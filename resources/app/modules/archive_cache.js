'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { safeEntry, assertWithin, serialQueue } = require('./safety')

const DEFAULT_BUDGET_BYTES = 2 * 1024 ** 3
const DEFAULT_MIN_FREE_BYTES = 256 * 1024 ** 2
const MARKER = '.manager-cache.json'
const IMAGE_MANIFEST = '.manager-images.json'
const CACHE_NAME = /^archive-[a-f0-9]{64}$/
const PENDING_NAME = /^\.archive-pending-[a-f0-9]{64}-[a-f0-9-]{36}$/

function abortError() {
  return Object.assign(new Error('任务已取消'), { name: 'AbortError', code: 'ABORT_ERR' })
}

function checkCancelled(signal) {
  if (signal?.aborted) throw abortError()
}

function sourceKey(filepath, stat) {
  return createHash('sha256').update(JSON.stringify([path.resolve(filepath), stat.size, stat.mtimeMs, stat.ctimeMs])).digest('hex')
}

function validateNames(names) {
  if (!Array.isArray(names) || !names.length || names.length > 100000) throw new Error('解压缓存图片清单无效')
  const unique = new Set()
  for (const name of names) {
    safeEntry(name)
    if (!/\.(jpg|jpeg|png|webp|avif|gif)$/i.test(name)) throw new Error('解压缓存包含非图片条目')
    const normalized = name.replace(/\\/g, '/').toLowerCase()
    if (unique.has(normalized)) throw new Error('压缩包中存在重复或大小写冲突的图片路径')
    unique.add(normalized)
  }
  return names
}

async function readMarker(directory) {
  try {
    const filename = path.join(directory, MARKER), stat = await fs.promises.lstat(filename)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return null
    const marker = JSON.parse(await fs.promises.readFile(filename, 'utf8'))
    return marker?.application === 'yanruyu-archive-cache' && marker.version === 1 ? marker : null
  } catch { return null }
}

class ArchiveCache {
  constructor({ rootPath, budgetBytes = DEFAULT_BUDGET_BYTES, minFreeBytes = DEFAULT_MIN_FREE_BYTES, statfs, now = Date.now, legacyLeaseMs = 60000 } = {}) {
    if (!rootPath) throw new Error('解压缓存目录未指定')
    this.rootPath = path.resolve(rootPath)
    this.budgetBytes = budgetBytes
    this.minFreeBytes = minFreeBytes
    this.statfs = statfs || (directory => fs.promises.statfs(directory))
    this.now = now
    this.legacyLeaseMs = legacyLeaseMs
    this.entries = new Map()
    this.owners = new Map()
    this.pending = new Map()
    this.queue = serialQueue()
    this.initialized = null
  }

  async initialize() {
    if (!this.initialized) this.initialized = this._initialize().catch(error => { this.initialized = null; throw error })
    return this.initialized
  }

  async _initialize() {
    await fs.promises.mkdir(this.rootPath, { recursive: true })
    if ((await fs.promises.lstat(this.rootPath)).isSymbolicLink()) throw new Error('解压缓存根目录不能是链接')
    for (const dirent of await fs.promises.readdir(this.rootPath, { withFileTypes: true })) {
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      const directory = path.join(this.rootPath, dirent.name)
      if (PENDING_NAME.test(dirent.name)) {
        const marker = await readMarker(directory)
        if (marker?.state === 'pending' || marker?.state === 'complete') await this.removeDirectory(directory, true)
        continue
      }
      if (!CACHE_NAME.test(dirent.name)) continue
      try {
        const entry = await this.inspectEntry(directory)
        this.entries.set(dirent.name.slice(8), entry)
      } catch {
        // An application marker identifies an interrupted or
        // damaged cache that can be regenerated. Unrecognized directories and
        // linked content are preserved instead of guessing ownership.
        if (await readMarker(directory)) await this.removeDirectory(directory).catch(() => {})
      }
    }
  }

  async treeBytes(directory, signal) {
    let bytes = 0, count = 0
    const visit = async current => {
      checkCancelled(signal)
      for (const dirent of await fs.promises.readdir(current, { withFileTypes: true })) {
        checkCancelled(signal)
        if (++count > 100010) throw new Error('解压缓存文件数量超出限制')
        const filename = path.join(current, dirent.name), stat = await fs.promises.lstat(filename)
        if (stat.isSymbolicLink()) throw new Error('解压缓存中不能包含链接')
        if (stat.isDirectory()) await visit(filename)
        else if (stat.isFile()) bytes += stat.size
        else throw new Error('解压缓存包含特殊文件')
        if (!Number.isSafeInteger(bytes) || bytes > 17 * 1024 ** 3) throw new Error('解压缓存大小超出限制')
      }
    }
    await visit(directory)
    return bytes
  }

