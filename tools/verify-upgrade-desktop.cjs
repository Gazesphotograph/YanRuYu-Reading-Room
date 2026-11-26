'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { fs, path, root, isWithin, sha256, listSourceFiles } = require('./project/common.cjs');
const { auditRelease } = require('./project/audit.cjs');
const { _electron } = require('./playwright-runtime.cjs');

const stableHash = '323f690f22668fac93f94ec4baef709334563647a8379a0381f1145d1f61f87c';
const executable = 'exhentai-manga-manager.exe';
const note = 'The quiet garden bridge is surrounded by birch trees.';
const readJson = filename => JSON.parse(fs.readFileSync(filename, 'utf8'));
const pointer = name => readJson(path.join(root, '.build', name));

function prepareRuntime(program) {
  const app = path.join(program, 'resources', 'app');
  const filename = path.join(app, 'package.json');
  const pkg = readJson(filename);
  // The only entry-point change in the temporary release copies is a bootstrap
  // that redirects Electron's system paths and checks the real path resolver
  // before either application can open a database or its browser profile.
  fs.writeFileSync(path.join(app, 'upgrade-fixture.cjs'), `
const assert = require('node:assert/strict');
const path = require('node:path');
const { app } = require('electron');
const { mode, store, systemStore, downloads } = JSON.parse(process.env.YANRUYU_UPGRADE_FIXTURE);
assert.equal(app.isPackaged, true);
app.setPath('userData', systemStore);
app.setPath('sessionData', systemStore);
app.setPath('downloads', downloads);
const actual = require('./modules/data_paths').resolveDataPaths(app);
assert.equal(actual.mode, mode);
assert.equal(actual.storePath, store);
assert.equal(actual.profilePath, path.join(store, '.reading-room'));
require(${JSON.stringify('./' + (pkg.main || 'index.js'))});
`);
  fs.writeFileSync(filename, JSON.stringify({ ...pkg, main: 'upgrade-fixture.cjs' }));
}

function createCase(folder, mode, runtime) {
  const program = path.join(folder, 'program');
  const systemStore = path.join(folder, 'system-profile');
  const downloads = path.join(folder, 'downloads');
  const stores = {
    'user-data': systemStore,
    'portable-data': path.join(program, 'data'),
    'portable-legacy': program,
    explicit: path.join(folder, 'explicit-store'),
  };
  const store = stores[mode];
  fs.mkdirSync(folder);
  fs.cpSync(runtime, program, { recursive: true, force: false, errorOnExist: true });
  for (const directory of new Set([systemStore, downloads, store])) fs.mkdirSync(directory, { recursive: true });
  if (mode === 'portable-legacy') fs.writeFileSync(path.join(program, 'portable'), '', { flag: 'wx' });
  return { folder, program, mode, store, systemStore, downloads };
}

function replaceRuntime(testCase, stableRuntime, previewRuntime) {
  const retired = path.join(testCase.folder, 'previous-program-files');
  fs.mkdirSync(retired);
  // Move only paths present in the data-free 1.6.16 package. Portable data and
  // the program path stay in place during the upgrade, including legacy markers.
  for (const name of fs.readdirSync(stableRuntime)) {
    fs.renameSync(path.join(testCase.program, name), path.join(retired, name));
  }
  fs.cpSync(previewRuntime, testCase.program, { recursive: true, force: false, errorOnExist: true });
}

