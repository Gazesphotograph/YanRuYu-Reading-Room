'use strict';

// Standalone UI regression suite. It starts a new headless Edge instance with fake IPC;
// it never connects to the running desktop app or opens its real book database.
// Usage: node tools/test-gallery.cjs [--screenshots] [--case=themes,reading]
const { chromium } = require('./playwright-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { migrateLegacyProgress, normalizeProgress, normalizePreferences } = require('../resources/app/modules/reading_state');

const base = path.resolve(__dirname, '..');
const appURL = pathToFileURL(path.join(base, 'resources', 'app', 'dist', 'index.html')).href;
const outDir = path.resolve(process.env.GALLERY_TEST_OUTPUT || path.join(__dirname, '.artifacts', 'gallery'));
const themeIds = ['paper', 'glass', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid'];
const bookSelector = '#room [data-book]';
const selectedCases = new Set((process.argv.find(value => value.startsWith('--case=')) || '').slice(7).split(',').filter(Boolean));
const saveScreenshots = process.argv.includes('--screenshots');
const report = { date: new Date().toISOString(), source: 'isolated fake library', checks: [], cases: [], failures: [], diagnostics: [] };
const clone = value => JSON.parse(JSON.stringify(value));
let activeCase = '';

function launchOptions() {
  return {
    ...(process.env.GALLERY_BROWSER_PATH ? { executablePath: process.env.GALLERY_BROWSER_PATH } : { channel: 'msedge' }),
    headless: true,
    args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader'],
  };
}

function createFixtures(directory, count = 25, readerPageCount = 5) {
  fs.mkdirSync(directory, { recursive: true });
  const colors = ['#526663', '#977d68', '#647681', '#8b665b', '#808472', '#737483'];
  const coverPaths = Array.from({ length: Math.max(count, readerPageCount) }, (_, index) => {
    const file = path.join(directory, `书页 #% ${String(index).padStart(2, '0')}.svg`);
    const label = String(index + 1).padStart(2, '0');
    fs.writeFileSync(file, `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="707" viewBox="0 0 500 707"><rect width="500" height="707" fill="${colors[index % colors.length]}"/><rect x="24" y="24" width="452" height="659" fill="none" stroke="#eee9d9" opacity=".3"/><circle cx="330" cy="236" r="132" fill="#ece6d7" opacity=".65"/><path d="M45 500 185 300 355 512 455 410V555H45Z" fill="#203330" opacity=".4"/><text x="48" y="88" font-family="Georgia,serif" font-size="21" letter-spacing="3" fill="#faf8ed">STILL LIFE / ${label}</text><text x="48" y="613" font-family="Georgia,serif" font-size="43" fill="#faf8ed">Quiet Objects</text><text x="50" y="645" font-family="Arial,sans-serif" font-size="13" letter-spacing="2" fill="#f2efe0">A NEUTRAL INTERFACE TEST COVER</text></svg>`, 'utf8');
    return file;
  });
  const books = Array.from({ length: count }, (_, index) => ({
    id: `gallery-book-${String(index).padStart(2, '0')}`,
    title: `静物档案 ${String(index + 1).padStart(2, '0')}`,
    coverPath: coverPaths[index],
    filepath: path.join(directory, `模拟书籍 ${String(index).padStart(2, '0')}`),
    pageCount: readerPageCount + index,
    createdAt: new Date(Date.UTC(2026, 8, 12 - index)).toISOString(),
    category: 'Artbook',
    rating: index % 5,
    mark: false,
    readCount: 0,
    tags: { artist: [index % 2 ? '作者乙' : '作者甲'], other: ['静物', '图像档案'] },
  }));
  return { books, pages: coverPaths.slice(0, readerPageCount) };
}

function createFakeModel(books, pages) {
  return {
    books: clone(books),
    collections: [],
    tasks: [],
    pages: [...pages],
    setting: { library: '仅供自动检查的模拟书库', imageExplorer: '' },
    fileSelection: null,
    externalError: null,
    calls: [],
    uiState: null,
    readingState: { schemaVersion: 1, pageBase: 1, revision: 0, progress: {}, migrations: {} },
    async invoke(channel, ...args) {
      this.calls.push({ channel, args: clone(args) });
      if (channel === 'load-ui-state') return clone(this.uiState);
      if (channel === 'save-ui-state') { this.uiState = clone(args[0]); return clone(this.uiState); }
      if (channel === 'load-reading-state') return clone(this.readingState);
      if (channel === 'migrate-reading-state') {
        if (!this.readingState.migrations.legacyV1) {
          this.readingState.progress = migrateLegacyProgress(args[0], this.books, this.readingState.progress).progress;
          this.readingState.migrations.legacyV1 = { migratedAt: Date.now() };
        }
        return clone(this.readingState);
      }
      if (channel === 'save-reading-progress') {
        assert(this.books.some(book => book.id === args[0]), 'The UI attempted to save progress outside the fake library');
        const progress = normalizeProgress(args[1]); this.readingState.progress[args[0]] = progress;
        this.readingState.revision++; return clone(progress);
      }
      if (channel === 'save-reading-preferences') {
        assert(this.books.some(book => book.id === args[0]), 'Preferences must belong to the fake library');
        const preferences = normalizePreferences(args[1]);
        this.readingState.preferences ||= {}; this.readingState.preferences[args[0]] = preferences;
        this.readingState.revision++; return clone(preferences);
      }
      if (channel === 'load-setting') return clone(this.setting);
      if (channel === 'save-setting') {
        assert.equal(args[0].library, this.setting.library, 'Reader options must preserve the fake library setting');
        this.setting = clone(args[0]);
        return clone(this.setting);
      }
      if (channel === 'load-book-list') return clone(this.books);
      if (channel === 'load-collection-list') return clone(this.collections);
      if (channel === 'task-list') return clone(this.tasks);
      if (channel === 'image-cache-status') return {budgetBytes:2147483648,usedBytes:0,protectedBytes:0,entryCount:0,activeEntries:0,freeBytes:107374182400,minFreeBytes:268435456};
      if (channel === 'image-cache-clear') return {budgetBytes:2147483648,usedBytes:0,protectedBytes:0,entryCount:0,activeEntries:0,freeBytes:107374182400,minFreeBytes:268435456,removedEntries:0,removedBytes:0};
      if (channel === 'image-cache-budget') {this.setting.imageCacheBudgetMB=args[0]/1048576;return {budgetBytes:args[0],usedBytes:0,protectedBytes:0,entryCount:0,activeEntries:0,freeBytes:107374182400,minFreeBytes:268435456};}
      if (channel === 'save-book') {
        const index = this.books.findIndex(book => book.id === args[0].id);
        assert.notEqual(index, -1, 'The UI attempted to write a book outside the fake library');
        Object.assign(this.books[index],clone(args[0]));
        return clone(this.books[index]);
      }
      if (channel === 'load-manga-image-list') {
        assert(this.books.some(book => book.id === args[0].id), 'The UI requested an unknown fixture book');
        return this.pages.map(absolutePath => ({ absolutePath }));
      }
      if (channel === 'open-local-book') {
        assert(this.books.some(book => book.filepath === args[0]), 'External reader received a path outside the fake library');
        if (this.externalError) throw new Error(this.externalError);
        return null;
      }
      if (['release-sendimagelock', 'update-window-title', 'show-file', 'window-minimize', 'window-toggle-maximize', 'window-close'].includes(channel)) return null;
      if (channel === 'select-folder') return null;
      if (channel === 'select-file') return clone(this.fileSelection);
      throw new Error('Unexpected IPC channel in isolated gallery test: ' + channel);
    },
  };
}

async function attachFakeIpc(context, model, { forceWebglUnavailable = false } = {}) {
  await context.exposeBinding('__galleryFakeInvoke', (_source, channel, args) => model.invoke(channel, ...args));
  await context.addInitScript(({ forceWebglUnavailable }) => {
    const listeners = new Map();
    window.ipcRenderer = {
      invoke: (channel, ...args) => window.__galleryFakeInvoke(channel, args),
      on(channel, callback) {
        if (!listeners.has(channel)) listeners.set(channel, []);
        listeners.get(channel).push(callback);
      },
      removeListener(channel, callback) {
        listeners.set(channel, (listeners.get(channel) || []).filter(item => item !== callback));
      },
    };
    window.__galleryEmit = (channel, data) => (listeners.get(channel) || []).forEach(callback => callback({}, data));
    if (forceWebglUnavailable) {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...args) {
        if (/^(webgl2?|experimental-webgl)$/i.test(type)) return null;
        return original.call(this, type, ...args);
      };
    }
  }, { forceWebglUnavailable });
}

function pass(name, details) {
  report.checks.push({ case: activeCase, name, ...(details ? { details } : {}) });
  console.log('PASS ' + name);
}

async function waitForCount(page, expected) {
  await page.waitForFunction(({ selector, expected }) => document.querySelectorAll(selector).length === expected && !!document.querySelector('#results')?.textContent, { selector: bookSelector, expected });
}

async function waitForScene(page, expected = 'ready') {
  await page.waitForFunction(expected => {
    const element = document.querySelector('.scene-viewport[data-scene-state]') || document.querySelector('[data-scene-state]');
    return element?.dataset.sceneState === expected;
  }, expected, { timeout: 30000 });
  if (expected === 'ready') {
    const canvases = page.locator('canvas.scene-canvas');
    assert.equal(await canvases.count(), 1, 'There should be one scene canvas');
    const canvasState = await canvases.evaluate(canvas => {
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      const rect = canvas.getBoundingClientRect();
      return { width: canvas.width, height: canvas.height, clientWidth: rect.width, clientHeight: rect.height, active: !!gl && !gl.isContextLost() };
    });
    assert(canvasState.active, 'The scene reported ready without an active WebGL context');
    assert(canvasState.width > 0 && canvasState.height > 0 && canvasState.clientWidth > 0 && canvasState.clientHeight > 0, 'The scene canvas is empty');
  }
}

async function settleLayout(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function sceneStopsRendering(page) {
  // waitForFunction treats a returned Promise as truthy in this Playwright runtime.
  // Await the complete sampling operation with evaluate instead of using an async predicate.
  const stopped = await page.evaluate(() => new Promise(resolve => {
    const started = performance.now();
    let previous = -1;
    let quietSince = started;
    const sample = () => {
      const now = performance.now();
      const count = Number(document.querySelector('.scene-viewport')?.dataset.renderCount);
      if (count !== previous) { previous = count; quietSince = now; }
      if (count > 0 && now - quietSince >= 240) return resolve(true);
      if (now - started >= 8000) return resolve(false);
      setTimeout(sample, 60);
    };
    sample();
  }));
  assert(stopped, 'The scene did not stop rendering within eight seconds');
}

async function noOverflow(page) {
  await settleLayout(page);
  const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
  assert(sizes.scroll <= sizes.viewport + 1, `Horizontal overflow: ${sizes.scroll}px content in ${sizes.viewport}px window`);
}

async function bookIds(page) {
  return page.locator(bookSelector).evaluateAll(elements => elements.map(element => element.dataset.book));
}

async function setView(page, view) {
  await page.locator(`[data-view="${view}"]`).click();
  await page.waitForFunction(view => document.querySelector(`[data-view="${view}"]`)?.getAttribute('aria-pressed') === 'true', view);
  if (view === 'shelf' && await page.locator(bookSelector).count()) await waitForScene(page);
  if (view === 'grid') await page.waitForSelector('.book-grid');
}

async function dismissDialog(page) {
  if (await page.locator('#modal-root [role="dialog"]').count()) {
    await page.keyboard.press('Escape');
    await page.waitForSelector('#modal-root [role="dialog"]', { state: 'detached' });
  }
}

async function screenshot(page, name) {
  if (!saveScreenshots) return;
  await settleLayout(page);
  await page.screenshot({ path: path.join(outDir, `${activeCase}-${name}.png`), fullPage: true });
}

async function readerPage(page, expected, total = 5) {
  await page.waitForFunction(({ expected, total }) => {
    const continuous = document.querySelector('.reader')?.dataset.readingMode === 'continuous';
    const image = document.querySelector(continuous ? `.continuous-page[data-reader-page="${expected}"] img` : '.reader-body img');
    return document.querySelector('#reader-page')?.textContent.trim() === `${expected} / ${total}` && image?.complete && image.naturalWidth > 0;
  }, { expected, total });
}

async function withFixture(browser, fixture, callback, options = {}) {
  const model = createFakeModel(fixture.books, fixture.pages);
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 }, reducedMotion: options.reducedMotion || 'no-preference' });
  const rendererErrors = [];
  const consoleErrors = [];
  let page;
  try {
    await attachFakeIpc(context, model, options);
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => rendererErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(appURL);
    await page.waitForSelector('.shell');
    await waitForCount(page, Math.min(12, fixture.books.length));
    await callback(page, model);
    assert.deepEqual(rendererErrors, [], 'Uncaught renderer errors');
    assert.equal(consoleErrors.filter(message => /GL_OUT_OF_MEMORY|Shader Error|VALIDATE_STATUS.*false/i.test(message)).length, 0, 'WebGL shader or memory errors');
  } catch (error) {
    if (page) {
      try { await page.screenshot({ path: path.join(outDir, `${activeCase}-failure.png`), fullPage: true, timeout: 5000 }); } catch {}
    }
    throw error;
  } finally {
    if (rendererErrors.length || consoleErrors.length) report.diagnostics.push({ case: activeCase, rendererErrors, consoleErrors });
    await context.close();
  }
}

