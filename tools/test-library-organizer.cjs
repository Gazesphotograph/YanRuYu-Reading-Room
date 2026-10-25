'use strict'

// Real SQLite + short neutral fixtures in an owned OS temporary directory.
// No test reads or writes the portable user's database, covers, or manga.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { prepareMangaModel, prepareMetadataModel } = require('../resources/app/modules/database')
const { createReadingStateStore, writeAtomic } = require('../resources/app/modules/reading_state')
const { createLibraryOrganizer, validateOrganizerState } = require('../resources/app/modules/library_organizer')
const { fingerprintBook, mergeRebuiltBook } = require('../resources/app/modules/library_identity')
const { sourceSignature } = require('../resources/app/modules/source_signature')
const { serialQueue } = require('../resources/app/modules/safety')

async function fixture(t) {
  const prefix = path.join(os.tmpdir(), 'yanruyu-organizer-')
  const directory = await fs.mkdtemp(prefix), library = path.join(directory, 'library')
  await fs.mkdir(library)
  const Manga = prepareMangaModel(path.join(directory, 'database.sqlite'))
  const Metadata = prepareMetadataModel(path.join(directory, 'metadata.sqlite'))
  await Manga.sync(); await Metadata.sync()
  const readingState = createReadingStateStore({ storePath: directory })
  let collections = [], counter = 0, failCollections = false, failJournalPhase = ''
  const queue = serialQueue()
  const options = { storePath: directory, getManga: () => Manga, getMetadata: () => Metadata, readingState,
    getCollections: () => collections, libraryRoot: () => library, commit: queue,
    saveCollections: async value => {
      if (failCollections) { failCollections = false; throw new Error('simulated collection disk failure') }
      await writeAtomic(path.join(directory, 'collectionList.json'), value); collections = value
    },
    write: async (filename, value) => {
      if (failJournalPhase && value.operations.at(-1)?.status === failJournalPhase) { failJournalPhase = ''; throw new Error('simulated journal disk failure') }
      return writeAtomic(filename, value)
    }
  }
  const service = createLibraryOrganizer(options)
  await service.ready
  t.after(async () => {
    await service.flush().catch(() => {})
    await Promise.allSettled([Manga.sequelize.close(), Metadata.sequelize.close()])
    const resolved = path.resolve(directory), parent = path.resolve(os.tmpdir())
    if (path.dirname(resolved) !== parent || !resolved.startsWith(path.resolve(prefix))) throw new Error('Unsafe organizer fixture cleanup')
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const add = async (name, fields = {}, contents = ['neutral page one', 'neutral page two']) => {
    const id = 'book-' + (++counter), filepath = path.join(library, id)
    await fs.mkdir(filepath)
    for (let i = 0; i < contents.length; i++) await fs.writeFile(path.join(filepath, `${i + 1}.jpg`), contents[i])
    const book = { id, filepath, type: 'folder', title: name, hash: 'metadata-' + id,
      pageCount: contents.length, bundleSize: contents.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
      identityFingerprint: await fingerprintBook(filepath, 'folder'), sourceSignature: await sourceSignature(filepath, 'folder'),
      status: 'tagged', tags: { artist: ['First Author'], other: ['Original tag'] }, mark: false, readCount: 0, ...fields }
    await Manga.create(book)
    if (!await Metadata.findByPk(book.hash)) await Metadata.create(book)
    return (await Manga.findByPk(id)).toJSON()
  }
  return { directory, library, Manga, Metadata, readingState, service, options, add,
    collections: () => collections, setCollections: options.saveCollections,
    failCollections: () => { failCollections = true }, failJournal: phase => { failJournalPhase = phase } }
}
const row = async (model, id) => (await model.findByPk(id)).toJSON()

async function disconnectSource(f, book) {
  const oldRoot = path.join(f.directory, 'old-computer-' + book.id)
  const parkedRoot = path.join(f.directory, 'parked-' + book.id)
  const filepath = path.join(oldRoot, 'original-book')
  await fs.mkdir(oldRoot)
  await fs.rename(book.filepath, filepath)
  await f.Manga.update({ filepath }, { where: { id: book.id } })
  await fs.rename(oldRoot, parkedRoot)
  return { filepath, restore: () => fs.rename(parkedRoot, oldRoot) }
}

test('batch preview is read-only and persistent undo restores author tags and metadata after restart', async t => {
  const f = await fixture(t), a = await f.add('Alpha'), b = await f.add('Beta')
  await f.readingState.saveProgress(a.id, { page: 1, total: 2, time: 100 })
  const preview = await f.service.previewBatch({ bookIds: [a.id, b.id], tags: [{ namespace: 'artist', mode: 'rename', from: 'First Author', values: ['Correct Author'] }] })
  assert.equal(preview.changed, 2)
  assert.deepEqual((await row(f.Manga, a.id)).tags.artist, ['First Author'])
  await assert.rejects(fs.stat(f.service.filePath), { code: 'ENOENT' })
  const result = await f.service.apply(preview.token)
  assert.equal(result.status, 'applied')
  assert.deepEqual((await row(f.Manga, a.id)).tags, { artist: ['Correct Author'], other: ['Original tag'] })
  assert.deepEqual((await row(f.Metadata, a.hash)).tags.artist, ['Correct Author'])
  assert.equal((await f.readingState.load()).progress[a.id].page, 1)
  const restarted = createLibraryOrganizer(f.options); await restarted.ready
  assert.equal((await restarted.history()).length, 1)
  await restarted.undo(result.id)
  assert.deepEqual((await row(f.Manga, a.id)).tags, a.tags)
  assert.deepEqual((await row(f.Metadata, a.hash)).tags, a.tags)
  assert.equal((await restarted.history())[0].status, 'undone')
  assert.equal(await fs.readFile(path.join(a.filepath, '1.jpg'), 'utf8'), 'neutral page one')
})

test('preview and undo refuse later edits before changing any other selected book', async t => {
  const f = await fixture(t), a = await f.add('Alpha'), b = await f.add('Beta')
  const edit = { bookIds: [a.id, b.id], tags: [{ namespace: 'artist', mode: 'replace', values: ['Batch Author'] }] }
  const stale = await f.service.previewBatch(edit)
  await f.Manga.update({ tags: { artist: ['New User Author'] } }, { where: { id: a.id } })
  await assert.rejects(f.service.apply(stale.token), /预览后修改/)
  assert.deepEqual((await row(f.Manga, b.id)).tags, b.tags)
  const latest = await f.service.previewBatch(edit), applied = await f.service.apply(latest.token)
  await f.Manga.update({ tags: { artist: ['Post-apply edit'] } }, { where: { id: a.id } })
  await assert.rejects(f.service.undo(applied.id), /预览后修改/)
  assert.deepEqual((await row(f.Manga, a.id)).tags.artist, ['Post-apply edit'])
  assert.deepEqual((await row(f.Manga, b.id)).tags.artist, ['Batch Author'])
})

test('shared sampled metadata hashes never propagate one book edit to another', async t => {
  const f = await fixture(t), a = await f.add('Alpha', { hash: 'shared-cover-sample' }), b = await f.add('Different book', { hash: 'shared-cover-sample' }, ['same cover', 'different complete content'])
  const preview = await f.service.previewBatch({ bookIds: [a.id], tags: [{ namespace: 'artist', mode: 'replace', values: ['Independent Author'] }] })
  assert.ok(preview.warnings.some(message => message.includes('共享')))
  await f.service.apply(preview.token)
  assert.deepEqual((await row(f.Metadata, a.hash)).tags.artist, ['First Author'])
  assert.deepEqual((await row(f.Manga, a.id)).tags.artist, ['Independent Author'])
  assert.deepEqual((await row(f.Manga, b.id)).tags.artist, ['First Author'])
  assert.equal((await f.service.duplicates()).groupCount, 0, 'A shared sampled cover is not a duplicate signal')
})

test('merge previews keeper, progress, metadata and collections; preserves every identity and original file', async t => {
  const f = await fixture(t), a = await f.add('Keeper', { readCount: 2 }), b = await f.add('Source', { tags: { artist: ['Second Author'], other: ['Extra tag'] }, mark: true, readCount: 7 })
  await f.readingState.saveProgress(a.id, { page: 1, total: 2, time: 100, source: 'room' })
  await f.readingState.saveProgress(b.id, { page: 2, total: 2, time: 200, source: 'classic' })
  await f.readingState.savePreferences(b.id, { mode: 'double', direction: 'rtl' })
  const priorReading = await f.readingState.load()
  await f.setCollections([{ id: 'favorite-series', title: 'Original collection', list: [b.hash] }])
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id, progressSourceId: b.id })
  assert.equal(preview.exact, true)
  assert.equal(preview.keeper.id, a.id)
  assert.equal(preview.progress.after.page, 2)
  assert.ok(preview.metadata.after.tags.artist.includes('Second Author'))
  assert.deepEqual(f.collections()[0].list, [b.hash])
  const result = await f.service.apply(preview.token)
  assert.equal(await f.Manga.count(), 2)
  assert.equal((await row(f.Manga, b.id)).hiddenBook, true)
  assert.equal((await row(f.Manga, a.id)).mark, true)
  assert.equal((await row(f.Manga, a.id)).readCount, 7)
  assert.equal((await f.readingState.load()).progress[a.id].page, 2)
  assert.deepEqual((await f.readingState.load()).progress[b.id], priorReading.progress[b.id])
  assert.deepEqual((await f.readingState.load()).preferences[b.id], priorReading.preferences[b.id])
  assert.deepEqual(f.collections()[0].list, [b.hash, a.id], 'Add only one keeper reference so the classic manager does not count it twice')
  assert.equal(await fingerprintBook(a.filepath, 'folder'), a.identityFingerprint)
  assert.equal(await fingerprintBook(b.filepath, 'folder'), b.identityFingerprint)
  const rebuilt = mergeRebuiltBook(await row(f.Manga, b.id), { filepath: b.filepath, pageCount: 3, exist: true })
  await f.Manga.update(rebuilt, { where: { id: b.id } })
  assert.equal((await row(f.Manga, b.id)).hiddenBook, true, 'An incremental or rebuild scan retains the donor hidden flag')
  await f.service.undo(result.id)
  assert.equal((await row(f.Manga, b.id)).hiddenBook, false)
  assert.equal((await row(f.Manga, b.id)).pageCount, 3, 'Undo retains unrelated scan-derived fields')
  assert.deepEqual((await row(f.Manga, a.id)).tags, a.tags)
  assert.equal((await f.readingState.load()).progress[a.id].page, 1)
  assert.deepEqual(f.collections()[0].list, [b.hash])
})

