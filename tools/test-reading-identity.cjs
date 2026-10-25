'use strict';

// All books below are short synthetic byte strings in a fresh OS temp directory.
// This suite never loads Electron, the running app, or the real portable store.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMangaModel } = require('../resources/app/modules/database');
const { fingerprintBook, createIdentityResolver, mergeRebuiltBook, moveWithIdentity } = require('../resources/app/modules/library_identity');
const { scanLibrary } = require('../resources/app/modules/library_scan');
const { createReadingStateStore, pageFromLegacyId, migrateLegacyProgress, writeAtomic } = require('../resources/app/modules/reading_state');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-reading-identity-'));
  const library = path.join(directory, 'library');
  const coverRoot = path.join(directory, 'cover');
  await fs.mkdir(library);
  await fs.mkdir(coverRoot);
  const Manga = prepareMangaModel(path.join(directory, 'fixture.sqlite'));
  await Manga.sync();
  t.after(async () => {
    await Manga.sequelize.close();
    if (!directory.startsWith(path.join(os.tmpdir(), 'yanruyu-reading-identity-'))) throw Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  });
  let idCounter = 0, coverCounter = 0;
  const files = [];
  const createBook = async (name, contents = ['neutral first page', 'neutral second page']) => {
    const filepath = path.join(library, name);
    await fs.mkdir(filepath, { recursive: true });
    for (let index = 0; index < contents.length; index++) await fs.writeFile(path.join(filepath, `${index + 1}.jpg`), contents[index]);
    const entry = { filepath, type: 'folder' };
    files.push(entry);
    return entry;
  };
  const options = {
    Manga, library, coverRoot, getBookFilelist: async () => [...files], newId: () => 'generated-' + (++idCounter),
    geneCover: async filepath => {
      const coverPath = path.join(coverRoot, `generated-${++coverCounter}.webp`);
      await fs.writeFile(coverPath, 'neutral cover fixture');
      return { targetFilePath: path.join(filepath, '1.jpg'), coverPath, pageCount: 2, bundleSize: 42,
        mtime: new Date('2026-09-13T00:00:00Z'), coverHash: 'fixture-cover-hash' };
    },
    sampleHash: async () => 'deliberately-colliding-sampled-image-hash'
  };
  return { directory, library, coverRoot, Manga, files, createBook, options };
}

test('a complete rebuild preserves logical ID, user fields, and reading state across restart', async t => {
  const f = await fixture(t);
  const book = await f.createBook('original');
  await scanLibrary(f.options);
  let original = (await f.Manga.findAll({ raw: true }))[0];
  const userFields = { title: 'User title', title_jpn: 'User alternate title', status: 'tagged', date: 123456,
    mark: true, hiddenBook: true, readCount: 9, rating: 4.5, tags: { artist: ['Neutral artist'] }, category: 'Artbook', url: 'https://example.com/book' };
  await f.Manga.update(userFields, { where: { id: original.id } });
  original = await f.Manga.findByPk(original.id, { raw: true });
  const reading = createReadingStateStore({ storePath: f.directory });
  await reading.saveProgress(original.id, { page: 2, total: 2, offset: .2, time: 100 });
  await scanLibrary({ ...f.options, rebuild: true, newId: () => { throw Error('An existing book must not receive a new ID'); } });
  const rebuilt = await f.Manga.findByPk(original.id, { raw: true });
  for (const key of Object.keys(userFields)) assert.deepEqual(rebuilt[key], original[key], key);
  assert.equal(rebuilt.createdAt, original.createdAt);
  assert.equal(rebuilt.filepath, book.filepath);
  assert.notEqual(rebuilt.coverPath, original.coverPath);
  assert.equal((await f.Manga.count()), 1);
  const restarted = createReadingStateStore({ storePath: f.directory });
  assert.equal((await restarted.load()).progress[original.id].page, 2);
});

