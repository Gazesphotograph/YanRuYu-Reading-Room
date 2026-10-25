'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomUUID, createHash } = require('node:crypto');
const appRequire = createRequire(path.resolve(__dirname, '../resources/app/package.json'));
const { BackupService } = appRequire('./modules/backup_service');
const { prepareMangaModel, prepareMetadataModel } = appRequire('./modules/database');
const { writeClientState, readClientState } = appRequire('./modules/client_state');
const { createStage, controlPath, writeDurable, recoverPendingRestoreSync } = appRequire('./modules/restore_transaction');
const AdmZip = appRequire('adm-zip');
const sqlite3 = appRequire('sqlite3');
const { open } = appRequire('sqlite');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-data-protection-'));
const checks = [];

after(() => {
  const reportDir = path.resolve(__dirname, '.artifacts/data-protection');
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'checks.json'), JSON.stringify({ date: new Date().toISOString(), source: 'isolated SQLite, ZIP and synthetic data', checks }, null, 2));
  // Only the exact randomly-created fixture root is recursively removed.
  assert.equal(path.dirname(fixtureRoot), os.tmpdir());
  assert(path.basename(fixtureRoot).startsWith('yanruyu-data-protection-'));
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

async function makeStore(label) {
  const storePath = path.join(fixtureRoot, label + '-' + randomUUID());
  fs.mkdirSync(path.join(storePath, 'cover'), { recursive: true });
  fs.mkdirSync(path.join(storePath, '.reading-room'));
  const manga = prepareMangaModel(path.join(storePath, 'database.sqlite'));
  const metadata = prepareMetadataModel(path.join(storePath, 'metadata.sqlite'));
  await manga.sync(); await metadata.sync();
  const book = { id: label, hash: 'hash-' + label, filepath: path.join(storePath, 'synthetic-library', 'book'),
    title: 'Neutral fixture ' + label, type: 'folder', pageCount: 20, mark: true,
    hiddenBook: true, readCount: 7, date: 123456789, coverPath: path.join(storePath, 'cover', label + '.webp'),
    tags: { artist: ['Fixture artist'] }, status: 'tagged' };
  await manga.create(book); await metadata.create(book);
  await manga.sequelize.close(); await metadata.sequelize.close();
  fs.writeFileSync(path.join(storePath, 'cover', label + '.webp'), 'neutral cover bytes ' + label);
  fs.writeFileSync(path.join(storePath, 'setting.json'), JSON.stringify({ library: path.join(storePath, 'synthetic-library'), metadataPath: '/previous/location', theme: 'forest', keepReadingProgress: true }));
  fs.writeFileSync(path.join(storePath, 'collectionList.json'), JSON.stringify([{ title: 'Neutral collection', id: 'collection-' + label, list: [book.hash] }]));
  fs.writeFileSync(path.join(storePath, 'reading-state.json'), JSON.stringify({ schemaVersion: 1, pageBase: 1, revision: 1, migrations: { legacyV1: { migratedAt: 123456 } },
    progress: { [label]: { page: 8, total: 20, time: 123456, offset: .25 } },
    migrationSnapshots: [{ source: 'legacy', values: ['keep original'] }] }));
  writeClientState(storePath, { schemaVersion: 1, values: { 'room-theme': '"forest"', 'room-sort': '"author"', viewerReadingProgress: JSON.stringify([{ bookId: label, pageId: label + '_8' }]) } });
  fs.writeFileSync(path.join(storePath, '.reading-room/window-state.json'), JSON.stringify({ width: 1100, height: 800 }));
  return { storePath, book, service: new BackupService({ storePath, appVersion: 'test-1' }) };
}

async function readRows(storePath, table = 'Mangas') {
  const db = await open({ filename: path.join(storePath, table === 'Mangas' ? 'database.sqlite' : 'metadata.sqlite'), driver: sqlite3.Database, mode: sqlite3.OPEN_READONLY });
  try { return await db.all('SELECT * FROM ' + table); } finally { await db.close(); }
}

