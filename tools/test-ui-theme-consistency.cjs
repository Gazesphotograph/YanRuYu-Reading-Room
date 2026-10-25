'use strict';

// End-to-end checks for the reported theme and short-window regressions. The
// production renderer runs in a fresh browser with neutral covers and memory
// IPC only. This file never opens the live app, its database or a real library.
// Usage: node tools/test-ui-theme-consistency.cjs [--screenshots]
//        [--case=themes,glass-panels,room-layout,dialog-layout,manager-layout]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const { openManager, settleVisuals } = require('./test-manager-glass.cjs');

const output = path.resolve(process.env.UI_THEME_TEST_OUTPUT || path.join(__dirname, '.artifacts', 'ui-theme-consistency'));
const selected = new Set((process.argv.find(arg => arg.startsWith('--case=')) || '').slice(7).split(',').filter(Boolean));
const saveScreenshots = process.argv.includes('--screenshots');
const themes = ['paper', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid', 'glass'];
const report = { date: new Date().toISOString(), source: 'isolated neutral library; memory IPC only', checks: [], failures: [], screenshots: [], errors: [] };
let activeCase = '';
const pass = (name, details) => { report.checks.push({ case: activeCase, name, details }); console.log('PASS ' + name); };

function uiModel(model) {
  const original = model.invoke.bind(model);
  model.tasks = Array.from({ length: 14 }, (_, index) => ({
    id: 'neutral-task-' + index, kind: 'scan', title: index === 0 ? '中性书库扫描 · ' + '静物与光影的长标题检查 '.repeat(5) : '中性书库扫描 ' + (index + 1),
    status: index === 0 ? 'running' : 'completed', createdAt: Date.UTC(2026, 8, 13, 12) - index * 1000,
    phase: 'cover', current: 3, total: 12, progress: .25, message: index === 0 ? '正在整理模拟封面' : '已完成',
    filepath: model.books[index % model.books.length].filepath, errors: [], canCancel: index === 0,
    result: index === 0 ? null : { added: 0, updated: 12, unchanged: 3, relocated: 0 },
  }));
  model.invoke = async function(channel, ...args) {
    if (channel === 'organizer-catalog') {
      this.calls.push({ channel, args });
      return { books: this.books.map(book => ({ ...book, originalTitle: book.title })), maxBatch: 2000 };
    }
    if (channel === 'local-search-command') {
      this.calls.push({ channel, args });
      if (args[0]?.action === 'ocr-capability') return { available: false, languages: [], reason: '隔离预览使用手动文本' };
      return { aliases: [], texts: [], indexedPages: 0, savedPages: 0, pendingPages: 0, textBytes: 0, estimatedIndexBytes: 0, buildMilliseconds: 0, paused: false };
    }
    return original(channel, ...args);
  };
  return model;
}

async function withRoom(browser, fixtures, callback) {
  const context = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
  const model = uiModel(createFakeModel(fixtures.books, fixtures.pages));
  await context.route(/^https?:/, route => route.abort());
  await attachFakeIpc(context, model);
  await context.addInitScript(() => {
    if (localStorage.getItem('room-theme') === null) localStorage.setItem('room-theme', JSON.stringify('glass'));
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push({ case: activeCase, error: error.message }));
  try {
    await page.goto(appURL);
    await page.locator('#room [data-book]').first().waitFor();
    await page.waitForFunction(() => document.querySelector('.scene-viewport')?.dataset.sceneState === 'ready', null, { timeout: 30000 });
    await settleVisuals(page);
    await callback(page, model);
  } catch (error) {
    await page.screenshot({ path: path.join(output, activeCase + '-failure.png') }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

async function screenshot(page, name) {
  if (!saveScreenshots) return;
  await settleVisuals(page);
  const filename = path.join(output, name + '.png');
  await page.screenshot({ path: filename });
  report.screenshots.push(filename);
}

async function theme(page, id, manager = false) {
  await page.locator(manager ? '[data-manager-theme-open]' : '.appearance-button').click();
  await page.locator(`${manager ? '.manager-appearance' : '#modal-root'} [data-theme-choice="${id}"]`).click();
  await page.waitForFunction(id => document.documentElement.dataset.roomTheme === id, id);
  await page.keyboard.press('Escape');
  await page.locator(manager ? '.setting-dialog' : '#modal-root .modal').waitFor({ state: 'hidden' });
  await settleVisuals(page);
}

const panels = [
  { name: 'tasks', trigger: '[data-action="tasks"]', selector: '.task-center-dialog', ready: '.task-center-item', close: '[data-task-action="close"]' },
  { name: 'organizer', trigger: '[data-action="organizer"]', selector: '.library-organizer-dialog', ready: '.organizer-book', close: '[data-organizer="close"]' },
  { name: 'discovery', trigger: '[data-action="discovery"]', selector: '.discovery-dialog', ready: '[data-discovery-search]', close: '[data-discovery-close]' },
  { name: 'personalization', trigger: '[data-action="personalization"]', selector: '.modal:has(#room-personalization)', ready: '[data-personal-layout]', close: '[data-action="dismiss"]' },
  { name: 'settings', trigger: '[data-action="settings"]', selector: '.modal:has(#setting-view)', ready: '#cache-budget', close: '[data-action="dismiss"]' },
];

async function openPanel(page, descriptor) {
  await page.locator(descriptor.trigger).first().click();
  const panel = page.locator(descriptor.selector);
  await panel.waitFor();
  await panel.locator(descriptor.ready).first().waitFor();
  await settleVisuals(page);
  return panel;
}

async function paint(panel) {
  return panel.evaluate(element => {
    const rgba = color => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    const probe = document.createElement('span'); probe.style.color = 'var(--ink)'; document.body.append(probe);
    const expectedInk = getComputedStyle(probe).color; probe.remove();
    const style = getComputedStyle(element), before = getComputedStyle(element, '::before'), after = getComputedStyle(element, '::after');
    const title = element.querySelector('h2');
    const bounds = element.getBoundingClientRect();
    return {
      expectedInk, color: style.color, titleColor: title && getComputedStyle(title).color,
      background: style.backgroundColor, fill: style.backgroundImage, alpha: rgba(style.backgroundColor)[3] / 255,
      radius: style.borderRadius, filter: style.filter,
      backdrop: [style.backdropFilter, before.backdropFilter, after.backdropFilter].filter(value => value && value !== 'none'),
      foregroundFilter: title && getComputedStyle(title).filter,
      areaFraction: bounds.width * bounds.height / (innerWidth * innerHeight),
    };
  });
}

async function themesCheck(browser, fixtures) {
  await withRoom(browser, fixtures, async page => {
    const signatures = new Set();
    for (const id of themes) {
      await theme(page, id);
      const surfaces = [];
      for (const descriptor of panels) {
        const panel = await openPanel(page, descriptor);
        const state = await paint(panel);
        assert.equal(state.color, state.expectedInk, `${id} ${descriptor.name}: dialog text ignores the active theme`);
        assert.equal(state.titleColor, state.expectedInk, `${id} ${descriptor.name}: heading ignores the active theme`);
        assert.equal(state.filter, 'none', `${id} ${descriptor.name}: background effect also distorts dialog contents`);
        assert.equal(state.foregroundFilter, 'none', `${id} ${descriptor.name}: heading is optically distorted`);
        if (id === 'glass') {
          assert(state.alpha < .99, `${descriptor.name}: large glass panel has an opaque background`);
          assert(state.backdrop.some(value => /blur\(|url\(/.test(value)), `${descriptor.name}: large panel lacks a glass backdrop`);
          assert(state.areaFraction > .1, `${descriptor.name}: glass only covers a small control, not the main panel`);
          await screenshot(page, `glass-${descriptor.name}-desktop`);
        }
        if (id === 'forest' && ['tasks', 'organizer', 'personalization'].includes(descriptor.name)) await screenshot(page, `${id}-${descriptor.name}-desktop`);
        surfaces.push({ name: descriptor.name, ...state });
        await panel.locator(descriptor.close).first().click();
        await panel.waitFor({ state: 'detached' });
      }
      signatures.add(surfaces[0].color + surfaces[0].background + surfaces[0].fill);
      pass(`${id}: all five panels follow the selected theme and keep their foreground sharp`, surfaces);
    }
    assert.equal(signatures.size, themes.length, 'Task center collapses distinct themes to the same surface palette');
  });
}

async function stripeContrast(page, buffer) {
  return page.evaluate(async encoded => {
    const source = new Image(); source.src = 'data:image/png;base64,' + encoded; await source.decode();
    const canvas = document.createElement('canvas'); canvas.width = source.width; canvas.height = source.height;
    const ctx = canvas.getContext('2d'); ctx.drawImage(source, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let contrast = 0, rows = 0;
    // Measure horizontal high-frequency contrast away from rounded rims. Each
    // row has its own mean, so the production vertical sheen does not count.
    for (let y = Math.floor(canvas.height * .3); y < canvas.height * .7; y += 4) {
      const luminance = [];
      for (let x = Math.floor(canvas.width * .25); x < canvas.width * .75; x++) {
        const offset = (y * canvas.width + x) * 4;
        luminance.push((data[offset] + data[offset + 1] + data[offset + 2]) / 3);
      }
      const mean = luminance.reduce((sum, value) => sum + value, 0) / luminance.length;
      contrast += Math.sqrt(luminance.reduce((sum, value) => sum + (value - mean) ** 2, 0) / luminance.length); rows++;
    }
    return contrast / rows;
  }, buffer.toString('base64'));
}

async function glassPanelsCheck(browser, fixtures) {
  await withRoom(browser, fixtures, async page => {
    for (const descriptor of panels) {
      const panel = await openPanel(page, descriptor);
      await page.evaluate(() => {
        const backdrop = document.createElement('div'); backdrop.id = 'large-glass-stripes';
        backdrop.style.cssText = 'position:fixed;inset:0;z-index:35;pointer-events:none;background:repeating-linear-gradient(90deg,#43546a 0 18px,#eef5fa 18px 36px);';
        document.body.append(backdrop);
      });
      await panel.evaluate(element => {
        // Keep the real registered glass panel, but give each material probe
        // identical bounds and conceal content while measuring its backdrop.
        element.style.cssText += ';width:720px;height:480px;min-height:480px;max-width:none;max-height:none;overflow:hidden;';
        for (const child of element.children) child.style.visibility = 'hidden';
      });
      await settleVisuals(page);
      const on = await panel.screenshot({ animations: 'disabled' });
      await panel.evaluate(element => element.style.setProperty('backdrop-filter', 'none', 'important'));
      const off = await panel.screenshot({ animations: 'disabled' });
      await panel.evaluate(element => element.style.removeProperty('backdrop-filter'));
      const measured = { filtered: await stripeContrast(page, on), unfiltered: await stripeContrast(page, off) };
      assert(measured.unfiltered > 8, `${descriptor.name}: stripe probe has no visible background signal`);
      assert(measured.filtered < measured.unfiltered * .35,
        `${descriptor.name}: a backdrop ancestor prevents the large panel from blurring its actual background: ${JSON.stringify(measured)}`);
      if (saveScreenshots) {
        for (const [name, buffer] of [['filtered', on], ['unfiltered', off]]) {
          const filename = path.join(output, `glass-${descriptor.name}-stripe-${name}.png`);
          fs.writeFileSync(filename, buffer); report.screenshots.push(filename);
        }
      }
      pass(`${descriptor.name}: pixels prove the full glass panel blurs the real background`, measured);
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
      await page.locator('#large-glass-stripes').evaluate(element => element.remove());
    }
  });
}

async function hitState(locator) {
  return locator.evaluate(element => {
    const r = element.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, hit: hit === element || element.contains(hit) };
  });
}

function assertVisibleHit(bounds, name) {
  assert(bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.top >= -1
    && bounds.right <= bounds.viewportWidth + 1 && bounds.bottom <= bounds.viewportHeight + 1 && bounds.hit,
  `${name} is clipped or covered: ${JSON.stringify(bounds)}`);
}

async function checkIcons(page, selector, label) {
  const result = await page.locator(selector).evaluateAll(elements => elements.filter(element => {
    const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  }).map(element => {
    const r = element.getBoundingClientRect(), svg = element.querySelector('svg'), icon = svg?.getBoundingClientRect();
    return { name: element.getAttribute('aria-label') || element.textContent.trim(), hasSvg: !!svg,
      dx: icon ? Math.abs((icon.left + icon.right - r.left - r.right) / 2) : null,
      dy: icon ? Math.abs((icon.top + icon.bottom - r.top - r.bottom) / 2) : null };
  }));
  assert(result.length, label + ': no visible icon controls were tested');
  assert(result.every(item => item.hasSvg && item.dx <= 1 && item.dy <= 1), `${label}: icon is off-centre: ${JSON.stringify(result)}`);
  return result;
}

async function roomLayoutCheck(browser, fixtures) {
  await withRoom(browser, fixtures, async page => {
    for (const id of ['glass', 'paper', 'forest']) {
      await theme(page, id);
      for (const viewport of [{ width: 1560, height: 760 }, { width: 1280, height: 560 }, { width: 950, height: 520 }, { width: 720, height: 480 }, { width: 420, height: 640 }]) {
        await page.setViewportSize(viewport); await settleVisuals(page);
        const before = await page.locator('.topbar').boundingBox();
        const scrolled = await page.locator('.content').evaluate(element => {
          element.scrollTop = element.scrollHeight;
          return { scroll: element.scrollTop, available: element.scrollHeight - element.clientHeight };
        });
        await settleVisuals(page);
        const after = await page.locator('.topbar').boundingBox();
        assert(scrolled.scroll > 0, `${id} ${viewport.width}x${viewport.height}: content has no working independent scroll area`);
        assert(Math.abs(after.y - before.y) <= 1 && after.y >= 0 && after.y + after.height <= viewport.height,
          `${id}: scrolling pushes the topbar out of the short window: ${JSON.stringify({ before, after, scrolled })}`);
        assert.equal(await page.evaluate(() => window.scrollY), 0, 'The whole window scrolls instead of the library content');
        assertVisibleHit(await hitState(page.locator('.appearance-button')), 'Fixed appearance button');
        assertVisibleHit(await hitState(page.locator('[data-action="maximize"]')), 'Fixed window controls');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Room overflows horizontally');
        const sidebar = await page.locator('.sidebar').evaluate(element => {
          const browser = element.querySelector('.tag-browser').getBoundingClientRect();
          const list = element.querySelector('.tag-list').getBoundingClientRect();
          const navigation = element.querySelector('.nav-label').getBoundingClientRect();
          return { visible: list.height > 0, listBottom: list.bottom, browserBottom: browser.bottom, navigationTop: navigation.top };
        });
        assert(!sidebar.visible || (sidebar.listBottom <= sidebar.browserBottom + 1 && sidebar.listBottom <= sidebar.navigationTop + 1),
          `Short-window tags overlap the sidebar navigation: ${JSON.stringify(sidebar)}`);
        const icons = await checkIcons(page, '.scene-controls button, .window-controls button, .view-toggle button, .pagination > button', 'Room controls');
        await page.locator('[data-scene-camera="left"]').hover();
        await settleVisuals(page);
        await checkIcons(page, '.scene-controls button', 'Hovered scene controls');
        const footer = await page.locator('.pagination').evaluate(element => {
          const controls = [...element.querySelectorAll('button,input,span')].filter(node => node.getBoundingClientRect().height > 0);
          const centres = controls.map(node => { const r = node.getBoundingClientRect(); return (r.top + r.bottom) / 2; });
          return { spread: Math.max(...centres) - Math.min(...centres), width: element.clientWidth, scroll: element.scrollWidth };
        });
        assert(footer.spread <= 1.5 && footer.scroll <= footer.width + 1, `Pagination is misaligned or clipped: ${JSON.stringify(footer)}`);
        if (id === 'glass') await screenshot(page, `glass-room-${viewport.width}x${viewport.height}-scrolled`);
        const settings = page.locator('.sidebar [data-action="settings"]');
        await settings.scrollIntoViewIfNeeded(); assertVisibleHit(await hitState(settings), 'Sidebar settings after independent scrolling');
        await page.locator('.sidebar').evaluate(element => { element.scrollTop = 0; });
        pass(`${id} room ${viewport.width}x${viewport.height}: topbar stays visible, icons stay centred and pagination aligns`, { scrolled, sidebar, footer, icons });
      }
    }
  });
}

async function dialogLayoutCheck(browser, fixtures) {
  await withRoom(browser, fixtures, async page => {
    for (const viewport of [{ width: 1280, height: 560 }, { width: 760, height: 500 }, { width: 420, height: 620 }]) {
      await page.setViewportSize(viewport);
      for (const descriptor of panels) {
        const panel = await openPanel(page, descriptor);
        if (descriptor.name === 'discovery') await panel.locator('[data-discovery-tab="text"]').click();
        await settleVisuals(page);
        const close = panel.locator(descriptor.close).first(), before = await close.boundingBox();
        const geometry = await panel.evaluate(element => {
          const bounds = element.getBoundingClientRect(), scrolled = [];
          for (const node of [element, ...element.querySelectorAll('*')]) {
            if (/^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) continue;
            if (node.scrollHeight > node.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
              node.scrollTop = node.scrollHeight;
              scrolled.push({ class: node.className, scroll: node.scrollTop });
            }
          }
          return { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.bottom,
            width: element.clientWidth, scrollWidth: element.scrollWidth, scrolled };
        });
        await settleVisuals(page);
        assert(geometry.scrolled.some(item => item.scroll > 0), `${descriptor.name}: the overflowing body cannot be scrolled`);
        assert(geometry.left >= -1 && geometry.top >= -1 && geometry.right <= viewport.width + 1 && geometry.bottom <= viewport.height + 1
          && geometry.scrollWidth <= geometry.width + 1, `${descriptor.name}: dialog clips outside the viewport: ${JSON.stringify(geometry)}`);
        const after = await hitState(close);
        assertVisibleHit(after, `${descriptor.name}: close after scrolling`);
        assert(Math.abs(after.top - before.y) <= 1, `${descriptor.name}: scrolling also moves the close control`);
        await checkIcons(page, `${descriptor.selector} ${descriptor.close}`, `${descriptor.name} close control`);
        await screenshot(page, `glass-${descriptor.name}-${viewport.width}x${viewport.height}-scrolled`);
        pass(`${descriptor.name} ${viewport.width}x${viewport.height}: scrollable contents keep the close control visible`, geometry);
        await close.click(); await panel.waitFor({ state: 'detached' });
      }
    }
  });
}

async function managerLayoutCheck(browser, fixtures) {
  const { page, context, model } = await openManager(browser, fixtures);
  uiModel(model);
  page.on('pageerror', error => report.errors.push({ case: activeCase, error: error.message }));
  try {
    for (const id of ['glass', 'paper', 'forest']) {
      await theme(page, id, true);
      for (const viewport of [{ width: 1560, height: 760 }, { width: 1280, height: 560 }, { width: 950, height: 520 }, { width: 720, height: 480 }]) {
        await page.setViewportSize(viewport); await settleVisuals(page);
        const before = await page.locator('.app-toolbar').boundingBox();
        const scroll = await page.locator('.book-card-area').evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollTop; });
        assert(scroll > 0, 'Manager library must actually scroll before checking its fixed toolbar');
        const state = await page.evaluate(() => {
          const box = element => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          const visible = element => { const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
          const intersects = (a, b) => Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1;
          const dock = [...document.querySelectorAll('.manager-room-return')].filter(visible).map(element => ({ name: element.getAttribute('aria-label') || element.textContent.trim(), ...box(element) }));
          const controls = [...document.querySelectorAll('.pagination-bar button, .pagination-bar input, .pagination-bar .el-select__wrapper, .pagination-bar .el-pager li')].filter(visible).map(box);
          const overlap = [];
          for (let i = 0; i < dock.length; i++) {
            for (let j = i + 1; j < dock.length; j++) if (intersects(dock[i], dock[j])) overlap.push([dock[i].name, dock[j].name]);
            if (controls.some(control => intersects(dock[i], control))) overlap.push([dock[i].name, 'pagination']);
          }
          const row = dock.every(item => Math.abs(item.y - dock[0].y) <= 1);
          const ordered = [...dock].sort((a, b) => row ? a.x - b.x : a.y - b.y);
          const gaps = ordered.slice(1).map((item, index) => row ? item.x - ordered[index].right : item.y - ordered[index].bottom);
          return { dock, overlap, controls, gaps, bookArea: box(document.querySelector('.book-card-area')), documentWidth: document.documentElement.scrollWidth,
            aligned: ['x', 'right', 'y', 'bottom'].some(key => Math.max(...dock.map(item => item[key])) - Math.min(...dock.map(item => item[key])) <= 1),
            heights: Math.max(...dock.map(item => item.height)) - Math.min(...dock.map(item => item.height)) };
        });
        assert.equal(state.dock.length, 3, 'The manager must expose return, backup and task controls');
        assert.deepEqual(state.overlap, [], `Manager dock overlaps at ${id} ${viewport.width}px`);
        assert(state.aligned && state.heights <= 1, `Manager utility buttons are misaligned: ${JSON.stringify(state.dock)}`);
        assert(state.gaps.every(gap => gap >= 6) && Math.max(...state.gaps) - Math.min(...state.gaps) <= 1,
          `Manager utility buttons have inconsistent spacing: ${JSON.stringify(state.gaps)}`);
        assert(state.dock.every(button => button.y >= state.bookArea.bottom - 1), 'Manager utility buttons cover the scrollable library');
        assert(state.documentWidth <= viewport.width + 1, 'Manager overflows the window');
        for (const button of await page.locator('.manager-room-return').all()) assertVisibleHit(await hitState(button), 'Manager utility button');
        assert(state.controls.every(control => control.x >= -1 && control.y >= -1 && control.right <= viewport.width + 1 && control.bottom <= viewport.height + 1),
          `Manager pagination leaves the viewport: ${JSON.stringify(state.controls)}`);
        const after = await page.locator('.app-toolbar').boundingBox();
        assert(Math.abs(after.y - before.y) <= 1 && after.y >= 0, 'Scrolling moves the manager toolbar');
        if (id === 'glass') await screenshot(page, `glass-manager-${viewport.width}x${viewport.height}`);
        pass(`${id} manager ${viewport.width}x${viewport.height}: utility buttons align and avoid pagination`, state);
      }
      await page.locator('.manager-task-center').click(); await page.locator('.task-center-item').first().waitFor();
      const taskPaint = await paint(page.locator('.task-center-dialog'));
      assert.equal(taskPaint.color, taskPaint.expectedInk, 'Manager task dialog ignores the theme');
      if (id === 'glass') assert(taskPaint.alpha < .99 && taskPaint.backdrop.length > 0, 'Manager task center loses the large glass surface');
      await page.locator('[data-task-action="close"]').click();
    }
  } catch (error) {
    await page.screenshot({ path: path.join(output, activeCase + '-failure.png') }).catch(() => {});
    throw error;
  } finally { await context.close(); }
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixtures = createFixtures(path.join(output, 'fixtures'), 65, 4);
  const browser = await chromium.launch(launchOptions());
  try {
    for (const [name, check] of Object.entries({ themes: themesCheck, 'glass-panels': glassPanelsCheck, 'room-layout': roomLayoutCheck, 'dialog-layout': dialogLayoutCheck, 'manager-layout': managerLayoutCheck })) {
      if (selected.size && !selected.has(name)) continue;
      activeCase = name;
      try { await check(browser, fixtures); }
      catch (error) { report.failures.push({ case: name, message: error.message, stack: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
  console.log(`${report.checks.length} checks passed; ${report.failures.length} cases failed. Report: ${path.join(output, 'report.json')}`);
  if (report.failures.length || report.errors.length) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