test('sampled-image collisions and identical copies never steal an existing book identity', async t => {
  const f = await fixture(t);
  const first = await f.createBook('first');
  await scanLibrary(f.options);
  const original = (await f.Manga.findAll({ raw: true }))[0];
  const duplicate = await f.createBook('duplicate');
  const different = await f.createBook('different', ['neutral first page', 'different second page']);
  f.files.splice(0, f.files.length, duplicate, different, first); // New copy scanned BEFORE its existing original.
  await scanLibrary(f.options);
  const books = await f.Manga.findAll({ raw: true });
  assert.equal(books.length, 3);
  assert.equal(books.find(book => book.filepath === first.filepath).id, original.id);
  assert.notEqual(books.find(book => book.filepath === duplicate.filepath).id, original.id);
  assert.equal(books.find(book => book.filepath === duplicate.filepath).identityFingerprint, original.identityFingerprint);
  assert.notEqual(books.find(book => book.filepath === different.filepath).identityFingerprint, original.identityFingerprint);
  assert.equal(new Set(books.map(book => book.hash)).size, 1, 'The old sampled hash deliberately collides');
});

test('a verified external rename reconnects the same ID and a legacy unverified path does not', async t => {
  const f = await fixture(t);
  const source = await f.createBook('before');
  await scanLibrary(f.options);
  const original = (await f.Manga.findAll({ raw: true }))[0];
  await f.Manga.update({ hiddenBook: true, readCount: 7 }, { where: { id: original.id } });
  const destination = path.join(f.library, 'after');
  await fs.rename(source.filepath, destination);
  f.files.splice(0, 1, { filepath: destination, type: 'folder' });
  await scanLibrary(f.options);
  const moved = await f.Manga.findByPk(original.id, { raw: true });
  assert.equal(moved.filepath, destination);
  assert.equal(moved.readCount, 7);
  assert.equal(moved.hiddenBook, 1);
  await f.Manga.update({ identityFingerprint: null }, { where: { id: original.id } });
  const secondDestination = path.join(f.library, 'unverified-after');
  await fs.rename(destination, secondDestination);
  f.files.splice(0, 1, { filepath: secondDestination, type: 'folder' });
  await scanLibrary(f.options);
  assert.equal(await f.Manga.count(), 2, 'Missing unverified record is retained separately for recovery');
  assert.equal((await f.Manga.findByPk(original.id, { raw: true })).exist, 0);
});

test('multiple missing full-content matches remain separate instead of choosing arbitrarily', async t => {
  const f = await fixture(t);
  const entry = await f.createBook('present');
  const fingerprint = await fingerprintBook(entry.filepath, 'folder');
  const previous = ['one', 'two'].map(id => ({ id, type: 'folder', filepath: path.join(f.library, id), identityFingerprint: fingerprint }));
  const resolver = createIdentityResolver(previous, [entry], { libraryRoot: f.library });
  assert.equal(await resolver.relocated(entry.filepath, 'folder', fingerprint), null);
});

test('application move persists the same ID and rolls the file back if the database write fails', async t => {
  const f = await fixture(t);
  const source = await f.createBook('source');
  await scanLibrary(f.options);
  const original = (await f.Manga.findAll({ raw: true }))[0];
  const destination = path.join(f.library, 'destination');
  await moveWithIdentity({ oldPath: source.filepath, newPath: destination, type: 'folder', libraryRoot: f.library,
    persist: identityFingerprint => f.Manga.update({ filepath: destination, identityFingerprint }, { where: { id: original.id } }) });
  assert.equal((await f.Manga.findByPk(original.id, { raw: true })).filepath, destination);
  const failedDestination = path.join(f.library, 'failed');
  await assert.rejects(moveWithIdentity({ oldPath: destination, newPath: failedDestination, type: 'folder', libraryRoot: f.library,
    persist: async () => { throw Error('synthetic database write failure'); } }), /synthetic database/);
  assert.equal(await fs.readFile(path.join(destination, '1.jpg'), 'utf8'), 'neutral first page');
  await assert.rejects(fs.access(failedDestination), { code: 'ENOENT' });
  assert.equal((await f.Manga.findByPk(original.id, { raw: true })).filepath, destination);
});

