'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { registerHooks } = require('node:module');
const { fileURLToPath, pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const RENDERER_DIR = path.join(ROOT, 'src', 'renderer');
const PRELOAD_PATH = path.join(ROOT, 'resources', 'app', 'preload.js');
const IPC_TYPES_PATH = path.join(RENDERER_DIR, 'types', 'ipc.ts');

// Enable Node 24 native TS execution for extensionless relative imports inside src/renderer/.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      context.parentURL &&
      context.parentURL.startsWith('file:')
    ) {
      const parentPath = fileURLToPath(context.parentURL);
      if (parentPath.startsWith(RENDERER_DIR) && !path.extname(specifier)) {
        const base = path.resolve(path.dirname(parentPath), specifier);
        for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
          if (fs.existsSync(candidate)) {
            return { url: pathToFileURL(candidate).href, shortCircuit: true };
          }
        }
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && url.endsWith('.ts')) {
      const filePath = fileURLToPath(url);
      if (filePath.startsWith(RENDERER_DIR)) {
        return {
          format: 'module-typescript',
          source: fs.readFileSync(filePath, 'utf8'),
          shortCircuit: true,
        };
      }
    }
    return nextLoad(url, context);
  },
});

function createMockPreloadHarness() {
  const invokeCalls = [];
  const invokeHandlers = new Map();
  const singletonEventListeners = new Map();
  let pathSep = '\\';
  let zoomLevel = 0;
  const insertedCss = [];

  const bridge = {
    invoke: async (channel, ...args) => {
      invokeCalls.push({ channel, args });
      if (invokeHandlers.has(channel)) {
        return invokeHandlers.get(channel)(...args);
      }
      return undefined;
    },
    // Mirrors resources/app/preload.js singleton consumer semantics.
    on: (channel, listener) => {
      singletonEventListeners.set(channel, listener);
    },
    sendSync: channel => {
      if (channel !== 'get-path-sep') throw new Error('IPC channel is not allowed');
      return pathSep;
    },
  };

  const electronFunction = {
    'get-zoom-level': () => zoomLevel,
    'set-zoom-level': level => {
      zoomLevel = level;
    },
    'insert-css': css => {
      insertedCss.push(css);
      return `css-${insertedCss.length}`;
    },
  };

  return {
    bridge,
    electronFunction,
    invokeCalls,
    setHandler(channel, handler) {
      invokeHandlers.set(channel, handler);
    },
    emit(channel, payload) {
      const listener = singletonEventListeners.get(channel);
      if (listener) listener(null, payload);
    },
    setPathSep(sep) {
      pathSep = sep;
    },
    getZoomLevel: () => zoomLevel,
    getInsertedCss: () => [...insertedCss],
    getSingletonListenerCount: () => singletonEventListeners.size,
  };
}

function createMemoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
    clear() {
      map.clear();
    },
    snapshot() {
      return Object.fromEntries(map.entries());
    },
  };
}

function loadPreloadChannels() {
  const source = fs.readFileSync(PRELOAD_PATH, 'utf8');
  const exposed = {};
  const registeredInvokeCalls = [];
  const registeredEventListeners = new Map();

  const sandbox = {
    require(mod) {
      if (mod !== 'electron') throw new Error(`Unexpected require: ${mod}`);
      return {
        contextBridge: {
          exposeInMainWorld(name, api) {
            exposed[name] = api;
          },
        },
        ipcRenderer: {
          invoke: async (channel, ...args) => {
            registeredInvokeCalls.push({ channel, args });
            return { ok: true, channel };
          },
          on: (channel, fn) => {
            registeredEventListeners.set(channel, fn);
          },
          removeListener: () => {},
          sendSync: channel => (channel === 'get-path-sep' ? '\\' : ''),
        },
        webFrame: {
          getZoomLevel: () => 0,
          setZoomLevel: () => {},
          insertCSS: () => 'key',
        },
      };
    },
    Set,
    Map,
    Promise,
    Error,
  };

  // Instrument source to capture exact invokeChannels and eventChannels sets from preload.js.
  const instrumented = `${source}\n;globalThis.__CAPTURED__ = { invokeChannels: [...invokeChannels], eventChannels: [...eventChannels] };`;
  sandbox.globalThis = sandbox;
  vm.runInNewContext(instrumented, sandbox, { filename: PRELOAD_PATH });

  return {
    invokeChannels: sandbox.__CAPTURED__.invokeChannels,
    eventChannels: sandbox.__CAPTURED__.eventChannels,
    exposed,
  };
}

