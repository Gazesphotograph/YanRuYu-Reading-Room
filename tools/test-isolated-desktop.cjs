'use strict';

// This test never reads the live installation's database, settings or profile.
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, isWithin, electronExecutable } = require('./project/common.cjs');
const { build } = require('./project/build.cjs');
const { _electron } = require('./playwright-runtime.cjs');

async function main() {
  const packageArgument = process.argv.find(argument => argument.startsWith('--package='));
  const packageFolder = packageArgument ? path.resolve(packageArgument.slice('--package='.length)) : null;
  if (packageFolder && (!isWithin(path.join(root, 'out'), packageFolder) || packageFolder === path.join(root, 'out'))) {
    throw new Error('Packaged smoke tests only accept a newly generated release below out/.');
  }
  const reusableBuild = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusableBuild && (!isWithin(path.join(root, '.build'), reusableBuild) || reusableBuild === path.join(root, '.build'))) {
    throw new Error('The reusable desktop test build must be a generated staging directory below .build/.');
  }
  const target = packageFolder
    ? { folder: packageFolder, app: path.join(packageFolder, 'resources', 'app') }
    : reusableBuild ? { folder: reusableBuild, app: path.join(reusableBuild, 'resources', 'app') } : build();
  const executable = packageFolder ? path.join(packageFolder, 'exhentai-manga-manager.exe') : electronExecutable();
  const args = packageFolder ? [] : [target.app];
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-desktop-check-'));
  const data = path.join(workspace, 'data');
  const library = path.join(workspace, 'library');
  const bookFolder = path.join(library, 'Neutral geometry test book');
  fs.mkdirSync(data, { recursive: true });
  fs.mkdirSync(bookFolder, { recursive: true });
  const sharp = require(path.join(target.app, 'node_modules', 'sharp'));
  for (let page = 1; page <= 4; page++) {
    await sharp({ create: { width: 320, height: 480, channels: 3, background: { r: 45 + page * 30, g: 100, b: 150 } } })
      .png().toFile(path.join(bookFolder, `${String(page).padStart(3, '0')}.png`));
  }
  fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({
    library, loadOnStart: false, hideTitleBar: true, closeToTray: false,
    minimizeToTray: true, minimizeOnStart: true, imageExplorer: '',
    autoCheckUpdates: false, pageSize: 42,
  }, null, 2));
  const env = { ...process.env, YANRUYU_DATA_DIR: data };
  delete env.ELECTRON_RUN_AS_NODE;
  const errors = [];
  const consoleErrors = [];
  const checks = [];
  let application;
  let page;
  const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
  const launch = () => _electron.launch({ executablePath: executable, args, cwd: target.folder, env, timeout: 45000 });
  const close = async () => {
    if (!application) return;
    // The handle refers only to this test's child process.
    await application.evaluate(({ app }) => app.quit()).catch(() => {});
    await application.close().catch(() => {});
    application = null;
  };
  try {
    application = await launch();
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.waitForSelector('#room', { state: 'attached', timeout: 30000 });
    const paths = await application.evaluate(({ app }) => ({ userData: app.getPath('userData'), sessionData: app.getPath('sessionData'), packaged: app.isPackaged }));
    assert.equal(paths.userData, path.join(data, '.reading-room'));
    assert.equal(paths.sessionData, path.join(data, '.reading-room'));
    assert.equal(paths.packaged, Boolean(packageFolder));
    const before = await page.evaluate(() => window.ipcRenderer.invoke('load-book-list', false));
    assert.deepEqual(before, []);
    pass('Real Electron and profile start with a separate empty database');

    const books = await page.evaluate(() => window.ipcRenderer.invoke('load-book-list', true));
    assert.equal(books.length, 1);
    assert.equal(path.resolve(books[0].filepath), bookFolder);
    assert.equal(books[0].pageCount, 4);
    assert.ok(isWithin(data, books[0].coverPath));
    assert.ok(fs.existsSync(path.join(data, 'database.sqlite')));
    assert.ok(fs.existsSync(path.join(data, 'metadata.sqlite')));
    pass('Real scan, SQLite and cover generation use only four neutral fixture pages');

    await page.reload();
    await page.waitForSelector('#room [data-book]', { state: 'attached' });
    await page.locator('[data-view="grid"]').click();
    await page.locator(`[data-book="${books[0].id}"]`).dblclick();
    await page.waitForFunction(() => document.querySelector('.reader-body img')?.naturalWidth > 0, {}, { timeout: 45000 });
    await page.locator('#page-slider').fill('2');
    await page.waitForFunction(() => document.querySelector('#reader-page')?.textContent.startsWith('2 /'), {}, { timeout: 20000 });
    await page.keyboard.press('Escape');
    await page.waitForSelector('.reader', { state: 'detached' });
    pass('Built renderer opens a real generated book and displays page two');

    await page.locator('[data-action="classic"]').click({ noWaitAfter: true });
    await page.waitForFunction(() => !document.querySelector('.shell') && document.querySelector('#app')?.children.length > 0, {}, { timeout: 30000 });
    await page.getByRole('button', { name: '返回 3D 阅览室', exact: true }).click({ noWaitAfter: true });
    await page.waitForSelector('#room [data-book]', { state: 'attached' });
    pass('Preserved custom classic manager and 3D return both load');

    await page.evaluate(() => localStorage.setItem('yanruyu-isolated-smoke-marker', 'retained'));
    await close();
    application = await launch();
    page = await application.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#room [data-book]', { state: 'attached', timeout: 30000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('yanruyu-isolated-smoke-marker')), 'retained');
    assert.equal((await page.evaluate(() => window.ipcRenderer.invoke('load-book-list', false))).length, 1);
    pass('Restart preserves only the isolated test library and profile');
    assert.deepEqual(errors, []);
    pass('No renderer JavaScript errors across reading, interface switching and restart');
  } catch (error) {
    if (page && !page.isClosed()) {
      fs.writeFileSync(path.join(workspace, 'failed-page.html'), await page.content().catch(() => 'unavailable'));
      await page.screenshot({ path: path.join(workspace, 'failed-page.png') }).catch(() => {});
    }
    if (consoleErrors.length) console.error('Renderer console:', consoleErrors);
    throw error;
  } finally {
    await close();
    const report = { at: new Date().toISOString(), kind: packageFolder ? 'packaged' : 'source-build', checks, errors, consoleErrors, isolatedData: data };
    fs.writeFileSync(path.join(workspace, 'checks.json'), JSON.stringify(report, null, 2));
    fs.mkdirSync(path.join(root, 'tools', '.artifacts', 'isolated-desktop'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tools', '.artifacts', 'isolated-desktop', packageFolder ? 'packaged-checks.json' : 'source-checks.json'), JSON.stringify(report, null, 2));
    console.log(`Isolated desktop report: ${path.join(root, 'tools', '.artifacts', 'isolated-desktop', packageFolder ? 'packaged-checks.json' : 'source-checks.json')}`);
    const resolved = path.resolve(workspace);
    if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('yanruyu-desktop-check-') || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Unsafe isolated desktop fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 6, retryDelay: 150 });
  }
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
