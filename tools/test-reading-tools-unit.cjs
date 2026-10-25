'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createReadingStateStore, normalizePreferences, writeAtomic } = require('../resources/app/modules/reading_state');
const rules = fs.readFile(path.join(__dirname, '../resources/app/dist/room-reader-tools.js'), 'utf8')
  .then(source => import('data:text/javascript;base64,' + Buffer.from(source).toString('base64')));

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-reader-tools-unit-'));
  t.after(async () => {
    assert(directory.startsWith(path.join(os.tmpdir(), 'yanruyu-reader-tools-unit-')));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('double-page grouping keeps the cover, wide artwork and odd final page readable', async () => {
  const { buildReaderSpreads, readerSpreadIndex, readerTurnTarget } = await rules;
  const dimensions = new Map([[4, 1.7], [8, 1.3]]);
  const spreads = buildReaderSpreads(11, dimensions);
  assert.deepEqual(spreads, [[1], [2, 3], [4], [5, 6], [7], [8], [9, 10], [11]]);
  assert.equal(readerSpreadIndex(spreads, 10), 6);
  assert.equal(readerTurnTarget(10, 11, -1, spreads), 8);
  assert.equal(readerTurnTarget(10, 11, 1, spreads), 11);
  assert.equal(readerTurnTarget(11, 11, 1, spreads), 11);
  assert.deepEqual(buildReaderSpreads(4, new Map(), { coverAlone: false }), [[1, 2], [3, 4]]);
  assert.deepEqual(buildReaderSpreads(1, new Map()), [[1]]);
  assert.deepEqual(buildReaderSpreads(0), []);
});

test('RTL reverses horizontal navigation without changing one-based progress or vertical reading', async () => {
  const { readerHorizontalDirection, readerTurnTarget } = await rules;
  assert.equal(readerHorizontalDirection('ArrowLeft', 'ltr'), -1);
  assert.equal(readerHorizontalDirection('ArrowLeft', 'rtl'), 1);
  assert.equal(readerHorizontalDirection('ArrowRight', 'rtl'), -1);
  assert.equal(readerHorizontalDirection('ArrowDown', 'rtl'), 0);
  assert.equal(readerTurnTarget(1, 9, -1), 1);
  assert.equal(readerTurnTarget(5, 9, 1), 6);
});

test('renderer preferences bound magnification and do not inherit invalid book settings', async () => {
  const { normalizeReaderPreferences } = await rules;
  assert.deepEqual(normalizeReaderPreferences(undefined, { mode: 'continuous' }),
    { mode: 'continuous', direction: 'ltr', fit: 'page', zoom: 100, coverAlone: true });
  assert.equal(normalizeReaderPreferences({ zoom: 900 }).zoom, 250);
  assert.equal(normalizeReaderPreferences({ zoom: -100 }).zoom, 50);
  assert.equal(normalizeReaderPreferences({ mode: 'unknown', zoom: NaN }).mode, 'paged');
});

test('old version-one profiles gain per-book preferences without modifying migration originals', async t => {
  const directory = await fixture(t), filename = path.join(directory, 'reading-state.json');
  const old = { schemaVersion: 1, pageBase: 1, revision: 3, progress: { book: { page: 10, total: 12, time: 3, offset: .32 } },
    migrations: { legacyV1: { migratedAt: 2 } }, migrationSnapshots: [{ storage: { untouched: 'original migration text' } }] };
  await fs.writeFile(filename, JSON.stringify(old));
  const original = await fs.readFile(filename);
  const store = createReadingStateStore({ storePath: directory });
  assert.deepEqual((await store.load()).preferences, {});
  assert.deepEqual(await fs.readFile(filename), original, 'Loading must not rewrite old profiles');
  const preferences = { mode: 'double', direction: 'rtl', fit: 'width', zoom: 125, coverAlone: false };
  await Promise.all([
    store.savePreferences('book', preferences),
    store.saveProgress('book', { page: 11, total: 12, offset: .2, time: 100 }),
    store.savePreferences('other-book', { mode: 'continuous' }),
  ]);
  const restarted = createReadingStateStore({ storePath: directory }), snapshot = await restarted.load();
  assert.deepEqual(snapshot.preferences.book, preferences);
  assert.equal(snapshot.preferences['other-book'].mode, 'continuous');
  assert.equal(snapshot.progress.book.page, 11);
  assert.deepEqual(JSON.parse(await fs.readFile(filename, 'utf8')).migrationSnapshots, old.migrationSnapshots);
});

test('invalid preferences and failed writes preserve the last good disk and memory state', async t => {
  const directory = await fixture(t);
  let failWrite = false;
  const store = createReadingStateStore({ storePath: directory, write: async (filename, value) => {
    if (failWrite) throw Error('Synthetic disk failure');
    return writeAtomic(filename, value);
  } });
  await store.savePreferences('book', { mode: 'double' });
  const good = await store.load(), bytes = await fs.readFile(store.filePath);
  for (const value of [{ zoom: Infinity }, { zoom: 251 }, { mode: 'invalid' }, { direction: 'up' }, { coverAlone: 'yes' }, { unexpected: true }, null]) {
    assert.throws(() => normalizePreferences(value));
    await assert.rejects(store.savePreferences('book', value));
  }
  await assert.rejects(store.savePreferences('__proto__', { mode: 'continuous' }));
  failWrite = true;
  await assert.rejects(store.savePreferences('book', { mode: 'continuous' }), /Synthetic disk failure/);
  assert.deepEqual(await store.load(), good);
  assert.deepEqual(await fs.readFile(store.filePath), bytes);
  failWrite = false;
  await store.savePreferences('book', { mode: 'continuous' });
  assert.equal((await store.load()).preferences.book.mode, 'continuous');
});