test('new keeper progress can be undone to absence without touching donor preferences or archives', async t => {
  const f = await fixture(t), a = await f.add('Keeper'), b = await f.add('Source')
  await f.readingState.saveProgress(b.id, { page: 2, total: 2, time: 200 })
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id, progressSourceId: b.id })
  const applied = await f.service.apply(preview.token)
  assert.equal((await f.readingState.load()).progress[a.id].page, 2)
  await f.service.undo(applied.id)
  assert.equal((await f.readingState.load()).progress[a.id], undefined)
  assert.equal((await f.readingState.load()).progress[b.id].page, 2)
})

test('a verified live keeper can retain progress from an offline old source and undo restores all archives', async t => {
  const f = await fixture(t), keeper = await f.add('New folder title'), donor = await f.add('Old display title', { mark: true, readCount: 7 })
  const offline = await disconnectSource(f, donor)
  await f.readingState.saveProgress(donor.id, { page: 2, total: 2, time: 200, source: 'room' })
  await f.readingState.savePreferences(donor.id, { mode: 'double', direction: 'rtl' })
  const priorReading = await f.readingState.load()
  const original = await row(f.Manga, donor.id)
  const preview = await f.service.previewMerge({ bookIds: [donor.id, keeper.id], keeperId: keeper.id, progressSourceId: donor.id })
  assert.equal(preview.exact, true, 'The keeper is verified first even when selected last')
  assert.match(preview.evidence, /离线来源已保存/)
  assert.ok(preview.warnings.some(message => /旧路径当前缺失或离线/.test(message) && /已保存的完整 SHA-256/.test(message)))
  assert.equal(preview.fingerprints.find(item => item.id === donor.id).source, 'history')
  assert.deepEqual(await row(f.Manga, donor.id), original, 'A preview never relocates the retained old row')
  assert.deepEqual(await f.service.mergedSources(), {})
  const applied = await f.service.apply(preview.token)
  assert.equal(await f.Manga.count(), 2)
  assert.equal((await row(f.Manga, donor.id)).filepath, offline.filepath)
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, true)
  assert.equal((await row(f.Manga, keeper.id)).filepath, keeper.filepath)
  assert.equal((await row(f.Manga, keeper.id)).readCount, 7)
  assert.deepEqual((await f.readingState.load()).progress[keeper.id], priorReading.progress[donor.id])
  assert.deepEqual((await f.readingState.load()).progress[donor.id], priorReading.progress[donor.id])
  assert.deepEqual((await f.readingState.load()).preferences[donor.id], priorReading.preferences[donor.id])
  assert.deepEqual(await f.service.mergedSources(), { [donor.id]: { keeperId: keeper.id, sharedSource: false } })
  const restarted = createLibraryOrganizer(f.options); await restarted.ready
  assert.deepEqual(await restarted.mergedSources(), { [donor.id]: { keeperId: keeper.id, sharedSource: false } })
  await restarted.undo(applied.id)
  assert.deepEqual(await restarted.mergedSources(), {})
  assert.equal((await row(f.Manga, donor.id)).filepath, offline.filepath)
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
  assert.equal((await f.readingState.load()).progress[keeper.id], undefined)
  assert.deepEqual((await f.readingState.load()).progress[donor.id], priorReading.progress[donor.id])
  assert.deepEqual((await f.readingState.load()).preferences[donor.id], priorReading.preferences[donor.id])
  assert.equal(await fingerprintBook(keeper.filepath, 'folder'), keeper.identityFingerprint)
})

