'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')

const appDir = path.resolve(__dirname, '../resources/app')
const appRequire = createRequire(path.join(appDir, 'package.json'))
const { createRawRecoveryPoint } = appRequire('./modules/raw_recovery')
const transaction = appRequire('./modules/restore_transaction')
const artifacts = path.join(__dirname, '.artifacts', 'raw-recovery')
fs.mkdirSync(artifacts, { recursive: true })
const fixtureRoot = fs.mkdtempSync(path.join(artifacts, 'run-'))
const report = { date: new Date().toISOString(), fixtureRoot, checks: [], errors: [] }
const pass = name => { report.checks.push(name); console.log('PASS ' + name) }
const digest = value => createHash('sha256').update(value).digest('hex')
const fileHash = filename => digest(fs.readFileSync(filename))

function loadRaw(overrides) {
  const filename = path.join(appDir, 'modules/raw_recovery.js')
  const nativeRequire = createRequire(filename)
  const context = { module: { exports: {} }, console, Buffer,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : nativeRequire(name) }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename })
  return context.module.exports.createRawRecoveryPoint
}

function makeFixture(name, external = true) {
  const storePath = path.join(fixtureRoot, name)
  fs.mkdirSync(path.join(storePath, 'cover', 'nested'), { recursive: true })
  fs.mkdirSync(path.join(storePath, 'cover', 'empty'))
  fs.mkdirSync(path.join(storePath, '.reading-room'))
  const metadataPath = external ? path.join(fixtureRoot, name + '-active-metadata', 'metadata.sqlite') : path.join(storePath, 'metadata.sqlite')
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true })
  const expected = new Map()
  const add = (relative, source, bytes) => { fs.writeFileSync(source, bytes); expected.set(relative, source) }
  add('database.sqlite', path.join(storePath, 'database.sqlite'), Buffer.from('broken SQLite main file\0\xff', 'binary'))
  for (const suffix of ['-wal', '-shm', '-journal']) {
    add('database.sqlite' + suffix, path.join(storePath, 'database.sqlite' + suffix), Buffer.from('damaged main sidecar ' + suffix))
  }
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    add('metadata.sqlite' + suffix, metadataPath + suffix, Buffer.from('damaged active metadata ' + suffix))
    if (external) add('inactive-metadata/metadata.sqlite' + suffix, path.join(storePath, 'metadata.sqlite' + suffix), Buffer.from('inactive local metadata ' + suffix))
  }
  for (const [name, bytes] of [
    ['setting.json', '{"library":'], ['collectionList.json', 'not JSON'],
    ['reading-state.json', '{"invalid":'], ['ui-state.json', '\ufeff{broken'],
    ['.reading-room/window-state.json', '{window-size'],
    ['cover/neutral.webp', 'neutral damaged image bytes'],
    ['cover/nested/custom.data', 'an unrecognized file in cover must also survive'],
  ]) add(name, path.join(storePath, name), Buffer.from(bytes))
  const excluded = path.join(storePath, '.reading-room', 'Cookies')
  fs.writeFileSync(excluded, 'synthetic browser cache: not part of raw recovery')
  return { storePath, metadataPath, expected, excluded }
}

function snapshotSources(spec) {
  return new Map([...new Set([...spec.expected.values(), spec.excluded])].map(filename => [filename, fileHash(filename)]))
}

function assertSourcesUnchanged(snapshot) {
  for (const [filename, hash] of snapshot) assert.equal(fileHash(filename), hash, 'source changed: ' + filename)
}

function rawDirectories(storePath) {
  const directory = path.join(storePath, '.data-protection', 'restore-points')
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => name.startsWith('raw-')).sort() : []
}

function assertNoStaging(storePath) {
  const directory = path.join(storePath, '.data-protection')
  if (fs.existsSync(directory)) assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('stage-')).length, 0)
}

