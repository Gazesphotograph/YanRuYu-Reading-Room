'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { assertWithin, isWithin } = require('./safety')
const { checkCancelled } = require('./source_signature')

const IMAGE_EXTENSION = /\.(jpg|jpeg|png|webp|avif|gif)$/i
const DERIVED_FIELDS = ['filepath', 'type', 'coverPath', 'hash', 'pageCount', 'bundleSize', 'mtime', 'coverHash', 'identityFingerprint', 'sourceSignature', 'exist']

function pathKey(filepath) {
  const resolved = path.resolve(filepath)
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved
}

async function hashWholeFile(filepath, signal) {
  checkCancelled(signal)
  const before = await fs.promises.lstat(filepath)
  if (!before.isFile() || before.isSymbolicLink()) throw new Error('书籍指纹只接受普通文件')
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filepath)) { checkCancelled(signal); hash.update(chunk) }
  const after = await fs.promises.lstat(filepath)
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) {
    throw new Error('书籍在校验过程中发生变化，请稍后重新扫描')
  }
  return { hash: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs, ino: after.ino }
}

// The old `hash` is only one sampled image and remains a metadata lookup key.
// It MUST NOT identify a book. Every byte of an archive, or every page in a
// folder (including its name), contributes to this separate SHA-256 identity.
async function fingerprintBook(filepath, type, { libraryRoot, signal } = {}) {
  checkCancelled(signal)
  if (libraryRoot) await assertWithin(libraryRoot, filepath, type === 'folder')
  const stat = await fs.promises.lstat(filepath)
  if (stat.isSymbolicLink()) throw new Error('无法为链接路径建立稳定书籍身份')
  if (type !== 'folder') {
    const file = await hashWholeFile(filepath, signal)
    return `file-sha256-v1:${file.hash}`
  }
  if (!stat.isDirectory()) throw new Error('书籍目录不存在')
  const entries = (await fs.promises.readdir(filepath, { withFileTypes: true }))
    .filter(entry => IMAGE_EXTENSION.test(entry.name))
    .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  if (!entries.length) throw new Error('书籍目录没有图片')
  const hash = createHash('sha256').update('folder-pages-v1\0')
  const checkedFiles = []
  for (const entry of entries) {
    checkCancelled(signal)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('书籍图片包含不支持的链接或目录')
    const file = await hashWholeFile(path.join(filepath, entry.name), signal)
    checkedFiles.push({ name: entry.name, ...file })
    hash.update(JSON.stringify([entry.name, file.size, file.hash]) + '\n')
  }
  const after = (await fs.promises.readdir(filepath, { withFileTypes: true }))
    .filter(entry => IMAGE_EXTENSION.test(entry.name)).map(entry => entry.name).sort()
  if (JSON.stringify(after) !== JSON.stringify(entries.map(entry => entry.name))) throw new Error('书籍在校验过程中增加或删除了图片')
  for (const file of checkedFiles) {
    const current = await fs.promises.lstat(path.join(filepath, file.name))
    if (current.size !== file.size || current.mtimeMs !== file.mtimeMs || current.ino !== file.ino) throw new Error('书籍在校验过程中发生变化')
  }
  return `folder-sha256-v1:${hash.digest('hex')}`
}

async function confirmedMissing(filepath, libraryRoot) {
  if (libraryRoot && !isWithin(libraryRoot, filepath, true)) return false
  try { await fs.promises.lstat(filepath); return false }
  catch (error) { if (error.code !== 'ENOENT') return false }
  let parent = path.dirname(filepath)
  while (!libraryRoot || isWithin(libraryRoot, parent, true)) {
    try { await fs.promises.readdir(parent); return true }
    catch (error) { if (error.code !== 'ENOENT') return false }
    const next = path.dirname(parent)
    if (next === parent) return false
    parent = next
  }
  return false
}

// Reconnecting a verified book is different from marking a library entry
// missing. A previous computer's root (or drive) need not exist here. Only an
// absent path is eligible; permission and I/O errors never prove relocation.
// Keep confirmedMissing's root boundary for health checks and removal guards.
async function canRelocateSource(filepath, libraryRoot) {
  if (typeof filepath !== 'string' || !path.isAbsolute(filepath)) return false
  if (libraryRoot && isWithin(libraryRoot, filepath, true) && !(await confirmedMissing(filepath, libraryRoot))) return false
  try { await fs.promises.lstat(filepath); return false }
  catch (error) { if (error.code !== 'ENOENT') return false }
  let parent = path.dirname(filepath)
  while (true) {
    try {
      const stat = await fs.promises.lstat(parent)
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false
    } catch (error) { if (error.code !== 'ENOENT') return false }
    const next = path.dirname(parent)
    if (next === parent) return true
    parent = next
  }
}

