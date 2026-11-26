'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { appURL, attachFakeIpc, createFakeModel, createFixtures, launchOptions } = require('./test-gallery.cjs');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');
const { TaskService } = require('../resources/app/modules/task_service');
const { createMetadataSources, validateSourceSettings } = require('../resources/app/modules/metadata_sources');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-metadata-history-ui-'));
  let browser;
  try {
    const { books, pages } = createFixtures(directory, 2, 4);
    const filename = books[0].title + ' [Chinese].cbz';
    Object.assign(books[0], { title:filename, status:'non-tag', tags:{}, filepath:path.join(directory, filename), type:'zip', hash:'b'.repeat(40) });
    const model = createFakeModel(books, pages);
    const id = books[0].id, openOnly = books[1].id;
    model.setting.requireGap = 0;
    const store = createReadingStateStore({ storePath: directory });
    await store.migrate({ recentRead: JSON.stringify([{ id: openOnly, read_time: Math.floor(Date.now() / 1000) - 3600 }]),
      'room-progress': JSON.stringify({ [id]: { page: 2, total: 4, time: Date.now() - 7200000 } }) }, books);
    let rejectNext = true;
    const sources = createMetadataSources({ getBook: async bookId => model.books.find(book => book.id === bookId), getSettings: () => model.setting,
      saveBook: patch => baseInvoke('save-book', patch), request: async (address, options) => {
        if (new URL(address).hostname === 'exhentai.org') {
          assert.equal(options.cookie, 'ipb_member_id=123; ipb_pass_hash=fixture');
          assert.equal(new URL(address).searchParams.get('f_shash'), 'B'.repeat(40));
          return '<a href="/g/123/abcdef1234/">River &amp; Lines</a>';
        }
        if (rejectNext) { rejectNext = false; throw new Error('元数据来源返回 HTTP 503'); }
        return JSON.stringify({ gmetadata: [{ gid: 123, token: 'abcdef1234', title: 'River &amp; Lines', title_jpn: '中性来源档案',
          tags: ['artist:River Studio', 'other:quiet', 'language:chinese'], category: 'Non-H', rating: '4.5', filecount: '99' }] });
      } });
    const baseInvoke = model.invoke.bind(model);
    const tasks = new TaskService();
    tasks.register('metadata-batch', (params, task) => sources.batch({
      ...params, library:model.setting.library, books:model.books
    }, task), { title:'全书库拉取在线元数据' });
    model.invoke = async (channel, ...args) => {
      if (channel === 'task-start' && args[0] === 'metadata-batch') return tasks.start(...args);
      if (channel === 'task-list') return tasks.list();
      if (channel === 'load-reading-state') return store.load();
      if (channel === 'migrate-reading-state') return store.migrate(args[0], model.books);
      if (channel === 'save-reading-progress') return store.saveProgress(...args);
      if (channel === 'save-reading-preferences') return store.savePreferences(...args);
      if (channel === 'save-reading-visit') return store.saveVisit(...args);
      if (channel === 'metadata-source-preview') return sources.preview(args[0]);
      if (channel === 'metadata-source-search') return sources.search(args[0]);
      if (channel === 'metadata-source-apply') return sources.apply(args[0]);
      if (channel === 'metadata-source-save-settings') { model.setting = validateSourceSettings(model.setting, args[0]); return model.setting; }
      return baseInvoke(channel, ...args);
    };
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 720, height: 520 }, reducedMotion: 'reduce' });
    await attachFakeIpc(context, model);
    await context.addInitScript(() => localStorage.setItem('room-workspace-preview', 'true'));
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(appURL);
    await page.locator('[data-desk-resume]').waitFor();
    assert.equal(await page.locator('[data-desk-resume]').getAttribute('data-read'),openOnly);
    assert.match(await page.locator('.desk-resume').innerText(),/未记录页码/);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name:'书库' }).click();
    await page.locator('#tag-list .tag-filter').filter({hasText:'chinese'}).click();
    await page.locator('[data-filter="reading"]:visible').first().click();
    const card = page.locator('.book-slot').filter({has:page.locator(`[data-book="${id}"]`)});
    assert.equal(await page.locator('.book-slot').count(), 1);
    assert.match(await card.innerText(), /第 2 \/ 4 页/);
    await card.locator('[data-book]').press('Enter');
    await page.getByRole('button', {name:'chinese · 文件名识别'}).waitFor();
    assert.deepEqual(model.books[0].tags, {});
    await page.keyboard.press('Escape');
    await page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name:'书桌' }).click();
    await page.setViewportSize({ width: 720, height: 520 });
    await page.locator('.sidebar [data-action="reading-history"]').click();
    let history = page.getByRole('dialog', { name: '阅读记录', exact: true });
    await history.waitFor();
    assert.match(await history.innerText(), /2 本有记录/);
    assert.equal(await history.locator('[data-history-more]').isVisible(), false);
    assert.match(await history.innerText(), /未记录页码/);
    assert.equal((await store.load()).progress[openOnly], undefined);
    const liveVisit=await store.saveVisit(id,{time:Date.now(),source:'external'});
    await page.evaluate(payload=>window.__galleryEmit('reading-visit-saved',payload),{bookId:id,visit:liveVisit});
    await history.locator('.reading-history-list li').first().getByRole('heading',{name:books[0].title}).waitFor();
    assert.match(await history.locator('.reading-history-list li').first().innerText(),/外部阅读器/);
    assert.equal(await history.getByLabel('查找读过的书').inputValue(),'');
    assert.equal((await store.load()).progress[id].page,2);
    await history.getByLabel('查找读过的书').fill('静物档案 01');
    await history.getByRole('button', { name: '继续阅读', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '2 / 4');
    await page.keyboard.press('ArrowRight');
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent === '3 / 4');
    await page.locator('[data-action="exit-reader"]').click();
    await history.waitFor();
    assert.equal(await history.getByLabel('查找读过的书').inputValue(), '静物档案 01');
    assert.match(await history.innerText(), /第 3 \/ 4 页/);
    await history.getByRole('button', { name: '书籍详情' }).click();
    const detail = page.getByRole('dialog', { name: '书籍详情', exact: true });
    await detail.getByRole('button', { name: '拉取元数据', exact: true }).click();
    const metadata = page.getByRole('dialog', { name: '拉取元数据', exact: true });
    assert.equal(await metadata.getByLabel('搜索书名').inputValue(), filename.slice(0, -4));
    await metadata.getByRole('button', {name:'元数据来源设置'}).click();
    const settings = page.getByRole('dialog', { name:'元数据来源设置' });
    await settings.getByLabel('ipb_member_id').fill('123');
    await settings.getByLabel('ipb_pass_hash').fill('fixture');
    await settings.getByRole('button', {name:'保存来源设置'}).click();
    await settings.getByRole('status').filter({hasText:'来源设置已保存'}).waitFor();
    await settings.getByRole('button', {name:'返回拉取'}).click();
    await metadata.getByLabel('画廊或作品链接').fill('https://exhentai.org/g/123/abcdef1234/');
    const original = structuredClone(model.books[0]);
    await metadata.getByRole('button', { name: '拉取预览', exact: true }).click();
    await metadata.getByRole('status').filter({ hasText: 'HTTP 503' }).waitFor();
    assert.deepEqual(model.books[0], original);
    await metadata.getByRole('button', { name: '搜索来源' }).click();
    await metadata.getByRole('button', { name: 'River & Lines', exact:true }).click();
    await metadata.getByRole('heading', { name: '应用前预览' }).waitFor();
    assert.deepEqual(model.books[0], original);
    await metadata.locator('input[name="field"]').evaluateAll(inputs => inputs.forEach(input => input.checked = ['title', 'title_jpn', 'tags'].includes(input.value)));
    const artifact = path.resolve(__dirname, '.artifacts', 'metadata-history');
    fs.mkdirSync(artifact, { recursive: true });
    await page.screenshot({ path: path.join(artifact, 'metadata-preview-720.png') });
    const overflow = await metadata.evaluate(node => node.scrollWidth <= node.clientWidth + 1);
    assert.equal(overflow, true);
    await metadata.getByRole('button', { name: '应用所选字段', exact: true }).click();
    await metadata.getByRole('status').filter({ hasText: '所选元数据已保存' }).waitFor();
    assert.equal(model.books[0].title, 'River & Lines');
    assert.equal(model.books[0].title_jpn, '中性来源档案');
    assert.deepEqual(model.books[0].tags.artist, ['River Studio']);
    for (const field of ['pageCount', 'coverPath', 'readCount', 'rating', 'filepath', 'mark']) assert.equal(model.books[0][field], original[field], field);
    assert.equal((await store.load()).progress[id].page, 3);
    await metadata.getByRole('button', { name: '返回书籍详情' }).click();
    await detail.getByRole('button', { name:'chinese', exact:true }).waitFor();
    assert.equal(await detail.getByText('文件名识别', {exact:false}).count(), 0);
    await page.keyboard.press('Escape');
    // A merge/undo or another interface can replace the main-process progress.
    await store.applyOrganizerProgress(id, { expected: (await store.load()).progress[id], value: { page: 1, total: 4, time: 1000, source: 'migration' } });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent('yanruyu-library-updated')));
    await page.waitForFunction(id => window.readingState.progress[id]?.page === 1, id);
    await page.reload();
    await page.locator('[data-desk-resume]').waitFor();
    await page.locator('.sidebar [data-action="reading-history"]').click();
    await history.waitFor();
    await history.getByLabel('查找读过的书').fill('中性来源');
    assert.match(await history.innerText(), /第 1 \/ 4 页/);
    await page.screenshot({ path: path.join(artifact, 'reading-history-720.png') });
    await page.keyboard.press('Escape');
    await page.getByRole('button', {name:'批量拉取元数据'}).click();
    const batch = page.getByRole('dialog', {name:'批量拉取元数据'});
    assert.equal(await batch.getByLabel('拉取范围').inputValue(), 'missing');
    assert.match(await batch.getByLabel('拉取范围').innerText(), /仅未标记书籍（1 本）/);
    await batch.getByLabel('拉取范围').selectOption('all');
    await batch.getByRole('button', {name:'开始批量拉取'}).click();
    const center = page.getByRole('dialog', {name:'任务中心'});
    await center.waitFor();
    await page.evaluate(() => window.YanruyuTasks.refresh());
    await center.getByText(/更新 1 · 一致 0 · 跳过 0 · 未完成 1/).waitFor();
    await center.locator('summary').click();
    await center.getByRole('button', {name:'单本拉取'}).click();
    await metadata.waitFor();
    assert.equal(await metadata.getByLabel('搜索书名').inputValue(), books[1].title);
    assert.equal((await store.load()).progress[id].page, 1);
    assert.deepEqual(errors, []);
    console.log('PASS Two-book metadata and reading history: HTTP failure, retry, field preview, narrow layout, open-only migration, resume, return query, organizer refresh and reload.');
  } finally {
    await browser?.close();
    if (!directory.startsWith(path.join(os.tmpdir(), 'yanruyu-metadata-history-ui-'))) throw new Error('Unsafe fixture cleanup');
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