function fileHash(filename) { return createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
function newBackupName(label) { return path.join(fixtureRoot, label + '-' + randomUUID() + '.yru-backup'); }

test('complete backup restores books, metadata, collections, progress, covers and preferences into an independent store', async () => {
  const source = await makeStore('source'); const target = await makeStore('target');
  const filename = newBackupName('complete');
  const exported = await source.service.createBackup(filename);
  assert.deepEqual([exported.summary.books, exported.summary.metadata, exported.summary.collections, exported.summary.readingRecords, exported.summary.covers], [1, 1, 1, 1, 1]);
  const preview = await target.service.inspectBackup(filename);
  assert.equal(preview.summary.includesOriginals, false);
  let paused = 0;
  const restored = await target.service.restoreBackup(filename, { expectedDigest: preview.digest, beforeCommit: async () => { paused++; } });
  assert.equal(paused, 1); assert.equal(restored.success, true);
  const rows = await readRows(target.storePath);
  assert.equal(rows[0].id, 'source'); assert.equal(rows[0].mark, 1); assert.equal(rows[0].hiddenBook, 1); assert.equal(rows[0].readCount, 7); assert.equal(rows[0].date, 123456789);
  assert.equal(rows[0].coverPath, path.join(target.storePath, 'cover/source.webp'));
  assert.equal(fs.readFileSync(rows[0].coverPath, 'utf8'), 'neutral cover bytes source');
  const reading = JSON.parse(fs.readFileSync(path.join(target.storePath, 'reading-state.json')));
  assert.equal(reading.progress.source.page, 8); assert.equal(reading.progress.source.offset, .25);
  assert.equal(reading.migrationSnapshots[0].source, 'legacy');
  assert.equal(readClientState(target.storePath).values['room-sort'], '"author"');
  assert.match(readClientState(target.storePath).restoreToken, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(target.storePath, 'setting.json'))).metadataPath, '');
  assert.equal((await readRows(target.storePath, 'Metadata'))[0].hash, 'hash-source');
  assert(fs.existsSync(restored.recoveryPath));
  const rollbackPreview = await target.service.inspectBackup(restored.recoveryPath);
  assert.equal(rollbackPreview.summary.books, 1);
  assert.equal((await readRows(source.storePath))[0].id, 'source');
  checks.push('Complete cross-directory restore preserves all requested records and isolates metadata paths.');
});

test('online SQLite snapshots include committed WAL rows while a writer connection remains open', async () => {
  const source = await makeStore('wal');
  const db = await open({ filename: path.join(source.storePath, 'database.sqlite'), driver: sqlite3.Database });
  try {
    await db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0');
    await db.run('UPDATE Mangas SET readCount = 91 WHERE id = ?', 'wal');
    assert(fs.existsSync(path.join(source.storePath, 'database.sqlite-wal')));
    const filename = newBackupName('wal');
    await source.service.createBackup(filename);
    const target = await makeStore('wal-target');
    await target.service.restoreBackup(filename);
    assert.equal((await readRows(target.storePath))[0].readCount, 91);
  } finally { await db.close(); }
  checks.push('Online snapshot includes active WAL commits.');
});

test('checksum tampering and invalid SQLite schemas are rejected before touching existing data', async () => {
  const source = await makeStore('tamper-source'); const target = await makeStore('tamper-target');
  const filename = newBackupName('tamper'); await source.service.createBackup(filename);
  const before = fileHash(path.join(target.storePath, 'database.sqlite'));
  const damaged = new AdmZip(filename);
  damaged.updateFile('reading-state.json', Buffer.from('{}'));
  const damagedPath = newBackupName('damaged'); damaged.writeZip(damagedPath);
  await assert.rejects(target.service.restoreBackup(damagedPath), /校验|大小/);
  assert.equal(fileHash(path.join(target.storePath, 'database.sqlite')), before);
  const badSQLite = new AdmZip(filename);
  const invalidBytes = Buffer.alloc(512, 7);
  const manifest = JSON.parse(badSQLite.readAsText('manifest.json'));
  const entry = manifest.files.find(file => file.name === 'database.sqlite');
  entry.size = invalidBytes.length; entry.sha256 = createHash('sha256').update(invalidBytes).digest('hex');
  badSQLite.updateFile('database.sqlite', invalidBytes);
  badSQLite.updateFile('manifest.json', Buffer.from(JSON.stringify(manifest)));
  const badPath = newBackupName('bad-sqlite'); badSQLite.writeZip(badPath);
  await assert.rejects(target.service.restoreBackup(badPath), /database|SQLite|SQLITE/);
  assert.equal(fileHash(path.join(target.storePath, 'database.sqlite')), before);
  checks.push('Corrupt payload and invalid SQLite fail before any existing data changes.');
});

