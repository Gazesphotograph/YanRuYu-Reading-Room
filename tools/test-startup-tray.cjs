'use strict';

// Exercise the shipped main process with isolated Electron, storage, and database
// mocks. This never starts Electron or opens the user's settings or library.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');
const vm = require('node:vm');

const appDir = path.resolve(__dirname, '../resources/app');
const source = fs.readFileSync(path.join(appDir, 'index.js'), 'utf8');
const { readerExecutable } = require(path.join(appDir, 'modules/safety'));
const { TaskService } = require(path.join(appDir, 'modules/task_service'));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const preventable = () => ({
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; },
});

function createRuntime(initialSetting = {}, {
  platform = 'win32', imageList = [], books = [], availablePaths,
  random = () => 0, beforeFindAll = async () => {}, beforeAccess = async () => {},
  readerError, openPathError = '', browserError, portableLibrary,
  readingProfile = true, organizerError, localSearchError,
} = {}) {
  const ready = deferred();
  const database = deferred();
  const windows = [];
  const trays = [];
  const writes = new Map();
  const removals = [];
  const handlers = new Map();
  const imageWork = { loads: [], metadata: [], resizes: [], files: [], copies: [], cleared: [], released: [], events: [] };
  const externalWork = { urls: [], paths: [], executions: [], dialogs: [], access: [], queries: [], updates: [] };
  const featureWork = { organizerFlushes: 0, searchFlushes: 0 };
  const existingPaths = availablePaths && new Set(availablePaths);
  const storedBooks = books.map(book => ({ ...book }));
  const setting = {
    library: appDir,
    minimizeOnStart: false, minimizeToTray: false, closeToTray: false,
    enabledLANBrowsing: false, startOnLogin: false, ...initialSetting,
  };
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: true,
    quitCalls: 0,
    quitCompleted: false,
    quitting: false,
    setPath() {},
    getPath: () => path.join(appDir, 'mock-app.exe'),
    requestSingleInstanceLock: () => true,
    whenReady: () => ready.promise,
    setLoginItemSettings() {},
    quit() {
      if (this.quitting || this.quitCompleted) return;
      this.quitCalls++;
      this.quitting = true;
      const beforeQuit = preventable();
      this.emit('before-quit', beforeQuit);
      if (!beforeQuit.defaultPrevented) {
        for (const win of windows.filter(win => !win.destroyed)) win.close();
        if (!windows.some(win => !win.destroyed)) {
          const willQuit = preventable();
          this.emit('will-quit', willQuit);
          this.quitCompleted = !willQuit.defaultPrevented;
        }
      }
      this.quitting = false;
    },
    exit() { throw new Error('Unexpected immediate process exit'); },
  });

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      Object.assign(this, { options, visible: false, minimized: false,
        destroyed: false, skipTaskbar: false, focused: false, forcedDestroyCalls: 0 });
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        mainFrame: { url: '' },
        setWindowOpenHandler() {},
        send(channel, payload) { imageWork.events.push({ channel, payload }); },
        async executeJavaScript() { return { saved: true, readingProfile }; },
      });
      windows.push(this);
    }
    static getAllWindows() { return windows.filter(win => !win.destroyed); }
    static fromWebContents(contents) { return windows.find(win => win.webContents === contents); }
    loadFile(file) { this.webContents.mainFrame.url = pathToFileURL(file).href; }
    loadURL(url) { this.webContents.mainFrame.url = url; }
    setMenuBarVisibility() {}
    setAutoHideMenuBar() {}
    setTitle() {}
    setProgressBar() {}
    setSkipTaskbar(value) { this.skipTaskbar = value; }
    isDestroyed() { return this.destroyed; }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; }
    focus() { this.focused = true; }
    minimize() {
      const event = preventable();
      this.emit('minimize', event);
      if (!event.defaultPrevented) this.minimized = true;
    }
    restore() { this.minimized = false; this.emit('restore'); }
    close() {
      const event = preventable();
      this.emit('close', event);
      if (!event.defaultPrevented) this.finishClose();
      return event;
    }
    destroy() { this.forcedDestroyCalls++; this.finishClose(); }
    finishClose() {
      this.destroyed = true;
      this.visible = false;
      this.emit('closed');
      if (!BrowserWindow.getAllWindows().length) app.emit('window-all-closed');
    }
  }

  class Tray extends EventEmitter {
    constructor(icon) { super(); this.icon = icon; this.destroyed = false; trays.push(this); }
    setToolTip(value) { this.tooltip = value; }
    setContextMenu(value) { this.menu = value; }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  const ipcMain = new EventEmitter();
  ipcMain.handle = (channel, handler) => handlers.set(channel, handler);
  const defaultSession = {
    setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    async setProxy() {},
  };
  const electron = { app, BrowserWindow, Tray, ipcMain,
    session: { defaultSession },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920 }, scaleFactor: 1 }) },
    Menu: { buildFromTemplate: template => template, setApplicationMenu() {} },
    shell: {
      async openExternal(url) {
        externalWork.urls.push(url);
        if (browserError) throw browserError;
      },
      async openPath(filepath) { externalWork.paths.push(filepath); return openPathError; },
    },
    dialog: { showErrorBox(title, message) { externalWork.dialogs.push({ title, message }); } },
  };
  const fakeFs = {
    createWriteStream: () => ({ write() {} }),
    appendFileSync() {},
    rmSync: file => removals.push(file),
    promises: {
      async access(file) {
        externalWork.access.push(file);
        await beforeAccess(file);
        if (existingPaths && !existingPaths.has(file)) {
          throw Object.assign(new Error('ENOENT: fixture does not exist'), { code: 'ENOENT' });
        }
      },
      async writeFile(file, value) { writes.set(file, value); },
      async rename(from, to) { writes.set(to, writes.get(from)); writes.delete(from); },
      async rm(file) { imageWork.cleared.push(file); },
      async mkdir() {},
      async copyFile(from, to) { imageWork.copies.push({ from, to }); },
    },
  };
  const model = {
    sync: () => database.promise,
    sequelize: { query: async sql => [sql.startsWith('PRAGMA')
      ? ['hiddenBook', 'readCount', 'exist'].map(name => ({ name })) : []] },
    async findAll(options) {
      externalWork.queries.push(options);
      await beforeFindAll();
      return storedBooks.map(book => options?.raw ? { ...book } : { ...book, toJSON: () => ({ ...book }) });
    },
    async update(values, { where }) {
      externalWork.updates.push({ values: { ...values }, where: { ...where } });
      const matches = storedBooks.filter(book => book.id === where.id);
      for (const book of matches) Object.assign(book, values);
      return [matches.length];
    },
  };
  const childProcess = {
    execFile(executable, args, options, callback) {
      const child = new EventEmitter();
      child.unrefCalls = 0;
      child.unref = () => child.unrefCalls++;
      externalWork.executions.push({ executable, args: Array.from(args), options: { ...options }, child });
      queueMicrotask(() => {
        if (readerError) {
          child.emit('error', readerError);
          callback(readerError);
        } else {
          child.emit('spawn');
        }
      });
      return child;
    },
  };
  const sharp = Object.assign(file => ({
    async metadata() { imageWork.metadata.push(file); return { width: 800, height: 1200 }; },
    resize(options) { imageWork.resizes.push({ file, ...options }); return this; },
    async toFile(target) { imageWork.files.push(target); },
  }), {
    cache() {}, concurrency() {},
  });
  const lan = { disable() {}, set() {}, use() {}, get() {} };
  const serialQueue = () => {
    let tail = Promise.resolve();
    return task => {
      const next = tail.then(task, task);
      tail = next.catch(() => {});
      return next;
    };
  };
  let nextId = 0;
  const modules = {
    electron, fs: fakeFs, lodash: { isEmpty: value => !value || !Object.keys(value).length }, nanoid: { nanoid: () => `mock-${++nextId}` }, sharp,
    sqlite3: {}, sqlite: {}, 'node-fetch': {}, 'https-proxy-agent': {}, glob: {},
    'electron-window-state': () => ({ x: 0, y: 0, width: 1200, height: 800, manage() {} }),
    express: () => lan,
    './modules/safety': { serialQueue, readerExecutable, assertWithin: async (_root, target) => target },
    './modules/reading_state': { createReadingStateStore: () => ({ ready: Promise.resolve(), flush: async () => {}, load: async () => ({ schemaVersion: 1, pageBase: 1, progress: {} }) }), validBookId: value => typeof value === 'string' && !!value },
    './modules/library_scan': {},
    // Feature behavior is covered by its real SQLite/browser suites. These
    // lifecycle-only doubles keep the tray VM entirely isolated from storage.
    './modules/library_organizer': { createLibraryOrganizer: ({ databaseReady }) => {
      const ready = Promise.resolve(databaseReady).then(() => { if (organizerError) throw organizerError; });
      ready.catch(() => {});
      return { ready, async flush() { featureWork.organizerFlushes++; await ready; } };
    } },
    './modules/local_search': { createLocalSearchService: () => ({
      ready: Promise.resolve(), initialError: localSearchError || null,
      async flush() { featureWork.searchFlushes++; if (localSearchError) throw localSearchError; },
    }) },
    './modules/task_service': { TaskService: class extends TaskService {
      constructor(options) { super({ ...options, storePath: null }); }
    } },
    './modules/library_edits': require('../resources/app/modules/library_edits'),
    './modules/shutdown_guard': require('../resources/app/modules/shutdown_guard'),
    './modules/library_identity': {},
    './modules/sqlite_metadata_import': {},
    './modules/backup_service': { BackupService: class {} },
    './modules/client_state': {},
    './modules/restore_transaction': { recoverPendingRestoreSync: () => ({ recovered: false }) },
    './modules/archive_recovery': {},
    './modules/database': { prepareMangaModel: () => model, prepareMetadataModel: () => model },
    './modules/prepare_menu.js': { prepareTemplate: () => [] },
    './fileLoader/index.js': {
      async setImageCacheBudget() {}, async releaseImageCache(owner) { imageWork.released.push(owner); },
      async getImageListByBook(filepath, type) {
        imageWork.loads.push({ filepath, type });
        return imageList;
      },
    },
    './fileLoader/folder.js': {},
    './modules/portable_paths': {
      resolvePortableSetting: value => ({ ...value, library: portableLibrary }),
    },
    './modules/utils': { getRootPath: () => '/isolated-tray-test/app' },
    './modules/init_folder_setting.js': {
      STORE_PATH: '/isolated-tray-test/store', TEMP_PATH: '/isolated-tray-test/temp',
      COVER_PATH: '/isolated-tray-test/cover', VIEWER_PATH: '/isolated-tray-test/viewer',
      isPortable: Boolean(portableLibrary), preparePath() {},
      prepareSetting: () => ({ ...setting }), prepareCollectionList: () => [],
    },
  };
  const builtins = new Set(['path', 'zlib', 'util', 'url', 'crypto']);
  const fakeProcess = new EventEmitter();
  Object.assign(fakeProcess, {
    platform, stdout: { write() {} }, stderr: { write() {} },
    exit() { throw new Error('Unexpected process exit'); },
  });
  const errors = [];
  vm.runInNewContext(source, {
    __dirname: appDir,
    require(name) {
      if (Object.hasOwn(modules, name)) return modules[name];
      if (builtins.has(name)) return require(`node:${name}`);
      if (name === 'child_process') return childProcess;
      if (name === './package.json') return { name: 'mock-reader', version: '0.0.0' };
      throw new Error('Unexpected module in isolated tray test: ' + name);
    },
    console: { log() {}, error: (...args) => errors.push(args) },
    process: fakeProcess, Buffer, URL, setTimeout, clearTimeout,
    Math: Object.assign(Object.create(Math), { random }),
  }, { filename: path.join(appDir, 'index.js') });

  return {
    app, windows, trays, writes, removals, errors, imageWork, externalWork, featureWork,
    async start({ finishDatabase = true } = {}) {
      app.emit('ready');
      ready.resolve();
      await settle();
      if (finishDatabase) await this.finishDatabase();
    },
    async finishDatabase() { database.resolve(); await settle(); },
    async invoke(channel, ...args) {
      const win = BrowserWindow.getAllWindows()[0];
      return handlers.get(channel)({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args);
    },
    async save(update) { return this.invoke('save-setting', { ...setting, ...update }); },
    menu(label) {
      const item = trays.at(-1).menu.find(item => item.label === label);
      assert(item, `Missing tray action: ${label}`);
      return item.click();
    },
  };
}