test('offline sources require their own valid matching full fingerprint and the keeper must be live', async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Offline source')
  await disconnectSource(f, donor)
  for (const identityFingerprint of [null, 'same-cover-sample', 'file-sha256-v1:' + 'a'.repeat(64)]) {
    await f.Manga.update({ identityFingerprint }, { where: { id: donor.id } })
    await assert.rejects(f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id }), /没有有效的完整内容指纹/)
  }
  await f.Manga.update({ identityFingerprint: 'folder-sha256-v1:' + 'a'.repeat(64) }, { where: { id: donor.id } })
  await assert.rejects(f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id }), /保存的完整指纹.*不一致/)
  await f.Manga.update({ identityFingerprint: donor.identityFingerprint }, { where: { id: donor.id } })
  await assert.rejects(f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: donor.id }), /无法完成完整校验/)
  assert.deepEqual(await f.service.mergedSources(), {})
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
})

for (const code of ['EACCES', 'EPERM', 'EIO', 'ELOOP', 'ENOTDIR']) test(`a ${code} old-source error cannot be treated as an offline historical match`, async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Offline source')
  const offline = await disconnectSource(f, donor), lstat = fs.lstat.bind(fs)
  t.mock.method(fs, 'lstat', async (filepath, ...options) => {
    if (filepath === offline.filepath) { const error = new Error('simulated ' + code); error.code = code; throw error }
    return lstat(filepath, ...options)
  })
  await assert.rejects(f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id }), new RegExp('simulated ' + code))
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
  assert.deepEqual(await f.service.mergedSources(), {})
})

