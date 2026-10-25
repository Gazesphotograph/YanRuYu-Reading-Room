'use strict';

// Browser actions use the real discovery renderer and the real isolated service.
// Only the operating-system picker/OCR result is stubbed here; the separate
// native OCR suite recognizes an actual generated neutral image.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { launchOptions } = require('./test-gallery.cjs');
const { createLocalSearchService } = require('../resources/app/modules/local_search');
const { sourceBooks, guardedCleanup } = require('./test-local-search.cjs');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-local-search-ui-'));
  let service, browser, page;
  const books = sourceBooks();
  books.push({ id: 'markup', title: '<img src=x onerror="window.injected=true">', pageCount: 3,
    tags: { artist: ['Markup Sample'], other: ['neutral'] } });
  const checks = [], diagnostics = [], calls = []; let ocrAvailable = true, ocrCancelled = false;
  const pass = value => { checks.push(value); console.log('PASS ' + value); };
  try {
    service = createLocalSearchService({ storePath: directory, getBooks: async () => books,
      ocr: { capability: async () => {
        await new Promise(resolve => setTimeout(resolve, 350));
        return { available: ocrAvailable, reason: ocrAvailable ? '' : '此测试系统没有安装 OCR 语言', languages: ocrAvailable ? [{ tag: 'en-US', name: '英语' }] : [] };
      } } });
    const moduleURL = pathToFileURL(path.join(__dirname, '../resources/app/dist/room-discovery.js')).href;
    const styleURL = pathToFileURL(path.join(__dirname, '../resources/app/dist/room.css')).href;
    const fixture = path.join(directory, 'discovery-ui.html');
    await fs.writeFile(fixture, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${styleURL}"></head><body><button id="launch">打开本地发现</button><script type="module">
      import { createDiscoveryUI } from ${JSON.stringify(moduleURL)};
      window.actions = []; window.aliasNotifications = [];
      window.discovery = createDiscoveryUI({invoke:async(...args)=>{const result=await window.fixtureInvoke(...args);if(args[1]?.action==='ocr-capability')window.ocrCapabilityReturned=true;return result;}, getBooks:()=>window.fixtureBooks,
        openBook:id=>window.actions.push({action:'book',id}), openReader:(id,page)=>window.actions.push({action:'reader',id,page}),
        onAliasesChanged:aliases=>window.aliasNotifications.push(aliases)});
      document.querySelector('#launch').onclick=()=>window.discovery.open({tab:'search'});
    </script></body></html>`, 'utf8');
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    await context.route(/^https?:/, route => route.abort());
    await context.addInitScript(value => { window.fixtureBooks = value; }, books);
    await context.exposeFunction('fixtureInvoke', async (channel, payload) => {
      calls.push({ channel, payload });
      if (channel === 'local-search-command') return service.command(payload);
      if (channel === 'local-search-ocr-image') return ocrCancelled ? { cancelled: true } : { text: 'FOREST NOTES. Quiet garden sunlight.', source: 'windows-ocr', language: 'en-US', width: 1000, height: 300, elapsedMilliseconds: 70 };
      throw new Error('Unexpected fixture channel: ' + channel);
    });
    page = await context.newPage(); page.on('pageerror', error => diagnostics.push(error.message));
    await page.goto(pathToFileURL(fixture).href); await page.waitForFunction(() => !!window.discovery);
    await page.evaluate(() => window.discovery.refreshAliases());
    await page.click('#launch'); await page.locator('[data-discovery-search]').waitFor();
    await page.fill('[name="query"]', 'garden bridge'); await page.selectOption('[name="mode"]', 'text');
    await page.waitForFunction(() => window.ocrCapabilityReturned === true);
    assert.equal(await page.inputValue('[name="query"]'), 'garden bridge'); assert.equal(await page.inputValue('[name="mode"]'), 'text');
    pass('delayed native capability detection preserves a search typed into the preloaded dialog');
    await page.selectOption('[name="mode"]', 'all');
    await page.click('[data-discovery-tab="aliases"]');
    await page.fill('[name="canonical"]', '青木'); await page.fill('[name="aliases"]', 'Aoki');
    await page.click('[data-discovery-alias] button[type="submit"]');
    await page.locator('.discovery-preview').waitFor();
    assert.equal((await service.snapshot()).aliases.length, 0);
    assert((await page.locator('.discovery-preview').innerText()).includes('3 本'));
    await page.click('[data-discovery-action="cancel-preview"]');
    assert.equal((await service.snapshot()).aliases.length, 0);
    await page.click('[data-discovery-alias] button[type="submit"]');
    await page.click('[data-discovery-action="save-alias"]');
    await page.waitForFunction(() => document.querySelector('.discovery-alias-list')?.textContent.includes('Aoki'));
    assert.equal((await service.snapshot()).aliases.length, 1);
    assert.equal(await page.evaluate(() => window.aliasNotifications.at(-1)[0].canonical), '青木');
    pass('alias preview/cancel/save works through real service IPC and notifies the main-search integration only after confirmation');

    await page.click('[data-discovery-tab="search"]'); await page.fill('[name="query"]', '青木');
    await page.click('[data-discovery-search] button[type="submit"]');
    await page.waitForFunction(() => document.querySelectorAll('.discovery-result').length === 3);
    assert((await page.locator('[data-discovery-results]').innerText()).includes('作者别名'));
    assert(!(await page.locator('[data-discovery-results]').innerText()).includes('隐藏的样本'));
    await page.fill('[name="query"]', 'satellite observatory'); await page.click('[data-discovery-search] button[type="submit"]');
    await page.waitForFunction(() => document.querySelector('[data-discovery-results]')?.textContent.includes('没有找到匹配内容'));
    pass('search shows explainable alias matches and a truthful empty result, without hidden books');

    await page.click('[data-discovery-tab="similar"]'); await page.selectOption('[data-discovery-book-select]', 'forest');
    await page.click('[data-discovery-action="recommend"]');
    await page.waitForFunction(() => document.querySelector('[data-discovery-results]')?.textContent.includes('同一作者：青木'));
    assert.equal(await page.locator('.discovery-result').count(), 1);
    assert((await page.locator('.discovery-result').innerText()).includes('河畔速写'));
    await page.selectOption('[data-discovery-book-select]', 'machine'); await page.click('[data-discovery-action="recommend"]');
    await page.waitForFunction(() => document.querySelector('[data-discovery-results]')?.textContent.includes('暂无足够的共同'));
    pass('similar-book UI explains recommendation evidence and does not invent suggestions for unrelated books');

    await page.click('[data-discovery-tab="text"]'); await page.selectOption('[data-discovery-book-select]', 'forest');
    await page.click('[data-discovery-action="pause"]');
    await page.waitForFunction(() => document.querySelector('.discovery-index-title')?.textContent.includes('已暂停'));
    await page.fill('[name="page"]', '3'); await page.fill('[name="text"]', '清晨森林的鸟鸣，阳光穿过树叶。');
    await page.click('[data-discovery-text] button[type="submit"]'); await page.locator('[data-discovery-action="save-text"]').waitFor();
    assert.equal((await service.snapshot()).savedPages, 0);
    await page.fill('[name="text"]', '清晨森林的鸟鸣，阳光穿过树叶。新的行程开始。');
    assert.equal(await page.locator('[data-discovery-action="save-text"]').count(), 0);
    await page.click('[data-discovery-text] button[type="submit"]'); await page.click('[data-discovery-action="save-text"]');
    await page.waitForFunction(() => document.querySelector('.discovery-index-title')?.textContent.includes('0 / 1'));
    assert.equal((await service.snapshot()).savedPages, 1); assert.equal((await service.snapshot()).indexedPages, 0);
    await page.click('[data-discovery-action="resume"]'); await service.waitForIdle();
    await page.click('[data-discovery-action="refresh-status"]');
    await page.waitForFunction(() => document.querySelector('.discovery-index-title')?.textContent.includes('1 / 1'));
    assert((await page.locator('.discovery-index').innerText()).includes('0 B / 0 次'));
    pass('text requires preview confirmation; edits invalidate the preview; pause/resume and honest local cost are visible');

    await page.click('[data-discovery-tab="search"]'); await page.fill('[name="query"]', '鸟鸣'); await page.selectOption('[name="mode"]', 'text');
    await page.click('[data-discovery-search] button[type="submit"]');
    await page.locator('[data-discovery-read-book="forest"]').waitFor();
    assert((await page.locator('.discovery-result').innerText()).includes('第 3 页'));
    await page.click('[data-discovery-read-book="forest"]');
    assert.deepEqual(await page.evaluate(() => window.actions.at(-1)), { action: 'reader', id: 'forest', page: 3 });
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('dialog').count(), 0);
    pass('a matched excerpt opens the exact one-based book page and disposes its dialog');

    await page.evaluate(() => window.discovery.open({ tab: 'text', bookId: 'river' }));
    await page.fill('[name="page"]', '5'); await page.selectOption('[name="language"]', 'en-US');
    await page.click('[data-discovery-action="ocr-image"]');
    await page.waitForFunction(() => document.querySelector('[name="text"]')?.value.includes('garden sunlight'));
    assert.equal((await service.snapshot()).savedPages, 1);
    assert.equal(calls.findLast(call => call.channel === 'local-search-ocr-image').payload.language, 'en-US');
    await page.click('[data-discovery-text] button[type="submit"]'); await page.click('[data-discovery-action="save-text"]');
    await page.waitForFunction(() => document.querySelector('[data-discovery-notice]')?.textContent.includes('文本已保存'));
    const ocrEntry = await service.command({ action: 'get-text', bookId: 'river', page: 5 });
    assert.equal(ocrEntry.source, 'windows-ocr'); assert.equal(ocrEntry.language, 'en-US');
    ocrCancelled = true;
    await page.fill('[name="text"]', '尚未保存的手动文字'); await page.click('[data-discovery-action="ocr-image"]');
    await page.waitForFunction(() => document.querySelector('[data-discovery-notice]')?.textContent.includes('已取消'));
    assert.equal(await page.inputValue('[name="text"]'), '尚未保存的手动文字');
    pass('OCR returns editable text without saving; confirmation preserves its language/source and cancelling keeps the draft');

    await page.click('[data-discovery-action="clear-index"]');
    await page.waitForFunction(() => document.querySelector('.discovery-index-title')?.textContent.includes('0 / 2'));
    assert.equal((await service.snapshot()).savedPages, 2);
    await page.click('[data-discovery-action="confirm-clear-texts"]');
    assert.equal((await service.snapshot()).savedPages, 2);
    await page.click('[data-discovery-action="cancel-preview"]'); assert.equal((await service.snapshot()).savedPages, 2);
    await page.click('[data-discovery-action="confirm-clear-texts"]'); await page.click('[data-discovery-action="clear-texts"]');
    await page.waitForFunction(() => document.querySelector('.discovery-index-title')?.textContent.includes('0 / 0'));
    assert.equal((await service.snapshot()).savedPages, 0); assert.equal((await service.snapshot()).aliases.length, 1);
    pass('index clearing is reversible; clearing imported originals is separate and requires a scope confirmation');

    await page.click('[data-discovery-close]'); await page.locator('dialog').waitFor({ state: 'detached' }); ocrAvailable = false;
    await page.evaluate(() => window.discovery.open({ tab: 'text', bookId: 'forest' }));
    assert(await page.locator('[data-discovery-action="ocr-image"]').isDisabled());
    assert((await page.locator('[data-discovery-ocr-capability]').innerText()).includes('没有安装'));
    assert(await page.locator('[name="text"]').isEnabled());
    await page.setViewportSize({ width: 420, height: 820 });
    assert(await page.evaluate(() => { const dialog = document.querySelector('dialog'); return dialog.scrollWidth <= dialog.clientWidth + 1 && dialog.getBoundingClientRect().right <= innerWidth; }));
    assert.equal(await page.locator('img[src="x"]').count(), 0); assert.equal(await page.evaluate(() => !!window.injected), false);
    await page.locator('[data-discovery-tab="text"]').focus(); await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('[data-discovery-tab="aliases"]').getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Escape');
    await page.locator('dialog').waitFor({ state: 'detached' });
    assert.equal(await page.locator('dialog').count(), 0);
    await page.evaluate(() => window.discovery.dispose());
    assert.deepEqual(diagnostics, []);
    pass('unsupported OCR retains manual text entry; narrow layout, safe text rendering and keyboard close leave no renderer errors');
    console.log(JSON.stringify({ suite: 'local-search-ui', checks: checks.length, diagnostics, userDataRead: false, fixtureCleanup: 'automatic' }));
  } finally {
    await browser?.close(); await service?.dispose().catch(() => {}); await guardedCleanup(directory);
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