function createIdentityResolver(previousBooks, scannedFiles, { libraryRoot, missing = canRelocateSource, mergedSources = {} } = {}) {
  const byPath = new Map()
  const byFingerprint = new Map()
  const claimed = new Set()
  const scannedPaths = new Set(scannedFiles.map(file => pathKey(file.filepath)))
  const byId = new Map(previousBooks.map(book => [book.id, book]))
  const mergeFor = id => {
    const relation = Object.hasOwn(mergedSources, id) ? mergedSources[id] : null
    return typeof relation === 'string' ? { keeperId: relation, sharedSource: true } : relation
  }
  const lineageOf = book => {
    const seen = new Set()
    let keeper = book
    while (keeper.hiddenBook && byId.has(mergeFor(keeper.id)?.keeperId)) {
      if (seen.has(keeper.id)) return [book]
      seen.add(keeper.id)
      keeper = byId.get(mergeFor(keeper.id).keeperId)
    }
    return [...seen].map(id => byId.get(id)).concat(keeper)
  }
  const keeperOf = book => lineageOf(book).at(-1)
  for (const book of previousBooks) {
    const key = pathKey(book.filepath)
    if (!byPath.has(key)) byPath.set(key, [])
    byPath.get(key).push(book)
    // Hidden books still have independent identities. Only an explicit,
    // applied organizer merge makes a donor an archived source of its keeper.
    if (keeperOf(book).id !== book.id && mergeFor(book.id)?.sharedSource) continue
    if (!byFingerprint.has(book.identityFingerprint)) byFingerprint.set(book.identityFingerprint, [])
    byFingerprint.get(book.identityFingerprint).push(book)
  }
  return {
    atPath(filepath) {
      const books = byPath.get(pathKey(filepath)) || []
      if (books.length > 1) {
        const lineages = books.map(book => new Set(lineageOf(book).map(item => item.id)))
        // A former keeper may itself have been merged into a book at another
        // path. Keep updating that local source, not the final keeper's path.
        const keeper = books.find(book => lineages.every(lineage => lineage.has(book.id)))
        if (keeper) return keeper
        throw new Error('同一路径存在多条书目，请在书库整理中合并展示后重新扫描；原记录与进度已保留')
      }
      return books[0] || null
    },
    claim(book) {
      if (claimed.has(book.id)) throw new Error('同一书籍身份已被另一文件使用')
      claimed.add(book.id)
      return book
    },
    async relocated(filepath, type, fingerprint) {
      if (typeof fingerprint !== 'string' || !/^(file|folder)-sha256-v1:[0-9a-f]{64}$/.test(fingerprint)) return null
      const matches = []
      for (const book of byFingerprint.get(fingerprint) || []) {
        if (claimed.has(book.id) ||
            (book.type === 'folder') !== (type === 'folder') || scannedPaths.has(pathKey(book.filepath)) ||
            pathKey(book.filepath) === pathKey(filepath)) continue
        // An identical copy whose original still exists is always a NEW book.
        if (await missing(book.filepath, libraryRoot)) matches.push(book)
      }
      if (matches.length === 1) return matches[0]
      // A keeper and its explicitly merged physical copies share one shelf
      // display. Prefer the keeper, then reconnect each separate hidden copy.
      // Unrelated matching histories remain ambiguous and must not be chosen.
      const keepers = matches.filter(book => keeperOf(book).id === book.id)
      if (keepers.length === 1 && matches.every(book => keeperOf(book).id === keepers[0].id)) return keepers[0]
      return null
    },
    isClaimed: id => claimed.has(id)
  }
}

function mergeRebuiltBook(previous, generated) {
  if (!previous) return { mark: false, hiddenBook: false, readCount: 0, exist: true, ...generated }
  const merged = { ...generated, ...previous }
  for (const field of DERIVED_FIELDS) if (Object.hasOwn(generated, field)) merged[field] = generated[field]
  // Metadata, custom titles, favorite/hidden flags, counts, dates, and ID all
  // belong to the existing logical book, even when its cover is regenerated.
  merged.id = previous.id
  merged.exist = true
  return merged
}

async function moveWithIdentity({ oldPath, newPath, type, libraryRoot, persist, fingerprint = fingerprintBook }) {
  if (pathKey(oldPath) === pathKey(newPath)) throw new Error('新旧书籍路径相同')
  try { await fs.promises.lstat(newPath); throw new Error('目标路径已存在，移动未执行') }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  const identityFingerprint = await fingerprint(oldPath, type, { libraryRoot })
  await fs.promises.rename(oldPath, newPath)
  try {
    if (await fingerprint(newPath, type, { libraryRoot }) !== identityFingerprint) throw new Error('移动后的书籍校验不一致')
    await persist(identityFingerprint)
    return identityFingerprint
  } catch (error) {
    try {
      // Never overwrite a concurrently created source during rollback.
      try { await fs.promises.lstat(oldPath); throw new Error('原路径已被占用') }
      catch (checkError) { if (checkError.code !== 'ENOENT') throw checkError }
      await fs.promises.rename(newPath, oldPath)
    } catch (rollbackError) {
      throw new Error(`移动记录保存失败且无法移回原路径。书籍保留在 ${newPath}：${rollbackError.message}`, { cause: error })
    }
    throw error
  }
}

module.exports = { pathKey, fingerprintBook, confirmedMissing, canRelocateSource, createIdentityResolver, mergeRebuiltBook, moveWithIdentity }
