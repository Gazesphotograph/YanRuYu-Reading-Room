'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const { promisify } = require('node:util')
const { execFile } = require('node:child_process')
const { createHash } = require('node:crypto')

const project = path.resolve(__dirname, '..')
const appDir = path.join(project, 'resources', 'app')
const appRequire = createRequire(path.join(appDir, 'package.json'))
const sqlite3 = appRequire('sqlite3')
const { open } = appRequire('sqlite')
const { prepareMangaModel, prepareMetadataModel } = appRequire('./modules/database')
const recovery = appRequire('./modules/archive_recovery')
const { importSqliteMetadata, parseTagList } = appRequire('./modules/sqlite_metadata_import')
const safety = appRequire('./modules/safety')
const artifacts = path.join(__dirname, '.artifacts', 'safe-operations')
fs.mkdirSync(artifacts, { recursive: true })
const fixture = fs.mkdtempSync(path.join(artifacts, 'run-'))
const report = { date: new Date().toISOString(), fixture, checks: [], errors: [] }
const pass = name => { report.checks.push(name); console.log('PASS ' + name) }
const hash = buffer => createHash('sha256').update(buffer).digest('hex')
const fileHash = filename => hash(fs.readFileSync(filename))
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=', 'base64')

function loadModule(relative, overrides) {
  const filename = path.join(appDir, relative)
  const nativeRequire = createRequire(filename)
  const context = { module: { exports: {} }, console, Buffer, process, require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return context.module.exports
}

function loadHandler(channel, dependencies) {
  const source = fs.readFileSync(path.join(appDir, 'index.js'), 'utf8')
  const start = source.indexOf(`ipcMain.handle('${channel}',`)
  assert(start >= 0, 'Missing IPC handler ' + channel)
  const ending = /\r?\n\}\)/g
  ending.lastIndex = start
  const end = ending.exec(source)
  assert(end, 'Missing IPC handler ending ' + channel)
  let handler
  vm.runInNewContext(source.slice(start, end.index + end[0].length), { ...dependencies, ipcMain: { handle(name, fn) { assert.equal(name, channel); handler = fn } } })
  return handler
}

async function trashFailureChecks() {
  const library = path.join(fixture, 'trash-library')
  const book = path.join(library, 'Neutral Pages')
  const recycle = path.join(fixture, 'mock-recycle')
  fs.mkdirSync(book, { recursive: true })
  fs.mkdirSync(recycle)
  fs.writeFileSync(path.join(book, 'page1.png'), png)
  fs.writeFileSync(path.join(book, 'page2.png'), png)
  fs.writeFileSync(path.join(book, 'notes.sqlite'), 'preserve non-image data')
  let removedRecords = 0
  const messages = []
  const shell = { trashItem: async () => { throw new Error('simulated recycle failure') } }
  const folder = loadModule('fileLoader/folder.js', { electron: { shell } })
  await assert.rejects(folder.deleteImageFromFolder('page1.png', book), /回收站.*simulated recycle failure/)
  assert.deepEqual(fs.readFileSync(path.join(book, 'page1.png')), png)
  const deleteBook = loadHandler('delete-local-book', {
    fs, path, setting: { library }, shell, glob: appRequire('glob').glob,
    ...safety, Manga: { destroy: async () => { removedRecords++ } }, sendMessageToWebContents: message => messages.push(message),
  })
  assert.equal(await deleteBook(null, book), false)
  assert.equal(removedRecords, 0)
  assert.equal(fs.readdirSync(book).length, 3)
  assert.match(messages.at(-1), /保留书库记录.*simulated recycle failure/)
  pass('Recycle failure preserves page bytes, all original files, and the book record')

  let recycled = 0
  shell.trashItem = async filename => {
    if (recycled++) throw new Error('simulated second-page failure')
    await fs.promises.rename(filename, path.join(recycle, path.basename(filename)))
  }
  assert.equal(await deleteBook(null, book), false)
  assert.equal(removedRecords, 0)
  assert.equal(fs.readdirSync(recycle).length, 1)
  assert.equal(fs.readdirSync(book).filter(name => name.endsWith('.png')).length, 1)
  assert.match(messages.at(-1), /已有 1 张图片移入系统回收站/)
  assert.equal(fs.readFileSync(path.join(book, 'notes.sqlite'), 'utf8'), 'preserve non-image data')
  pass('Partial recycle failure stops the batch, preserves the record, and reports the recoverable page count')

  shell.trashItem = async filename => fs.promises.rename(filename, path.join(recycle, path.basename(filename)))
  assert.equal(await deleteBook(null, book), true)
  assert.equal(removedRecords, 1)
  assert.deepEqual(fs.readdirSync(book), ['notes.sqlite'])
  const deletePage = loadHandler('delete-image', {
    setting: { library }, ...safety,
    deleteImageFromBook: async () => { throw new Error('simulated protected delete failure') },
    sendMessageToWebContents: message => messages.push(message),
  })
  assert.equal(await deletePage(null, 'page.png', book, 'folder'), false)
  assert.match(messages.at(-1), /删除页面失败.*simulated protected delete failure/)
  pass('Successful book deletion preserves non-image files; page IPC returns false and a real failure reason')
}

