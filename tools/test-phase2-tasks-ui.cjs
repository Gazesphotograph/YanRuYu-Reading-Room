'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const { openManager } = require('./test-manager-glass.cjs');
const output = path.join(__dirname, '.artifacts', 'phase2-tasks-ui');
fs.mkdirSync(output, { recursive: true });
const fixtures = createFixtures(path.join(output, 'fixtures'), 3, 4);
const checks = [], errors = [];
const pass = message => { checks.push(message); console.log('PASS ' + message); };

function tasksModel(model) {
  model.tasks = [{ id: 'scan-one', kind: 'scan', title: '中性书库扫描', status: 'running', phase: 'cover', current: 2, total: 8,
    progress: .25, createdAt: Date.now(), filepath: 'E:\\Synthetic\\<script>window.taskInjected=1</script>', message: '正在生成封面', errors: [], canCancel: true },
  { id: 'extract-failed', kind: 'extract', title: '准备阅读', status: 'failed', current: 0, total: 1, createdAt: Date.now() - 1,
    message: '模拟压缩包损坏', errors: [{ filepath: 'E:\\Synthetic\\Neutral.zip', message: '<img src=x onerror="window.taskInjected=1">' }], errorCount: 1, canRetry: true }];
  const original = model.invoke.bind(model);
  model.invoke = async function (channel, ...args) {
    if (channel.startsWith('task-')) {
      this.calls.push({ channel, args });
      if (this.taskError) throw Error(this.taskError);
      if (channel === 'task-list') return JSON.parse(JSON.stringify(this.tasks));
      if (channel === 'task-start') {
        const task = { id: 'new-' + this.tasks.length, kind: args[0], title: '新增任务', status: 'queued', createdAt: Date.now(), errors: [], canCancel: true };
        this.tasks.unshift(task); return task;
      }
      const task = this.tasks.find(item => item.id === args[0]);
      if (channel === 'task-cancel') { task.status = 'cancelled'; task.canCancel = false; task.canRetry = true; task.message = '已取消'; return task; }
      if (channel === 'task-retry') { task.status = 'queued'; task.canCancel = true; task.canRetry = false; return task; }
      if (channel === 'task-dismiss') { this.tasks = this.tasks.filter(item => item.id !== args[0]); return true; }
    }
    return original(channel, ...args);
  };
  return model;
}

async function main() {
  const browser = await chromium.launch(launchOptions());
  try {
    const model = tasksModel(createFakeModel(fixtures.books, fixtures.pages));
    const context = await browser.newContext({ viewport: { width: 1080, height: 800 } });
    await attachFakeIpc(context, model);
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(appURL); await page.waitForSelector('#room [data-book]');
    await page.locator('[data-action="tasks"]').click(); await page.waitForSelector('.task-center-dialog[open]');
    assert.equal(await page.locator('.task-center-item progress').getAttribute('value'), '0.25');
    await page.locator('[data-task-details="extract-failed"] summary').click();
    assert.match(await page.locator('[data-task-details="extract-failed"]').innerText(), /onerror/);
    assert.equal(await page.evaluate(() => window.taskInjected), undefined);
    assert.equal(await page.locator('.task-center-list script,.task-center-list img').count(), 0);
    pass('Task progress and failed-item details render safely without interpreting filenames or errors as HTML.');
    await page.locator('[data-task-id="scan-one"][data-task-action="cancel"]').click();
    await page.waitForSelector('[data-task-id="scan-one"][data-task-action="retry"]');
    assert.equal(model.tasks.find(task => task.id === 'scan-one').status, 'cancelled');
    await page.locator('[data-task-id="scan-one"][data-task-action="retry"]').click();
    await page.waitForSelector('[data-task-id="scan-one"][data-task-action="cancel"]');
    assert.equal(model.tasks.find(task => task.id === 'scan-one').status, 'queued');
    pass('Cancel and retry reach the task service and update the visible available actions.');
    await page.locator('[data-task-id="extract-failed"][data-task-action="dismiss"]').click();
    await page.waitForSelector('[data-task-id="extract-failed"]', { state: 'detached' });
    await page.getByRole('button', { name: '刷新本地页数与封面', exact: true }).click();
    assert(model.calls.some(call => call.channel === 'task-start' && call.args[0] === 'metadata'));
    pass('Completed task records can be removed and metadata refresh can be queued from the same panel.');
    for (const width of [380, 760, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.locator('.task-center-dialog').evaluate(element => ({ left: element.getBoundingClientRect().left,
        right: element.getBoundingClientRect().right, width: element.clientWidth, scroll: element.scrollWidth, viewport: innerWidth }));
      assert(layout.left >= 0 && layout.right <= layout.viewport + 1 && layout.scroll <= layout.width + 1, JSON.stringify(layout));
    }
    await page.screenshot({ path: path.join(output, 'task-center.png') });
    await page.keyboard.press('Escape'); await page.waitForSelector('.task-center-dialog', { state: 'detached' });
    pass('The task panel stays within narrow and wide windows and closes with Escape.');
    model.taskError = '模拟任务历史读取失败';
    await page.reload(); await page.waitForSelector('#room [data-book]');
    await page.locator('[data-action="tasks"]').click();
    await page.waitForFunction(() => document.querySelector('.task-center-status')?.textContent.includes('模拟任务历史'));
    pass('Task-history failure is visible inside the panel and does not prevent library startup.');
    await context.close();
    const classic = await openManager(browser, fixtures);
    try {
      tasksModel(classic.model);
      await classic.page.locator('.manager-task-center').click();
      await classic.page.waitForSelector('.task-center-dialog[open]');
      assert.equal(await classic.page.locator('.task-center-item').count(), 2);
      pass('The classic manager exposes the same task center.');
    } finally { await classic.context.close(); }
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify({ checks, errors }, null, 2));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
