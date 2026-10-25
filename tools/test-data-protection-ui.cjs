'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const { openManager } = require('./test-manager-glass.cjs');
const out = path.join(__dirname, '.artifacts/data-protection-ui');
fs.mkdirSync(out, { recursive: true });
const fixtures = createFixtures(path.join(out, 'fixtures'), 3, 5);
const report = { source: 'isolated browser, neutral covers and fake dialogs', checks: [], errors: [] };
const pass = message => { report.checks.push(message); console.log('PASS ' + message); };

function installBackupModel(model) {
  model.backupExportResult = { canceled: true };
  model.backupPreview = { path: 'E:\\synthetic\\neutral.yru-backup', token: 'preview-token',
    summary: { createdAt: '2026-09-13T08:00:00Z', appVersion: 'test-1', books: 3, metadata: 3,
      collections: 2, readingRecords: 1, covers: 3, includesCovers: true, bytes: 123456,
      libraryPath: 'E:\\Synthetic <script>never execute</script>' } };
  model.recoveryPoints = [
    { id: 'valid-point', filename: 'Neutral archive.cbz', originalPath: 'E:\\Synthetic\\Neutral archive.cbz', createdAt: Date.now(), size: 3000, removedEntry: '002.png', available: true },
    { id: 'invalid-point', filename: 'Unavailable archive.cbz', originalPath: 'E:\\Synthetic\\Unavailable archive.cbz', createdAt: Date.now(), size: 3000, available: false, error: '恢复文件校验不通过' },
  ];
  const base = model.invoke.bind(model);
  model.invoke = async function (channel, ...args) {
    if (['backup-export', 'backup-inspect', 'backup-restore', 'archive-recovery-list', 'archive-recovery-restore', 'data-protection-open-recovery'].includes(channel)) {
      this.calls.push({ channel, args: JSON.parse(JSON.stringify(args)) });
      if (channel === 'backup-export') {
        if (this.backupError) throw new Error(this.backupError);
        return this.backupExportResult;
      }
      if (channel === 'backup-inspect') { if (this.previewError) throw new Error(this.previewError); return this.backupPreview; }
      if (channel === 'backup-restore') { assert.equal(args[0], 'preview-token'); return { success: true, recoveryPath: 'E:\\Synthetic\\before-restore.yru-backup' }; }
      if (channel === 'archive-recovery-list') return this.recoveryPoints;
      if (channel === 'archive-recovery-restore') { assert.equal(args[0], 'valid-point'); return { success: true, restoredPath: this.recoveryPoints[0].originalPath }; }
      return true;
    }
    return base(channel, ...args);
  };
  return model;
}

async function roomContext(browser, options = {}) {
  const model = installBackupModel(createFakeModel(fixtures.books, fixtures.pages));
  if (options.uiState) model.uiState = options.uiState;
  const context = await browser.newContext({ viewport: { width: 1000, height: 850 } });
  await attachFakeIpc(context, model);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(appURL);
  await page.waitForSelector('#room [data-book]');
  return { model, context, page };
}

async function openPanel(page) {
  await page.locator('[data-action="settings"]').click();
  await page.getByRole('button', { name: '备份与恢复', exact: true }).click();
  await page.waitForSelector('.data-protection-dialog[open]');
}

