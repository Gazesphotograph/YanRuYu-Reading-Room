'use strict'

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

// Preferences and the two legacy reading journals are portable. Browser caches,
// network cookies and arbitrary origin storage are deliberately not serialized.
const CLIENT_KEYS = new Set([
  'reading-room-interface', 'recentRead', 'viewerReadingProgress',
  'viewerImageWidth', 'imageStyleType', 'imageStyleFit', 'showViewerSide',
  'expandNodes', 'sortValue', 'room-theme', 'room-sort', 'room-view',
  'room-progress', 'room-reading-mode', 'room-external-reader',
  'room-library-state', 'room-smart-shelves', 'room-quality', 'room-personalization',
  'reading-room-theme', 'manager-theme', 'theme', 'room-night', 'appTheme',
])
const MAX_CLIENT_BYTES = 32 * 1024 * 1024

function validateClientValue(key, raw) {
  const jsonKeys = new Set(['recentRead', 'viewerReadingProgress', 'expandNodes', 'room-progress',
    'room-theme', 'room-sort', 'room-view', 'room-reading-mode', 'room-external-reader', 'room-night',
    'room-library-state', 'room-smart-shelves', 'room-quality', 'room-personalization'])
  let value = raw
  if (jsonKeys.has(key)) {
    try { value = JSON.parse(raw) } catch { throw new Error('界面偏好内容不是有效 JSON：' + key) }
  }
  const object = value => !!value && typeof value === 'object' && !Array.isArray(value)
  if (key === 'room-quality' && !['power','balanced','fine'].includes(value)) throw new Error('场景画质偏好无效')
  if (key === 'room-library-state') validateLibraryState(value)
  if (key === 'room-personalization') validatePersonalization(value)
  if (key === 'room-smart-shelves') {
    if (!Array.isArray(value) || value.length > 100) throw new Error('智能书架列表无效')
    const ids = new Set()
    for (const shelf of value) {
      if (!object(shelf) || typeof shelf.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(shelf.id) || ids.has(shelf.id) ||
          typeof shelf.name !== 'string' || !shelf.name.trim() || shelf.name.length > 80) throw new Error('智能书架内容无效')
      ids.add(shelf.id); validateLibraryState(shelf.query, true)
    }
  }
  if (key === 'recentRead' && (!Array.isArray(value) || value.some(item => !object(item) || typeof item.id !== 'string' || !Number.isFinite(item.read_time)))) throw new Error('最近阅读记录格式无效')
  if (key === 'viewerReadingProgress' && (!Array.isArray(value) || value.some(item => !object(item) || typeof item.bookId !== 'string' || typeof item.pageId !== 'string'))) throw new Error('旧阅读进度格式无效')
  if (key === 'expandNodes' && (!Array.isArray(value) || value.some(item => typeof item !== 'string'))) throw new Error('文件夹展开偏好格式无效')
  if (key === 'room-progress') {
    if (!object(value)) throw new Error('阅览室进度格式无效')
    for (const [id, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(id) || !object(item) ||
          !Number.isSafeInteger(item.page) || !Number.isSafeInteger(item.total) || item.page < 1 || item.total < item.page) throw new Error('阅览室进度内容无效')
    }
  }
  if (['room-theme', 'room-sort', 'room-view', 'room-reading-mode'].includes(key) && (typeof value !== 'string' || !value)) throw new Error('界面选项格式无效：' + key)
  if (['room-external-reader', 'room-night'].includes(key) && typeof value !== 'boolean') throw new Error('阅读器或主题开关格式无效')
  if (key === 'reading-room-interface' && !['classic', 'room'].includes(raw)) throw new Error('界面选择无效')
  if (key === 'showViewerSide' && !['true', 'false'].includes(raw)) throw new Error('缩略图侧栏偏好无效')
  if (key === 'viewerImageWidth' && (!Number.isFinite(Number(raw)) || Number(raw) <= 0)) throw new Error('阅读宽度偏好无效')
}

function validateLibraryState(value, queryOnly = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('书架筛选格式无效')
  if (typeof value.search !== 'string' || value.search.length > 1000 ||
      !['all','reading','finished','unread'].includes(value.filter) || typeof value.favorites !== 'boolean' ||
      typeof value.collectionId !== 'string' || value.collectionId.length > 200) throw new Error('书架筛选内容无效')
  if (value.featured !== undefined && typeof value.featured !== 'boolean') throw new Error('精选陈列筛选无效')
  for (const key of ['selectedTags','excludedTags']) {
    if (!Array.isArray(value[key]) || value[key].length > 200) throw new Error('书架标签筛选无效')
    for (const raw of value[key]) {
      if (typeof raw !== 'string' || raw.length > 600) throw new Error('书架标签筛选无效')
      let pair; try { pair = JSON.parse(raw) } catch { throw new Error('书架标签筛选无效') }
      if (!Array.isArray(pair) || pair.length !== 2 || pair.some(item => typeof item !== 'string' || !item)) throw new Error('书架标签筛选无效')
    }
  }
  if (queryOnly) return
  if (!['recent','title','author','pages','rating'].includes(value.sort) || !['shelf','grid'].includes(value.view) ||
      !['comfortable','standard','compact'].includes(value.density) || !Number.isSafeInteger(value.page) || value.page < 1 || value.page > 1000000 ||
      !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > 10000000 ||
      !Number.isFinite(value.tagScrollTop) || value.tagScrollTop < 0 || value.tagScrollTop > 10000000 ||
      !Number.isSafeInteger(value.tagLimit) || value.tagLimit < 40 || value.tagLimit > 10000 ||
      typeof value.tagSearch !== 'string' || value.tagSearch.length > 200 || typeof value.tagGroup !== 'string' || value.tagGroup.length > 100 ||
      typeof value.shelfId !== 'string' || value.shelfId.length > 100) throw new Error('书架浏览位置无效')
}