test('a move refuses an occupied destination before changing either book', async t => {
  const f = await fixture(t);
  const source = await f.createBook('source');
  const target = await f.createBook('occupied', ['occupied contents']);
  await assert.rejects(moveWithIdentity({ oldPath: source.filepath, newPath: target.filepath, type: 'folder', libraryRoot: f.library,
    persist: async () => { throw Error('Must not persist'); } }), /目标路径已存在/);
  assert.equal(await fs.readFile(path.join(target.filepath, '1.jpg'), 'utf8'), 'occupied contents');
  assert.equal(await fs.readFile(path.join(source.filepath, '1.jpg'), 'utf8'), 'neutral first page');
});

test('a failed full rebuild keeps every original row and cover and removes staged replacements', async t => {
  const f = await fixture(t);
  await f.createBook('first');
  const broken = await f.createBook('broken');
  await scanLibrary(f.options);
  const before = await f.Manga.findAll({ raw: true });
  const coversBefore = (await fs.readdir(f.coverRoot)).sort();
  const outcome = await scanLibrary({ ...f.options, rebuild: true, geneCover: async filepath => {
    if (filepath === broken.filepath) throw Error('synthetic decode failure');
    return f.options.geneCover(filepath);
  } });
  assert.equal(outcome.changed, false);
  assert.equal(outcome.failures, 1);
  assert.deepEqual(await f.Manga.findAll({ raw: true }), before);
  assert.deepEqual((await fs.readdir(f.coverRoot)).sort(), coversBefore);
});

test('transaction failure leaves the old library intact and does not leak generated covers', async t => {
  const f = await fixture(t);
  await f.createBook('first');
  await scanLibrary(f.options);
  const before = await f.Manga.findAll({ raw: true });
  const coversBefore = (await fs.readdir(f.coverRoot)).sort();
  const originalUpdate = f.Manga.update.bind(f.Manga);
  f.Manga.update = async (...args) => { await originalUpdate(...args); throw Error('synthetic transaction failure'); };
  await assert.rejects(scanLibrary({ ...f.options, rebuild: true }), /synthetic transaction/);
  f.Manga.update = originalUpdate;
  assert.deepEqual(await f.Manga.findAll({ raw: true }), before);
  assert.deepEqual((await fs.readdir(f.coverRoot)).sort(), coversBefore);
});

test('recovery and application output folders are excluded from scan results', async t => {
  const f = await fixture(t);
  await f.createBook('book');
  const recovery = await f.createBook('recovery/restored-copy');
  await scanLibrary({ ...f.options, excludeRoots: [path.dirname(recovery.filepath)] });
  assert.equal(await f.Manga.count(), 1);
  assert.equal((await f.Manga.findAll({ raw: true }))[0].title, 'book');
});

test('legacy one-based page IDs, newest classic entries, and timestamp conflicts migrate deterministically', () => {
  assert.equal(pageFromLegacyId('id_with_underscores', 'id_with_underscores_9'), 9);
  assert.equal(pageFromLegacyId('id', 'id_0'), null);
  assert.equal(pageFromLegacyId('id', 'other_3'), null);
  const raw = {
    'room-progress': JSON.stringify({ shared: { page: 3, total: 10, time: 1000, offset: .3 }, room: { page: 8, total: 10, time: 3000 } }),
    viewerReadingProgress: JSON.stringify([{ bookId: 'shared', pageId: 'shared_9' }, { bookId: 'shared', pageId: 'shared_2' }, { bookId: 'room', pageId: 'room_1' }]),
    recentRead: JSON.stringify([{ id: 'shared', read_time: 2 }, { id: 'room', read_time: 1 }])
  };
  const result = migrateLegacyProgress(raw, [{ id: 'shared', pageCount: 10 }, { id: 'room', pageCount: 10 }]);
  assert.equal(result.progress.shared.page, 9);
  assert.equal(result.progress.room.page, 8);
});