test('tray exists before database startup finishes and survives disabled hide settings', async () => {
  const runtime = createRuntime();
  await runtime.start({ finishDatabase: false });
  assert.equal(runtime.trays.length, 1, 'The tray should not wait for the window or database');
  assert.equal(runtime.windows.length, 0);
  await runtime.finishDatabase();
  const win = runtime.windows[0];
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  await runtime.save({ minimizeToTray: false, closeToTray: false });
  assert.equal(runtime.trays[0].destroyed, false);
  assert.equal(runtime.trays.length, 1);
  assert.equal(runtime.writes.size, 1, 'The settings save still completes');
  runtime.menu('退出');
  await settle();
  assert.equal(runtime.app.quitCompleted, true);
  assert.equal(win.forcedDestroyCalls, 0, 'Exit should use the normal application lifecycle');
  assert.equal(runtime.trays[0].destroyed, true);
});

test('recovery window can exit when feature initialization fails without a reading profile', async () => {
  const runtime = createRuntime({}, { readingProfile: false,
    organizerError: new Error('synthetic invalid organizer journal'),
    localSearchError: new Error('synthetic invalid local search state'),
  });
  await runtime.start();
  const win = runtime.windows[0];
  assert(win, 'Initialization failure must still expose the recovery window');
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  runtime.menu('退出');
  await settle();
  assert.equal(runtime.app.quitCompleted, true, 'A failed feature must not trap the user in the recovery window');
  assert.equal(win.forcedDestroyCalls, 0);
  assert.equal(runtime.featureWork.organizerFlushes, 0);
  assert.equal(runtime.featureWork.searchFlushes, 0);
  assert.deepEqual(runtime.externalWork.dialogs, []);
});