test('dangling source links and linked parent folders cannot supply an offline historical match', async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Source')
  const linked = path.join(f.directory, 'dangling-source')
  await fs.symlink(path.join(f.directory, 'absent-target'), linked, process.platform === 'win32' ? 'junction' : 'dir')
  for (const filepath of [linked, path.join(linked, 'missing-book')]) {
    await f.Manga.update({ filepath }, { where: { id: donor.id } })
    await assert.rejects(f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id }), /链接/)
  }
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
})

for (const change of ['source-returned', 'fingerprint-changed', 'type-changed']) test(`an offline merge detects ${change} after preview before hiding any book`, async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Offline source')
  const offline = await disconnectSource(f, donor)
  await f.readingState.saveProgress(donor.id, { page: 2, total: 2, time: 200 })
  const preview = await f.service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id, progressSourceId: donor.id })
  if (change === 'source-returned') await offline.restore()
  else await f.Manga.update(change === 'fingerprint-changed'
    ? { identityFingerprint: 'folder-sha256-v1:' + 'a'.repeat(64) } : { type: 'zip' }, { where: { id: donor.id } })
  await assert.rejects(f.service.apply(preview.token), /预览后修改/)
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
  assert.equal((await f.readingState.load()).progress[keeper.id], undefined)
  assert.equal((await f.readingState.load()).progress[donor.id].page, 2)
  assert.deepEqual(await f.service.mergedSources(), {})
})

test('an offline source returning during the durable journal write aborts and rolls back the merge', async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Offline source')
  const offline = await disconnectSource(f, donor)
  await f.readingState.saveProgress(donor.id, { page: 2, total: 2, time: 200 })
  let restored = false
  const service = createLibraryOrganizer({ ...f.options, write: async (filename, value) => {
    await writeAtomic(filename, value)
    if (!restored && value.operations.at(-1)?.status === 'prepared') { restored = true; await offline.restore() }
  } })
  await service.ready
  const preview = await service.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id, progressSourceId: donor.id })
  await assert.rejects(service.apply(preview.token), /已回滚本次变更.*预览后修改/)
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, false)
  assert.equal((await f.readingState.load()).progress[keeper.id], undefined)
  assert.equal((await f.readingState.load()).progress[donor.id].page, 2)
  assert.equal((await service.history())[0].status, 'rolled-back')
  assert.deepEqual(await service.mergedSources(), {})
})

test('same-path explicit merges export only applied donor mappings, including an already hidden source, and undo removes them', async t => {
  const f = await fixture(t), keeper = await f.add('Keeper'), donor = await f.add('Hidden source', { hiddenBook: true })
  const unrelated = await f.add('Ordinary hidden book', { hiddenBook: true })
  await f.Manga.update({ filepath: keeper.filepath }, { where: { id: donor.id } })
  assert.deepEqual(await f.service.mergedSources(), {}, 'A plain hidden flag is not a merge relationship')
  const preview = await f.service.previewMerge({ bookIds: [donor.id, keeper.id], keeperId: keeper.id })
  assert.equal(preview.changed, 0, 'The explicit relationship is meaningful even if every field already matches')
  assert.deepEqual(await f.service.mergedSources(), {}, 'Prepared previews never hide a source from scanning')
  const applied = await f.service.apply(preview.token)
  assert.equal(applied.status, 'applied')
  assert.deepEqual(await f.options.commit(() => f.service.mergedSources()), { [donor.id]: { keeperId: keeper.id, sharedSource: true } }, 'Reading the mapping under the shared queue must not deadlock')
  const snapshot = await f.service.mergedSources(); snapshot[donor.id].keeperId = unrelated.id
  snapshot[unrelated.id] = { keeperId: keeper.id, sharedSource: false }
  assert.deepEqual(await f.service.mergedSources(), { [donor.id]: { keeperId: keeper.id, sharedSource: true } }, 'Callers cannot mutate the journal through the returned map')
  await f.service.undo(applied.id)
  assert.deepEqual(await f.service.mergedSources(), {})
  assert.equal((await row(f.Manga, donor.id)).filepath, keeper.filepath)
  assert.equal((await row(f.Manga, donor.id)).hiddenBook, true, 'Undo preserves its original hidden flag')
  assert.equal((await row(f.Manga, unrelated.id)).hiddenBook, true)
})

test('a later reading session blocks merge undo without partially unhiding donors', async t => {
  const f = await fixture(t), a = await f.add('Keeper'), b = await f.add('Source')
  await f.readingState.saveProgress(b.id, { page: 2, total: 2, time: 100 })
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id, progressSourceId: b.id })
  const applied = await f.service.apply(preview.token)
  await f.readingState.saveProgress(a.id, { page: 1, total: 2, time: 300 })
  await assert.rejects(f.service.undo(applied.id), /阅读进度.*预览后修改/)
  assert.equal((await row(f.Manga, b.id)).hiddenBook, true)
  assert.equal((await f.readingState.load()).progress[a.id].time, 300)
})

