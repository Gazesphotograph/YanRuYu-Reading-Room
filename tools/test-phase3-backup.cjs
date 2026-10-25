'use strict'

// All databases, backups, neutral page files and recovery points live below a
// newly-created OS temp root. Teardown verifies that exact root and removes it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const { createHash } = require('node:crypto')
const { createRequire } = require('node:module')
const appRequire = createRequire(path.resolve(__dirname, '../resources/app/package.json'))
const AdmZip = appRequire('adm-zip')
const { BackupService } = require('../resources/app/modules/backup_service')
const { prepareMangaModel, prepareMetadataModel } = require('../resources/app/modules/database')
const { createReadingStateStore, writeAtomic } = require('../resources/app/modules/reading_state')
const { createLibraryOrganizer } = require('../resources/app/modules/library_organizer')
const { createLocalSearchService } = require('../resources/app/modules/local_search')
const { writeClientState, readClientState } = require('../resources/app/modules/client_state')
const { fingerprintBook } = require('../resources/app/modules/library_identity')
const { serialQueue } = require('../resources/app/modules/safety')

const sha = value => createHash('sha256').update(value).digest('hex')
const json = async filename => JSON.parse(await fs.readFile(filename, 'utf8'))
const personalLayout = {
  layout: 'cozy', shelfOffset: 4, furnitureOffset: -3, brightness: 112, warmth: 9,
  furniture: { chair: true, table: true, lamp: false, rug: true, plants: false, objects: true },
  camera: { yaw: .1, panX: .2, panY: -.2, zoom: 1.15 }
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-phase3-backup-'))
  const stores = []
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {})
    const resolved = path.resolve(root)
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('yanruyu-phase3-backup-')) throw new Error('Unsafe phase 3 backup fixture cleanup')
    await fs.rm(resolved, { recursive: true, force: true })
  })

  async function makeStore(label, features = false) {
    const storePath = path.join(root, label), library = path.join(root, label + '-originals')
    await fs.mkdir(storePath); await fs.mkdir(library)
    await fs.mkdir(path.join(storePath, 'cover')); await fs.mkdir(path.join(storePath, '.reading-room'))
    const store = { storePath, library, books: [], collections: [], closed: true,
      backup: new BackupService({ storePath, appVersion: 'phase3-synthetic-fixture' }) }
    stores.push(store)
    store.open = async () => {
      if (!store.closed) return
      store.Manga = prepareMangaModel(path.join(storePath, 'database.sqlite'))
      store.Metadata = prepareMetadataModel(path.join(storePath, 'metadata.sqlite'))
      store.closed = false
      await store.Manga.sync(); await store.Metadata.sync()
      store.readingState = createReadingStateStore({ storePath })
      try { store.currentLibrary = (await json(path.join(storePath, 'setting.json'))).library } catch (error) { if (error.code !== 'ENOENT') throw error; store.currentLibrary = library }
      try { store.collections = await json(path.join(storePath, 'collectionList.json')) } catch (error) { if (error.code !== 'ENOENT') throw error; store.collections = [] }
      store.setCollections = async list => { await writeAtomic(path.join(storePath, 'collectionList.json'), list); store.collections = list }
      store.organizer = createLibraryOrganizer({ storePath, getManga: () => store.Manga, getMetadata: () => store.Metadata,
        readingState: store.readingState, getCollections: () => store.collections, saveCollections: store.setCollections,
        libraryRoot: () => store.currentLibrary, commit: serialQueue() })
      store.search = createLocalSearchService({ storePath, getBooks: async () => (await store.Manga.findAll()).map(book => book.toJSON()) })
      await store.organizer.ready; await store.search.ready
    }
    store.close = async () => {
      if (store.closed) return
      const pending = await Promise.allSettled([store.organizer?.flush(), store.search?.dispose(), store.readingState?.flush()])
      const connections = await Promise.allSettled([store.Manga.sequelize.close(), store.Metadata.sequelize.close()])
      store.closed = true
      const failure = [...pending, ...connections].find(result => result.status === 'rejected')
      if (failure) throw failure.reason
    }
    await store.open()
    for (let i = 0; i < 2; i++) {
      const id = label + '-book-' + i, filepath = path.join(library, 'book-' + i), coverPath = path.join(storePath, 'cover', id + '.webp')
      await fs.mkdir(filepath)
      for (const page of [1, 2]) await fs.writeFile(path.join(filepath, page + '.jpg'), 'neutral synthetic page ' + page)
      await fs.writeFile(coverPath, 'neutral cover fixture ' + id)
      const book = { id, hash: label + '-sample-' + i, filepath, coverPath, type: 'folder', title: 'Neutral ' + label + ' ' + i,
        pageCount: 2, tags: { artist: ['Author ' + label + ' ' + i], other: ['Original ' + i] },
        status: 'tagged', mark: i === 1, readCount: i + 2, identityFingerprint: await fingerprintBook(filepath, 'folder') }
      await store.Manga.create(book); await store.Metadata.create(book); store.books.push(book)
      await store.readingState.saveProgress(id, { page: i + 1, total: 2, time: 100 + i, source: 'room' })
      await store.readingState.savePreferences(id, { mode: i ? 'double' : 'paged', direction: i ? 'rtl' : 'ltr' })
    }
    await store.setCollections([{ id: label + '-collection', title: 'Neutral collection ' + label, list: [store.books[1].hash] }])
    await writeAtomic(path.join(storePath, 'setting.json'), { library, metadataPath: '', keepReadingProgress: true })
    const values = { 'room-theme': '"forest"', 'room-quality': '"fine"', 'reading-room-interface': 'room' }
    if (features) {
      values['room-personalization'] = JSON.stringify({ schemaVersion: 1, themes: { forest: { current: personalLayout, saved: personalLayout, savedAt: 1234 } },
        featuredIds: [store.books[0].id], sound: { kind: 'rain', volume: 13, duringReading: true } })
      const alias = await store.search.command({ action: 'preview-alias', kind: 'author', canonical: '标准作者 ' + label, aliases: ['Author ' + label + ' 0'] })
      await store.search.command({ action: 'save-alias', token: alias.token })
      const text = await store.search.command({ action: 'preview-text', bookId: store.books[0].id, page: 1, text: '清晨的森林有一条安静小路。 Neutral local corpus.', source: 'manual' })
      await store.search.command({ action: 'save-text', token: text.token })
      await store.search.waitForIdle()
      const preview = await store.organizer.previewMerge({ bookIds: store.books.map(book => book.id), keeperId: store.books[0].id, progressSourceId: store.books[1].id })
      store.applied = await store.organizer.apply(preview.token)
    }
    writeClientState(storePath, { schemaVersion: 1, values })
    store.uiValues = values
    await store.close()
    return store
  }

  return { root, makeStore }
}