let piniaMod;
let ipcTypesMod;
let ipcServiceMod;
let libraryMod;
let selectionMod;
let readingMod;
let settingsMod;
let tasksMod;

test.before(async () => {
  piniaMod = await import('pinia');
  ipcTypesMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'types', 'ipc.ts')).href);
  ipcServiceMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'services', 'ipc.ts')).href);
  libraryMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'stores', 'library.ts')).href);
  selectionMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'stores', 'selection.ts')).href);
  readingMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'stores', 'reading.ts')).href);
  settingsMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'stores', 'settings.ts')).href);
  tasksMod = await import(pathToFileURL(path.join(RENDERER_DIR, 'stores', 'tasks.ts')).href);
});

test.afterEach(() => {
  ipcServiceMod.setIpcBridgeForTesting(undefined, undefined);
  ipcServiceMod.resetIpcSubscriptions();
  delete globalThis.localStorage;
});

test('IPC channel parity: every invoke and event channel in preload.js is typed in ipc.ts', async () => {
  const preload = loadPreloadChannels();
  const typedInvoke = [...ipcTypesMod.INVOKE_CHANNELS];
  const typedEvents = [...ipcTypesMod.EVENT_CHANNELS];

  assert.deepEqual(
    new Set(typedInvoke),
    new Set(preload.invokeChannels),
    'INVOKE_CHANNELS in ipc.ts must match preload.js invokeChannels exactly'
  );
  assert.deepEqual(
    new Set(typedEvents),
    new Set(preload.eventChannels),
    'EVENT_CHANNELS in ipc.ts must match preload.js eventChannels exactly'
  );

  // Also verify InvokeChannelMap and EventChannelMap interface keys in ipc.ts cover every channel.
  const ipcSource = fs.readFileSync(IPC_TYPES_PATH, 'utf8');
  for (const channel of preload.invokeChannels) {
    assert.ok(
      ipcSource.includes(`'${channel}':`),
      `InvokeChannelMap in ipc.ts is missing channel "${channel}"`
    );
    const res = await preload.exposed.ipcRenderer.invoke(channel);
    assert.equal(res.ok, true, `preload.js rejected invoke channel "${channel}"`);
  }
  for (const channel of preload.eventChannels) {
    assert.ok(
      ipcSource.includes(`'${channel}':`),
      `EventChannelMap in ipc.ts is missing channel "${channel}"`
    );
    assert.doesNotThrow(
      () => preload.exposed.ipcRenderer.on(channel, () => {}),
      `preload.js rejected event channel "${channel}"`
    );
  }
  assert.equal(preload.exposed.ipcRenderer.sendSync('get-path-sep'), '\\');
});

test('IPC service wrapper multiplexes preload singleton listeners and handles missing bridge safely', async () => {
  assert.equal(ipcServiceMod.hasIpc(), false);
  assert.equal(ipcServiceMod.getPathSep(), '/');
  assert.equal(ipcServiceMod.electronZoom().get(), 0);
  await assert.rejects(() => ipcServiceMod.invoke('load-setting'), /IPC bridge is unavailable/);

  const harness = createMockPreloadHarness();
  harness.setHandler('load-setting', () => ({ library: 'E:\\Books' }));
  ipcServiceMod.setIpcBridgeForTesting(harness.bridge, harness.electronFunction);

  assert.equal(ipcServiceMod.hasIpc(), true);
  assert.equal(ipcServiceMod.getPathSep(), '\\');
  const setting = await ipcServiceMod.invoke('load-setting');
  assert.equal(setting.library, 'E:\\Books');

  // Multiple subscribers on the same channel must all receive events despite preload's singleton `on`.
  const receivedA = [];
  const receivedB = [];
  const unsubA = ipcServiceMod.onEvent('tasks-changed', payload => receivedA.push(payload.tasks.length));
  const unsubB = ipcServiceMod.onEvent('tasks-changed', payload => receivedB.push(payload.tasks.length));
  assert.equal(harness.getSingletonListenerCount(), 1);

  harness.emit('tasks-changed', { tasks: [{ id: 't1' }, { id: 't2' }] });
  assert.deepEqual(receivedA, [2]);
  assert.deepEqual(receivedB, [2]);

  unsubA();
  harness.emit('tasks-changed', { tasks: [{ id: 't3' }] });
  assert.deepEqual(receivedA, [2]);
  assert.deepEqual(receivedB, [2, 1]);
  unsubB();

  // electronZoom wrapper
  const zoom = ipcServiceMod.electronZoom();
  zoom.set(1.5);
  assert.equal(zoom.get(), 1.5);
  assert.equal(zoom.insertCss('body { color: red; }'), 'css-1');
  assert.deepEqual(harness.getInsertedCss(), ['body { color: red; }']);
});