async function runCase(name, callback) {
  if (selectedCases.size && !selectedCases.has(name)) return;
  activeCase = name;
  const start = Date.now();
  try {
    await callback();
    report.cases.push({ name, status: 'passed', durationMs: Date.now() - start });
  } catch (error) {
    report.cases.push({ name, status: 'failed', durationMs: Date.now() - start });
    report.failures.push({ case: name, message: error.message, stack: error.stack });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function testPagination(browser, fixtures) {
  await withFixture(browser, fixtures, async page => {
    await waitForScene(page);
    await page.waitForFunction(() => [...document.querySelectorAll('#room [data-book]')].every(element => element.dataset.coverState === 'loaded'));
    assert.equal(await page.locator('[data-action="prev"]').isDisabled(), true);
    assert.match(await page.locator('#results').textContent(), /1–12.*25/);
    assert.deepEqual(await bookIds(page), fixtures.books.slice(0, 12).map(book => book.id));
    pass('25 books open as the first 12 book targets with loaded cover textures in a working WebGL scene');
    await screenshot(page, 'first-page');
    await page.locator('[data-action="next"]').click();
    await page.waitForFunction(() => document.querySelector('#results')?.textContent.includes('13–24'));
    await waitForScene(page);
    assert.deepEqual(await bookIds(page), fixtures.books.slice(12, 24).map(book => book.id));
    await page.locator('[data-action="next"]').click();
    await waitForCount(page, 1);
    await waitForScene(page);
    assert.deepEqual(await bookIds(page), [fixtures.books[24].id]);
    assert.equal(await page.locator('[data-action="next"]').isDisabled(), true);
    assert.match(await page.locator('#pagination').textContent(), /03\s*\/\s*03/);
    pass('Pagination reaches books 13–24 and a one-book final page without exceeding the last page');
    await screenshot(page, 'last-page');
    await page.locator('#search').fill('作者乙');
    await waitForCount(page, 12);
    assert.match(await page.locator('#pagination').textContent(), /01\s*\/\s*01/);
    assert.deepEqual(await bookIds(page), fixtures.books.filter((_, index) => index % 2).map(book => book.id));
    pass('Tag search resets pagination and finds the exact matching books');
    await page.locator('#search').fill('静物档案 25');
    await waitForCount(page, 1);
    assert.deepEqual(await bookIds(page), [fixtures.books[24].id]);
    await page.locator('#search').fill('没有这本书__gallery_empty__');
    await waitForCount(page, 0);
    await page.waitForSelector('#room .empty');
    await page.locator('#room [data-action="reset"]').click();
    await waitForCount(page, 12);
    await waitForScene(page);
    await page.locator('#sort').selectOption('pages');
    await page.waitForFunction(id => document.querySelector('#room [data-book]')?.dataset.book === id, fixtures.books[24].id);
    pass('Title search, no-results reset and page-count sorting remain functional');
    await setView(page, 'grid');
    await page.waitForFunction(() => {
      const images = [...document.querySelectorAll('#room [data-book] img')];
      return images.length === 12 && images.every(image => image.complete && image.naturalWidth > 0);
    });
    pass('Local neutral covers load from filenames containing Chinese, spaces, # and %');
  });
}

async function testThemes(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async page => {
    await waitForScene(page);
    for (const theme of themeIds) {
      await page.locator('#search').fill('作者甲');
      await waitForCount(page, 2);
      const idsBefore = await bookIds(page);
      await page.locator('[data-action="theme"]').first().click();
      assert.equal(await page.locator('[data-theme-choice]').count(), themeIds.length);
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      assert.equal(await page.locator('html').getAttribute('data-room-theme'), theme);
      assert.equal(await page.locator('[data-theme-choice][aria-pressed="true"]').count(), 1);
      assert.equal(await page.locator(`[data-theme-choice="${theme}"]`).getAttribute('aria-pressed'), 'true');
      await dismissDialog(page);
      assert.equal(await page.locator('#search').inputValue(), '作者甲');
      assert.deepEqual(await bookIds(page), idsBefore);
      await waitForScene(page);
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-scene-theme'), theme, 'Scene materials must follow the selected interface theme');
      await screenshot(page, theme);
      await page.reload();
      await waitForCount(page, 2);
      assert.equal(await page.locator('#search').inputValue(), '作者甲');
      assert.deepEqual(await bookIds(page), idsBefore);
      await waitForScene(page);
      assert.equal(await page.locator('html').getAttribute('data-room-theme'), theme);
      pass(`${theme}: theme selection preserves current results and survives reload`);
    }
    await page.locator('[data-action="settings"]').click();
    await page.locator('#modal-root [data-action="theme"]').click();
    await page.waitForSelector('.theme-modal');
    await dismissDialog(page);
    assert.equal(await page.evaluate(() => document.activeElement?.dataset.action), 'settings');
    pass('Theme access from settings restores keyboard focus');
    await page.evaluate(() => { localStorage.removeItem('room-theme'); localStorage.setItem('room-night', 'true'); });
    await page.reload();
    await waitForCount(page, 2);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'forest');
    await page.evaluate(() => { localStorage.setItem('room-theme', '"unknown-theme"'); localStorage.setItem('room-night', 'false'); });
    await page.reload();
    await waitForCount(page, 2);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'paper');
    pass('Legacy night preference and unknown saved theme resolve safely');
  });
}

