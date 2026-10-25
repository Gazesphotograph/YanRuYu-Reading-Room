'use strict'

const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')
const { DATA_FILES, SIDECARS, assertLocalPath, controlPath, createStage, removeWork, writeDurable } = require('./restore_transaction')

const FORMAT = 'yanruyu-raw-recovery'
const SQLITE_SUFFIXES = ['', '-wal', '-shm', '-journal']

async function lstatOrMissing(filename) {
  try { return await fs.promises.lstat(filename) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function assertAbsoluteSource(filename) {
  if (typeof filename !== 'string' || !filename || !path.isAbsolute(filename)) throw new Error('原始恢复点的来源路径必须是绝对路径')
  const absolute = path.resolve(filename)
  // Check ancestors too, including an external active metadata directory. A raw
  // snapshot must never follow a file link or a directory junction unexpectedly.
  assertLocalPath(path.parse(absolute).root, absolute)
  return absolute
}

function sameStat(expected, actual) {
  return actual && expected.isFile() === actual.isFile() && expected.isDirectory() === actual.isDirectory() &&
    expected.size === actual.size && expected.mtimeMs === actual.mtimeMs && expected.ctimeMs === actual.ctimeMs &&
    expected.ino === actual.ino && expected.dev === actual.dev
}

async function sha256(filename) {
  const hash = createHash('sha256')
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk)
  return hash.digest('hex')
}

async function syncFile(filename) {
  const handle = await fs.promises.open(filename, 'r+')
  try { await handle.sync() } finally { await handle.close() }
}

async function inventorySource(storePath, metadataPath) {
  const entries = [], directories = [], missing = []
  const collect = async (name, source, expectedType) => {
    assertAbsoluteSource(source)
    const stat = await lstatOrMissing(source)
    if (!stat) { missing.push({ name, source }); return }
    if (stat.isSymbolicLink()) throw new Error('原始恢复点不支持链接：' + source)
    if (expectedType === 'directory') {
      if (!stat.isDirectory()) throw new Error('原始恢复点的目录类型不正确：' + source)
      const children = (await fs.promises.readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
      directories.push({ name, source, stat, children: children.map(child => child.name) })
      for (const child of children) {
        if (child.isSymbolicLink() || (!child.isFile() && !child.isDirectory())) throw new Error('原始恢复点中存在链接或特殊文件：' + path.join(source, child.name))
        await collect(name + '/' + child.name, path.join(source, child.name), child.isDirectory() ? 'directory' : 'file')
      }
    } else {
      if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error('原始恢复点的文件类型或大小不正确：' + source)
      entries.push({ name, source, stat })
    }
  }

  for (const name of [...DATA_FILES, ...SIDECARS].filter(name => !name.startsWith('metadata.sqlite'))) {
    await collect(name, assertLocalPath(storePath, path.join(storePath, name)), name === 'cover' ? 'directory' : 'file')
  }
  for (const suffix of SQLITE_SUFFIXES) await collect('metadata.sqlite' + suffix, metadataPath + suffix, 'file')

  // Restoring into the local store also replaces an old, currently inactive local
  // metadata database. Preserve that file independently when the active one is external.
  const localMetadata = path.join(storePath, 'metadata.sqlite')
  if (path.relative(localMetadata, metadataPath) !== '') {
    for (const suffix of SQLITE_SUFFIXES) await collect('inactive-metadata/metadata.sqlite' + suffix, localMetadata + suffix, 'file')
  }
  return { entries, directories, missing }
}

async function assertInventoryUnchanged(inventory) {
  for (const entry of inventory.entries) {
    assertAbsoluteSource(entry.source)
    if (!sameStat(entry.stat, await lstatOrMissing(entry.source))) throw new Error('原数据在复制期间发生变化：' + entry.source)
  }
  for (const directory of inventory.directories) {
    assertAbsoluteSource(directory.source)
    const stat = await lstatOrMissing(directory.source)
    if (!sameStat(directory.stat, stat)) throw new Error('原目录在复制期间发生变化：' + directory.source)
    const children = (await fs.promises.readdir(directory.source)).sort((a, b) => a.localeCompare(b))
    if (JSON.stringify(children) !== JSON.stringify(directory.children)) throw new Error('原目录内容在复制期间发生变化：' + directory.source)
  }
  for (const missing of inventory.missing) {
    assertAbsoluteSource(missing.source)
    if (await lstatOrMissing(missing.source)) throw new Error('原来缺失的数据在复制期间出现：' + missing.source)
  }
}

// The caller must first close SQLite connections and pause all application
// writes. These files are copied as bytes: no parser, database repair or schema
// validation is allowed to modify or discard the damaged source data.
async function createRawRecoveryPoint({ storePath, metadataPath } = {}) {
  storePath = assertAbsoluteSource(storePath)
  const storeStat = await lstatOrMissing(storePath)
  if (!storeStat?.isDirectory() || storeStat.isSymbolicLink()) throw new Error('原始恢复点的数据目录不可用')
  metadataPath = assertAbsoluteSource(metadataPath || path.join(storePath, 'metadata.sqlite'))

  const inventory = await inventorySource(storePath, metadataPath)
  const recoveryDirectory = assertLocalPath(storePath, path.join(controlPath(storePath), 'restore-points'))
  await fs.promises.mkdir(recoveryDirectory, { recursive: true })
  const stageRoot = createStage(storePath)
  const id = randomUUID()
  const createdAt = new Date().toISOString()
  const finalPath = assertLocalPath(storePath, path.join(recoveryDirectory, 'raw-' + createdAt.replace(/[:.]/g, '-') + '-' + id))
  let published = false
  try {
    const payloadRoot = assertLocalPath(storePath, path.join(stageRoot, 'files'))
    await fs.promises.mkdir(payloadRoot)
    for (const directory of inventory.directories) {
      const destination = assertLocalPath(storePath, path.join(payloadRoot, directory.name))
      await fs.promises.mkdir(destination, { recursive: true })
    }
    const files = []
    let totalBytes = 0
    for (const entry of inventory.entries) {
      assertAbsoluteSource(entry.source)
      if (!sameStat(entry.stat, await lstatOrMissing(entry.source))) throw new Error('原文件在复制前发生变化：' + entry.source)
      const destination = assertLocalPath(storePath, path.join(payloadRoot, entry.name))
      await fs.promises.mkdir(path.dirname(destination), { recursive: true })
      await fs.promises.copyFile(entry.source, destination, fs.constants.COPYFILE_EXCL)
      await syncFile(destination)
      const [sourceHash, copiedHash] = await Promise.all([sha256(entry.source), sha256(destination)])
      const copiedStat = await fs.promises.lstat(destination)
      if (sourceHash !== copiedHash || copiedStat.size !== entry.stat.size || !sameStat(entry.stat, await lstatOrMissing(entry.source))) {
        throw new Error('原始恢复点的复制校验失败：' + entry.source)
      }
      files.push({ name: entry.name, source: entry.source, size: copiedStat.size, sha256: copiedHash, sourceMtimeMs: entry.stat.mtimeMs })
      totalBytes += copiedStat.size
      if (!Number.isSafeInteger(totalBytes)) throw new Error('原始恢复点的累计文件大小无法安全表示')
    }
    await assertInventoryUnchanged(inventory)
    const completedAt = new Date().toISOString()
    const manifest = {
      format: FORMAT,
      schemaVersion: 1,
      id,
      raw: true,
      status: 'complete',
      createdAt,
      completedAt,
      sourceStorePath: storePath,
      activeMetadataPath: metadataPath,
      files,
      directories: inventory.directories.map(directory => ({ name: directory.name, source: directory.source })),
      missing: inventory.missing,
      totalBytes,
      note: '恢复前保存的原始字节，可能包含损坏数据。请保留同一数据库的全部 sidecar；此目录不是可直接导入的 .yru-backup 文件。',
    }
    const manifestPath = path.join(stageRoot, 'manifest.json')
    writeDurable(manifestPath, manifest)
    writeDurable(path.join(stageRoot, 'COMPLETE.json'), { format: FORMAT, schemaVersion: 1, id, completedAt, manifestSha256: await sha256(manifestPath) })
    if (await lstatOrMissing(finalPath)) throw new Error('同名原始恢复点已存在')
    await fs.promises.rename(stageRoot, finalPath)
    published = true
    // Flush the completion marker again after publishing the directory. A marker
    // flush failure is an error, and the published copy is retained for inspection.
    await syncFile(path.join(finalPath, 'COMPLETE.json'))
    return { success: true, path: finalPath, raw: true }
  } catch (error) {
    let cleanupError
    if (!published) {
      try { removeWork(storePath, stageRoot, 'stage') } catch (failure) { cleanupError = failure }
    }
    const failure = new Error(`无法创建原始恢复点，已停止恢复且未修改原数据：${error.message}${cleanupError ? '；暂存目录清理失败：' + cleanupError.message : ''}`, { cause: error })
    if (published) failure.recoveryPath = finalPath
    throw failure
  }
}

module.exports = { FORMAT, createRawRecoveryPoint }