test('LibraryIndex & useLibraryStore: filtering, tag include/exclude, classic query, and author sorting', async () => {
  const pinia = piniaMod.createPinia();
  piniaMod.setActivePinia(pinia);

  const books = [
    {
      id: 'b1',
      title: 'Zeta Story',
      title_jpn: 'ゼータ物語',
      filepath: 'E:\\Library\\SeriesA\\Zeta [汉化].zip',
      category: 'Doujinshi',
      pageCount: 40,
      rating: 4.5,
      mark: true,
      readCount: 3,
      date: 1700000001000,
      tags: { artist: ['River Studio', 'Alpha'], parody: ['Original'] },
    },
    {
      id: 'b2',
      title: 'Beta Tale',
      filepath: 'E:\\Library\\SeriesA\\Beta.zip',
      category: 'Manga',
      pageCount: 120,
      rating: 5.0,
      mark: false,
      readCount: 1,
      date: 1700000005000,
      tags: { artist: ['Beta Artist'], female: ['glasses'] },
    },
    {
      id: 'b3',
      title: 'No Author Sketch',
      filepath: 'E:\\Library\\SeriesB\\Sketch.zip',
      category: 'Image Set',
      pageCount: 25,
      rating: 3.0,
      mark: true,
      readCount: 0,
      date: 1700000003000,
      tags: { other: ['monochrome'] },
    },
    {
      id: 'b4',
      title: 'Hidden Entry',
      filepath: 'E:\\Library\\SeriesA\\Hidden.zip',
      hiddenBook: true,
      tags: { artist: ['AAA First'] },
    },
  ];
  const collections = [{ id: 'col-1', title: 'Selected', list: ['b1', 'b3'] }];

  const readingStore = readingMod.useReadingStore();
  readingStore.applyProfileSnapshot({
    schemaVersion: 1,
    pageBase: 1,
    revision: 1,
    progress: {
      b1: { page: 40, total: 40, offset: 0, time: 1700000100000, source: 'room' },
      b2: { page: 12, total: 120, offset: 0, time: 1700000200000, source: 'room' },
    },
    preferences: {},
    visits: {},
    migrations: { legacyV1: true },
    migrationSnapshots: [],
  });

  const libraryStore = libraryMod.useLibraryStore();
  libraryStore.setBooks(books, collections, 'E:\\Library');

  // Hidden book is excluded from index
  assert.deepEqual(
    libraryStore.visibleBooks.map(b => b.id),
    ['b2', 'b3', 'b1']
  );

  // Inferred Chinese language tag from filename [汉化]
  const zhKey = libraryMod.tagKey('language', 'chinese');
  assert.ok(libraryStore.index.tags.has(zhKey));
  assert.equal(libraryStore.index.tags.get(zhKey).inferred, true);

  // Author sort: canonicalized coauthors ('Alpha' < 'Beta Artist') and blank authors LAST ('b3')
  libraryStore.setSort('author');
  assert.deepEqual(
    libraryStore.visibleBooks.map(b => b.id),
    ['b1', 'b2', 'b3']
  );

  // Tag include & exclude (mutual exclusion)
  assert.equal(libraryStore.toggleTag(zhKey, false), true);
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1']);
  assert.equal(libraryStore.toggleTag(zhKey, true), true);
  assert.deepEqual(libraryStore.query.selectedTags, []);
  assert.deepEqual(libraryStore.query.excludedTags, [zhKey]);
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b2', 'b3']);
  libraryStore.clearTags();

  // Folder filter
  libraryStore.setFolder('SeriesA');
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1', 'b2']);
  libraryStore.setFolder('');

  // Collection filter
  libraryStore.setCollection('col-1');
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1', 'b3']);
  libraryStore.setCollection('');

  // Classic query syntax: author + excluded category + read count comparison
  libraryStore.setClassicQuery('a:"River Studio"$ -cat:Manga :count>1');
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1']);

  // Classic query OR alternative (~)
  libraryStore.setClassicQuery('a:"River Studio"$ ~cat:Manga');
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1', 'b2']);
  libraryStore.resetFilters();

  // Status counts & favorites summary
  assert.deepEqual(libraryStore.statusCounts, { reading: 1, finished: 1, unread: 1 });
  assert.equal(libraryStore.favoriteCount, 2);
  libraryStore.setFavorites(true);
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1', 'b3']);
  libraryStore.setFilter('finished');
  assert.deepEqual(libraryStore.visibleBooks.map(b => b.id), ['b1']);
});

