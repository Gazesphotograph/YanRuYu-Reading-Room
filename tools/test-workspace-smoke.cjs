'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { appURL, attachFakeIpc, createFakeModel, createFixtures, launchOptions } = require('./test-gallery.cjs');

async function main() {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-workspace-smoke-'));
  let browser;
  try {
    const { books, pages } = createFixtures(fixture, 2, 2);
    browser = await chromium.launch(launchOptions());
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    await attachFakeIpc(context, createFakeModel(books, pages));
    await context.addInitScript(() => localStorage.setItem('room-workspace-preview', 'true'));
    const page = await context.newPage();
    const errors = [], sceneRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\/(room-scene|three[^/]*)\.js$/.test(request.url())) sceneRequests.push(request.url());
    });
    const nav = name => page.getByRole('navigation', { name: '主导航' }).getByRole('button', { name });
    const book = page.locator(`#room [data-book="${books[0].id}"]`);
    await page.goto(appURL);
    await page.locator('[data-desk-book], .desk-recent button').first().waitFor();
    await nav('书库').click();
    await book.press('Enter');
    assert.deepEqual(sceneRequests, []);
    await page.getByRole('button', { name: '在阅览室看' }).click();
    await page.locator('.scene-viewport[data-scene-state="ready"]').waitFor();
    assert(sceneRequests.some(url => url.endsWith('/room-scene.js')));
    await page.waitForFunction(id => document.activeElement.dataset.book === id, books[0].id);
    assert.equal(await page.locator('.scene-caption, .scene-edition').count(), 0);
    await page.locator('#room-selection [data-read]').press('Enter');
    await page.waitForFunction(() => document.querySelector('.paged-sheet img')?.naturalWidth > 0);
    await page.locator('[data-action="exit-reader"]').press('Enter');
    await page.waitForFunction(() => !document.querySelector('.reader') && document.activeElement.matches('#room-selection [data-read]'));
    const canvasContext = await page.locator('.scene-canvas').evaluateHandle(node => node.getContext('webgl2'));
    await page.setViewportSize({ width: 500, height: 650 });
    const arrange = page.getByRole('button', { name: '布置私人阅览室' });
    await arrange.click();
    await page.getByRole('button', { name: '关闭私人阅览室' }).click();
    assert.equal(await arrange.evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
    await page.locator('#room-selection [data-in-library]').click();
    assert.equal(await book.getAttribute('data-selected'), '');
    assert.equal(await canvasContext.evaluate(gl => gl.isContextLost()), true);
    await nav('阅览室').click();
    await page.locator('.scene-canvas').evaluate(node => node.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
    await page.locator('.scene-viewport[data-scene-state="fallback"] .book').first().waitFor();
    await nav('书桌').click();
    assert.equal(await page.locator('#room > *, .book-title-tooltip').count(), 0);
    assert.deepEqual(errors, []);
    console.log('PASS Two-book workspace smoke: lazy scene, selection, reader return focus, narrow layout, fallback and teardown.');
  } finally {
    await browser?.close();
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