test('tray restores minimized or hidden windows and close-to-tray does not block exit', async () => {
  const runtime = createRuntime({ minimizeToTray: true, closeToTray: true });
  await runtime.start();
  const win = runtime.windows[0];
  const tray = runtime.trays[0];
  win.emit('ready-to-show');
  tray.emit('click');
  assert.equal(win.visible, false);
  assert.equal(win.skipTaskbar, true);
  tray.emit('click');
  assert.equal(win.visible, true);
  assert.equal(win.skipTaskbar, false);
  assert.equal(win.focused, true);
  assert.equal(win.close().defaultPrevented, true);
  assert.equal(win.visible, false);
  runtime.app.emit('second-instance');
  assert.equal(win.visible, true);
  assert.equal(win.skipTaskbar, false);
  win.close();
  tray.emit('click');
  assert.equal(win.visible, true);
  assert.equal(runtime.trays.length, 1, 'Hide/show actions must not duplicate tray icons');
  runtime.menu('退出');
  await settle();
  assert.equal(runtime.app.quitCompleted, true, 'Explicit exit must bypass close-to-tray');
  assert.equal(win.destroyed, true);
  assert.equal(win.forcedDestroyCalls, 0);
  assert.equal(runtime.removals.length, 0, 'Normal quit retains budgeted archive caches for restart');
  assert(runtime.imageWork.released.includes('desktop-reader'), 'Normal quit releases the active reader lease');
});