async function testRestart(fixtures) {
  const tempParent = fs.realpathSync(os.tmpdir());
  const profileDirectory = fs.mkdtempSync(path.join(tempParent, 'qiyue-gallery-test-'));
  const model = createFakeModel(fixtures.books.slice(0, 3), fixtures.pages);
  let context;
  try {
    for (const phase of ['save', 'restore']) {
      context = await chromium.launchPersistentContext(profileDirectory, { ...launchOptions(), viewport: { width: 1280, height: 900 } });
      await attachFakeIpc(context, model);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(appURL);
      await waitForCount(page, 3);
      if (phase === 'save') {
        await page.locator('[data-action="theme"]').first().click();
        await page.locator('[data-theme-choice="glass"]').click();
        await dismissDialog(page);
        await setView(page, 'grid');
        await page.locator(bookSelector).first().click();
        await page.waitForSelector('.drawer .reading-options');
        await page.locator('#continuous-reading').check();
        await page.locator('#external-reader').check();
      } else {
        assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'glass');
        assert.equal(await page.locator('[data-view="grid"]').getAttribute('aria-pressed'), 'true');
        await page.waitForSelector('.book-grid');
        await page.locator(bookSelector).first().click();
        await page.waitForSelector('.drawer .reading-options');
        assert.equal(await page.locator('#continuous-reading').isChecked(), true);
        assert.equal(await page.locator('#external-reader').isChecked(), true);
        assert.equal(await page.locator('#continuous-reading').isDisabled(), true);
        pass('A full headless-browser restart restores the glass theme, grid view and both reader preferences');
      }
      assert.deepEqual(errors, [], 'Renderer errors during browser restart');
      await context.close();
      context = null;
    }
  } finally {
    if (context) await context.close();
    // Delete only the exact disposable profile just created under the verified temp directory.
    const resolved = fs.realpathSync(profileDirectory);
    const relative = path.relative(tempParent, resolved);
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative) && /^qiyue-gallery-test-[^\\/]+$/.test(relative), 'Unexpected browser profile cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function testReading(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async (page, model) => {
    const id = model.books[0].id;
    const target = () => page.locator(`#room [data-book="${id}"]`);
    await waitForScene(page);
    await target().click();
    await page.waitForSelector('.drawer');
    assert.match(await page.locator('.drawer h2').textContent(), /静物档案 01/);
    await page.locator('[data-favorite]').click();
    await page.waitForFunction(() => document.querySelector('[data-favorite]')?.getAttribute('aria-pressed') === 'true');
    assert.equal(model.books.find(book => book.id === id).mark, true);
    await dismissDialog(page);
    await page.locator('[data-action="favorites"]').click();
    await waitForCount(page, 1);
    assert.deepEqual(await bookIds(page), [id]);
    pass('Detail drawer, favorite writes and favorite filtering use only the fake library');
    await page.reload();
    await waitForCount(page, 1);
    assert.equal(await page.locator('[data-action="favorites"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#count-favorites').textContent(), '1');
    await waitForScene(page);
    await target().dblclick();
    await readerPage(page, 1);
    assert.equal(await page.locator('.reader').getAttribute('data-reading-mode'), 'paged');
    assert.equal(await page.locator('[data-action="page-prev"]').isDisabled(), true);
    await page.locator('.reader-body').hover();
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(0, 120);
    await page.mouse.wheel(0, 120);
    await readerPage(page, 2);
    await page.waitForTimeout(420);
    await page.mouse.wheel(0, -120);
    await readerPage(page, 1);
    await page.waitForTimeout(420);
    await page.mouse.wheel(0, -120);
    await settleLayout(page);
    await readerPage(page, 1);
    pass('Paged reader wheel moves one page per gesture in either direction and respects the first-page boundary');
    await page.locator('[data-action="page-next"]').click();
    await readerPage(page, 2);
    await page.locator('.reader-title').click();
    await page.keyboard.press('ArrowRight');
    await readerPage(page, 3);
    await page.locator('#reader-fit').selectOption('width');
    assert.equal(await page.locator('.reader-body').evaluate(element => element.classList.contains('fit-width')), true);
    await page.locator('#page-slider').focus();
    await page.keyboard.press('End');
    await readerPage(page, 5);
    assert.equal(await page.locator('[data-action="page-next"]').isDisabled(), true);
    await page.keyboard.press('Home');
    await readerPage(page, 1);
    await page.keyboard.press('ArrowRight');
    await readerPage(page, 2);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('room-progress'))[id], id);
    assert.equal(saved.page, 2);
    assert.equal(saved.total, 5);
    assert(model.books.find(book => book.id === id).readCount >= 1);
    assert(model.calls.some(call => call.channel === 'release-sendimagelock'));
    pass('Double-click reading, keyboard navigation, fit-width, page bounds and progress saving work');
    await page.locator('[data-filter="reading"]').click();
    await waitForCount(page, 1);
    assert.deepEqual(await bookIds(page), [id]);
    await page.reload();
    await waitForCount(page, 1);
    await waitForScene(page);
    await target().dblclick();
    await readerPage(page, 2);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    await waitForScene(page);
    await target().click();
    await page.waitForSelector('[data-read-start]');
    await page.locator('[data-read-start]').click();
    await readerPage(page, 1);
    await page.locator('#page-slider').focus();
    await page.keyboard.press('End');
    await readerPage(page, 5);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    await page.locator('[data-filter="finished"]').click();
    await waitForCount(page, 1);
    assert.deepEqual(await bookIds(page), [id]);
    pass('Reading progress survives reload, restart-from-first-page works, and finished filtering is accurate');
  });
}

