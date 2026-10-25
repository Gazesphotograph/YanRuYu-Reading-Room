'use strict';

// Complete backup/restore integration through the real sandboxed preload. Only
// file dialogs and the restart trigger are substituted in this test child.
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, isWithin, sha256, electronExecutable } = require('./project/common.cjs');
const { build } = require('./project/build.cjs');
const { _electron } = require('./playwright-runtime.cjs');

async function main() {
  const reusableBuild = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusableBuild && (!isWithin(path.join(root, '.build'), reusableBuild) || reusableBuild === path.join(root, '.build'))) {
    throw new Error('Backup desktop tests only reuse generated staging directories below .build/.');
  }
  const target = reusableBuild ? { folder: reusableBuild, app: path.join(reusableBuild, 'resources', 'app') } : build();
  const executable = electronExecutable();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-backup-desktop-'));
  const data = path.join(workspace, 'data');
  const library = path.join(workspace, 'library');
  const goodBackup = path.join(workspace, 'synthetic-library.yru-backup');
  const badBackup = path.join(workspace, 'changed-payload.yru-backup');
  const lifecycle = path.join(workspace, 'restart-events.jsonl');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(library, { recursive: true });
  const sharp = require(path.join(target.app, 'node_modules', 'sharp'));
  const AdmZip = require(path.join(target.app, 'node_modules', 'adm-zip'));
  const originals = new Map();
  async function createBook(name, blue) {
    const folder = path.join(library, name);
    fs.mkdirSync(folder);
    for (let page = 1; page <= 4; page++) {
      const filename = path.join(folder, `${page}.png`);
      await sharp({ create: { width: 240, height: 360, channels: 3, background: { r: 50 + page * 20, g: 120, b: blue } } }).png().toFile(filename);
      originals.set(filename, sha256(filename));
    }
    return folder;
  }
  const firstFolder = await createBook('Original neutral book', 150);
  fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({
    library, loadOnStart: false, hideTitleBar: true, closeToTray: false,
    minimizeOnStart: true, minimizeToTray: true, imageExplorer: '',
    autoCheckUpdates: false, pageSize: 42,
  }, null, 2));
  const env = { ...process.env, YANRUYU_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const report = { at: new Date().toISOString(), source: 'real Electron preload and isolated synthetic library', checks: [], errors: [], isolatedData: data };
  const pass = message => { report.checks.push(message); console.log(`PASS ${message}`); };
  let application;
  let page;
  let openPath = goodBackup;

  async function launch({ recovery = false } = {}) {
    application = await _electron.launch({ executablePath: executable, args: [target.app], cwd: target.folder, env, timeout: 45000 });
    // No backup service, database, IPC handler or filesystem operation is mocked.
    await application.evaluate(({ app, dialog }, choices) => {
      const testFs = process.getBuiltinModule('fs');
      app.__yanruyuBackupTestChoices = choices;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: app.__yanruyuBackupTestChoices.savePath });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [app.__yanruyuBackupTestChoices.openPath] });
      app.relaunch = () => testFs.appendFileSync(choices.lifecycle, JSON.stringify({ action: 'relaunch' }) + '\n');
      app.exit = code => {
        testFs.appendFileSync(choices.lifecycle, JSON.stringify({ action: 'exit', code }) + '\n');
        app.quit();
      };
    }, { savePath: goodBackup, openPath, lifecycle });
    page = await application.firstWindow();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.waitForSelector(recovery ? '[data-recovery-mode]' : '#room', { state: 'attached', timeout: 30000 });
  }
  async function close() {
    if (!application) return;
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {});
    application = null;
  }
  async function choose(filename) {
    openPath = filename;
    await application.evaluate(({ app }, filename) => { app.__yanruyuBackupTestChoices.openPath = filename; }, filename);
  }
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.ipcRenderer.invoke(channel, ...args), { channel, args });
  const dataHashes = () => Object.fromEntries(['database.sqlite', 'metadata.sqlite', 'setting.json', 'collectionList.json', 'reading-state.json', 'ui-state.json'].map(name => [name, sha256(path.join(data, name))]));
  function waitForExit() {
    const child = application.process();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('The test Electron process did not exit after restore')), 30000);
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
  }
  async function setProgressAndPreferences(id, progress, theme) {
    await page.evaluate(async ({ id, progress, theme }) => {
      window.readingState.stage(id, progress);
      await window.readingState.flush();
      localStorage.setItem('room-theme', JSON.stringify(theme));
      localStorage.setItem('room-view', JSON.stringify('grid'));
      localStorage.setItem('reading-room-interface', 'room');
      await globalThis.YanruyuClientState.flush();
    }, { id, progress, theme });
  }

  try {
    await launch();
    const actualData = await application.evaluate(({ app }) => app.getPath('userData'));
    assert.equal(actualData, path.join(data, '.reading-room'));
    assert.deepEqual(await invoke('load-book-list', false), []);
    const books = await invoke('load-book-list', true);
    assert.equal(books.length, 1);
    assert.equal(path.resolve(books[0].filepath), firstFolder);
    const first = { ...books[0], title: 'Saved neutral book title', mark: true, readCount: 7 };
    await invoke('save-book', first);
    const savedProgress = { page: 2, total: 4, offset: 0.33, time: 1789280000000, source: 'room' };
    await setProgressAndPreferences(first.id, savedProgress, 'forest');
    pass('Synthetic library, bookmarks and preferences are saved through real preload IPC in a separate data directory');

    const exported = await invoke('backup-export', { includeCovers: true });
    assert.equal(exported.success, true);
    assert.equal(exported.path, goodBackup);
    assert.equal(exported.summary.books, 1);
    assert.equal(exported.summary.readingRecords, 1);
    assert.equal(exported.summary.includesOriginals, false);
    assert.equal(exported.summary.covers, 1);
    assert.ok(fs.statSync(goodBackup).size > 22);
    pass('Native save dialog selection exports a verified backup containing the real database, reading record and cover');

    const badZip = new AdmZip(fs.readFileSync(goodBackup));
    const payload = Buffer.from(badZip.getEntry('reading-state.json').getData());
    payload[payload.length - 1] = payload[payload.length - 1] === 32 ? 10 : 32;
    badZip.updateFile('reading-state.json', payload);
    badZip.writeZip(badBackup);
    const beforeBadPreview = dataHashes();
    await choose(badBackup);
    await assert.rejects(invoke('backup-inspect'), /校验|损坏|不匹配/);
    assert.deepEqual(dataHashes(), beforeBadPreview);
    pass('A ZIP with a tampered payload is rejected during preview and every current data file remains byte-for-byte unchanged');

    await choose(goodBackup);
    const preview = await invoke('backup-inspect');
    assert.equal(preview.canceled, false);
    assert.equal(typeof preview.token, 'string');
    assert.equal(preview.summary.books, 1);
    assert.equal(preview.summary.readingRecords, 1);
    assert.equal(preview.summary.includesCovers, true);
    assert.equal(preview.summary.libraryPath, library);
    pass('The valid backup preview reports the expected library, reading record and cover before restore');

    await createBook('Book added after backup', 205);
    const changedBooks = await invoke('load-book-list', true);
    assert.equal(changedBooks.length, 2);
    const current = changedBooks.find(book => book.id === first.id);
    assert.ok(current, 'The rescan must retain the first book identity');
    await invoke('save-book', { ...current, title: 'Changed after backup', mark: false, readCount: 99 });
    await setProgressAndPreferences(first.id, { page: 4, total: 4, offset: 0, time: 1789290000000, source: 'classic' }, 'acid');
    assert.equal((await invoke('load-reading-state')).progress[first.id].page, 4);
    assert.equal((await invoke('load-ui-state')).values['room-theme'], JSON.stringify('acid'));
    pass('A second book, modified metadata, page four and a different theme create genuinely different current data');

    const exited = waitForExit();
    const restored = await invoke('backup-restore', preview.token);
    assert.equal(restored.restartRequired, true);
    assert.ok(isWithin(data, restored.recoveryPath));
    assert.ok(fs.existsSync(restored.recoveryPath));
    await page.evaluate(() => globalThis.YanruyuClientState.suspend());
    await exited;
    await application.close().catch(() => {});
    application = null;
    const events = fs.readFileSync(lifecycle, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(events.map(event => event.action), ['relaunch', 'exit']);
    pass('Restore creates a real recovery point and requests restart; only the explicitly tracked test child exits');

    await launch();
    const after = await invoke('load-book-list', false);
    assert.equal(after.length, 1);
    assert.equal(after[0].id, first.id);
    assert.equal(after[0].title, first.title);
    assert.equal(after[0].mark, true);
    assert.equal(after[0].readCount, 7);
    assert.ok(isWithin(data, after[0].coverPath));
    pass('Restart restores the original book identity, title, favorite and read count');
    const reading = await invoke('load-reading-state');
    for (const key of ['page', 'total', 'offset', 'time', 'source']) assert.equal(reading.progress[first.id][key], savedProgress[key], key);
    const preferences = await page.evaluate(() => ({ theme: localStorage.getItem('room-theme'), view: localStorage.getItem('room-view'), activeTheme: document.documentElement.dataset.roomTheme }));
    assert.equal(preferences.theme, JSON.stringify('forest'));
    assert.equal(preferences.view, JSON.stringify('grid'));
    assert.equal(preferences.activeTheme, 'forest');
    pass('Restart restores the shared reading profile and applies backed-up preferences over the previous browser state');

    await close();
    const corruptBytes = {
      'database.sqlite': Buffer.from('Deliberately corrupt synthetic SQLite header for the recovery test.\n'),
      'reading-state.json': Buffer.from('{"synthetic-corruption":"unfinished JSON"'),
    };
    for (const [name, bytes] of Object.entries(corruptBytes)) fs.writeFileSync(path.join(data, name), bytes);
    await launch({ recovery: true });
    for (const [name, bytes] of Object.entries(corruptBytes)) assert.deepEqual(fs.readFileSync(path.join(data, name)), bytes);
    await page.getByRole('button', { name: '打开备份与恢复', exact: true }).click();
    await page.waitForSelector('dialog.data-protection-dialog[open]');
    await choose(goodBackup);
    await page.locator('[data-protection="inspect"]').click();
    await page.waitForSelector('[data-protection="restore"]', { state: 'visible', timeout: 30000 });
    assert.match(await page.locator('#protection-status').textContent(), /校验通过/);
    pass('Corrupt SQLite and reading JSON preserve their original bytes while a visible recovery screen can preview a valid backup');

    const recoveryDirectory = path.join(data, '.data-protection', 'restore-points');
    const rawBefore = new Set(fs.readdirSync(recoveryDirectory).filter(name => name.startsWith('raw-')));
    const recoveryExit = waitForExit();
    await page.locator('[data-protection="restore"]').click();
    await recoveryExit;
    await application.close().catch(() => {});
    application = null;
    const rawNames = fs.readdirSync(recoveryDirectory).filter(name => name.startsWith('raw-') && !rawBefore.has(name));
    assert.equal(rawNames.length, 1);
    const rawPoint = path.join(recoveryDirectory, rawNames[0]);
    assert.ok(isWithin(data, rawPoint));
    const rawManifest = JSON.parse(fs.readFileSync(path.join(rawPoint, 'manifest.json'), 'utf8'));
    assert.equal(rawManifest.raw, true);
    assert.equal(rawManifest.status, 'complete');
    for (const [name, bytes] of Object.entries(corruptBytes)) assert.deepEqual(fs.readFileSync(path.join(rawPoint, 'files', name)), bytes);
    assert.ok(fs.existsSync(path.join(rawPoint, 'COMPLETE.json')));
    pass('The recovery panel restores through real IPC and retains byte-identical corrupt originals in a completed raw recovery point');

    await launch();
    const repaired = await invoke('load-book-list', false);
    assert.equal(repaired.length, 1);
    assert.equal(repaired[0].id, first.id);
    assert.equal(repaired[0].title, first.title);
    assert.equal(repaired[0].mark, true);
    assert.equal((await invoke('load-reading-state')).progress[first.id].page, 2);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.roomTheme), 'forest');
    const allEvents = fs.readFileSync(lifecycle, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(allEvents.map(event => event.action), ['relaunch', 'exit', 'relaunch', 'exit']);
    pass('A controlled restart after corrupt-data recovery returns to the original library, reading page and theme');
    for (const [filename, hash] of originals) assert.equal(sha256(filename), hash);
    assert.deepEqual(report.errors, []);
    pass('Every original fixture page is untouched and the renderer reports no JavaScript errors');
  } catch (error) {
    if (page && !page.isClosed()) {
      fs.writeFileSync(path.join(workspace, 'failed-page.html'), await page.content().catch(() => 'unavailable'));
      await page.screenshot({ path: path.join(workspace, 'failed-page.png') }).catch(() => {});
    }
    throw error;
  } finally {
    await close();
    const artifactDir = path.join(root, 'tools', '.artifacts', 'data-protection-desktop');
    fs.mkdirSync(artifactDir, { recursive: true });
    fs.writeFileSync(path.join(workspace, 'checks.json'), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.join(artifactDir, 'checks.json'), JSON.stringify(report, null, 2));
    console.log(`Backup desktop report: ${path.join(artifactDir, 'checks.json')}`);
    const resolved = path.resolve(workspace);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('yanruyu-backup-desktop-') || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe backup desktop fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