test('startup minimization and ordinary taskbar minimization keep one tray', async () => {
  const runtime = createRuntime({ minimizeOnStart: true, minimizeToTray: true });
  await runtime.start();
  const win = runtime.windows[0];
  win.emit('ready-to-show');
  assert.equal(win.visible, false);
  assert.equal(win.skipTaskbar, true);
  runtime.trays[0].emit('click');
  await runtime.save({ minimizeToTray: false, closeToTray: false });
  runtime.trays[0].emit('click');
  assert.equal(win.minimized, true);
  assert.equal(win.skipTaskbar, false);
  runtime.trays[0].emit('click');
  assert.equal(win.minimized, false);
  assert.equal(win.visible, true);
  await runtime.save({ minimizeToTray: true, closeToTray: true });
  assert.equal(runtime.trays.length, 1);
  assert.equal(runtime.trays[0].destroyed, false);
  runtime.app.quit();
  await settle();
  assert.equal(runtime.app.quitCompleted, true);
});

test('show requested during startup is honored after the window becomes ready', async () => {
  const runtime = createRuntime({ minimizeOnStart: true, minimizeToTray: true });
  await runtime.start({ finishDatabase: false });
  runtime.trays[0].emit('click');
  await runtime.finishDatabase();
  const win = runtime.windows[0];
  win.emit('ready-to-show');
  assert.equal(win.visible, true);
  assert.equal(win.skipTaskbar, false);
  runtime.app.quit();
});