async function testReaderOptions(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async (page, model) => {
    const book = model.books[0];
    const target = () => page.locator(`#room [data-book="${book.id}"]`);
    await waitForScene(page);
    await target().click();
    await page.waitForSelector('.drawer .reading-options');
    assert.equal(await page.locator('#continuous-reading').isChecked(), false);
    assert.equal(await page.locator('#external-reader').isChecked(), false);
    await page.locator('#continuous-reading').check();
    assert.equal(await page.locator('#modal-root [role="dialog"]').count(), 1, 'Reading options must stay in the book drawer');
    assert.equal(await page.locator('.drawer .reading-options').count(), 1);
    await page.locator('#external-reader').check();
    assert.equal(await page.locator('#continuous-reading').isDisabled(), true);
    assert.equal(await page.locator('#continuous-reading').isChecked(), true, 'External reader must retain the selected internal mode');
    assert.equal(await page.locator('#modal-root .modal').count(), 0, 'Selecting a reader preference must not open a separate modal');

    // A canceled file picker must preserve the existing setting and usable drawer.
    await page.locator('#reader-program').click();
    assert.equal(model.calls.filter(call => call.channel === 'save-setting').length, 0);
    assert.equal(await page.locator('.drawer .reading-options').isVisible(), true);
    model.fileSelection = path.join(outDir, 'fixtures', '模拟阅读器 #%.exe');
    await page.locator('#reader-program').click();
    await page.waitForFunction(() => document.querySelector('#reader-program')?.disabled === false);
    assert.equal(model.setting.imageExplorer, model.fileSelection);
    const picker = model.calls.find(call => call.channel === 'select-file');
    assert(picker.args[1].some(filter => filter.extensions.includes('exe')), 'Reader picker should request executables');
    assert.equal(await page.locator('#modal-root [role="dialog"]').count(), 1);
    await page.reload();
    await waitForCount(page, 3);
    await waitForScene(page);
    await target().click();
    await page.waitForSelector('.drawer .reading-options');
    assert.equal(await page.locator('#continuous-reading').isChecked(), true);
    assert.equal(await page.locator('#external-reader').isChecked(), true);
    assert.equal(await page.locator('#continuous-reading').isDisabled(), true);
    pass('Book drawer keeps both reader options inline, preserves their preference, and supports canceling or choosing an external program');

    const internalLoads = model.calls.filter(call => call.channel === 'load-manga-image-list').length;
    const readCount = model.books[0].readCount;
    model.externalError = 'Simulated unavailable external reader executable';
    await page.locator(`[data-read="${book.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#reader-option-status')?.textContent.includes('无法启动'));
    assert.equal(await page.locator('.drawer .reading-options').isVisible(), true);
    assert.equal(await page.locator('#reader-program').isDisabled(), false);
    assert.equal(await page.locator('#external-reader').isChecked(), true);
    assert.equal(await page.locator('#modal-root [role="dialog"]').count(), 1);
    assert.equal(await page.locator('.reader').count(), 0);
    pass('External launch failure stays inline in a usable book drawer with preferences retained');
    model.externalError = null;
    await page.locator(`[data-read="${book.id}"]`).click();
    await page.waitForFunction(() => !document.querySelector('[data-read]')?.disabled);
    const externalCalls = model.calls.filter(call => call.channel === 'open-local-book');
    assert.equal(externalCalls.length, 2);
    assert.deepEqual(externalCalls.at(-1).args, [book.filepath]);
    assert.equal(model.calls.filter(call => call.channel === 'load-manga-image-list').length, internalLoads);
    assert.equal(await page.locator('.reader').count(), 0, 'External reading should not open the internal reader');
    assert.equal(model.books[0].readCount, readCount, 'External dispatch must not claim that an internal page was viewed');
    await dismissDialog(page);
    await target().dblclick();
    await page.waitForFunction(() => !document.querySelector('.reader'));
    assert.equal(model.calls.filter(call => call.channel === 'open-local-book').length, 3, 'Double-click should honor the saved external-reader preference');
    pass('Primary read and double-click dispatch the exact fake book path externally without loading internal pages');

    await target().click();
    await page.waitForSelector('.drawer .reading-options');
    await page.locator('#external-reader').uncheck();
    assert.equal(await page.locator('#continuous-reading').isDisabled(), false);
    assert.equal(await page.locator('#continuous-reading').isChecked(), true);
    await page.locator('#continuous-reading').uncheck();
    await page.locator(`[data-read="${book.id}"]`).click();
    await readerPage(page, 1);
    assert.equal(await page.locator('.reader').getAttribute('data-reading-mode'), 'paged');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    pass('Turning external reading off restores the internal mode and paged reading remains available');
  });
}

async function testContinuousReading(browser) {
  const fixtures = createFixtures(path.join(outDir, 'continuous-fixtures'), 3, 64);
  // Page 20 is a spread whose dimensions arrive only after jumping farther ahead.
  // This catches visible-page jumps caused by late layout changes above the reader.
  fs.writeFileSync(fixtures.pages[19], '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="707" viewBox="0 0 1000 707"><rect width="1000" height="707" fill="#526663"/><text x="60" y="100" font-size="36" fill="#faf8ed">A NEUTRAL DOUBLE PAGE / 20</text></svg>', 'utf8');
  await withFixture(browser, fixtures, async (page, model) => {
    const id = model.books[0].id;
    const target = () => page.locator(`#room [data-book="${id}"]`);
    await waitForScene(page);
    await target().click();
    await page.waitForSelector('.drawer .reading-options');
    await page.locator('#continuous-reading').check();
    await page.locator(`[data-read="${id}"]`).click();
    await readerPage(page, 1, 64);
    assert.equal(await page.locator('.reader').getAttribute('data-reading-mode'), 'continuous');
    assert.equal(await page.locator('.reader-body.continuous-mode > .continuous-pages > .continuous-page').count(), 64);
    const initialImages = await page.locator('.continuous-page img[src]').count();
    assert(initialImages > 0 && initialImages < 16, `Continuous reader eagerly assigned ${initialImages} of 64 image sources`);
    assert.equal(await page.locator('.continuous-page[data-reader-page="64"] img[src]').count(), 0, 'Last page should remain an unloaded placeholder on entry');
    await page.evaluate(({ id, paths }) => {
      paths.forEach((filepath, index) => { if (index !== 19) window.__galleryEmit('manga-image', { id: `${id}_${index + 1}`, index: index + 1, filepath, width: 500, height: 707, total: paths.length }); });
    }, { id, paths: fixtures.pages });
    await settleLayout(page);
    assert(await page.locator('.continuous-page img[src]').count() < 16, 'Background page metadata must not bypass lazy image loading');
    assert.equal(await page.locator('.continuous-page[data-reader-page="64"] img[src]').count(), 0);
    await page.waitForFunction(() => [...document.querySelectorAll('.continuous-page img[src]')].every(image => image.complete && image.naturalWidth > 0));
    const pageLayout = await page.locator('.continuous-page').evaluateAll(elements => {
      const bounds = elements.slice(0, 3).map(element => element.getBoundingClientRect());
      const image = elements[0].querySelector('img').getBoundingClientRect();
      return { gaps: bounds.slice(1).map((rect, index) => rect.top - bounds[index].bottom), imageGap: bounds[0].bottom - image.bottom };
    });
    assert(pageLayout.gaps.every(gap => Math.abs(gap) < 1) && Math.abs(pageLayout.imageGap) < 1, 'Continuous comic pages must join without visual gutters');
    const entryProgress = await page.evaluate(id => JSON.parse(localStorage.getItem('room-progress'))?.[id], id);
    assert.equal(entryProgress.page, 1, 'Preloading pages must not advance saved progress');
    pass('Continuous reading creates 64 seamless page placeholders while loading only nearby images and retaining actual reading progress');

    const body = page.locator('.reader-body');
    await body.hover();
    await page.mouse.wheel(0, 1500);
    await page.waitForFunction(() => {
      const number = Number(document.querySelector('#reader-page')?.textContent.split('/')[0]);
      return document.querySelector('.reader-body').scrollTop > 0 && number > 1 && number < 8;
    });
    const scrolledPage = Number((await page.locator('#reader-page').textContent()).split('/')[0]);
    await readerPage(page, scrolledPage, 64);
    pass('Continuous wheel scrolls vertically and updates the current page from the visible image');

    await page.locator('#page-slider').fill('40');
    await readerPage(page, 40, 64);
    const targetVisible = await page.locator('.continuous-page[data-reader-page="40"]').evaluate(element => {
      const rect = element.getBoundingClientRect();
      const body = element.closest('.reader-body').getBoundingClientRect();
      return rect.bottom > body.top && rect.top < body.bottom;
    });
    assert(targetVisible, 'Page slider must scroll to its continuous page');
    assert.equal(await page.locator('.continuous-page[data-reader-page="64"] img[src]').count(), 0);
    const offsetBefore = await page.locator('.continuous-page[data-reader-page="40"]').evaluate(element => element.getBoundingClientRect().top - element.closest('.reader-body').getBoundingClientRect().top);
    await page.evaluate(({ id, filepath }) => window.__galleryEmit('manga-image', { id: `${id}_20`, index: 20, filepath, width: 1000, height: 707, total: 64 }), { id, filepath: fixtures.pages[19] });
    await settleLayout(page);
    await readerPage(page, 40, 64);
    const offsetAfter = await page.locator('.continuous-page[data-reader-page="40"]').evaluate(element => element.getBoundingClientRect().top - element.closest('.reader-body').getBoundingClientRect().top);
    assert(Math.abs(offsetAfter - offsetBefore) < 2, 'Late dimensions for an earlier page must preserve the current visible-page position');
    await page.locator('.reader-title').click();
    await page.keyboard.press('ArrowRight');
    await readerPage(page, 41, 64);
    await page.keyboard.press('ArrowLeft');
    await readerPage(page, 40, 64);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    const saved = await page.evaluate(id => JSON.parse(localStorage.getItem('room-progress'))[id], id);
    assert.equal(saved.page, 40);
    assert.equal(saved.total, 64);
    assert.equal(model.books[0].readCount, 1, 'A waterfall session should increment read count only once');
    await page.reload();
    await waitForCount(page, 3);
    await waitForScene(page);
    await target().dblclick();
    await readerPage(page, 40, 64);
    assert.equal(await page.locator('.reader').getAttribute('data-reading-mode'), 'continuous');
    pass('Continuous page navigation survives late image dimensions and restores the saved mode and exact page on reload');
    await screenshot(page, 'restored-page-40');
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
  });
}

