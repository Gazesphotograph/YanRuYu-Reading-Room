'use strict'

const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')
const AdmZip = require('adm-zip')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const { safeEntry } = require('./safety')
const { validateClientState } = require('./client_state')
const { validateState: validateReadingState } = require('./reading_state')
const { validateOrganizerState, rebaseOrganizerStateForRestore } = require('./library_organizer')
const { validateLocalSearchState } = require('./local_search')
const { SIDECARS, assertLocalPath, controlPath, createStage, removeWork,
  writeDurable, commitPreparedRestore } = require('./restore_transaction')

const FORMAT = 'yanruyu-backup'
const MAX_FILE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024 * 1024
const REQUIRED_FILES = ['database.sqlite', 'metadata.sqlite', 'setting.json', 'collectionList.json', 'reading-state.json', 'ui-state.json']
const FEATURE_FILES = ['library-organizer.json', 'local-search.json']
const OPTIONAL_FILES = new Set(['window-state.json', ...FEATURE_FILES])
const sha256 = value => createHash('sha256').update(value).digest('hex')
const emptyReadingState = () => ({ schemaVersion: 1, pageBase: 1, revision: 0, progress: {}, migrations: {}, migrationSnapshots: [] })
const emptyClientState = () => ({ schemaVersion: 1, values: {}, savedAt: Date.now() })

function readJSON(target, fallback) {
  try {
    if (fs.statSync(target).size > MAX_JSON_BYTES) throw new Error('数据文件过大：' + path.basename(target))
    return JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    if (error.code === 'ENOENT' && fallback !== undefined) return fallback
    throw error
  }
}

function isObject(value) { return !!value && typeof value === 'object' && !Array.isArray(value) }

function validateJSON(name, value) {
  if (name === 'setting.json') {
    if (!isObject(value) || typeof value.library !== 'string' || !value.library.trim() || !path.isAbsolute(value.library) ||
        (value.metadataPath !== undefined && value.metadataPath !== null && typeof value.metadataPath !== 'string')) throw new Error('备份的程序设置无效')
  } else if (name === 'collectionList.json') {
    const ids = new Set()
    if (!Array.isArray(value) || value.some(item => {
      if (!isObject(item) || typeof item.id !== 'string' || !item.id || ids.has(item.id) ||
          typeof item.title !== 'string' || !Array.isArray(item.list) || item.list.some(hash => typeof hash !== 'string')) return true
      ids.add(item.id); return false
    })) throw new Error('备份的合集列表无效')
  } else if (name === 'reading-state.json') {
    validateReadingState(value)
    if (!isObject(value) || value.schemaVersion !== 1 || value.pageBase !== 1 || !isObject(value.progress)) throw new Error('备份的阅读档案无效')
    for (const [id, progress] of Object.entries(value.progress)) {
      if (['__proto__', 'constructor', 'prototype'].includes(id) || !isObject(progress) ||
          !Number.isInteger(progress.page) || !Number.isInteger(progress.total) ||
          progress.page < 1 || progress.total < 1 || progress.page > progress.total || progress.total > 1000000 ||
          !Number.isFinite(progress.time) || (progress.offset !== undefined && (!Number.isFinite(progress.offset) || progress.offset < 0 || progress.offset >= 1))) throw new Error('备份的阅读进度无效')
    }
    if (value.migrationSnapshots !== undefined && !Array.isArray(value.migrationSnapshots)) throw new Error('备份的阅读迁移副本无效')
  } else if (name === 'ui-state.json') {
    validateClientState(value)
  } else if (name === 'library-organizer.json') {
    validateOrganizerState(value)
  } else if (name === 'local-search.json') {
    validateLocalSearchState(value)
  } else if (name === 'window-state.json' && !isObject(value)) throw new Error('备份的窗口设置无效')
  return value
}

async function sqliteDatabase(filename, readOnly = true) {
  const db = await open({ filename, driver: sqlite3.Database, mode: readOnly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE })
  await db.exec('PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;')
  return db
}