async function main() {
  const browser = await chromium.launch(launchOptions());
  try {
    const { model, context, page } = await roomContext(browser);
    try {
      await openPanel(page);
      await page.locator('#backup-include-covers').uncheck();
      await page.getByRole('button', { name: '选择位置并创建备份' }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.textContent.includes('已取消'));
      assert.equal(model.calls.find(call => call.channel === 'backup-export').args[0].includeCovers, false);
      model.backupError = '模拟磁盘写入失败';
      await page.getByRole('button', { name: '选择位置并创建备份' }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.dataset.level === 'error');
      assert.match(await page.locator('#protection-status').innerText(), /模拟磁盘写入失败/);
      model.backupError = null; model.backupExportResult = { success: true, path: 'E:\\Synthetic\\backup.yru-backup' };
      await page.getByRole('button', { name: '选择位置并创建备份' }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.textContent.includes('完整备份已保存'));
      pass('Backup settings handle optional covers, cancellation, failure and confirmed save distinctly.');

      model.previewError = '模拟校验和不匹配';
      await page.getByRole('button', { name: '选择备份并预览' }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.dataset.level === 'error');
      assert.equal(await page.locator('[data-protection="restore"]').count(), 0);
      model.previewError = null;
      await page.getByRole('button', { name: '选择备份并预览' }).click();
      await page.waitForSelector('[data-protection="restore"]');
      assert.match(await page.locator('#backup-preview').innerText(), /3 \/ 3/);
      assert.match(await page.locator('#backup-preview').innerText(), /<script>never execute<\/script>/);
      assert.equal(await page.locator('#backup-preview script').count(), 0);
      assert.equal(model.calls.filter(call => call.channel === 'backup-restore').length, 0);
      pass('Invalid backups expose no restore action; validated preview shows counts and safely renders paths.');

      for (const width of [720, 1280]) {
        await page.setViewportSize({ width, height: 820 });
        const layout = await page.locator('.data-protection-dialog').evaluate(element => ({ left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right, scroll: element.scrollWidth, width: element.clientWidth, viewport: innerWidth }));
        assert(layout.left >= 0 && layout.right <= layout.viewport + 1 && layout.scroll <= layout.width + 1);
        await page.screenshot({ path: path.join(out, `backup-preview-${width}.png`) });
      }
      pass('Backup preview remains readable without horizontal overflow at 720 and 1280 pixels.');

      await page.getByRole('button', { name: '查看可恢复版本' }).click();
      await page.waitForSelector('[data-point-id="valid-point"]');
      assert(await page.locator('[data-point-id="invalid-point"]').isDisabled());
      await page.locator('[data-point-id="valid-point"]').click();
      assert.equal(model.calls.filter(call => call.channel === 'archive-recovery-restore').length, 0);
      await page.getByRole('button', { name: '确认恢复此版本', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.textContent.includes('压缩包已恢复'));
      assert.equal(model.calls.filter(call => call.channel === 'archive-recovery-restore').length, 1);
      pass('Archive versions require a concrete confirmation; damaged recovery points remain disabled.');

      await page.getByRole('button', { name: '确认恢复并重新启动', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#protection-status')?.textContent.includes('恢复完成'));
      assert.equal(model.calls.filter(call => call.channel === 'backup-restore').length, 1);
      assert(model.calls.some(call => call.channel === 'save-ui-state'));
      pass('Restore uses the preview token and saves portable preferences before replacing data.');
    } finally { await context.close(); }

    const hydrated = await roomContext(browser, { uiState: { schemaVersion: 1, restoreToken: 'fixture-restore',
      values: { 'room-theme': '"forest"', 'room-sort': '"author"', 'room-view': '"grid"' } } });
    try {
      assert.equal(await hydrated.page.evaluate(() => localStorage.getItem('yanruyu-restored-backup-id')), 'fixture-restore');
      assert.equal(await hydrated.page.evaluate(() => JSON.parse(localStorage.getItem('room-sort'))), 'author');
      assert.equal(await hydrated.page.locator('html').getAttribute('data-room-theme'), 'forest');
      pass('Restored preferences hydrate before the initial theme and library view are rendered.');
    } finally { await hydrated.context.close(); }

    const classic = await openManager(browser, fixtures);
    try {
      installBackupModel(classic.model);
      await classic.page.getByRole('button', { name: '备份与恢复', exact: true }).click();
      await classic.page.waitForSelector('.data-protection-dialog[open]');
      await classic.page.getByRole('button', { name: '选择备份并预览' }).click();
      await classic.page.waitForSelector('[data-protection="restore"]');
      await classic.page.screenshot({ path: path.join(out, 'classic-backup-preview.png') });
      pass('The shipped classic manager exposes the same backup and recovery panel.');
    } finally { await classic.context.close(); }
    assert.deepEqual(report.errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(report, null, 2));
  }
}

main().catch(error => { report.errors.push(error.stack || String(error)); fs.writeFileSync(path.join(out, 'checks.json'), JSON.stringify(report, null, 2)); console.error(error); process.exitCode = 1; });