async function testDensities(browser, fixtures) {
  for (const count of [0, 1, 3, 12]) {
    await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, count) }, async page => {
      assert.equal(await page.locator('[data-action="prev"]').isDisabled(), true);
      assert.equal(await page.locator('[data-action="next"]').isDisabled(), true);
      if (!count) {
        await page.waitForSelector('#room .empty');
        assert.equal(await page.locator('#room [data-action="library"]').isVisible(), true);
        assert.match(await page.locator('#results').textContent(), /0/);
      } else {
        await waitForScene(page);
        const targets = await page.locator(bookSelector).evaluateAll(elements => elements.map(element => ({ role: element.tagName, label: element.getAttribute('aria-label') })));
        assert(targets.every(target => target.role === 'BUTTON' && target.label?.trim()), 'Each book needs a labeled DOM button');
        await page.locator(bookSelector).first().focus();
        await page.keyboard.press('Enter');
        await page.waitForSelector('.drawer');
        await dismissDialog(page);
      }
      await noOverflow(page);
      await screenshot(page, `${count}-books`);
      pass(`${count}-book library has correct bounds and usable ${count ? 'keyboard book targets' : 'empty state'}`);
    });
  }
}

async function testLayouts(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 12) }, async page => {
    for (const width of [720, 950, 1280, 1560]) {
      await page.setViewportSize({ width, height: width < 1000 ? 800 : 1000 });
      await waitForScene(page);
      await noOverflow(page);
      const idsBefore = await bookIds(page);
      await page.locator(bookSelector).first().click();
      await page.waitForSelector('.drawer');
      await noOverflow(page);
      await dismissDialog(page);
      await screenshot(page, `${width}-scene`);
      await setView(page, 'grid');
      await noOverflow(page);
      assert.deepEqual(await bookIds(page), idsBefore);
      assert.equal(await page.locator('.book-grid').isVisible(), true);
      await screenshot(page, `${width}-grid`);
      await setView(page, 'shelf');
      await page.locator('[data-action="theme"]').first().click();
      await page.locator('[data-theme-choice="acid"]').scrollIntoViewIfNeeded();
      const modalBounds = await page.locator('.theme-modal').evaluate(element => ({ scroll: element.scrollWidth, client: element.clientWidth }));
      assert(modalBounds.scroll <= modalBounds.client + 1, `Theme picker overflows at ${width}px`);
      await noOverflow(page);
      await dismissDialog(page);
      pass(`${width}px: scene, grid, detail drawer and theme picker fit and remain interactive`);
    }
    for (let index = 0; index < 3; index++) {
      await setView(page, 'grid');
      await setView(page, 'shelf');
    }
    await waitForScene(page);
    pass('Repeated scene/grid switching leaves one healthy WebGL canvas');
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const first = page.locator(bookSelector).first();
    const originalLeft = await first.evaluate(element => parseFloat(element.style.left));
    const firstId = await first.getAttribute('data-book');
    await page.locator('[data-scene-camera="left"]').click();
    await page.waitForFunction(originalLeft => Math.abs(parseFloat(document.querySelector('#room [data-book]').style.left) - originalLeft) > .5, originalLeft);
    await sceneStopsRendering(page);
    await first.click();
    await page.waitForSelector('.drawer');
    assert.equal(await page.locator('[data-read]').getAttribute('data-read'), firstId);
    await dismissDialog(page);
    await page.locator('[data-scene-camera="right"]').click();
    await sceneStopsRendering(page);
    await page.locator('[data-scene-camera="right"]').click();
    await sceneStopsRendering(page);
    await page.locator('[data-scene-camera="reset"]').click();
    await sceneStopsRendering(page);
    assert(Math.abs(await first.evaluate(element => parseFloat(element.style.left)) - originalLeft) < 1, 'Camera reset did not restore the projected book target');
    pass('Camera rotation keeps projected book targets clickable and reset restores their position');
    const idleCount = await page.locator('.scene-viewport').getAttribute('data-render-count');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-render-count'), idleCount);
    pass('The normal scene stops rendering when idle after camera interaction');
  });
}