async function archiveChecks() {
  const sevenZip = path.join(project, 'resources', 'extraResources', '7z.exe')
  const run7z = async (args, cwd) => (await promisify(execFile)(sevenZip, args, { cwd, windowsHide: true, timeout: 120000 })).stdout
  const library = path.join(fixture, 'archive-library')
  const source = path.join(fixture, 'neutral-archive-pages')
  const store = path.join(fixture, 'archive-store')
  fs.mkdirSync(path.join(source, '子目录'), { recursive: true })
  fs.mkdirSync(library)
  fs.mkdirSync(store)
  fs.writeFileSync(path.join(source, '子目录', 'page 01.png'), png)
  fs.writeFileSync(path.join(source, 'page 02.png'), png)
  fs.writeFileSync(path.join(source, 'notes.txt'), 'preserve this archive entry')
  const archive = loadModule('fileLoader/archive.js', {
    '../modules/utils.js': { getRootPath: () => project },
    '../modules/init_folder_setting': { STORE_PATH: store },
  })
  const zip = path.join(library, 'Neutral Book.zip')
  await run7z(['a', '-tzip', '-y', '--', zip, '子目录', 'page 02.png', 'notes.txt'], source)
  const originalBytes = fs.readFileSync(zip)
  assert.equal(await archive.deleteImageFromArchive('子目录/page 01.png', zip), true)
  const editedBytes = fs.readFileSync(zip)
  assert.notEqual(hash(editedBytes), hash(originalBytes))
  const imageNames = archive.validateArchiveListing(await run7z(['l', '-slt', '-ba', '-sccUTF-8', '--', zip]))
  assert.equal(imageNames.length, 1)
  assert.equal(imageNames[0], 'page 02.png')
  assert.match(await run7z(['l', '-slt', '-ba', '-sccUTF-8', '--', zip]), /notes\.txt/)
  let points = await recovery.listArchiveRecoveryPoints(store)
  assert.equal(points.length, 1)
  assert.equal(points[0].status, 'completed')
  assert.equal(points[0].sha256, hash(originalBytes))
  const point = points[0]
  const restored = await recovery.restoreArchiveRecoveryPoint(store, point.id, { libraryPath: library })
  assert.equal(restored.success, true)
  assert.deepEqual(fs.readFileSync(zip), originalBytes)
  assert(restored.previousRecoveryId)
  await recovery.restoreArchiveRecoveryPoint(store, restored.previousRecoveryId, { libraryPath: library })
  assert.deepEqual(fs.readFileSync(zip), editedBytes)
  pass('Real 7z ZIP deletion handles nested Unicode paths; restoration and undo of restoration preserve exact archive bytes')

  const cb7 = path.join(library, 'Neutral Book.cb7')
  await run7z(['a', '-t7z', '-y', '--', cb7, '子目录', 'page 02.png', 'notes.txt'], source)
  const cb7Bytes = fs.readFileSync(cb7)
  assert.equal(await archive.deleteImageFromArchive('page 02.png', cb7), true)
  const cb7Point = (await recovery.listArchiveRecoveryPoints(store)).find(item => item.originalPath === cb7)
  await recovery.restoreArchiveRecoveryPoint(store, cb7Point.id, { libraryPath: library })
  assert.deepEqual(fs.readFileSync(cb7), cb7Bytes)
  pass('Real 7z-format CB7 deletion and restoration retain a persistent recovery point')

  await assert.rejects(recovery.restoreArchiveRecoveryPoint(store, point.id, { libraryPath: source }), /当前书库/)
  await assert.rejects(recovery.restoreArchiveRecoveryPoint(store, '../unsafe', { libraryPath: library }), /编号无效/)
  const backup = path.join(store, 'recovery', point.id, 'original.zip')
  const damaged = Buffer.from(originalBytes)
  damaged[0] ^= 1
  fs.writeFileSync(backup, damaged)
  await assert.rejects(recovery.restoreArchiveRecoveryPoint(store, point.id, { libraryPath: library }), /SHA256/)
  assert.deepEqual(fs.readFileSync(zip), editedBytes)
  fs.writeFileSync(backup, originalBytes)
  pass('Recovery rejects outside-library targets, path traversal, and same-size backup corruption without touching the book')

  const failureArchive = path.join(library, 'Interrupted.zip')
  fs.writeFileSync(failureArchive, originalBytes)
  let verified = false
  await assert.rejects(recovery.editArchiveSafely({
    storePath: store, filepath: failureArchive, removedEntry: 'page 02.png',
    modify: async staged => { await fs.promises.writeFile(staged, 'simulated damaged working copy'); throw new Error('simulated tool interruption') },
    verify: async () => { verified = true },
  }), /原包未改动.*simulated tool interruption/)
  assert.equal(verified, false)
  assert.deepEqual(fs.readFileSync(failureArchive), originalBytes)
  const failedPoint = (await recovery.listArchiveRecoveryPoints(store)).find(item => item.originalPath === failureArchive)
  assert.equal(failedPoint.status, 'failed')
  assert.equal(failedPoint.sha256, hash(originalBytes))
  pass('An interrupted archive tool can damage only its working copy; the original and recovery copy survive')

  const collateralArchive = path.join(library, 'Collateral.zip')
  fs.writeFileSync(collateralArchive, originalBytes)
  const realRunner = appRequire('./modules/process_runner').spawnPromise
  const faultyArchive = loadModule('fileLoader/archive.js', {
    '../modules/utils.js': { getRootPath: () => project },
    '../modules/init_folder_setting': { STORE_PATH: store },
    '../modules/process_runner': { spawnPromise: async (binary, args, timeout) => {
      const result = await realRunner(binary, args, timeout)
      if (args[0] === 'd') await realRunner(binary, ['d', '-spd', '--', args[args.indexOf('--') + 1], 'notes.txt'])
      return result
    } },
  })
  await assert.rejects(faultyArchive.deleteImageFromArchive('page 02.png', collateralArchive), /改变了其他文件/)
  assert.deepEqual(fs.readFileSync(collateralArchive), originalBytes)
  pass('A valid archive that unexpectedly lost a non-image entry is rejected before replacement')

  const missingArchive = path.join(library, 'Missing.zip')
  fs.writeFileSync(missingArchive, originalBytes)
  const missingPoint = await recovery.createArchiveRecoveryPoint(store, missingArchive)
  assert(safety.isWithin(fixture, missingArchive))
  fs.unlinkSync(missingArchive)
  const recreated = await recovery.restoreArchiveRecoveryPoint(store, missingPoint.record.id, { libraryPath: library })
  assert.equal(recreated.previousRecoveryId, null)
  assert.deepEqual(fs.readFileSync(missingArchive), originalBytes)
  pass('A missing archive is restored without overwriting any existing target')

  const lockedArchive = path.join(library, 'Locked.zip')
  fs.writeFileSync(lockedArchive, originalBytes)
  const blockedRenameFs = { ...fs, promises: { ...fs.promises, rename: async (from, to) => {
    if (to === lockedArchive) throw Object.assign(new Error('simulated archive lock'), { code: 'EBUSY' })
    return fs.promises.rename(from, to)
  } } }
  const lockedRecovery = loadModule('modules/archive_recovery.js', { fs: blockedRenameFs })
  await assert.rejects(lockedRecovery.editArchiveSafely({ storePath: store, filepath: lockedArchive, modify: async () => {}, verify: async () => {} }), /simulated archive lock/)
  assert.deepEqual(fs.readFileSync(lockedArchive), originalBytes)
  assert.equal(fs.readdirSync(library).filter(name => name.includes('.manager-')).length, 0)
  pass('Atomic replacement failure preserves the original and removes only the owned working copy')

  const noBackupArchive = path.join(library, 'No Space.zip')
  fs.writeFileSync(noBackupArchive, originalBytes)
  const noSpaceFs = { ...fs, promises: { ...fs.promises, copyFile: async () => { throw new Error('simulated no space for backup') } } }
  const noSpaceRecovery = loadModule('modules/archive_recovery.js', { fs: noSpaceFs })
  let modified = false
  await assert.rejects(noSpaceRecovery.editArchiveSafely({ storePath: store, filepath: noBackupArchive, modify: async () => { modified = true }, verify: async () => {} }), /无法创建.*simulated no space/)
  assert.equal(modified, false)
  assert.deepEqual(fs.readFileSync(noBackupArchive), originalBytes)
  pass('Recovery copy failure aborts before the archive tool runs and preserves the source')

  const changedArchive = path.join(library, 'External Change.zip')
  fs.writeFileSync(changedArchive, originalBytes)
  await assert.rejects(recovery.editArchiveSafely({
    storePath: store, filepath: changedArchive,
    modify: async () => fs.promises.writeFile(changedArchive, 'new content written by another process'),
    verify: async () => {},
  }), /其他操作修改/)
  assert.equal(fs.readFileSync(changedArchive, 'utf8'), 'new content written by another process')
  pass('An external archive change detected during editing is never overwritten')
}