async function completeCopyCheck() {
  const spec = makeFixture('complete')
  const sourceHashes = snapshotSources(spec)
  const result = await createRawRecoveryPoint(spec)
  assert.equal(result.success, true)
  assert.equal(result.raw, true)
  assert.equal(path.dirname(result.path), path.join(spec.storePath, '.data-protection', 'restore-points'))
  assert(path.basename(result.path).startsWith('raw-'))
  const manifestBytes = fs.readFileSync(path.join(result.path, 'manifest.json'))
  const manifest = JSON.parse(manifestBytes)
  const complete = JSON.parse(fs.readFileSync(path.join(result.path, 'COMPLETE.json'), 'utf8'))
  assert.equal(manifest.format, 'yanruyu-raw-recovery')
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.activeMetadataPath, spec.metadataPath)
  assert.equal(complete.id, manifest.id)
  assert.equal(complete.manifestSha256, digest(manifestBytes))
  assert.equal(manifest.files.length, spec.expected.size)
  let bytes = 0
  for (const file of manifest.files) {
    const source = spec.expected.get(file.name)
    assert(source, 'unexpected source: ' + file.name)
    assert.equal(file.source, source)
    assert.equal(file.sha256, sourceHashes.get(source))
    const copied = path.join(result.path, 'files', file.name)
    assert.equal(fileHash(copied), file.sha256)
    assert.equal(fs.statSync(copied).size, file.size)
    bytes += file.size
  }
  assert.equal(bytes, manifest.totalBytes)
  assert(fs.statSync(path.join(result.path, 'files', 'cover', 'empty')).isDirectory())
  assert(!fs.existsSync(path.join(result.path, 'files', '.reading-room', 'Cookies')))
  assertSourcesUnchanged(sourceHashes)
  assertNoStaging(spec.storePath)
  const firstManifestHash = fileHash(path.join(result.path, 'manifest.json'))
  const second = await createRawRecoveryPoint(spec)
  assert.notEqual(second.path, result.path)
  assert.equal(fileHash(path.join(result.path, 'manifest.json')), firstManifestHash)
  pass('Damaged main and external metadata, all sidecars, raw JSON, empty/nested covers and inactive local metadata are preserved byte-for-byte')
  pass('Recovery manifests are hashed, completion-marked and published uniquely without overwriting earlier points')
}

async function missingAndStreamingChecks() {
  const missing = makeFixture('missing', false)
  const removed = missing.expected.get('database.sqlite')
  assert(path.relative(fixtureRoot, removed).startsWith('missing' + path.sep))
  fs.unlinkSync(removed)
  missing.expected.delete('database.sqlite')
  const sourceHashes = snapshotSources(missing)
  const result = await createRawRecoveryPoint(missing)
  const manifest = JSON.parse(fs.readFileSync(path.join(result.path, 'manifest.json'), 'utf8'))
  assert(manifest.missing.some(entry => entry.name === 'database.sqlite' && entry.source === removed))
  assert(manifest.files.some(entry => entry.name === 'database.sqlite-wal'))
  assert(!fs.existsSync(removed))
  assertSourcesUnchanged(sourceHashes)
  pass('A missing database is recorded as missing while its surviving sidecars are preserved without creating or repairing the source')

  const streaming = makeFixture('streaming', false)
  const large = path.join(streaming.storePath, 'cover', 'large-neutral.data')
  const fd = fs.openSync(large, 'wx')
  try {
    const chunk = Buffer.alloc(1024 * 1024, 0x6e)
    for (let index = 0; index < 8; index++) fs.writeSync(fd, chunk)
  } finally { fs.closeSync(fd) }
  streaming.expected.set('cover/large-neutral.data', large)
  const streams = [], synced = [], durable = []
  const streamingFs = { ...fs,
    readFileSync: () => { throw new Error('raw recovery must not read a complete payload into memory') },
    createReadStream: (...args) => { streams.push(args[0]); return fs.createReadStream(...args) },
    promises: { ...fs.promises,
      readFile: async () => { throw new Error('raw recovery must not read a complete payload into memory') },
      open: async (filename, flags) => {
        const handle = await fs.promises.open(filename, flags)
        return { sync: async () => { synced.push(filename); return handle.sync() }, close: () => handle.close() }
      },
    },
  }
  const invoke = loadRaw({ fs: streamingFs, './restore_transaction': { ...transaction, writeDurable: (filename, value) => {
    durable.push(filename)
    return transaction.writeDurable(filename, value)
  } } })
  const copied = await invoke(streaming)
  const copiedManifest = JSON.parse(fs.readFileSync(path.join(copied.path, 'manifest.json'), 'utf8'))
  assert.equal(fileHash(path.join(copied.path, 'files', 'cover', 'large-neutral.data')), fileHash(large))
  assert.equal(synced.filter(filename => filename.includes(path.sep + 'files' + path.sep)).length, copiedManifest.files.length)
  assert.equal(durable.length, 2)
  assert(streams.includes(large))
  assert(synced.includes(path.join(copied.path, 'COMPLETE.json')))
  pass('Payloads use streaming hashes and filesystem copying with no whole-file reads; every copied file and both manifests are explicitly flushed')
}