test('exiting from the startup tray cancels a waiting random open and never creates a late window', async () => {
  const runtime = createRuntime({ closeToTray: true }, {
    books: [{ filepath: path.join(appDir, 'fixture.zip') }],
  });
  await runtime.start({ finishDatabase: false });
  const opening = runtime.menu('随机打开漫画');
  await settle();
  assert.equal(runtime.externalWork.queries.length, 0, 'Random selection must wait for the schema');
  runtime.menu('退出');
  assert.equal(runtime.app.quitCompleted, true);
  assert.equal(runtime.trays[0].destroyed, true);
  await runtime.finishDatabase();
  await opening;
  runtime.app.emit('activate');
  assert.equal(runtime.windows.length, 0);
  assert.equal(runtime.trays.length, 1);
  assert.deepEqual(runtime.externalWork.paths, []);
  assert.deepEqual(runtime.externalWork.executions, []);
  assert.deepEqual(runtime.externalWork.dialogs, []);
});

test('tray contains exactly three Chinese actions in order and opens the popular page without waiting for the library', async () => {
  const runtime = createRuntime();
  await runtime.start({ finishDatabase: false });
  assert.deepEqual(Array.from(runtime.trays[0].menu, item => item.label), [
    '随机打开漫画', '打开漫画网页', '退出',
  ]);
  await runtime.menu('打开漫画网页');
  assert.deepEqual(runtime.externalWork.urls, ['https://exhentai.org/popular']);
  assert.equal(runtime.windows.length, 0, 'Opening a browser must not reveal or create the main window');
  assert.deepEqual(runtime.externalWork.queries, []);
  runtime.app.quit();
  await runtime.finishDatabase();
});

test('random open uses the configured external reader once without revealing the tray window', async () => {
  const reader = path.join(appDir, 'mock reader', 'reader.exe');
  const chosen = path.join(appDir, 'mock library', '漫画 & %1.zip');
  const runtime = createRuntime({
    minimizeOnStart: true, minimizeToTray: true, imageExplorer: `"${reader}"`,
  }, {
    random: () => 0.99,
    books: [
      { filepath: path.join(appDir, 'hidden.zip'), hiddenBook: true },
      { filepath: path.join(appDir, 'hidden-number.zip'), hiddenBook: 1 },
      { filepath: path.join(appDir, 'unavailable.zip'), exist: false },
      { filepath: path.join(appDir, 'unavailable-number.zip'), exist: 0 },
      { filepath: '' }, { filepath: '  ' }, { filepath: null },
      { filepath: path.join(appDir, 'other.zip'), hiddenBook: false, exist: true },
      { filepath: chosen, hiddenBook: null, exist: null },
    ],
  });
  await runtime.start();
  const win = runtime.windows[0];
  win.emit('ready-to-show');
  await runtime.menu('随机打开漫画');
  const work = runtime.externalWork;
  assert.equal(work.executions.length, 1, 'One tray click must launch exactly one reader');
  const launch = work.executions[0];
  assert.equal(launch.executable, reader);
  assert.deepEqual(launch.args, [chosen], 'A path containing spaces and shell characters stays one literal argument');
  assert.equal(launch.options.shell, undefined);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.child.unrefCalls, 1);
  assert.deepEqual(work.paths, []);
  assert.deepEqual(work.dialogs, []);
  assert.equal(work.queries.length, 1);
  assert.equal(work.queries[0].raw, true);
  assert.deepEqual(Array.from(work.queries[0].attributes).sort(), ['exist', 'filepath', 'hiddenBook']);
  assert.equal(win.visible, false);
  assert.equal(win.skipTaskbar, true);
  assert.equal(win.focused, false);
  assert.deepEqual(runtime.imageWork.loads, [], 'The tray must not load the internal reader');
  const directBook = path.join(appDir, 'direct-open.zip');
  await runtime.invoke('open-local-book', directBook);
  assert.equal(work.executions.length, 2, 'The existing direct-open IPC still launches the configured reader');
  assert.deepEqual(work.executions[1].args, [directBook]);
  runtime.app.quit();
});