function validatePersonalization(value) {
  const object = item => !!item && typeof item === 'object' && !Array.isArray(item)
  const number = (item, min, max) => typeof item === 'number' && Number.isFinite(item) && item >= min && item <= max
  const themes = new Set(['paper', 'glass', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid'])
  if (!object(value) || value.schemaVersion !== 1 || !object(value.themes) || Object.keys(value.themes).some(key => !themes.has(key)) ||
      !Array.isArray(value.featuredIds) || value.featuredIds.length > 60 || new Set(value.featuredIds).size !== value.featuredIds.length ||
      value.featuredIds.some(id => typeof id !== 'string' || !id || id.length > 256 || ['__proto__', 'constructor', 'prototype'].includes(id)) ||
      !object(value.sound) || !['off', 'rain', 'breeze'].includes(value.sound.kind) || !number(value.sound.volume, 0, 40) ||
      typeof value.sound.duringReading !== 'boolean') throw new Error('私人阅览室偏好无效')
  for (const entry of Object.values(value.themes)) {
    if (!object(entry) || !number(entry.savedAt, 0, Number.MAX_SAFE_INTEGER)) throw new Error('已保存的房间布置无效')
    for (const options of [entry.current, entry.saved]) {
      if (!object(options) || !['balanced', 'airy', 'cozy'].includes(options.layout) ||
          !number(options.shelfOffset, -12, 12) || !number(options.furnitureOffset, -15, 15) ||
          !number(options.brightness, 75, 125) || !number(options.warmth, -30, 30) || !object(options.furniture) ||
          ['chair','table','lamp','rug','plants','objects'].some(key => typeof options.furniture[key] !== 'boolean') ||
          !object(options.camera) || !number(options.camera.yaw, -.29, .29) || !number(options.camera.panX, -1.8, 1.8) ||
          !number(options.camera.panY, -1.15, 1.15) || !number(options.camera.zoom, .72, 1.9)) throw new Error('房间布置参数超出允许范围')
    }
  }
}

function validateClientState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.schemaVersion !== 1 ||
      !input.values || typeof input.values !== 'object' || Array.isArray(input.values)) {
    throw new Error('界面偏好文件格式不正确')
  }
  const values = Object.create(null)
  for (const [key, value] of Object.entries(input.values)) {
    if (!CLIENT_KEYS.has(key)) throw new Error('界面偏好包含不支持的项目')
    if (typeof value !== 'string') throw new Error('界面偏好值必须是文本')
    validateClientValue(key, value)
    values[key] = value
  }
  if (Buffer.byteLength(JSON.stringify(values)) > MAX_CLIENT_BYTES) throw new Error('界面偏好文件过大')
  const result = { schemaVersion: 1, values, savedAt: Number(input.savedAt) || Date.now() }
  if (input.restoreToken !== undefined) {
    if (typeof input.restoreToken !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(input.restoreToken)) throw new Error('恢复标识无效')
    result.restoreToken = input.restoreToken
  }
  return result
}

function readClientState(storePath) {
  try {
    const target = path.join(storePath, 'ui-state.json')
    if (fs.statSync(target).size > MAX_CLIENT_BYTES + 4096) throw new Error('界面偏好文件过大')
    return validateClientState(JSON.parse(fs.readFileSync(target, 'utf8')))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function writeClientState(storePath, input) {
  const next = validateClientState(input)
  const previous = readClientState(storePath)
  if (previous?.restoreToken) next.restoreToken = previous.restoreToken
  const target = path.join(storePath, 'ui-state.json')
  const temporary = target + '.' + randomUUID() + '.tmp'
  fs.mkdirSync(storePath, { recursive: true })
  try {
    const descriptor = fs.openSync(temporary, 'wx')
    try { fs.writeFileSync(descriptor, JSON.stringify(next, null, 2)); fs.fsyncSync(descriptor) }
    finally { fs.closeSync(descriptor) }
    fs.renameSync(temporary, target)
  } finally {
    try { fs.unlinkSync(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return next
}

module.exports = { CLIENT_KEYS, MAX_CLIENT_BYTES, validateClientState, readClientState, writeClientState }