async function testTitles(browser, fixtures) {
  const books = clone(fixtures.books.slice(0, 3));
  books[0].title = '收藏中的完整书名应当随着内容自动展开：静物与光影的漫长旅途 · A complete title with 中文、English、标点与很长的连续文字 ' + '漫长但不应被省略的书名'.repeat(8);
  books[1].title = '短标题';
  const assertTooltip = async (page, book) => {
    await page.locator(`#room [data-book="${book.id}"]`).hover();
    await page.waitForFunction(id => {
      const tooltip = document.querySelector('.book-title-tooltip:not([hidden])');
      return tooltip?.dataset.book === id;
    }, book.id);
    const tooltip = page.locator('.book-title-tooltip:not([hidden])');
    assert.equal((await tooltip.textContent()).trim(), book.title);
    const metrics = await tooltip.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight, viewportWidth: innerWidth, viewportHeight: innerHeight, textOverflow: getComputedStyle(element).textOverflow };
    });
    assert(metrics.scrollWidth <= metrics.clientWidth + 1 && metrics.scrollHeight <= metrics.clientHeight + 1, 'Full title must not be clipped inside its tooltip');
    assert(metrics.left >= 0 && metrics.right <= metrics.viewportWidth + 1 && metrics.top >= 0 && metrics.bottom <= metrics.viewportHeight + 1, 'Title tooltip must fit inside the window');
    assert.notEqual(metrics.textOverflow, 'ellipsis', 'Hovered book title must not be truncated');
    return metrics.width;
  };
  await withFixture(browser, { ...fixtures, books }, async page => {
    await waitForScene(page);
    for (const width of [1560, 720]) {
      await page.setViewportSize({ width, height: width < 1000 ? 800 : 1000 });
      for (const view of ['shelf', 'grid']) {
        await setView(page, view);
        const shortWidth = await assertTooltip(page, books[1]);
        const longWidth = await assertTooltip(page, books[0]);
        assert(longWidth > shortWidth + 80, 'Title tooltip should grow to fit a longer title');
        await noOverflow(page);
      }
      await screenshot(page, `${width}-full-title`);
      pass(`${width}px: scene and grid display complete adaptive book titles inside the window`);
    }
    await page.locator(`#room [data-book="${books[0].id}"]`).click();
    await page.waitForSelector('.drawer');
    assert.equal(await page.locator('.book-title-tooltip:not([hidden])').count(), 0, 'Title tooltip must clear when the book drawer opens');
    await dismissDialog(page);
  });
  await withFixture(browser, { ...fixtures, books }, async page => {
    await waitForScene(page, 'fallback');
    await assertTooltip(page, books[0]);
    pass('WebGL fallback also exposes the complete long book title');
  }, { forceWebglUnavailable: true });
}