test('random open skips missing files and uses the system reader when no executable is configured', async () => {
  const missing = path.join(appDir, 'deleted.zip');
  const readable = path.join(appDir, 'readable.zip');
  const runtime = createRuntime({ minimizeOnStart: true, minimizeToTray: true }, {
    books: [{ filepath: missing }, { filepath: readable }], availablePaths: [readable],
  });
  await runtime.start();
  runtime.windows[0].emit('ready-to-show');
  await runtime.menu('随机打开漫画');
  assert.deepEqual(runtime.externalWork.access, [missing, readable]);
  assert.deepEqual(runtime.externalWork.paths, [readable]);
  assert.deepEqual(runtime.externalWork.executions, []);
  assert.deepEqual(runtime.externalWork.dialogs, []);
  assert.equal(runtime.windows[0].visible, false);
  runtime.app.quit();
});

test('empty, excluded, or missing library entries produce a visible Chinese error without opening a reader', async t => {
  for (const [name, books, availablePaths] of [
    ['empty library', []],
    ['hidden or unavailable entries', [
      { filepath: 'hidden.zip', hiddenBook: true }, { filepath: 'hidden-number.zip', hiddenBook: 1 },
      { filepath: 'unavailable.zip', exist: false }, { filepath: 'unavailable-number.zip', exist: 0 },
      { filepath: '' }, { filepath: '  ' }, { filepath: null },
    ]],
    ['all files missing', [{ filepath: path.join(appDir, 'deleted.zip') }], []],
  ]) {
    await t.test(name, async () => {
      const runtime = createRuntime({ minimizeOnStart: true, minimizeToTray: true }, { books, availablePaths });
      await runtime.start();
      runtime.windows[0].emit('ready-to-show');
      await runtime.menu('随机打开漫画');
      assert.deepEqual(runtime.externalWork.paths, []);
      assert.deepEqual(runtime.externalWork.executions, []);
      assert.equal(runtime.externalWork.dialogs.length, 1);
      assert.equal(runtime.externalWork.dialogs[0].title, '颜如玉');
      assert.match(runtime.externalWork.dialogs[0].message, /书库.*没有.*漫画/);
      assert.equal(runtime.windows[0].visible, false);
      runtime.app.quit();
    });
  }
});

test('startup random open waits for the schema and only opens the recorded source after a portable move', async t => {
  const originalLibrary = path.join(appDir, 'old library');
  const activeLibrary = path.join(appDir, 'moved library');
  const original = path.join(originalLibrary, 'collection', 'book.zip');
  const relocated = path.join(activeLibrary, 'collection', 'book.zip');
  for (const [name, recorded, readable, opened] of [
    ['original source remains available', original, [original], [original]],
    ['same-name replacement is not a verified source', original, [relocated], []],
    ['an available original takes priority over a same-name replacement', original, [original, relocated], [original]],
    ['a verified relocated database record opens normally', relocated, [relocated], [relocated]],
  ]) {
    await t.test(name, async () => {
      const runtime = createRuntime({
        library: originalLibrary, minimizeOnStart: true, minimizeToTray: true,
      }, {
        portableLibrary: activeLibrary, books: [{ filepath: recorded }], availablePaths: readable,
      });
      await runtime.start({ finishDatabase: false });
      const opening = runtime.menu('随机打开漫画');
      await settle();
      assert.deepEqual(runtime.externalWork.queries, []);
      assert.deepEqual(runtime.externalWork.paths, []);
      await runtime.finishDatabase();
      await opening;
      assert.deepEqual(runtime.externalWork.paths, opened);
      assert.equal(runtime.externalWork.queries.length, 1, 'No full library repair is required before opening a book');
      assert.deepEqual(runtime.externalWork.access, [recorded], 'A folder name cannot identify a moved book');
      assert.equal(runtime.externalWork.dialogs.length, opened.length ? 0 : 1);
      assert.deepEqual(runtime.externalWork.updates, [], 'Opening a book does not change its source record');
      runtime.windows[0].emit('ready-to-show');
      assert.equal(runtime.windows[0].visible, false);
      runtime.app.quit();
    });
  }
});