test('collection write failure rolls back both databases, keeper progress and donor visibility', async t => {
  const f = await fixture(t), a = await f.add('Keeper'), b = await f.add('Source', { tags: { artist: ['Donor Author'] } })
  await f.readingState.saveProgress(b.id, { page: 2, total: 2, time: 100 })
  await f.setCollections([{ id: 'c', title: 'C', list: [b.hash] }])
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id, progressSourceId: b.id })
  f.failCollections()
  await assert.rejects(f.service.apply(preview.token), /已回滚本次变更/)
  assert.deepEqual((await row(f.Manga, a.id)).tags, a.tags)
  assert.deepEqual((await row(f.Metadata, a.hash)).tags, a.tags)
  assert.equal((await row(f.Manga, b.id)).hiddenBook, false)
  assert.equal((await f.readingState.load()).progress[a.id], undefined)
  assert.deepEqual(f.collections()[0].list, [b.hash])
  assert.equal((await f.service.history())[0].status, 'rolled-back')
})

test('failure to finalize the durable journal also rolls all changes back', async t => {
  const f = await fixture(t), a = await f.add('Alpha')
  const preview = await f.service.previewBatch({ bookIds: [a.id], fields: { rating: 4.5 } })
  f.failJournal('applied')
  await assert.rejects(f.service.apply(preview.token), /已回滚本次变更/)
  assert.equal((await row(f.Manga, a.id)).rating, a.rating)
  assert.equal((await row(f.Metadata, a.hash)).rating, a.rating)
  assert.equal((await f.service.history())[0].status, 'rolled-back')
})

for (const stage of ['book', 'metadata']) test(`a failure inside the ${stage} transaction leaves no partially updated rows`, async t => {
  const f = await fixture(t), a = await f.add('Alpha'), b = await f.add('Beta')
  const target = stage === 'book' ? f.Manga : f.Metadata, method = stage === 'book' ? 'update' : 'upsert'
  const original = target[method]
  let writes = 0
  target[method] = async function (...args) {
    if (++writes === 2) throw new Error('simulated mid-transaction failure')
    return original.apply(this, args)
  }
  t.after(() => { target[method] = original })
  const preview = await f.service.previewBatch({ bookIds: [a.id, b.id], fields: { rating: 4.5 } })
  await assert.rejects(f.service.apply(preview.token), /已回滚本次变更/)
  for (const book of [a, b]) {
    assert.equal((await row(f.Manga, book.id)).rating, book.rating)
    assert.equal((await row(f.Metadata, book.hash)).rating, book.rating)
  }
  assert.equal((await f.service.history())[0].status, 'rolled-back')
})

test('startup rolls back a power-loss journal with only some stores installed', async t => {
  const f = await fixture(t), a = await f.add('Keeper'), b = await f.add('Source', { tags: { artist: ['Different Author'] } })
  await f.readingState.saveProgress(b.id, { page: 2, total: 2, time: 100 })
  await f.setCollections([{ id: 'c', title: 'C', list: [b.hash] }])
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id, progressSourceId: b.id })
  const result = await f.service.apply(preview.token)
  const journal = JSON.parse(await fs.readFile(f.service.filePath, 'utf8')), interrupted = journal.operations[0]
  await f.service.undo(result.id)
  // Simulated interrupted installation: the library transaction and reading
  // archive reached disk, but metadata and collections are still originals.
  for (const item of interrupted.changes.books) await f.Manga.update(item.after, { where: { id: item.id } })
  for (const item of interrupted.changes.progress) await f.readingState.applyOrganizerProgress(item.id, { expected: item.before, value: item.after })
  interrupted.status = 'prepared'
  await writeAtomic(f.service.filePath, journal)
  const restarted = createLibraryOrganizer({ ...f.options, readingState: createReadingStateStore({ storePath: f.directory }) })
  await restarted.ready
  assert.equal((await row(f.Manga, b.id)).hiddenBook, false)
  assert.deepEqual((await row(f.Manga, a.id)).tags, a.tags)
  assert.deepEqual((await row(f.Metadata, a.hash)).tags, a.tags)
  assert.deepEqual(f.collections()[0].list, [b.hash])
  assert.equal((await createReadingStateStore({ storePath: f.directory }).load()).progress[a.id], undefined)
  assert.equal((await restarted.history())[0].status, 'rolled-back')
})

test('health separates confirmed missing files from offline libraries and never changes records', async t => {
  const f = await fixture(t), a = await f.add('Present'), b = await f.add('Missing')
  const moved = path.join(f.directory, 'temporarily-moved')
  await fs.rename(b.filepath, moved)
  const report = await f.service.health()
  assert.equal(report.present, 1); assert.equal(report.missing, 1)
  assert.equal(report.issues[0].id, b.id); assert.equal(report.issues[0].canRelocate, true)
  assert.equal((await row(f.Manga, b.id)).exist, true, 'A report is read-only')
  const offline = createLibraryOrganizer({ ...f.options, libraryRoot: () => path.join(f.directory, 'offline-drive') })
  await offline.ready
  const unavailable = await offline.health()
  assert.equal(unavailable.libraryAvailable, false); assert.equal(unavailable.missing, 0); assert.equal(unavailable.unavailable, 2)
  assert.equal(await fingerprintBook(a.filepath, 'folder'), a.identityFingerprint)
})