async function verify(stableArchive, previewRuntime) {
  const stableDigest = sha256(stableArchive);
  assert.equal(stableDigest, stableHash, 'Use the Windows x64 ZIP from the published v1.6.16 release.');
  const previewAudit = auditRelease(previewRuntime);
  const manifest = readJson(path.join(previewRuntime, 'build-manifest.json'));
  assert.equal(manifest.developmentPreview, true);
  const sources = [...listSourceFiles(), path.join(root, 'tools', 'project', 'compact-runtime.ps1')];
  for (const file of sources) {
    const relative = file.endsWith('compact-runtime.ps1') ? '优化程序磁盘占用.ps1' : path.relative(root, file).replaceAll(path.sep, '/');
    assert.equal(manifest.sourceHashes[relative], sha256(file), `Rebuild the preview package for ${relative}.`);
  }

  const staging = path.join(root, '.build');
  fs.mkdirSync(staging, { recursive: true });
  const temporary = fs.realpathSync.native(staging);
  const fixture = fs.mkdtempSync(path.join(temporary, 'yanruyu-upgrade-'));
  const stableRuntime = path.join(fixture, 'stable-runtime');
  const library = path.join(fixture, 'library');
  const backup = path.join(fixture, 'historical.yru-backup');
  const pictures = new Map();
  const output = path.join(root, 'tools', '.artifacts', 'historical-upgrade');
  const results = [];
  const errors = [];
  let application, page, failure;

  async function launch(testCase, preview) {
    const env = { ...process.env, YANRUYU_UPGRADE_FIXTURE: JSON.stringify(testCase), APPDATA: testCase.systemStore, LOCALAPPDATA: testCase.systemStore };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.YANRUYU_DATA_DIR;
    if (testCase.mode === 'explicit') env.YANRUYU_DATA_DIR = testCase.store;
    application = await _electron.launch({ executablePath: path.join(testCase.program, executable), args: [], cwd: testCase.program, env, timeout: 45000 });
    const appState = await application.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData') }));
    assert.deepEqual(appState, { packaged: true, profile: path.join(testCase.store, '.reading-room') });
    assert.equal(Boolean(readJson(path.join(testCase.program, 'build-manifest.json')).developmentPreview), preview);
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(`${testCase.mode}: ${error.message}`));
    await page.locator('[data-action="settings"]').waitFor({ state: 'visible' });
    await page.waitForFunction(() => Boolean(window.YanruyuClientState && window.readingState));
  }

  async function close() {
    if (!application) return;
    await page?.evaluate(async () => {
      await window.readingState?.flush();
      await window.YanruyuClientState?.flush();
    }).catch(() => {});
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close();
    application = page = null;
  }

  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.ipcRenderer.invoke(channel, ...args), { channel, args });
  const search = (mode, query) => invoke('local-search-command', { action: 'search', mode, query });
  const matches = result => result.results.map(({ bookId, page }) => ({ bookId, page })).sort((a, b) => a.bookId.localeCompare(b.bookId));

  async function snapshot(store) {
    const books = await invoke('load-book-list', false);
    const { books: organizer } = await invoke('organizer-catalog');
    const reading = await invoke('load-reading-state');
    const { values } = await invoke('load-ui-state');
    const settings = await invoke('load-setting');
    return {
      books: books.sort((a, b) => a.id.localeCompare(b.id)).map(book => {
        const { id, title, filepath, coverPath, pageCount, readCount, tags, mark, hiddenBook } = book;
        assert.ok(isWithin(path.join(store, 'cover'), coverPath), 'Cover must resolve inside this store.');
        return { id, title, filepath, pageCount, readCount, tags, mark, hiddenBook, coverDigest: sha256(coverPath),
          mergedInto: organizer.find(entry => entry.id === id)?.mergedInto };
      }),
      progress: reading.progress,
      preferences: reading.preferences,
      collections: await invoke('load-collection-list'),
      personalization: JSON.parse(values['room-personalization']),
      theme: JSON.parse(values['room-theme']),
      settings: { library: settings.library, pageSize: settings.pageSize, hideTitleBar: settings.hideTitleBar },
      textMatches: matches(await search('text', 'garden bridge')),
      aliasMatches: matches(await search('metadata', '林间画室')),
    };
  }

  async function restoreHistoricalBackup(testCase) {
    await launch(testCase, false);
    await application.evaluate(({ app, dialog }, filename) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filename] });
      app.relaunch = () => {};
    }, backup);
    const inspected = await invoke('backup-inspect');
    assert.equal(inspected.summary.books, 3);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    const exit = once(application.process(), 'exit', { signal: controller.signal });
    try {
      const restored = await invoke('backup-restore', inspected.token);
      assert.equal(restored.restartRequired, true);
      assert.deepEqual(await exit, [0, null]);
    } finally {
      clearTimeout(timer);
      controller.abort();
      await exit.catch(() => {});
    }
    await application.close();
    application = page = null;
  }

  try {
    fs.mkdirSync(stableRuntime);
    fs.mkdirSync(library);
    const extract = spawnSync(path.join(root, 'resources', 'extraResources', '7z.exe'), ['x', stableArchive, `-o${stableRuntime}`, '-y'], { stdio: 'ignore', windowsHide: true });
    if (extract.error) throw extract.error;
    assert.equal(extract.status, 0, 'Could not extract the published v1.6.16 package.');
    assert.equal(readJson(path.join(stableRuntime, 'build-manifest.json')).appVersion, '1.6.16');
    const sharp = require(path.join(previewRuntime, 'resources', 'app', 'node_modules', 'sharp'));
    for (const [title, color] of [['Birch original', 90], ['Birch copy', 90], ['Garden sketches', 140]]) {
      const folder = path.join(library, title);
      fs.mkdirSync(folder);
      for (let number = 1; number <= 4; number++) {
        const file = path.join(folder, `${number}.png`);
        await sharp({ create: { width: 120, height: 180, channels: 3, background: { r: color, g: 38 * number, b: 150 } } }).png().toFile(file);
        pictures.set(file, sha256(file));
      }
    }

    const seed = createCase(path.join(fixture, 'seed'), 'explicit', stableRuntime);
    fs.writeFileSync(path.join(seed.store, 'setting.json'), JSON.stringify({ library, loadOnStart: false,
      hideTitleBar: true, pageSize: 35, closeToTray: false, minimizeOnStart: false, autoCheckUpdates: false, imageExplorer: '' }));
    prepareRuntime(seed.program);
    await launch(seed, false);
    const books = await invoke('load-book-list', true);
    assert.equal(books.length, 3);
    const keeper = books.find(book => path.basename(book.filepath) === 'Birch original');
    const donor = books.find(book => path.basename(book.filepath) === 'Birch copy');
    const sketch = books.find(book => path.basename(book.filepath) === 'Garden sketches');
    await invoke('save-book', { id: keeper.id, title: 'Birch archival edition', mark: true, readCount: 7, tags: { artist: ['Forest Studio'] } });
    await invoke('save-reading-progress', keeper.id, { page: 3, total: 4, time: Date.now(), source: 'room' });
    await invoke('save-reading-preferences', keeper.id, { mode: 'double', direction: 'rtl', zoom: 125 });
    await invoke('save-reading-progress', sketch.id, { page: 2, total: 4, offset: 0.32, time: Date.now() - 10000, source: 'room' });
    await invoke('save-reading-preferences', sketch.id, { mode: 'continuous', fit: 'width' });
    const collection = { id: 'archive-fixture', title: 'Archive collection', list: [keeper.id, sketch.hash] };
    await invoke('save-collection-list', [collection]);
    const merge = await invoke('organizer-preview-merge', { bookIds: [keeper.id, donor.id], keeperId: keeper.id });
    const merged = await invoke('organizer-apply', merge.token);
    const alias = await invoke('local-search-command', { action: 'preview-alias', kind: 'author', canonical: 'Forest Studio', aliases: ['林间画室'] });
    await invoke('local-search-command', { action: 'save-alias', token: alias.token });
    const text = await invoke('local-search-command', { action: 'preview-text', bookId: keeper.id, page: 3, text: note, source: 'manual' });
    await invoke('local-search-command', { action: 'save-text', token: text.token });
    await page.evaluate(async ({ first, second }) => {
      const { normalizeRoomPersonalization } = await import('./room-personalization-state.js');
      const state = normalizeRoomPersonalization({ featuredIds: [second, first], themes: { forest: { current: { layout: 'airy', brightness: 112 } } } });
      localStorage.setItem('room-personalization', JSON.stringify(state));
      localStorage.setItem('room-theme', JSON.stringify('forest'));
      await window.YanruyuClientState.flush();
    }, { first: keeper.id, second: sketch.id });
    const historical = await snapshot(seed.store);
    assert.equal(historical.books.find(book => book.id === donor.id).mergedInto, keeper.id);
    assert.equal(historical.books.find(book => book.id === keeper.id).title, 'Birch archival edition');
    assert.equal(historical.progress[keeper.id].page, 3);
    assert.equal(historical.progress[sketch.id].offset, 0.32);
    assert.equal(historical.preferences[keeper.id].mode, 'double');
    assert.equal(historical.preferences[sketch.id].mode, 'continuous');
    assert.deepEqual(historical.collections, [collection]);
    assert.deepEqual(historical.personalization.featuredIds, [sketch.id, keeper.id]);
    assert.deepEqual(historical.textMatches, [{ bookId: keeper.id, page: 3 }]);
    assert.ok(historical.aliasMatches.some(hit => hit.bookId === keeper.id));
    await application.evaluate(({ dialog }, filename) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: filename });
    }, backup);
    const exported = await invoke('backup-export', { includeCovers: true });
    assert.equal(exported.success, true);
    assert.equal(exported.summary.books, 3);
    assert.equal(exported.summary.readingRecords, 2);
    await close();
    console.log('PASS The published 1.6.16 executable produced one historical backup with three books and two reading positions.');

    for (const mode of ['user-data', 'portable-data', 'portable-legacy', 'explicit']) {
      const testCase = createCase(path.join(fixture, mode), mode, stableRuntime);
      prepareRuntime(testCase.program);
      await restoreHistoricalBackup(testCase);
      await launch(testCase, false);
      assert.deepEqual(await snapshot(testCase.store), historical, `${mode}: old application after restore`);
      await close();

      replaceRuntime(testCase, stableRuntime, previewRuntime);
      prepareRuntime(testCase.program);
      await launch(testCase, true);
      assert.deepEqual(await snapshot(testCase.store), historical, `${mode}: first upgraded launch`);
      await page.locator('[data-action="settings"]').click();
      await page.getByRole('button', { name: '启用 2.0 预览' }).click();
      await page.locator('[data-desk-resume]').waitFor();
      await close();
      await launch(testCase, true);
      assert.deepEqual(await snapshot(testCase.store), historical, `${mode}: restart in the upgraded app`);
      const { memberships } = await invoke('collection-command', { action: 'list' });
      assert.deepEqual(memberships[collection.id], { bookIds: [keeper.id, sketch.id], unresolved: [] });
      const resume = page.locator('[data-desk-resume]');
      assert.equal(await resume.getAttribute('data-read'), keeper.id);
      await resume.click();
      await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '3 / 4' &&
        document.querySelector('.paged-sheet[data-reader-page="3"] img')?.naturalWidth > 0);
      assert.equal(await page.getByLabel('阅读模式').inputValue(), 'double');
      await page.locator('[data-action="exit-reader"]').click();
      await page.locator('.reader').waitFor({ state: 'detached' });
      await invoke('organizer-undo', merged.id);
      const { books: restored } = await invoke('organizer-catalog');
      assert.equal(restored.find(book => book.id === donor.id).hiddenBook, false);
      assert.equal(restored.find(book => book.id === donor.id).mergedInto, null);
      for (const [file, digest] of pictures) assert.equal(sha256(file), digest);
      await close();
      if (mode !== 'user-data') assert.equal(fs.existsSync(path.join(testCase.systemStore, 'database.sqlite')), false);
      results.push({ mode, books: books.length, originalPages: pictures.size, continuedPage: 3, undoVerified: true });
      console.log(`PASS ${mode}: same historical data after upgrade and restart, real page-three resume, undo, and unchanged original pages.`);
    }
    assert.deepEqual(errors, []);
    fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checkedAt: new Date().toISOString(), stableDigest,
      historicalBackupDigest: sha256(backup), previewAudit, previewExecutableDigest: manifest.executable.sha256,
      previewSourceHashes: manifest.sourceHashes, results, errors }, null, 2) + '\n');
  } catch (error) {
    failure = error;
    if (page && !page.isClosed()) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'failed.png') }).catch(() => {});
    }
    throw error;
  } finally {
    try {
      await close();
      const resolved = fs.realpathSync.native(fixture);
      assert.equal(path.dirname(resolved), temporary);
      assert.ok(path.basename(resolved).startsWith('yanruyu-upgrade-'));
      await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    } catch (error) {
      if (!failure) throw error;
      console.error(`Could not clean up the generated fixture at ${fixture}: ${error.message}`);
    }
  }
}

Promise.resolve().then(() => {
  const [stable = pointer('last-release.json').archive, preview = pointer('last-preview.json').folder] = process.argv.slice(2);
  return verify(path.resolve(stable), path.resolve(preview));
}).catch(error => { console.error(error); process.exitCode = 1; });
