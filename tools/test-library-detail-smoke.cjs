'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { appURL, attachFakeIpc, createFakeModel, createFixtures, launchOptions } = require('./test-gallery.cjs');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-library-detail-'));
  let browser;
  try {
    const { books, pages } = createFixtures(directory, 2, 2);
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 720, height: 520 }, reducedMotion: 'reduce' });
    await attachFakeIpc(context, createFakeModel(books, pages));
    await context.addInitScript(() => localStorage.setItem('room-workspace-preview', 'true'));
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(appURL);
    const recent = page.locator('[data-desk-book]').first();
    await recent.waitFor();
    const originalDeskTitle = await recent.textContent();
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name: '书库' }).click();
    await page.getByRole('button', { name: '表格视图' }).click();
    await page.getByLabel('书籍排序').selectOption('title');
    const table = page.getByRole('table', { name: '书库结果' });
    const id = books[0].id;
    const book = table.locator(`button[data-book="${id}"]`);
    const checkbox = table.locator(`input[data-check-book="${id}"]`);
    await checkbox.press('Space');
    assert.equal(await checkbox.isChecked(), true);
    assert.equal(await page.getByRole('button', { name: '批量编辑所选书籍' }).isEnabled(), true);
    assert.equal(await table.getByRole('columnheader').count(), 2);
    const row = table.getByRole('row').filter({ has: page.locator(`[data-book="${id}"]`) });
    assert.match(await row.innerText(), /作者甲/);
    assert.match(await row.innerText(), /可访问/);
    await book.press('Enter');
    const drawer = page.getByRole('dialog', { name: '书籍详情' });
    await drawer.waitFor();
    assert.deepEqual(await drawer.evaluate(node => {
      const { x, y, width, height } = node.getBoundingClientRect();
      return [x, y, width, height, node.scrollWidth <= node.clientWidth];
    }), [0, 0, 720, 520, true]);
    assert.equal(await recent.textContent(), originalDeskTitle);
    await drawer.getByRole('button', { name: '编辑书名和作者' }).press('Enter');
    const renamed = '静物档案 99 · ' + '连续长书名'.repeat(12);
    await drawer.getByLabel('显示书名').fill(renamed);
    await drawer.getByRole('button', { name: '保存修改' }).press('Enter');
    await drawer.getByRole('heading', { name: renamed }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await book.evaluate(node => node === document.activeElement), true);
    assert.equal(await table.locator('tbody tr').last().getByRole('button').textContent(), renamed);
    assert.equal(await checkbox.isChecked(), true);
    const search = page.getByLabel('搜索书名、作者或标签');
    await search.fill('档案 99');
    await page.waitForFunction(() => document.querySelectorAll('.library-table tbody tr').length === 1);
    await book.press('Enter');
    await drawer.getByRole('button', { name: '编辑书名和作者' }).press('Enter');
    await drawer.getByLabel('显示书名').fill('另一册静物');
    await drawer.getByRole('button', { name: '保存修改' }).press('Enter');
    const notice = page.getByRole('button', { name: '查看此书' });
    await notice.waitFor();
    assert.equal(await notice.evaluate(node => node === document.activeElement), true);
    await notice.press('Enter');
    await drawer.getByRole('button', { name: '关闭详情' }).press('Enter');
    assert.equal(await notice.evaluate(node => node === document.activeElement), true);
    assert.equal(await search.inputValue(), '档案 99');
    await search.fill('');
    await page.setViewportSize({ width: 1280, height: 720 });
    await book.waitFor();
    assert.equal(await table.getByRole('columnheader').count(), 4);
    assert.deepEqual(errors, []);
    console.log('PASS Two-book library detail smoke: compact table, full-page details, edit, selection and return focus.');
  } finally {
    await browser?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