async function originalDigests(...stores) {
  const files = {}
  for (const store of stores) for (const book of store.books) for (const page of [1, 2]) {
    const filename = path.join(book.filepath, page + '.jpg'); files[filename] = sha(await fs.readFile(filename))
  }
  return files
}
async function assertOriginals(before) {
  for (const [filename, digest] of Object.entries(before)) assert.equal(sha(await fs.readFile(filename)), digest, 'Original source page changed: ' + filename)
}
async function storeDigests(store) {
  const values = {}
  for (const name of ['database.sqlite', 'metadata.sqlite', 'reading-state.json', 'setting.json', 'collectionList.json', 'ui-state.json', 'library-organizer.json', 'local-search.json']) {
    try { values[name] = sha(await fs.readFile(path.join(store.storePath, name))) } catch (error) { if (error.code !== 'ENOENT') throw error; values[name] = null }
  }
  return values
}
function modifiedBackup(source, destination, filename, payload, updateManifest = true) {
  const zip = new AdmZip(source), bytes = Buffer.from(JSON.stringify(payload))
  zip.updateFile(filename, bytes)
  if (updateManifest) {
    const manifest = JSON.parse(zip.readAsText('manifest.json')), entry = manifest.files.find(file => file.name === filename)
    entry.sha256 = sha(bytes); entry.size = bytes.length
    zip.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)))
  }
  zip.writeZip(destination)
}