async function testSceneControls(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async page => {
    await waitForScene(page);
    await page.waitForFunction(() => [...document.querySelectorAll('#room [data-book]')].every(element => element.dataset.coverState === 'loaded'));
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const viewport = page.locator('.scene-viewport');
    const first = page.locator(bookSelector).first();
    const readCamera = () => viewport.evaluate(element => ({
      yaw: Number(element.dataset.cameraYaw), panX: Number(element.dataset.cameraPanX), panY: Number(element.dataset.cameraPanY), zoom: Number(element.dataset.cameraZoom),
      targetPanX: Number(element.dataset.cameraTargetPanX), targetPanY: Number(element.dataset.cameraTargetPanY), targetZoom: Number(element.dataset.cameraTargetZoom),
    }));
    const readTarget = () => first.evaluate(element => ({ left: parseFloat(element.style.left), top: parseFloat(element.style.top), width: parseFloat(element.style.width) }));
    const original = await readTarget();
    const bookBounds = await first.boundingBox();
    const firstId = await first.getAttribute('data-book');
    const start = { x: bookBounds.x + bookBounds.width / 2, y: bookBounds.y + bookBounds.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(start.x + 90, start.y + 65, { steps: 6 });
    await page.mouse.up({ button: 'middle' });
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const panned = await readCamera();
    const moved = await readTarget();
    assert(panned.panX < 0 && panned.panY > 0, 'Middle drag should pan along both axes even when it begins over a book');
    assert(Math.abs(panned.yaw) < .002 && Math.abs(panned.zoom - 1) < .002, 'Middle panning should preserve rotation and zoom');
    assert(Math.abs(moved.left - original.left) > 2 && Math.abs(moved.top - original.top) > 2, 'Panning must move the projected interactive book targets');
    assert.equal(await page.locator('.drawer, .reader').count(), 0, 'Middle drag must not open a book');
    pass('Middle-button dragging over a book pans the scene and its hit targets without opening the book');

    const sceneBounds = await viewport.boundingBox();
    const scenePoint = { x: sceneBounds.x + sceneBounds.width * .77, y: sceneBounds.y + sceneBounds.height * .55 };
    await page.mouse.move(scenePoint.x, scenePoint.y);
    const scrollBefore = await page.evaluate(() => ({ page: scrollY, main: document.querySelector('.main').scrollTop, content: document.querySelector('.content').scrollTop }));
    await page.mouse.wheel(0, -350);
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const zoomed = await readCamera();
    assert(zoomed.zoom > 1 && zoomed.zoom <= 1.9, 'Scene wheel up must zoom in');
    assert((await readTarget()).width > original.width + 2, 'Zoom must resize the projected book hit targets');
    assert.deepEqual(await page.evaluate(() => ({ page: scrollY, main: document.querySelector('.main').scrollTop, content: document.querySelector('.content').scrollTop })), scrollBefore, 'Scene wheel zoom should not scroll the home page');

    await page.mouse.move(scenePoint.x, scenePoint.y);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(scenePoint.x + 4000, scenePoint.y - 4000, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const bounded = await readCamera();
    assert(Math.abs(bounded.panX) <= 1.801 && Math.abs(bounded.panY) <= 1.151, 'Large middle drags must stay inside both pan limits');
    assert(Math.abs(Math.abs(bounded.targetPanX) - 1.8) < .002 && Math.abs(Math.abs(bounded.targetPanY) - 1.15) < .002, 'Large drags should stop at the configured pan bounds');
    await page.mouse.move(scenePoint.x, scenePoint.y);
    await page.mouse.wheel(0, -12000);
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    assert(Math.abs((await readCamera()).zoom - 1.9) < .003, 'Scene zoom must stop at its upper limit');
    await page.mouse.move(scenePoint.x, scenePoint.y);
    await page.mouse.wheel(0, 12000);
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    assert(Math.abs((await readCamera()).zoom - .72) < .003, 'Scene zoom must stop at its lower limit');
    pass('Scene wheel zoom updates book targets, consumes page scrolling and respects zoom and pan limits');

    await page.locator('[data-scene-camera="left"]').click();
    await sceneStopsRendering(page);
    await page.locator('[data-scene-camera="reset"]').click();
    await page.mouse.move(0, 0);
    await sceneStopsRendering(page);
    const reset = await readCamera();
    assert(Math.abs(reset.yaw) < .002 && Math.abs(reset.panX) < .002 && Math.abs(reset.panY) < .002 && Math.abs(reset.zoom - 1) < .002, 'Reset must restore rotation, both pan axes and zoom together');
    const restored = await readTarget();
    assert(Math.abs(restored.left - original.left) < 1 && Math.abs(restored.top - original.top) < 1 && Math.abs(restored.width - original.width) < 1, 'Reset must restore original book hit target geometry');
    await first.click();
    await page.waitForSelector('.drawer');
    assert.equal(await page.locator('[data-read]').getAttribute('data-read'), firstId);
    await dismissDialog(page);
    pass('One reset restores the original composition and correctly clickable book after pan, zoom and rotation');
  });
}

async function testCoverFallback(browser, fixtures) {
  const books = clone(fixtures.books.slice(0, 3));
  books[1].coverPath = path.join(outDir, 'fixtures', '不存在的封面 #% 测试.svg');
  books[2].coverPath = '';
  await withFixture(browser, { ...fixtures, books }, async page => {
    await waitForScene(page);
    await page.waitForFunction(ids => ids.every(id => document.querySelector(`#room [data-book="${id}"]`)?.dataset.coverState === 'fallback'), books.slice(1).map(book => book.id));
    await setView(page, 'grid');
    const broken = page.locator(`#room [data-book="${books[1].id}"]`);
    await page.waitForFunction(id => {
      const image = document.querySelector(`#room [data-book="${id}"] img`);
      return image?.complete && image.naturalWidth === 0 && image.classList.contains('failed');
    }, books[1].id);
    for (const book of books.slice(1)) {
      const fallback = page.locator(`#room [data-book="${book.id}"] .fallback`);
      assert.equal(await fallback.isVisible(), true, 'Missing covers must leave a visible title fallback');
      assert.equal((await fallback.textContent()).trim(), book.title);
    }
    await broken.click();
    await page.waitForSelector('.drawer');
    assert.equal((await page.locator('.drawer h2').textContent()).trim(), books[1].title);
    await dismissDialog(page);
    await setView(page, 'shelf');
    pass('Missing and invalid cover paths preserve a readable fallback and usable book details');
  });
}

async function testWebglFallback(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async page => {
    await waitForScene(page, 'fallback');
    await noOverflow(page);
    await page.locator(bookSelector).first().click();
    await page.waitForSelector('.drawer');
    await page.locator('[data-read]').click();
    await readerPage(page, 1);
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    await waitForScene(page, 'fallback');
    await page.locator('[data-view="grid"]').click();
    await page.waitForSelector('.book-grid');
    await waitForCount(page, 3);
    pass('With WebGL unavailable, fallback still supports book details, reading and explicit grid view');
    await screenshot(page, 'usable-without-webgl');
  }, { forceWebglUnavailable: true });
}

