'use strict';

// Synthetic books and SQLite databases live only in a fresh OS temp directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { prepareMangaModel } = require('../resources/app/modules/database');
const { scanLibrary, relocateMissingBook } = require('../resources/app/modules/library_scan');
const { TaskService } = require('../resources/app/modules/task_service');
const { mergeBookEdits } = require('../resources/app/modules/library_edits');
const { sourceSignature } = require('../resources/app/modules/source_signature');
const { fingerprintBook } = require('../resources/app/modules/library_identity');
const { serialQueue } = require('../resources/app/modules/safety');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-phase2-tasks-'));
  const library = path.join(directory, 'library'), coverRoot = path.join(directory, 'covers');
  await fs.mkdir(library); await fs.mkdir(coverRoot);
  const Manga = prepareMangaModel(path.join(directory, 'fixture.sqlite'));
  await Manga.sync();
  const services = [];
  t.after(async () => {
    for (const service of services) { await service.stopAll(); if (service.notifyTimer) clearTimeout(service.notifyTimer); }
    await Manga.sequelize.close();
    if (!directory.startsWith(path.join(os.tmpdir(), 'yanruyu-phase2-tasks-'))) throw Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  });
  let sequence = 0, coverCalls = 0;
  const entries = [];
  const add = async (name, type = 'folder') => {
    const filepath = path.join(library, name);
    if (type === 'folder') {
      await fs.mkdir(filepath, { recursive: true });
      await fs.writeFile(path.join(filepath, '1.jpg'), 'neutral first page');
      await fs.writeFile(path.join(filepath, '2.jpg'), 'neutral second page');
    } else await fs.writeFile(filepath, 'neutral synthetic archive bytes');
    const entry = { filepath, type }; entries.push(entry); return entry;
  };
  const geneCover = async (filepath, type) => {
    coverCalls++;
    const coverPath = path.join(coverRoot, `cover-${++sequence}.webp`);
    await fs.writeFile(coverPath, 'neutral cover');
    const pages = type === 'folder' ? (await fs.readdir(filepath)).filter(name => /\.jpg$/.test(name)) : ['archive'];
    const stat = await fs.stat(filepath);
    return { targetFilePath: type === 'folder' ? path.join(filepath, pages[0]) : filepath,
      coverPath, pageCount: pages.length, bundleSize: stat.size, mtime: stat.mtime, coverHash: 'neutral-' + sequence };
  };
  const options = { Manga, library, coverRoot, getBookFilelist: async () => entries.slice(), geneCover, newId: () => `book-${++sequence}` };
  const service = (config = {}) => { const value = new TaskService({ storePath: directory, ...config }); services.push(value); return value; };
  return { directory, library, coverRoot, Manga, entries, add, options, geneCover, service, get coverCalls() { return coverCalls; } };
}

test('incremental scans detect added, removed and edited pages at the same path without resetting user fields', async t => {
  const f = await fixture(t), entry = await f.add('neutral');
  await scanLibrary(f.options);
  const original = (await f.Manga.findAll())[0].toJSON();
  await f.Manga.update({ title: 'My title', mark: true, hiddenBook: true, readCount: 8 }, { where: { id: original.id } });
  await fs.writeFile(path.join(entry.filepath, '3.jpg'), 'new neutral page');
  const added = await scanLibrary(f.options);
  const refreshed = (await f.Manga.findByPk(original.id)).toJSON();
  assert.equal(added.updated, 1); assert.equal(refreshed.pageCount, 3);
  assert.notEqual(refreshed.coverPath, original.coverPath);
  assert.notEqual(refreshed.identityFingerprint, original.identityFingerprint);
  assert.equal(refreshed.title, 'My title'); assert.equal(refreshed.readCount, 8);
  assert.equal(refreshed.mark, true); assert.equal(refreshed.hiddenBook, true);
  const calls = f.coverCalls;
  const unchanged = await scanLibrary({ ...f.options, fingerprint: () => { throw Error('Unchanged files must not be hashed'); } });
  assert.equal(unchanged.unchanged, 1); assert.equal(unchanged.changed, false); assert.equal(f.coverCalls, calls);
  await fs.unlink(path.join(entry.filepath, '3.jpg'));
  await scanLibrary(f.options);
  assert.equal((await f.Manga.findByPk(original.id)).pageCount, 2);
  const beforeEdit = (await f.Manga.findByPk(original.id)).sourceSignature;
  await fs.writeFile(path.join(entry.filepath, '1.jpg'), 'changed neutral first page');
  await scanLibrary(f.options);
  assert.notEqual((await f.Manga.findByPk(original.id)).sourceSignature, beforeEdit);
});