  async inspectEntry(directory) {
    await this.validateDirectory(directory, false)
    const manifestPath = path.join(directory, IMAGE_MANIFEST), manifestStat = await fs.promises.lstat(manifestPath)
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 ** 2) throw new Error('解压缓存清单过大或无效')
    const names = validateNames(JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')))
    const marker = await readMarker(directory), stat = await fs.promises.stat(directory)
    if (marker && marker.state !== 'complete') throw new Error('解压缓存尚未完成')
    return { directory, names, bytes: await this.treeBytes(directory), source: marker?.source || null, lastUsed: stat.mtimeMs, leaseUntil: 0 }
  }

  async validateDirectory(directory, pending = false) {
    const target = path.resolve(directory)
    if (path.dirname(target) !== this.rootPath || !(pending ? PENDING_NAME : CACHE_NAME).test(path.basename(target))) throw new Error('拒绝操作缓存目录以外的路径')
    const stat = await fs.promises.lstat(target)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('缓存目录不是普通目录')
    await assertWithin(this.rootPath, target)
    return target
  }

  async removeDirectory(directory, pending = false) {
    const target = await this.validateDirectory(directory, pending)
    // Check every child before recursive removal so linked trees cannot become
    // cleanup targets, even when an old manifest has been tampered with.
    await this.treeBytes(target)
    await fs.promises.rm(target, { recursive: true, force: false })
  }

  isProtected(key, entry) {
    return entry.leaseUntil > this.now() || [...this.owners.values()].some(owned => owned === key)
  }

  async freeBytes() {
    let info
    try { info = await this.statfs(this.rootPath) }
    catch (error) { throw new Error(`无法确认缓存磁盘空闲空间：${error.message}`, { cause: error }) }
    const bytes = Number(info.bavail) * Number(info.bsize)
    if (!Number.isFinite(bytes) || bytes < 0) throw new Error('无法确认缓存磁盘空闲空间')
    return Math.floor(bytes)
  }

  usedBytes() {
    return [...this.entries.values()].reduce((sum, entry) => sum + entry.bytes, 0)
  }

  candidates() {
    return [...this.entries].filter(([key, entry]) => !this.isProtected(key, entry)).sort((a, b) => a[1].lastUsed - b[1].lastUsed)
  }

