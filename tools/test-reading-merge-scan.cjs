'use strict';

// Real organizer journals, SQLite and scans, with neutral pages in a fresh
// temporary directory. Never touches the portable library or running app.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMangaModel, prepareMetadataModel } = require('../resources/app/modules/database');
const { createLibraryOrganizer } = require('../resources/app/modules/library_organizer');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');
const { scanLibrary } = require('../resources/app/modules/library_scan');
const { serialQueue } = require('../resources/app/modules/safety');

async function fixture(t) {
  const prefix = 'yanruyu-merge-scan-';
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const library = path.join(directory, 'library'), coverRoot = path.join(directory, 'covers');
  await fs.mkdir(library); await fs.mkdir(coverRoot);
  const Manga = prepareMangaModel(path.join(directory, 'database.sqlite'));
  const Metadata = prepareMetadataModel(path.join(directory, 'metadata.sqlite'));
  const readingState = createReadingStateStore({ storePath: directory });
  await Manga.sync(); await Metadata.sync();
  const commit = serialQueue();
  const organizerOptions = { storePath: directory, getManga: () => Manga, getMetadata: () => Metadata,
    readingState, libraryRoot: () => library, commit, getCollections: () => [], saveCollections: async () => {} };
  const organizer = createLibraryOrganizer(organizerOptions);
  await organizer.ready;
  t.after(async () => {
    await organizer.flush(); await readingState.flush();
    await Promise.all([Manga.sequelize.close(), Metadata.sequelize.close()]);
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith(prefix)) {
      throw Error('Unsafe merge/scan fixture cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  let nextId = 0, nextCover = 0;
  const createBook = async name => {
    const filepath = path.join(library, name);
    await fs.mkdir(filepath);
    await fs.writeFile(path.join(filepath, '1.jpg'), 'neutral first page');
    await fs.writeFile(path.join(filepath, '2.jpg'), 'neutral second page');
    return filepath;
  };
  const scanOptions = { Manga, library, coverRoot, commit, getMergedSources: () => organizer.mergedSources(),
    getBookFilelist: async () => (await fs.readdir(library, { withFileTypes: true })).filter(entry => entry.isDirectory())
      .map(entry => ({ filepath: path.join(library, entry.name), type: 'folder' })),
    newId: () => `book-${++nextId}`, sampleHash: async () => 'shared-sample-hash',
    geneCover: async filepath => {
      const coverPath = path.join(coverRoot, `cover-${++nextCover}.webp`);
      await fs.writeFile(coverPath, 'neutral cover');
      return { coverPath, targetFilePath: path.join(filepath, '1.jpg'), pageCount: 2, bundleSize: 39,
        coverHash: 'neutral-cover-hash', mtime: (await fs.stat(filepath)).mtime };
    } };
  const books = () => Manga.findAll({ raw: true });
  const merge = async (keeper, donor) => {
    const preview = await organizer.previewMerge({ bookIds: [keeper.id, donor.id], keeperId: keeper.id, progressSourceId: keeper.id });
    return organizer.apply(preview.token);
  };
  const duplicatedPath = async () => {
    await createBook('Neutral book'); await scanLibrary(scanOptions);
    const keeper = (await books())[0];
    await readingState.saveProgress(keeper.id, { page: 2, total: 2, time: 100 });
    await readingState.savePreferences(keeper.id, { mode: 'double', direction: 'rtl' });
    const donor = (await Manga.create({ ...keeper, id: 'legacy-duplicate', title: 'Newly imported name', readCount: 0 })).toJSON();
    return { keeper, donor };
  };
  return { directory, library, Manga, Metadata, readingState, organizer, organizerOptions, scanOptions, createBook, books, merge, duplicatedPath };
}

test('an explicit same-path merge survives repeated scans and restart, preserving both archives and undo', async t => {
  const f = await fixture(t), { keeper, donor } = await f.duplicatedPath();
  const initial = await scanLibrary(f.scanOptions);
  assert.equal(initial.failures, 1, 'Unmerged duplicate IDs must not be chosen arbitrarily');
  const originalProfile = await f.readingState.load();
  const merged = await f.merge(keeper, donor);
  const donorAfter = await f.Manga.findByPk(donor.id, { raw: true });
  const restarted = createLibraryOrganizer(f.organizerOptions); await restarted.ready;
  for (let i = 0; i < 2; i++) {
    const result = await scanLibrary({ ...f.scanOptions, getMergedSources: () => restarted.mergedSources() });
    assert.equal(result.failures, 0); assert.equal(result.added, 0);
    const books = await f.books();
    assert.equal(books.length, 2); assert.deepEqual(books.filter(book => !book.hiddenBook).map(book => book.id), [keeper.id]);
    assert.deepEqual(await f.Manga.findByPk(donor.id, { raw: true }), donorAfter);
    assert.deepEqual(await f.readingState.load(), originalProfile);
  }
  await restarted.undo(merged.id);
  assert.deepEqual(await restarted.mergedSources(), {});
  assert.equal((await f.books()).filter(book => !book.hiddenBook).length, 2);
  const afterUndo = await scanLibrary({ ...f.scanOptions, getMergedSources: () => restarted.mergedSources() });
  assert.equal(afterUndo.failures, 1); assert.equal(afterUndo.added, 0);
  await restarted.flush();
});

test('a merged copy at its own path stays hidden and is never reimported as a new book', async t => {
  const f = await fixture(t);
  await f.createBook('First'); await f.createBook('Second');
  await scanLibrary(f.scanOptions);
  const [keeper, donor] = await f.books();
  await f.merge(keeper, donor);
  const before = await f.books();
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 0); assert.equal(result.added, 0); assert.equal(result.unchanged, 2);
  assert.deepEqual(await f.books(), before);
});

test('a merged archive cannot compete with its keeper when the shared book moves again', async t => {
  const f = await fixture(t), { keeper, donor } = await f.duplicatedPath();
  await f.merge(keeper, donor);
  const archived = await f.Manga.findByPk(donor.id, { raw: true });
  const destination = path.join(f.library, 'Moved neutral book');
  await fs.rename(keeper.filepath, destination);
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 0); assert.equal(result.added, 0); assert.equal(result.relocated, 1);
  assert.equal((await f.Manga.findByPk(keeper.id)).filepath, destination);
  assert.deepEqual(await f.Manga.findByPk(donor.id, { raw: true }), archived);
  assert.equal((await f.readingState.load()).progress[keeper.id].page, 2);
  assert.equal((await f.books()).filter(book => !book.hiddenBook).length, 1);
  await f.createBook('New separate copy');
  const added = await scanLibrary(f.scanOptions);
  assert.equal(added.added, 1, 'An archived same-path alias must not capture a newly added physical copy');
  assert.deepEqual(await f.Manga.findByPk(donor.id, { raw: true }), archived);
  assert.equal((await f.books()).filter(book => !book.hiddenBook).length, 2);
});

test('renaming a separate merged source reconnects its own hidden ID without creating a visible duplicate', async t => {
  const f = await fixture(t);
  await f.createBook('First'); await f.createBook('Second');
  await scanLibrary(f.scanOptions);
  const [keeper, donor] = await f.books();
  await f.merge(keeper, donor);
  const destination = path.join(f.library, 'Renamed hidden copy');
  await fs.rename(donor.filepath, destination);
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 0); assert.equal(result.relocated, 1); assert.equal(result.added, 0);
  assert.equal((await f.Manga.findByPk(donor.id)).filepath, destination);
  assert.equal((await f.Manga.findByPk(donor.id)).hiddenBook, true);
  assert.deepEqual((await f.books()).filter(book => !book.hiddenBook).map(book => book.id), [keeper.id]);
  assert.equal((await scanLibrary(f.scanOptions)).unchanged, 2);
});

