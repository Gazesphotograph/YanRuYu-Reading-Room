'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { _electron } = require('./playwright-runtime.cjs');
const { root, appSource, electronExecutable } = require('./project/common.cjs');

async function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-phase2-desktop-'));
  const data = path.join(workspace, 'data'), library = path.join(workspace, 'library');
  fs.mkdirSync(data); fs.mkdirSync(library);
  const originalPath = path.join(library, 'Neutral source'); fs.mkdirSync(originalPath);
  const sharp = require(path.join(appSource, 'node_modules', 'sharp'));
  for (let page = 1; page <= 3; page++) await sharp({ create: { width: 120, height: 180, channels: 3,
    background: { r: 40 + page * 30, g: 100, b: 140 } } }).png().toFile(path.join(originalPath, `${page}.png`));
  fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({ library, loadOnStart: false, hideTitleBar: true,
    closeToTray: false, minimizeOnStart: true, autoCheckUpdates: false, enabledLANBrowsing: false, imageExplorer: '' }));
  const env = { ...process.env, YANRUYU_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], errors = [], output = path.join(root, 'tools', '.artifacts', 'phase2-tasks-desktop');
  fs.mkdirSync(output, { recursive: true });
  const pass = value => { checks.push(value); console.log('PASS ' + value); };
  let application, page;
  const invoke = (channel, ...args) => page.evaluate(({ channel, args }) => window.ipcRenderer.invoke(channel, ...args), { channel, args });
  const waitTask = async id => {
    return page.evaluate(id => new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = async () => {
        try {
          const task = (await window.ipcRenderer.invoke('task-list')).find(item => item.id === id);
          if (task && !['queued', 'running', 'cancelling'].includes(task.status)) return resolve(task);
          if (Date.now() - started > 45000) return reject(Error('Task did not finish: ' + id));
          setTimeout(poll, 80);
        } catch (error) { reject(error); }
      }; poll();
    }), id);
  };
  try {
    application = await _electron.launch({ executablePath: electronExecutable(), args: [appSource], cwd: root, env, timeout: 45000 });
    page = await application.firstWindow(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
    await page.waitForSelector('#room', { state: 'attached' });
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(data, '.reading-room'));
    const first = await invoke('task-start', 'scan', { rebuild: false });
    assert(['queued', 'running'].includes(first.status));
    const done = await waitTask(first.id); assert.equal(done.status, 'completed');
    let books = await invoke('load-book-list', false); assert.equal(books.length, 1); const original = books[0];
    assert.equal(original.pageCount, 3); assert.match(original.sourceSignature, /^folder-stat-v1:/);
    pass('Real task IPC returns immediately, creates source signatures and scans neutral images into an isolated SQLite store.');

    await invoke('save-book', { ...original, mark: true, title: 'User title retained', readCount: 6 });
    await invoke('save-reading-progress', original.id, { page: 2, total: 3, time: Date.now() });
    await invoke('save-reading-preferences', original.id, { mode: 'double', direction: 'rtl', fit: 'width', zoom: 125, coverAlone: true });
    fs.copyFileSync(path.join(originalPath, '1.png'), path.join(originalPath, '4.png'));
    const changed = await invoke('task-start', 'scan', {}); await waitTask(changed.id);
    books = await invoke('load-book-list', false); const updated = books.find(book => book.id === original.id);
    assert.equal(updated.pageCount, 4); assert.equal(updated.title, 'User title retained'); assert.equal(updated.mark, true); assert.equal(updated.readCount, 6);
    const profile = await invoke('load-reading-state'); assert.equal(profile.progress[original.id].page, 2); assert.equal(profile.preferences[original.id].mode, 'double');
    pass('A same-path added page refreshes the cover/page count while preserving stable ID, user edits, reading progress and per-book preferences.');

    const staleSaved = await invoke('save-book', { ...original, mark: true, title: 'User title retained', readCount: 7 });
    assert.equal(staleSaved.coverPath, updated.coverPath); assert.equal(staleSaved.pageCount, 4); assert.equal(staleSaved.sourceSignature, updated.sourceSignature);
    const customCover = await invoke('use-new-cover', path.join(originalPath, '2.png'));
    const customSaved = await invoke('save-book', { ...staleSaved, coverPath: customCover });
    assert.equal(customSaved.coverPath, customCover); assert.equal(customSaved.pageCount, 4);
    pass('A stale reader save cannot restore a retired cover or old page count, while explicit custom cover selection still saves correctly.');

    for (let index = 0; index < 35; index++) {
      const folder = path.join(library, 'Neutral batch ' + String(index).padStart(3, '0')); fs.mkdirSync(folder);
      fs.copyFileSync(path.join(originalPath, '1.png'), path.join(folder, '1.png'));
      fs.copyFileSync(path.join(originalPath, '2.png'), path.join(folder, '2.png'));
    }
    const batch = await invoke('task-start', 'scan', {});
    const during = await invoke('load-book-list', false); assert(during.some(book => book.id === original.id));
    await invoke('save-reading-progress', original.id, { page: 3, total: 4, time: Date.now() });
    await invoke('task-cancel', batch.id); const cancelled = await waitTask(batch.id); assert.equal(cancelled.status, 'cancelled');
    const retried = await invoke('task-retry', batch.id); const resumed = await waitTask(retried.id); assert.equal(resumed.status, 'completed');
    assert.equal((await invoke('load-book-list', false)).length, 36);
    pass('Browsing and reading saves continue during a batch; cancellation and retry finish without duplicate book identities.');

    const zip = path.join(library, 'Neutral archive.zip');
    const zipped = spawnSync(path.join(root, 'resources', 'extraResources', '7z.exe'), ['a', '-tzip', zip, '1.png', '2.png'],
      { cwd: originalPath, windowsHide: true, encoding: 'utf8' });
    assert.equal(zipped.status, 0, zipped.stderr);
    fs.writeFileSync(path.join(library, 'Neutral damaged.zip'), 'deliberately invalid neutral archive');
    const damaged = await invoke('task-start', 'scan', {}); const partial = await waitTask(damaged.id);
    assert.equal(partial.status, 'completed-with-errors'); assert(partial.errors.some(error => error.filepath.endsWith('Neutral damaged.zip')));
    books = await invoke('load-book-list', false); const archive = books.find(book => book.filepath === zip); assert(archive);
    const images = await invoke('load-manga-image-list', archive, { backgroundProcessing: false }); assert.equal(images.length, 2);
    assert((await invoke('task-list')).some(task => task.kind === 'extract' && task.status === 'completed'));
    const cache = await invoke('image-cache-status'); assert(cache.usedBytes > 0); assert(cache.protectedBytes > 0);
    await invoke('release-sendimagelock');
    pass('A corrupt ZIP is reported without blocking a valid ZIP; real 7-Zip extraction appears as a task and has a protected cache lease.');

    const outside = path.join(workspace, 'temporarily-moved'); fs.renameSync(originalPath, outside);
    const missingScan = await invoke('task-start', 'scan', {}); await waitTask(missingScan.id);
    assert.equal((await invoke('load-book-list', false)).find(book => book.id === original.id).exist, false);
    const destination = path.join(library, 'Neutral relocated'); fs.renameSync(outside, destination);
    await application.evaluate(({ dialog }, target) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] }); }, destination);
    const relocated = await invoke('relocate-book', original.id); assert.equal(relocated.success, true); assert.equal(relocated.book.id, original.id);
    assert.equal(relocated.book.filepath, destination); assert.equal(relocated.book.mark, true);
    assert.equal((await invoke('load-reading-state')).progress[original.id].page, 3);
    pass('The real relocation dialog bridge verifies content, reconnects the missing book ID and keeps its reading archive.');
    await page.evaluate(() => window.YanruyuTasks.open());
    await page.waitForSelector('.task-center-dialog[open]'); await page.screenshot({ path: path.join(output, 'real-task-center.png') });
    assert.deepEqual(errors, []);
  } finally {
    if (application) {
      await application.evaluate(({ app }) => app.quit()).catch(() => {});
      await application.close().catch(() => {});
    }
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checks, errors, isolated: true }, null, 2));
    const resolved = path.resolve(workspace), intended = path.join(os.tmpdir(), 'yanruyu-phase2-desktop-');
    if (!resolved.startsWith(intended)) throw Error('Unsafe desktop fixture cleanup');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
