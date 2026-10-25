'use strict';

// Launch only this test's Electron children, with generated neutral PNG pages
// and a new YANRUYU_DATA_DIR. Never inspect or copy the live portable store.
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, appSource, electronExecutable, isWithin } = require('./project/common.cjs');
const { _electron } = require('./playwright-runtime.cjs');

const TEMP_PREFIX = 'yanruyu-reading-relocation-desktop-';
const BOOK_NAME = 'Neutral relocation fixture';
const PREFERENCES = { mode: 'double', direction: 'rtl', fit: 'width', zoom: 125, coverAlone: true };
const PROGRESS = { page: 2, total: 4, offset: .25, time: 123456789, source: 'room' };
const USER_FIELDS = { title: 'Saved main title', title_jpn: 'Saved display title', mark: true, readCount: 6 };

async function main() {
  const reusable = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusable && (!isWithin(path.join(root, '.build'), reusable) || reusable === path.join(root, '.build'))) {
    throw Error('Only an isolated generated test build may be reused');
  }
  const target = reusable ? path.join(reusable, 'resources', 'app') : appSource;
  const executable = electronExecutable();
  const sharp = require(path.join(target, 'node_modules', 'sharp'));
  const temporaryRoot = path.resolve(os.tmpdir());
  const workspace = path.resolve(fs.mkdtempSync(path.join(temporaryRoot, TEMP_PREFIX)));
  const fixturePath = (...parts) => {
    const targetPath = path.resolve(workspace, ...parts);
    if (!isWithin(workspace, targetPath) || targetPath === workspace) throw Error('Fixture path escaped its temporary directory');
    return targetPath;
  };
  const data = fixturePath('data');
  const oldRoot = fixturePath('old-root'), newRoot = fixturePath('new-root'), copyRoot = fixturePath('copy-root');
  const originalPath = fixturePath('old-root', BOOK_NAME);
  const destination = fixturePath('new-root', BOOK_NAME);
  const copyPath = fixturePath('copy-root', BOOK_NAME);
  const env = { ...process.env, YANRUYU_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [], consoleErrors = [];
  let application = null, page = null;
  const pass = message => { checks.push(message); console.log('PASS ' + message); };
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.ipcRenderer.invoke(channel, ...args), { channel, args });

  async function launch() {
    application = await _electron.launch({ executablePath: executable, args: [target], cwd: root, env, timeout: 45000 });
    page = await application.firstWindow();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.route(/^https?:/, route => route.abort());
    await page.waitForSelector('#room', { state: 'attached', timeout: 30000 });
    const paths = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData') }));
    assert.deepEqual(paths, { userData: path.join(data, '.reading-room'), sessionData: path.join(data, '.reading-room') });
  }

  async function close() {
    if (!application) return;
    const current = application;
    // Both calls address the handle returned by this fixture's launch only.
    await current.evaluate(({ app }) => app.quit()).catch(() => {});
    await current.close();
    application = null;
    page = null;
  }

  async function scan() {
    const task = await invoke('task-start', 'scan', { rebuild: false });
    const finished = await page.evaluate(id => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = async () => {
        try {
          const current = (await window.ipcRenderer.invoke('task-list')).find(item => item.id === id);
          if (current && !['queued', 'running', 'cancelling'].includes(current.status)) return resolve(current);
          if (Date.now() - started > 45000) return reject(Error('Isolated scan did not finish: ' + id));
          setTimeout(poll, 100);
        } catch (error) { reject(error); }
      };
      poll();
    }), task.id);
    assert.equal(finished.status, 'completed', 'Scan failed: ' + JSON.stringify(finished.errors));
    return finished.result;
  }

  async function selectRoot(library) {
    assert.ok(isWithin(workspace, library));
    await invoke('save-setting', { ...await invoke('load-setting'), library });
    assert.equal((await invoke('load-setting')).library, library);
  }

  function assertUserFields(book) {
    for (const [field, value] of Object.entries(USER_FIELDS)) assert.deepEqual(book[field], value, 'Preserve ' + field);
  }

  async function assertProfile(id, expectedProgress = PROGRESS) {
    const profile = await invoke('load-reading-state');
    assert.deepEqual(profile.progress[id], expectedProgress);
    assert.deepEqual(profile.preferences[id], PREFERENCES);
    assert.deepEqual(Object.keys(profile.progress), [id]);
    assert.deepEqual(Object.keys(profile.preferences), [id]);
    return profile;
  }

  async function assertShelf(ids, originalId) {
    await page.waitForSelector('#room .scene-book-target', { state: 'attached', timeout: 30000 });
    assert.equal(await page.locator('#room .scene-canvas').count(), 1, 'The real 3D shelf is mounted');
    const state = await page.evaluate(id => ({
      books: Array.from(document.querySelectorAll('#room [data-book]'), element => ({
        id: element.dataset.book,
        title: element.dataset.bookTitle,
        label: element.getAttribute('aria-label'),
        progress: element.querySelector('.scene-book-progress')?.style.getPropertyValue('--progress'),
        favorite: Boolean(element.querySelector('.scene-book-favorite'))
      })),
      progress: window.readingState.get(id),
      preferences: window.readingState.getPreferences(id)
    }), originalId);
    assert.deepEqual(state.books.map(book => book.id).sort(), [...ids].sort());
    const original = state.books.find(book => book.id === originalId);
    assert.equal(original.title, USER_FIELDS.title_jpn);
    assert.match(original.label, /50%/);
    assert.equal(original.progress, '50%');
    assert.equal(original.favorite, true);
    assert.equal(state.progress.page, 2);
    assert.equal(state.progress.total, 4);
    assert.deepEqual(state.preferences, PREFERENCES);
    for (const book of state.books.filter(book => book.id !== originalId)) assert.equal(book.progress, undefined);
  }

  try {
    fs.mkdirSync(data);
    fs.mkdirSync(originalPath, { recursive: true });
    for (let number = 1; number <= 4; number++) {
      await sharp({ create: { width: 120, height: 180, channels: 3,
        background: { r: 40 + number * 30, g: 100, b: 140 } } }).png().toFile(path.join(originalPath, `${number}.png`));
    }
    fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({ library: oldRoot, loadOnStart: false,
      hideTitleBar: true, closeToTray: false, minimizeOnStart: true, minimizeToTray: true,
      autoCheckUpdates: false, enabledLANBrowsing: false, imageExplorer: '' }));
    await launch();
    assert.deepEqual(await invoke('load-book-list', false), []);
    await scan();
    const imported = await invoke('load-book-list', false);
    assert.equal(imported.length, 1);
    const original = imported[0], id = original.id;
    assert.equal(original.filepath, originalPath);
    assert.equal(original.pageCount, 4);
    assert.match(original.identityFingerprint, /^folder-sha256-v1:[0-9a-f]{64}$/);
    assert.ok(isWithin(data, original.coverPath));
    await invoke('save-book', { ...original, ...USER_FIELDS });
    await invoke('save-reading-progress', id, PROGRESS);
    await invoke('save-reading-preferences', id, PREFERENCES);
    await assertProfile(id);
    pass('Real scan imports four neutral PNG pages and saves custom titles, favourites, reading progress and preferences in a fresh store.');

    // Both resolved paths are fixed descendants of this mkdtemp fixture.
    assert.ok(isWithin(workspace, oldRoot) && isWithin(workspace, newRoot));
    fs.renameSync(oldRoot, newRoot);
    assert.equal(fs.existsSync(oldRoot), false);
    await selectRoot(newRoot);
    const relocated = await scan();
    assert.equal(relocated.relocated, 1);
    assert.equal(relocated.added, 0);
    let books = await invoke('load-book-list', false);
    assert.equal(books.length, 1, 'A new selected root must not add a second unread book');
    assert.equal(books[0].id, id);
    assert.equal(books[0].filepath, destination);
    assert.equal(books[0].identityFingerprint, original.identityFingerprint);
    assertUserFields(books[0]);
    await assertProfile(id);
    const repeat = await scan();
    assert.equal(repeat.changed, false);
    assert.equal(repeat.unchanged, 1);
    assert.deepEqual(await invoke('load-book-list', false), books);
    pass('Changing roots through real settings and scan IPC preserves one original ID, its new path and all saved reading data; repeat scan is unchanged.');

    await page.reload();
    await assertShelf([id], id);
    await assertProfile(id);
    pass('Reloading the real 3D shelf shows the original display title, favourite and 50% progress marker on the same ID.');

    await close();
    await launch();
    assert.equal((await invoke('load-setting')).library, newRoot);
    books = await invoke('load-book-list', false);
    assert.equal(books.length, 1);
    assert.equal(books[0].id, id);
    assert.equal(books[0].filepath, destination);
    assertUserFields(books[0]);
    await assertProfile(id);
    await assertShelf([id], id);
    pass('A fresh Electron process reloads the selected new root, one original record, the same reader preferences and the same shelf progress.');

    // Dispatch through the real shelf interaction without bringing a test
    // window in front of the user's applications.
    const originalTarget = page.locator('#room .scene-book-target').filter({ has: page.locator('.scene-book-progress') });
    await originalTarget.dispatchEvent('dblclick');
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent.startsWith('2 /') &&
      Array.from(document.querySelectorAll('.reader-body img')).some(image => image.naturalWidth > 0), undefined,
    { polling: 100, timeout: 30000 });
    assert.equal(await page.locator('#reader-mode').inputValue(), PREFERENCES.mode);
    assert.equal(await page.locator('#reader-direction').inputValue(), PREFERENCES.direction);
    assert.equal(await page.locator('#reader-fit').inputValue(), PREFERENCES.fit);
    assert.equal(await page.locator('#reader-zoom').inputValue(), String(PREFERENCES.zoom));
    assert.equal(await page.locator('#reader-cover-alone').isChecked(), PREFERENCES.coverAlone);
    await page.locator('[data-action="exit-reader"]').dispatchEvent('click');
    await page.waitForSelector('.reader', { state: 'detached' });
    await page.evaluate(() => window.readingState.flush());
    const beforeCopy = (await invoke('load-book-list', false))[0];
    const profileBeforeCopy = await invoke('load-reading-state');
    assert.equal(profileBeforeCopy.progress[id].page, 2);
    pass('Opening the relocated book from its 3D shelf resumes page two, loads the real PNGs and restores the saved reading controls.');

    fs.mkdirSync(copyPath, { recursive: true });
    for (let number = 1; number <= 4; number++) {
      fs.copyFileSync(fixturePath('new-root', BOOK_NAME, `${number}.png`), fixturePath('copy-root', BOOK_NAME, `${number}.png`));
    }
    assert.ok(fs.existsSync(destination), 'The original remains live while its copy is scanned');
    await selectRoot(copyRoot);
    const copied = await scan();
    assert.equal(copied.added, 1);
    assert.equal(copied.relocated, 0);
    books = await invoke('load-book-list', false);
    assert.equal(books.length, 2);
    const retained = books.find(book => book.id === id);
    const duplicate = books.find(book => book.filepath === copyPath);
    assert.equal(retained.filepath, destination);
    assert.equal(retained.readCount, beforeCopy.readCount);
    assert.equal(retained.title, USER_FIELDS.title);
    assert.equal(retained.title_jpn, USER_FIELDS.title_jpn);
    assert.ok(duplicate);
    assert.notEqual(duplicate.id, id);
    assert.equal(duplicate.identityFingerprint, original.identityFingerprint);
    assert.equal(duplicate.readCount, 0);
    assert.equal(duplicate.mark, false);
    assert.deepEqual(await invoke('load-reading-state'), profileBeforeCopy);
    await page.reload();
    await assertShelf([id, duplicate.id], id);
    pass('Selecting an identical live copy creates a second independent ID without moving the original or copying its progress marker.');
    assert.deepEqual(errors, []);
    console.log(`Reading relocation desktop checks passed: ${checks.length}.`);
  } catch (error) {
    if (page && !page.isClosed()) {
      console.error('Isolated renderer state:', await page.evaluate(() => ({
        location: location.href,
        shelfIds: Array.from(document.querySelectorAll('#room [data-book]'), element => element.dataset.book),
        sceneState: document.querySelector('.scene-viewport')?.dataset.sceneState,
        readerPage: document.querySelector('#reader-page')?.textContent
      })).catch(() => 'unavailable'));
    }
    if (consoleErrors.length) console.error('Isolated renderer console:', consoleErrors);
    throw error;
  } finally {
    try { await close(); }
    finally {
      if (path.dirname(workspace) !== temporaryRoot || !path.basename(workspace).startsWith(TEMP_PREFIX) ||
          fs.lstatSync(workspace).isSymbolicLink()) throw Error('Unsafe desktop fixture cleanup');
      fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
    }
  }
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