async function inspectSQLite(filename, type) {
  const stat = fs.statSync(filename)
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES || stat.size < 100) throw new Error('SQLite 文件大小无效')
  const db = await sqliteDatabase(filename)
  try {
    const check = await db.all('PRAGMA quick_check')
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok') throw new Error('SQLite 完整性校验未通过')
    const table = type === 'library' ? 'Mangas' : 'Metadata'
    // Only the four columns explicitly added by startup migrations may be absent.
    // A structurally valid SQLite file can otherwise still fail the first model read.
    const common = ['title', 'status', 'rating', 'tags', 'title_jpn', 'filecount', 'posted',
      'filesize', 'category', 'url', 'mark', 'createdAt', 'updatedAt']
    const required = type === 'library'
      ? ['id', 'filepath', 'coverPath', 'hash', 'type', 'pageCount', 'bundleSize', 'mtime', 'coverHash', 'date', ...common]
      : ['hash', ...common]
    const columns = await db.all('PRAGMA table_info(' + table + ')')
    const present = new Set(columns.map(column => column.name))
    if (required.some(column => !present.has(column))) throw new Error('SQLite 表结构与当前数据类型不匹配：' + table)
    const unusual = await db.get("SELECT COUNT(*) AS total FROM sqlite_master WHERE type IN ('trigger', 'view')")
    if (unusual.total) throw new Error('SQLite 包含不支持的触发器或视图')
    const key = type === 'library' ? 'id' : 'hash'
    const invalid = await db.get('SELECT COUNT(*) AS total FROM ' + table + ' WHERE ' + key + ' IS NULL OR ' + key + " = ''")
    if (invalid.total) throw new Error('SQLite 中存在缺少标识的记录')
    return (await db.get('SELECT COUNT(*) AS total FROM ' + table)).total
  } finally { await db.close() }
}

// VACUUM INTO produces a transactionally consistent standalone snapshot even when
// the running application has a WAL. Copying only the live .sqlite file cannot.
async function snapshotSQLite(source, target, type) {
  await inspectSQLite(source, type)
  const db = await sqliteDatabase(source)
  try { await db.run('VACUUM INTO ?', target) } finally { await db.close() }
  return inspectSQLite(target, type)
}

function validatePayloadName(name) {
  safeEntry(name)
  if (name.includes('\\') || (!REQUIRED_FILES.includes(name) && !OPTIONAL_FILES.has(name) && !/^covers\/[^/]+\.(?:webp|png|jpe?g|gif|avif)$/i.test(name))) throw new Error('备份包含不支持的文件：' + name)
}

async function verifyPayload(stageRoot, manifest) {
  const values = {}
  for (const name of [...REQUIRED_FILES.filter(name => name.endsWith('.json')), ...OPTIONAL_FILES]) {
    if (OPTIONAL_FILES.has(name) && !fs.existsSync(path.join(stageRoot, name))) continue
    values[name] = validateJSON(name, readJSON(path.join(stageRoot, name)))
  }
  const books = await inspectSQLite(path.join(stageRoot, 'database.sqlite'), 'library')
  const metadata = await inspectSQLite(path.join(stageRoot, 'metadata.sqlite'), 'metadata')
  return { values, summary: {
    createdAt: manifest.createdAt, appVersion: manifest.appVersion,
    books, metadata, collections: values['collectionList.json'].length,
    readingRecords: Object.keys(values['reading-state.json'].progress).length,
    organizerRecords: values['library-organizer.json']?.operations?.length || 0,
    localAliases: values['local-search.json']?.aliases?.length || 0,
    indexedTextPages: values['local-search.json']?.texts?.length || 0,
    covers: manifest.files.filter(file => file.name.startsWith('covers/')).length,
    includesCovers: manifest.scope.covers, includesOriginals: false,
    libraryPath: values['setting.json'].library || '',
    bytes: manifest.files.reduce((sum, file) => sum + file.size, 0),
  } }
}

class BackupService {
  constructor({ storePath, metadataPath, appVersion = '1.0.0' }) {
    if (!path.isAbsolute(storePath)) throw new Error('数据目录必须是绝对路径')
    this.storePath = path.resolve(storePath)
    this.metadataPath = metadataPath || (() => path.join(this.storePath, 'metadata.sqlite'))
    this.appVersion = appVersion
  }