test('duplicate clues require full fingerprints or title-plus-pages, and changed sources invalidate previews', async t => {
  const f = await fixture(t), a = await f.add('Alpha'), b = await f.add('Beta')
  const clues = await f.service.duplicates()
  assert.equal(clues.groupCount, 1); assert.equal(clues.groups[0].kind, 'exact-candidate')
  const preview = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id })
  await fs.writeFile(path.join(b.filepath, '2.jpg'), 'changed after preview')
  await assert.rejects(f.service.apply(preview.token), /书籍文件.*预览后修改/)
  assert.equal((await row(f.Manga, b.id)).hiddenBook, false)
  const different = await f.service.previewMerge({ bookIds: [a.id, b.id], keeperId: a.id })
  assert.equal(different.exact, false); assert.ok(different.warnings.some(message => message.includes('不同版本')))
})

test('reading compare-and-swap preserves a concurrent save and journal rejects source-field mutations', async t => {
  const f = await fixture(t), a = await f.add('Alpha')
  const original = { page: 1, total: 2, time: 100 }
  await f.readingState.saveProgress(a.id, original)
  const expected = (await f.readingState.load()).progress[a.id]
  await f.readingState.saveProgress(a.id, { page: 2, total: 2, time: 200 })
  await assert.rejects(f.readingState.applyOrganizerProgress(a.id, { expected, value: null }), /新进度已保留/)
  assert.equal((await f.readingState.load()).progress[a.id].page, 2)
  const preview = await f.service.previewBatch({ bookIds: [a.id], fields: { rating: 3 } })
  await f.service.apply(preview.token)
  const journal = JSON.parse(await fs.readFile(f.service.filePath, 'utf8'))
  assert.equal(validateOrganizerState(journal), journal)
  journal.operations[0].changes.books[0].before.filepath = 'arbitrary-old'
  journal.operations[0].changes.books[0].after.filepath = 'arbitrary-new'
  assert.throws(() => validateOrganizerState(journal), /不允许编辑的书目字段/)
})

const snapshot = value => JSON.parse(JSON.stringify(value))

test('removing one missing record preserves source files, shared metadata and reading archives; restart undo restores its exact row', async t => {
  const f = await fixture(t)
  const a = await f.add('Selected missing book', { mark: true, hiddenBook: true, readCount: 7, rating: 4.5, date: 100,
    coverPath: path.join(f.directory, 'retained-cover.jpg'), hash: 'shared-metadata' })
  const b = await f.add('Unselected missing book', { hash: 'shared-metadata' }), c = await f.add('Present book')
  await fs.writeFile(a.coverPath, 'retained cover')
  await f.readingState.saveProgress(a.id, { page: 2, total: 2, time: 100 })
  await f.readingState.savePreferences(a.id, { mode: 'double', direction: 'rtl' })
  await f.setCollections([{ id: 'retained-collection', title: 'My books', list: [a.id, a.hash, b.id] }])
  const savedReading = await f.readingState.load(), savedMetadata = snapshot(await row(f.Metadata, a.hash)), savedCollections = snapshot(f.collections())
  const parked = path.join(f.directory, 'parked-selected')
  await fs.rename(a.filepath, parked)
  await fs.rename(b.filepath, path.join(f.directory, 'parked-unselected'))
  const preview = await f.service.previewRemoveMissing({ bookIds: [a.id] })
  assert.equal(preview.kind, 'remove-missing'); assert.equal(preview.changed, 1); assert.equal(preview.selected, 1)
  assert.equal(preview.rows[0].status, 'missing'); assert.equal(preview.rows[0].filepath, a.filepath)
  for (const flag of ['sourceFilesUnchanged', 'readingArchivesRetained', 'metadataRetained', 'collectionsRetained']) assert.equal(preview[flag], true)
  assert.equal(await f.Manga.count(), 3, 'Preview never deletes a row')
  await assert.rejects(fs.stat(f.service.filePath), { code: 'ENOENT' })
  const removed = await f.service.apply(preview.token)
  assert.equal(removed.kind, 'remove-missing'); assert.equal(removed.changed, 1); assert.equal(removed.canUndo, true)
  assert.equal(await f.Manga.findByPk(a.id), null)
  assert.ok(await f.Manga.findByPk(b.id)); assert.ok(await f.Manga.findByPk(c.id))
  assert.deepEqual(snapshot(await row(f.Metadata, a.hash)), savedMetadata)
  assert.deepEqual(await f.readingState.load(), savedReading)
  assert.deepEqual(f.collections(), savedCollections)
  assert.equal(await fs.readFile(a.coverPath, 'utf8'), 'retained cover')
  assert.equal(await fs.readFile(path.join(parked, '1.jpg'), 'utf8'), 'neutral page one')
  await assert.rejects(f.service.apply(preview.token), /预览已失效/)
  const restarted = createLibraryOrganizer(f.options); await restarted.ready
  await restarted.undo(removed.id)
  assert.deepEqual(snapshot(await row(f.Manga, a.id)), snapshot(a), 'Every source, metadata, preference and timestamp field is restored')
  assert.equal((await restarted.history())[0].status, 'undone')
})