test('a failure after installing the database rolls back every file and permits reopening the old database', async () => {
  const source = await makeStore('failure-source'); const target = await makeStore('failure-target');
  const filename = newBackupName('failure'); await source.service.createBackup(filename);
  const before = Object.fromEntries(['database.sqlite', 'metadata.sqlite', 'reading-state.json', 'setting.json', 'collectionList.json'].map(name => [name, fileHash(path.join(target.storePath, name))]));
  let rollbackCalls = 0;
  await assert.rejects(target.service.restoreBackup(filename, {
    beforeCommit: async () => {},
    onRollback: async () => { rollbackCalls++; assert.equal((await readRows(target.storePath))[0].id, 'failure-target'); },
    afterInstall: async name => { if (name === 'reading-state.json') throw new Error('simulated disk failure'); },
  }), /simulated disk failure/);
  assert.equal(rollbackCalls, 1);
  for (const [name, digest] of Object.entries(before)) assert.equal(fileHash(path.join(target.storePath, name)), digest);
  assert(fs.existsSync(path.join(target.storePath, 'cover/failure-target.webp')));
  assert(!fs.existsSync(path.join(controlPath(target.storePath), 'restore-journal.json')));
  checks.push('Injected mid-restore failure rolls back byte-for-byte and reopens previous data.');
});

test('startup journal recovers an interrupted multi-file restore before opening SQLite', async () => {
  const target = await makeStore('interrupted');
  const stageRoot = createStage(target.storePath);
  const rollbackRoot = path.join(controlPath(target.storePath), 'rollback-' + randomUUID());
  fs.mkdirSync(rollbackRoot);
  const original = fs.readFileSync(path.join(target.storePath, 'setting.json'));
  writeDurable(path.join(controlPath(target.storePath), 'restore-journal.json'), { schemaVersion: 1,
    phase: 'installing', stageRoot, rollbackRoot,
    entries: [{ name: 'setting.json', beforeExists: true }, { name: 'ui-state.json', beforeExists: true }] });
  fs.renameSync(path.join(target.storePath, 'setting.json'), path.join(rollbackRoot, 'setting.json'));
  fs.writeFileSync(path.join(target.storePath, 'setting.json'), JSON.stringify({ library: 'partially installed' }));
  const result = recoverPendingRestoreSync(target.storePath);
  assert.equal(result.recovered, true);
  assert.deepEqual(fs.readFileSync(path.join(target.storePath, 'setting.json')), original);
  assert.equal((await readRows(target.storePath))[0].id, 'interrupted');
  checks.push('Durable startup journal restores originals after an interrupted rename sequence.');
});

test('a backup changed since its preview is rejected and omitted covers do not delete existing covers', async () => {
  const source = await makeStore('no-covers-source'); const target = await makeStore('no-covers-target');
  const filename = newBackupName('no-covers');
  await source.service.createBackup(filename, { includeCovers: false });
  const preview = await target.service.inspectBackup(filename);
  assert.equal(preview.summary.covers, 0); assert.equal(preview.summary.includesCovers, false);
  await assert.rejects(target.service.restoreBackup(filename, { expectedDigest: '0'.repeat(64) }), /预览后发生变化/);
  assert.equal((await readRows(target.storePath))[0].id, 'no-covers-target');
  await target.service.restoreBackup(filename, { expectedDigest: preview.digest });
  assert(fs.existsSync(path.join(target.storePath, 'cover/no-covers-target.webp')));
  checks.push('Preview digest prevents replacing a selected backup; optional cover exclusion preserves existing files.');
});

