const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, clipboard, nativeImage, Tray } = require('electron')
const path = require('path')
const fs = require('fs')
const { brotliDecompress } = require('zlib')
const { promisify, format } = require('util')
const _ = require('lodash')
const { folderTree } = require('./modules/folder_tree')
const { nanoid } = require('nanoid')
const sharp = require('sharp')
const { execFile } = require('child_process')
const { pathToFileURL } = require('url')
const { isWithin, assertWithin, webURL, readerExecutable, hashFile, serialQueue } = require('./modules/safety')
const { createReadingStateStore, validBookId, writeAtomic } = require('./modules/reading_state')
const { scanLibrary, relocateMissingBook, coverForRefresh } = require('./modules/library_scan')
const { TaskService } = require('./modules/task_service')
const { createLibraryOrganizer } = require('./modules/library_organizer')
const { createLocalSearchService } = require('./modules/local_search')
const { mergeBookEdits, withBookAuthors, writeBookEdit } = require('./modules/library_edits')
const { validateCollections, createCollectionService } = require('./modules/collections')
const { createBookFileService } = require('./modules/book_files')
const { createShutdownGuard } = require('./modules/shutdown_guard')
const { moveWithIdentity, fingerprintBook, pathKey } = require('./modules/library_identity')
const { createHash } = require('crypto')
const { BackupService } = require('./modules/backup_service')
const { readClientState, writeClientState } = require('./modules/client_state')
const { recoverPendingRestoreSync, controlPath, assertLocalPath, writeDurable } = require('./modules/restore_transaction')
const { listArchiveRecoveryPoints, restoreArchiveRecoveryPoint } = require('./modules/archive_recovery')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { importSqliteMetadata } = require('./modules/sqlite_metadata_import')
const { requestSource, createMetadataSources, validateSourceSettings, SOURCE_TYPES, galleryURL } = require('./modules/metadata_sources')
const windowStateKeeper = require('electron-window-state')
const express = require('express')
const { glob } = require('glob')

const { prepareMangaModel, prepareMetadataModel } = require('./modules/database')
const { prepareTemplate } = require('./modules/prepare_menu.js')
const { getBookFilelist, geneCover, getImageListByBook, deleteImageFromBook,
  releaseImageCache, getImageCacheStatus, setImageCacheBudget, clearUnusedImageCache } = require('./fileLoader/index.js')
const {
  STORE_PATH, isPortable,
  TEMP_PATH, COVER_PATH, VIEWER_PATH,
  prepareSetting, prepareCollectionList, preparePath
} = require('./modules/init_folder_setting.js')
const { resolvePortableSetting } = require('./modules/portable_paths')
const appIconPath = path.join(__dirname, 'public', process.platform === 'win32' ? 'icon.ico' : 'icon.png')

// Keep every profile/cache under the selected data store, including isolated development.
// Legacy portable installs retain their existing <program>/.reading-room profile.
app.setPath('userData', path.join(STORE_PATH, '.reading-room'))
app.setPath('sessionData', path.join(STORE_PATH, '.reading-room'))

// Claim the portable data store before opening databases or truncating logs.
if (!app.requestSingleInstanceLock()) app.exit(0)
preparePath()
recoverPendingRestoreSync(STORE_PATH)
let setting = prepareSetting()
const configuredCacheBytes = () => {
  const bytes = (Number(setting.imageCacheBudgetMB) || 2048) * 1024 ** 2
  return Number.isSafeInteger(bytes) && bytes > 0 && bytes <= 64 * 1024 ** 3 ? bytes : 2 * 1024 ** 3
}
Promise.resolve(setImageCacheBudget?.(configuredCacheBytes())).catch(error => console.error('缓存预算暂未应用：', error.message))
if (isPortable) setting = resolvePortableSetting(setting, require('./modules/utils').getRootPath())
let collectionList = prepareCollectionList()
const readingState = createReadingStateStore({ storePath: STORE_PATH })

let Manga = prepareMangaModel(path.join(STORE_PATH, './database.sqlite'))
let metadataSqliteFile
if (setting.metadataPath) {
  metadataSqliteFile = path.join(setting.metadataPath, './metadata.sqlite')
} else {
  metadataSqliteFile = path.join(STORE_PATH, './metadata.sqlite')
}
let Metadata = prepareMetadataModel(metadataSqliteFile)
const backupService = new BackupService({ storePath: STORE_PATH, metadataPath: () => metadataSqliteFile, appVersion: require('./package.json').version })
const backupPreviews = new Map()
const pendingCustomCovers = new Map()
let dataRestoreInProgress = false
const getColumns = async (sequelize, tableName) => {
  const query = `PRAGMA table_info(${tableName})`
  const [results] = await sequelize.query(query)
  return results.map(column => column.name)
}
// sync({alter:true}) 在 sqlite 上会按列反复 CREATE/INSERT/DROP 重建整张表且不带事务,
// 中途中断就会连表都不剩;改用单语句且原子的 ADD COLUMN
const schemaReady = (async () => {
  await Manga.sync()
  const columns = await getColumns(Manga.sequelize, 'Mangas')
  const additions = {
    identityFingerprint: 'TEXT',
    sourceSignature: 'TEXT',
    hiddenBook: 'TINYINT(1) DEFAULT 0',
    readCount: 'INTEGER DEFAULT 0',
    exist: 'TINYINT(1) DEFAULT 1'
  }
  for (const [name, ddl] of Object.entries(additions)) {
    if (!columns.includes(name)) {
      await Manga.sequelize.query(`ALTER TABLE \`Mangas\` ADD COLUMN \`${name}\` ${ddl}`)
    }
  }
  await Metadata.sync()
  await Manga.sequelize.query('CREATE INDEX IF NOT EXISTS mangas_hash_lookup ON Mangas(hash)')
  await Manga.sequelize.query('CREATE INDEX IF NOT EXISTS mangas_filepath_lookup ON Mangas(filepath)')
})()
schemaReady.catch(e => console.error('Database schema initialisation failed:', e))

const logFile = fs.createWriteStream(path.join(STORE_PATH, 'log.txt'), { flags: 'w' })
const logStdout = process.stdout
const logStderr = process.stderr

console.log = (...message) => {
  logFile.write(format(...message) + '\n')
  logStdout.write(format(...message) + '\n')
}

console.error = (...message) => {
  logFile.write(format(...message) + '\n')
  logStderr.write(format(...message) + '\n')
}

process
  .on('unhandledRejection', (reason, promise) => {
    console.log('Unhandled Rejection at:', promise, 'reason:', reason)
  })
  .on('uncaughtException', err => {
    // console.log 走的是异步写入流,紧跟着的 process.exit 会让崩溃原因根本来不及落盘
    try { fs.appendFileSync(path.join(STORE_PATH, 'log.txt'), format(err, 'Uncaught Exception thrown') + '\n') } catch {}
    logStderr.write(format(err, 'Uncaught Exception thrown') + '\n')
    process.exit(1)
  })

const sendMessageToWebContents = (message) => {
  console.log(message)
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('send-message', message)
}

let mainWindow
let tray
let isQuitting = false
let revealWindowWhenReady = false
let readerGeneration = 0
let readerExtractionTaskId = null
const readerQueue = serialQueue()
const libraryQueue = serialQueue()
const settingsQueue = serialQueue()
let libraryOrganizer, localSearch, metadataSources, collectionService, bookFiles
const taskService = new TaskService({ storePath: STORE_PATH, onChange: tasks => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('tasks-changed', { tasks })
} })
const libraryChannels = new Set(['load-book-list', 'force-gene-book-list', 'patch-local-metadata', 'patch-local-metadata-by-book', 'delete-local-book', 'move-local-book', 'delete-image', 'save-book', 'import-sqlite', 'import-database', 'export-database', 'save-setting'])
for (const channel of ['load-reading-state', 'save-reading-progress', 'save-reading-preferences', 'save-reading-visit', 'migrate-reading-state']) libraryChannels.add(channel)
libraryChannels.add('metadata-source-save-settings')
libraryChannels.add('collection-command')
libraryChannels.add('open-local-book')
for (const channel of ['load-ui-state', 'save-ui-state', 'backup-export', 'backup-inspect', 'backup-restore',
  'archive-recovery-list', 'archive-recovery-restore', 'save-collection-list']) libraryChannels.add(channel)
// Long tasks prepare outside this queue and take it only for their commits.
for (const channel of ['load-book-list', 'force-gene-book-list', 'patch-local-metadata', 'patch-local-metadata-by-book']) libraryChannels.delete(channel)
libraryChannels.add('image-cache-budget')
libraryChannels.add('save-library-exclusion')
libraryChannels.add('local-search-command')
const recoveryChannels = new Set(['load-ui-state', 'save-ui-state', 'backup-inspect', 'backup-restore',
  'import-database', 'data-protection-open-recovery', 'window-close', 'window-minimize', 'window-toggle-maximize', 'window-is-maximized'])