test('moving both separate merged sources keeps one visible keeper and both original IDs', async t => {
  const f = await fixture(t);
  await f.createBook('First'); await f.createBook('Second');
  await scanLibrary(f.scanOptions);
  const [keeper, donor] = await f.books();
  await f.merge(keeper, donor);
  await fs.rename(keeper.filepath, path.join(f.library, 'Moved first'));
  await fs.rename(donor.filepath, path.join(f.library, 'Moved second'));
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 0); assert.equal(result.relocated, 2); assert.equal(result.added, 0);
  assert.deepEqual(new Set((await f.books()).map(book => book.id)), new Set([keeper.id, donor.id]));
  assert.deepEqual((await f.books()).filter(book => !book.hiddenBook).map(book => book.id), [keeper.id]);
});

test('ordinary hidden records do not become merge aliases merely because their paths match', async t => {
  const f = await fixture(t), { donor } = await f.duplicatedPath();
  await f.Manga.update({ hiddenBook: true }, { where: { id: donor.id } });
  const before = await f.books();
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 1); assert.equal(result.added, 0);
  assert.deepEqual(await f.books(), before);
});

test('a former keeper with same-path aliases remains scannable after it is merged into another path', async t => {
  const f = await fixture(t), { keeper, donor } = await f.duplicatedPath();
  await f.merge(keeper, donor);
  await f.createBook('Separate keeper'); await scanLibrary(f.scanOptions);
  const finalKeeper = (await f.books()).find(book => ![keeper.id, donor.id].includes(book.id));
  await f.merge(finalKeeper, keeper);
  const before = await f.books();
  const result = await scanLibrary(f.scanOptions);
  assert.equal(result.failures, 0); assert.equal(result.added, 0); assert.equal(result.unchanged, 2);
  assert.deepEqual(await f.books(), before);
  assert.deepEqual((await f.books()).filter(book => !book.hiddenBook).map(book => book.id), [finalKeeper.id]);
});

test('undoing a same-path merge during preparation blocks a stale scan without losing either record', async t => {
  const f = await fixture(t), { keeper, donor } = await f.duplicatedPath();
  const merged = await f.merge(keeper, donor);
  const result = await scanLibrary({ ...f.scanOptions, rebuild: false,
    geneCover: async (...args) => { await f.organizer.undo(merged.id); return f.scanOptions.geneCover(...args); },
    forceRefresh: true });
  assert.equal(result.failures, 1); assert.equal(result.added, 0);
  assert.equal((await f.books()).length, 2);
  assert.equal((await f.books()).filter(book => !book.hiddenBook).length, 2);
  assert.equal((await f.readingState.load()).progress[keeper.id].page, 2);
});

test('health offers verified cross-root relocation while preserving unavailable and legacy-source safeguards', async t => {
  const f = await fixture(t);
  await f.createBook('Verified history'); await f.createBook('Legacy history');
  await scanLibrary(f.scanOptions);
  const [verified, legacy] = await f.books();
  await f.Manga.update({ filepath: path.join(f.directory, 'old-computer', 'verified') }, { where: { id: verified.id } });
  await f.Manga.update({ filepath: path.join(f.directory, 'old-computer', 'legacy'), identityFingerprint: null }, { where: { id: legacy.id } });
  const report = await f.organizer.health();
  assert.equal(report.missing, 0); assert.equal(report.unavailable, 2);
  assert.equal(report.issues.find(book => book.id === verified.id).canRelocate, true);
  assert.equal(report.issues.find(book => book.id === legacy.id).canRelocate, false);
});