test('changing a portable library root never rewrites source paths while loading the catalogue', async () => {
  const originalLibrary = path.join(appDir, 'computer-a-library');
  const selectedLibrary = path.join(appDir, 'computer-b-library');
  const oldPath = path.join(originalLibrary, 'series', 'same-book');
  const newPath = path.join(selectedLibrary, 'series', 'same-book');
  const books = [
    { id: 'read-original', filepath: oldPath, hash: 'same-sampled-content', type: 'folder',
      title: 'Original book title', title_jpn: 'Original display title', status: 'tagged',
      coverPath: path.join(originalLibrary, 'covers', 'old-cover.jpg') },
    { id: 'new-import', filepath: newPath, hash: 'same-sampled-content', type: 'folder',
      title: 'same-book', status: 'tagged', coverPath: path.join(selectedLibrary, 'covers', 'new-cover.jpg') },
  ];
  const runtime = createRuntime({ library: originalLibrary }, {
    portableLibrary: originalLibrary, books, availablePaths: [newPath],
  });
  await runtime.start();
  await runtime.save({ library: selectedLibrary });
  for (let refresh = 0; refresh < 2; refresh++) {
    const listed = JSON.parse(JSON.stringify(await runtime.invoke('load-book-list', false)));
    assert.deepEqual(listed.map(book => [book.id, book.filepath]), books.map(book => [book.id, book.filepath]),
      'The old reading identity and the new import must not be pointed at the same source by a list refresh');
    assert.equal(listed[0].title, books[0].title);
    assert.equal(listed[0].title_jpn, books[0].title_jpn);
    assert.deepEqual(listed.map(book => book.coverPath), ['old-cover.jpg', 'new-cover.jpg']
      .map(name => path.join('/isolated-tray-test/cover', name)), 'Generated covers still follow the portable data store');
  }
  assert.equal(runtime.externalWork.updates.length, 2, 'Only the two generated cover locations need updating');
  assert(runtime.externalWork.updates.every(update => !Object.hasOwn(update.values, 'filepath')),
    'Only identity-verified scan or relocation operations may change a book source');
  runtime.app.quit();
});

test('exit cancels random opens delayed by a database query or file access', async t => {
  const book = path.join(appDir, 'readable.zip');
  const reader = path.join(appDir, 'reader.exe');
  for (const phase of ['database query', 'book access', 'reader access']) {
    await t.test(phase, async () => {
      const reached = deferred();
      const release = deferred();
      const pause = async () => { reached.resolve(); await release.promise; };
      const runtime = createRuntime({ imageExplorer: reader, closeToTray: true }, {
        books: [{ filepath: book }],
        beforeFindAll: phase === 'database query' ? pause : async () => {},
        beforeAccess: async file => {
          if (file === (phase === 'book access' ? book : phase === 'reader access' ? reader : null)) await pause();
        },
      });
      await runtime.start();
      const opening = runtime.menu('随机打开漫画');
      await reached.promise;
      runtime.menu('退出');
      release.resolve();
      await opening;
      await settle();
      assert.equal(runtime.app.quitCompleted, true);
      assert.deepEqual(runtime.externalWork.paths, []);
      assert.deepEqual(runtime.externalWork.executions, []);
      assert.deepEqual(runtime.externalWork.dialogs, []);
    });
  }
});

