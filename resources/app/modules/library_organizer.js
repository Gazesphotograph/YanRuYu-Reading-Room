'use strict'

// This service edits logical catalogue records only. A merge retains every
// original file, row ID, reading archive and original collection reference.
// The fsynced before/after journal covers the two SQLite databases and the two
// JSON stores; an interrupted multi-store commit is rolled back on startup.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { serialQueue, isWithin, safeEntry } = require('./safety')
const { assertLocalPath } = require('./restore_transaction')
const { writeAtomic, validBookId, normalizeProgress } = require('./reading_state')
const { fingerprintBook, confirmedMissing, canRelocateSource, pathKey } = require('./library_identity')
const { sourceSignature, checkCancelled } = require('./source_signature')

const JOURNAL_VERSION = 1
const JOURNAL_NAME = 'library-organizer.json'
const MAX_JOURNAL_BYTES = 64 * 1024 ** 2
const MAX_BATCH = 2000
const MAX_REMOVE_MISSING = 100000
const METADATA_FIELDS = ['title', 'status', 'rating', 'tags', 'title_jpn', 'filecount', 'posted', 'filesize', 'category', 'url', 'mark']
const EDIT_FIELDS = new Set(['title', 'title_jpn', 'category', 'rating', 'mark'])
const BOOK_FIELDS = new Set([...METADATA_FIELDS, 'hiddenBook', 'readCount'])
// A removal journal stores the complete row so undo restores the same logical
// identity, source fields and timestamps. Only this operation can delete or
// restore a row; ordinary edits still cannot change any source field.
const BOOK_ROW_FIELDS = new Set(['id', ...BOOK_FIELDS, 'coverPath', 'hash', 'identityFingerprint', 'sourceSignature',
  'filepath', 'type', 'pageCount', 'bundleSize', 'mtime', 'coverHash', 'date', 'exist', 'createdAt', 'updatedAt'])
const BOOK_NUMBER_FIELDS = new Set(['rating', 'readCount', 'filecount', 'posted', 'filesize', 'pageCount', 'bundleSize', 'date'])
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const FINGERPRINT = /^(file|folder)-sha256-v1:[0-9a-f]{64}$/
const clone = value => JSON.parse(JSON.stringify(value))
const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
const plain = value => value?.toJSON ? value.toJSON() : value
const normalTitle = value => String(value || '').normalize('NFKC').toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
const bookTitle = book => String(book.title_jpn || book.title || '未命名书籍')

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}'
  return JSON.stringify(value ?? null)
}
const same = (left, right) => stable(left) === stable(right)

function tagsOf(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value) } catch { throw new Error('标签数据无法解析，请先修复该书元数据') } }
  if (value == null) return {}
  if (!object(value)) throw new Error('标签必须按分组保存')
  const result = {}
  for (const [key, values] of Object.entries(value)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/i.test(key) || ['constructor', 'prototype', '__proto__'].includes(key)) throw new Error('标签分组无效')
    const list = Array.isArray(values) ? values : [values]
    result[key] = [...new Set(list.map(item => {
      if (!['string', 'number'].includes(typeof item)) throw new Error('标签内容无效')
      const text = String(item).trim()
      if (text.length > 512 || /[\x00-\x1f]/.test(text)) throw new Error('单个标签过长或包含控制字符')
      return text
    }).filter(Boolean))]
  }
  return result
}

function normalizedRecord(value) {
  const result = clone(plain(value))
  result.tags = tagsOf(result.tags)
  for (const key of ['mark', 'hiddenBook', 'exist']) if (result[key] !== undefined) result[key] = !!result[key]
  return result
}

function pick(record, fields) {
  const result = {}
  for (const key of fields) result[key] = record[key] ?? null
  return result
}

function changeFor(before, after, allowed = BOOK_FIELDS) {
  const oldFields = {}, newFields = {}
  for (const key of allowed) if (!same(before[key], after[key])) {
    oldFields[key] = before[key] ?? null
    newFields[key] = after[key] ?? null
  }
  return Object.keys(oldFields).length ? { id: before.id, before: oldFields, after: newFields } : null
}

function idsOf(ids, { minimum = 1, maximum = MAX_BATCH } = {}) {
  if (!Array.isArray(ids) || ids.length < minimum || ids.length > maximum || ids.some(id => !validBookId(id))) throw new Error(`请选择 ${minimum} 至 ${maximum} 本有效书籍`)
  const unique = [...new Set(ids)]
  if (unique.length < minimum) throw new Error(`至少需要 ${minimum} 本不同的书籍`)
  return unique
}

function collectionList(value) {
  if (!Array.isArray(value) || value.some(item => !object(item) || typeof item.id !== 'string' || !Array.isArray(item.list) || item.list.some(id => typeof id !== 'string'))) throw new Error('合集档案格式无效，整理操作未执行')
  if (new Set(value.map(item => item.id)).size !== value.length) throw new Error('合集 ID 重复，整理操作未执行')
  return clone(value)
}

function validSourcePath(filepath) {
  return typeof filepath === 'string' && path.isAbsolute(filepath) && !filepath.includes('\0')
}

