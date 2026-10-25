'use strict'

const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

const DATA_FILES = [
  'database.sqlite', 'metadata.sqlite', 'setting.json', 'collectionList.json',
  'reading-state.json', 'ui-state.json', 'library-organizer.json', 'local-search.json',
  '.reading-room/window-state.json', 'cover',
]
const SIDECARS = ['database.sqlite-wal', 'database.sqlite-shm', 'database.sqlite-journal',
  'metadata.sqlite-wal', 'metadata.sqlite-shm', 'metadata.sqlite-journal']
// A backup from before these features intentionally has no matching payload.
// Its restore removes newer state transactionally, while required files remain mandatory.
const OPTIONAL_FEATURE_FILES = new Set(['library-organizer.json', 'local-search.json'])
const ALLOWED_TARGETS = new Set([...DATA_FILES, ...SIDECARS])
const CONTROL_DIR = '.data-protection'
const JOURNAL_NAME = 'restore-journal.json'

function exists(target) {
  try { fs.lstatSync(target); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}

function assertLocalPath(storePath, target) {
  const root = path.resolve(storePath)
  const relative = path.relative(root, path.resolve(target))
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('恢复目标不在当前数据目录内')
  let current = root
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part)
    if (exists(current) && fs.lstatSync(current).isSymbolicLink()) throw new Error('恢复目录不能使用链接或目录联接')
  }
  return target
}

function controlPath(storePath) {
  const target = assertLocalPath(storePath, path.join(storePath, CONTROL_DIR))
  fs.mkdirSync(target, { recursive: true })
  return target
}

function ownedWorkPath(storePath, value, prefix) {
  const parent = controlPath(storePath)
  if (typeof value !== 'string' || path.dirname(path.resolve(value)) !== parent ||
      !new RegExp('^' + prefix + '-[a-f0-9-]{36}$').test(path.basename(value))) throw new Error('恢复工作目录无效')
  return assertLocalPath(storePath, value)
}

function removeWork(storePath, target, prefix) {
  ownedWorkPath(storePath, target, prefix)
  fs.rmSync(target, { recursive: true, force: true })
}

function writeDurable(target, value) {
  const temporary = target + '.' + randomUUID() + '.tmp'
  let descriptor
  try {
    descriptor = fs.openSync(temporary, 'wx')
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2))
    fs.fsyncSync(descriptor)
    fs.closeSync(descriptor)
    descriptor = undefined
    fs.renameSync(temporary, target)
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor)
    if (exists(temporary)) fs.unlinkSync(temporary)
  }
}

function validateJournal(storePath, journal) {
  if (!journal || journal.schemaVersion !== 1 || !['installing', 'committed'].includes(journal.phase) ||
      !Array.isArray(journal.entries) || journal.entries.length > ALLOWED_TARGETS.size) throw new Error('恢复日志损坏，请保留数据目录并使用恢复点')
  ownedWorkPath(storePath, journal.stageRoot, 'stage')
  ownedWorkPath(storePath, journal.rollbackRoot, 'rollback')
  const names = new Set()
  for (const entry of journal.entries) {
    if (!entry || !ALLOWED_TARGETS.has(entry.name) || names.has(entry.name) || typeof entry.beforeExists !== 'boolean') throw new Error('恢复日志中的文件清单无效')
    names.add(entry.name)
    assertLocalPath(storePath, path.join(storePath, entry.name))
    assertLocalPath(storePath, path.join(journal.rollbackRoot, entry.name))
  }
  return journal
}

// Runs before settings or SQLite connections are opened. If power is lost between
// two renames, the journal and the presence of the original determine rollback.
function recoverPendingRestoreSync(storePath) {
  const journalPath = path.join(controlPath(storePath), JOURNAL_NAME)
  if (!exists(journalPath)) return { recovered: false }
  const journal = validateJournal(storePath, JSON.parse(fs.readFileSync(journalPath, 'utf8')))
  if (journal.phase === 'installing') {
    for (const entry of [...journal.entries].reverse()) {
      const target = assertLocalPath(storePath, path.join(storePath, entry.name))
      const original = assertLocalPath(storePath, path.join(journal.rollbackRoot, entry.name))
      if (entry.beforeExists && exists(original)) {
        if (exists(target)) fs.rmSync(target, { recursive: entry.name === 'cover', force: true })
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.renameSync(original, target)
      } else if (!entry.beforeExists && exists(target)) {
        fs.rmSync(target, { recursive: entry.name === 'cover', force: true })
      }
    }
  }
  // Remove the journal only after every original has been put back (or after a
  // durable committed marker). Leftover private work folders are safe to retry.
  fs.unlinkSync(journalPath)
  removeWork(storePath, journal.rollbackRoot, 'rollback')
  removeWork(storePath, journal.stageRoot, 'stage')
  return { recovered: journal.phase === 'installing', completed: journal.phase === 'committed' }
}

