'use strict'

const fs = require('fs')
const path = require('path')
const { createHash, randomBytes } = require('crypto')
const { assertWithin, isWithin } = require('./safety')

const ARCHIVE_EXTENSION = /^\.(zip|cbz|rar|cbr|7z|cb7)$/i
const RECOVERY_ID = /^\d{13}-[a-f0-9]{16}$/

async function sha256(filepath) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filepath)) hash.update(chunk)
  return hash.digest('hex')
}

async function syncFile(filepath) {
  const handle = await fs.promises.open(filepath, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function copyDurably(source, target) {
  await fs.promises.copyFile(source, target, fs.constants.COPYFILE_EXCL)
  try { await syncFile(target) } catch (error) {
    await fs.promises.unlink(target).catch(() => {})
    throw error
  }
}

async function writeManifest(directory, record) {
  const temporary = path.join(directory, '.manifest-' + randomBytes(8).toString('hex') + '.tmp')
  const handle = await fs.promises.open(temporary, 'wx')
  try {
    await handle.writeFile(JSON.stringify(record, null, 2), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await fs.promises.rename(temporary, path.join(directory, 'manifest.json'))
  } catch (error) {
    await fs.promises.unlink(temporary).catch(() => {})
    throw error
  }
}

async function recoveryRoot(storePath, create = false) {
  if (typeof storePath !== 'string' || !path.isAbsolute(storePath)) throw new Error('恢复点目录无效')
  const root = path.join(storePath, 'recovery')
  if (create) await fs.promises.mkdir(root, { recursive: true })
  await assertWithin(storePath, root)
  if ((await fs.promises.lstat(root)).isSymbolicLink()) throw new Error('恢复点目录不能是链接')
  return root
}

async function archiveStat(filepath) {
  if (typeof filepath !== 'string' || !path.isAbsolute(filepath) || !ARCHIVE_EXTENSION.test(path.extname(filepath))) {
    throw new Error('恢复点仅支持书库中的压缩包文件')
  }
  const stat = await fs.promises.lstat(filepath)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('压缩包必须是普通文件')
  return stat
}

function sameStat(a, b) {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.ino === b.ino && a.dev === b.dev
}

async function assertUnchanged(filepath, expected, expectedHash) {
  const before = await archiveStat(filepath)
  if (!sameStat(before, expected) || await sha256(filepath) !== expectedHash || !sameStat(before, await archiveStat(filepath))) {
    throw new Error('原压缩包已被其他操作修改，已停止替换')
  }
}

function publicPoint(record) {
  return {
    id: record.id,
    createdAt: record.createdAt,
    originalPath: record.originalPath,
    filename: path.basename(record.originalPath),
    size: record.size,
    sha256: record.sha256,
    removedEntry: record.removedEntry || null,
    status: record.status,
    reason: record.reason,
    error: record.error || null,
    restoredAt: record.restoredAt || null,
    available: true,
  }
}

async function createArchiveRecoveryPoint(storePath, filepath, options = {}) {
  filepath = path.resolve(filepath)
  const initial = await archiveStat(filepath)
  const root = await recoveryRoot(storePath, true)
  if (isWithin(root, filepath, true)) throw new Error('不能编辑恢复点中的压缩包')
  const id = Date.now() + '-' + randomBytes(8).toString('hex')
  const directory = path.join(root, id)
  await fs.promises.mkdir(directory)
  await assertWithin(root, directory)
  const backupFile = 'original' + path.extname(filepath).toLowerCase()
  const backupPath = path.join(directory, backupFile)
  try {
    await copyDurably(filepath, backupPath)
    const backupHash = await sha256(backupPath)
    await assertUnchanged(filepath, initial, backupHash)
    const record = {
      version: 1,
      id,
      createdAt: new Date().toISOString(),
      originalPath: filepath,
      backupFile,
      size: initial.size,
      sha256: backupHash,
      sourceMtimeMs: initial.mtimeMs,
      removedEntry: options.removedEntry || null,
      reason: options.reason || 'before-edit',
      status: options.status || 'prepared',
    }
    await writeManifest(directory, record)
    return { record, directory, backupPath, sourceStat: initial }
  } catch (error) {
    // Only files created by this attempt are removed; the source is never a cleanup target.
    await fs.promises.unlink(backupPath).catch(() => {})
    await fs.promises.rmdir(directory).catch(() => {})
    throw new Error(`无法创建并校验恢复点，原包未修改：${error.message}`, { cause: error })
  }
}

function stagedPath(filepath, id) {
  return path.join(path.dirname(filepath), '.' + path.basename(filepath, path.extname(filepath)) + '.manager-' + id + path.extname(filepath))
}

async function updatePoint(point, changes) {
  const record = { ...point.record, ...changes }
  await writeManifest(point.directory, record)
  point.record = record
}

async function editArchiveSafely({ storePath, filepath, removedEntry, modify, verify }) {
  const point = await createArchiveRecoveryPoint(storePath, filepath, { reason: 'delete-image', removedEntry })
  const staged = stagedPath(filepath, point.record.id)
  let committed = false
  let stagedCreated = false
  try {
    await copyDurably(point.backupPath, staged)
    stagedCreated = true
    await modify(staged)
    await syncFile(staged)
    await verify(staged)
    const editedHash = await sha256(staged)
    await assertUnchanged(filepath, point.sourceStat, point.record.sha256)
    // Same-directory rename replaces the original atomically. A failed rename leaves it intact.
    await fs.promises.rename(staged, filepath)
    committed = true
    try {
      await updatePoint(point, { status: 'completed', completedAt: new Date().toISOString(), editedSha256: editedHash })
    } catch (error) {
      // The durable prepared manifest remains a valid recovery point after a successful edit.
      console.error('压缩包已修改，恢复点状态更新失败；原始恢复文件仍可使用：', error)
    }
    return publicPoint(point.record)
  } catch (error) {
    await updatePoint(point, { status: 'failed', error: String(error.message || error).slice(0, 2000) }).catch(() => {})
    throw new Error(`压缩包修改失败，原包未改动；恢复点 ${point.record.id} 已保留：${error.message}`, { cause: error })
  } finally {
    if (!committed && stagedCreated) await fs.promises.unlink(staged).catch(() => {})
  }
}

async function readPoint(storePath, id) {
  if (typeof id !== 'string' || !RECOVERY_ID.test(id)) throw new Error('恢复点编号无效')
  const root = await recoveryRoot(storePath)
  const directory = path.join(root, id)
  await assertWithin(root, directory)
  if (!(await fs.promises.lstat(directory)).isDirectory()) throw new Error('恢复点目录无效')
  const manifestPath = path.join(directory, 'manifest.json')
  await assertWithin(directory, manifestPath)
  if (!(await fs.promises.lstat(manifestPath)).isFile()) throw new Error('恢复点清单无效')
  const record = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'))
  if (record.version !== 1 || record.id !== id || !path.isAbsolute(record.originalPath || '') ||
      !ARCHIVE_EXTENSION.test(path.extname(record.originalPath)) ||
      record.backupFile !== 'original' + path.extname(record.originalPath).toLowerCase() ||
      !Number.isSafeInteger(record.size) || record.size < 0 || !/^[a-f0-9]{64}$/.test(record.sha256 || '')) {
    throw new Error('恢复点清单格式无效')
  }
  const backupPath = path.join(directory, record.backupFile)
  await assertWithin(directory, backupPath)
  const stat = await fs.promises.lstat(backupPath)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.size) throw new Error('恢复文件缺失或大小校验失败')
  return { record, directory, backupPath, root }
}

async function listArchiveRecoveryPoints(storePath) {
  let root
  try { root = await recoveryRoot(storePath) } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const names = await fs.promises.readdir(root)
  const points = []
  for (const id of names.filter(name => RECOVERY_ID.test(name)).sort().reverse()) {
    try {
      points.push(publicPoint((await readPoint(storePath, id)).record))
    } catch (error) {
      points.push({ id, createdAt: new Date(Number(id.split('-')[0])).toISOString(), originalPath: '', filename: id, size: 0, status: 'invalid', reason: 'invalid-recovery', available: false, error: error.message })
    }
  }
  return points
}

async function restoreArchiveRecoveryPoint(storePath, id, { libraryPath } = {}) {
  const point = await readPoint(storePath, id)
  const original = point.record.originalPath
  if (!isWithin(libraryPath, original) || isWithin(point.root, original, true)) throw new Error('恢复目标不在当前书库中')
  await assertWithin(libraryPath, path.dirname(original), true)
  if (await sha256(point.backupPath) !== point.record.sha256) throw new Error('恢复文件 SHA256 校验失败，已停止恢复')

  let previous
  try {
    await archiveStat(original)
    await assertWithin(libraryPath, original)
    previous = await createArchiveRecoveryPoint(storePath, original, { reason: 'before-restore', status: 'available' })
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }

  const staged = stagedPath(original, Date.now() + '-' + randomBytes(8).toString('hex'))
  let committed = false
  let stagedCreated = false
  try {
    await copyDurably(point.backupPath, staged)
    stagedCreated = true
    if (await sha256(staged) !== point.record.sha256) throw new Error('恢复副本 SHA256 校验失败')
    if (previous) {
      await assertUnchanged(original, previous.sourceStat, previous.record.sha256)
      await fs.promises.rename(staged, original)
    } else {
      // An atomic no-clobber creation also protects files that appeared after the preflight.
      await fs.promises.link(staged, original)
      await fs.promises.unlink(staged).catch(() => {})
    }
    committed = true
    const restoredAt = new Date().toISOString()
    try { await updatePoint(point, { status: 'restored', restoredAt }) } catch (error) {
      console.error('压缩包已恢复，恢复点状态更新失败：', error)
    }
    return { success: true, restoredPath: original, recoveryId: id, previousRecoveryId: previous?.record.id || null, restoredAt }
  } finally {
    if (!committed && stagedCreated) await fs.promises.unlink(staged).catch(() => {})
  }
}

module.exports = { createArchiveRecoveryPoint, editArchiveSafely, listArchiveRecoveryPoints, restoreArchiveRecoveryPoint }