test('useSelectionStore: cross-page multi-select, workspace round-trip, and filtered-out recovery', () => {
  const pinia = piniaMod.createPinia();
  piniaMod.setActivePinia(pinia);

  const selection = selectionMod.useSelectionStore();
  const allBooks = Array.from({ length: 18 }, (_, i) => ({
    id: `book-${i + 1}`,
    title: `Book ${i + 1}`,
    mark: i % 2 === 0,
  }));

  // Enter library workspace & test cross-page multi-select
  selection.setWorkspace('library');
  selection.setLibraryView('table');
  const page1Ids = allBooks.slice(0, 12).map(b => b.id);
  const page2Ids = allBooks.slice(12).map(b => b.id);

  selection.toggleChecked('book-2');
  selection.toggleChecked('book-5');
  assert.equal(selection.isPageAllChecked(page1Ids), false);
  assert.equal(selection.isPageIndeterminate(page1Ids), true);

  // Move to page 2 and select entire page 2 while preserving page 1 selections
  selection.saveLibraryPosition({ page: 2, scrollTop: 340, selectedId: 'book-14' });
  selection.selectBook('book-14');
  selection.togglePageChecked(page2Ids, true);
  assert.equal(selection.isPageAllChecked(page2Ids), true);
  assert.equal(selection.checkedCount, 2 + page2Ids.length);
  assert.equal(selection.checkedIds.has('book-2'), true);
  assert.equal(selection.checkedIds.has('book-18'), true);

  // Workspace round-trip: library -> room -> library restores exact anchor
  const activeQuery = libraryMod.normalizeShelfQuery({ favorites: true, search: 'Book' });
  const toRoom = selection.setWorkspace('room', {
    bookId: 'book-14',
    currentQuery: activeQuery,
    currentPage: 2,
    currentScrollTop: 340,
    visibleBooks: allBooks,
    perPage: 12,
  });
  assert.equal(toRoom.workspace, 'room');
  assert.equal(selection.selectedId, 'book-14');
  assert.deepEqual(selection.roomQuery, activeQuery);
  assert.deepEqual(selection.libraryPosition, { page: 2, scrollTop: 340, selectedId: 'book-14' });

  const backToLibrary = selection.setWorkspace('library', { visibleBooks: allBooks, perPage: 12 });
  assert.equal(backToLibrary.workspace, 'library');
  assert.equal(backToLibrary.page, 2);
  assert.equal(backToLibrary.scrollTop, 340);
  assert.equal(backToLibrary.selectedId, 'book-14');
  assert.equal(selection.filteredOutNotice, null);

  // Selected book edited and filtered out of active query -> selects neighbor & surfaces "查看此书" notice
  const filteredBooks = allBooks.filter(b => b.id !== 'book-14');
  const editRecovery = selection.reconcileAfterMutation({
    previousIndex: 13,
    nextVisibleBooks: filteredBooks,
    allBooks,
    perPage: 12,
    preferNoticeFocus: true,
  });
  assert.equal(editRecovery.selectedId, 'book-15');
  assert.equal(editRecovery.page, 2);
  assert.equal(editRecovery.focusTarget, 'filtered-notice');
  assert.equal(editRecovery.focusBookId, 'book-14');
  assert.deepEqual(selection.filteredOutNotice, {
    bookId: 'book-14',
    reason: 'filtered',
    message: '这本书已移出当前筛选。',
    canShowBook: true,
  });
  // Filtered-out book was also pruned from checkedIds, while other cross-page checks remain
  assert.equal(selection.checkedIds.has('book-14'), false);
  assert.equal(selection.checkedIds.has('book-2'), true);

  // Notice clears automatically if book re-enters visible list
  selection.reconcileNotice(allBooks, allBooks);
  assert.equal(selection.filteredOutNotice, null);

  // Hidden book removal -> preserves query, selects neighbor, shows hidden notice
  selection.selectBook('book-15');
  const withHidden = allBooks.map(b => (b.id === 'book-15' ? { ...b, hiddenBook: true } : b));
  const visibleWithoutHidden = withHidden.filter(b => !b.hiddenBook);
  const hideRecovery = selection.reconcileAfterMutation({
    previousIndex: 14,
    nextVisibleBooks: visibleWithoutHidden,
    allBooks: withHidden,
    perPage: 12,
  });
  assert.equal(hideRecovery.selectedId, 'book-16');
  assert.equal(hideRecovery.focusTarget, 'book');
  assert.equal(selection.filteredOutNotice.reason, 'hidden');
  assert.equal(selection.filteredOutNotice.canShowBook, true);

  // Deleted last book -> empty fallback, removed notice with canShowBook = false
  selection.selectBook('only-book');
  const deleteRecovery = selection.reconcileAfterMutation({
    previousIndex: 0,
    nextVisibleBooks: [],
    allBooks: [],
    perPage: 12,
  });
  assert.equal(deleteRecovery.selectedId, '');
  assert.equal(deleteRecovery.focusTarget, 'empty');
  assert.deepEqual(selection.filteredOutNotice, {
    bookId: 'only-book',
    reason: 'removed',
    message: '所选书已从书库移除，原查询已保留。',
    canShowBook: false,
  });
});

