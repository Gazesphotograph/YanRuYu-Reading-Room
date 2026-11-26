'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { appURL, createFixtures, createFakeModel, attachFakeIpc, launchOptions } = require('./test-gallery.cjs');
const { folderTree } = require('../resources/app/modules/folder_tree');
const { validateClientState } = require('../resources/app/modules/client_state');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-filter-'));
  let browser;
  try {
    const { books, pages } = createFixtures(directory, 4, 1);
    const folders = ['Atlas', 'Atlas/North', 'Atlas-old', 'Atlas/North'];
    books.forEach((book, i) => Object.assign(book, {
      filepath: path.join(directory, folders[i], book.title), hash: 'sample-' + i,
      date: book.createdAt, readCount: 3, category: i === 1 ? 'Sketch' : 'Artbook',
      tags: { artist: [i === 1 ? 'Other Studio' : 'River Studio'], other: [i === 3 ? 'skip' : 'paper'] },
    }));
    browser = await chromium.launch(launchOptions());
    async function open() {
      const context = await browser.newContext({ viewport: { width: 720, height: 720 }, reducedMotion: 'reduce' });
      const model = createFakeModel(books, pages);
      Object.assign(model.setting, { library: directory, language: 'zh-CN', displayTitle: 'englishTitle',
        loadOnStart: false, autoCheckUpdates: false, disableRandomTag: true, collectTag: [], pageSize: 20 });
      const invoke = model.invoke.bind(model);
      model.invoke = (channel, ...args) => {
        if (channel === 'get-folder-tree') return folderTree(directory, args[0]);
        if (channel === 'get-locale') return 'zh-CN';
        if (['set-progress-bar', 'update-tag-translation', 'window-is-maximized'].includes(channel)) return false;
        return invoke(channel, ...args);
      };
      await attachFakeIpc(context, model);
      await context.addInitScript(() => {
        localStorage.setItem('room-workspace-preview', 'true');
        localStorage.setItem('room-workspace-start-page', '"library"');
        localStorage.setItem('room-workspace-library-view', '"table"');
      });
      const page = await context.newPage();
      page.setDefaultTimeout(7000);
      await page.goto(appURL);
      return page;
    }
    const expression = 'a:"River Studio"$ -o:"skip"$ :count>1 :atime>2020-01-01 ~cat:"Sketch"$';
    // Recorded from the 1.6.16 manager with this four-book fixture.
    const reference = books.slice(0, 2).map(book => book.title).sort();
    const page = await open();
    const filter = page.getByRole('button', { name: /^目录与组合筛选/ });
    await filter.click();
    const dialog = page.getByRole('dialog', { name: '目录与组合筛选' });
    await dialog.getByLabel('查找目录').fill('North');
    await dialog.getByRole('radio', { name: 'Atlas', exact: true }).check();
    await dialog.getByLabel('组合条件').fill(expression);
    await dialog.getByRole('button', { name: '应用筛选' }).click();
    const titles = page.locator('.library-table [data-book]');
    assert.deepEqual((await titles.allTextContents()).sort(), reference);
    await page.getByRole('button', { name: '保存筛选' }).click();
    await page.getByLabel('书架名称').fill('Atlas 选书');
    await page.getByRole('button', { name: '保存书架' }).click();
    await titles.first().press('Enter');
    await page.getByRole('button', { name: '在阅览室看' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#room [data-book]').length === 2);
    assert((await page.locator('#room-context-label').textContent()).includes(expression));
    await page.getByRole('button', { name: '在书库显示' }).click();
    assert.deepEqual((await titles.allTextContents()).sort(), reference);
    await page.evaluate(() => window.YanruyuClientState.flush());
    validateClientState(await page.evaluate(() => window.YanruyuClientState.snapshot()));
    await page.reload();
    await titles.first().waitFor();
    assert.deepEqual((await titles.allTextContents()).sort(), reference);
    await page.getByRole('button', { name: '清除筛选' }).click();
    assert.equal(await titles.count(), 4);
    await page.getByLabel('智能书架', { exact: true }).selectOption({ label: 'Atlas 选书' });
    assert.deepEqual((await titles.allTextContents()).sort(), reference);
    assert.equal(await page.locator('.sidebar [data-action="classic"]').isVisible(), false);
    await page.locator('[data-action="settings"]').click();
    assert.equal(await page.getByRole('button', { name: '打开完整管理界面' }).count(), 0);
    console.log('PASS Four-book parity with the released classic UI, room round trip, saved shelf and reload.');
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