async function testReducedMotion(browser, fixtures) {
  await withFixture(browser, { ...fixtures, books: fixtures.books.slice(0, 3) }, async page => {
    await waitForScene(page);
    assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
    await page.mouse.move(0, 0);
    await settleLayout(page);
    const duration = await page.locator(bookSelector).first().evaluate(element => {
      const css = getComputedStyle(element);
      const milliseconds = value => value.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000));
      return Math.max(...milliseconds(css.transitionDuration), ...milliseconds(css.animationDuration));
    });
    assert(duration <= 20, `Reduced-motion book animation still lasts ${duration}ms`);
    const canvas = page.locator('canvas.scene-canvas');
    let previous = await canvas.screenshot();
    let stable = false;
    // Allow local textures and the initial frame to settle, then require an unchanged canvas.
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForTimeout(180);
      const current = await canvas.screenshot();
      if (current.equals(previous)) { stable = true; break; }
      previous = current;
    }
    assert(stable, 'Reduced-motion scene keeps moving while idle');
    await sceneStopsRendering(page);
    await page.locator(bookSelector).first().click();
    await page.waitForSelector('.drawer');
    await dismissDialog(page);
    pass('Reduced-motion preference suppresses long transitions and idle scene motion without disabling interaction');
  }, { reducedMotion: 'reduce' });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node tools/test-gallery.cjs [--screenshots] [--case=pagination,themes,restart,reading,reader-options,continuous,densities,layouts,titles,scene-controls,covers,fallback,reduced-motion]\nOutput: tools/.artifacts/gallery (override with GALLERY_TEST_OUTPUT). Uses fresh headless Edge and fake IPC only.');
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });
  const fixtures = createFixtures(path.join(outDir, 'fixtures'));
  const browser = await chromium.launch(launchOptions());
  try {
    const cases = {
      pagination: () => testPagination(browser, fixtures),
      themes: () => testThemes(browser, fixtures),
      restart: () => testRestart(fixtures),
      reading: () => testReading(browser, fixtures),
      'reader-options': () => testReaderOptions(browser, fixtures),
      continuous: () => testContinuousReading(browser),
      densities: () => testDensities(browser, fixtures),
      layouts: () => testLayouts(browser, fixtures),
      titles: () => testTitles(browser, fixtures),
      'scene-controls': () => testSceneControls(browser, fixtures),
      covers: () => testCoverFallback(browser, fixtures),
      fallback: () => testWebglFallback(browser, fixtures),
      'reduced-motion': () => testReducedMotion(browser, fixtures),
    };
    for (const name of selectedCases) assert(name in cases, 'Unknown test case: ' + name);
    for (const [name, callback] of Object.entries(cases)) await runCase(name, callback);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(outDir, 'checks.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(`${report.checks.length} checks passed; ${report.failures.length} cases failed. Report: ${path.join(outDir, 'checks.json')}`);
  if (report.failures.length) process.exitCode = 1;
}

module.exports = { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