test('missing removal rechecks returned files and later row edits before changing any selected record', async t => {
  const f = await fixture(t), a = await f.add('Still missing'), b = await f.add('Returned book')
  const parkedA = path.join(f.directory, 'parked-a'), parkedB = path.join(f.directory, 'parked-b')
  await fs.rename(a.filepath, parkedA); await fs.rename(b.filepath, parkedB)
  const preview = await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })
  await fs.rename(parkedB, b.filepath)
  await assert.rejects(f.service.apply(preview.token), /已恢复访问.*重新检测/)
  assert.equal(await f.Manga.count(), 2)
  await assert.rejects(fs.stat(f.service.filePath), { code: 'ENOENT' })
  await fs.rename(b.filepath, parkedB)
  const edited = await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })
  await f.Manga.update({ title: 'A later user title' }, { where: { id: b.id } })
  await assert.rejects(f.service.apply(edited.token), /预览后修改/)
  assert.equal((await row(f.Manga, b.id)).title, 'A later user title')
  assert.ok(await f.Manga.findByPk(a.id))
})

test('a source returning while the removal journal is being saved is caught before the first delete', async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Returns during commit')
  const parkedA = path.join(f.directory, 'parked-a'), parkedB = path.join(f.directory, 'parked-b')
  await fs.rename(a.filepath, parkedA); await fs.rename(b.filepath, parkedB)
  const returningSource = createLibraryOrganizer({ ...f.options, write: async (filename, value) => {
    if (value.operations.at(-1)?.status === 'prepared') await fs.rename(parkedB, b.filepath)
    return f.options.write(filename, value)
  } })
  await returningSource.ready
  const preview = await returningSource.previewRemoveMissing({ bookIds: [a.id, b.id] })
  await assert.rejects(returningSource.apply(preview.token), /已回滚本次变更.*已恢复访问/)
  for (const book of [a, b]) assert.deepEqual(snapshot(await row(f.Manga, book.id)), snapshot(book))
  assert.equal((await returningSource.history())[0].status, 'rolled-back')
})

test('an offline library supports explicit record removal and preserves every parked book for undo', async t => {
  const f = await fixture(t), a = await f.add('Offline A'), b = await f.add('Offline B')
  const parkedLibrary = path.join(f.directory, 'disconnected-drive')
  await fs.rename(f.library, parkedLibrary)
  const report = await f.service.health()
  assert.equal(report.libraryAvailable, false); assert.equal(report.missing, 0); assert.equal(report.unavailable, 2)
  assert.ok(report.issues.every(issue => issue.canRemove))
  const preview = await f.service.previewRemoveMissing({ bookIds: report.issues.map(issue => issue.id) })
  assert.ok(preview.warnings.some(message => message.includes('暂不可访问')))
  const result = await f.service.apply(preview.token)
  assert.equal(await f.Manga.count(), 0)
  for (const book of [a, b]) assert.equal(await fs.readFile(path.join(parkedLibrary, book.id, '1.jpg'), 'utf8'), 'neutral page one')
  await fs.rename(parkedLibrary, f.library)
  await f.service.undo(result.id)
  assert.equal(await f.Manga.count(), 2)
  assert.equal((await f.service.health()).present, 2)
})

test('cached missing flags, changed root settings and invalid paths never authorize removal of present sources', async t => {
  const f = await fixture(t), a = await f.add('Present despite stale flag', { exist: false }), b = await f.add('Wrong type')
  await assert.rejects(f.service.previewRemoveMissing({ bookIds: [a.id] }), /已可访问/)
  const otherRoot = createLibraryOrganizer({ ...f.options, libraryRoot: () => path.join(f.directory, 'other-root') })
  await otherRoot.ready
  const unavailable = await otherRoot.health()
  assert.ok(unavailable.issues.every(issue => issue.status === 'unavailable' && !issue.canRemove))
  await assert.rejects(otherRoot.previewRemoveMissing({ bookIds: [a.id] }), /已可访问/)
  await f.Manga.update({ type: 'zip' }, { where: { id: b.id } })
  assert.equal((await f.service.health()).issues.find(issue => issue.id === b.id).canRemove, false)
  await assert.rejects(f.service.previewRemoveMissing({ bookIds: [b.id] }), /路径类型无效/)
  await f.Manga.update({ filepath: 'relative-path' }, { where: { id: b.id } })
  const invalid = (await f.service.health()).issues.find(issue => issue.id === b.id)
  assert.equal(invalid.status, 'invalid'); assert.equal(invalid.canRemove, false)
  await assert.rejects(f.service.previewRemoveMissing({ bookIds: [b.id] }), /路径类型无效/)
  assert.equal(await f.Manga.count(), 2)
})

for (const phase of ['prepared', 'applied']) test(`a ${phase} removal journal write failure preserves or restores every selected row`, async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Missing B')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  const preview = await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })
  f.failJournal(phase)
  await assert.rejects(f.service.apply(preview.token), /simulated journal disk failure/)
  for (const book of [a, b]) assert.deepEqual(snapshot(await row(f.Manga, book.id)), snapshot(book))
  if (phase === 'applied') assert.equal((await f.service.history())[0].status, 'rolled-back')
  else assert.equal((await f.service.history()).length, 0)
})

