'use strict';

// Neutral synthetic page bytes and a disposable SQLite database only. Nothing
// here opens Electron, the running app, or the real portable library/profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMangaModel } = require('../resources/app/modules/database');
const { scanLibrary } = require('../resources/app/modules/library_scan');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');

const TEMP_PREFIX = 'yanruyu-reading-relocation-';
const PAGES = ['neutral first page', 'neutral second page', 'neutral third page'];
const SAVED_FIELDS = {
  title: 'Saved display title', title_jpn: 'Saved alternate title', status: 'tagged',
  mark: true, readCount: 8, rating: 4.5, date: 123456789,
  tags: { artist: ['Neutral fixture artist'] }, category: 'Artbook', url: 'https://example.com/book'
};
const PREFERENCES = { mode: 'double', direction: 'rtl', fit: 'width', zoom: 125, coverAlone: false };

async function fixture(t) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const directory = path.resolve(await fs.mkdtemp(path.join(temporaryRoot, TEMP_PREFIX)));
  let Manga;
  t.after(async () => {
    if (Manga) await Manga.sequelize.close();
    if (path.dirname(directory) !== temporaryRoot || !path.basename(directory).startsWith(TEMP_PREFIX)) {
      throw Error('Unsafe fixture cleanup');
    }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const withinFixture = target => {
    const relative = path.relative(directory, path.resolve(target));
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw Error('Fixture operation escaped its temporary directory');
    }
    return target;
  };
  const oldRoot = path.join(directory, 'old-root');
  const newRoot = path.join(directory, 'new-root');
  const coverRoot = path.join(directory, 'covers');
  await fs.mkdir(oldRoot);
  await fs.mkdir(coverRoot);
  Manga = prepareMangaModel(path.join(directory, 'fixture.sqlite'));
  await Manga.sync();
  let idSequence = 0, coverSequence = 0;
  const createBook = async (root, name = 'same-book', contents = PAGES) => {
    const filepath = withinFixture(path.join(root, name));
    await fs.mkdir(filepath, { recursive: true });
    for (let index = 0; index < contents.length; index++) {
      await fs.writeFile(path.join(filepath, `${index + 1}.jpg`), contents[index]);
    }
    return filepath;
  };
  const move = async (source, destination) => fs.rename(withinFixture(source), withinFixture(destination));
  const options = {
    Manga, library: oldRoot, coverRoot,
    getBookFilelist: async root => (await fs.readdir(withinFixture(root), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink())
      .map(entry => ({ filepath: path.join(root, entry.name), type: 'folder' })),
    newId: () => `generated-${++idSequence}`,
    geneCover: async filepath => {
      const names = (await fs.readdir(withinFixture(filepath))).filter(name => /\.jpg$/i.test(name)).sort();
      const stats = await Promise.all(names.map(name => fs.stat(path.join(filepath, name))));
      const coverPath = path.join(coverRoot, `cover-${++coverSequence}.webp`);
      await fs.writeFile(coverPath, 'neutral fixture cover');
      return {
        targetFilePath: path.join(filepath, names[0]), coverPath, pageCount: names.length,
        bundleSize: stats.reduce((sum, stat) => sum + stat.size, 0),
        mtime: (await fs.stat(filepath)).mtime, coverHash: 'neutral-cover-hash'
      };
    },
    // Every book intentionally collides under the legacy one-image hash.
    sampleHash: async () => 'deliberately-colliding-sampled-image-hash'
  };
  const allBooks = () => Manga.findAll({ raw: true, order: [['id', 'ASC']] });
  const scan = (root = oldRoot, overrides = {}) => scanLibrary({ ...options, library: root, ...overrides });
  const importSavedBook = async () => {
    const filepath = await createBook(oldRoot);
    const result = await scan();
    assert.equal(result.failures, 0);
    assert.equal(result.added, 1);
    const imported = await Manga.findOne({ where: { filepath }, raw: true });
    await Manga.update(SAVED_FIELDS, { where: { id: imported.id } });
    const book = await Manga.findByPk(imported.id, { raw: true });
    const reading = createReadingStateStore({ storePath: directory });
    await reading.saveProgress(book.id, { page: 2, total: PAGES.length, offset: .25, time: 100, source: 'room' });
    await reading.savePreferences(book.id, PREFERENCES);
    await reading.flush();
    return { book, profile: await reading.load(), profileBytes: await fs.readFile(reading.filePath) };
  };
  const assertProfilePreserved = async saved => {
    const restarted = createReadingStateStore({ storePath: directory });
    assert.deepEqual(await restarted.load(), saved.profile, 'A fresh reader still resolves the original ID and preferences');
    assert.deepEqual(await fs.readFile(restarted.filePath), saved.profileBytes, 'Scanning must not rewrite reading history');
  };
  return { directory, oldRoot, newRoot, coverRoot, Manga, createBook, move, scan, allBooks, importSavedBook, assertProfilePreserved };
}

function assertSavedFields(book, original) {
  for (const key of Object.keys(SAVED_FIELDS)) assert.deepEqual(book[key], original[key], `Preserve ${key}`);
  assert.equal(book.createdAt, original.createdAt, 'Relocation preserves the original import date');
}

test('moving the entire library root reconnects one ID with its titles, favourites, progress and preferences', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  await f.move(f.oldRoot, f.newRoot);
  await assert.rejects(fs.access(f.oldRoot), { code: 'ENOENT' });
  const destination = path.join(f.newRoot, path.basename(saved.book.filepath));
  const result = await f.scan(f.newRoot);
  const books = await f.allBooks();
  assert.equal(books.length, 1, 'Changing the selected root must not add an unread duplicate');
  assert.equal(result.failures, 0);
  assert.equal(result.relocated, 1);
  assert.equal(result.added, 0);
  assert.equal(books[0].id, saved.book.id);
  assert.equal(books[0].filepath, destination);
  assert.equal(books[0].exist, 1);
  assert.equal(books[0].identityFingerprint, saved.book.identityFingerprint);
  assertSavedFields(books[0], saved.book);
  await fs.access(books[0].coverPath);
  await f.assertProfilePreserved(saved);

  const again = await f.scan(f.newRoot);
  assert.equal(again.changed, false);
  assert.equal(again.unchanged, 1);
  assert.equal(again.added, 0);
  assert.equal(again.relocated, 0);
  assert.deepEqual(await f.allBooks(), books, 'A repeat scan leaves the relocated row unchanged');
  await f.assertProfilePreserved(saved);
});