test('archive replacement at the same filename refreshes its signature and complete identity', async t => {
  const f = await fixture(t), entry = await f.add('neutral.zip', 'zip');
  await scanLibrary(f.options);
  const before = (await f.Manga.findAll())[0].toJSON();
  await fs.writeFile(entry.filepath, 'a replaced neutral archive with changed bytes');
  await scanLibrary(f.options);
  const after = (await f.Manga.findByPk(before.id)).toJSON();
  assert.notEqual(after.sourceSignature, before.sourceSignature);
  assert.notEqual(after.identityFingerprint, before.identityFingerprint);
  assert.notEqual(after.coverPath, before.coverPath);
  assert.equal(await f.Manga.count(), 1);
});

test('an empty but readable library marks confirmed missing books without removing records or covers', async t => {
  const f = await fixture(t), entry = await f.add('last-book'); await scanLibrary(f.options);
  const original = (await f.Manga.findAll())[0].toJSON();
  await fs.rename(entry.filepath, path.join(f.directory, 'temporarily-moved')); f.entries.length = 0;
  const result = await scanLibrary(f.options);
  assert.equal(result.changed, true); assert.equal(await f.Manga.count(), 1);
  const missing = (await f.Manga.findByPk(original.id)).toJSON();
  assert.equal(missing.exist, false); assert.equal(missing.coverPath, original.coverPath);
  await fs.access(original.coverPath);
  await f.Manga.update({ exist: true }, { where: { id: original.id } });
  const excluded = await scanLibrary({ ...f.options, excludeFile: 'last-book' });
  assert.equal(excluded.changed, false); assert.equal((await f.Manga.findByPk(original.id)).exist, true);
  await assert.rejects(scanLibrary({ ...f.options, library: path.join(f.directory, 'unavailable-drive') }), { code: 'ENOENT' });
  assert.equal((await f.Manga.findByPk(original.id)).exist, true);
});

test('a damaged book does not stop the rest of an incremental batch or remove its previous record', async t => {
  const f = await fixture(t), broken = await f.add('broken'); await f.add('good');
  await scanLibrary(f.options);
  const original = await f.Manga.findOne({ where: { filepath: broken.filepath }, raw: true });
  await fs.writeFile(path.join(broken.filepath, '3.jpg'), 'change');
  await f.add('new-good');
  const errors = [];
  const result = await scanLibrary({ ...f.options, onError: error => errors.push(error), geneCover: async (filepath, type) => {
    if (filepath === broken.filepath) throw Error('synthetic image decode failure'); return f.geneCover(filepath, type);
  } });
  assert.equal(result.failures, 1); assert.equal(result.added, 1); assert.equal(errors.length, 1);
  assert.match(errors[0].message, /decode/); assert.equal(await f.Manga.count(), 3);
  assert.deepEqual(await f.Manga.findByPk(original.id, { raw: true }), original);
});

test('cancelling saves completed incremental books and retrying skips those books', async t => {
  const f = await fixture(t); await f.add('one'); await f.add('two'); await f.add('three');
  const controller = new AbortController();
  const result = await scanLibrary({ ...f.options, signal: controller.signal, onItem: value => {
    if (value.phase === 'inspect' && value.current === 1) controller.abort();
  } });
  assert.equal(result.cancelled, true); assert.equal(result.added, 1); assert.equal(await f.Manga.count(), 1);
  const retry = await scanLibrary(f.options);
  assert.equal(retry.added, 2); assert.equal(retry.unchanged, 1); assert.equal(await f.Manga.count(), 3);
  assert.equal(f.coverCalls, 3);
});