  async createBackup(destination, { includeCovers = true } = {}) {
    if (typeof destination !== 'string' || !path.isAbsolute(destination) || path.extname(destination).toLowerCase() !== '.yru-backup') throw new Error('请选择 .yru-backup 备份文件')
    if (fs.existsSync(destination)) throw new Error('同名备份已存在，请选择其他文件名')
    if (!fs.statSync(path.dirname(destination)).isDirectory()) throw new Error('备份目标文件夹不可用')
    const stageRoot = createStage(this.storePath)
    const temporary = destination + '.' + randomUUID() + '.tmp'
    try {
      const metadataSource = typeof this.metadataPath === 'function' ? this.metadataPath() : this.metadataPath
      await snapshotSQLite(path.join(this.storePath, 'database.sqlite'), path.join(stageRoot, 'database.sqlite'), 'library')
      await snapshotSQLite(metadataSource, path.join(stageRoot, 'metadata.sqlite'), 'metadata')
      const jsonFiles = {
        'setting.json': readJSON(path.join(this.storePath, 'setting.json')),
        'collectionList.json': readJSON(path.join(this.storePath, 'collectionList.json')),
        'reading-state.json': readJSON(path.join(this.storePath, 'reading-state.json'), emptyReadingState()),
        'ui-state.json': readJSON(path.join(this.storePath, 'ui-state.json'), emptyClientState()),
      }
      const windowPath = path.join(this.storePath, '.reading-room', 'window-state.json')
      if (fs.existsSync(windowPath)) jsonFiles['window-state.json'] = readJSON(windowPath)
      for (const name of FEATURE_FILES) {
        const featurePath = path.join(this.storePath, name)
        if (fs.existsSync(featurePath)) jsonFiles[name] = readJSON(featurePath)
      }
      for (const [name, value] of Object.entries(jsonFiles)) {
        validateJSON(name, value)
        fs.writeFileSync(path.join(stageRoot, name), JSON.stringify(value, null, 2))
      }
      const names = [...REQUIRED_FILES, ...OPTIONAL_FILES].filter(name => !OPTIONAL_FILES.has(name) || Object.hasOwn(jsonFiles, name))
      const coverRoot = path.join(this.storePath, 'cover')
      if (includeCovers && fs.existsSync(coverRoot)) {
        assertLocalPath(this.storePath, coverRoot)
        fs.mkdirSync(path.join(stageRoot, 'covers'))
        for (const entry of fs.readdirSync(coverRoot, { withFileTypes: true })) {
          if (entry.isSymbolicLink()) throw new Error('封面目录中存在链接，请检查后再备份')
          if (!entry.isFile() || !/\.(webp|png|jpe?g|gif|avif)$/i.test(entry.name)) continue
          const name = 'covers/' + entry.name
          validatePayloadName(name)
          fs.copyFileSync(path.join(coverRoot, entry.name), path.join(stageRoot, name), fs.constants.COPYFILE_EXCL)
          names.push(name)
        }
      }
      let total = 0
      const zip = new AdmZip()
      const files = names.map(name => {
        const filename = path.join(stageRoot, name)
        const size = fs.statSync(filename).size
        if (size > MAX_FILE_BYTES || (total += size) > MAX_TOTAL_BYTES) throw new Error('备份超过单文件 512 MB 或总量 1 GB 的限制，可先取消包含封面')
        const content = fs.readFileSync(filename)
        zip.addFile(name, content)
        return { name, size, sha256: sha256(content) }
      })
      const manifest = { format: FORMAT, schemaVersion: 1, backupId: randomUUID(),
        createdAt: new Date().toISOString(), appVersion: this.appVersion,
        scope: { originals: false, covers: !!includeCovers }, files }
      const { summary } = await verifyPayload(stageRoot, manifest)
      zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2)))
      await new Promise((resolve, reject) => zip.writeZip(temporary, error => error ? reject(error) : resolve()))
      // COPYFILE_EXCL never overwrites a backup created by a concurrent process.
      fs.copyFileSync(temporary, destination, fs.constants.COPYFILE_EXCL)
      const descriptor = fs.openSync(destination, 'r+')
      try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
      return { success: true, path: destination, summary }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary)
      removeWork(this.storePath, stageRoot, 'stage')
    }
  }

  async prepareBackup(filename) {
    if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw new Error('备份路径无效')
    const stat = fs.lstatSync(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 22 || stat.size > MAX_TOTAL_BYTES + 16 * 1024 * 1024) throw new Error('备份文件大小或类型无效')
    const bytes = fs.readFileSync(filename)
    const digest = sha256(bytes)
    const zip = new AdmZip(bytes)
    const entries = zip.getEntries()
    if (entries.length > 100000) throw new Error('备份文件数量超过限制')
    const seen = new Set()
    let total = 0
    for (const entry of entries) {
      safeEntry(entry.entryName)
      if (entry.isDirectory || entry.entryName.includes('\\') || seen.has(entry.entryName.toLowerCase()) ||
          (entry.header.attr >>> 16 & 0xf000) === 0xa000) throw new Error('备份包含重复项目、目录或链接')
      seen.add(entry.entryName.toLowerCase())
      const size = entry.header.size
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || (total += size) > MAX_TOTAL_BYTES) throw new Error('备份展开后超过大小限制')
    }
    const manifestEntry = zip.getEntry('manifest.json')
    if (!manifestEntry || manifestEntry.header.size > 16 * 1024 * 1024) throw new Error('备份缺少有效清单')
    const manifest = JSON.parse(manifestEntry.getData().toString('utf8'))
    if (!manifest || manifest.format !== FORMAT || manifest.schemaVersion !== 1 ||
        !Array.isArray(manifest.files) || manifest.files.length !== entries.length - 1 ||
        !Number.isFinite(Date.parse(manifest.createdAt)) || typeof manifest.appVersion !== 'string' ||
        !manifest.scope || manifest.scope.originals !== false || typeof manifest.scope.covers !== 'boolean') throw new Error('不是受支持的颜如玉备份版本')
    const fileNames = new Set()
    for (const file of manifest.files) {
      if (!file || typeof file.name !== 'string') throw new Error('备份清单损坏')
      validatePayloadName(file.name)
      if (fileNames.has(file.name.toLowerCase()) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error('备份文件校验信息无效')
      fileNames.add(file.name.toLowerCase())
      if (!manifest.scope.covers && file.name.startsWith('covers/')) throw new Error('备份封面范围与清单不一致')
    }
    if (REQUIRED_FILES.some(name => !fileNames.has(name.toLowerCase()))) throw new Error('备份缺少必要的数据文件')
    const stageRoot = createStage(this.storePath)
    try {
      for (const file of manifest.files) {
        const entry = zip.getEntry(file.name)
        if (!entry || entry.header.size !== file.size) throw new Error('备份文件缺失或大小不匹配：' + file.name)
        const content = entry.getData()
        if (content.length !== file.size || sha256(content) !== file.sha256) throw new Error('备份内容校验失败：' + file.name)
        const target = path.join(stageRoot, file.name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, content, { flag: 'wx' })
      }
      const verified = await verifyPayload(stageRoot, manifest)
      return { stageRoot, manifest, digest, ...verified }
    } catch (error) { removeWork(this.storePath, stageRoot, 'stage'); throw error }
  }

  async inspectBackup(filename) {
    const prepared = await this.prepareBackup(filename)
    try { return { path: filename, digest: prepared.digest, summary: prepared.summary } }
    finally { removeWork(this.storePath, prepared.stageRoot, 'stage') }
  }

  async recoveryPoint() {
    const directory = assertLocalPath(this.storePath, path.join(controlPath(this.storePath), 'restore-points'))
    fs.mkdirSync(directory, { recursive: true })
    const filename = path.join(directory, 'before-restore-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8) + '.yru-backup')
    return this.createBackup(filename, { includeCovers: true })
  }

  async protectedRecoveryPoint(pause) {
    try { return await this.recoveryPoint() }
    catch (error) {
      // A good backup must remain usable when the current data is corrupt. Close
      // all writers first and preserve exact original bytes, including sidecars.
      // If that copy fails as well, restoration stops without replacing anything.
      await pause()
      const metadataPath = typeof this.metadataPath === 'function' ? this.metadataPath() : this.metadataPath
      const result = await require('./raw_recovery').createRawRecoveryPoint({ storePath: this.storePath, metadataPath })
      return { ...result, normalBackupError: error.message }
    }
  }

  async restoreBackup(filename, { expectedDigest, beforeCommit, onRollback, afterInstall } = {}) {
    const prepared = await this.prepareBackup(filename)
    let stageRoot = prepared.stageRoot
    let paused = false, resumed = false, retainStage = false
    const pause = async () => { if (!paused) { paused = true; await beforeCommit?.() } }
    const resume = async () => { if (paused && !resumed) { resumed = true; await onRollback?.() } }
    try {
      if (expectedDigest && expectedDigest !== prepared.digest) throw new Error('备份文件在预览后发生变化，请重新选择并检查')
      const settings = { ...prepared.values['setting.json'], metadataPath: '' }
      // Metadata is restored into this copy. A path inside an imported setting
      // must never redirect a restore to a different portable installation.
      writeDurable(path.join(stageRoot, 'setting.json'), settings)
      const client = validateClientState(prepared.values['ui-state.json'])
      client.restoreToken = randomUUID()
      writeDurable(path.join(stageRoot, 'ui-state.json'), client)
      if (prepared.values['library-organizer.json']) {
        const journal = rebaseOrganizerStateForRestore(prepared.values['library-organizer.json'], path.join(this.storePath, 'metadata.sqlite'))
        writeDurable(path.join(stageRoot, 'library-organizer.json'), journal)
      }
      const db = await sqliteDatabase(path.join(stageRoot, 'database.sqlite'), false)
      try {
        await db.exec('BEGIN IMMEDIATE')
        const books = await db.all('SELECT id, coverPath FROM Mangas')
        for (const book of books) {
          if (!book.coverPath) continue
          const basename = path.win32.basename(book.coverPath.replace(/\//g, '\\'))
          safeEntry(basename)
          await db.run('UPDATE Mangas SET coverPath = ? WHERE id = ?', path.join(this.storePath, 'cover', basename), book.id)
        }
        await db.exec('COMMIT')
      } catch (error) { await db.exec('ROLLBACK').catch(() => {}); throw error } finally { await db.close() }
      // Absent optional state in an older backup clears newer feature state;
      // old merge journals must not be replayed against a different library.
      const names = [...REQUIRED_FILES, ...FEATURE_FILES, ...SIDECARS]
      if (prepared.manifest.scope.covers) {
        const stagedCovers = path.join(stageRoot, 'covers')
        if (!fs.existsSync(stagedCovers)) fs.mkdirSync(stagedCovers)
        fs.renameSync(stagedCovers, path.join(stageRoot, 'cover'))
        names.push('cover')
      }
      if (fs.existsSync(path.join(stageRoot, 'window-state.json'))) {
        fs.mkdirSync(path.join(stageRoot, '.reading-room'))
        fs.renameSync(path.join(stageRoot, 'window-state.json'), path.join(stageRoot, '.reading-room/window-state.json'))
        names.push('.reading-room/window-state.json')
      }
      const recovery = await this.protectedRecoveryPoint(pause)
      const result = await commitPreparedRestore({ storePath: this.storePath, stageRoot, names, beforeCommit: pause, onRollback: resume, afterInstall })
      stageRoot = null
      return { ...result, recoveryPath: recovery.path, rawRecovery: !!recovery.raw, summary: prepared.summary, restartRequired: true }
    } catch (error) {
      retainStage = !!error.rollbackFailed
      if (!retainStage) await resume()
      throw error
    } finally { if (!retainStage && stageRoot && fs.existsSync(stageRoot)) removeWork(this.storePath, stageRoot, 'stage') }
  }

  async inspectLegacy({ collectionListPath, metadataSqlitePath }) {
    if (![collectionListPath, metadataSqlitePath].every(filename => typeof filename === 'string' && path.isAbsolute(filename))) throw new Error('请选择完整的旧格式元数据和合集文件')
    const collections = validateJSON('collectionList.json', readJSON(collectionListPath))
    const metadata = await inspectSQLite(metadataSqlitePath, 'metadata')
    return { collections: collections.length, metadata, legacy: true }
  }

  async restoreLegacy(files, { beforeCommit, onRollback, afterInstall } = {}) {
    const summary = await this.inspectLegacy(files)
    const stageRoot = createStage(this.storePath)
    let paused = false, resumed = false, retainStage = false
    const pause = async () => { if (!paused) { paused = true; await beforeCommit?.() } }
    const resume = async () => { if (paused && !resumed) { resumed = true; await onRollback?.() } }
    try {
      await snapshotSQLite(files.metadataSqlitePath, path.join(stageRoot, 'metadata.sqlite'), 'metadata')
      const collections = validateJSON('collectionList.json', readJSON(files.collectionListPath))
      writeDurable(path.join(stageRoot, 'collectionList.json'), collections)
      writeDurable(path.join(stageRoot, 'setting.json'), { ...readJSON(path.join(this.storePath, 'setting.json')), metadataPath: '' })
      const recovery = await this.protectedRecoveryPoint(pause)
      const result = await commitPreparedRestore({ storePath: this.storePath, stageRoot,
        names: ['metadata.sqlite', 'collectionList.json', 'setting.json', ...SIDECARS.filter(name => name.startsWith('metadata.'))],
        beforeCommit: pause, onRollback: resume, afterInstall })
      return { ...result, recoveryPath: recovery.path, rawRecovery: !!recovery.raw, summary, restartRequired: true }
    } catch (error) {
      retainStage = !!error.rollbackFailed
      if (!retainStage) await resume()
      throw error
    } finally { if (!retainStage && fs.existsSync(stageRoot)) removeWork(this.storePath, stageRoot, 'stage') }
  }
}

module.exports = { BackupService, FORMAT, MAX_FILE_BYTES, MAX_TOTAL_BYTES, inspectSQLite, snapshotSQLite,
  validateJSON, emptyReadingState }