const registerHandler = ipcMain.handle.bind(ipcMain)
function trustedSender(event) {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  const url = event.senderFrame.url.split('#')[0]
  return url === pathToFileURL(path.join(__dirname, 'dist/index.html')).href
}
ipcMain.handle = (channel, handler) => registerHandler(channel, async (event, ...args) => {
  if (!trustedSender(event)) throw new Error('Untrusted IPC sender')
  if (recoveryChannels.has(channel)) await schemaReady.catch(() => {})
  else { await schemaReady; await libraryOrganizer?.ready }
  const run = () => {
    if (dataRestoreInProgress) throw new Error('数据恢复正在完成，请等待程序重新启动')
    return handler(event, ...args)
  }
  if (libraryChannels.has(channel)) return libraryQueue(run)
  if (channel === 'save-collection-list') return settingsQueue(run)
  return run()
})
const showMainWindow = () => {
  if (isQuitting) return
  revealWindowWhenReady = true
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.setSkipTaskbar(false)
  mainWindow.focus()
}
const shutdownGuard = createShutdownGuard({
  app, getWindow: () => mainWindow, bypass: () => dataRestoreInProgress,
  setQuitting: value => { isQuitting = value },
  flushMain: async receipt => {
    await taskService.stopAll().catch(error => console.error('Task history could not be saved:', error))
    if (receipt.readingProfile) {
      await libraryOrganizer?.flush()
      if (!localSearch?.initialError) await localSearch?.flush()
    }
    return libraryQueue(async () => {
    // Recovery mode may have no usable profile; with no renderer profile there
    // are no staged reading changes to flush, and the user must still be able to exit.
    if (receipt.readingProfile) await readingState.flush()
    await settingsQueue(async () => {})
    })
  },
  reportError: error => {
    console.error('Close cancelled because saving failed:', error)
    showMainWindow()
    dialog.showErrorBox('尚未退出：阅读档案未能保存', `${error.message}\n窗口已保留，请重试关闭。`)
  }
})
app.on('second-instance', showMainWindow)
sharp.cache({ memory: 64, files: 20, items: 100 })
sharp.concurrency(2)

const runTrayAction = async (action) => {
  if (isQuitting) return
  try {
    await action()
  } catch (error) {
    console.error('Tray action failed:', error)
    if (!isQuitting) dialog.showErrorBox('颜如玉', error.message || String(error))
  }
}

const openRandomLocalBook = async () => {
  await schemaReady
  return libraryQueue(async () => {
    if (isQuitting) return
    const books = (await Manga.findAll({
      attributes: ['id', 'filepath', 'hiddenBook', 'exist'],
      raw: true
    })).filter(book => !book.hiddenBook && book.exist !== false && book.exist !== 0 &&
      typeof book.filepath === 'string' && book.filepath.trim())

    while (books.length) {
      if (isQuitting) return
      const index = Math.floor(Math.random() * books.length)
      const book = books[index]
      books[index] = books[books.length - 1]
      books.pop()
      // Scanning verifies moved sources before changing their database paths.
      // A same-name file in the selected root may be a different book.
      try { await fs.promises.access(book.filepath) } catch { continue }
      if (isQuitting) return
      await openLocalBook(book.filepath, book, true)
      return
    }
    throw new Error('书库中没有可打开的漫画，请先添加漫画或检查漫画文件是否存在。')
  })
}

const createTray = () => {
  if (isQuitting || (tray && !tray.isDestroyed())) return
  tray = new Tray(appIconPath)
  tray.setToolTip('颜如玉 · 书中自有颜如玉')
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
        mainWindow.minimize()
      } else {
        showMainWindow()
      }
    } else {
      showMainWindow()
    }
  })
  const contextMenu = Menu.buildFromTemplate([
    {
      label: '随机打开漫画',
      click: () => runTrayAction(openRandomLocalBook)
    },
    {
      label: '打开漫画网页',
      click: () => runTrayAction(() => shell.openExternal('https://exhentai.org/popular'))
    },
    {
      label: '退出',
      click: () => {
        app.quit()
      }
    }
  ])
  tray.setContextMenu(contextMenu)
}

const createWindow = () => {
  const mainWindowState = windowStateKeeper({
    defaultWidth: 1560,
    defaultHeight: 1000
  })
  const win = new BrowserWindow({
    'x': mainWindowState.x,
    'y': mainWindowState.y,
    'width': mainWindowState.width,
    'height': mainWindowState.height,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#f4f2ec',
    icon: appIconPath,
    frame: !setting.hideTitleBar,
    webPreferences: {
      webSecurity: true,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    },
    show: false
  })
  win.loadFile(path.join(__dirname, 'dist/index.html'))
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const entry = pathToFileURL(path.join(__dirname, 'dist/index.html')).href
    if (url.split('#')[0] !== entry) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', event => event.preventDefault())
  win.setMenuBarVisibility(false)
  win.setAutoHideMenuBar(true)
  const menu = Menu.buildFromTemplate(prepareTemplate(win))
  Menu.setApplicationMenu(menu)
  win.webContents.on('did-finish-load', () => {
    const name = require('./package.json').productName || '颜如玉'
    const version = require('./package.json').version
    win.setTitle(name + ' ' + version)
  })
  win.on('maximize', () => win.webContents.send('send-action', { action: 'window-maximized' }))
  win.on('unmaximize', () => win.webContents.send('send-action', { action: 'window-unmaximized' }))
  win.once('ready-to-show', () => {
    if (setting.minimizeOnStart && !revealWindowWhenReady) {
      if (setting.minimizeToTray) {
        createTray()
        win.hide()
        win.setSkipTaskbar(true)
      } else {
        win.minimize()
      }
    } else {
      win.show()
    }
    revealWindowWhenReady = false
  })
  win.on('close', (event) => {
    if (!isQuitting && setting.closeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
      shutdownGuard.hideToTray(win)
      return
    }
    shutdownGuard.windowClose(event, win)
  })
  win.on('minimize', (event) => {
    if (!isQuitting && setting.minimizeToTray) {
      event.preventDefault()
      createTray()
      win.hide()
      win.setSkipTaskbar(true)
    }
  })
  win.on('restore', () => {
    win.show()
    win.setSkipTaskbar(false)
  })
  win.on('show', () => {
    win.setSkipTaskbar(false)
    mainWindowState.manage(win)
  })
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

// Use the runtime memory limit instead of allowing a 64 GB heap.
// app.disableHardwareAcceleration()
app.whenReady().then(async () => {
  // The tray belongs to the app lifetime, independently of window hide settings.
  createTray()
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  try { await Promise.all([schemaReady, readingState.ready, libraryOrganizer?.ready]) }
  catch { revealWindowWhenReady = true }
  if (!isQuitting && setting.enabledLANBrowsing) enableLANBrowsing()
  if (!isQuitting && (!mainWindow || mainWindow.isDestroyed())) mainWindow = createWindow()
})
app.on('activate', () => {
  if (isQuitting) return
  if (BrowserWindow.getAllWindows().length === 0) {
    mainWindow = createWindow()
  }
  showMainWindow()
})

app.on('ready', async () => {
  if (setting.proxy) {
    await session.defaultSession.setProxy({
      mode: 'fixed_servers',
      proxyRules: setting.proxy
    })
  }
  // session.defaultSession.loadExtension(path.join(__dirname, './devtools'))
})

app.on('before-quit', event => shutdownGuard.beforeQuit(event))

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Archive caches are budgeted and reused across restarts. Only reader leases
// are released here; a whole viewer-folder deletion would bypass that budget.
app.on('will-quit', () => {
  if (tray && !tray.isDestroyed()) tray.destroy()
  tray = null
  Promise.resolve(releaseImageCache?.('desktop-reader')).catch(() => {})
})

process.on('exit', () => {
  app.quit()
})

// base function
const loadBookListFromBrFile = async () => {
  try {
    const buffer = await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json.br'))
    const decodeBuffer = await promisify(brotliDecompress)(buffer)
    return JSON.parse(decodeBuffer.toString())
  } catch {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(STORE_PATH, 'bookList.json'), { encoding: 'utf-8' }))
    } catch {
      return []
    }
  }
}

const loadLegecyBookListFromFile = async () => {
  const bookList = await loadBookListFromBrFile()
  if (!Array.isArray(bookList)) throw new Error('旧书库清单格式不正确，原始文件已保留')
  return bookList
}

const preserveLegacyBookSources = async () => {
  const directory = assertLocalPath(STORE_PATH, path.join(controlPath(STORE_PATH), 'legacy-book-lists'))
  await fs.promises.mkdir(directory, { recursive: true })
  for (const name of ['bookList.json.br', 'bookList.json']) {
    const source = assertLocalPath(STORE_PATH, path.join(STORE_PATH, name))
    try {
      await fs.promises.access(source)
      // Preserve the exact source only after its database transaction succeeds.
      await fs.promises.rename(source, path.join(directory, Date.now() + '-' + nanoid(8) + '-' + name))
    } catch (error) { if (error.code !== 'ENOENT') console.error('旧书库来源保留在原处：', error.message) }
  }
}