test('external reader startup failures are reported without reopening the main window', async t => {
  const book = path.join(appDir, 'readable.zip');
  const reader = path.join(appDir, 'reader.exe');
  for (const [name, setting, options, expected] of [
    ['missing executable', { imageExplorer: reader }, { availablePaths: [book] }, /ENOENT/],
    ['spawn error', { imageExplorer: reader }, { readerError: new Error('spawn EACCES') }, /EACCES/],
    ['no system file association', {}, { openPathError: 'No app is associated with this file' }, /associated/],
  ]) {
    await t.test(name, async () => {
      const runtime = createRuntime({ minimizeOnStart: true, minimizeToTray: true, ...setting }, {
        books: [{ filepath: book }], ...options,
      });
      await runtime.start();
      runtime.windows[0].emit('ready-to-show');
      await runtime.menu('随机打开漫画');
      assert.equal(runtime.externalWork.dialogs.length, 1);
      assert.equal(runtime.externalWork.dialogs[0].title, '颜如玉');
      assert.match(runtime.externalWork.dialogs[0].message, expected);
      assert.equal(runtime.windows[0].visible, false);
      runtime.app.quit();
    });
  }
});

test('list-only reader returns original paths without decoding, copying, or streaming the whole book', async () => {
  const pages = [
    { relativePath: 'page #1.png', absolutePath: path.join(appDir, 'mock-archive', 'page #1.png') },
    { relativePath: 'page %2.webp', absolutePath: path.join(appDir, 'mock-archive', 'page %2.webp') },
  ];
  const runtime = createRuntime({}, { imageList: pages });
  await runtime.start();
  const book = { id: 'fixture-book', filepath: path.join(appDir, 'mock-book.zip'), type: 'archive' };
  const result = await runtime.invoke('load-manga-image-list', book, { backgroundProcessing: false });
  await settle();
  assert.deepEqual(result, pages, 'The file loader remains the source of directly readable original paths');
  assert.deepEqual(runtime.imageWork.loads, [{ filepath: book.filepath, type: 'archive' }]);
  assert.deepEqual(runtime.imageWork.metadata, []);
  assert.deepEqual(runtime.imageWork.resizes, []);
  assert.deepEqual(runtime.imageWork.files, []);
  assert.deepEqual(runtime.imageWork.copies, [], 'Original paths with URL characters must remain intact');
  assert.deepEqual(runtime.imageWork.cleared, [], 'List-only loading must not rebuild unused processed-page storage');
  assert.deepEqual(runtime.imageWork.events.filter(event => ['manga-image', 'manga-thumbnail-image'].includes(event.channel)), [], 'No legacy page or thumbnail stream should run');
  runtime.app.quit();
});

test('legacy reader calls without options still resize and stream pages and thumbnails', async () => {
  const pages = ['1.png', '2.webp'].map(name => ({
    relativePath: name, absolutePath: path.join(appDir, 'mock-book', name),
  }));
  const runtime = createRuntime({ widthLimit: 400 }, { imageList: pages });
  await runtime.start();
  const book = { id: 'fixture-book', filepath: path.join(appDir, 'mock-book'), type: 'folder' };
  // Opting out once must not change the default behavior of a later legacy call.
  await runtime.invoke('load-manga-image-list', book, { backgroundProcessing: false });
  const result = await runtime.invoke('load-manga-image-list', book);
  await settle();
  assert.deepEqual(result, pages);
  assert.equal(runtime.imageWork.metadata.length, pages.length);
  assert.equal(runtime.imageWork.resizes.length, pages.length * 2);
  assert.equal(runtime.imageWork.files.length, pages.length * 2);
  assert.equal(runtime.imageWork.cleared.length, 1);
  const images = runtime.imageWork.events.filter(event => event.channel === 'manga-image');
  const thumbnails = runtime.imageWork.events.filter(event => event.channel === 'manga-thumbnail-image');
  assert.equal(images.length, pages.length);
  assert.equal(thumbnails.length, pages.length);
  assert.deepEqual(images.map(event => event.payload.index), [1, 2]);
  assert(images.every(event => event.payload.width === 400 && event.payload.height === 600));
  assert(thumbnails.every(event => event.payload.thumbnailPath.includes('thumb_')));
  runtime.app.quit();
});