test('useReadingStore: status, progress/preference normalization, IPC load/migration/flush, and visit events', async () => {
  const pinia = piniaMod.createPinia();
  piniaMod.setActivePinia(pinia);

  const storage = createMemoryStorage({
    'room-progress': JSON.stringify({ b1: { page: 5, total: 20, offset: 0, time: 1000 } }),
  });
  globalThis.localStorage = storage;

  const harness = createMockPreloadHarness();
  harness.setHandler('load-reading-state', () => ({
    schemaVersion: 1,
    pageBase: 1,
    revision: 0,
    progress: {},
    preferences: {},
    visits: {},
    migrations: {},
    migrationSnapshots: [],
  }));
  harness.setHandler('migrate-reading-state', payload => {
    assert.ok(payload['room-progress']);
    return {
      schemaVersion: 1,
      pageBase: 1,
      revision: 1,
      progress: {
        b1: { page: 5, total: 20, offset: 0, time: 1000, source: 'migration' },
      },
      preferences: {
        b1: { mode: 'double', direction: 'rtl', fit: 'width', zoom: 125, coverAlone: false },
      },
      visits: {
        b2: { time: 2500, source: 'external' },
      },
      migrations: { legacyV1: true },
      migrationSnapshots: [],
    };
  });
  harness.setHandler('save-reading-progress', (_id, value) => value);
  harness.setHandler('save-reading-preferences', (_id, value) => value);
  harness.setHandler('save-reading-visit', (_id, value) => value);
  ipcServiceMod.setIpcBridgeForTesting(harness.bridge, harness.electronFunction);

  const reading = readingMod.useReadingStore();
  await reading.load();

  assert.equal(reading.loaded, true);
  assert.equal(reading.readingStatus({ id: 'b1' }), 'reading');
  assert.equal(reading.readingStatus({ id: 'b2' }), 'reading');
  assert.equal(reading.readingStatus({ id: 'b3', readCount: 0 }), 'unread');
  assert.equal(reading.readingStatus({ id: 'b4', readCount: 2 }), 'reading');
  assert.equal(reading.readingTime({ id: 'b2' }), 2500);
  assert.equal(reading.readingPercent({ id: 'b1' }), 25);

  // Preferences resolution with defaults & clamping
  assert.deepEqual(reading.getPreferences('b1'), {
    mode: 'double',
    direction: 'rtl',
    fit: 'width',
    zoom: 125,
    coverAlone: false,
  });
  assert.deepEqual(reading.getPreferences('unknown', { mode: 'continuous', zoom: 999 }), {
    mode: 'continuous',
    direction: 'ltr',
    fit: 'page',
    zoom: 250,
    coverAlone: true,
  });

  // Save progress -> clamps page <= total and marks finished
  await reading.saveProgress('b1', { page: 25, total: 20, offset: 1.5, time: 5000, source: 'room' }, { immediate: true });
  assert.equal(reading.getProgress('b1').page, 20);
  assert.equal(reading.getProgress('b1').offset, 0.99);
  assert.equal(reading.readingStatus({ id: 'b1' }), 'finished');

  // Save preferences & visit -> flushes through IPC
  await reading.savePreferences('b3', { mode: 'continuous', zoom: 40 }, { immediate: true });
  assert.equal(reading.getPreferences('b3').zoom, 50);
  await reading.saveVisit('b3', { time: 7000, source: 'external' }, { immediate: true });
  assert.equal(reading.readingTime({ id: 'b3' }), 7000);

  // Push event from main process updates visit timestamp
  harness.emit('reading-visit-saved', { bookId: 'b3', visit: { time: 9000, source: 'classic' } });
  assert.equal(reading.readingTime({ id: 'b3' }), 9000);

  // Rejects prototype pollution keys and invalid page values
  await assert.rejects(() => reading.saveProgress('__proto__', { page: 1, total: 10 }));
  await assert.rejects(() => reading.saveProgress('b1', { page: 0, total: 10 }));

  const channelsCalled = harness.invokeCalls.map(c => c.channel);
  assert.deepEqual(channelsCalled, [
    'load-reading-state',
    'migrate-reading-state',
    'save-reading-progress',
    'save-reading-preferences',
    'save-reading-visit',
  ]);
});