const loadBookListFromDatabase = async () => {
  await schemaReady
  let bookList = await Manga.findAll()
  bookList = bookList.map(b => b.toJSON())
  if (_.isEmpty(bookList)) {
    bookList = await loadLegecyBookListFromFile()
    if (bookList.length) { await saveBookListToDatabase(bookList); await preserveLegacyBookSources() }
  }
  let metadataList = await Metadata.findAll()
  metadataList = metadataList.map(m => m.toJSON())
  const metadataByHash = new Map(metadataList.map(m => [m.hash, m]))
  const hashCounts = new Map()
  for (const book of bookList) hashCounts.set(book.hash, (hashCounts.get(book.hash) || 0) + 1)
  const bookListLength = bookList.length
  for (let i = 0; i < bookListLength; i++) {
    const book = bookList[i]
    if (isPortable) {
      const changes = {}
      if (book.coverPath) {
        const localCover = path.join(COVER_PATH, path.basename(book.coverPath))
        if (localCover !== book.coverPath) changes.coverPath = localCover
      }
      // Only verified scan/relocation operations may rebind a book's source.
      // Loading a catalogue must not turn two records into the same path.
      if (Object.keys(changes).length) {
        await Manga.update(changes, { where: { id: book.id } })
        Object.assign(book, changes)
      }
    }
    const findMetadata = metadataByHash.get(book.hash)
    if (findMetadata) {
      // The book row owns user edits. A sampled-page metadata key must never
      // overwrite favorites or merge two books that happen to share that page.
      if (book.status === 'non-tag' && findMetadata.status !== 'non-tag' && hashCounts.get(book.hash) === 1) {
        const metadata = _.pick(findMetadata, ['status', 'rating', 'tags', 'title_jpn', 'filecount', 'posted', 'filesize', 'category', 'url'])
        if (!book.title || book.title === path.basename(book.filepath)) metadata.title = findMetadata.title || book.title
        await Manga.update(metadata, { where: { id: book.id } })
        Object.assign(book, metadata)
      }
    } else {
      setProgressBar((i + 1) / bookListLength)
      await Metadata.upsert(book)
    }
  }
  setProgressBar(-1)
  return bookList
}

const saveBookListToDatabase = async (data) => {
  console.log('Empty Exist BookList and Saved New BookList')
  await Manga.sequelize.transaction(async transaction => {
    await Manga.destroy({ truncate: true, transaction })
    await Manga.bulkCreate(data, { transaction })
  })
}

const saveBookToDatabase = async (book, authors) => {
  if (!book || !validBookId(book.id)) throw new Error('书籍 ID 无效')
  const stored = await Manga.findByPk(book.id)
  if (!stored) throw new Error('书籍记录不存在，保存未执行')
  const previous = stored.toJSON()
  const approvedCover = pendingCustomCovers.get(book.coverPath)
  const cover = approvedCover && approvedCover.expires > Date.now() ? approvedCover : null
  if (cover) await assertWithin(COVER_PATH, cover.coverPath)
  const merged = mergeBookEdits(previous, book, cover)
  const saved = await writeBookEdit(Manga, Metadata, authors === undefined ? merged : withBookAuthors(merged, authors))
  if (cover) pendingCustomCovers.delete(cover.coverPath)
  console.log(`Saved ${saved.title}`)
  return saved
}

const setProgressBar = (progress) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.setProgressBar(progress)
  mainWindow.webContents.send('send-action', {
    action: 'send-progress',
    progress
  })
}

const clearFolder = async (Folder) => {
  try {
    await fs.promises.rm(Folder, { recursive: true, force: true })
    await fs.promises.mkdir(Folder, { recursive: true })
  } catch (err) {
    console.log(err)
  }
}


// library and metadata
function notifyLibraryUpdated(taskId, kind) {
  lanListExpires = 0
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('library-updated', { taskId, kind })
}

const commitLibraryTask = operation => libraryQueue(() => {
  if (dataRestoreInProgress) throw new Error('数据恢复正在完成，任务已停止')
  return operation()
})

libraryOrganizer = createLibraryOrganizer({
  storePath: STORE_PATH, databaseReady: schemaReady,
  getManga: () => Manga, getMetadata: () => Metadata, readingState,
  getCollections: () => collectionList,
  saveCollections: async list => {
    writeDurable(path.join(STORE_PATH, 'collectionList.json'), list)
    collectionList = list
  },
  libraryRoot: () => setting.library, commit: commitLibraryTask,
  onChanged: () => notifyLibraryUpdated(null, 'organizer'),
})
localSearch = createLocalSearchService({ storePath: STORE_PATH, getBooks: loadBookListFromDatabase })
metadataSources = createMetadataSources({ getBook: async id => (await Manga.findByPk(id))?.toJSON(), getSettings: () => setting,
  saveBook: saveBookToDatabase, commit: commitLibraryTask })
collectionService = createCollectionService({ getCollections: () => collectionList, getBooks: () => Manga.findAll({ raw: true }),
  saveCollections: async list => {
    await writeAtomic(path.join(STORE_PATH, 'collectionList.json'), list)
    collectionList = list
  } })
bookFiles = createBookFileService({ getBook:async id => {
    const book = await Manga.findByPk(id, { raw:true })
    if (book) {
      const records = await Manga.findAll({ attributes:['id','filepath'], raw:true })
      if (records.filter(row => typeof row.filepath === 'string' && pathKey(row.filepath) === pathKey(book.filepath)).length !== 1) throw new Error('多个书库记录指向同一来源，请先核对重复记录或撤销相关合并')
    }
    return book
  }, getLibrary:() => setting.library,
  saveLocation:async (id, patch) => { const [count] = await Manga.update(patch, { where:{id} }); if (count !== 1) throw new Error('书库记录未能更新') },
  trash:filename => shell.trashItem(filename), listImages:directory => glob('*.@(jpg|jpeg|png|webp|avif|gif)', { cwd:directory, nocase:true, absolute:true, nodir:true, follow:false }),
  commit:commitLibraryTask })
ipcMain.handle('book-file-preview-move', async (_event, id) => {
  const selected = await dialog.showOpenDialog(mainWindow, { title:'选择书库内的目标文件夹', defaultPath:setting.library, properties:['openDirectory'] })
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled:true }
  return bookFiles.previewMove(id, selected.filePaths[0])
})
ipcMain.handle('book-file-preview-recycle', (_event, id) => bookFiles.previewRecycle(id))
ipcMain.handle('book-file-apply', async (_event, token) => {
  const result = await bookFiles.apply(token)
  notifyLibraryUpdated(null, 'book-files')
  return result
})
ipcMain.handle('collection-command', async (_event, params) => {
  const result = await collectionService.command(params)
  if (result.changed) notifyLibraryUpdated(null, 'collections')
  return result
})

taskService.register('metadata-search', (params, task) => {
  task.report({ message: '正在搜索元数据来源…' })
  return metadataSources.search(params, { signal: task.signal })
}, { lane: 'metadata-online', title: '搜索在线元数据' })
taskService.register('metadata-fetch', async (params, task) => {
  task.report({ message: '正在拉取元数据预览…' })
  return metadataSources.preview(params, { signal: task.signal })
}, { lane: 'metadata-online', title: '拉取在线元数据预览' })
taskService.register('metadata-batch', async (params, task) => {
  const books = await commitLibraryTask(() => Manga.findAll({ attributes:['id', 'filepath', 'hiddenBook', 'status'], raw:true, order:[['id','ASC']] }))
  const result = await metadataSources.batch({ ...params, books }, task)
  if (result.changed) notifyLibraryUpdated(task.id, 'online-metadata')
  return result
}, { lane:'metadata-online', title:params => params.scope === 'all' ? '全书库拉取在线元数据' : '拉取未标记书籍的元数据' })
taskService.register('sqlite-import', (params, task) => commitLibraryTask(async () => {
  const books = await Manga.findAll({ raw:true })
  const ids = params.bookIds ? new Set(params.bookIds) : null
  const selected = books.filter(book => !book.hiddenBook && (!ids || ids.has(book.id)))
  task.report({ total:selected.length, message:'正在匹配 SQLite 元数据…' })
  const result = await importSqliteMetadata({ filename:params.filename, books:selected, Manga, Metadata,
    getEhviewerData:getEhviewerDataManually, signal:task.signal,
    onProgress:value => { if (value >= 0) task.report({ current:Math.floor(value * selected.length) }) } })
  for (const failure of result.failures) task.error({ bookId:failure.id, message:failure.reason, phase:'import' })
  if (result.counts.imported) notifyLibraryUpdated(task.id, 'sqlite-import')
  return { ...result, ...result.counts, failureDetails:result.failures, failures:result.counts.failed,
    changed:result.counts.imported>0, cancelled:result.canceled }
}), { lane:'library', title:'导入 SQLite 元数据' })
ipcMain.handle('import-library-sqlite', async (_event, options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options) || (options.bookIds !== undefined &&
      (!Array.isArray(options.bookIds) || options.bookIds.length > 100000 || options.bookIds.some(id => !validBookId(id))))) throw new Error('导入书籍列表无效')
  const selected = await dialog.showOpenDialog(mainWindow, { title:'选择 SQLite 元数据', properties:['openFile'], filters:[{name:'SQLite', extensions:['sqlite','db']}] })
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled:true }
  const params = { filename:selected.filePaths[0], ...(options.bookIds ? {bookIds:[...new Set(options.bookIds)]} : {}) }
  return taskService.run('sqlite-import', params, { key:'sqlite-import:' + JSON.stringify(params) })
})
function metadataTaskParams(value, preview = false) {
  const keys = preview ? ['bookId','url'] : ['bookId','source','query']
  if (!value || typeof value !== 'object' || Array.isArray(value) || !validBookId(value.bookId) ||
      Object.keys(value).some(key => !keys.includes(key))) throw new Error('元数据请求参数无效')
  if (preview) return { bookId:value.bookId, url:galleryURL(value.url).url }
  if (!SOURCE_TYPES.includes(value.source) || typeof value.query !== 'string' || value.query.length > 1000) throw new Error('元数据搜索参数无效')
  return { bookId:value.bookId, source:value.source, query:value.query }
}
ipcMain.handle('metadata-source-search', (_event, value) => {
  const params = metadataTaskParams(value)
  return taskService.run('metadata-search', params, { key:'metadata-search:' + JSON.stringify(params) })
})
ipcMain.handle('metadata-source-preview', (_event, value) => {
  const params = metadataTaskParams(value, true)
  return taskService.run('metadata-fetch', params, { key:'metadata-fetch:' + JSON.stringify(params) })
})
ipcMain.handle('metadata-source-get-preview', (_event, token) => metadataSources.getPreview(token))
ipcMain.handle('metadata-source-apply', async (_event, params) => {
  const saved = await metadataSources.apply(params)
  notifyLibraryUpdated(null, 'online-metadata')
  return saved
})
ipcMain.handle('metadata-source-save-settings', async (_event, patch) => {
  const previous = setting, next = validateSourceSettings(previous, patch)
  const proxyOptions = value => value ? { mode: 'fixed_servers', proxyRules: value } : { mode: 'direct' }
  try {
    await session.defaultSession.setProxy(proxyOptions(next.proxy))
    await writeAtomic(path.join(STORE_PATH, 'setting.json'), next)
    setting = next
    return setting
  } catch (error) {
    await session.defaultSession.setProxy(proxyOptions(previous.proxy)).catch(() => {})
    throw error
  }
})