async function databaseFixture(name, specifications, galleryRows) {
  const directory = path.join(fixture, name)
  fs.mkdirSync(directory)
  const Manga = prepareMangaModel(path.join(directory, 'database.sqlite'))
  const Metadata = prepareMetadataModel(path.join(directory, 'metadata.sqlite'))
  await Manga.sync()
  await Metadata.sync()
  const values = specifications.map(([id, title, status = 'non-tag']) => ({
    id, hash: 'hash-' + id, title: title + '.zip', filepath: path.join(directory, title + '.zip'), type: 'zip', status,
    mark: true, hiddenBook: true, readCount: 7, tags: { old: ['preserved until import'] },
  }))
  await Manga.bulkCreate(values)
  const books = (await Manga.findAll({ order: [['id', 'ASC']] })).map(book => book.toJSON())
  const sourcePath = path.join(directory, 'source.sqlite')
  const sourceDb = await open({ filename: sourcePath, driver: sqlite3.Database })
  await sourceDb.exec('CREATE TABLE gallery (gid INTEGER, token TEXT, title TEXT, title_jpn TEXT, torrents TEXT, thumb TEXT, language TEXT, artist TEXT, filecount TEXT, rating TEXT, posted TEXT, filesize TEXT, category TEXT)')
  let gid = 1
  for (const row of galleryRows) {
    await sourceDb.run('INSERT INTO gallery (gid, token, title, title_jpn, language, artist, filecount, rating, posted, filesize, category) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [gid++, '0123456789', row.title, row.title_jpn || null, row.language ?? "['english']", row.artist ?? JSON.stringify(["O'Brien"]), '2', row.rating ?? '4.5', '1600000000', '128', 'Manga'])
  }
  await sourceDb.close()
  const close = () => Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()])
  return { directory, Manga, Metadata, books, sourcePath, close }
}