test('feature backup restores to another data directory and restored applied merge can be undone safely', async t => {
  const f = await fixture(t), source = await f.makeStore('source', true), target = await f.makeStore('target', true)
  const originals = await originalDigests(source, target), filename = path.join(f.root, 'modern.yru-backup')
  await source.backup.createBackup(filename)
  const inspected = await target.backup.inspectBackup(filename)
  assert.equal(inspected.summary.organizerRecords, 1)
  assert.equal(inspected.summary.localAliases, 1)
  assert.equal(inspected.summary.indexedTextPages, 1)
  const restored = await target.backup.restoreBackup(filename, { expectedDigest: inspected.digest })
  assert.equal(restored.success, true)
  const journal = await json(path.join(target.storePath, 'library-organizer.json'))
  assert.equal(journal.operations[0].status, 'applied')
  assert.equal(journal.operations[0].metadataStorage, path.join(target.storePath, 'metadata.sqlite'), 'The restore rebases a guard, never follows an imported path')
  assert.deepEqual((await json(path.join(target.storePath, 'local-search.json'))), await json(path.join(source.storePath, 'local-search.json')))
  assert.equal(readClientState(target.storePath).values['room-personalization'], source.uiValues['room-personalization'])
  assert.equal(readClientState(target.storePath).values['room-quality'], '"fine"')
  await target.open()
  await target.search.waitForIdle()
  const aliasResults = await target.search.command({ action: 'search', query: '标准作者 source', mode: 'metadata' })
  assert.ok(aliasResults.results.some(result => result.bookId === source.books[0].id))
  const textResults = await target.search.command({ action: 'search', query: '安静小路', mode: 'text' })
  assert.equal(textResults.results[0].bookId, source.books[0].id); assert.equal(textResults.results[0].page, 1)
  const readingBefore = await target.readingState.load()
  assert.equal(readingBefore.progress[source.books[0].id].page, 2)
  assert.equal(readingBefore.preferences[source.books[1].id].direction, 'rtl')
  await target.organizer.undo(source.applied.id)
  assert.equal((await target.Manga.findByPk(source.books[1].id)).hiddenBook, false)
  assert.deepEqual((await target.Manga.findByPk(source.books[0].id)).tags, source.books[0].tags)
  assert.deepEqual((await target.Metadata.findByPk(source.books[0].hash)).tags, source.books[0].tags)
  assert.equal((await target.readingState.load()).progress[source.books[0].id].page, 1)
  assert.deepEqual(target.collections[0].list, [source.books[1].hash])
  assert.equal((await target.organizer.history())[0].status, 'undone')
  await target.close()
  await source.open()
  assert.equal((await source.Manga.findByPk(source.books[1].id)).hiddenBook, true, 'Undo in the restored copy does not touch the source database')
  assert.equal((await source.organizer.history())[0].status, 'applied')
  await assertOriginals(originals)
})

test('a removed record survives full backup into another data directory and can be restored with its identity and archives', async t => {
  const f = await fixture(t), source = await f.makeStore('removed-source'), target = await f.makeStore('removed-target')
  const originals = await originalDigests(source, target), removedBook = source.books[1]
  const snapshot = value => JSON.parse(JSON.stringify(value))
  await source.open()
  const before = snapshot((await source.Manga.findByPk(removedBook.id)).toJSON())
  const metadataBefore = snapshot(await source.Metadata.findAll({ order: [['hash', 'ASC']] }))
  const readingBefore = await source.readingState.load(), collectionsBefore = snapshot(source.collections)
  const parked = path.join(f.root, 'parked-missing-book')
  await fs.rename(removedBook.filepath, parked)
  const preview = await source.organizer.previewRemoveMissing({ bookIds: [removedBook.id] })
  const removal = await source.organizer.apply(preview.token)
  assert.equal(await source.Manga.findByPk(removedBook.id), null)
  await source.close()

  const filename = path.join(f.root, 'removed-record.yru-backup')
  await source.backup.createBackup(filename)
  const inspected = await target.backup.inspectBackup(filename)
  assert.equal(inspected.summary.books, 1); assert.equal(inspected.summary.metadata, 2)
  assert.equal(inspected.summary.readingRecords, 2); assert.equal(inspected.summary.organizerRecords, 1)
  const restored = await target.backup.restoreBackup(filename, { expectedDigest: inspected.digest })
  assert.equal(restored.success, true)
  const journal = await json(path.join(target.storePath, 'library-organizer.json'))
  assert.equal(journal.operations[0].kind, 'remove-missing'); assert.equal(journal.operations[0].status, 'applied')
  assert.equal(journal.operations[0].changes.books[0].id, removedBook.id)
  assert.equal(journal.operations[0].changes.books[0].after, null)
  assert.equal(journal.operations[0].metadataStorage, path.join(target.storePath, 'metadata.sqlite'))
  await target.open()
  assert.equal(await target.Manga.findByPk(removedBook.id), null, 'Opening the restored copy preserves the intentional removal')
  assert.deepEqual(snapshot(await target.Metadata.findAll({ order: [['hash', 'ASC']] })), metadataBefore)
  assert.deepEqual(await target.readingState.load(), readingBefore)
  assert.deepEqual(target.collections, collectionsBefore)
  const restoredCover = path.join(target.storePath, 'cover', path.basename(removedBook.coverPath))
  assert.equal(await fs.readFile(restoredCover, 'utf8'), await fs.readFile(removedBook.coverPath, 'utf8'))
  await target.organizer.undo(removal.id)
  assert.deepEqual(snapshot((await target.Manga.findByPk(removedBook.id)).toJSON()), { ...before, coverPath: restoredCover },
    'Undo restores all original fields and uses the cover copied into this restored data directory')
  assert.deepEqual(snapshot(await target.Metadata.findAll({ order: [['hash', 'ASC']] })), metadataBefore)
  assert.deepEqual(await target.readingState.load(), readingBefore)
  assert.deepEqual(target.collections, collectionsBefore)
  assert.equal((await target.organizer.history())[0].status, 'undone')
  await target.close()
  await source.open()
  assert.equal(await source.Manga.findByPk(removedBook.id), null, 'Undo in the backup copy leaves the source catalogue untouched')
  assert.equal((await source.organizer.history())[0].status, 'applied')
  await fs.rename(parked, removedBook.filepath)
  await assertOriginals(originals)
})