test('cancelling a full rebuild preserves all original rows and removes staged covers', async t => {
  const f = await fixture(t); await f.add('one'); await f.add('two');
  await scanLibrary(f.options);
  const before = await f.Manga.findAll({ raw: true }), covers = (await fs.readdir(f.coverRoot)).sort();
  const controller = new AbortController();
  const result = await scanLibrary({ ...f.options, rebuild: true, signal: controller.signal, onItem: value => {
    if (value.phase === 'inspect' && value.current === 1) controller.abort();
  } });
  assert.equal(result.cancelled, true); assert.equal(result.changed, false);
  assert.deepEqual(await f.Manga.findAll({ raw: true }), before);
  assert.deepEqual((await fs.readdir(f.coverRoot)).sort(), covers);
});

test('a full rebuild cancelled while waiting to commit or during its transaction leaves the original rows intact', async t => {
  const f = await fixture(t); await f.add('one'); await f.add('two'); await scanLibrary(f.options);
  const before = await f.Manga.findAll({ raw: true }), covers = (await fs.readdir(f.coverRoot)).sort();
  const queued = new AbortController();
  const queuedResult = await scanLibrary({ ...f.options, rebuild: true, signal: queued.signal, beforeCommit: () => queued.abort() });
  assert.equal(queuedResult.cancelled, true); assert.equal(queuedResult.changed, false);
  assert.deepEqual(await f.Manga.findAll({ raw: true }), before);
  assert.deepEqual((await fs.readdir(f.coverRoot)).sort(), covers);
  const writing = new AbortController(), update = f.Manga.update.bind(f.Manga);
  f.Manga.update = async (...args) => { const result = await update(...args); writing.abort(); return result; };
  const transactionResult = await scanLibrary({ ...f.options, rebuild: true, signal: writing.signal });
  f.Manga.update = update;
  assert.equal(transactionResult.cancelled, true); assert.equal(transactionResult.changed, false);
  assert.deepEqual(await f.Manga.findAll({ raw: true }), before);
  assert.deepEqual((await fs.readdir(f.coverRoot)).sort(), covers);
});

test('scan preparation does not hold the write queue and merges concurrent reading and user edits', async t => {
  const f = await fixture(t), entry = await f.add('one'); await scanLibrary(f.options);
  const original = (await f.Manga.findAll())[0]; await fs.writeFile(path.join(entry.filepath, '3.jpg'), 'change');
  const queue = serialQueue(), started = deferred(), release = deferred();
  const scanning = scanLibrary({ ...f.options, commit: queue, geneCover: async (...args) => {
    started.resolve(); await release.promise; return f.geneCover(...args);
  } });
  await started.promise;
  await queue(async () => {
    const reading = createReadingStateStore({ storePath: f.directory });
    await reading.saveProgress(original.id, { page: 2, total: 3, time: Date.now() });
    await f.Manga.update({ mark: true, readCount: 9, title: 'Edited during scan' }, { where: { id: original.id } });
  });
  release.resolve(); await scanning;
  const after = await f.Manga.findByPk(original.id);
  assert.equal(after.mark, true); assert.equal(after.readCount, 9); assert.equal(after.title, 'Edited during scan'); assert.equal(after.pageCount, 3);
  assert.equal((await createReadingStateStore({ storePath: f.directory }).load()).progress[original.id].page, 2);
});

test('a concurrently deleted record is not resurrected by the prepared scan', async t => {
  const f = await fixture(t), entry = await f.add('one'); await scanLibrary(f.options);
  const original = (await f.Manga.findAll())[0]; await fs.writeFile(path.join(entry.filepath, '3.jpg'), 'change');
  const result = await scanLibrary({ ...f.options, geneCover: async (...args) => {
    await f.Manga.destroy({ where: { id: original.id } }); return f.geneCover(...args);
  } });
  assert.equal(result.failures, 1); assert.equal(await f.Manga.count(), 0);
  assert.equal((await fs.readdir(f.coverRoot)).length, 1, 'Only the existing pre-scan cover is retained');
});

