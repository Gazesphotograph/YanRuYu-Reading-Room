'use strict';

// Real Electron close/quit regression. Every launched process is this test's
// child, with neutral generated images and a fresh, explicit data directory.
const assert = require('node:assert/strict');
const os = require('node:os');
const { fs, path, root, appSource, electronExecutable, isWithin } = require('./project/common.cjs');
const { _electron } = require('./playwright-runtime.cjs');

(async () => {
  const reusable = process.env.YANRUYU_TEST_BUILD && path.resolve(process.env.YANRUYU_TEST_BUILD);
  if (reusable && !isWithin(path.join(root, '.build'), reusable)) throw Error('Only an isolated generated test build may be reused');
  const target = reusable ? path.join(reusable, 'resources/app') : appSource;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-reading-shutdown-'));
  const data = path.join(workspace, 'data'), library = path.join(workspace, 'library');
  const folder = path.join(library, 'Neutral shutdown fixture');
  fs.mkdirSync(data, { recursive: true }); fs.mkdirSync(folder, { recursive: true });
  const sharp = require(path.join(target, 'node_modules/sharp'));
  for (let page = 1; page <= 6; page++) await sharp({ create: { width: 80, height: 120, channels: 3, background: { r: 30 + page * 20, g: 100, b: 150 } } }).png().toFile(path.join(folder, `${page}.png`));
  const env = { ...process.env, YANRUYU_DATA_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const checks = [], diagnostics = [];
  let application = null, page = null, id;
  const pass = message => { checks.push(message); console.log('PASS ' + message); };
  const stateOnDisk = () => JSON.parse(fs.readFileSync(path.join(data, 'reading-state.json'), 'utf8'));
  async function launch({ closeToTray = false, recovery = false } = {}) {
    fs.writeFileSync(path.join(data, 'setting.json'), JSON.stringify({ library, imageExplorer: '', hideTitleBar: true,
      minimizeOnStart: true, minimizeToTray: true, closeToTray, loadOnStart: false, autoCheckUpdates: false }));
    application = await _electron.launch({ executablePath: electronExecutable(), args: [target], cwd: path.dirname(target), env, timeout: 45000 });
    await application.evaluate(({ app, dialog }) => {
      app.__shutdownErrors = [];
      dialog.showErrorBox = (title, message) => app.__shutdownErrors.push({ title, message });
    });
    page = await application.firstWindow();
    page.on('pageerror', error => diagnostics.push(error.message));
    await page.waitForSelector(recovery ? '[data-recovery-mode]' : '#room', { state: 'attached', timeout: 30000 });
    assert.equal(await application.evaluate(({ app }) => app.getPath('userData')), path.join(data, '.reading-room'));
  }
  function waitForExit() {
    const child = application.process();
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('The isolated Electron child did not finish normal shutdown')), 15000);
      child.once('exit', code => { clearTimeout(timeout); resolve(code); });
    });
  }
  async function stageThenClose(number, quit) {
    return application.evaluate(async ({ app, BrowserWindow }, { id, number, quit }) => {
      const win = BrowserWindow.getAllWindows()[0];
      const staged = await win.webContents.executeJavaScript(`(() => {
        window.readingState.stage(${JSON.stringify(id)}, {page:${number},total:6,time:Date.now(),source:'room'});
        return {pending:window.readingState.pending.has(${JSON.stringify(id)}),timer:Boolean(window.readingState.timer)};
      })()`);
      // The close happens in the same main-process turn that receives the stage
      // result; it does not wait for the renderer's 160 ms persistence timer.
      if (quit) app.quit(); else win.close();
      return staged;
    }, { id, number, quit });
  }
  async function exited() { application = null; page = null; }
  try {
    await launch();
    const books = await page.evaluate(() => window.ipcRenderer.invoke('load-book-list', true));
    id = books[0].id;
    const firstExit = waitForExit();
    const firstStage = await stageThenClose(2, false);
    assert.deepEqual(firstStage, { pending: true, timer: true });
    assert.equal(await firstExit, 0); await exited();
    assert.equal(stateOnDisk().progress[id].page, 2);
    pass('Immediate native window close saves a pending page before the 160 ms timer');

    await launch({ closeToTray: true });
    assert.equal(await page.evaluate(id => window.readingState.get(id).page, id), 2);
    assert.equal(stateOnDisk().migrationSnapshots.length, 1);
    const trayExit = waitForExit();
    assert.deepEqual(await stageThenClose(3, true), { pending: true, timer: true });
    assert.equal(await trayExit, 0); await exited();
    assert.equal(stateOnDisk().progress[id].page, 3);
    pass('Tray-exit app.quit saves the new page and bypasses close-to-tray hiding');

    await launch({ closeToTray: true });
    await stageThenClose(4, false);
    await page.waitForFunction(async id => (await window.ipcRenderer.invoke('load-reading-state')).progress[id]?.page === 4, id);
    const hidden = await application.evaluate(({ BrowserWindow }) => ({ count: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible() }));
    assert.deepEqual(hidden, { count: 1, visible: false });
    assert.equal(stateOnDisk().progress[id].page, 4);
    pass('Closing to tray remains immediate, keeps the renderer alive, and flushes progress');
    const hiddenExit = waitForExit(); await application.evaluate(({ app }) => app.quit()); await hiddenExit; await exited();

    await launch();
    await page.evaluate(() => {
      window.__shutdownRealFlush = window.readingState.flush;
      window.readingState.flush = async () => { throw Error('synthetic shutdown save failure'); };
    });
    await stageThenClose(5, false);
    await page.waitForFunction(() => window.readingState.pending.size > 0);
    for (let attempt = 0; attempt < 100; attempt++) {
      if ((await application.evaluate(({ app }) => app.__shutdownErrors)).length) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const failed = await application.evaluate(({ app, BrowserWindow }) => ({ errors: app.__shutdownErrors,
      count: BrowserWindow.getAllWindows().length, visible: BrowserWindow.getAllWindows()[0].isVisible(), enabled: BrowserWindow.getAllWindows()[0].isEnabled() }));
    assert.equal(failed.count, 1); assert.equal(failed.visible, true); assert.equal(failed.enabled, true);
    assert.match(failed.errors[0]?.message || '', /synthetic shutdown save failure/);
    assert.equal(stateOnDisk().progress[id].page, 4);
    pass('Failed shutdown saving preserves and reenables the window with an explicit error');
    await page.evaluate(() => { window.readingState.flush = window.__shutdownRealFlush; });
    const retryExit = waitForExit();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await retryExit, 0); await exited();
    assert.equal(stateOnDisk().progress[id].page, 5);
    pass('Retrying native close persists the pending page and exits normally');

    await launch();
    const relaunchTrace = path.join(workspace, 'controlled-relaunch.jsonl');
    await application.evaluate(({ app, session }, { data, relaunchTrace, id }) => {
      const io = process.getBuiltinModule('fs'), paths = process.getBuiltinModule('path');
      // Replace only restart scheduling in this owned test process so no
      // untracked instance can be launched. Record the disk state at the exact
      // moment scheduling would have happened.
      app.relaunch = () => io.appendFileSync(relaunchTrace, JSON.stringify({
        page: JSON.parse(io.readFileSync(paths.join(data, 'reading-state.json'), 'utf8')).progress[id].page,
        settings: JSON.parse(io.readFileSync(paths.join(data, 'setting.json'), 'utf8'))
      }) + '\n');
      const setProxy = session.defaultSession.setProxy.bind(session.defaultSession);
      session.defaultSession.setProxy = async options => {
        await new Promise(resolve => setTimeout(resolve, 250));
        return setProxy(options);
      };
    }, { data, relaunchTrace, id });
    const restartExit = waitForExit();
    const pendingRestart = await page.evaluate(async id => {
      const previous = await window.ipcRenderer.invoke('load-setting');
      window.readingState.stage(id, { page: 6, total: 6, time: Date.now(), source: 'room' });
      let settingsDone = false;
      // Match the classic settings flow: trigger saving, then request restart
      // without awaiting the save-setting result.
      window.ipcRenderer.invoke('save-setting', { ...previous, hideTitleBar: false, pageSize: 37 })
        .then(() => { settingsDone = true; }).catch(error => { window.__restartSettingsError = error.message; });
      window.ipcRenderer.invoke('relaunch-app').catch(error => { window.__restartError = error.message; });
      return { readingPending: window.readingState.pending.has(id), settingsPending: !settingsDone };
    }, id);
    assert.deepEqual(pendingRestart, { readingPending: true, settingsPending: true });
    assert.equal(await restartExit, 0); await exited();
    const relaunches = fs.readFileSync(relaunchTrace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.equal(relaunches.length, 1);
    assert.equal(relaunches[0].page, 6);
    assert.equal(relaunches[0].settings.pageSize, 37);
    assert.equal(relaunches[0].settings.hideTitleBar, false);
    assert.equal(stateOnDisk().progress[id].page, 6);
    pass('Immediate relaunch IPC waits for both pending reading progress and unawaited settings writes before scheduling restart');

    fs.writeFileSync(path.join(data, 'reading-state.json'), 'synthetic damaged reading profile');
    await launch({ recovery: true });
    assert.equal(await page.evaluate(() => Boolean(window.readingState)), false);
    const recoveryExit = waitForExit();
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    assert.equal(await recoveryExit, 0); await exited();
    assert.equal(fs.readFileSync(path.join(data, 'reading-state.json'), 'utf8'), 'synthetic damaged reading profile');
    pass('A damaged startup profile can close without trying to save or overwriting its evidence');
    console.log(`${checks.length} real Electron shutdown checks passed`);
  } finally {
    if (application) {
      // Cleanup targets only this test's owned child, never the user's instance.
      await application.evaluate(({ app }) => app.exit(1)).catch(() => {});
      await application.close().catch(() => {});
    }
    const report = { at: new Date().toISOString(), checks, diagnostics, isolatedData: data };
    const output = path.join(root, 'tools/.artifacts/reading-shutdown'); fs.mkdirSync(output, { recursive: true });
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(report, null, 2));
    console.log('Isolated shutdown report: ' + path.join(output, 'checks.json'));
    if (!workspace.startsWith(path.join(os.tmpdir(), 'yanruyu-reading-shutdown-'))) throw Error('Unsafe fixture cleanup');
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