test('matching folder names, page counts and sampled hashes cannot merge different later pages across roots', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  await f.move(f.oldRoot, f.newRoot);
  const destination = path.join(f.newRoot, path.basename(saved.book.filepath));
  await fs.writeFile(path.join(destination, '2.jpg'), 'a different second page');
  const result = await f.scan(f.newRoot);
  const books = await f.allBooks();
  assert.equal(books.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.relocated, 0);
  assert.equal(result.failures, 0);
  const original = books.find(book => book.id === saved.book.id);
  const discovered = books.find(book => book.filepath === destination);
  assert.equal(original.filepath, saved.book.filepath);
  assert.notEqual(discovered.id, original.id);
  assert.equal(path.basename(discovered.filepath), path.basename(original.filepath));
  assert.equal(discovered.pageCount, original.pageCount);
  assert.equal(discovered.hash, original.hash);
  assert.notEqual(discovered.identityFingerprint, original.identityFingerprint);
  assertSavedFields(original, saved.book);
  await f.assertProfilePreserved(saved);
});

test('an identical copy in a second root stays independent while the original path still exists', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  const destination = await f.createBook(f.newRoot);
  const result = await f.scan(f.newRoot);
  const books = await f.allBooks();
  assert.equal(books.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.relocated, 0);
  assert.equal(result.failures, 0);
  const original = books.find(book => book.id === saved.book.id);
  const copy = books.find(book => book.filepath === destination);
  assert.equal(original.filepath, saved.book.filepath);
  assert.equal(original.exist, 1);
  assert.notEqual(copy.id, original.id);
  assert.equal(copy.identityFingerprint, original.identityFingerprint);
  assert.equal(copy.mark, 0);
  assert.equal(copy.readCount, 0);
  assertSavedFields(original, saved.book);
  await fs.access(original.filepath);
  await fs.access(copy.filepath);
  await f.assertProfilePreserved(saved);
});

test('multiple missing full-fingerprint matches retain separate histories instead of choosing an ID arbitrarily', async t => {
  const f = await fixture(t);
  await f.createBook(f.oldRoot, 'first-history');
  await f.createBook(f.oldRoot, 'second-history');
  await f.scan();
  const originals = await f.allBooks();
  assert.equal(originals.length, 2);
  assert.equal(originals[0].identityFingerprint, originals[1].identityFingerprint);
  for (let index = 0; index < originals.length; index++) {
    await f.Manga.update({ title: `Saved history ${index + 1}`, readCount: index + 4, exist: false },
      { where: { id: originals[index].id } });
  }
  const histories = await f.allBooks();
  await f.move(f.oldRoot, path.join(f.directory, 'parked-root'));
  const destination = await f.createBook(f.newRoot);
  const result = await f.scan(f.newRoot);
  const books = await f.allBooks();
  assert.equal(books.length, 3);
  assert.equal(result.added, 1);
  assert.equal(result.relocated, 0);
  assert.equal(result.failures, 0);
  for (const original of histories) {
    assert.deepEqual(books.find(book => book.id === original.id), original, 'Each ambiguous historical record remains intact');
  }
  const discovered = books.find(book => book.filepath === destination);
  assert.ok(discovered);
  assert.ok(histories.every(book => book.id !== discovered.id));
  assert.equal(discovered.identityFingerprint, histories[0].identityFingerprint);
  assert.equal(discovered.readCount, 0);
});