test('stale reader saves cannot overwrite a scan result and explicit approved custom covers still work', async t => {
  const f = await fixture(t), entry = await f.add('one'); await scanLibrary(f.options);
  const stale = (await f.Manga.findAll())[0].toJSON();
  await fs.writeFile(path.join(entry.filepath, '3.jpg'), 'neutral appended page'); await scanLibrary(f.options);
  const refreshed = (await f.Manga.findByPk(stale.id)).toJSON();
  const edit = mergeBookEdits(refreshed, { ...stale, mark: true, readCount: 9 });
  await f.Manga.update(edit, { where: { id: edit.id } });
  const saved = (await f.Manga.findByPk(stale.id)).toJSON();
  for (const field of ['coverPath', 'pageCount', 'hash', 'bundleSize', 'mtime', 'coverHash', 'identityFingerprint', 'sourceSignature']) {
    assert.equal(saved[field], refreshed[field], field);
  }
  assert.equal(saved.mark, true); assert.equal(saved.readCount, 9); await fs.access(saved.coverPath);
  const custom = mergeBookEdits(saved, { ...stale, coverPath: 'untrusted-cover' }, { coverPath: 'approved-cover', coverHash: 'approved-hash' });
  assert.equal(custom.coverPath, 'approved-cover'); assert.equal(custom.coverHash, 'approved-hash'); assert.equal(custom.pageCount, 3);
});

test('a file changed while its cover is generated is rejected and leaves no staged cover', async t => {
  const f = await fixture(t), entry = await f.add('one');
  const result = await scanLibrary({ ...f.options, geneCover: async (...args) => {
    const generated = await f.geneCover(...args); await fs.writeFile(path.join(entry.filepath, '3.jpg'), 'concurrent change'); return generated;
  } });
  assert.equal(result.failures, 1); assert.equal(await f.Manga.count(), 0);
  assert.deepEqual(await fs.readdir(f.coverRoot), []);
});

test('manual relocation preserves the ID and reading archive and rejects different content', async t => {
  const f = await fixture(t), entry = await f.add('before'); await scanLibrary(f.options);
  const original = (await f.Manga.findAll())[0];
  await f.Manga.update({ mark: true, hiddenBook: true, readCount: 7 }, { where: { id: original.id } });
  const reading = createReadingStateStore({ storePath: f.directory }); await reading.saveProgress(original.id, { page: 2, total: 2 });
  const destination = path.join(f.library, 'after'); await fs.rename(entry.filepath, destination);
  const options = { ...f.options, bookId: original.id, filepath: destination };
  const relocated = await relocateMissingBook(options);
  assert.equal(relocated.id, original.id); assert.equal(relocated.filepath, destination); assert.equal(relocated.readCount, 7);
  assert.equal(relocated.hiddenBook, true); assert.equal((await reading.load()).progress[original.id].page, 2);
  const next = path.join(f.library, 'different'); await fs.rename(destination, next); await fs.writeFile(path.join(next, '1.jpg'), 'different book');
  await assert.rejects(relocateMissingBook({ ...options, filepath: next }), /内容不一致/);
  assert.equal((await f.Manga.findByPk(original.id)).filepath, destination);
});

test('manual relocation rejects a still-present original and an already occupied target', async t => {
  const f = await fixture(t), entry = await f.add('original'); const copy = await f.add('copy'); await scanLibrary(f.options);
  const original = await f.Manga.findOne({ where: { filepath: entry.filepath } });
  const options = { ...f.options, bookId: original.id, filepath: copy.filepath };
  await assert.rejects(relocateMissingBook(options), /原路径仍存在/);
  await fs.rename(entry.filepath, path.join(f.directory, 'outside-original'));
  await assert.rejects(relocateMissingBook(options), /已有独立书目/);
  assert.equal(await f.Manga.count(), 2);
});

test('task lanes serialize batches, cancel a queued task, and retain independent extraction progress', async t => {
  const f = await fixture(t), service = f.service();
  const hold = deferred(), entered = deferred(), calls = [];
  service.register('scan', async (params, task) => {
    calls.push(params.label); task.report({ current: 1, total: 4, phase: 'scan' }); entered.resolve(); await hold.promise;
    task.checkpoint(); return { added: 1, changed: true };
  }, { lane: 'library', title: 'Synthetic scan' });
  service.register('extract', async (_params, task) => { task.report({ current: 1, total: 1 }); return []; });
  const first = await service.start('scan', { label: 'first' }); await entered.promise;
  const queued = await service.start('scan', { label: 'queued' });
  const extraction = await service.start('extract', {}); await service.wait(extraction.id);
  assert.equal((await service.list()).find(task => task.id === first.id).progress, .25);
  await service.cancel(queued.id); hold.resolve(); await service.wait(first.id);
  assert.deepEqual(calls, ['first']);
  assert.equal((await service.list()).find(task => task.id === queued.id).status, 'cancelled');
  const retried = await service.retry(queued.id); await service.wait(retried.id); assert.deepEqual(calls, ['first', 'queued']);
});