test('useSettingsStore: 4-theme migration map, quality/startPage normalization, and setting persistence', async () => {
  const pinia = piniaMod.createPinia();
  piniaMod.setActivePinia(pinia);

  // Exhaustive legacy theme migration checks
  const cases = [
    ['paper', 'paper'],
    ['dark', 'dark'],
    ['glass', 'glass'],
    ['ex', 'ex'],
    ['light', 'paper'],
    ['light e-hentai', 'paper'],
    ['acid', 'paper'],
    ['forest', 'dark'],
    ['hub', 'dark'],
    ['terminal', 'dark'],
    ['neon', 'dark'],
    ['dark nhentai', 'dark'],
    ['dark exhentai', 'ex'],
    ['gallery', 'ex'],
    ['FOREST', 'dark'],
    ['unknown-theme', null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(settingsMod.normalizeThemeId(input), expected, `normalizeThemeId("${input}")`);
  }

  // room-night: true migrates to neutral dark ('dark')
  assert.equal(settingsMod.resolveThemeId({ roomNight: true }), 'dark');
  assert.equal(settingsMod.resolveThemeId({ settingTheme: 'dark exhentai' }), 'ex');
  assert.equal(settingsMod.resolveThemeId({}), 'paper');

  // Store hydration & persistence with localStorage + IPC
  const storage = createMemoryStorage({
    'room-theme': JSON.stringify('forest'),
    'room-night': JSON.stringify(true),
    appTheme: 'dark nhentai',
    'room-quality': JSON.stringify('fine'),
    'room-workspace-start-page': JSON.stringify('library'),
  });
  globalThis.localStorage = storage;

  const harness = createMockPreloadHarness();
  harness.setHandler('load-setting', () => ({
    library: 'E:\\Manga',
    theme: 'light e-hentai',
    customFlag: 'keep-me',
  }));
  harness.setHandler('save-setting', next => next);
  ipcServiceMod.setIpcBridgeForTesting(harness.bridge, harness.electronFunction);

  const settings = settingsMod.useSettingsStore();
  await settings.load();

  assert.equal(settings.theme, 'dark');
  assert.equal(settings.isDarkTheme, true);
  assert.equal(settings.quality, 'fine');
  assert.equal(settings.qualityPreset.coverDimension, 1600);
  assert.equal(settings.startPage, 'library');
  assert.equal(settings.setting.customFlag, 'keep-me');

  // Switching theme migrates & cleans up legacy localStorage keys
  assert.equal(settings.setTheme('gallery'), 'ex');
  assert.equal(settings.theme, 'ex');
  assert.equal(storage.getItem('room-theme'), JSON.stringify('ex'));
  assert.equal(storage.getItem('room-night'), null);
  assert.equal(storage.getItem('appTheme'), null);

  // Saving partial setting preserves existing setting.json fields untouched
  const saved = await settings.saveSetting({ pageSize: 60 });
  assert.equal(saved.library, 'E:\\Manga');
  assert.equal(saved.customFlag, 'keep-me');
  assert.equal(saved.pageSize, 60);

  // Invalid quality/startPage fall back cleanly
  assert.equal(settings.setQuality('ultra'), 'balanced');
  assert.equal(settings.setStartPage('unknown'), 'desk');
});

test('useTasksStore: loads tasks, reacts to tasks-changed events, and dispatches lifecycle actions', async () => {
  const pinia = piniaMod.createPinia();
  piniaMod.setActivePinia(pinia);

  const harness = createMockPreloadHarness();
  let serverTasks = [
    {
      id: 't1',
      kind: 'scan',
      title: '增量扫描书库',
      status: 'running',
      current: 5,
      total: 10,
      progress: 0.5,
      message: '扫描中',
      errors: [],
      errorCount: 0,
      canCancel: true,
      canRetry: false,
      createdAt: 1000,
      updatedAt: 1000,
    },
  ];
  harness.setHandler('task-list', () => serverTasks);
  harness.setHandler('task-start', (kind, options) => {
    const next = {
      id: 't2',
      kind,
      title: '刷新元数据',
      status: 'queued',
      current: 0,
      total: 0,
      progress: null,
      message: JSON.stringify(options),
      errors: [],
      errorCount: 0,
      canCancel: true,
      canRetry: false,
      createdAt: 2000,
      updatedAt: 2000,
    };
    serverTasks = [next, ...serverTasks];
    return next;
  });
  harness.setHandler('task-cancel', id => {
    serverTasks = serverTasks.map(t => (t.id === id ? { ...t, status: 'cancelled' } : t));
  });
  harness.setHandler('task-retry', id => {
    serverTasks = serverTasks.map(t => (t.id === id ? { ...t, status: 'queued' } : t));
    return serverTasks.find(t => t.id === id);
  });
  harness.setHandler('task-dismiss', id => {
    serverTasks = serverTasks.filter(t => t.id !== id);
  });
  ipcServiceMod.setIpcBridgeForTesting(harness.bridge, harness.electronFunction);

  const tasks = tasksMod.useTasksStore();
  await tasks.load();
  assert.equal(tasks.activeCount, 1);
  assert.equal(tasks.hasFailures, false);

  await tasks.start('metadata', { rebuild: false });
  assert.equal(tasks.activeCount, 2);

  await tasks.cancel('t1');
  assert.equal(tasks.activeCount, 1);

  // Push event with a failed task updates activeCount & hasFailures reactively
  harness.emit('tasks-changed', {
    tasks: [
      {
        id: 't3',
        kind: 'metadata-batch',
        title: '批量拉取',
        status: 'completed-with-errors',
        current: 10,
        total: 10,
        progress: 1,
        message: '部分失败',
        errors: [{ message: '网络超时' }],
        errorCount: 1,
        createdAt: 3000,
        updatedAt: 3000,
      },
    ],
  });
  assert.equal(tasks.activeCount, 0);
  assert.equal(tasks.hasFailures, true);

  await tasks.retry('t1');
  await tasks.dismiss('t2');
  assert.equal(
    harness.invokeCalls.filter(c => ['task-start', 'task-cancel', 'task-retry', 'task-dismiss'].includes(c.channel)).length,
    4
  );
});