test('a missing legacy row without a complete fingerprint cannot inherit identity from the sampled hash', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  await f.Manga.update({ identityFingerprint: null }, { where: { id: saved.book.id } });
  await f.move(f.oldRoot, f.newRoot);
  const result = await f.scan(f.newRoot);
  const books = await f.allBooks();
  assert.equal(books.length, 2);
  assert.equal(result.added, 1);
  assert.equal(result.relocated, 0);
  assert.equal(result.failures, 0);
  const original = books.find(book => book.id === saved.book.id);
  const discovered = books.find(book => book.id !== saved.book.id);
  assert.equal(original.filepath, saved.book.filepath);
  assert.equal(original.identityFingerprint, null);
  assert.equal(discovered.filepath, path.join(f.newRoot, path.basename(saved.book.filepath)));
  assert.equal(discovered.hash, original.hash);
  assert.equal(discovered.pageCount, original.pageCount);
  assert.match(discovered.identityFingerprint, /^folder-sha256-v1:[0-9a-f]{64}$/);
  assertSavedFields(original, saved.book);
  await f.assertProfilePreserved(saved);
});

test('a source path restored after preparation blocks relocation before commit without losing either directory', async t => {
  for (const [name, restoredPages] of [
    ['same contents restored', PAGES],
    ['path occupied by different contents', ['unrelated first page', 'unrelated second page', 'unrelated third page']]
  ]) {
    await t.test(name, async t => {
      const f = await fixture(t), saved = await f.importSavedBook();
      await f.move(f.oldRoot, f.newRoot);
      const destination = path.join(f.newRoot, path.basename(saved.book.filepath));
      let beforeCommitCalls = 0;
      const result = await f.scan(f.newRoot, { beforeCommit: async () => {
        beforeCommitCalls++;
        await f.createBook(f.oldRoot, path.basename(saved.book.filepath), restoredPages);
      } });
      assert.equal(beforeCommitCalls, 1);
      assert.equal(result.failures, 1, 'A stale relocation must be rejected, not applied to a now-live original');
      assert.equal(result.relocated, 0);
      assert.equal(result.added, 0);
      const retained = await f.allBooks();
      assert.equal(retained.length, 1);
      assert.deepEqual(retained[0], saved.book, 'The original ID, path, cover and metadata remain intact');
      assert.equal(await fs.readFile(path.join(saved.book.filepath, '1.jpg'), 'utf8'), restoredPages[0]);
      assert.equal(await fs.readFile(path.join(destination, '1.jpg'), 'utf8'), PAGES[0]);
      await f.assertProfilePreserved(saved);

      const retry = await f.scan(f.newRoot);
      assert.equal(retry.added, 1, 'A later scan can import the second location as an independent book');
      assert.equal(retry.relocated, 0);
      assert.equal(retry.failures, 0);
      const books = await f.allBooks();
      assert.equal(books.length, 2);
      const original = books.find(book => book.id === saved.book.id);
      const copy = books.find(book => book.filepath === destination);
      assert.equal(original.filepath, saved.book.filepath);
      assert.notEqual(copy.id, original.id);
      assert.equal(copy.readCount, 0);
      assertSavedFields(original, saved.book);
      await f.assertProfilePreserved(saved);
    });
  }
});

test('a target claimed by another record after preparation preserves both records and the old reading identity', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  await f.move(f.oldRoot, f.newRoot);
  const destination = path.join(f.newRoot, path.basename(saved.book.filepath));
  const competingId = 'concurrent-target';
  let competing;
  const result = await f.scan(f.newRoot, { beforeCommit: async () => {
    await f.Manga.create({ ...saved.book, id: competingId, filepath: destination,
      title: 'Separately registered target', readCount: 13, mark: false });
    competing = await f.Manga.findByPk(competingId, { raw: true });
  } });
  assert.equal(result.failures, 1);
  assert.equal(result.relocated, 0);
  assert.equal(result.added, 0);
  const books = await f.allBooks();
  assert.equal(books.length, 2);
  assert.deepEqual(books.find(book => book.id === saved.book.id), saved.book);
  assert.deepEqual(books.find(book => book.id === competingId), competing);
  assert.equal(new Set(books.map(book => book.filepath)).size, 2, 'No pair of records acquires the same path');
  assert.equal(await fs.readFile(path.join(destination, '1.jpg'), 'utf8'), PAGES[0]);
  await f.assertProfilePreserved(saved);
});

test('a disconnected directory link cannot masquerade as an absent previous library root', async t => {
  const f = await fixture(t), saved = await f.importSavedBook();
  await f.move(f.oldRoot, f.newRoot);
  await fs.symlink(path.join(f.directory, 'unavailable-link-target'), f.oldRoot, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await f.scan(f.newRoot);
  assert.equal(result.relocated, 0); assert.equal(result.added, 1); assert.equal(result.failures, 0);
  assert.deepEqual(await f.Manga.findByPk(saved.book.id, { raw: true }), saved.book);
  await f.assertProfilePreserved(saved);
});
