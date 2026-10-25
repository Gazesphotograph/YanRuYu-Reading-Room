'use strict';

// Real preload, databases and reader. Every image and data file is synthetic.
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, isWithin, sha256, electronExecutable } = require('./project/common.cjs');
const { build } = require('./project/build.cjs');
const { _electron } = require('./playwright-runtime.cjs');

async function main() {
  const packageArg = process.argv.find(argument => argument.startsWith('--package='));
  const current = process.argv.includes('--current');
  const packaged = current ? root : packageArg ? path.resolve(packageArg.slice(10)) : null;
  if (packaged && packaged !== root && (!isWithin(path.join(root, 'out'), packaged) || packaged === path.join(root, 'out'))) throw new Error('Only generated releases may be tested.');
  const reusable = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusable && (!isWithin(path.join(root, '.build'), reusable) || reusable === path.join(root, '.build'))) throw new Error('Invalid isolated staging directory.');
  const target = packaged ? { folder: packaged, app: path.join(packaged, 'resources', 'app') }
    : reusable ? { folder: reusable, app: path.join(reusable, 'resources', 'app') } : build();
  const executable = packaged ? path.join(packaged, 'exhentai-manga-manager.exe') : electronExecutable();
  const args = packaged ? [] : [target.app];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-phase3-desktop-'));
  const data = path.join(workspace, 'data'), library = path.join(workspace, 'library');
  fs.mkdirSync(data); fs.mkdirSync(library);
  const sharp = require(path.join(target.app, 'node_modules', 'sharp'));
  const originals = new Map();
  for (const [name, tone] of [['Birch original', 110], ['Birch copy', 110], ['Garden sketches', 175]]) {
    const folder = path.join(library, name); fs.mkdirSync(folder);
    for (let page = 1; page <= 4; page++) {
      const filename = path.join(folder, `${page}.png`);
      await sharp({ create: { width: 280, height: 400, channels: 3, background: { r: tone, g: 60 + page * 35, b: 155 } } }).png().toFile(filename);
      originals.set(filename, sha256(filename));
    }
  }
  fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({ library, loadOnStart: false,
    hideTitleBar: true, closeToTray: false, minimizeOnStart: true, minimizeToTray: true,
    autoCheckUpdates: false, imageExplorer: '', pageSize: 42 }));
  const env = { ...process.env, YANRUYU_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = []; let application, page;
  const pass = message => { checks.push(message); console.log('PASS ' + message); };
  const call = (channel, ...values) => page.evaluate(({ channel, values }) => window.ipcRenderer.invoke(channel, ...values), { channel, values });
  async function launch() {
    application = await _electron.launch({ executablePath: executable, args, cwd: target.folder, env, timeout: 45000 });
    page = await application.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('[data-action="organizer"]', { timeout: 30000 });
  }
  async function close() {
    if (!application) return;
    await page.evaluate(() => window.readingState?.flush()).catch(() => {});
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {}); application = null;
  }
  try {
    await launch();
    const books = await call('load-book-list', true); assert.equal(books.length, 3);
    await page.reload(); await page.waitForSelector('#room [data-book]');
    const a = books.find(book => path.basename(book.filepath) === 'Birch original');
    const b = books.find(book => path.basename(book.filepath) === 'Birch copy');
    assert.ok(a && b);

    await page.locator('[data-action="organizer"]').click();
    const organizer = page.locator('.library-organizer-dialog');
    await organizer.locator('.organizer-book-list input').first().waitFor();
    await organizer.locator('[data-organizer="select-results"]').click();
    await organizer.locator('[data-edit-mode]').selectOption('replace');
    await organizer.locator('[data-edit-values]').fill('Forest Studio');
    await organizer.locator('[data-organizer="preview-tags"]').click();
    await organizer.locator('[data-organizer="apply"]').waitFor();
    const beforeApply = await call('load-book-list', false);
    assert.ok(beforeApply.every(book => !(book.tags?.artist || []).includes('Forest Studio')));
    await organizer.locator('[data-organizer="apply"]').click();
    await page.waitForFunction(() => document.querySelector('.organizer-status')?.textContent.includes('整理已保存'));
    await organizer.locator('[data-organizer="close"]').click();
    const edited = await call('load-book-list', false);
    assert.ok(edited.every(book => book.tags.artist.includes('Forest Studio')));
    pass('Real organizer UI previews without writing, then applies author edits through the trusted preload');

    const alias = await call('local-search-command', { action: 'preview-alias', kind: 'author', canonical: 'Forest Studio', aliases: ['林间画室'] });
    assert.equal((await call('local-search-command', { action: 'status' })).aliases.length, 0);
    await call('local-search-command', { action: 'save-alias', token: alias.token });
    await page.reload(); await page.waitForSelector('#search');
    await page.locator('#search').fill('林间画室');
    await page.waitForFunction(() => document.querySelector('#results')?.textContent.includes('共 3 本'));
    pass('Confirmed local author aliases survive reload and work in the main bookshelf search');

    const text = await call('local-search-command', { action: 'preview-text', bookId: a.id, page: 2, text: 'The quiet garden bridge is surrounded by birch trees.', source: 'manual' });
    await call('local-search-command', { action: 'save-text', token: text.token });
    await page.waitForFunction(async () => (await window.ipcRenderer.invoke('local-search-command', { action: 'status' })).indexedPages === 1);
    await page.locator('[data-action="discovery"]').click();
    const discovery = page.locator('.discovery-dialog');
    await discovery.locator('input[name="query"]').fill('garden bridge');
    await discovery.locator('select[name="mode"]').selectOption('text');
    await discovery.locator('form[data-discovery-search] button[type="submit"]').click();
    await discovery.locator('[data-discovery-read-book]').click();
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent.startsWith('2 /'));
    await page.waitForFunction(() => document.querySelector('.reader-body img')?.naturalWidth > 0);
    await page.keyboard.press('Escape'); await page.waitForSelector('.reader', { state: 'detached' });
    pass('A local text hit opens the actual reader on its one-based page, with a decoded image');

    const duplicateReport = await call('organizer-duplicates');
    assert.ok(duplicateReport.groups.some(group => group.books.some(book => book.id === a.id) && group.books.some(book => book.id === b.id)));
    const merge = await call('organizer-preview-merge', { bookIds: [a.id, b.id], keeperId: a.id });
    const applied = await call('organizer-apply', merge.token);
    const mergedBooks = await call('load-book-list', false);
    assert.equal(mergedBooks.length, 3); assert.equal(mergedBooks.find(book => book.id === b.id).hiddenBook, true);
    await close(); await launch();
    await call('organizer-undo', applied.id);
    const restored = await call('load-book-list', false);
    assert.ok(restored.every(book => !book.hiddenBook));
    assert.equal((await call('load-reading-state')).progress[a.id].page, 2);
    pass('Duplicate preview, logical merge and undo after real application restart retain IDs, sources and reading progress');

    const health = await call('organizer-health'); assert.equal(health.present, 3); assert.equal(health.missing, 0);

    // Move two generated fixture folders out of the synthetic library. This
    // exercises real path checks and preload permissions without deleting pages.
    const held = [a, b].map((book, index) => ({ book, filepath: path.join(workspace, `held-book-${index}`) }));
    const moveFixture = (from, to) => {
      if (!isWithin(workspace, from) || !isWithin(workspace, to) || !isWithin(os.tmpdir(), workspace)
          || !path.basename(workspace).startsWith('yanruyu-phase3-desktop-')) throw new Error('Unexpected fixture move.');
      fs.renameSync(from, to);
    };
    for (const item of held) moveFixture(item.book.filepath, item.filepath);
    const missing = await call('organizer-health');
    assert.equal(missing.missing, 2);
    assert.ok(missing.issues.every(book => book.canRemove));
    const removal = await call('organizer-preview-remove-missing', { bookIds: held.map(item => item.book.id) });
    assert.equal(removal.kind, 'remove-missing'); assert.equal(removal.changed, 2);
    assert.equal((await call('load-book-list', false)).length, 3, 'Preparing deletion must not remove records');
    const removed = await call('organizer-apply', removal.token);
    const remaining = await call('load-book-list', false);
    assert.equal(remaining.length, 1);
    assert.ok(remaining.every(book => !held.some(item => item.book.id === book.id)));
    assert.equal((await call('load-reading-state')).progress[a.id].page, 2);
    for (const item of held) for (let pageNumber = 1; pageNumber <= 4; pageNumber++) {
      assert.equal(sha256(path.join(item.filepath, `${pageNumber}.png`)), originals.get(path.join(item.book.filepath, `${pageNumber}.png`)));
    }
    await close(); await launch();
    const removalHistory = (await call('organizer-history')).find(item => item.id === removed.id);
    assert.equal(removalHistory.kind, 'remove-missing'); assert.equal(removalHistory.canUndo, true);
    await call('organizer-undo', removed.id);
    const restoredRemoval = await call('load-book-list', false);
    for (const item of held) {
      const book = restoredRemoval.find(book => book.id === item.book.id);
      assert.ok(book); assert.equal(book.filepath, item.book.filepath);
      assert.equal(book.identityFingerprint, item.book.identityFingerprint);
      assert.deepEqual(book.tags.artist, ['Forest Studio']);
      moveFixture(item.filepath, item.book.filepath);
    }
    assert.equal(restoredRemoval.length, 3);
    assert.equal((await call('organizer-health')).present, 3);
    assert.equal((await call('load-reading-state')).progress[a.id].page, 2);
    pass('Missing-record deletion uses the real preload, preserves source pages and reading progress, and restores original identities after restart');

    const recommendation = await call('local-search-command', { action: 'recommend', bookId: a.id });
    assert.ok(recommendation.results.length > 0 && recommendation.results.every(item => item.reasons.length));
    for (const [filename, hash] of originals) assert.equal(sha256(filename), hash);
    assert.deepEqual(errors, []);
    pass('Health checks and explained recommendations work with real data, with all 12 source images unchanged and no renderer errors');
    const report = path.join(root, 'tools', '.artifacts', 'phase3-desktop'); fs.mkdirSync(report, { recursive: true });
    fs.writeFileSync(path.join(report, current ? 'current-checks.json' : packaged ? 'package-checks.json' : 'source-checks.json'), JSON.stringify({ checks, errors, runtime: current ? 'current compressed executable' : packaged ? 'packaged executable' : 'staged source', originalsVerified: originals.size }, null, 2));
  } finally {
    await close();
    if (!isWithin(os.tmpdir(), workspace) || !path.basename(workspace).startsWith('yanruyu-phase3-desktop-')) throw new Error('Unexpected test workspace.');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