async function copyFailureChecks() {
  for (const [name, code, failAt] of [['no-space', 'ENOSPC', 2], ['denied', 'EACCES', 1]]) {
    const spec = makeFixture(name)
    const before = snapshotSources(spec)
    const preserved = await createRawRecoveryPoint(spec)
    const existing = rawDirectories(spec.storePath)
    let copies = 0
    const failedFs = { ...fs, promises: { ...fs.promises, copyFile: async (...args) => {
      if (++copies === failAt) throw Object.assign(new Error('simulated ' + code), { code })
      return fs.promises.copyFile(...args)
    } } }
    await assert.rejects(loadRaw({ fs: failedFs })(spec), new RegExp('未修改原数据.*' + code))
    assertSourcesUnchanged(before)
    assert.deepEqual(rawDirectories(spec.storePath), existing)
    assert(fs.existsSync(path.join(preserved.path, 'COMPLETE.json')))
    assertNoStaging(spec.storePath)
  }
  pass('Disk-space and permission failures stop recovery, preserve all source bytes and existing completed points, and clean only the new stage')

  const corrupted = makeFixture('copy-corruption')
  const before = snapshotSources(corrupted)
  const corruptFs = { ...fs, promises: { ...fs.promises, copyFile: async (source, destination, flags) => {
    await fs.promises.copyFile(source, destination, flags)
    if (path.basename(source) === 'database.sqlite') await fs.promises.appendFile(destination, 'copy-corruption')
  } } }
  await assert.rejects(loadRaw({ fs: corruptFs })(corrupted), /复制校验失败/)
  assertSourcesUnchanged(before)
  assert.deepEqual(rawDirectories(corrupted.storePath), [])
  assertNoStaging(corrupted.storePath)
  pass('Corrupted copy bytes fail size/SHA256 checks and are never published as a complete recovery point')
}

async function linkAndCompletionChecks() {
  const spec = makeFixture('linked-cover')
  const outside = path.join(fixtureRoot, 'outside-cover')
  fs.mkdirSync(outside)
  const keep = path.join(outside, 'keep.txt')
  fs.writeFileSync(keep, 'neutral external data must remain untouched')
  fs.symlinkSync(outside, path.join(spec.storePath, 'cover', 'linked-directory'), 'junction')
  const sourceHashes = snapshotSources(spec)
  await assert.rejects(createRawRecoveryPoint(spec), /链接|联接/)
  assert.equal(fs.readFileSync(keep, 'utf8'), 'neutral external data must remain untouched')
  assertSourcesUnchanged(sourceHashes)
  assert.deepEqual(rawDirectories(spec.storePath), [])
  await assert.rejects(createRawRecoveryPoint({ storePath: 'relative-path' }), /绝对路径/)
  pass('Relative paths and cover-directory junctions are rejected before copying; external data is never followed or removed')

  const incomplete = makeFixture('marker-failure', false)
  const before = snapshotSources(incomplete)
  const failMarker = loadRaw({ './restore_transaction': { ...transaction, writeDurable: (filename, value) => {
    if (path.basename(filename) === 'COMPLETE.json') throw new Error('simulated completion marker failure')
    return transaction.writeDurable(filename, value)
  } } })
  await assert.rejects(failMarker(incomplete), /completion marker failure/)
  assertSourcesUnchanged(before)
  assert.deepEqual(rawDirectories(incomplete.storePath), [])
  assertNoStaging(incomplete.storePath)
  pass('A completion-marker write failure cannot return success or publish an incomplete directory')

  const flushFailed = makeFixture('published-flush-failure', false)
  const beforeFlush = snapshotSources(flushFailed)
  const fsyncFailure = { ...fs, promises: { ...fs.promises, open: async (filename, flags) => {
    const handle = await fs.promises.open(filename, flags)
    return {
      sync: async () => {
        if (filename.includes(path.sep + 'restore-points' + path.sep) && path.basename(filename) === 'COMPLETE.json') throw new Error('simulated final marker flush failure')
        return handle.sync()
      },
      close: () => handle.close(),
    }
  } } }
  let failure
  try { await loadRaw({ fs: fsyncFailure })(flushFailed) } catch (error) { failure = error }
  assert(failure)
  assert.match(failure.message, /final marker flush failure/)
  assert(failure.recoveryPath)
  assert(fs.existsSync(path.join(failure.recoveryPath, 'manifest.json')))
  assert(fs.existsSync(path.join(failure.recoveryPath, 'files', 'database.sqlite')))
  assertSourcesUnchanged(beforeFlush)
  pass('A failure after publishing still stops recovery and retains the published bytes for inspection')
}

;(async () => {
  try {
    await completeCopyCheck()
    await missingAndStreamingChecks()
    await copyFailureChecks()
    await linkAndCompletionChecks()
  } catch (error) {
    report.errors.push(error.stack || error.message)
    throw error
  } finally {
    fs.writeFileSync(path.join(artifacts, 'checks.json'), JSON.stringify(report, null, 2))
    fs.writeFileSync(path.join(fixtureRoot, 'checks.json'), JSON.stringify(report, null, 2))
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