test('legacy imports validate first, create a complete recovery point and preserve main-library progress', async () => {
  const source = await makeStore('legacy-source'); const target = await makeStore('legacy-target');
  const files = { collectionListPath: path.join(source.storePath, 'collectionList.json'), metadataSqlitePath: path.join(source.storePath, 'metadata.sqlite') };
  const before = fileHash(path.join(target.storePath, 'database.sqlite'));
  const result = await target.service.restoreLegacy(files);
  assert.equal(result.success, true); assert(fs.existsSync(result.recoveryPath));
  assert.equal(fileHash(path.join(target.storePath, 'database.sqlite')), before);
  assert.equal((await readRows(target.storePath, 'Metadata'))[0].hash, 'hash-legacy-source');
  assert.equal(JSON.parse(fs.readFileSync(path.join(target.storePath, 'reading-state.json'))).progress['legacy-target'].page, 8);
  const invalid = path.join(fixtureRoot, 'invalid-collections.json'); fs.writeFileSync(invalid, '{}');
  await assert.rejects(target.service.restoreLegacy({ ...files, collectionListPath: invalid }), /合集列表/);
  checks.push('Legacy import is validated, protected by a complete recovery point and keeps existing reading progress.');
});

test('backups cannot silently overwrite another backup and client-state accepts only supported preferences', async () => {
  const source = await makeStore('exclusive'); const filename = newBackupName('exclusive');
  await source.service.createBackup(filename); const digest = fileHash(filename);
  await assert.rejects(source.service.createBackup(filename), /同名备份/);
  assert.equal(fileHash(filename), digest);
  assert.throws(() => writeClientState(source.storePath, { schemaVersion: 1, values: { arbitrarySecret: 'never copy' } }), /不支持/);
  assert.throws(() => writeClientState(source.storePath, { schemaVersion: 1, values: { recentRead: '{}' } }), /最近阅读/);
  assert.throws(() => writeClientState(source.storePath, { schemaVersion: 1, values: { expandNodes: 'not-json' } }), /JSON/);
  writeClientState(source.storePath, { schemaVersion: 1, values: { 'room-night': 'true', appTheme: 'forest' } });
  assert.equal(readClientState(source.storePath).values['room-night'], 'true');
  checks.push('Existing backup files are never overwritten; arbitrary origin storage is excluded.');
});

test('valid SQLite containers with missing application fields and incomplete settings fail preflight', async () => {
  const { inspectSQLite, validateJSON } = appRequire('./modules/backup_service');
  const filename = path.join(fixtureRoot, 'incomplete-schema.sqlite');
  const db = await open({ filename, driver: sqlite3.Database });
  await db.exec('CREATE TABLE Mangas (id TEXT PRIMARY KEY, filepath TEXT, title TEXT, coverPath TEXT, hash TEXT, type TEXT, pageCount INTEGER, mark INTEGER, tags TEXT)');
  await db.close();
  await assert.rejects(inspectSQLite(filename, 'library'), /表结构/);
  assert.throws(() => validateJSON('setting.json', {}), /程序设置/);
  checks.push('Incomplete schemas and settings are rejected before replacing usable data.');
});

test('a verified backup can repair corrupt current SQLite and JSON only after retaining the original bytes', async () => {
  const source = await makeStore('repair-source'); const target = await makeStore('repair-target');
  const filename = newBackupName('repair'); await source.service.createBackup(filename);
  const badDatabase = Buffer.from('current database is damaged');
  const badReading = Buffer.from('{invalid-reading-state');
  fs.writeFileSync(path.join(target.storePath, 'database.sqlite'), badDatabase);
  fs.writeFileSync(path.join(target.storePath, 'reading-state.json'), badReading);
  let closed = 0;
  const result = await target.service.restoreBackup(filename, { beforeCommit: async () => { closed++; } });
  assert.equal(closed, 1); assert.equal(result.rawRecovery, true); assert(fs.existsSync(result.recoveryPath));
  assert.equal((await readRows(target.storePath))[0].id, 'repair-source');
  const originals = [];
  const walk = directory => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name); if (entry.isDirectory()) walk(file); else originals.push(fs.readFileSync(file));
  } };
  walk(result.recoveryPath);
  assert(originals.some(value => value.equals(badDatabase)));
  assert(originals.some(value => value.equals(badReading)));
  checks.push('Corrupt current SQLite and reading JSON are repairable after preserving their exact original bytes.');
});