async function missingMergeSource(filepath, signal) {
  if (!validSourcePath(filepath)) throw new Error('书籍路径无效')
  checkCancelled(signal)
  try {
    const stat = await fs.promises.lstat(filepath)
    if (stat.isSymbolicLink()) throw new Error('书籍路径不能是链接')
    return false
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  // A disconnected old drive may have no reachable ancestor. A dangling link,
  // permission error or I/O failure is different and must not authorize a merge.
  let parent = path.dirname(filepath)
  while (true) {
    checkCancelled(signal)
    try {
      const stat = await fs.promises.lstat(parent)
      if (stat.isSymbolicLink()) throw new Error('书籍上级目录不能是链接')
      if (!stat.isDirectory()) throw new Error('书籍上级目录类型无效')
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    const next = path.dirname(parent)
    if (next === parent) return true
    parent = next
  }
}

function validateRemovedBook(entry) {
  const record = entry.before
  if (entry.after !== null || !object(record) || record.id !== entry.id || !validSourcePath(record.filepath) ||
      typeof record.type !== 'string' || !record.type || !same(Object.keys(record).sort(), [...BOOK_ROW_FIELDS].sort()) ||
      !['createdAt', 'updatedAt'].every(field => typeof record[field] === 'string' && Number.isFinite(Date.parse(record[field])))) {
    throw new Error('整理日志删除书目的完整快照无效')
  }
  for (const [field, value] of Object.entries(record)) {
    if (value === null) continue
    if (field === 'tags') tagsOf(value)
    else if (['mark', 'hiddenBook', 'exist'].includes(field)) { if (typeof value !== 'boolean') throw new Error('整理日志删除书目的布尔字段无效') }
    else if (BOOK_NUMBER_FIELDS.has(field)) { if (!Number.isFinite(value) || value < 0) throw new Error('整理日志删除书目的数值字段无效') }
    else if (typeof value !== 'string') throw new Error('整理日志删除书目的文本字段无效')
  }
}

function validateJournal(document) {
  if (!object(document) || document.schemaVersion !== JOURNAL_VERSION || !Number.isSafeInteger(document.revision) || document.revision < 0 ||
      !Array.isArray(document.operations) || document.operations.length > 100000) throw new Error('书库整理日志格式无效，原文件已保留')
  const seen = new Set()
  for (const op of document.operations) {
    if (!object(op) || !UUID.test(op.id) || seen.has(op.id) || !['batch', 'merge', 'remove-missing'].includes(op.kind) || typeof op.title !== 'string' || op.title.length > 4096 ||
        !['prepared', 'applied', 'undoing', 'undone', 'rolled-back', 'recovery-conflict'].includes(op.status) ||
        !object(op.changes) || typeof op.metadataStorage !== 'string' || !Number.isFinite(op.createdAt)) throw new Error('书库整理日志含无效操作，原文件已保留')
    seen.add(op.id)
    for (const name of ['books', 'metadata', 'progress', 'collections']) {
      const entries = op.changes[name]
      const maximum = op.kind === 'remove-missing' && name === 'books' ? MAX_REMOVE_MISSING : MAX_BATCH
      if (!Array.isArray(entries) || entries.length > maximum || (op.kind === 'remove-missing' && name !== 'books' && entries.length)) throw new Error('书库整理日志变更清单无效')
      const keys = new Set()
      for (const entry of entries) {
        const key = name === 'metadata' ? entry?.hash : entry?.id
        if (typeof key !== 'string' || !key || keys.has(key)) throw new Error('书库整理日志包含重复或无效标识')
        keys.add(key)
        if (name === 'books') {
          if (op.kind === 'remove-missing') {
            if (!validBookId(key)) throw new Error('整理日志删除书目标识无效')
            validateRemovedBook(entry)
            continue
          }
          if (!validBookId(key) || !object(entry.before) || !object(entry.after) || !same(Object.keys(entry.before).sort(), Object.keys(entry.after).sort()) ||
              Object.keys(entry.before).some(field => !BOOK_FIELDS.has(field))) throw new Error('书库整理日志包含不允许编辑的书目字段')
        } else if (name === 'metadata') {
          for (const value of [entry.before, entry.after]) if (value !== null && (!object(value) || Object.keys(value).some(field => !METADATA_FIELDS.includes(field)))) throw new Error('整理日志元数据字段无效')
        } else if (name === 'progress') {
          if (!validBookId(key)) throw new Error('整理日志阅读档案标识无效')
          for (const value of [entry.before, entry.after]) if (value !== null) normalizeProgress(value)
        } else if (![entry.before, entry.after].every(list => Array.isArray(list) && list.every(id => typeof id === 'string'))) throw new Error('整理日志合集变更无效')
        if (name === 'books' || name === 'metadata') for (const value of [entry.before, entry.after]) if (value !== null) {
          for (const [field, content] of Object.entries(value)) {
            if (content === null) continue
            if (field === 'tags') tagsOf(content)
            else if (['mark', 'hiddenBook'].includes(field)) { if (typeof content !== 'boolean') throw new Error('整理日志布尔字段无效') }
            else if (['rating', 'readCount', 'filecount', 'posted', 'filesize'].includes(field)) { if (!Number.isFinite(content) || content < 0) throw new Error('整理日志数值字段无效') }
            else if (typeof content !== 'string') throw new Error('整理日志文本字段无效')
          }
        }
      }
    }
    if (op.kind === 'merge' && (!validBookId(op.keeperId) || !Array.isArray(op.donorIds) || !op.donorIds.length || op.donorIds.length > 29 || new Set(op.donorIds).size !== op.donorIds.length || op.donorIds.some(id => !validBookId(id) || id === op.keeperId))) throw new Error('整理日志合并关系无效')
  }
  return document
}

// Called only by the validated full-backup restore staging code. It rebases the
// metadata guard and retained cover references without following journal paths.
// The matching database and covers come from that same backup. Original book
// paths remain unchanged because a full data backup does not move source files.
function rebaseOrganizerStateForRestore(document, targetMetadataPath) {
  validateJournal(document)
  if (typeof targetMetadataPath !== 'string' || !path.isAbsolute(targetMetadataPath)) throw new Error('恢复后的元数据路径必须是绝对路径')
  const next = clone(document)
  for (const op of next.operations) {
    op.metadataStorage = path.resolve(targetMetadataPath)
    if (op.kind === 'remove-missing') for (const item of op.changes.books) {
      if (!item.before.coverPath) continue
      // Keep the same basename validation and destination as the restored
      // catalogue rows, including snapshots of rows absent from that database.
      const basename = path.win32.basename(item.before.coverPath.replace(/\//g, '\\'))
      safeEntry(basename)
      item.before.coverPath = path.join(path.dirname(targetMetadataPath), 'cover', basename)
    }
  }
  next.revision++
  return validateJournal(next)
}

function createLibraryOrganizer({ storePath, getManga, getMetadata, readingState, getCollections = () => [], saveCollections,
  libraryRoot = () => '', commit = operation => operation(), databaseReady = Promise.resolve(), onChanged = () => {},
  write = writeAtomic, fingerprint = fingerprintBook, signature = sourceSignature } = {}) {
  if (typeof storePath !== 'string' || !path.isAbsolute(storePath) || typeof getManga !== 'function' || typeof getMetadata !== 'function' ||
      !readingState?.load || !readingState?.applyOrganizerProgress || typeof saveCollections !== 'function') throw new Error('书库整理服务依赖不完整')
  const filePath = assertLocalPath(storePath, path.join(storePath, JOURNAL_NAME))
  const queue = serialQueue(), previews = new Map()
  let state = { schemaVersion: JOURNAL_VERSION, revision: 0, operations: [] }, loaded = false
  const metadataStorage = () => path.resolve(String(getMetadata().sequelize.options.storage))

  async function persist(next) {
    next.revision = state.revision + 1
    validateJournal(next)
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_JOURNAL_BYTES) throw new Error('整理历史已达到容量上限，请先保存完整备份；本次操作未提交')
    assertLocalPath(storePath, filePath)
    await write(filePath, next)
    state = next
  }

  async function status(id, phase, extra = {}) {
    const next = clone(state), operation = next.operations.find(item => item.id === id)
    if (!operation) throw new Error('整理操作日志不存在')
    Object.assign(operation, extra, { status: phase, updatedAt: Date.now() })
    await persist(next)
    return operation
  }

  function conflict(label) { throw new Error(`${label}已在预览后修改，操作未覆盖新内容；请重新预览或保留当前数据`) }

  async function inspectChanges(op, from, to, tolerant = false) {
    const Manga = getManga(), Metadata = getMetadata()
    if (op.changes.metadata.length && metadataStorage() !== op.metadataStorage) throw new Error('元数据目录已经切换，请恢复原目录后再撤销此项整理')
    const current = { books: [], metadata: [], progress: [], collections: [] }
    if (op.kind === 'remove-missing') {
      // One snapshot also makes large all-selected removals practical. Check
      // every selected row before deleting any row, and never recreate a
      // duplicate path if a later scan has already imported it under a new ID.
      const rows = (await Manga.findAll()).map(row => clone(plain(row))), byId = new Map(rows.map(row => [row.id, row]))
      const restoringIds = new Set(op.changes.books.map(item => item.id)), occupiedPaths = new Set()
      if (to === 'before') for (const row of rows) {
        if (!restoringIds.has(row.id) && validSourcePath(row.filepath)) occupiedPaths.add(pathKey(row.filepath))
      }
      for (const item of op.changes.books) {
        const value = byId.get(item.id) || null
        if (!same(value, item[from]) && !(tolerant && same(value, item[to]))) conflict('相关书目')
        if (to === 'before' && value === null && occupiedPaths.has(pathKey(item.before.filepath))) conflict('原路径的新书目')
        if (!same(value, item[to])) current.books.push(item)
      }
      return current
    }
    for (const item of op.changes.books) {
      const row = await Manga.findByPk(item.id)
      if (!row) conflict('相关书目')
      const value = pick(normalizedRecord(row), Object.keys(item[from]))
      if (!same(value, item[from]) && !(tolerant && same(value, item[to]))) conflict('书目内容')
      if (!same(value, item[to])) current.books.push(item)
    }
    for (const item of op.changes.metadata) {
      const row = await Metadata.findByPk(item.hash)
      const value = row ? pick(normalizedRecord(row), METADATA_FIELDS) : null
      if (!same(value, item[from]) && !(tolerant && same(value, item[to]))) conflict('元数据')
      if (!same(value, item[to])) current.metadata.push(item)
    }
    const reading = await readingState.load()
    for (const item of op.changes.progress) {
      const value = reading.progress[item.id] || null
      if (!same(value, item[from]) && !(tolerant && same(value, item[to]))) conflict('阅读进度')
      if (!same(value, item[to])) current.progress.push({ ...item, expected: value })
    }
    const collections = collectionList(await getCollections())
    for (const item of op.changes.collections) {
      const row = collections.find(entry => entry.id === item.id)
      if (!row || (!same(row.list, item[from]) && !(tolerant && same(row.list, item[to])))) conflict('合集成员')
      if (!same(row.list, item[to])) current.collections.push(item)
    }
    current.collectionSnapshot = collections
    return current
  }

  async function applyChanges(op, from, to, tolerant = false) {
    // Validate every affected store before changing even the first row. The
    // caller's shared library queue also covers readers and collection edits.
    const changes = await inspectChanges(op, from, to, tolerant)
    const Manga = getManga(), Metadata = getMetadata()
    // Recheck after the durable journal write too: an old drive can reconnect
    // while that write is pending, before any book or reading archive changes.
    if (op.kind === 'merge' && to === 'after' && !tolerant) await verifyGuards(op)
    if (changes.books.length) await Manga.sequelize.transaction(async transaction => {
      if (op.kind === 'remove-missing') {
        // Files can return after a preview (for example a reconnected drive).
        // Recheck all sources inside the transaction before its first delete.
        if (to === 'after' && !tolerant) await verifyMissingSources(op)
        for (const item of changes.books) {
          if (item[to] === null) {
            if (await Manga.destroy({ where: { id: item.id }, transaction }) !== 1) throw new Error('书目事务没有删除预期记录')
          } else await Manga.create(item[to], { transaction, silent: true })
        }
        return
      }
      for (const item of changes.books) {
        const [count] = await Manga.update(item[to], { where: { id: item.id }, transaction })
        if (count !== 1) throw new Error('书目事务没有更新预期记录')
      }
    })
    if (changes.metadata.length) await Metadata.sequelize.transaction(async transaction => {
      for (const item of changes.metadata) {
        if (item[to] === null) await Metadata.destroy({ where: { hash: item.hash }, transaction })
        else await Metadata.upsert({ hash: item.hash, ...item[to] }, { transaction })
      }
    })
    for (const item of changes.progress) await readingState.applyOrganizerProgress(item.id, { expected: item.expected, value: item[to] })
    if (changes.collections.length) {
      for (const item of changes.collections) changes.collectionSnapshot.find(entry => entry.id === item.id).list = clone(item[to])
      await saveCollections(changes.collectionSnapshot)
    }
  }

  async function recoverPending() {
    for (const op of state.operations.filter(item => ['prepared', 'undoing', 'recovery-conflict'].includes(item.status))) {
      try {
        await applyChanges(op, 'after', 'before', true)
        await status(op.id, op.status === 'undoing' || op.recoveringUndo ? 'undone' : 'rolled-back', { recoveredAt: Date.now(), error: null })
      } catch (error) {
        await status(op.id, 'recovery-conflict', { error: error.message, recoveringUndo: op.status === 'undoing' || !!op.recoveringUndo }).catch(() => {})
        throw new Error('上次整理未完整结束，已保留所有原文件和恢复日志：' + error.message, { cause: error })
      }
    }
  }

  const ready = Promise.resolve(databaseReady).then(() => queue(() => commit(async () => {
    await fs.promises.mkdir(storePath, { recursive: true })
    try {
      const stat = await fs.promises.lstat(filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JOURNAL_BYTES) throw new Error('书库整理日志文件大小或类型无效')
      state = validateJournal(JSON.parse(await fs.promises.readFile(filePath, 'utf8')))
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    loaded = true
    await recoverPending()
  })))
  ready.catch(() => {})

  const run = operation => ready.then(() => queue(() => commit(async () => {
    await recoverPending()
    return operation()
  })))
  async function allBooks() { return (await getManga().findAll()).map(normalizedRecord) }
  const activeMerges = () => new Map(state.operations.filter(op => op.kind === 'merge' && op.status === 'applied').flatMap(op => op.donorIds.map(id => [id, op.keeperId])))
  const mergedSourceSnapshot = () => Object.fromEntries(state.operations.filter(op => op.kind === 'merge' && op.status === 'applied').flatMap(op => {
    const sourcePaths = new Map((op.guards || []).map(guard => [guard.id, guard.filepath]))
    const keeperPath = sourcePaths.get(op.keeperId)
    return op.donorIds.map(id => {
      const donorPath = sourcePaths.get(id)
      // Compare the original journal paths, even after a later scan moves a
      // source. Incomplete legacy guards cannot prove an independent copy.
      const sharedSource = !validSourcePath(keeperPath) || !validSourcePath(donorPath) || pathKey(keeperPath) === pathKey(donorPath)
      return [id, { keeperId: op.keeperId, sharedSource }]
    })
  }))
  const summary = op => ({ id: op.id, kind: op.kind, title: op.title, status: op.status, createdAt: op.createdAt,
    updatedAt: op.updatedAt, changed: op.changes.books.length, keeperId: op.keeperId, donorIds: op.donorIds,
    error: op.error || null, canUndo: op.status === 'applied', recoveredAt: op.recoveredAt || null })
  const bookInfo = (book, reading = {}) => ({ id: book.id, title: bookTitle(book), originalTitle: book.title || '',
    title_jpn: book.title_jpn || '', filepath: book.filepath, type: book.type, coverPath: book.coverPath,
    pageCount: Number(book.pageCount || book.filecount) || 0, size: Number(book.bundleSize || book.filesize) || 0,
    tags: book.tags, mark: !!book.mark, hiddenBook: !!book.hiddenBook, exist: book.exist !== false,
    rating: book.rating, category: book.category || '', progress: reading[book.id] || null })

  function savePreview(operation, view) {
    const now = Date.now()
    for (const [token, item] of previews) if (item.expiresAt < now) previews.delete(token)
    while (previews.size >= 16) previews.delete(previews.keys().next().value)
    const token = randomUUID(), expiresAt = now + 15 * 60 * 1000
    previews.set(token, { operation, expiresAt })
    return { token, expiresAt, kind: operation.kind, changed: operation.changes.books.length, ...view }
  }

  async function metadataChanges(books, replacements) {
    const counts = new Map(), changes = [], warnings = []
    for (const book of books) if (book.hash) counts.set(book.hash, (counts.get(book.hash) || 0) + 1)
    for (const after of replacements) {
      if (!after.hash) continue
      if (counts.get(after.hash) > 1) {
        warnings.push(`《${bookTitle(after)}》与其他书共享旧元数据索引；修改按独立书目保存，未覆盖共享元数据。`)
        continue
      }
      const row = await getMetadata().findByPk(after.hash)
      const before = row ? pick(normalizedRecord(row), METADATA_FIELDS) : null
      const next = pick(after, METADATA_FIELDS)
      if (!same(before, next)) changes.push({ hash: after.hash, before, after: next })
    }
    return { changes, warnings }
  }

  function baseOperation(kind, title) {
    return { id: randomUUID(), kind, title, status: 'prepared', createdAt: Date.now(), metadataStorage: metadataStorage(),
      changes: { books: [], metadata: [], progress: [], collections: [] } }
  }

  async function previewBatch(params = {}) {
    const ids = idsOf(params.bookIds)
    const edits = Array.isArray(params.tags) ? params.tags : []
    const fields = params.fields === undefined ? {} : params.fields
    if (!object(fields) || Object.keys(fields).some(key => !EDIT_FIELDS.has(key)) || edits.length > 30) throw new Error('批量编辑参数无效')
    if (!edits.length && !Object.keys(fields).length) throw new Error('请先填写要修改的作者、标签或书目信息')
    for (const [key, value] of Object.entries(fields)) {
      if (key === 'rating') { if (!Number.isFinite(value) || value < 0 || value > 5) throw new Error('评分必须为 0 至 5') }
      else if (key === 'mark') { if (typeof value !== 'boolean') throw new Error('收藏状态无效') }
      else if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw new Error('书目信息无效或过长')
    }
    if (ids.length > 1 && (Object.hasOwn(fields, 'title') || Object.hasOwn(fields, 'title_jpn'))) throw new Error('书名修改请一次选择一本，避免批量覆盖不同书名')
    const normalizedEdits = edits.map(edit => {
      if (!object(edit) || !/^[a-z][a-z0-9_-]{0,39}$/i.test(edit.namespace) || ['constructor', 'prototype', '__proto__'].includes(edit.namespace) ||
          !['add', 'remove', 'replace', 'rename'].includes(edit.mode)) throw new Error('作者或标签修改方式无效')
      const values = tagsOf({ [edit.namespace]: edit.values || [] })[edit.namespace]
      if (edit.mode === 'rename' && (typeof edit.from !== 'string' || !edit.from.trim() || values.length !== 1)) throw new Error('替换标签需要一个原名称和一个新名称')
      if (edit.mode !== 'replace' && !values.length) throw new Error('请填写标签内容')
      return { namespace: edit.namespace, mode: edit.mode, values, from: edit.from?.trim() }
    })
    return run(async () => {
      const books = await allBooks(), byId = new Map(books.map(book => [book.id, book]))
      const op = baseOperation('batch', `批量整理 ${ids.length} 本书`), replacements = [], rows = []
      op.guards = []
      for (const id of ids) {
        const before = byId.get(id)
        if (!before) throw new Error('部分所选书籍已不存在，请刷新选择')
        const after = clone(before)
        Object.assign(after, fields)
        for (const edit of normalizedEdits) {
          const previous = after.tags[edit.namespace] || []
          let next
          if (edit.mode === 'replace') next = edit.values
          else if (edit.mode === 'add') next = [...new Set([...previous, ...edit.values])]
          else if (edit.mode === 'remove') next = previous.filter(value => !edit.values.includes(value))
          else next = [...new Set(previous.map(value => value === edit.from ? edit.values[0] : value))]
          if (next.length) after.tags[edit.namespace] = next
          else delete after.tags[edit.namespace]
        }
        const changed = changeFor(before, after)
        if (!changed) continue
        if (normalizedEdits.length || Object.keys(fields).some(key => key !== 'mark')) after.status = 'tagged'
        op.changes.books.push(changeFor(before, after))
        op.guards.push({ id, filepath: before.filepath, hash: before.hash })
        replacements.push(after)
        rows.push({ id, title: bookTitle(before), before: op.changes.books.at(-1).before, after: op.changes.books.at(-1).after })
      }
      const metadata = await metadataChanges(books, replacements)
      op.changes.metadata = metadata.changes
      return savePreview(op, { title: op.title, selected: ids.length, rows, warnings: metadata.warnings,
        sourceFilesUnchanged: true, readingArchivesRetained: true })
    })
  }

  async function previewRemoveMissing(params = {}) {
    if (!object(params)) throw new Error('请选择要删除的缺失书目记录')
    const ids = idsOf(params.bookIds, { maximum: MAX_REMOVE_MISSING })
    return run(async () => {
      const books = (await getManga().findAll()).map(row => clone(plain(row))), byId = new Map(books.map(book => [book.id, book]))
      const context = await sourceContext(), rows = []
      const op = baseOperation('remove-missing', `删除 ${ids.length} 条缺失或不可访问书目记录`)
      for (const id of ids) {
        const book = byId.get(id)
        if (!book) throw new Error('部分所选书目已不存在，请重新检测缺失文件')
        const issue = await sourceIssue(book, context)
        if (!issue?.canRemove) throw new Error(`《${bookTitle(book)}》当前已可访问或路径类型无效，本次未删除；请重新检测缺失文件`)
        const entry = { id, before: book, after: null }
        validateRemovedBook(entry)
        op.changes.books.push(entry)
        rows.push({ id, title: bookTitle(book), filepath: book.filepath, status: issue.status, message: issue.message })
      }
      const unavailable = rows.filter(row => row.status === 'unavailable').length
      return savePreview(op, { title: op.title, selected: ids.length, rows,
        warnings: unavailable ? [`其中 ${unavailable} 条记录只是暂不可访问，可能与磁盘离线、目录设置或访问权限有关；删除后可从整理历史撤销。`] : [],
        sourceFilesUnchanged: true, readingArchivesRetained: true, metadataRetained: true, collectionsRetained: true })
    })
  }

  async function previewMerge(params = {}, task = {}) {
    const ids = idsOf(params.bookIds, { minimum: 2, maximum: 30 })
    if (!ids.includes(params.keeperId)) throw new Error('请选择合并后保留在书架上的书籍')
    if (params.progressSourceId && !ids.includes(params.progressSourceId)) throw new Error('阅读进度来源不在所选书籍中')
    const policy = params.metadataPolicy || 'union'
    if (!['union', 'keeper'].includes(policy)) throw new Error('元数据保留方式无效')
    const fieldSources = params.fieldSources || {}
    if (!object(fieldSources) || Object.keys(fieldSources).some(key => !['title', 'title_jpn', 'rating', 'category'].includes(key)) || Object.values(fieldSources).some(id => !ids.includes(id))) throw new Error('元数据来源无效')
    const snapshot = await run(async () => {
      const books = await allBooks(), byId = new Map(books.map(book => [book.id, book])), merged = activeMerges()
      const selected = ids.map(id => {
        if (!byId.has(id)) throw new Error('部分所选书籍已不存在')
        if (merged.has(id)) throw new Error('所选书籍已合并，请先撤销原合并再重新整理')
        return byId.get(id)
      })
      return { selected, library: libraryRoot() }
    })
    const guards = [], fingerprints = [], warnings = []
    const verificationOrder = [snapshot.selected.find(book => book.id === params.keeperId),
      ...snapshot.selected.filter(book => book.id !== params.keeperId)]
    let keeperFingerprint
    // Full verification is deliberately outside the shared library write queue.
    for (let i = 0; i < verificationOrder.length; i++) {
      checkCancelled(task.signal)
      const book = verificationOrder[i]
      task.report?.({ phase: 'verify', current: i, total: ids.length, filepath: book.filepath, message: `核对完整内容 ${i + 1} / ${ids.length}` })
      try {
        if (book.id !== params.keeperId && await missingMergeSource(book.filepath, task.signal)) {
          const identity = book.identityFingerprint
          if (!FINGERPRINT.test(identity || '') || (book.type === 'folder') !== identity.startsWith('folder-')) {
            throw new Error('旧来源缺失且没有有效的完整内容指纹，无法安全确认是否为同一本书')
          }
          if (identity !== keeperFingerprint) throw new Error('旧来源保存的完整指纹与保留本内容不一致，无法合并离线来源')
          guards.push({ id: book.id, filepath: book.filepath, hash: book.hash, type: book.type,
            missingSource: true, identityFingerprint: identity })
          fingerprints.push({ id: book.id, value: identity, source: 'history' })
          warnings.push(`《${bookTitle(book)}》的旧路径当前缺失或离线；本次沿用已保存的完整 SHA-256 指纹，与保留本实测内容一致。原路径和阅读档案仍会保留。`)
          continue
        }
        const before = await signature(book.filepath, book.type, { libraryRoot: snapshot.library, signal: task.signal })
        const identity = await fingerprint(book.filepath, book.type, { libraryRoot: snapshot.library, signal: task.signal })
        const after = await signature(book.filepath, book.type, { libraryRoot: snapshot.library, signal: task.signal })
        if (before !== after) throw new Error('内容在核对时发生变化，请重新预览')
        guards.push({ id: book.id, filepath: book.filepath, hash: book.hash, type: book.type, signature: after })
        fingerprints.push({ id: book.id, value: identity })
        if (book.id === params.keeperId) keeperFingerprint = identity
      } catch (error) {
        if (error.name === 'AbortError' || task.signal?.aborted) throw error
        throw new Error(`《${bookTitle(book)}》无法完成完整校验，请先重新定位或修复文件：${error.message}`, { cause: error })
      }
    }
    task.report?.({ current: ids.length, total: ids.length, message: '内容核对完成，正在准备保留内容预览' })
    const exact = fingerprints.every(item => item.value === fingerprints[0].value)
    if (!exact) warnings.push('所选文件的完整内容不一致，可能是不同版本。此次仅合并书架展示，所有版本原文件与档案都会保留。')
    return run(async () => {
      const books = await allBooks(), byId = new Map(books.map(book => [book.id, book]))
      for (const guard of guards) {
        const book = byId.get(guard.id)
        if (!book || book.filepath !== guard.filepath || book.hash !== guard.hash || book.type !== guard.type) conflict('书籍来源')
        await verifyHistoricalSource(book, guard, task.signal)
      }
      const selected = ids.map(id => byId.get(id)), keeper = byId.get(params.keeperId), donors = selected.filter(book => book.id !== keeper.id)
      const reading = await readingState.load(), collections = collectionList(await getCollections())
      const after = clone(keeper)
      if (policy === 'union') {
        for (const book of donors) for (const [namespace, values] of Object.entries(book.tags)) after.tags[namespace] = [...new Set([...(after.tags[namespace] || []), ...values])]
        for (const field of ['title', 'title_jpn', 'category', 'url']) if (!after[field]) after[field] = donors.find(book => book[field])?.[field] ?? after[field]
        if (after.rating == null) after.rating = donors.find(book => book.rating != null)?.rating ?? after.rating
      }
      for (const [field, id] of Object.entries(fieldSources)) after[field] = byId.get(id)[field]
      after.mark = selected.some(book => book.mark)
      after.readCount = Math.max(...selected.map(book => Number(book.readCount) || 0))
      after.hiddenBook = false
      if (Object.keys(after.tags).length) after.status = 'tagged'
      const op = baseOperation('merge', `合并 ${selected.length} 本书的书架展示`)
      Object.assign(op, { keeperId: keeper.id, donorIds: donors.map(book => book.id), guards, fingerprints, exact })
      const keeperChange = changeFor(keeper, after)
      if (keeperChange) op.changes.books.push(keeperChange)
      for (const donor of donors) {
        const change = changeFor(donor, { ...donor, hiddenBook: true })
        if (change) op.changes.books.push(change)
      }
      const progressSourceId = params.progressSourceId || keeper.id
      const chosen = reading.progress[progressSourceId] || null
      let nextProgress = chosen ? clone(chosen) : null
      const total = Number(keeper.pageCount || keeper.filecount)
      if (nextProgress && progressSourceId !== keeper.id && Number.isSafeInteger(total) && total > 0) {
        if (nextProgress.total !== total) warnings.push(`进度来源共有 ${nextProgress.total} 页；保留本共有 ${total} 页。复制页码会限制在保留本页数内，请核对预览。`)
        nextProgress = normalizeProgress({ ...nextProgress, total, page: Math.min(nextProgress.page, total) })
      }
      const oldProgress = reading.progress[keeper.id] || null
      if (!same(oldProgress, nextProgress)) op.changes.progress.push({ id: keeper.id, before: oldProgress, after: nextProgress })
      const allReferences = new Set(selected.flatMap(book => [book.id, book.hash].filter(Boolean)))
      const additions = []
      for (const collection of collections) {
        if (!collection.list.some(reference => allReferences.has(reference))) continue
        // Both interfaces understand an ID. Add a single reference, because
        // legacy collection aggregation would count ID + hash twice. Preserve
        // every original reference, including the donors' collection entries.
        const alreadyIncluded = collection.list.includes(keeper.id) || (keeper.hash && collection.list.includes(keeper.hash))
        const next = alreadyIncluded ? [...collection.list] : [...collection.list, keeper.id]
        additions.push({ id: collection.id, title: collection.title || '未命名合集', added: !same(next, collection.list) })
        if (!same(next, collection.list)) op.changes.collections.push({ id: collection.id, before: collection.list, after: next })
      }
      const metadata = await metadataChanges(books, keeperChange ? [after] : [])
      op.changes.metadata = metadata.changes
      return savePreview(op, { title: op.title, keeper: bookInfo(keeper, reading.progress), donors: donors.map(book => bookInfo(book, reading.progress)),
        metadata: { policy, before: pick(keeper, METADATA_FIELDS), after: pick(after, METADATA_FIELDS) },
        progress: { sourceId: progressSourceId, before: oldProgress, after: nextProgress },
        collections: additions, exact, evidence: exact
          ? fingerprints.some(item => item.source === 'history')
            ? '可访问书籍的完整 SHA-256 与离线来源已保存的完整指纹一致'
            : '全部文件的完整 SHA-256 内容一致'
          : '完整内容不同，仅手动合并展示',
        fingerprints, warnings: [...warnings, ...metadata.warnings], sourceFilesUnchanged: true, readingArchivesRetained: true,
        retainedPreferences: keeper.id, retainedReadCount: after.readCount })
    })
  }

  async function verifyHistoricalSource(book, guard, signal) {
    if (!guard.missingSource) return
    if (book.identityFingerprint !== guard.identityFingerprint) conflict('离线来源的完整指纹')
    if (!await missingMergeSource(book.filepath, signal)) conflict('离线来源的访问状态')
  }

  async function verifyGuards(op) {
    if (op.kind === 'remove-missing') return verifyMissingSources(op)
    const merged = activeMerges()
    for (const guard of op.guards || []) {
      const row = await getManga().findByPk(guard.id)
      if (!row) conflict('所选书目')
      const book = normalizedRecord(row)
      if (book.filepath !== guard.filepath || book.hash !== guard.hash || (guard.type && book.type !== guard.type)) conflict('书籍路径或内容')
      if (op.kind === 'merge' && merged.has(book.id)) conflict('合并关系')
      await verifyHistoricalSource(book, guard)
      if (guard.signature && await signature(book.filepath, book.type, { libraryRoot: libraryRoot() }) !== guard.signature) conflict('书籍文件')
    }
  }

  async function apply(token) {
    if (typeof token !== 'string' || !UUID.test(token)) throw new Error('请先预览本次修改')
    return run(async () => {
      const preview = previews.get(token)
      previews.delete(token)
      if (!preview || preview.expiresAt < Date.now()) throw new Error('修改预览已失效，请重新预览')
      const op = preview.operation
      await verifyGuards(op)
      await inspectChanges(op, 'before', 'after')
      if (op.kind !== 'merge' && !Object.values(op.changes).some(entries => entries.length)) return { changed: 0, noChanges: true }
      const next = clone(state)
      next.operations.push(op)
      await persist(next) // No data is touched until the recovery record is durable.
      try {
        await applyChanges(op, 'before', 'after')
        await status(op.id, 'applied')
      } catch (error) {
        let rollbackError
        try { await applyChanges(op, 'after', 'before', true); await status(op.id, 'rolled-back', { error: error.message }) }
        catch (caught) { rollbackError = caught; await status(op.id, 'recovery-conflict', { error: caught.message }).catch(() => {}) }
        if (rollbackError) throw new Error(`整理未完成，恢复日志已保留；请勿覆盖新内容：${rollbackError.message}`, { cause: error })
        throw new Error('整理未完成，已回滚本次变更：' + error.message, { cause: error })
      }
      try { await onChanged({ id: op.id, kind: op.kind }) } catch {}
      return summary(state.operations.find(item => item.id === op.id))
    })
  }

  async function undo(id) {
    if (typeof id !== 'string' || !UUID.test(id)) throw new Error('整理记录标识无效')
    return run(async () => {
      const op = state.operations.find(item => item.id === id)
      if (!op || op.status !== 'applied') throw new Error('该记录当前不能撤销')
      // Check all records first: later user edits or reading progress are never
      // silently replaced by an old undo snapshot.
      await inspectChanges(op, 'after', 'before')
      await status(id, 'undoing')
      try {
        await applyChanges(op, 'after', 'before')
        await status(id, 'undone')
      } catch (error) {
        try { await applyChanges(op, 'before', 'after', true); await status(id, 'applied', { error: error.message }) }
        catch (rollbackError) { await status(id, 'recovery-conflict', { error: rollbackError.message, recoveringUndo: true }).catch(() => {}) }
        throw new Error('撤销尚未完成，已保留恢复日志：' + error.message, { cause: error })
      }
      try { await onChanged({ id, kind: 'undo' }) } catch {}
      return summary(state.operations.find(item => item.id === id))
    })
  }

  async function catalog() {
    return run(async () => {
      const [books, reading] = await Promise.all([allBooks(), readingState.load()]), merged = activeMerges()
      return { books: books.map(book => ({ ...bookInfo(book, reading.progress), mergedInto: merged.get(book.id) || null })),
        maxBatch: MAX_BATCH, maxRemoveMissing: MAX_REMOVE_MISSING, historyCount: state.operations.filter(op => op.status === 'applied').length }
    })
  }

  async function sourceContext(library = libraryRoot()) {
    let libraryAvailable = true, libraryError = ''
    try { if (!library) throw new Error('尚未选择书库文件夹'); await fs.promises.readdir(library) }
    catch (error) { libraryAvailable = false; libraryError = error.message }
    return { library, libraryAvailable, libraryError }
  }

  async function sourceIssue(book, context) {
    if (!validSourcePath(book.filepath)) return { status: 'invalid', message: '书籍路径无效，请核对目录设置或重新定位', canRemove: false }
    const withinLibrary = isWithin(context.library, book.filepath, true)
    try {
      const stat = await fs.promises.lstat(book.filepath)
      if (stat.isSymbolicLink() || (book.type === 'folder' ? !stat.isDirectory() : !stat.isFile())) {
        return { status: 'invalid', message: '路径类型已改变或为链接，请重新定位原书文件', canRemove: false }
      }
      // A bad library setting must not make an existing source deletable.
      // Still report the directory problem so the user can fix or relocate it.
      if (!context.libraryAvailable || !withinLibrary) return { status: 'unavailable',
        message: '当前书库目录不可访问或与记录不匹配，但原路径仍可访问；请核对目录设置', canRemove: false }
      return null
    } catch (error) {
      if (['EINVAL', 'ENAMETOOLONG', 'ENOTDIR', 'ELOOP'].includes(error.code)) return { status: 'invalid', message: '书籍路径或上级目录类型无效，请重新定位', canRemove: false }
      if (error.code === 'ENOENT' && context.libraryAvailable && withinLibrary && await confirmedMissing(book.filepath, context.library)) {
        return { status: 'missing', message: '已确认文件或文件夹缺失，可以重新定位或删除书目记录', canRemove: true }
      }
      return { status: 'unavailable', message: '路径暂不可访问，未判为缺失：' + error.message, canRemove: true }
    }
  }

  async function verifyMissingSources(op) {
    const context = await sourceContext()
    for (const item of op.changes.books) {
      const issue = await sourceIssue(item.before, context)
      if (!issue?.canRemove) throw new Error(`《${bookTitle(item.before)}》已恢复访问或路径状态已改变，本次未删除；请重新检测缺失文件`)
    }
  }

  async function health(_params = {}, task = {}) {
    const snapshot = await run(async () => ({ books: await allBooks(), library: libraryRoot() }))
    const context = await sourceContext(snapshot.library), { libraryAvailable, libraryError } = context
    const report = { checkedAt: Date.now(), total: snapshot.books.length, present: 0, missing: 0, unavailable: 0, invalid: 0, issues: [], libraryAvailable, libraryError }
    for (let index = 0; index < snapshot.books.length; index++) {
      checkCancelled(task.signal)
      const book = snapshot.books[index]
      task.report?.({ phase: 'inspect', current: index, total: snapshot.books.length, message: '正在检查书籍路径', filepath: book.filepath })
      const issue = await sourceIssue(book, context)
      if (issue) {
        report[issue.status]++
        const canRelocate = libraryAvailable && FINGERPRINT.test(book.identityFingerprint || '') &&
          ['missing', 'unavailable'].includes(issue.status) && await canRelocateSource(book.filepath, snapshot.library)
        report.issues.push({ ...bookInfo(book), ...issue, canRelocate })
      }
      else report.present++
    }
    task.report?.({ current: snapshot.books.length, total: snapshot.books.length, message: '书库健康检查已完成' })
    return report
  }

  async function duplicates() {
    return run(async () => {
      const books = (await allBooks()).filter(book => !book.hiddenBook), exactBuckets = new Map(), titleBuckets = new Map(), grouped = new Set(), groups = []
      for (const book of books) {
        if (FINGERPRINT.test(book.identityFingerprint || '')) {
          if (!exactBuckets.has(book.identityFingerprint)) exactBuckets.set(book.identityFingerprint, [])
          exactBuckets.get(book.identityFingerprint).push(book)
        }
        const title = normalTitle(bookTitle(book)), pages = Number(book.pageCount || book.filecount)
        if (title.length > 1 && pages > 0) {
          const key = title + '\0' + pages
          if (!titleBuckets.has(key)) titleBuckets.set(key, [])
          titleBuckets.get(key).push(book)
        }
      }
      for (const values of exactBuckets.values()) if (values.length > 1) {
        values.forEach(book => grouped.add(book.id))
        groups.push({ kind: 'exact-candidate', evidence: ['上次完整内容指纹一致', `页数：${values[0].pageCount || values[0].filecount || '未知'}`],
          note: '确认前将重新校验全部内容；不会仅凭封面合并。', books: values.map(book => bookInfo(book)) })
      }
      for (const values of titleBuckets.values()) if (values.length > 1 && values.some(book => !grouped.has(book.id))) {
        const sizes = values.map(book => Number(book.bundleSize || book.filesize)).filter(value => value > 0)
        const evidence = ['规范化书名一致', '页数一致']
        if (sizes.length === values.length && new Set(sizes).size === 1) evidence.push('记录的文件大小一致')
        groups.push({ kind: 'suspected', evidence, note: '可能是不同版本，请逐本核对。相同封面本身不作为重复依据。', books: values.map(book => bookInfo(book)) })
      }
      return { checkedAt: Date.now(), total: books.length, groupCount: groups.length, groups,
        note: '结果是整理线索。完整内容一致也可能是有意保留的副本，所有合并都需先预览。' }
    })
  }

  return { filePath, ready, catalog, previewBatch, previewRemoveMissing, previewMerge, apply, undo, health, duplicates,
    // Scans also read this snapshot while holding the shared commit queue.
    // Do not acquire that queue again here; only explicit applied merges count.
    mergedSources: () => ready.then(mergedSourceSnapshot),
    history: () => run(() => state.operations.slice().reverse().map(summary)),
    flush: () => ready.then(() => queue(() => {})),
    // Exposed for diagnostics, never as an unchecked IPC mutation surface.
    get loaded() { return loaded } }
}

module.exports = { JOURNAL_VERSION, JOURNAL_NAME, MAX_BATCH, MAX_REMOVE_MISSING, validateJournal, validateOrganizerState: validateJournal,
  rebaseOrganizerStateForRestore, tagsOf, createLibraryOrganizer }