test('task cancellation is observable, failures expose details, and only retryable states can retry', async t => {
  const f = await fixture(t), service = f.service(); const entered = deferred();
  service.register('scan', (_params, task) => new Promise((resolve, reject) => {
    entered.resolve(); task.signal.addEventListener('abort', () => { try { task.checkpoint(); } catch (error) { reject(error); } }, { once: true });
  }));
  const task = await service.start('scan', {}); await entered.promise; await service.cancel(task.id);
  await assert.rejects(service.wait(task.id), { name: 'AbortError' });
  assert.equal((await service.list())[0].status, 'cancelled');
  service.register('scan', async (_params, ctx) => { ctx.error({ filepath: 'neutral.zip', message: 'synthetic damage' }); return { failures: 1 }; });
  const retry = await service.retry(task.id); await service.wait(retry.id);
  const state = (await service.list()).find(item => item.id === retry.id);
  assert.equal(state.status, 'completed-with-errors'); assert.equal(state.errors[0].filepath, 'neutral.zip'); assert.equal(state.errorCount, 1);
  service.register('success', async () => ({ changed: false }));
  const done = await service.start('success'); await service.wait(done.id);
  await assert.rejects(service.retry(done.id), /不能重试/);
});

test('interrupted task history is retryable after restart without resuming mutations automatically', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'task-state.json'), JSON.stringify({ version: 1, tasks: [
    { id: 'interrupted', kind: 'scan', title: 'Synthetic scan', status: 'running', params: { rebuild: false }, errors: [], createdAt: 1 }
  ] }));
  const service = f.service(); let called = false;
  service.register('scan', async () => { called = true; return { changed: false }; });
  const records = await service.list(); assert.equal(records[0].status, 'interrupted'); assert.equal(records[0].canRetry, true); assert.equal(called, false);
  const retry = await service.retry('interrupted'); await service.wait(retry.id); assert.equal(called, true);
  await service.persist();
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'task-state.json'), 'utf8'));
  assert.equal(disk.tasks.find(record => record.id === retry.id).status, 'completed');
});

test('a task whose admission could not be persisted never runs when another task is started', async t => {
  const f = await fixture(t), service = f.service(); await service.ready;
  const persist = service.persist.bind(service), calls = [];
  service.register('scan', async params => { calls.push(params.label); return { changed: true }; });
  service.persist = async () => { throw Error('synthetic admission disk failure'); };
  await assert.rejects(service.start('scan', { label: 'reported-failed' }), /admission disk/);
  service.persist = persist;
  const valid = await service.start('scan', { label: 'valid' }); await service.wait(valid.id);
  assert.deepEqual(calls, ['valid']); assert.equal((await service.list()).length, 1);
});

test('concurrent retries of an interrupted persisted task coalesce into exactly one execution', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.directory, 'task-state.json'), JSON.stringify({ version: 1, tasks: [
    { id: 'previous', kind: 'scan', title: 'Synthetic scan', status: 'running', params: { rebuild: false }, errors: [], createdAt: 1 }
  ] }));
  const service = f.service(); let calls = 0; const release = deferred();
  service.register('scan', async () => { calls++; await release.promise; return { changed: false }; });
  const [first, second] = await Promise.all([service.retry('previous'), service.retry('previous')]);
  assert.equal(first.id, second.id); release.resolve(); await service.wait(first.id); assert.equal(calls, 1);
  const disk = JSON.parse(await fs.readFile(path.join(f.directory, 'task-state.json'), 'utf8'));
  assert.equal(disk.tasks.find(record => record.id === first.id).key, 'retry:previous');
});

test('fingerprinting and source signatures respond to an already cancelled task', async t => {
  const f = await fixture(t), entry = await f.add('neutral');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(sourceSignature(entry.filepath, 'folder', { signal: controller.signal }), { name: 'AbortError' });
  await assert.rejects(fingerprintBook(entry.filepath, 'folder', { signal: controller.signal }), { name: 'AbortError' });
});
