'use strict';

// Runs both real renderer bundles with synthetic pages and a real temporary
// reading-state store. No connection is made to the desktop app or user data.
const { chromium } = require('./playwright-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-reading-bridge-'));
  let browser, activePage;
  const diagnostics = [];
  try {
    const id = 'synthetic_book_with_underscores';
    const pages = [];
    for (let index = 1; index <= 12; index++) {
      const absolutePath = path.join(directory, `page-${String(index).padStart(2, '0')}.svg`);
      await fs.writeFile(absolutePath, `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#e4ddd1"/><text x="40" y="200" font-size="24">Neutral page ${index}</text></svg>`);
      pages.push({ absolutePath, relativePath: path.basename(absolutePath), width: 300, height: 400 });
    }
    const book = { id, filepath: path.join(directory, 'synthetic-book'), title: 'Neutral reading fixture', pageCount: 12,
      coverPath: pages[0].absolutePath, type: 'folder', readCount: 2, hiddenBook: false, mark: true, tags: {}, hash: 'neutral',
      status: 'non-tag', date: 12345, bundleSize: 100, exist: true };
    const setting = { library: directory, imageExplorer: '', viewerType: 'original', directEnter: 'internalViewer', keepReadingProgress: true,
      pageSize: 42, theme: 'light e-hentai', widthLimit: 2000, hidePageNumber: false, thumbnailColumn: 10, loadOnStart: false,
      showTranslation: false, language: 'zh-CN', customOptions: '', defaultExpandTree: false, showComment: false, autoCheckUpdates: false,
      defaultInsertEmptyPage: false, reverseLeftRight: false, autoNextManga: false, keyMap: {}, titleBar: 'default', enableLANBrowsing: false };
    let store = createReadingStateStore({ storePath: directory });
    let uiState = null;
    const originalLegacy = {
      'room-progress': JSON.stringify({ [id]: { page: 4, total: 12, time: 1000 } }),
      viewerReadingProgress: JSON.stringify([{ bookId: id, pageId: `${id}_7` }]),
      recentRead: JSON.stringify([{ id, read_time: 2 }])
    };
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1300, height: 950 } });
    await context.route(/^https?:/, route => route.abort());
    await context.exposeBinding('__readingFixtureInvoke', async (_source, channel, args) => {
      if (channel === 'load-reading-state') return store.load();
      if (channel === 'migrate-reading-state') return store.migrate(args[0], [book]);
      if (channel === 'save-reading-progress') { assert.equal(args[0], id); return store.saveProgress(...args); }
      if (channel === 'load-ui-state') return uiState;
      if (channel === 'save-ui-state') { uiState = args[0]; return true; }
      if (channel === 'load-setting') return setting;
      if (channel === 'save-setting') { Object.assign(setting, args[0]); return setting; }
      if (channel === 'load-book-list' || channel === 'force-gene-book-list') return [book];
      if (channel === 'save-book') { assert.equal(args[0].id, id); Object.assign(book, args[0]); return book; }
      if (channel === 'load-manga-image-list') { assert.equal(args[0].id, id); return pages; }
      if (channel === 'load-collection-list') return [];
      if (channel === 'get-folder-tree') return [];
      if (channel === 'get-locale') return 'zh-CN';
      if (channel === 'window-is-maximized') return false;
      if (['release-sendimagelock', 'set-progress-bar', 'update-window-title', 'update-tag-translation', 'window-minimize', 'window-close'].includes(channel)) return null;
      throw Error('Unexpected fixture IPC: ' + channel);
    });
    await context.addInitScript(({ originalLegacy }) => {
      if (!localStorage.getItem('reading-fixture-seeded')) {
        for (const [key, value] of Object.entries(originalLegacy)) localStorage.setItem(key, value);
        localStorage.setItem('reading-fixture-seeded', 'true');
        localStorage.setItem('imageStyleType', 'single');
        localStorage.setItem('room-view', '"grid"');
      }
      const callbacks = new Map();
      window.ipcRenderer = {
        async invoke(channel, ...args) {
          const result = await window.__readingFixtureInvoke(channel, args);
          if (channel === 'load-manga-image-list' && args[1]?.backgroundProcessing !== false) {
            const book = args[0];
            result.forEach((image, offset) => setTimeout(() => {
              const payload = { ...image, filepath: image.absolutePath, id: `${book.id}_${offset + 1}`, index: offset + 1, total: result.length };
              callbacks.get('manga-image')?.(null, payload);
              callbacks.get('manga-thumbnail-image')?.(null, { ...payload, thumbnailPath: image.absolutePath, thumbId: `thumb_${payload.id}` });
            }, 40 + offset * 15));
          }
          return result;
        },
        on(channel, callback) { callbacks.set(channel, callback); },
        sendSync(channel) { if (channel === 'get-path-sep') return '\\'; throw Error(channel); }
      };
      window.electronFunction = { 'get-zoom-level': () => 0, 'set-zoom-level': () => {}, 'insert-css': () => {} };
    }, { originalLegacy });
    const page = await context.newPage();
    activePage = page;
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    const url = pathToFileURL(path.join(__dirname, '../resources/app/dist/index.html')).href;
    await page.goto(url);
    await page.locator(`#room [data-book="${id}"]`).waitFor();
    await page.locator(`#room [data-book="${id}"]`).dblclick();
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '7 / 12');
    assert.equal((await store.load()).progress[id].page, 7);
    console.log('PASS legacy migration opens the newer classic page in the room reader');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '9 / 12');
    await page.locator('[data-action="exit-reader"]').click();
    await page.waitForFunction(() => !document.querySelector('.reader'));
    assert.equal((await store.load()).progress[id].page, 9);
    console.log('PASS closing the room reader acknowledges page 9 on disk');
    await page.locator('[data-action="settings"]').click();
    await page.getByRole('button', { name: '打开完整管理界面', exact: true }).click();
    await page.locator('.book-cover-frame img').waitFor();
    await page.locator('.book-cover-frame img').click();
    await page.waitForFunction(() => { const image = document.querySelector('.drawer-viewer-body img'); return image?.src.split('?')[0].endsWith('page-09.svg') && image.complete && image.naturalWidth > 0; });
    console.log('PASS the actual classic reader resumes room page 9');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => { const image = document.querySelector('.drawer-viewer-body img'); return image?.src.split('?')[0].endsWith('page-10.svg') && image.complete && image.naturalWidth > 0; });
    await page.locator('.viewer-mode-setting').getByText('单页', { exact: true }).click();
    await page.getByRole('option', { name: '双页', exact: true }).click();
    await page.waitForFunction(id => window.readingState.classicReader?.()?.visiblePageIds?.includes(`${id}_10`), id);
    await page.evaluate(() => window.readingState.flush());
    assert.equal((await store.load()).progress[id].page, 10);
    console.log('PASS classic double-page display preserves the requested page 10 anchor');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => ![...document.querySelectorAll('.drawer-viewer-body')].some(element => element.offsetParent));
    await page.getByRole('button', { name: '返回 3D 阅览室', exact: true }).click();
    await page.locator(`#room [data-book="${id}"]`).waitFor();
    assert.equal((await store.load()).progress[id].page, 10);
    await page.locator(`#room [data-book="${id}"]`).dblclick();
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '10 / 12');
    console.log('PASS the last five classic pages no longer reset and room resumes page 10');
    await page.locator('[data-action="exit-reader"]').click();
    await page.waitForFunction(() => !document.querySelector('.reader'));
    const stored = JSON.parse(await fs.readFile(store.filePath, 'utf8'));
    assert.deepEqual(stored.migrationSnapshots[0].storage, originalLegacy);
    await store.flush();
    store = createReadingStateStore({ storePath: directory });
    await page.reload();
    await page.locator(`#room [data-book="${id}"]`).waitFor();
    assert.equal(await page.evaluate(id => window.readingState.get(id).page, id), 10);
    console.log('PASS restarting the main profile and renderer preserves page 10 and migration originals');
    await page.evaluate(({ id }) => {
      const reader = { store: { pageList: [[0, 1], [2, 3], [4, 5], [6, 7], [8, 9], [10, 11]], activePageIndex: 0 },
        props: { show: true, imgList: Array(12).fill('neutral') }, goto(index) { this.store.activePageIndex = index; } };
      window.__comicFixture = reader;
      window.readingState.attachComicReader(reader, { id, pageCount: 12 });
    }, { id });
    await page.waitForFunction(() => window.__comicFixture.store.activePageIndex === 4 && window.readingState.comic.ready);
    await page.evaluate(() => window.readingState.flush());
    assert.equal((await store.load()).progress[id].page, 10);
    console.log('PASS ComicRead double-page display preserves the requested page 10 anchor');
    await page.evaluate(async () => { window.__comicFixture.store.pageList = [[0], [1, 2], [3, 4], [5, 6], [7, 8], [9, 10], [11]]; window.__comicFixture.store.activePageIndex = 6; await window.readingState.flush(); window.readingState.closeComicReader(); });
    assert.equal((await store.load()).progress[id].page, 12);
    console.log('PASS ComicRead zero-based spread indices convert to one-based book pages');
    assert.equal(diagnostics.filter(value => !/net::ERR_FAILED|Failed to load resource|WebGL|THREE\./.test(value)).length, 0, diagnostics.join('\n'));
    await context.close();
    console.log('8 reading bridge checks passed with isolated synthetic content');
  } catch (error) {
    console.error(diagnostics.join('\n'));
    if (activePage && !activePage.isClosed()) console.error(await activePage.evaluate(() => JSON.stringify({
      text: document.body.innerText.slice(-1200), images: [...document.querySelectorAll('.drawer-viewer-body img')].map(image => ({ src: image.src, complete: image.complete, width: image.naturalWidth })),
      classic: window.readingState?.classicReader?.(), progress: window.readingState?.progress
    })));
    throw error;
  } finally {
    if (browser) await browser.close();
    if (!directory.startsWith(path.join(os.tmpdir(), 'yanruyu-reading-bridge-'))) throw Error('Unsafe fixture cleanup');
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