async function sqliteChecks() {
  assert.deepEqual(parseTagList('["O\'Brien"]', 'artist'), ["O'Brien"])
  assert.deepEqual(parseTagList("['O\\'Brien', 'Artist with \"quotes\"']", 'artist'), ["O'Brien", 'Artist with "quotes"'])
  await assert.rejects(async () => parseTagList('{"bad":"object"}', 'artist'), /字符串数组/)
  pass('Tag parsing preserves apostrophes and accepts legacy string arrays without executing input')

  const successDb = await databaseFixture('sqlite-success', [['a', 'Neutral Match'], ['b', 'No Such Gallery'], ['c', 'Already Tagged', 'tagged']], [{ title: 'Neutral Match' }])
  try {
    await successDb.Metadata.create({ hash: 'hash-a', title: 'Old cache title', status: 'non-tag', mark: true })
    const progress = [], sourceBefore = fileHash(successDb.sourcePath)
    const result = await importSqliteMetadata({ filename: successDb.sourcePath, books: successDb.books, Manga: successDb.Manga, Metadata: successDb.Metadata, onProgress: value => progress.push(value) })
    assert.equal(result.success, true)
    assert.deepEqual(result.counts, { total: 3, eligible: 2, matched: 1, imported: 1, failed: 0, unmatched: 1, skipped: 1 })
    assert.equal(result.bList, result.bookList)
    assert.equal(result.bList[0].status, 'tagged')
    assert.equal(successDb.books[0].status, 'non-tag')
    assert.equal(progress.at(-1), -1)
    assert.equal(fileHash(successDb.sourcePath), sourceBefore)
    const persisted = (await successDb.Manga.findByPk('a')).toJSON()
    assert.equal(persisted.mark, true)
    assert.equal(persisted.hiddenBook, true)
    assert.equal(persisted.readCount, 7)
    assert.deepEqual(persisted.tags.artist, ["O'Brien"])
    const metadata = (await successDb.Metadata.findByPk('hash-a')).toJSON()
    assert.equal(metadata.status, 'tagged')
    assert.equal(metadata.mark, true)
    pass('Successful SQLite import reports real imported/unmatched/skipped counts and preserves user state in both databases')

    const badText = path.join(successDb.directory, 'not-sqlite.sqlite')
    fs.writeFileSync(badText, 'This is not a SQLite database; it must never be imported.')
    const wrongSchema = path.join(successDb.directory, 'wrong-schema.sqlite')
    const empty = await open({ filename: wrongSchema, driver: sqlite3.Database })
    await empty.exec('CREATE TABLE unrelated (value TEXT)')
    await empty.close()
    const absent = path.join(successDb.directory, 'does-not-exist.sqlite')
    const beforeMain = fileHash(successDb.Manga.sequelize.options.storage)
    const beforeMetadata = fileHash(successDb.Metadata.sequelize.options.storage)
    for (const filename of [badText, wrongSchema, absent]) {
      const failedProgress = []
      const failed = await importSqliteMetadata({ filename, books: successDb.books, Manga: successDb.Manga, Metadata: successDb.Metadata, onProgress: value => failedProgress.push(value) })
      assert.equal(failed.success, false)
      assert.equal(failed.canceled, false)
      assert.equal(failed.counts.imported, 0)
      assert.equal(failed.counts.failed, 2)
      assert(failed.failures[0].reason)
      assert.match(failed.message, /导入失败/)
      assert.equal(failedProgress.at(-1), -1)
      assert.equal(fileHash(successDb.Manga.sequelize.options.storage), beforeMain)
      assert.equal(fileHash(successDb.Metadata.sequelize.options.storage), beforeMetadata)
    }
    assert.equal(fs.existsSync(absent), false)
    pass('Bad SQLite format, missing gallery schema, and missing files return failure without changing either target database')
  } finally { await successDb.close() }

  const mixedDb = await databaseFixture('sqlite-mixed', [['a', 'Good'], ['b', 'Bad Tags'], ['c', 'Unmatched'], ['d', 'Tagged', 'tagged'], ['e', 'Ambiguous'], ['f', '100%_Pure']], [
    { title: 'Good' }, { title: 'Bad Tags', artist: '{"invalid":"tag array"}' },
    { title: 'Ambiguous' }, { title: 'Ambiguous' }, { title: '100xxPure' },
  ])
  try {
    const result = await importSqliteMetadata({ filename: mixedDb.sourcePath, books: mixedDb.books, Manga: mixedDb.Manga, Metadata: mixedDb.Metadata })
    assert.equal(result.success, false)
    assert.equal(result.partial, true)
    assert.deepEqual(result.counts, { total: 6, eligible: 5, matched: 2, imported: 1, failed: 2, unmatched: 2, skipped: 1 })
    assert.equal(result.bList[0].status, 'tagged')
    assert.equal(result.bList[1].status, 'non-tag')
    assert.equal((await mixedDb.Manga.findByPk('b')).status, 'non-tag')
    assert.equal((await mixedDb.Manga.findByPk('f')).status, 'non-tag')
    assert(result.failures.some(item => /字符串数组/.test(item.reason)))
    assert(result.failures.some(item => /多个画廊/.test(item.reason)))
    pass('Mixed import reports invalid tags and ambiguous matches as failures, escapes LIKE wildcards, and returns only committed updates')
  } finally { await mixedDb.close() }

  const rollbackDb = await databaseFixture('sqlite-rollback', [['r1', 'First'], ['r2', 'Second']], [{ title: 'First' }, { title: 'Second' }])
  try {
    await rollbackDb.Metadata.sequelize.query("CREATE TRIGGER reject_second BEFORE INSERT ON Metadata WHEN NEW.hash = 'hash-r2' BEGIN SELECT RAISE(ABORT, 'simulated metadata write failure'); END")
    const result = await importSqliteMetadata({ filename: rollbackDb.sourcePath, books: rollbackDb.books, Manga: rollbackDb.Manga, Metadata: rollbackDb.Metadata })
    assert.equal(result.success, false)
    assert.equal(result.counts.imported, 0)
    assert.equal(result.counts.failed, 2)
    assert.match(result.message, /simulated metadata write failure/)
    assert.equal(await rollbackDb.Metadata.count(), 0)
    for (const book of await rollbackDb.Manga.findAll()) {
      assert.equal(book.status, 'non-tag')
      assert(book.title.endsWith('.zip'))
    }
    assert(result.bList.every(book => book.status === 'non-tag'))
    pass('A real second-record SQLite write failure rolls back the first record and both attached databases')
  } finally { await rollbackDb.close() }

  let called = false
  const canceledHandler = loadHandler('import-sqlite', {
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, mainWindow: {},
    importSqliteMetadata: async () => { called = true },
  })
  const canceled = await canceledHandler(null, [])
  assert.equal(canceled.success, false)
  assert.equal(canceled.canceled, true)
  assert.equal(called, false)
  pass('IPC cancellation is distinct from an import failure and performs no writes')
}

;(async () => {
  try {
    await trashFailureChecks()
    await archiveChecks()
    await sqliteChecks()
  } catch (error) {
    report.errors.push(error.stack || error.message)
    throw error
  } finally {
    fs.writeFileSync(path.join(artifacts, 'checks.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(fixture, 'checks.json'), JSON.stringify(report, null, 2))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
