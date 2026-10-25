'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { serialQueue } = require('./safety')

const SCHEMA_VERSION = 1
const MAX_PAGE_COUNT = 1000000
const LEGACY_KEYS = ['room-progress', 'viewerReadingProgress', 'recentRead']
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)
const clone = value => JSON.parse(JSON.stringify(value))

function validBookId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 256 && !/[\x00-\x1f]/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id)
}

// Public page numbers, legacy image IDs, and this file all use a ONE-based index.
// Only ComicRead's internal image/page arrays are zero-based (converted by the bridge).
function normalizeProgress(progress) {
  if (!isObject(progress) || !Number.isSafeInteger(progress.page) || !Number.isSafeInteger(progress.total) ||
      progress.page < 1 || progress.total < 1 || progress.total > MAX_PAGE_COUNT) {
    throw new Error('阅读进度的页码或总页数无效')
  }
  return {
    page: Math.min(progress.page, progress.total),
    total: progress.total,
    offset: Number.isFinite(progress.offset) ? Math.max(0, Math.min(.99, progress.offset)) : 0,
    time: Number.isFinite(progress.time) && progress.time >= 0 ? progress.time : Date.now(),
    ...(typeof progress.source === 'string' && ['room', 'classic', 'comicread', 'migration'].includes(progress.source) ? { source: progress.source } : {})
  }
}

function normalizePreferences(value) {
  if (!isObject(value)) throw new Error('阅读偏好无效')
  const allowed = new Set(['mode', 'direction', 'fit', 'zoom', 'coverAlone'])
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('阅读偏好包含不支持的字段')
  if (value.mode !== undefined && !['paged', 'double', 'continuous'].includes(value.mode)) throw new Error('阅读模式无效')
  if (value.direction !== undefined && !['ltr', 'rtl'].includes(value.direction)) throw new Error('阅读方向无效')
  if (value.fit !== undefined && !['page', 'width'].includes(value.fit)) throw new Error('页面显示方式无效')
  if (value.zoom !== undefined && (!Number.isFinite(value.zoom) || value.zoom < 50 || value.zoom > 250)) throw new Error('页面缩放必须在 50% 到 250% 之间')
  if (value.coverAlone !== undefined && typeof value.coverAlone !== 'boolean') throw new Error('封面显示偏好无效')
  return { mode: value.mode || 'paged', direction: value.direction || 'ltr', fit: value.fit || 'page',
    zoom: value.zoom === undefined ? 100 : Math.round(value.zoom), coverAlone: value.coverAlone !== false }
}

function pageFromLegacyId(bookId, pageId) {
  if (!validBookId(bookId) || typeof pageId !== 'string' || !pageId.startsWith(bookId + '_')) return null
  const suffix = pageId.slice(bookId.length + 1)
  if (!/^[1-9]\d*$/.test(suffix)) return null
  const page = Number(suffix)
  return Number.isSafeInteger(page) && page <= MAX_PAGE_COUNT ? page : null
}

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, pageBase: 1, revision: 0, progress: {}, preferences: {}, migrations: {}, migrationSnapshots: [] }
}

function validateState(value) {
  if (!isObject(value) || value.schemaVersion !== SCHEMA_VERSION || value.pageBase !== 1 ||
      !Number.isSafeInteger(value.revision) || value.revision < 0 || !isObject(value.progress) ||
      !isObject(value.migrations) || !Array.isArray(value.migrationSnapshots)) {
    throw new Error('阅读档案格式不受支持，请从备份恢复 reading-state.json')
  }
  for (const [id, progress] of Object.entries(value.progress)) {
    if (!validBookId(id)) throw new Error('阅读档案包含无效书籍 ID')
    normalizeProgress(progress)
  }
  // Existing version-one archives have no preferences field and remain valid.
  if (value.preferences !== undefined) {
    if (!isObject(value.preferences)) throw new Error('阅读偏好档案格式无效')
    for (const [id, preferences] of Object.entries(value.preferences)) {
      if (!validBookId(id)) throw new Error('阅读偏好包含无效书籍 ID')
      normalizePreferences(preferences)
    }
  }
  return value
}

function parseLegacy(raw, fallback) {
  if (typeof raw !== 'string') return fallback
  try { return JSON.parse(raw) } catch { return fallback }
}

function migrateLegacyProgress(raw, books, existing = {}) {
  const progress = { ...existing }
  const room = parseLegacy(raw['room-progress'], {})
  const classic = parseLegacy(raw.viewerReadingProgress, [])
  const recent = parseLegacy(raw.recentRead, [])
  const recentTimes = new Map((Array.isArray(recent) ? recent : []).filter(isObject)
    .filter(entry => validBookId(entry.id) && Number.isFinite(entry.read_time))
    .map(entry => [entry.id, Math.max(0, entry.read_time * 1000)]))
  const byId = new Map(books.map(book => [book.id, book]))
  let imported = 0
  const offer = (id, candidate) => {
    if (!validBookId(id)) return
    try {
      const next = normalizeProgress({ ...candidate, source: 'migration' })
      // Never let an untimed old record overwrite a newer room or main-process save.
      if (!progress[id] || next.time > progress[id].time) { progress[id] = next; imported++ }
    } catch { /* The untouched raw source is retained in the migration snapshot. */ }
  }
  if (isObject(room)) {
    for (const [id, entry] of Object.entries(room)) {
      if (isObject(entry)) offer(id, { ...entry, time: Number.isFinite(entry.time) ? entry.time : 0 })
    }
  }
  const seen = new Set()
  for (const entry of Array.isArray(classic) ? classic : []) {
    if (!isObject(entry) || seen.has(entry.bookId)) continue
    const page = pageFromLegacyId(entry.bookId, entry.pageId)
    if (!page) continue
    seen.add(entry.bookId) // The legacy array is newest-first.
    const book = byId.get(entry.bookId)
    const total = Number(book?.pageCount || book?.filecount)
    if (!Number.isSafeInteger(total) || total < 1) continue
    offer(entry.bookId, { page, total, offset: 0, time: recentTimes.get(entry.bookId) || 0 })
  }
  return { progress, imported }
}

