'use strict';

// Uses a fresh browser and simulated books only; never opens the desktop app's library.
// Usage: node tools/test-room-author-sort.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const out = fs.mkdtempSync(path.join(os.tmpdir(), 'qiyue-author-sort-'));
const checks = [];
const pass = name => { checks.push(name); console.log('PASS ' + name); };
const ids = books => books.map(book => book.id);
const bookSelector = '#room [data-book]';
const cases = [
  { id: 'zed', title: 'Album 1', tags: { artist: ['Zed'] } },
  { id: 'alpha-10', title: 'Volume 10', tags: JSON.stringify({ artist: ['ALPHA'] }) },
  { id: 'alpha-2a', title: 'Volume 99', title_jpn: 'Volume 2', tags: { artist: ' Alpha ' } },
  { id: 'alpha-2b', title: 'Volume 2', tags: { artist: ['alpha'] } },
  { id: 'artist-10', title: 'Volume 1', tags: { artist: ['Artist 10'] } },
  { id: 'artist-2', title: 'Volume 1', tags: { artist: ['Artist 2'] } },
  { id: 'multi-10', title: 'Volume 10', tags: { artist: ['Zed', 'Beta'] } },
  { id: 'multi-2', title: 'Volume 2', tags: { artist: ['beta', 'zed'] } },
  { id: 'multi-3', title: 'Volume 3', tags: { artist: ['beta', 'BETA', 'zed', 'zed'] } },
  { id: 'beta', title: 'Volume 99', tags: { artist: ['Beta'] } },
  { id: 'missing-10', title: 'No author 10', tags: null },
  { id: 'missing-2', title: 'No author 2', tags: '{broken' },
  { id: 'missing-3', title: 'No author 3', tags: { artist: [null, {}, [], ' '] } },
  { id: 'group-only', title: 'No author 1', tags: { group: ['Aaron'] } },
  { id: 'hidden', title: 'Hidden book', tags: { artist: ['Aaron'] }, hiddenBook: true },
  { id: 'missing-4', title: 'No author 4', tags: [] },
  { id: 'missing-5', title: 'No author 5', tags: { artist: {} } },
];
const expected = ['alpha-2a', 'alpha-2b', 'alpha-10', 'artist-2', 'artist-10', 'beta', 'multi-2', 'multi-3', 'multi-10', 'zed', 'group-only', 'missing-2', 'missing-3', 'missing-4', 'missing-5', 'missing-10'];

async function waitForBooks(page, expectedIds) {
  await page.waitForFunction(({ selector, expectedIds }) =>
    JSON.stringify([...document.querySelectorAll(selector)].map(book => book.dataset.book)) === JSON.stringify(expectedIds),
  { selector: bookSelector, expectedIds });
}

(async () => {
  const { LibraryIndex, tagKey } = await import(pathToFileURL(path.resolve(__dirname, '../resources/app/dist/room-library.js')).href);
  const index = new LibraryIndex(cases);
  assert.deepEqual(ids(index.ordered('author')), expected);
  assert.strictEqual(index.ordered('author'), index.ordered('author'));
  assert.deepEqual(cases[6].tags.artist, ['Zed', 'Beta']);
  pass('Author sorting handles JSON/scalar tags, natural numbers, case, coauthors, duplicate names, absent metadata and stable book-title ties');

  assert.deepEqual(ids(index.select({ sort: 'author', selectedTags: [tagKey('artist', 'Beta')] })), ['beta', 'multi-10']);
  assert.deepEqual(ids(index.select({ sort: 'author', search: 'Volume' })), expected.slice(0, 9));
  assert.deepEqual(ids(index.select({ sort: 'author', filter: 'reading', progress: {
    'alpha-10': { page: 1, total: 5, time: 100 }, 'alpha-2a': { page: 2, total: 5, time: 1 },
  } })), ['alpha-2a', 'alpha-10']);
  assert.deepEqual(ids(index.ordered('author')), expected);
  const chinese = new LibraryIndex([
    { id: 'zhang', title: '第 1 册', tags: { artist: ['张三'] } },
    { id: 'li-10', title: '第 10 册', tags: { artist: ['李四'] } },
    { id: 'li-2', title: '第 2 册', tags: { artist: ['李四'] } },
  ]);
  assert.deepEqual(ids(chinese.ordered('author')), ['li-2', 'li-10', 'zhang']);
  pass('Chinese names and titles sort naturally; searches, tag filters and reading state preserve author order without changing the cache');

  const fixture = createFixtures(path.join(out, 'fixtures'), cases.length);
  fixture.books = fixture.books.map((book, i) => ({ ...book, ...cases[i] }));
  const model = createFakeModel(fixture.books, fixture.pages);
  const browser = await chromium.launch(launchOptions());
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
    await attachFakeIpc(context, model);
    await context.addInitScript(() => {
      if (!localStorage.getItem('room-view')) localStorage.setItem('room-view', JSON.stringify('grid'));
      localStorage.setItem('room-theme', JSON.stringify('paper'));
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(appURL);
    const recent = ids(fixture.books.filter(book => !book.hiddenBook));
    await waitForBooks(page, recent.slice(0, 12));
    await page.locator('[data-action="next"]').click();
    await waitForBooks(page, recent.slice(12));
    await page.getByRole('combobox', { name: '书籍排序', exact: true }).selectOption({ label: '作者顺序' });
    await waitForBooks(page, expected.slice(0, 12));
    assert.equal(await page.locator('#pagination').textContent(), '01 / 02');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('room-sort'))), 'author');
    await page.locator('[data-action="next"]').click();
    await waitForBooks(page, expected.slice(12));
    await page.locator('#sort').selectOption('recent');
    await waitForBooks(page, recent.slice(0, 12));
    await page.locator('#sort').selectOption('author');
    await page.locator('#search').fill('Volume');
    await waitForBooks(page, expected.slice(0, 9));
    await page.locator('#search').fill('');
    await waitForBooks(page, expected.slice(0, 12));
    pass('The author option sorts both pages, resets pagination, saves the preference and works with search and existing recent sorting');

    await page.locator('[data-view="shelf"]').click();
    await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    await waitForBooks(page, expected.slice(0, 12));
    await page.reload();
    await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    await waitForBooks(page, expected.slice(0, 12));
    assert.equal(await page.locator('#sort').inputValue(), 'author');
    pass('The 3D bookshelf follows author order and restores the selected sort after reloading');

    model.books.find(book => book.id === 'zed').tags.artist = ['Aaron'];
    await page.locator('[data-action="scan"]').click();
    await waitForBooks(page, ['zed', ...expected.filter(id => id !== 'zed')].slice(0, 12));
    assert.equal(await page.locator('#sort').inputValue(), 'author');
    assert.deepEqual(errors, []);
    pass('Refreshing the simulated library rebuilds the author cache and renders updated metadata without errors');
    await page.screenshot({ path: path.join(out, 'author-sort.png'), fullPage: true });
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify({ source: 'isolated fake library', checks, errors }, null, 2));
    console.log('Report: ' + path.join(out, 'checks.json'));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
