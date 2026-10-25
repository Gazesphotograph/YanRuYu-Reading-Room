'use strict';

// The real room renderer and reading profile run against neutral SVG pages and
// a fresh temporary profile. This suite cannot connect to the live desktop app.
const { chromium } = require('./playwright-runtime.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { createReadingStateStore } = require('../resources/app/modules/reading_state');

(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-reading-tools-'));
  const screenshots = process.argv.includes('--screenshots');
  const output = path.join(__dirname, '.artifacts', 'reading-tools');
  const diagnostics = [], checks = [];
  let browser, page, failPreferences = false;
  const pass = name => { checks.push(name); console.log('PASS ' + name); };
  try {
    const pages = [];
    for (let index = 1; index <= 70; index++) {
      const width = [4, 8].includes(index) ? 680 : 300, height = index === 40 ? 900 : 400;
      const absolutePath = path.join(directory, `neutral-page-${String(index).padStart(2, '0')}.svg`);
      await fs.writeFile(absolutePath, `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${index % 2 ? '#d9e3df' : '#dfe1eb'}"/><rect x="15" y="15" width="${width - 30}" height="${height - 30}" fill="none" stroke="#506a60"/><text x="30" y="95" font-family="serif" font-size="22" fill="#334b43">Neutral page ${index}</text></svg>`);
      // One spread intentionally has no metadata; its natural dimensions must
      // split the provisional pair without changing the user's page anchor.
      pages.push({ absolutePath, ...(index === 4 ? {} : { width, height }) });
    }
    const books = ['reader-a', 'reader-b'].map((id, index) => ({ id, title: `Neutral reading tools ${index + 1}`, type: 'folder',
      filepath: path.join(directory, id), coverPath: pages[index].absolutePath, pageCount: 70, readCount: 0,
      tags: {}, mark: false, hiddenBook: false, exist: true, status: 'non-tag', date: index + 1 }));
    const setting = { library: directory, imageExplorer: '', reverseLeftRight: false };
    let store = createReadingStateStore({ storePath: directory }), uiState = null;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--allow-file-access-from-files', '--enable-unsafe-swiftshader'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route(/^https?:/, route => route.abort());
    await context.exposeBinding('__readerToolsInvoke', async (_source, channel, args) => {
      if (channel === 'load-reading-state') return store.load();
      if (channel === 'migrate-reading-state') return store.migrate(args[0], books);
      if (channel === 'save-reading-progress') { assert(books.some(book => book.id === args[0])); return store.saveProgress(...args); }
      if (channel === 'save-reading-preferences') {
        assert(books.some(book => book.id === args[0]));
        if (failPreferences) throw Error('Synthetic preference disk failure');
        return store.savePreferences(...args);
      }
      if (channel === 'load-ui-state') return uiState;
      if (channel === 'save-ui-state') { uiState = args[0]; return uiState; }
      if (channel === 'load-setting') return setting;
      if (channel === 'save-setting') { Object.assign(setting, args[0]); return setting; }
      if (channel === 'load-book-list') return books;
      if (channel === 'load-collection-list' || channel === 'task-list') return [];
      if (channel === 'save-book') { const book = books.find(book => book.id === args[0].id); assert(book); Object.assign(book, args[0]); return book; }
      if (channel === 'load-manga-image-list') { assert(books.some(book => book.id === args[0].id)); return pages; }
      if (['release-sendimagelock', 'update-window-title', 'set-progress-bar'].includes(channel)) return null;
      throw Error('Unexpected fixture IPC: ' + channel);
    });
    await context.addInitScript(() => {
      if (!localStorage.getItem('reader-tools-seeded')) {
        localStorage.setItem('room-view', '"grid"');localStorage.setItem('room-reading-mode', '"paged"');
        localStorage.setItem('reader-tools-seeded', 'true');
      }
      const listeners = new Map();
      window.ipcRenderer = { invoke: (channel, ...args) => window.__readerToolsInvoke(channel, args),
        on(channel, callback) { if (!listeners.has(channel)) listeners.set(channel, []); listeners.get(channel).push(callback); },
        removeListener(channel, callback) { listeners.set(channel, (listeners.get(channel) || []).filter(item => item !== callback)); } };
    });
    page = await context.newPage();
    page.on('pageerror', error => diagnostics.push(error.message));
    page.on('console', message => { if (message.type() === 'error') diagnostics.push(message.text()); });
    await page.goto(pathToFileURL(path.join(__dirname, '../resources/app/dist/index.html')).href);
    await page.locator('#room [data-book="reader-a"]').waitFor();
    const anchor = async expected => page.waitForFunction(expected => {
      const reader = document.querySelector('.reader');
      const image = document.querySelector(reader?.dataset.readingMode === 'continuous' ? `.continuous-page[data-reader-page="${expected}"] img` : `.paged-sheet[data-reader-page="${expected}"] img`);
      return document.querySelector('#reader-page')?.textContent === `${expected} / 70` && image?.complete && image.naturalWidth > 0 && image.closest('[data-reader-page]')?.classList.contains('is-loaded');
    }, expected);
    const displayed = () => page.locator('.paged-sheet').evaluateAll(elements => elements.map(element => Number(element.dataset.readerPage)));
    const jump = async number => { await page.locator('#reader-page-input').fill(String(number)); await page.locator('#reader-page-input').press('Enter'); await anchor(number); };
    const close = async () => { await page.locator('[data-action="exit-reader"]').click(); await page.locator('.reader').waitFor({ state: 'detached' }); };

    await page.locator('#room [data-book="reader-a"]').focus();await page.keyboard.press('Enter');
    await page.locator('[data-read="reader-a"]').waitFor();await page.locator('[data-read="reader-a"]').focus();await page.keyboard.press('Space');
    await anchor(1);await page.evaluate(() => window.readingState.flush());assert.equal(books[0].readCount, 1);
    pass('A book opens using only native Enter, Tab-focus and Space controls');

    await page.locator('#reader-mode').selectOption('double');await anchor(1);assert.deepEqual(await displayed(), [1]);
    await page.locator('[data-action="page-next"]').click();await anchor(2);assert.deepEqual(await displayed(), [2, 3]);
    await jump(3);await page.evaluate(() => window.readingState.flush());assert.equal((await store.load()).progress['reader-a'].page, 3);
    await page.locator('#reader-mode').selectOption('paged');await anchor(3);assert.deepEqual(await displayed(), [3]);
    await page.locator('#reader-mode').selectOption('double');await anchor(3);assert.deepEqual(await displayed(), [2, 3]);
    await page.locator('#reader-direction').selectOption('rtl');
    const positions = await page.locator('.paged-sheet').evaluateAll(elements => elements.map(element => element.getBoundingClientRect().left));
    assert(positions[0] > positions[1], 'RTL must reverse the visible order');
    await page.locator('#reader-body').focus();await page.keyboard.press('ArrowLeft');await anchor(4);
    await page.waitForFunction(() => document.querySelectorAll('.paged-sheet').length === 1);assert.deepEqual(await displayed(), [4]);
    await page.keyboard.press('ArrowLeft');await anchor(5);assert.deepEqual(await displayed(), [5, 6]);
    await page.keyboard.press('ArrowRight');await anchor(4);
    await page.locator('#reader-cover-alone').uncheck();await jump(1);assert.deepEqual(await displayed(), [1, 2]);
    await page.locator('#reader-cover-alone').check();await anchor(1);assert.deepEqual(await displayed(), [1]);
    pass('Double pages preserve exact anchors, reverse direction, isolate landscape pages and honor the cover option');

    await jump(5);await page.locator('[data-action="reader-zoom-in"]').focus();await page.keyboard.press('Space');
    assert.equal(await page.locator('#reader-zoom').inputValue(), '125');await anchor(5);
    await page.locator('#reader-body').focus();await page.keyboard.press('ArrowDown');
    assert(await page.locator('#reader-body').evaluate(element => element.scrollTop > 0));await anchor(5);
    await page.keyboard.press('0');assert.equal(await page.locator('#reader-zoom').inputValue(), '100');
    await page.keyboard.press('w');assert.equal(await page.locator('#reader-fit').inputValue(), 'width');
    pass('Focused buttons keep Space activation; zoomed pages scroll before turning and keyboard zoom resets');

    await page.keyboard.press('t');await page.locator('#reader-thumbnails').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-reader-thumbnail]').count(), 60);
    await page.waitForFunction(() => document.querySelectorAll('.reader-thumbnail img[src]').length > 0);
    assert(await page.locator('.reader-thumbnail img[src]').count() < 30, 'Thumbnails must load a bounded viewport, not the entire book: ' + await page.locator('#reader-thumbnail-grid').evaluate(grid => JSON.stringify({ height: grid.clientHeight, scroll: grid.scrollHeight, count: grid.querySelectorAll('img[src]').length, first: grid.firstElementChild.getBoundingClientRect().toJSON(), style: getComputedStyle(grid).gridTemplateColumns })));
    await page.locator('[data-reader-thumbnail="12"]').focus();await page.keyboard.press('Enter');await anchor(12);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#reader-thumbnails').isHidden(), true);assert.equal(await page.locator('.reader').count(), 1);
    await page.locator('#reader-body').focus();await page.keyboard.press('t');
    await page.locator('[data-action="reader-thumbs-next"]').click();assert.equal(await page.locator('[data-reader-thumbnail]').count(), 10);
    await page.locator('[data-reader-thumbnail="70"]').click();await anchor(70);assert.equal(await page.locator('[data-action="page-next"]').isDisabled(), true);
    await page.keyboard.press('Escape');
    pass('Lazy thumbnail navigation reaches later groups and the final page with bounded mounted thumbnails');

    await page.locator('#reader-body').focus();await page.keyboard.press('g');assert.equal(await page.locator('#reader-page-input').evaluate(element => element === document.activeElement), true);
    await page.keyboard.type('40');await page.keyboard.press('Enter');await anchor(40);
    await page.locator('#reader-mode').selectOption('continuous');await anchor(40);
    await page.locator('#reader-body').evaluate(body => { const holder = body.querySelector('[data-reader-page="40"]'); body.scrollTop = holder.offsetTop + holder.offsetHeight * .33; });
    await page.evaluate(() => window.readingState.flush());
    const before = (await store.load()).progress['reader-a'];assert.equal(before.page, 40);assert(Math.abs(before.offset - .33) < .02);
    await page.locator('#reader-mode').selectOption('paged');await anchor(40);
    await page.locator('#reader-mode').selectOption('continuous');await anchor(40);await page.evaluate(() => window.readingState.flush());
    const after = (await store.load()).progress['reader-a'];assert.equal(after.page, 40);assert(Math.abs(after.offset - before.offset) < .02);
    await page.locator('[data-action="reader-thumbnails"]').click();await anchor(40);await page.evaluate(() => window.readingState.flush());
    assert(Math.abs((await store.load()).progress['reader-a'].offset-before.offset)<.02, 'Opening thumbnails must preserve the continuous page fraction');
    await page.setViewportSize({ width: 720, height: 900 });await anchor(40);await page.evaluate(() => window.readingState.flush());
    assert(Math.abs((await store.load()).progress['reader-a'].offset-before.offset)<.02, 'Resizing must preserve the continuous page fraction');
    await page.locator('[data-action="reader-thumbnails"]').click();await page.setViewportSize({ width: 1280, height: 900 });await anchor(40);
    await page.locator('#reader-zoom').fill('75');await page.locator('#reader-zoom').press('Tab');await anchor(40);
    for (let index = 0; index < 3; index++) { await page.locator('#reader-mode').selectOption('double');await anchor(40);await page.locator('#reader-mode').selectOption('continuous');await anchor(40); }
    assert(await page.locator('.continuous-page img[src]').count() < 16);
    assert.equal(books[0].readCount, 1);
    pass('Mode changes, thumbnails, resizing and magnification retain page 40 and its fractional offset without multiplying active images or read counts');

    failPreferences = true;
    await page.locator('#reader-mode').selectOption('double');await anchor(40);
    const error = await page.evaluate(async () => { try { await window.readingState.flush(); return ''; } catch (error) { return error.message; } });
    assert.match(error, /Synthetic preference disk failure/);
    await page.locator('[data-action="exit-reader"]').click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent.includes('Synthetic preference disk failure') || document.body.innerText.includes('Synthetic preference disk failure'));
    assert.equal(await page.locator('.reader').count(), 1, 'A failed preference write must keep the reading dialog available for retry');
    failPreferences = false;await close();
    assert.equal(await page.locator('#room [data-book="reader-a"]').evaluate(element => element === document.activeElement), true);
    assert.equal((await store.load()).preferences['reader-a'].mode, 'double');
    pass('Preference write failures keep the reader open; a successful retry saves and returns focus to the same book');

    await page.locator('#room [data-book="reader-b"]').dblclick();await anchor(1);assert.equal(await page.locator('#reader-mode').inputValue(), 'paged');await close();
    store = createReadingStateStore({ storePath: directory });await page.reload();
    await page.locator('#room [data-book="reader-a"]').dblclick();await anchor(40);
    assert.equal(await page.locator('#reader-mode').inputValue(), 'double');assert.equal(await page.locator('#reader-direction').inputValue(), 'rtl');assert.equal(await page.locator('#reader-zoom').inputValue(), '75');
    pass('Each book has independent preferences, and restarting the profile and renderer restores the saved settings');

    if (screenshots) { await fs.mkdir(output, { recursive: true });await page.screenshot({ path: path.join(output, 'reader-tools-wide.png') }); }
    for (const width of [640, 420]) {
      await page.setViewportSize({ width, height: 900 });await page.locator('[data-action="reader-thumbnails"]').click();
      const bounds = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - innerWidth,
        bodyHeight: document.querySelector('#reader-body').clientHeight,
        controls: [...document.querySelectorAll('.reader-tools select,.reader-tools input,.reader-page-jump button')].filter(element => element.offsetParent).map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right }; }) }));
      assert(bounds.overflow <= 1 && bounds.bodyHeight > 200 && bounds.controls.every(rect => rect.left >= 0 && rect.right <= width + 1), JSON.stringify(bounds));
      if (screenshots && width === 420) await page.screenshot({ path: path.join(output, 'reader-tools-narrow.png') });
      await page.keyboard.press('Escape');
    }
    pass('The toolbars, page input and thumbnail panel fit 640px and 420px windows');
    await close();
    const unexpected = diagnostics.filter(value => !/net::ERR_FAILED|Failed to load resource|WebGL|THREE\.|Synthetic preference disk failure/.test(value));
    assert.equal(unexpected.length, 0, unexpected.join('\n'));
    console.log(`${checks.length} reading-tool integration checks passed using isolated synthetic content`);
    if (screenshots) console.log('Optional screenshots: ' + output);
    await context.close();
  } catch (error) {
    console.error(diagnostics.join('\n'));
    if (page && !page.isClosed()) console.error(await page.evaluate(() => JSON.stringify({ text: document.body.innerText.slice(-2000),
      active: document.activeElement?.outerHTML, progress: window.readingState?.progress, preferences: window.readingState?.preferences })));
    throw error;
  } finally {
    if (browser) await browser.close();
    assert(directory.startsWith(path.join(os.tmpdir(), 'yanruyu-reading-tools-')));
    await fs.rm(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error);process.exitCode = 1; });