test('a failure midway through the removal transaction rolls back all deleted rows', async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Missing B')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  const original = f.Manga.destroy
  let writes = 0
  f.Manga.destroy = async function (...args) {
    if (++writes === 2) throw new Error('simulated deletion failure')
    return original.apply(this, args)
  }
  t.after(() => { f.Manga.destroy = original })
  const preview = await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })
  await assert.rejects(f.service.apply(preview.token), /已回滚本次变更.*simulated deletion failure/)
  for (const book of [a, b]) assert.deepEqual(snapshot(await row(f.Manga, book.id)), snapshot(book))
  assert.equal((await f.service.history())[0].status, 'rolled-back')
})

test('startup recovers an interrupted removal while retaining rows already restored from its snapshot', async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Missing B')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  const preview = await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })
  await f.service.apply(preview.token)
  const journal = JSON.parse(await fs.readFile(f.service.filePath, 'utf8'))
  journal.operations[0].status = 'prepared'
  await f.Manga.create(journal.operations[0].changes.books[0].before, { silent: true })
  await writeAtomic(f.service.filePath, journal)
  const restarted = createLibraryOrganizer(f.options); await restarted.ready
  for (const book of [a, b]) assert.deepEqual(snapshot(await row(f.Manga, book.id)), snapshot(book))
  assert.equal((await restarted.history())[0].status, 'rolled-back')
})

test('removal undo refuses replacement identities or rescanned paths before restoring any selected record', async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Missing B')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  const result = await f.service.apply((await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })).token)
  await f.Manga.create({ ...snapshot(a), title: 'New row with old ID' })
  await assert.rejects(f.service.undo(result.id), /预览后修改/)
  assert.equal(await f.Manga.findByPk(b.id), null)
  assert.equal((await row(f.Manga, a.id)).title, 'New row with old ID')
  await f.Manga.destroy({ where: { id: a.id } })
  await f.Manga.create({ ...snapshot(a), id: 'new-scan-id', title: 'Imported again under a new ID' })
  await assert.rejects(f.service.undo(result.id), /原路径的新书目.*预览后修改/)
  assert.equal(await f.Manga.findByPk(a.id), null); assert.equal(await f.Manga.findByPk(b.id), null)
  assert.equal((await row(f.Manga, 'new-scan-id')).title, 'Imported again under a new ID')
})

test('a failure midway through removal undo leaves no partially restored rows and can be retried', async t => {
  const f = await fixture(t), a = await f.add('Missing A'), b = await f.add('Missing B')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  const result = await f.service.apply((await f.service.previewRemoveMissing({ bookIds: [a.id, b.id] })).token)
  const original = f.Manga.create
  let writes = 0
  f.Manga.create = async function (...args) {
    if (++writes === 2) throw new Error('simulated restore failure')
    return original.apply(this, args)
  }
  t.after(() => { f.Manga.create = original })
  await assert.rejects(f.service.undo(result.id), /撤销尚未完成.*simulated restore failure/)
  assert.equal(await f.Manga.count(), 0)
  assert.equal((await f.service.history())[0].status, 'applied')
  f.Manga.create = original
  await f.service.undo(result.id)
  for (const book of [a, b]) assert.deepEqual(snapshot(await row(f.Manga, book.id)), snapshot(book))
})

test('removal journals reject incomplete snapshots, identity changes, replacement rows and unrelated archive mutations', async t => {
  const f = await fixture(t), a = await f.add('Missing')
  await fs.rename(f.library, path.join(f.directory, 'parked-library'))
  await f.service.apply((await f.service.previewRemoveMissing({ bookIds: [a.id] })).token)
  const journal = JSON.parse(await fs.readFile(f.service.filePath, 'utf8'))
  assert.equal(validateOrganizerState(journal), journal)
  for (const mutate of [
    op => { delete op.changes.books[0].before.filepath },
    op => { op.changes.books[0].before.id = 'another-id' },
    op => { op.changes.books[0].after = op.changes.books[0].before },
    op => { op.changes.books[0].before.unexpected = 'arbitrary data' },
    op => { op.changes.books[0].before.createdAt = null },
    op => { op.changes.progress.push({ id: a.id, before: null, after: null }) },
  ]) {
    const invalid = snapshot(journal); mutate(invalid.operations[0])
    assert.throws(() => validateOrganizerState(invalid), /整理日志|整理操作|变更清单/)
  }
})

test('remove-all and durable undo support more than the ordinary 2000-record editing limit', async t => {
  const f = await fixture(t), count = 2001
  const values = Array.from({ length: count }, (_, index) => ({ id: `missing-${index}`, title: `Neutral missing ${index}`,
    filepath: path.join(f.library, `missing-${index}`), type: 'folder' }))
  await f.Manga.bulkCreate(values)
  assert.ok((await f.service.catalog()).maxRemoveMissing >= count)
  const preview = await f.service.previewRemoveMissing({ bookIds: values.map(book => book.id) })
  assert.equal(preview.changed, count)
  const result = await f.service.apply(preview.token)
  assert.equal(result.changed, count); assert.equal(await f.Manga.count(), 0)
  const restarted = createLibraryOrganizer(f.options); await restarted.ready
  await restarted.undo(result.id)
  assert.equal(await f.Manga.count(), count)
})