test('migration keeps exact old storage copies, is idempotent, and survives restarting the store', async t => {
  const f = await fixture(t);
  const raw = { 'room-progress': '{ invalid legacy JSON', viewerReadingProgress: '[{"bookId":"legacy","pageId":"legacy_6"}]', recentRead: '[{"id":"legacy","read_time":17}]' };
  const store = createReadingStateStore({ storePath: f.directory });
  await store.migrate(raw, [{ id: 'legacy', pageCount: 6 }]);
  await store.migrate({ 'room-progress': '{}' }, []);
  await store.flush();
  const disk = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
  assert.equal(disk.pageBase, 1);
  assert.deepEqual(disk.migrationSnapshots[0].storage, raw);
  assert.equal(disk.migrationSnapshots.length, 1);
  assert.equal(disk.progress.legacy.page, 6, 'The last page must not reset to the first page');
  assert.equal((await createReadingStateStore({ storePath: f.directory }).load()).progress.legacy.page, 6);
});

test('concurrent progress updates serialize, and intentional rereading can move backwards', async t => {
  const f = await fixture(t);
  const store = createReadingStateStore({ storePath: f.directory });
  await Promise.all([store.saveProgress('one', { page: 9, total: 10, time: 10 }), store.saveProgress('two', { page: 4, total: 10, time: 11 }), store.saveProgress('one', { page: 2, total: 10, time: 12 })]);
  await store.flush();
  const disk = await createReadingStateStore({ storePath: f.directory }).load();
  assert.equal(disk.progress.one.page, 2);
  assert.equal(disk.progress.two.page, 4);
  assert.equal(disk.revision, 3);
});

test('failed progress writes retain the previously acknowledged state and can be retried', async t => {
  const f = await fixture(t);
  let fail = false;
  const store = createReadingStateStore({ storePath: f.directory, write: async (target, value) => {
    if (fail) throw Error('synthetic disk-full failure');
    return writeAtomic(target, value);
  } });
  await store.saveProgress('one', { page: 4, total: 10, time: 1 });
  fail = true;
  await assert.rejects(store.saveProgress('one', { page: 5, total: 10, time: 2 }), /synthetic disk-full/);
  assert.equal((await store.load()).progress.one.page, 4);
  assert.equal((await createReadingStateStore({ storePath: f.directory }).load()).progress.one.page, 4);
  fail = false;
  await store.saveProgress('one', { page: 6, total: 10, time: 3 });
  assert.equal((await store.load()).progress.one.page, 6);
});

test('a malformed main profile is reported without overwriting its original bytes', async t => {
  const f = await fixture(t);
  const file = path.join(f.directory, 'reading-state.json');
  await fs.writeFile(file, 'malformed main profile');
  const store = createReadingStateStore({ storePath: f.directory });
  await assert.rejects(store.load(), /原文件已保留/);
  await assert.rejects(store.saveProgress('one', { page: 1, total: 2 }), /原文件已保留/);
  assert.equal(await fs.readFile(file, 'utf8'), 'malformed main profile');
});

test('rebuild merge preserves unknown future user metadata rather than a narrow field subset', () => {
  const result = mergeRebuiltBook({ id: 'stable', date: 1, title: 'custom', hiddenBook: true, futureUserField: { note: 'keep' } },
    { id: 'new', date: 2, title: 'filename', pageCount: 20, identityFingerprint: 'new-fingerprint' });
  assert.deepEqual(result.futureUserField, { note: 'keep' });
  assert.equal(result.id, 'stable');
  assert.equal(result.date, 1);
  assert.equal(result.title, 'custom');
  assert.equal(result.pageCount, 20);
});
