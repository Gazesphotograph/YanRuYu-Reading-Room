'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createShutdownGuard } = require('../resources/app/modules/shutdown_guard');
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const event = () => ({ defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } });

function runtime(options = {}) {
  let quitting = false;
  const errors = [];
  const window = { destroyed: false, enabled: true, closeCalls: 0,
    isDestroyed() { return this.destroyed; }, setEnabled(value) { this.enabled = value; },
    close() { this.closeCalls++; const e = event(); guard.windowClose(e, this); if (!e.defaultPrevented) this.destroyed = true; return e; } };
  const app = { exited: false, quitCalls: 0, relaunchCalls: 0,
    relaunch() { this.relaunchCalls++; }, quit() {
    this.quitCalls++;
    const e = event(); guard.beforeQuit(e);
    if (!e.defaultPrevented) { if (!window.destroyed) window.close(); this.exited = window.destroyed || options.noWindow; }
    return e;
  } };
  const guard = createShutdownGuard({ app, getWindow: () => options.noWindow ? null : window,
    setQuitting: value => { quitting = value; }, reportError: error => errors.push(error.message),
    flushRenderer: async () => ({ saved: true, readingProfile: true }), flushMain: async () => {}, ...options });
  return { app, window, guard, errors, isQuitting: () => quitting };
}

test('native close waits for renderer acknowledgement and main-process disk writes', async () => {
  const renderer = deferred(), disk = deferred();
  const order = [];
  const r = runtime({ flushRenderer: async () => { order.push('renderer'); await renderer.promise; return { saved: true, readingProfile: true }; },
    flushMain: async () => { order.push('main'); await disk.promise; } });
  assert.equal(r.window.close().defaultPrevented, true);
  await turn();
  assert.equal(r.window.destroyed, false);
  assert.equal(r.window.enabled, false);
  renderer.resolve(); await turn();
  assert.deepEqual(order, ['renderer', 'main']);
  assert.equal(r.window.destroyed, false);
  disk.resolve(); assert.equal(await r.guard.wait(), true);
  assert.equal(r.window.destroyed, true);
});

test('tray quit while native close is pending shares one flush and upgrades to application exit', async () => {
  const save = deferred(); let calls = 0;
  const r = runtime({ flushRenderer: async () => { calls++; await save.promise; return { saved: true }; } });
  r.window.close(); r.app.quit(); await turn();
  assert.equal(calls, 1);
  assert.equal(r.app.exited, false);
  assert.equal(r.isQuitting(), true);
  save.resolve(); await r.guard.wait();
  assert.equal(r.app.exited, true);
});

test('write failure cancels quit, reenables the window, and allows a successful retry', async () => {
  let failed = true;
  const r = runtime({ flushMain: async () => { if (failed) throw Error('synthetic disk failure'); } });
  r.app.quit(); assert.equal(await r.guard.wait(), false);
  assert.equal(r.app.exited, false);
  assert.equal(r.window.destroyed, false);
  assert.equal(r.window.enabled, true);
  assert.equal(r.isQuitting(), false);
  assert.match(r.errors[0], /synthetic disk failure/);
  failed = false; r.app.quit(); await r.guard.wait();
  assert.equal(r.app.exited, true);
});

test('a hung renderer has a bounded timeout and cannot close later after that timeout', async () => {
  const saved = deferred();
  const r = runtime({ timeoutMs: 15, flushRenderer: async () => { await saved.promise; return { saved: true }; } });
  r.app.quit(); assert.equal(await r.guard.wait(), false);
  assert.equal(r.window.enabled, true);
  assert.equal(r.app.exited, false);
  assert.match(r.errors[0], /超时/);
  saved.resolve(); await turn();
  assert.equal(r.app.exited, false, 'A late acknowledgement must not resurrect a cancelled quit');
});

test('startup tray exit without a first window remains immediate', () => {
  const r = runtime({ noWindow: true, flushRenderer: async () => { throw Error('Must not ask a nonexistent renderer'); },
    flushMain: async () => { throw Error('Must not wait for startup schema'); } });
  assert.equal(r.app.quit().defaultPrevented, false);
  assert.equal(r.app.exited, true);
  assert.equal(r.isQuitting(), true);
});

test('committed restore bypasses old renderer and store writes entirely', () => {
  const r = runtime({ bypass: () => true,
    flushRenderer: async () => { throw Error('Old renderer must not run'); }, flushMain: async () => { throw Error('Old store must not run'); } });
  assert.equal(r.app.quit().defaultPrevented, false);
  assert.equal(r.app.exited, true);
  assert.deepEqual(r.errors, []);
});

test('an invalid renderer receipt does not count as a completed save', async () => {
  const r = runtime({ flushRenderer: async () => undefined });
  r.window.close(); await r.guard.wait();
  assert.equal(r.window.destroyed, false);
  assert.match(r.errors[0], /保存确认/);
});

test('close-to-tray capture does not turn hiding into application exit', async () => {
  const r = runtime();
  await r.guard.hideToTray(r.window);
  assert.equal(r.app.quitCalls, 0);
  assert.equal(r.window.closeCalls, 0);
  assert.equal(r.isQuitting(), false);
});

test('relaunch is scheduled only after both renderer and main writes are acknowledged', async () => {
  const renderer = deferred(), disk = deferred();
  const r = runtime({ flushRenderer: async () => { await renderer.promise; return { saved: true }; },
    flushMain: async () => { await disk.promise; } });
  const restarted = r.guard.relaunch();
  await turn();
  assert.equal(r.app.relaunchCalls, 0);
  assert.equal(r.app.exited, false);
  renderer.resolve(); await turn();
  assert.equal(r.app.relaunchCalls, 0);
  disk.resolve(); assert.equal(await restarted, true);
  assert.equal(r.app.relaunchCalls, 1);
  assert.equal(r.app.exited, true);
});

test('failed restart never schedules a relaunch or contaminates a later ordinary exit', async () => {
  let failed = true;
  const r = runtime({ flushMain: async () => { if (failed) throw Error('synthetic pending save failed'); } });
  assert.equal(await r.guard.relaunch(), false);
  assert.equal(r.app.relaunchCalls, 0);
  assert.equal(r.app.quitCalls, 0);
  assert.equal(r.window.destroyed, false);
  assert.equal(r.window.enabled, true);
  failed = false;
  r.app.quit(); await r.guard.wait();
  assert.equal(r.app.exited, true);
  assert.equal(r.app.relaunchCalls, 0);
});

test('a repeated relaunch request shares its save and schedules only one restart', async () => {
  const disk = deferred(); let calls = 0;
  const r = runtime({ flushMain: async () => { calls++; await disk.promise; } });
  const first = r.guard.relaunch(), second = r.guard.relaunch();
  r.app.quit(); await turn();
  assert.equal(calls, 1);
  assert.equal(r.app.relaunchCalls, 0);
  disk.resolve(); await Promise.all([first, second]);
  assert.equal(r.app.relaunchCalls, 1);
  assert.equal(r.app.exited, true);
});