// The organizer takes the shared commit queue itself. Putting these channels
// into libraryChannels as well would deadlock preview, apply and undo.
for (const [channel, method] of Object.entries({
  'organizer-catalog': 'catalog', 'organizer-preview-batch': 'previewBatch',
  'organizer-preview-remove-missing': 'previewRemoveMissing',
  'organizer-preview-merge': 'previewMerge', 'organizer-apply': 'apply',
  'organizer-history': 'history', 'organizer-undo': 'undo',
  'organizer-health': 'health', 'organizer-duplicates': 'duplicates',
})) ipcMain.handle(channel, (_event, payload) => libraryOrganizer[method](payload))

ipcMain.handle('local-search-command', (_event, payload) => localSearch.command(payload))
ipcMain.handle('local-search-ocr-image', async (_event, options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (options.language !== undefined && (typeof options.language !== 'string' || options.language.length > 60))) throw new Error('识别语言选项无效')
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '选择一页图片进行本地文字识别', properties: ['openFile'],
    filters: [{ name: '书页图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff'] }],
  })
  if (selected.canceled || !selected.filePaths?.[0]) return { cancelled: true }
  return localSearch.recognizeImage(selected.filePaths[0], { language: options.language })
})

async function runLibraryScan(params, task) {
  const library = setting.library
  const excludeFile = setting.excludeFile
  const tempRoot = path.join(TEMP_PATH, 'task-' + task.id)
  if (!isWithin(TEMP_PATH, tempRoot)) throw new Error('无效任务临时目录')
  const clearTemp = () => clearFolder(tempRoot)
  const taskCover = (filepath, type, options) => geneCover(filepath, type, { ...options, tempRoot,
    onProgress: step => task.report({ message: step.message || '正在读取压缩包封面…', filepath }) })
  try {
  const result = await scanLibrary({
    Manga, library, excludeFile, coverRoot: COVER_PATH,
    excludeRoots: [TEMP_PATH, COVER_PATH, VIEWER_PATH, path.dirname(__dirname), path.join(STORE_PATH, 'recovery'),
      path.join(STORE_PATH, '.data-protection'), path.join(STORE_PATH, '.source-backups'), path.join(STORE_PATH, '.cache')],
    getBookFilelist, geneCover: taskCover, clearTemp,
    progress: setProgressBar, message: sendMessageToWebContents, newId: nanoid,
    rebuild: params.rebuild === true, forceRefresh: params.forceRefresh === true, bookIds: params.bookIds?.length ? params.bookIds : null,
    signal: task.signal, onItem: task.report, onError: task.error, commit: commitLibraryTask,
    onFirstBookReady: () => notifyLibraryUpdated(task.id, 'scan'),
    getMergedSources: () => libraryOrganizer.mergedSources(),
    beforeCommit: () => {
      if (setting.library !== library || setting.excludeFile !== excludeFile) throw new Error('书库设置已改变，本次扫描未提交，请重新扫描')
    }
  })
  if (result.changed) notifyLibraryUpdated(task.id, params.forceRefresh ? 'metadata' : 'scan')
  if (params.rebuild && result.failures) throw new Error(`重建未提交：${result.failures} 本书处理失败，原书库和阅读档案均已保留`)
  return result
  } finally {
    await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

taskService.register('scan', runLibraryScan, { lane: 'library', title: params => params.rebuild ? '安全重建书库' : '增量扫描书库' })
taskService.register('metadata', (params, task) => runLibraryScan({ ...params, forceRefresh: true }, task),
  { lane: 'library', title: '刷新本地页数、封面与指纹' })
taskService.register('extract', async (params, task) => {
  await assertWithin(setting.library, params.filepath, params.type === 'folder')
  task.report({ phase: 'extract', message: '正在准备阅读图片…', filepath: params.filepath })
  return getImageListByBook(params.filepath, params.type, { signal: task.signal, onProgress: task.report,
    owner: params.owner || 'desktop-reader' })
}, { lane: 'extract', title: params => '准备阅读 · ' + path.basename(params.filepath) })
taskService.register('relocate', async (params, task) => {
  const library = setting.library
  const tempRoot = path.join(TEMP_PATH, 'task-' + task.id)
  if (!isWithin(TEMP_PATH, tempRoot)) throw new Error('无效任务临时目录')
  await fs.promises.mkdir(tempRoot, { recursive: true })
  task.report({ phase: 'verify', current: 0, total: 1, filepath: params.filepath, message: '正在核对完整书籍内容…' })
  try {
    const book = await relocateMissingBook({ Manga, bookId: params.bookId, filepath: params.filepath, library,
      coverRoot: COVER_PATH, signal: task.signal,
      geneCover: (filepath, type, options) => geneCover(filepath, type, { ...options, tempRoot }),
      commit: operation => commitLibraryTask(() => {
        if (setting.library !== library) throw new Error('书库目录已改变，请重新定位')
        return operation()
      }) })
    task.report({ current: 1, total: 1 })
    notifyLibraryUpdated(task.id, 'relocate')
    return { success: true, book, changed: true, relocated: 1 }
  } finally { await fs.promises.rm(tempRoot, { recursive: true, force: true }).catch(() => {}) }
}, { lane: 'library', title: '重新定位失联书籍' })

ipcMain.handle('task-list', () => taskService.list())
ipcMain.handle('task-start', (_event, kind, options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('任务参数无效')
  if (kind === 'metadata-batch') {
    if (!['missing', 'all'].includes(options.scope) || !SOURCE_TYPES.includes(options.source)) throw new Error('批量拉取范围或来源无效')
    const params = { scope:options.scope, source:options.source, library:setting.library || '' }
    return taskService.start(kind, params, { key:kind + ':' + JSON.stringify(params) })
  }
  if (!['scan', 'metadata'].includes(kind)) throw new Error('不支持的任务类型')
  const params = { rebuild: kind === 'scan' && options.rebuild === true }
  if (kind === 'metadata' && Array.isArray(options.bookIds)) {
    if (options.bookIds.length > 100000 || options.bookIds.some(id => !validBookId(id))) throw new Error('书籍列表无效')
    params.bookIds = [...new Set(options.bookIds)]
  }
  return taskService.start(kind, params, { key: kind + ':' + JSON.stringify(params) })
})
ipcMain.handle('task-cancel', (_event, id) => taskService.cancel(id))
ipcMain.handle('task-retry', (_event, id) => taskService.retry(id))
ipcMain.handle('task-dismiss', (_event, id) => taskService.dismiss(id))
ipcMain.handle('relocate-book', async (_event, bookId) => {
  if (!validBookId(bookId)) throw new Error('书籍 ID 无效')
  const book = await commitLibraryTask(() => Manga.findByPk(bookId, { raw: true }))
  if (!book) throw new Error('书籍记录不存在')
  const selected = await dialog.showOpenDialog(mainWindow, {
    title: '重新定位：' + (book.title || path.basename(book.filepath)), defaultPath: setting.library,
    properties: [book.type === 'folder' ? 'openDirectory' : 'openFile'],
    ...(book.type === 'folder' ? {} : { filters: [{ name: '漫画压缩包', extensions: ['zip', 'cbz', 'rar', 'cbr', '7z', 'cb7'] }] })
  })
  if (selected.canceled || !selected.filePaths?.[0]) return { canceled: true }
  return taskService.run('relocate', { bookId, filepath: selected.filePaths[0] }, { key: 'relocate:' + bookId })
})

ipcMain.handle('load-book-list', async (event, scan) => {
  if (scan) await taskService.run('scan', { rebuild: false }, { key: 'scan:' + JSON.stringify({ rebuild: false }) })
  return await commitLibraryTask(loadBookListFromDatabase)
})

ipcMain.handle('force-gene-book-list', async () => {
  await taskService.run('scan', { rebuild: true }, { key: 'scan:' + JSON.stringify({ rebuild: true }) })
  return await commitLibraryTask(loadBookListFromDatabase)
})

ipcMain.handle('patch-local-metadata', async (event, arg) => {
  await taskService.run('metadata', {}, { key: 'metadata:all' })
  return commitLibraryTask(loadBookListFromDatabase)
})

ipcMain.handle('patch-local-metadata-by-book', async (_event, book, options) => {
  if (!book || !validBookId(book.id)) throw new Error('书籍记录无效')
  const result = await taskService.run('metadata', { bookIds: [book.id] }, { key: 'metadata:' + book.id })
  if (result.cancelled) throw new Error('已取消本地元数据刷新')
  const outcome = result.bookResults.find(item => item.bookId === book.id)
  if (!outcome) throw new Error('本地元数据刷新未完成')
  if (outcome.status !== 'refreshed') {
    if (options?.detailed === true) return outcome
    throw new Error(outcome.message)
  }
  const refreshed = await commitLibraryTask(() => Manga.findByPk(book.id, { raw: true }))
  if (!refreshed) throw new Error('书籍记录不存在')
  const fields = _.pick(refreshed, ['coverPath', 'hash', 'pageCount', 'bundleSize', 'mtime', 'coverHash', 'identityFingerprint', 'sourceSignature', 'exist'])
  return options?.detailed === true ? { ...outcome, book: fields } : fields
})

// Function to read the .ehviewer file
function getEhviewerDataManually(dir) {
  try {
    const filePath = path.join(dir, '.ehviewer')
    if (fs.existsSync(filePath)) {
      const fileContent = fs.readFileSync(filePath, 'utf-8')
      const lines = fileContent.split('\n')
      if (lines.length >= 4) {
        const gid = lines[2].trim()
        const token = lines[3].trim()
        return { gid, token }
      }
    }
    return null
  } catch (error) {
    console.error('Failed to read .ehviewer file:', error)
    return null
  }
}

ipcMain.handle('get-ehviewer-data', async (event, dir) => {
  return getEhviewerDataManually(dir)
})

ipcMain.handle('get-ex-webpage', (_event, { url, cookie }) =>
  requestSource(webURL(url, ['exhentai.org', 'e-hentai.org']), { cookie: cookie || '', proxy: setting.proxy || '' }))

ipcMain.handle('post-data-ex', (_event, { url, data }) =>
  requestSource(webURL(url, ['api.e-hentai.org', 'exhentai.org', 'e-hentai.org']), { method: 'POST', data, proxy: setting.proxy || '' }))

ipcMain.handle('save-book', async (event, book, authors) => {
  return await saveBookToDatabase(book, authors)
})

ipcMain.handle('load-reading-state', () => readingState.load())
ipcMain.handle('migrate-reading-state', async (event, payload) => {
  const books = await loadBookListFromDatabase()
  return readingState.migrate(payload, books)
})
ipcMain.handle('save-reading-progress', async (event, id, progress) => {
  if (!validBookId(id) || !await Manga.findByPk(id, { attributes: ['id'] })) throw new Error('无法保存不存在书籍的阅读进度')
  return readingState.saveProgress(id, progress)
})
ipcMain.handle('save-reading-preferences', async (_event, id, preferences) => {
  if (!validBookId(id) || !await Manga.findByPk(id, { attributes: ['id'] })) throw new Error('无法保存不存在书籍的阅读偏好')
  return readingState.savePreferences(id, preferences)
})
ipcMain.handle('save-reading-visit', async (_event, id, visit) => {
  if (!validBookId(id) || !await Manga.findByPk(id, { attributes: ['id'] })) throw new Error('无法保存不存在书籍的阅读记录')
  return readingState.saveVisit(id, visit)
})

// home
ipcMain.handle('get-folder-tree', (event, filePathList) => folderTree(setting.library, filePathList))

ipcMain.handle('load-collection-list', async (event, arg) => {
  return collectionList
})

ipcMain.handle('save-collection-list', async (event, list) => {
  const next = validateCollections(list)
  await writeAtomic(path.join(STORE_PATH, 'collectionList.json'), next)
  collectionList = next
  notifyLibraryUpdated(null, 'collections')
})

// detail
ipcMain.handle('open-url', async (event, url) => {
  return shell.openExternal(webURL(url))
})

ipcMain.handle('show-file', async (event, filepath) => {
  shell.showItemInFolder(filepath)
})

ipcMain.handle('use-new-cover', async (event, filepath) => {
  const copyTempCoverPath = path.join(TEMP_PATH, nanoid(8) + path.extname(filepath))
  const coverPath = path.join(COVER_PATH, 'custom-' + nanoid() + path.extname(filepath))
  try {
    await fs.promises.copyFile(filepath, copyTempCoverPath)
    await sharp(copyTempCoverPath, { failOnError: false })
    .rotate()
    .resize({ width: 1000, height: 1000, fit: 'inside', withoutEnlargement: true })
    .toFile(coverPath)
    pendingCustomCovers.set(coverPath, { coverPath, coverHash: await hashFile(coverPath), expires: Date.now() + 30 * 60 * 1000 })
    return coverPath
  } catch (e) {
    sendMessageToWebContents(`Generate cover from ${filepath} failed because ${e}`)
  }
})

const openLocalBook = async (filepath, book = null, sourceChecked = false) => {
  if (typeof filepath !== 'string' || !filepath.trim() || filepath.includes('\0')) throw new Error('书籍路径无效')
  if (isQuitting) return { opened:false }
  if (book && !sourceChecked) {
    await fs.promises.access(filepath)
    if (isQuitting) return { opened:false }
  }
  if (setting.imageExplorer) {
    const executable = readerExecutable(setting.imageExplorer)
    await fs.promises.access(executable)
    if (isQuitting) return { opened:false }
    await new Promise((resolve, reject) => {
      const child = execFile(executable, [path.resolve(filepath)], { windowsHide: true }, error => {
        if (error) sendMessageToWebContents(`Open reader failed: ${error.message}`)
      })
      child.once('error', reject)
      child.once('spawn', () => { child.unref(); resolve() })
    })
  } else {
    const error = await shell.openPath(filepath)
    if (error) throw new Error(error)
  }
  if (!book || !validBookId(book.id)) return { opened:true, bookId:null, recorded:false }
  const visit = { time:Date.now(), source:'external' }
  try {
    const saved = await readingState.saveVisit(book.id, visit)
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('reading-visit-saved', { bookId:book.id, visit:saved })
    return { opened:true, bookId:book.id, recorded:true, visit:saved }
  } catch (error) {
    const recordingError = '外部阅读器已打开，阅读记录尚未保存：' + error.message
    sendMessageToWebContents(recordingError)
    return { opened:true, bookId:book.id, recorded:false, visit, recordingError }
  }
}

ipcMain.handle('open-local-book', async (_event, filepath, options = {}) => {
  if (typeof filepath !== 'string' || !filepath.trim() || filepath.includes('\0') || !options || typeof options !== 'object' || Array.isArray(options) ||
      Object.keys(options).some(key => key !== 'bookId')) throw new Error('外部阅读参数无效')
  let book
  if (options.bookId !== undefined) {
    if (!validBookId(options.bookId)) throw new Error('书籍 ID 无效')
    book = await Manga.findByPk(options.bookId, { raw:true })
    if (!book || pathKey(book.filepath) !== pathKey(filepath)) throw new Error('书籍位置已更新，请从书库重新打开')
  } else {
    const rows = await Manga.findAll({ attributes:['id','filepath','hiddenBook','exist'], raw:true })
    const matches = rows.filter(row => typeof row.filepath === 'string' && pathKey(row.filepath) === pathKey(filepath))
    if (matches.length > 1) throw new Error('多个记录指向这个来源，请从书籍详情打开')
    book = matches[0] || null
  }
  return openLocalBook(filepath, book)
})

ipcMain.handle('delete-local-book', async (event, filepath) => {
  let recycledImages = 0
  let filesRecycled = false
  try {
    await assertWithin(setting.library, filepath, true)
    const stats = await fs.promises.lstat(filepath)
    if (stats.isSymbolicLink()) throw new Error('不能删除链接形式的书目')
    if (stats.isDirectory()) {
      const imageFiles = await glob('*.@(jpg|jpeg|png|webp|avif|gif)', {
        cwd: filepath,
        nocase: true,
        absolute: true,
        nodir: true,
        follow: false,
      })
      for (const imageFile of imageFiles) {
        await assertWithin(filepath, imageFile)
        if (!(await fs.promises.lstat(imageFile)).isFile()) throw new Error('图片路径不是普通文件')
      }
      for (const imageFile of imageFiles) {
        await shell.trashItem(imageFile)
        recycledImages++
      }
      const remainingFiles = await fs.promises.readdir(filepath)
      if (remainingFiles.length === 0 && path.resolve(filepath) !== path.resolve(setting.library)) {
        await shell.trashItem(filepath)
      } else if (remainingFiles.length) {
        sendMessageToWebContents(`图片已移入回收站，目录因仍有 ${remainingFiles.length} 个其他文件而保留：${filepath}`)
      }
    } else {
      if (!stats.isFile() || !/\.(zip|cbz|rar|cbr|7z|cb7)$/i.test(filepath)) throw new Error('只能删除书目目录或受支持的压缩包')
      await shell.trashItem(filepath)
    }
    filesRecycled = true
    await Manga.destroy({ where: { filepath: filepath } })
    return true
  } catch (error) {
    const detail = filesRecycled
      ? '文件已移入回收站，但书库记录更新失败，请刷新后检查。'
      : `已停止删除并保留书库记录。${recycledImages ? `此前已有 ${recycledImages} 张图片移入系统回收站，可在那里恢复。` : ''}`
    sendMessageToWebContents(`删除失败：${filepath}。${detail}原因：${error.message || error}`)
    return false
  }
})

ipcMain.handle('move-local-book', async (event, oldPath, folderArr) => {
  try {
    await assertWithin(setting.library, oldPath)
    const records = await Manga.findAll({ where: { filepath: oldPath }, raw: true })
    if (records.length !== 1) throw new Error('无法唯一确定待移动的书籍，原文件保持不变')
    const book = records[0]
    const pathSep = require('path').sep
    const folderPath = Array.isArray(folderArr) && folderArr.length > 0 ? folderArr.join(pathSep) : ''
    const newFilePath = path.join(path.dirname(setting.library), folderPath, path.basename(oldPath))
    if (!isWithin(setting.library, newFilePath)) throw new Error('Move target is outside the library')
    let ancestor = path.dirname(newFilePath)
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor)
    await assertWithin(setting.library, ancestor, true)
    if (oldPath !== newFilePath) {
      // Windows 的 rename 走 MoveFileExW 会覆盖同名目标,同名的压缩包书会被静默销毁
      await fs.promises.mkdir(path.dirname(newFilePath), { recursive: true })
      if (fs.existsSync(newFilePath)) {
        sendMessageToWebContents(`Move ${oldPath} failed because ${newFilePath} already exists`)
        return false
      }
      await moveWithIdentity({ oldPath, newPath: newFilePath, type: book.type, libraryRoot: setting.library,
        persist: async identityFingerprint => {
          const [updated] = await Manga.update({ filepath: newFilePath, identityFingerprint, exist: true }, { where: { id: book.id } })
          if (updated !== 1) throw new Error('移动后的书目更新失败')
        }
      })
      sendMessageToWebContents(`Move ${oldPath} to ${newFilePath} successfully`)
      return newFilePath
    } else {
      sendMessageToWebContents(`Move ${oldPath} failed because the new path is the same as the old path`)
      return false
    }
  } catch (e) {
    sendMessageToWebContents(`Move ${oldPath} failed because ${e}`)
    return false
  }
})

// viewer
ipcMain.handle('load-manga-image-list', async (_event, book) => {
  const generation = ++readerGeneration
  if (readerExtractionTaskId) await taskService.cancel(readerExtractionTaskId)
  return readerQueue(async () => {
    await releaseImageCache?.('desktop-reader')
    if (generation !== readerGeneration) return []
    const { filepath, type, id: bookId } = book
    const extraction = await taskService.start('extract', { filepath, type, bookId, owner: 'desktop-reader' })
    readerExtractionTaskId = extraction.id
    try {
      if (generation !== readerGeneration) await taskService.cancel(extraction.id)
      const pages = await taskService.wait(extraction.id)
      return generation === readerGeneration && Array.isArray(pages) ? pages : []
    } catch (error) {
      if (generation !== readerGeneration || error.name === 'AbortError' || error.code === 'ABORT_ERR') return []
      throw error
    } finally {
      if (readerExtractionTaskId === extraction.id) readerExtractionTaskId = null
    }
  })
})

ipcMain.handle('release-sendimagelock', async () => {
  readerGeneration++
  if (readerExtractionTaskId) await taskService.cancel(readerExtractionTaskId)
  await readerQueue(() => releaseImageCache?.('desktop-reader'))
})

ipcMain.handle('delete-image', async (event, filename, filepath, type) => {
  try {
    if (!['folder', 'zip', 'archive'].includes(type)) throw new Error('不支持的书目类型')
    await assertWithin(setting.library, filepath, type === 'folder')
    return await deleteImageFromBook(filename, filepath, type)
  } catch (error) {
    sendMessageToWebContents(`删除页面失败：${filename}。${error.message || error}`)
    return false
  }
})

// setting
ipcMain.handle('select-folder', async (event, title) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openDirectory']
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('select-file', async (event, title, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ['openFile'],
    filters
  })
  if (!result.canceled) {
    return result.filePaths[0]
  } else {
    return undefined
  }
})