test('older complete backup without optional feature files clears newer state while preserving all originals', async t => {
  const f = await fixture(t), legacy = await f.makeStore('legacy'), target = await f.makeStore('newer', true)
  const originals = await originalDigests(legacy, target), filename = path.join(f.root, 'legacy.yru-backup')
  await legacy.backup.createBackup(filename)
  const zip = new AdmZip(filename)
  assert.equal(zip.getEntry('library-organizer.json'), null); assert.equal(zip.getEntry('local-search.json'), null)
  await target.backup.restoreBackup(filename)
  await assert.rejects(fs.stat(path.join(target.storePath, 'library-organizer.json')), { code: 'ENOENT' })
  await assert.rejects(fs.stat(path.join(target.storePath, 'local-search.json')), { code: 'ENOENT' })
  assert.equal(readClientState(target.storePath).values['room-personalization'], undefined)
  await target.open()
  assert.deepEqual(await target.organizer.history(), [])
  const state = await target.search.command({ action: 'status' })
  assert.equal(state.aliases.length, 0); assert.equal(state.savedPages, 0)
  assert.equal((await target.Manga.findByPk(legacy.books[1].id)).hiddenBook, false)
  assert.equal((await target.readingState.load()).progress[legacy.books[0].id].page, 1)
  await assertOriginals(originals)
})

test('tampered or invalid new feature JSON fails preflight before existing data is touched', async t => {
  const f = await fixture(t), source = await f.makeStore('valid', true), target = await f.makeStore('unchanged', true)
  const original = path.join(f.root, 'valid.yru-backup'); await source.backup.createBackup(original)
  const before = await storeDigests(target), originals = await originalDigests(source, target)
  const search = await json(path.join(source.storePath, 'local-search.json'))
  const invalidSearch = { ...search, texts: [{ ...search.texts[0], page: 0 }] }
  const invalidJournal = await json(path.join(source.storePath, 'library-organizer.json'))
  invalidJournal.operations[0].changes.books[0].before.filepath = 'untrusted-old'
  invalidJournal.operations[0].changes.books[0].after.filepath = 'untrusted-new'
  const invalidUI = await json(path.join(source.storePath, 'ui-state.json'))
  const personalization = JSON.parse(invalidUI.values['room-personalization']); personalization.themes.forest.current.shelfOffset = 999
  invalidUI.values['room-personalization'] = JSON.stringify(personalization)
  const cases = [
    { name: 'checksum', filename: 'local-search.json', payload: {}, manifest: false, error: /校验|大小/ },
    { name: 'text-schema', filename: 'local-search.json', payload: invalidSearch, error: /文本页/ },
    { name: 'journal-fields', filename: 'library-organizer.json', payload: invalidJournal, error: /不允许编辑的书目字段/ },
    { name: 'layout-bounds', filename: 'ui-state.json', payload: invalidUI, error: /房间布置参数/ },
  ]
  for (const item of cases) {
    const filename = path.join(f.root, item.name + '.yru-backup')
    modifiedBackup(original, filename, item.filename, item.payload, item.manifest !== false)
    await assert.rejects(target.backup.restoreBackup(filename), item.error)
    assert.deepEqual(await storeDigests(target), before, item.name + ' changed existing data during failed preflight')
  }
  await assertOriginals(originals)
})

test('a restored prepared organizer journal is recovered before exposing the restored book records', async t => {
  const f = await fixture(t), source = await f.makeStore('interrupted-source', true), target = await f.makeStore('interrupted-target')
  const original = path.join(f.root, 'applied.yru-backup'); await source.backup.createBackup(original)
  const journal = await json(path.join(source.storePath, 'library-organizer.json')); journal.operations[0].status = 'prepared'
  const interrupted = path.join(f.root, 'interrupted.yru-backup')
  modifiedBackup(original, interrupted, 'library-organizer.json', journal)
  await target.backup.restoreBackup(interrupted)
  await target.open() // .ready recovers the imported before/after journal.
  assert.equal((await target.organizer.history())[0].status, 'rolled-back')
  assert.equal((await target.Manga.findByPk(source.books[1].id)).hiddenBook, false)
  assert.deepEqual((await target.Manga.findByPk(source.books[0].id)).tags, source.books[0].tags)
  assert.equal((await target.readingState.load()).progress[source.books[0].id].page, 1)
  assert.deepEqual(target.collections[0].list, [source.books[1].hash])
  assert.equal((await target.search.command({ action: 'status' })).savedPages, 1)
})