  async evict(key, entry) {
    if (this.isProtected(key, entry)) return false
    try { await this.removeDirectory(entry.directory) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`无法清理解压缓存：${error.message}`, { cause: error })
    }
    this.entries.delete(key)
    return true
  }

  async reserve(bytes, signal) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('压缩包展开大小无效')
    if (bytes > this.budgetBytes) throw new Error('这本书的解压大小超过缓存预算，请在设置中提高缓存容量后重试')
    let free = await this.freeBytes()
    const candidates = this.candidates(), reclaimable = candidates.reduce((sum, [, entry]) => sum + entry.bytes, 0)
    if (this.usedBytes() - reclaimable + bytes > this.budgetBytes) throw new Error('缓存容量不足，使用中的书籍受到保护；请关闭其他阅读任务或提高缓存容量后重试')
    if (free + reclaimable < bytes + this.minFreeBytes) throw new Error('磁盘空闲空间不足，已停止解压；请释放空间后重试')
    for (const [key, entry] of candidates) {
      checkCancelled(signal)
      if (this.usedBytes() + bytes <= this.budgetBytes && free >= bytes + this.minFreeBytes) break
      if (await this.evict(key, entry)) free = await this.freeBytes()
    }
    if (this.usedBytes() + bytes > this.budgetBytes) throw new Error('解压缓存预算不足')
    if (free < bytes + this.minFreeBytes) throw new Error('磁盘空闲空间不足，已停止解压；请释放空间后重试')
  }

  pin(key, entry, owner) {
    entry.lastUsed = this.now()
    if (owner) this.owners.set(String(owner), key)
    else entry.leaseUntil = Math.max(entry.leaseUntil, this.now() + this.legacyLeaseMs)
  }

  async validateImages(entry, signal) {
    for (const name of entry.names) {
      checkCancelled(signal)
      const filename = path.join(entry.directory, name)
      await assertWithin(entry.directory, filename)
      const stat = await fs.promises.lstat(filename)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('解压缓存图片缺失或已被替换')
    }
  }

  getOrCreate({ key, filepath, owner, signal, onProgress, inspect, extract }) {
    if (!/^[a-f0-9]{64}$/.test(key)) return Promise.reject(new Error('解压缓存标识无效'))
    const run = this.queue(async () => {
      checkCancelled(signal)
      await this.initialize()
      let entry = this.entries.get(key)
      if (entry) {
        try { await this.validateImages(entry, signal) }
        catch (error) {
          checkCancelled(signal)
          if (this.isProtected(key, entry)) throw new Error('使用中的解压缓存已发生变化，请关闭阅读器后重试')
          await this.evict(key, entry); entry = null
        }
      }
      if (entry) {
        checkCancelled(signal);this.pin(key, entry, owner)
        const now = new Date(this.now())
        await fs.promises.utimes(entry.directory, now, now).catch(() => {})
        onProgress?.({ phase:'cached', current:1, total:1, message:'使用已有解压缓存' })
        return entry.names.map(relativePath => ({ relativePath, absolutePath:path.join(entry.directory, relativePath) }))
      }
      onProgress?.({ phase:'inspect', current:0, total:1, message:'检查压缩包与磁盘空间' })
      const info = await inspect(signal)
      checkCancelled(signal)
      validateNames(info.names)
      const reservedBytes = info.expandedBytes + Buffer.byteLength(JSON.stringify(info.names)) * 2 + Buffer.byteLength(String(filepath)) + 8192
      await this.reserve(reservedBytes, signal)
      checkCancelled(signal)
      const directory = path.join(this.rootPath, 'archive-' + key)
      const staging = path.join(this.rootPath, '.archive-pending-' + key + '-' + randomUUID())
      if (fs.existsSync(directory)) throw new Error('缓存目标目录已存在但无法验证，已保留原内容；请检查缓存目录')
      await fs.promises.mkdir(staging)
      const marker = { application:'yanruyu-archive-cache', version:1, state:'pending', source:path.resolve(filepath) }
      this.pending.set(key, reservedBytes)
      let committed = false
      try {
        await fs.promises.writeFile(path.join(staging, MARKER), JSON.stringify(marker))
        await extract(staging, info, signal, onProgress)
        checkCancelled(signal)
        entry = { directory:staging, names:info.names, source:marker.source, bytes:0, lastUsed:this.now(), leaseUntil:0 }
        await this.validateImages(entry, signal)
        await fs.promises.writeFile(path.join(staging, IMAGE_MANIFEST), JSON.stringify(info.names))
        await fs.promises.writeFile(path.join(staging, MARKER), JSON.stringify({ ...marker, state:'complete' }))
        entry.bytes = await this.treeBytes(staging, signal)
        if (entry.bytes + this.usedBytes() > this.budgetBytes) throw new Error('实际解压大小超过缓存预算，未保留这次未完成缓存')
        if (await this.freeBytes() < this.minFreeBytes) throw new Error('磁盘剩余空间低于保留量，未保留这次未完成缓存')
        checkCancelled(signal)
        await fs.promises.rename(staging, directory)
        committed = true;entry.directory=directory
        this.pin(key, entry, owner);this.entries.set(key, entry)
        onProgress?.({ phase:'complete', current:1, total:1, message:'解压完成' })
        return entry.names.map(relativePath => ({ relativePath, absolutePath:path.join(directory, relativePath) }))
      } finally {
        this.pending.delete(key)
        if (!committed) await this.removeDirectory(staging, true)
      }
    })
    // A queued cancellation is observable immediately. Its queued work still
    // reaches the signal check later and never creates files or a reader pin.
    if (!signal) return run
    return new Promise((resolve, reject) => {
      const abort = () => reject(abortError())
      signal.addEventListener('abort', abort, { once:true })
      if (signal.aborted) abort()
      run.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
    })
  }

  async getStatus() {
    await this.initialize()
    const active = [...this.entries].filter(([key, entry]) => this.isProtected(key, entry))
    const usedBytes = this.usedBytes()
    return { budgetBytes:this.budgetBytes, usedBytes, protectedBytes:active.reduce((sum,[,entry])=>sum+entry.bytes,0), entryCount:this.entries.size, activeEntries:active.length, pendingEntries:this.pending.size, reservedBytes:[...this.pending.values()].reduce((sum,bytes)=>sum+bytes,0), freeBytes:await this.freeBytes(), minFreeBytes:this.minFreeBytes, overBudgetBytes:Math.max(0,usedBytes-this.budgetBytes) }
  }

  setBudget(bytes) {
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 ** 3) return Promise.reject(new Error('缓存容量必须大于 0 且不超过 64 GiB'))
    return this.queue(async () => { await this.initialize();this.budgetBytes=bytes;return this.trim(false) })
  }

  clearUnused() {
    return this.queue(async () => { await this.initialize();return this.trim(true) })
  }

  async trim(all) {
    let removedEntries=0,removedBytes=0
    for (const [key,entry] of this.candidates()) {
      if (!all && this.usedBytes() <= this.budgetBytes) break
      if (await this.evict(key,entry)){removedEntries++;removedBytes+=entry.bytes}
    }
    return { ...await this.getStatus(), removedEntries, removedBytes }
  }

  release(owner) {
    return this.queue(async () => { await this.initialize();this.owners.delete(String(owner));return this.trim(false) })
  }

  invalidateSource(filepath) {
    return this.queue(async () => {
      await this.initialize()
      for (const [key,entry] of this.entries) if (entry.source===path.resolve(filepath)&&!this.isProtected(key,entry)) await this.evict(key,entry)
    })
  }
}

const caches = new Map()
function getArchiveCache(rootPath) {
  const root = path.resolve(rootPath)
  if (!caches.has(root)) caches.set(root, new ArchiveCache({ rootPath:root }))
  return caches.get(root)
}

module.exports = { ArchiveCache, getArchiveCache, sourceKey, validateNames, checkCancelled, abortError, DEFAULT_BUDGET_BYTES, DEFAULT_MIN_FREE_BYTES }