ipcMain.handle('load-setting', async (event, arg) => {
  return setting
})
ipcMain.handle('data-locations', () => ({ storePath:STORE_PATH, metadataPath:metadataSqliteFile }))
ipcMain.handle('save-library-exclusion', async (_event, pattern) => {
  if (typeof pattern !== 'string') throw new Error('请输入有效的书库排除规则')
  try { new RegExp(pattern) }
  catch { throw new Error('书库排除规则不是有效的正则表达式') }
  const updated = { ...setting, excludeFile: pattern }
  await writeAtomic(path.join(STORE_PATH, 'setting.json'), updated)
  setting = updated
  return pattern
})
ipcMain.handle('image-cache-status', () => getImageCacheStatus())
ipcMain.handle('image-cache-clear', () => clearUnusedImageCache())
ipcMain.handle('image-cache-budget', async (_event, bytes) => {
  if (!Number.isSafeInteger(bytes) || bytes < 128 * 1024 ** 2 || bytes > 64 * 1024 ** 3) throw new Error('缓存容量应为 128 MB 至 64 GB')
  const updated = { ...setting, imageCacheBudgetMB: bytes / 1024 ** 2 }
  const target = path.join(STORE_PATH, 'setting.json')
  const temporary = path.join(STORE_PATH, 'setting.json.tmp')
  const previousBytes = configuredCacheBytes()
  let cacheStatus
  try {
    cacheStatus = await setImageCacheBudget(bytes)
    await fs.promises.writeFile(temporary, JSON.stringify(updated, null, '  '), 'utf8')
    await fs.promises.rename(temporary, target)
  } catch (error) {
    await setImageCacheBudget(previousBytes).catch(() => {})
    throw error
  }
  setting = updated
  return cacheStatus
})

