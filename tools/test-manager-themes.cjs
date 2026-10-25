'use strict';

// Runs in a separate headless browser with neutral covers and fake IPC.
// It does not open the live application, database, credentials, or user library.
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const { assertSettingsFields, assertSettingsShortcuts, settleVisuals } = require('./test-manager-glass.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const out = path.join(__dirname, '.artifacts', 'manager-themes');
const ids = ['paper', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid', 'glass'];
const dark = new Set(['forest', 'hub', 'ex', 'terminal', 'neon']);
const report = { checks: [], screenshots: [], errors: [] };
const pass = message => { report.checks.push(message); console.log('PASS ' + message); };

function makeModel(fixtures) {
  const books = fixtures.books.map((book, index) => ({ ...book, coverPath: pathToFileURL(book.coverPath).href, hash: `neutral-hash-${index}`, status: 'tagged', date: book.createdAt, tags: { artist: ['Neutral Artist'], language: ['chinese'], misc: ['still life'] } }));
  const model = createFakeModel(books, fixtures.pages);
  Object.assign(model.setting, {
    theme: 'dark nhentai', language: 'zh-CN', loadOnStart: false, autoCheckUpdates: false,
    showTranslation: false, hideTitleBar: true, disableRandomTag: true, collectTag: [],
  });
  const invoke = model.invoke.bind(model);
  model.invoke = async function (channel, ...args) {
    if (['get-locale', 'get-folder-tree', 'load-collection-list', 'window-is-maximized', 'update-tag-translation', 'set-progress-bar', 'switch-fullscreen'].includes(channel)) {
      this.calls.push({ channel, args });
      if (channel === 'get-locale') return 'zh-CN';
      if (channel === 'get-folder-tree' || channel === 'load-collection-list') return [];
      if (channel === 'window-is-maximized') return false;
      return null;
    }
    return invoke(channel, ...args);
  };
  return model;
}

async function contextFor(browser, model, seed = {}) {
  const context = await browser.newContext({ viewport: { width: 1560, height: 1040 } });
  await attachFakeIpc(context, model);
  await context.addInitScript(seed => {
    window.ipcRenderer.sendSync = channel => {
      if (channel !== 'get-path-sep') throw Error('Unexpected sync channel: ' + channel);
      return '\\';
    };
    window.electronFunction = { 'get-zoom-level': () => 0, 'set-zoom-level': () => {}, 'insert-css': () => {} };
    if (!sessionStorage.getItem('manager-test-initialized')) {
      localStorage.clear();
      localStorage.setItem('reading-room-interface', 'classic');
      localStorage.setItem('room-view', JSON.stringify('grid'));
      for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
      sessionStorage.setItem('manager-test-initialized', '1');
    }
  }, seed);
  return context;
}

async function waitForManager(page) {
  await page.waitForSelector('.app-toolbar');
  await page.waitForSelector('.book-card');
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const fixtures = createFixtures(path.join(out, 'fixtures'), 12);
  const browser = await chromium.launch(launchOptions());
  try {
    const model = makeModel(fixtures);
    const context = await contextFor(browser, model, { 'room-theme': JSON.stringify('glass'), appTheme: 'dark exhentai' });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    page.on('console', event => { if (event.type() === 'error') report.errors.push(event.text()); });
    await page.goto(appURL);
    await waitForManager(page);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'glass');
    assert.equal(await page.locator('.book-card').count(), 12);
    assert.equal(await page.locator('html').evaluate(el => el.classList.contains('exhentai')), false);
    pass('The current room preference overrides both old manager preferences; all books remain available');

    await page.locator('[data-manager-theme-open]').click();
    await page.locator('.manager-appearance').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.manager-appearance [data-theme-choice]').count(), 8);
    const tabs = await page.locator('.setting-dialog [role="tab"]').allTextContents();
    assert(!tabs.some(text => /^(关于|關於|About)$/.test(text.trim())));
    const options = await page.locator('.setting-dialog').textContent();
    assert(!/Default Dark|Default Light|E-Hentai|nHentai/.test(options));
    pass('Settings expose exactly eight theme cards; the About tab and all five old themes are absent');

    const paints = new Set();
    for (const id of ids) {
      await page.locator(`.manager-appearance [data-theme-choice="${id}"]`).click();
      await page.waitForFunction(id => document.documentElement.dataset.roomTheme === id, id);
      const state = await page.evaluate(() => {
        const style = getComputedStyle(document.querySelector('#app'));
        return { stored: JSON.parse(localStorage.getItem('room-theme')), dark: document.documentElement.dataset.themeDark, color: style.color, background: style.backgroundColor, accent: getComputedStyle(document.documentElement).getPropertyValue('--cat-accent').trim(), legacy: localStorage.getItem('appTheme') };
      });
      assert.equal(state.stored, id);
      assert.equal(state.dark, String(dark.has(id)));
      assert.equal(state.legacy, null);
      assert.notEqual(state.color, state.background);
      assert(state.accent);
      assert.equal(await page.locator(`.manager-appearance [data-theme-choice="${id}"]`).getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.manager-appearance [aria-pressed="true"]').count(), 1);
      assert.equal(await page.evaluate(() => document.activeElement?.dataset.themeChoice), id);
      paints.add(state.color + '|' + state.background + '|' + state.accent);
      if (['glass', 'forest', 'acid'].includes(id)) {
        const file = path.join(out, `manager-${id}.png`);
        await page.screenshot({ path: file, fullPage: true });
        report.screenshots.push(file);
      }
      await page.getByRole('tab', { name: '常用', exact: true }).click();
      await settleVisuals(page);
      await assertSettingsFields(page);
      await page.getByRole('tab', { name: '快捷键', exact: true }).click();
      await settleVisuals(page);
      await assertSettingsShortcuts(page);
      await page.getByRole('tab', { name: '主题', exact: true }).click();
    }
    assert.equal(paints.size, 8);
    await page.waitForTimeout(650);
    assert.equal(model.setting.theme, 'glass');
    assert.equal(model.setting.library, '仅供自动检查的模拟书库');
    assert.equal(model.setting.imageExplorer, '');
    pass('All eight themes repaint controls and persist without changing library or reader settings');
    pass('All eight themes keep field actions connected and shortcut names and combinations readable');

    await page.keyboard.press('Escape');
    await page.locator('.setting-dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '返回 3D 阅览室', exact: true }).click();
    await page.waitForSelector('.shell');
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'glass');
    await page.locator('[data-action="theme"]').first().click();
    await page.locator('#modal-root [data-theme-choice="forest"]').click();
    await page.keyboard.press('Escape');
    await page.locator('[data-action="classic"]').first().click();
    await waitForManager(page);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'forest');
    await page.reload();
    await waitForManager(page);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'forest');
    pass('Theme selection survives both interface directions and an application-page reload');

    const search = page.locator('.app-toolbar .search-input input');
    await search.fill('"静物档案 01"');
    await search.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 1);
    await search.fill('');
    await search.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.book-card').length === 12);
    pass('Management search still filters and restores the neutral library');

    const before = model.calls.filter(call => call.channel === 'window-minimize').length;
    await page.locator('.titlebar-button').nth(1).click();
    await page.waitForTimeout(50);
    assert.equal(model.calls.filter(call => call.channel === 'window-minimize').length, before + 1);
    await page.evaluate(() => window.__galleryEmit('send-action', { action: 'about' }));
    assert.equal(await page.locator('.setting-dialog:visible').count(), 0);
    assert.equal(await page.locator('.book-card').count(), 12);
    pass('Window controls remain clickable and obsolete About shortcuts open no orphaned panel');
    await context.close();

    for (const [legacy, expected] of [['light', 'paper'], ['dark', 'forest'], ['light e-hentai', 'paper'], ['dark exhentai', 'ex'], ['dark nhentai', 'neon']]) {
      const migrationModel = makeModel(fixtures);
      migrationModel.setting.theme = legacy;
      const migrationContext = await contextFor(browser, migrationModel, { appTheme: legacy });
      const migrationPage = await migrationContext.newPage();
      migrationPage.on('pageerror', error => report.errors.push(error.message));
      await migrationPage.goto(appURL);
      await waitForManager(migrationPage);
      assert.equal(await migrationPage.locator('html').getAttribute('data-room-theme'), expected);
      assert.equal(await migrationPage.evaluate(() => JSON.parse(localStorage.getItem('room-theme'))), expected);
      await migrationContext.close();
    }
    pass('Each old theme migrates to a supported theme');
    assert.deepEqual(report.errors, []);
  } finally {
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