function createStage(storePath) {
  const stage = path.join(controlPath(storePath), 'stage-' + randomUUID())
  fs.mkdirSync(stage)
  return stage
}

function syncStagedFiles(storePath, target) {
  assertLocalPath(storePath, target)
  const stat = fs.lstatSync(target)
  if (stat.isSymbolicLink()) throw new Error('恢复暂存内容不能包含链接')
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) syncStagedFiles(storePath, path.join(target, name))
  } else if (stat.isFile()) {
    const descriptor = fs.openSync(target, 'r+')
    try { fs.fsyncSync(descriptor) } finally { fs.closeSync(descriptor) }
  } else throw new Error('恢复暂存内容必须是普通文件')
}

async function commitPreparedRestore({ storePath, stageRoot, names, beforeCommit, onRollback, afterInstall }) {
  ownedWorkPath(storePath, stageRoot, 'stage')
  if (exists(path.join(controlPath(storePath), JOURNAL_NAME))) throw new Error('存在尚未完成的恢复，请重新启动以完成回滚')
  if (!Array.isArray(names) || new Set(names).size !== names.length || names.some(name => !ALLOWED_TARGETS.has(name))) throw new Error('恢复文件清单无效')
  const rollbackRoot = path.join(controlPath(storePath), 'rollback-' + randomUUID())
  let paused = false
  let committed = false
  try {
    paused = true
    await beforeCommit?.()
    // Flush every payload (including covers and SQLite edits) before the durable
    // journal can declare a commit and discard the original files.
    syncStagedFiles(storePath, stageRoot)
    fs.mkdirSync(rollbackRoot)
    const entries = names.map(name => {
      const target = assertLocalPath(storePath, path.join(storePath, name))
      const staged = assertLocalPath(storePath, path.join(stageRoot, name))
      if (!SIDECARS.includes(name) && !OPTIONAL_FEATURE_FILES.has(name) && !exists(staged)) throw new Error('恢复暂存文件缺失')
      if (exists(target) && (fs.lstatSync(target).isDirectory() !== (name === 'cover'))) throw new Error('恢复目标类型不正确')
      return { name, beforeExists: exists(target) }
    })
    const journalPath = path.join(controlPath(storePath), JOURNAL_NAME)
    const journal = { schemaVersion: 1, phase: 'installing', stageRoot, rollbackRoot, entries }
    writeDurable(journalPath, journal)
    for (const entry of entries) {
      const target = assertLocalPath(storePath, path.join(storePath, entry.name))
      const original = assertLocalPath(storePath, path.join(rollbackRoot, entry.name))
      const staged = assertLocalPath(storePath, path.join(stageRoot, entry.name))
      fs.mkdirSync(path.dirname(original), { recursive: true })
      fs.mkdirSync(path.dirname(target), { recursive: true })
      if (entry.beforeExists) fs.renameSync(target, original)
      if (!SIDECARS.includes(entry.name) && (!OPTIONAL_FEATURE_FILES.has(entry.name) || exists(staged))) fs.renameSync(staged, target)
      await afterInstall?.(entry.name)
    }
    writeDurable(journalPath, { ...journal, phase: 'committed' })
    committed = true
    try { recoverPendingRestoreSync(storePath) } catch { return { success: true, cleanupPending: true } }
    return { success: true }
  } catch (error) {
    if (!committed) {
      try {
        recoverPendingRestoreSync(storePath)
        if (exists(rollbackRoot)) removeWork(storePath, rollbackRoot, 'rollback')
        if (exists(stageRoot)) removeWork(storePath, stageRoot, 'stage')
      } catch (rollbackError) {
        const failure = new Error('恢复失败，回滚尚未完成。请重新启动程序完成回滚：' + rollbackError.message)
        failure.rollbackFailed = true
        failure.cause = error
        throw failure
      }
      if (paused) await onRollback?.()
    }
    throw error
  }
}

module.exports = { DATA_FILES, SIDECARS, assertLocalPath, controlPath, createStage, removeWork,
  writeDurable, recoverPendingRestoreSync, commitPreparedRestore }