ipcMain.handle('window-minimize', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize()
})

ipcMain.handle('window-toggle-maximize', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win) return false
  if (win.isMaximized()) {
    win.unmaximize()
    return false
  } else {
    win.maximize()
    return true
  }
})

ipcMain.handle('window-is-maximized', (event) => {
  return BrowserWindow.fromWebContents(event.sender)?.isMaximized() ?? false
})

ipcMain.handle('window-close', (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close()
})

ipcMain.handle('relaunch-app', () => shutdownGuard.relaunch())

ipcMain.handle('save-setting', async (_event, receiveSetting) => {
  if (!receiveSetting || typeof receiveSetting !== 'object' || Array.isArray(receiveSetting)) throw new Error('程序设置格式无效')
  const previous = setting, next = { ...receiveSetting }
  if (setting.imageCacheBudgetMB !== undefined) next.imageCacheBudgetMB = setting.imageCacheBudgetMB
  const newMetadataDir = next.metadataPath || STORE_PATH, oldMetadataDir = previous.metadataPath || STORE_PATH
  if (typeof newMetadataDir !== 'string' || !path.isAbsolute(newMetadataDir)) throw new Error('元数据目录需要绝对路径')
  const proxyOptions = value => value ? { mode:'fixed_servers', proxyRules:value } : { mode:'direct' }
  const targetPath = path.join(STORE_PATH, 'setting.json')
  let replacement, written = false
  try {
    if (newMetadataDir !== oldMetadataDir) {
      replacement = prepareMetadataModel(path.join(newMetadataDir, 'metadata.sqlite'))
      await replacement.sync()
    }
    await session.defaultSession.setProxy(proxyOptions(next.proxy))
    await writeAtomic(targetPath, next)
    written = true
    setting = next
    if (next.startOnLogin !== previous.startOnLogin) app.setLoginItemSettings({ openAtLogin:!!next.startOnLogin })
    if (next.enabledLANBrowsing !== previous.enabledLANBrowsing) next.enabledLANBrowsing ? enableLANBrowsing() : disableLANBrowsing()
    if (replacement) {
      const oldModel = Metadata
      Metadata = replacement
      metadataSqliteFile = path.join(newMetadataDir, 'metadata.sqlite')
      replacement = null
      await oldModel.sequelize.close().catch(error => console.error('旧元数据连接未能释放：', error.message))
    }
    return setting
  } catch (error) {
    setting = previous
    if (replacement) await replacement.sequelize.close().catch(() => {})
    if (written) await writeAtomic(targetPath, previous)
    await session.defaultSession.setProxy(proxyOptions(previous.proxy)).catch(() => {})
    if (next.startOnLogin !== previous.startOnLogin) try { app.setLoginItemSettings({ openAtLogin:!!previous.startOnLogin }) } catch {}
    throw error
  }
})

const backupName = () => '颜如玉-备份-' + new Date().toISOString().replace(/[:.]/g, '-') + '.yru-backup'

async function captureClientState({ bestEffort = false } = {}) {
  try { await readingState.flush() }
  catch (error) { if (!bestEffort) throw error; console.error('Preserving unreadable reading state in a raw recovery point:', error.message) }
  try { await localSearch?.flush() }
  catch (error) { if (!bestEffort) throw error; console.error('Preserving unreadable local search state in a raw recovery point:', error.message) }
  // Only collect a snapshot here: invoking another queued IPC from this script
  // would deadlock the library queue that is protecting the backup.
  try {
    const snapshot = await mainWindow.webContents.executeJavaScript('globalThis.YanruyuClientState?.snapshot()')
    if (snapshot) writeClientState(STORE_PATH, snapshot)
  } catch (error) { if (!bestEffort) throw error; console.error('Preserving unreadable preferences in a raw recovery point:', error.message) }
}

async function pauseForRestore() {
  dataRestoreInProgress = true
  await taskService.stopAll({ wait: false }).catch(error => console.error('Task cancellation history:', error))
  ++readerGeneration
  await readerQueue(async () => {})
  const closed = await Promise.allSettled([Manga.sequelize.close(), Metadata.sequelize.close()])
  const failure = closed.find(result => result.status === 'rejected')
  if (failure) throw failure.reason
}

async function resumeAfterRollback() {
  Manga = prepareMangaModel(path.join(STORE_PATH, 'database.sqlite'))
  Metadata = prepareMetadataModel(metadataSqliteFile)
  try { await Manga.sync(); await Metadata.sync() }
  finally { dataRestoreInProgress = false }
}