async function writeAtomic(target, value) {
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  let handle
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600)
    await handle.writeFile(JSON.stringify(value, null, 2) + '\n', 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await fs.promises.rename(temporary, target)
  } finally {
    if (handle) await handle.close().catch(() => {})
    await fs.promises.rm(temporary, { force: true }).catch(() => {})
  }
}

function createReadingStateStore({ storePath, write = writeAtomic } = {}) {
  if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new Error('An absolute reading-state store path is required')
  const filePath = path.join(storePath, 'reading-state.json')
  const queue = serialQueue()
  let state
  const ready = (async () => {
    await fs.promises.mkdir(storePath, { recursive: true })
    try { state = validateState(JSON.parse(await fs.promises.readFile(filePath, 'utf8'))) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`阅读档案无法载入，原文件已保留：${error.message}`, { cause: error })
      state = emptyState()
    }
  })()
  // Initialization errors are reported by load/flush; do not create an unhandled rejection.
  ready.catch(() => {})
  const snapshot = () => clone({ schemaVersion: state.schemaVersion, pageBase: 1, revision: state.revision,
    progress: state.progress, preferences: state.preferences || {}, migrations: state.migrations })
  const commit = async next => {
    next.revision = state.revision + 1
    await write(filePath, next)
    state = next // Failed disk writes must not advance the in-memory state.
    return snapshot()
  }
  return {
    filePath,
    ready,
    flush: () => queue(async () => { await ready }),
    load: () => queue(async () => { await ready; return snapshot() }),
    saveProgress: (id, value) => queue(async () => {
      await ready
      if (!validBookId(id)) throw new Error('书籍 ID 无效')
      const nextProgress = normalizeProgress(value)
      const next = clone(state)
      // Arrival order is authoritative so intentional rereading can move backwards.
      // Clients share this serialized store; migration alone uses legacy timestamps.
      next.progress[id] = nextProgress
      await commit(next)
      return clone(next.progress[id])
    }),
    // Organizer undo must be able to restore the absence of a record, and it
    // must never overwrite progress saved after the user's merge preview.
    applyOrganizerProgress: (id, { expected, value } = {}) => queue(async () => {
      await ready
      if (!validBookId(id)) throw new Error('书籍 ID 无效')
      const current = state.progress[id] || null
      const wanted = expected == null ? null : normalizeProgress(expected)
      const equal = (left, right) => left === null || right === null ? left === right
        : ['page', 'total', 'offset', 'time', 'source'].every(key => left[key] === right[key])
      if (!equal(current, wanted)) throw new Error('阅读进度已更新，请重新预览；新进度已保留')
      if (value === undefined) throw new Error('整理操作缺少目标阅读进度')
      const next = clone(state)
      if (value === null) delete next.progress[id]
      else next.progress[id] = normalizeProgress(value)
      await commit(next)
      return value === null ? null : clone(next.progress[id])
    }),
    savePreferences: (id, value) => queue(async () => {
      await ready
      if (!validBookId(id)) throw new Error('书籍 ID 无效')
      const preferences = normalizePreferences(value)
      const next = clone(state)
      if (!next.preferences) next.preferences = {}
      next.preferences[id] = preferences
      await commit(next)
      return clone(preferences)
    }),
    migrate: (payload, books = []) => queue(async () => {
      await ready
      if (state.migrations.legacyV1) return snapshot()
      if (!isObject(payload)) throw new Error('旧阅读档案迁移参数无效')
      const raw = {}
      for (const key of LEGACY_KEYS) {
        const value = payload[key]
        if (value !== undefined && value !== null && typeof value !== 'string') throw new Error('旧阅读档案必须为原始文本')
        raw[key] = typeof value === 'string' ? value : null
      }
      if (Buffer.byteLength(JSON.stringify(raw)) > 32 * 1024 * 1024) throw new Error('旧阅读档案过大，迁移未修改任何原数据')
      const next = clone(state)
      const { progress, imported } = migrateLegacyProgress(raw, books, state.progress)
      const migratedAt = Date.now()
      next.progress = progress
      next.migrations.legacyV1 = { migratedAt, imported }
      next.migrationSnapshots.push({ name: 'localStorage-before-reading-state-v1', migratedAt,
        sha256: createHash('sha256').update(JSON.stringify(raw)).digest('hex'), storage: raw })
      return commit(next)
    })
  }
}

module.exports = { SCHEMA_VERSION, LEGACY_KEYS, normalizeProgress, normalizePreferences, validBookId, pageFromLegacyId,
  migrateLegacyProgress, validateState, writeAtomic, createReadingStateStore }