function restartAfterRestore() {
  setTimeout(() => { app.relaunch(); app.exit(0) }, 600)
}

ipcMain.handle('load-ui-state', () => readClientState(STORE_PATH))
ipcMain.handle('save-ui-state', (_event, snapshot) => writeClientState(STORE_PATH, snapshot))

ipcMain.handle('backup-export', async (_event, options = {}) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: '创建完整备份', defaultPath: path.join(app.getPath('documents'), backupName()),
    filters: [{ name: '颜如玉完整备份', extensions: ['yru-backup'] }],
  })
  if (result.canceled || !result.filePath) return { canceled: true }
  await captureClientState()
  return backupService.createBackup(result.filePath, { includeCovers: options.includeCovers !== false })
})

ipcMain.handle('backup-inspect', async () => {
  backupPreviews.clear()
  const result = await dialog.showOpenDialog(mainWindow, { title: '选择备份并查看恢复内容',
    properties: ['openFile'], filters: [{ name: '颜如玉完整备份', extensions: ['yru-backup'] }] })
  if (result.canceled || !result.filePaths[0]) return { canceled: true }
  const preview = await backupService.inspectBackup(result.filePaths[0])
  const token = require('crypto').randomUUID()
  backupPreviews.clear()
  backupPreviews.set(token, { ...preview, expires: Date.now() + 30 * 60 * 1000 })
  return { ...preview, token, canceled: false }
})

ipcMain.handle('backup-restore', async (_event, token) => {
  const preview = typeof token === 'string' ? backupPreviews.get(token) : undefined
  if (!preview || preview.expires < Date.now()) throw new Error('恢复预览已过期，请重新选择备份')
  backupPreviews.delete(token)
  await captureClientState({ bestEffort: true })
  try {
    const result = await backupService.restoreBackup(preview.path, {
      expectedDigest: preview.digest, beforeCommit: pauseForRestore, onRollback: resumeAfterRollback,
    })
    restartAfterRestore()
    return result
  } catch (error) {
    if (!error.rollbackFailed) dataRestoreInProgress = false
    throw error
  }
})

// Keep the manager's existing export button useful: it now creates the same
// complete versioned package as the reading-room data-protection panel.
ipcMain.handle('export-database', async (_event, folder) => {
  if (!folder) return false
  if (typeof folder !== 'string' || !path.isAbsolute(folder)) throw new Error('备份目录无效')
  await captureClientState()
  const result = await backupService.createBackup(path.join(folder, backupName()))
  sendMessageToWebContents('完整备份已保存：' + result.path)
  return result.success
})

ipcMain.handle('import-database', async (_event, files = {}) => {
  if (!files.collectionListPath || !files.metadataSqlitePath) return { success: false, canceled: true }
  const summary = await backupService.inspectLegacy(files)
  const choice = await dialog.showMessageBox(mainWindow, {
    type: 'question', title: '导入旧格式数据', buttons: ['取消', '导入并重新启动'], defaultId: 0, cancelId: 0,
    message: `将导入 ${summary.metadata} 条元数据、${summary.collections} 个合集。`,
    detail: '这两项将替换当前内容；主书库和阅读档案保留。导入前会自动保存完整恢复点，校验或写入失败会回滚。',
  })
  if (choice.response !== 1) return { success: false, canceled: true }
  await captureClientState({ bestEffort: true })
  try {
    const result = await backupService.restoreLegacy(files, { beforeCommit: pauseForRestore, onRollback: resumeAfterRollback })
    restartAfterRestore()
    return result
  } catch (error) {
    if (!error.rollbackFailed) dataRestoreInProgress = false
    throw error
  }
})

ipcMain.handle('archive-recovery-list', () => listArchiveRecoveryPoints(STORE_PATH))
ipcMain.handle('archive-recovery-restore', async (_event, id) => {
  ++readerGeneration
  await readerQueue(async () => {})
  const result = await restoreArchiveRecoveryPoint(STORE_PATH, id, { libraryPath: setting.library })
  let generatedCover, retainedCover
  try {
    const book = await Manga.findOne({ where: { filepath: result.restoredPath }, raw: true })
    if (book) {
      const refreshed = await geneCover(book.filepath, book.type)
      generatedCover = refreshed.coverPath
      const hash = await hashFile(refreshed.targetFilePath)
      const identityFingerprint = await fingerprintBook(book.filepath, book.type)
      const cover = await coverForRefresh(book, refreshed, COVER_PATH)
      await Manga.update({ ...cover, pageCount: refreshed.pageCount,
        bundleSize: refreshed.bundleSize, mtime: refreshed.mtime.toJSON(),
        hash, identityFingerprint }, { where: { id: book.id } })
      retainedCover = cover.coverPath
    }
  } catch (error) {
    result.warning = '原压缩包已恢复，书目刷新失败，可重新生成封面：' + error.message
  } finally {
    if (generatedCover && generatedCover !== retainedCover) {
      await assertWithin(COVER_PATH, generatedCover).then(() => fs.promises.unlink(generatedCover)).catch(() => {})
    }
  }
  lanListExpires = 0
  return result
})

ipcMain.handle('data-protection-open-recovery', async () => {
  const directory = assertLocalPath(STORE_PATH, path.join(controlPath(STORE_PATH), 'restore-points'))
  await fs.promises.mkdir(directory, { recursive: true })
  const error = await shell.openPath(directory)
  if (error) throw new Error(error)
  return true
})

ipcMain.handle('import-sqlite', async (event, bookList) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'SQLite', extensions: ['sqlite'] }]
  })
  if (result.canceled || !result.filePaths?.[0]) {
    return { success: false, canceled: true, bList: bookList, bookList }
  }
  const imported = await importSqliteMetadata({
    filename: result.filePaths[0],
    books: bookList,
    Manga,
    Metadata,
    getEhviewerData: getEhviewerDataManually,
    onProgress: setProgressBar,
  })
  sendMessageToWebContents(imported.message)
  return imported
})


// tools

ipcMain.handle('set-progress-bar', async (event, progress) => {
  setProgressBar(progress)
})

ipcMain.handle('get-locale', async (event, arg) => {
  return app.getLocale()
})

ipcMain.handle('copy-image-to-clipboard', async (event, filepath) => {
  clipboard.writeImage(nativeImage.createFromPath(filepath))
})

ipcMain.handle('copy-text-to-clipboard', async (event, text) => {
  clipboard.writeText(text)
})

ipcMain.handle('read-text-from-clipboard', async () => {
  return clipboard.readText()
})

ipcMain.handle('update-window-title', async (event, title) => {
  const name = require('./package.json').productName || '颜如玉'
  const version = require('./package.json').version
  if (title) {
    mainWindow.setTitle(name + ' ' + version + ' | ' + title)
  } else {
    mainWindow.setTitle(name + ' ' + version)
  }
})

ipcMain.handle('switch-fullscreen', async (event, arg) => {
  mainWindow.setFullScreen(!mainWindow.isFullScreen())
})

ipcMain.on('get-path-sep', async (event, arg) => {
  event.returnValue = trustedSender(event) ? path.sep : ''
})


// 初始化Express
const LANBrowsing = express()
const port = 23786
const sortkey_map = {
  "date_added": {
    key: "date",
    type: "number"
  },
  "date_modified": {
    key: "mtime",
    type: "date"
  },
  "date_posted": {
    key: "posted",
    type: "number"
  },
  "size": {
    key: "bundleSize",
    type: "number"
  },
  "rating": {
    key: "rating",
    type: "number"
  },
  "read_count": {
    key: "readCount",
    type: "number"
  },
  "random": {},
  // LANraragi 客户端默认按 title 排序,缺这一项会让 compareItems 抛错,整个列表 500
  "title": {
    key: "title",
    type: "string"
  }
}

LANBrowsing.disable('x-powered-by')
LANBrowsing.set('query parser', 'simple')
LANBrowsing.use((req, res, next) => {
  // Block browser-origin requests and DNS rebinding; native LAN clients send no Origin.
  if (req.headers.origin || (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'none' && req.headers['sec-fetch-site'] !== 'same-origin')) return res.sendStatus(403)
  const host = (req.headers.host || '').replace(/:\d+$/, '')
  if (host !== 'localhost' && require('net').isIP(host) === 0) return res.sendStatus(403)
  res.set('X-Content-Type-Options', 'nosniff')
  next()
})

let mangas = []
let lanListPromise
let lanListExpires = 0
const getLANBookList = () => {
  if (!lanListPromise || Date.now() >= lanListExpires) {
    lanListExpires = Date.now() + 2000
    lanListPromise = (async () => {
      await schemaReady
      const [books, metadata] = await Promise.all([Manga.findAll({ raw: true }), Metadata.findAll({ raw: true })])
      // Sequelize raw mode bypasses JSON field parsing for SQLite.
      const normalize = book => {
        if (typeof book.tags === 'string') { try { book.tags = JSON.parse(book.tags) } catch { book.tags = {} } }
        return book
      }
      const byHash = new Map(metadata.map(m => [m.hash, normalize(m)]))
      return books.map(book => Object.assign(normalize(book), byHash.get(book.hash) || {}))
    })().catch(error => { lanListPromise = undefined; throw error })
  }
  return lanListPromise
}
let tagTranslation = undefined

// sort
function compareItems(a, b, sortKey, ascending = false) {
  const sortConfig = sortkey_map[sortKey]
  if (!sortConfig) {
    throw new Error(`Invalid sort key: ${sortKey}`)
  }

  const { key, type } = sortConfig

  let valA = a[key]
  let valB = b[key]

  if (type === "number") {
    valA = Number(valA) || 0
    valB = Number(valB) || 0
  } else if (type === "date") {
    valA = new Date(valA).getTime() || 0
    valB = new Date(valB).getTime() || 0
  } else {
    valA = String(valA || "")
    valB = String(valB || "")
  }

  if (valA < valB) return ascending ? -1 : 1
  if (valA > valB) return ascending ? 1 : -1
  return 0
}

// 格式化标签
const formatTags = (tags) => {
  return Object.entries(tags || {})
    .map(([key, values]) => (Array.isArray(values) ? values : []).map(value => setting.showTranslation ? `${tagTranslation?.[key]?._name || key}:${tagTranslation?.[key]?.[value]?.name || value}` : `${key}:${value}`).join(', '))
    .join(', ')
}

ipcMain.handle('update-tag-translation', async (event, _tagTranslation) => {
  tagTranslation = _tagTranslation
})

LANBrowsing.get('/api/search', async (req, res) => {
  try {
    const filter = typeof req.query.filter === 'string' ? req.query.filter.slice(0, 1000) : ''
    const start = Math.max(0, parseInt(req.query.start, 10) || 0)
    const length = Math.max(1, Math.min(1000, parseInt(req.query.length, 10) || 200))
    // 默认使用阅读次数排序, 来匹配 mihon 热门不带 sortby
    let sortKey = typeof req.query.sortby === 'string' ? req.query.sortby : 'read_count'
    let showAll = false
    if (sortKey.includes("_all")) {
      sortKey = sortKey.replace("_all", "")
      showAll = true
    }
    // 未知排序键退回默认,而不是让 compareItems 抛错把整个请求打成 500
    if (!sortkey_map[sortKey]) sortKey = 'read_count'

    // 读取并搜索数据库
    mangas = await getLANBookList()
    let filterMangas
    if (filter) {
      filterMangas = mangas.filter(manga => {
        return JSON.stringify(_.pick(manga, ['title', 'title_jpn', 'status', 'category', 'filepath', 'url'])).toLowerCase().includes(filter.toLowerCase())
        || formatTags(manga.tags).toLowerCase().includes(filter.toLowerCase())
      })
    } else {
      filterMangas = mangas.slice()
    }

    if (sortKey !== 'random') {
      filterMangas = filterMangas.sort((a, b) => compareItems(a, b, sortKey))
    } else {
      filterMangas = _.shuffle(filterMangas)
    }
    // 先记下总数,下面这行会把 filterMangas 覆盖成当前页,否则 recordsTotal 会等于页长
    const totalCount = mangas.length
    const filteredCount = filterMangas.length
    filterMangas = showAll ? filterMangas : filterMangas.slice(start, start + length)

    // 格式化响应数据
    const responseData = filterMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
      url: manga.url
    }))
    const hash = createHash('md5').update(JSON.stringify(responseData)).digest('hex')
    res.json({
      data: responseData,
      hash,
      draw: 0,
      recordsFiltered: filteredCount,
      recordsTotal: totalCount
    })
  } catch (error) {
    res.status(500).send(error.message)
  }
})

LANBrowsing.get('/api/search/random', async (req, res) => {
  try {
    // 从数据库中随机获取指定数量的 Manga 记录
    const count = Math.max(1, Math.min(1000, parseInt(req.query.count, 10) || 1))
    const randomMangas = _.sampleSize(await getLANBookList(), count)

    const responseData = randomMangas.map(manga => ({
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }))

    res.json({
      data: responseData
    })
  } catch (error) {
    console.error('Failed to fetch random Manga:', error)
    res.status(500).send('Internal Server Error')
  }
})

LANBrowsing.get('/api/archives/:hash/metadata', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    mangas = await getLANBookList()
    const manga = await mangas.find(manga => manga.hash === mangaHash)

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    // 构造响应数据
    const responseMetadata = {
      arcid: manga.hash,
      extension: path.extname(manga.filepath),
      filename: path.basename(manga.filepath),
      isnew: 'true',
      lastreadtime: 0,
      pagecount: manga.pageCount,
      progress: 0,
      size: manga.filesize,
      summary: null,
      tags: manga.tags ? formatTags(manga.tags) : '',
      title: `${manga.title_jpn && manga.title ? `${manga.title_jpn} || ${manga.title}` : manga.title}`,
      category: manga.category,
    }

    res.json(responseMetadata)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理封面图片请求
LANBrowsing.get('/api/archives/:hash/thumbnail', async (req, res) => {
  try {
    const hash = req.params.hash
    const manga = await Manga.findOne({where: {hash: hash}})
    if (!manga || !manga.coverPath || !fs.existsSync(manga.coverPath)) {
      return res.status(404).send('Cover not found')
    }
    // 直接发源文件,不再中转到 staticFilePath —— 那个目录会被 /files 和 /page 清空
    res.sendFile(manga.coverPath, err => { if (err && !res.headersSent) res.status(404).end() })
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.status(500).send('Error serving cover')
  }
})

let existBook = {
  hash: null,
  imageList: []
}

// 处理章节列表请求
LANBrowsing.get('/api/archives/:hash/files', async (req, res) => {
  try {
    const mangaHash = req.params.hash

    // 从数据库找到对应的漫画
    const manga = await Manga.findOne({where: {hash: mangaHash}})

    if (!manga) {
      return res.status(404).send('Manga not found')
    }

    // 原先这里会清空 VIEWER_PATH 和 staticFilePath —— 前者是桌面阅读器正在用的目录,
    // 后者是另一个请求刚复制进去的响应内容,并发读不同的书时互相删文件导致 404
    const imageList = await getImageListByBook(manga.filepath, manga.type)

    existBook = {
      hash: manga.hash,
      imageList: imageList.map(p => p.absolutePath)
    }
    // 构造响应数据
    const responseFiles = {
      job: Date.now(), // 示例中的 job 可以是一个随机数或时间戳
      pages: imageList.map((file, index) => `/api/archives/${manga.hash}/page?path=${index + 1}`)
    }

    res.json(responseFiles)
  } catch (error) {
    res.status(500).send(error.message)
  }
})

// 处理章节图片请求
LANBrowsing.get('/api/archives/:hash/page', async (req, res) => {
  const hash = req.params.hash
  const page = parseInt(req.query.path, 10)
  if (isNaN(page) || page < 1) {
    return res.status(400).send('Invalid page number')
  }

  // 获取章节图片列表
  try {
    const manga = await Manga.findOne({where: {hash: hash}})
    if (!manga || !manga.filepath) {
      return res.status(404).send('File not found')
    }
    const imageList = (await getImageListByBook(manga.filepath, manga.type)).map(p => p.absolutePath)
    const imageFilePath = imageList[page - 1]
    if (!imageFilePath) {
      return res.status(404).send('Image not found')
    }

    // 直接发源文件,不再复制到会被清空的 staticFilePath
    if (!fs.existsSync(imageFilePath)) {
      return res.status(404).send('Image file not found')
    }
    res.sendFile(imageFilePath, err => { if (err && !res.headersSent) res.status(404).end() })
  } catch (err) {
    console.error(err)
    if (!res.headersSent) res.status(500).send('Error processing file')
  }
})

// 处理webview请求
LANBrowsing.get('/reader', async (req, res) => {
  // express 4 不接管 async handler 的 rejection,不 catch 的话请求会一直挂到超时
  try {
    const id = req.query.id
    const manga = await Manga.findOne({where: {hash: id}})

    // 重定向至manga.url
    if (manga && manga.url) {
      res.redirect(webURL(manga.url.replace('exhentai', 'e-hentai')))
    } else {
      res.status(404).send('Manga not found')
    }
  } catch (e) {
    console.error(e)
    if (!res.headersSent) res.status(500).send('Internal Server Error')
  }
})

LANBrowsing.get('/', (req, res) => {
  switch (setting.language) {
    case 'en-US':
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/LAN-Browsing')
      break
    case 'zh-CN':
    case 'zh-TW':
    default:
      res.redirect('https://github.com/SchneeHertz/exhentai-manga-manager/wiki/%E5%B1%80%E5%9F%9F%E7%BD%91%E6%B5%8F%E8%A7%88')
      break
  }
})

let LANBrowsingInstance
const startLANServer = () => {
  const server = LANBrowsing.listen(port, '0.0.0.0', () => {
    sendMessageToWebContents(`LAN browsing listening at http://0.0.0.0:${port}`)
  })
  server.on('error', (e) => {
    if (LANBrowsingInstance === server) LANBrowsingInstance = undefined
    console.error('LAN browsing listen failed', e)
    sendMessageToWebContents(e.code === 'EADDRINUSE'
      ? `LAN browsing could not start: port ${port} is already in use (another instance running?)`
      : `LAN browsing failed: ${e.message}`)
  })
  return server
}
const enableLANBrowsing = () => {
  // Repeated UI initialization must not restart the listener or leave a deferred
  // restart capable of undoing the user's later disable action.
  if (!LANBrowsingInstance) LANBrowsingInstance = startLANServer()
}
const disableLANBrowsing = () => {
  const server = LANBrowsingInstance
  LANBrowsingInstance = undefined
  if (!server) return
  server.close(() => sendMessageToWebContents('LAN browsing closed'))
  // Stop keep-alive clients and streams as soon as sharing is turned off.
  server.closeAllConnections?.()
}

ipcMain.handle('enable-LAN-browsing', async (event, arg) => {
  if (setting.enabledLANBrowsing) enableLANBrowsing()
})
