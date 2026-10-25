'use strict';

// Focused liquid-glass integration checks. Uses a fresh headless browser and fake
// IPC only; fixtures, pixel probes and the report stay in the system temp folder.
// Usage: node tools/test-liquid-glass.cjs [--screenshots] [--case=lifecycle,optics,content,preferences]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');

const selected = new Set((process.argv.find(arg => arg.startsWith('--case=')) || '').slice(7).split(',').filter(Boolean));
const screenshots = process.argv.includes('--screenshots');
const report = { date: new Date().toISOString(), source: 'isolated fake library', checks: [], failures: [], diagnostics: [] };
let output, activeCase = '';
const pass = (name, details) => {
  report.checks.push({ case: activeCase, name, ...(details ? { details } : {}) });
  console.log('PASS ' + name);
};

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function idle(page) {
  // Instrumentation covers both the glass layer and the scene. Sampling uses
  // timers, so this check does not create its own animation frames.
  const result = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now();
    let last = -1, quietSince = start;
    function sample() {
      const stats = window.__glassFrameStats();
      const now = performance.now();
      if (stats.scheduled !== last || stats.pending) { last = stats.scheduled; quietSince = now; }
      if (now - quietSince >= 320) return resolve({ idle: true, ...stats });
      if (now - start >= 8000) return resolve({ idle: false, ...stats });
      setTimeout(sample, 60);
    }
    sample();
  }));
  assert(result.idle, 'Animation frames keep running while the UI is idle: ' + JSON.stringify(result));
}

async function glassReady(page, mode = 'refraction') {
  await page.waitForFunction(mode => {
    if (document.documentElement.dataset.liquidGlass !== mode) return false;
    const lens = document.querySelector('.appearance-button[data-liquid-surface="lens"]');
    return !!lens && (mode !== 'refraction' || /url\(/.test(getComputedStyle(lens).getPropertyValue('--liquid-filter')));
  }, mode);
  await settle(page);
}

async function closeDialog(page) {
  await page.keyboard.press('Escape');
  await page.waitForSelector('#modal-root [role="dialog"]', { state: 'detached' });
}

async function takeScreenshot(page, name) {
  if (screenshots) await page.screenshot({ path: path.join(output, `${activeCase}-${name}.png`), fullPage: true });
}

async function filterState(page) {
  return page.evaluate(() => {
    const filters = [...document.querySelectorAll('#room-liquid-filters filter')];
    return {
      mode: document.documentElement.dataset.liquidGlass || null,
      roots: document.querySelectorAll('svg#room-liquid-filters').length,
      filters: filters.length,
      ids: filters.map(node => node.id),
      surfaces: document.querySelectorAll('[data-liquid-surface]').length,
      lenses: document.querySelectorAll('[data-liquid-surface="lens"]').length,
      inlineFilters: [...document.querySelectorAll('[style]')].filter(node => node.style.getPropertyValue('--liquid-filter')).length,
      positioned: document.querySelectorAll('.liquid-positioned').length,
    };
  });
}

async function assertFiltersReleased(page, disabledTheme = false) {
  await page.waitForFunction(() => !document.querySelector('#room-liquid-filters'));
  const state = await filterState(page);
  assert.equal(state.inlineFilters, 0, 'Released SVG filters leave stale CSS references');
  if (disabledTheme) {
    assert.equal(state.mode, null);
    assert.equal(state.surfaces, 0, 'Non-glass themes retain glass surface markers');
    assert.equal(state.positioned, 0, 'Non-glass themes retain injected positioning classes');
  }
}

async function withFixture(browser, fixtures, callback, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 980 }, deviceScaleFactor: 1,
    reducedMotion: options.reducedMotion || 'no-preference',
    ...(options.userAgent ? { userAgent: options.userAgent } : {}),
  });
  const model = createFakeModel(fixtures.books, fixtures.pages);
  const errors = [], consoleErrors = [];
  let page;
  try {
    await attachFakeIpc(context, model);
    await context.addInitScript(({ theme }) => {
      if (localStorage.getItem('room-theme') === null) localStorage.setItem('room-theme', JSON.stringify(theme));
      const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
      const pending = new Set();
      let scheduled = 0;
      window.requestAnimationFrame = callback => {
        scheduled++;
        const id = request(time => { pending.delete(id); callback(time); });
        pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
      window.__glassFrameStats = () => ({ scheduled, pending: pending.size });
    }, { theme: options.theme || 'glass' });
    page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.goto(appURL);
    await page.waitForSelector('#room [data-book]');
    await page.waitForFunction(() => document.querySelector('.scene-viewport')?.dataset.sceneState === 'ready', null, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    await callback(page, context, model);
    assert.deepEqual(errors, [], 'Uncaught renderer errors');
    assert.deepEqual(consoleErrors.filter(error => /GL_OUT_OF_MEMORY|Shader Error|VALIDATE_STATUS.*false/i.test(error)), [], 'GPU errors');
  } catch (error) {
    if (page) {
      try { await page.screenshot({ path: path.join(output, `${activeCase}-failure.png`), fullPage: true, timeout: 5000 }); } catch {}
    }
    throw error;
  } finally {
    if (errors.length || consoleErrors.length) report.diagnostics.push({ case: activeCase, errors, consoleErrors });
    await context.close();
  }
}

async function lifecycle(browser, fixtures) {
  await withFixture(browser, fixtures, async page => {
    await assertFiltersReleased(page, true);
    await page.locator('.appearance-button').click();
    await page.locator('[data-theme-choice="glass"]').click();
    await glassReady(page);
    await closeDialog(page);
    await idle(page);
    const initial = await filterState(page);
    assert.equal(initial.roots, 1);
    assert(initial.filters > 0 && initial.filters <= initial.lenses, 'Filters should be shared only by registered lenses');
    await page.reload();
    await page.waitForSelector('#room [data-book]');
    await glassReady(page);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('room-theme'))), 'glass');
    pass('Glass theme restores its actual filter resources after reload');

    const rounds = [];
    for (const theme of ['paper', 'forest', 'paper']) {
      await page.locator('.appearance-button').click();
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      await assertFiltersReleased(page, true);
      await idle(page);
      await page.locator('[data-theme-choice="glass"]').click();
      await glassReady(page);
      await closeDialog(page);
      await page.mouse.move(0, 0);
      await idle(page);
      const state = await filterState(page);
      assert.equal(state.roots, 1, 'Theme changes accumulated SVG roots');
      assert.equal(new Set(state.ids).size, state.ids.length, 'Duplicate SVG filter IDs');
      assert(state.filters <= initial.filters + 1, 'Theme changes accumulated unused filter definitions');
      rounds.push({ theme, filters: state.filters, lenses: state.lenses });
    }
    pass('Repeated theme changes release glass resources and stop idle animation frames', rounds);
    await takeScreenshot(page, 'restored');
  }, { theme: 'paper' });
}

async function pixelDifference(page, first, second) {
  return page.evaluate(async ({ first, second }) => {
    async function pixels(encoded) {
      const image = new Image();
      image.src = 'data:image/png;base64,' + encoded;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      return { width: canvas.width, height: canvas.height, data: context.getImageData(0, 0, canvas.width, canvas.height).data };
    }
    const a = await pixels(first), b = await pixels(second);
    if (a.width !== b.width || a.height !== b.height) throw new Error('Probe changed dimensions');
    const zones = { rim: { sum: 0, count: 0, changed: 0 }, centre: { sum: 0, count: 0, changed: 0 } };
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) {
      const px = x / a.width, py = y / a.height;
      const centre = px > .3 && px < .7 && py > .36 && py < .64;
      // Exclude corners and the anti-aliased border; compare the straight rim.
      const rim = ((px > .25 && px < .75) && ((y > 3 && py < .19) || (py > .81 && y < a.height - 3)))
        || ((py > .3 && py < .7) && ((x > 3 && x < 20) || (x > a.width - 20 && x < a.width - 3)));
      if (!centre && !rim) continue;
      const offset = (y * a.width + x) * 4;
      const delta = (Math.abs(a.data[offset] - b.data[offset]) + Math.abs(a.data[offset + 1] - b.data[offset + 1]) + Math.abs(a.data[offset + 2] - b.data[offset + 2])) / 3;
      const zone = zones[centre ? 'centre' : 'rim'];
      zone.sum += delta; zone.count++; if (delta > 3) zone.changed++;
    }
    return Object.fromEntries(Object.entries(zones).map(([name, zone]) => [name, { meanDifference: zone.sum / zone.count, changedFraction: zone.changed / zone.count }]));
  }, { first: first.toString('base64'), second: second.toString('base64') });
}

async function optics(browser, fixtures) {
  await withFixture(browser, fixtures, async page => {
    await glassReady(page);
    const state = await page.evaluate(() => {
      const lenses = [...document.querySelectorAll('[data-liquid-surface="lens"]')]
        .filter(element => element.clientWidth > 2 && element.clientHeight > 2);
      return {
        lenses: lenses.map(element => {
          const css = getComputedStyle(element), before = getComputedStyle(element, '::before');
          const reference = css.getPropertyValue('--liquid-filter'), id = reference.match(/#([^"')\s]+)/)?.[1];
          return { name: element.className, reference, exists: !!id && !!document.getElementById(id)?.querySelector('feDisplacementMap'), filter: css.filter, backdrop: before.backdropFilter, pointerEvents: before.pointerEvents };
        }),
        content: [...document.querySelectorAll('h1, h2, .appearance-button span, #room img, canvas.scene-canvas')]
          .map(element => ({ name: element.tagName, filter: getComputedStyle(element).filter, surface: element.dataset.liquidSurface || null })),
        filteredHosts: [...document.querySelectorAll('[data-liquid-surface]')]
          .filter(element => getComputedStyle(element).filter !== 'none').map(element => element.className),
      };
    });
    assert(state.lenses.length >= 4, 'Expected multiple active control lenses');
    for (const lens of state.lenses) {
      assert(lens.exists, `Lens has a broken filter reference: ${lens.name}`);
      assert.match(lens.backdrop, /url\(/, `Lens background has no SVG refraction: ${lens.name}`);
      assert.equal(lens.filter, 'none', `Refraction distorts the control contents: ${lens.name}`);
      assert.equal(lens.pointerEvents, 'none', `Glass overlay intercepts clicks: ${lens.name}`);
    }
    for (const content of state.content) {
      assert.equal(content.filter, 'none', `Foreground content is filtered: ${content.name}`);
      assert.equal(content.surface, null, `Foreground content was registered as glass: ${content.name}`);
    }
    assert.deepEqual(state.filteredHosts, [], 'A whole glass panel is filtered along with its foreground contents');
    pass('Real SVG displacement filters apply only to non-interactive background layers');

    const button = page.locator('.appearance-button');
    await page.mouse.move(0, 0);
    await idle(page);
    const original = await button.boundingBox();
    const highlights = [];
    for (const point of [.15, .5, .85]) {
      await page.mouse.move(original.x + original.width * point, original.y + original.height * .5);
      await settle(page);
      const current = await button.boundingBox();
      for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(current[key] - original[key]) < .5, 'Pointer highlights move or resize the control');
      highlights.push(await button.evaluate(element => element.style.getPropertyValue('--liquid-x')));
    }
    assert(new Set(highlights.filter(Boolean)).size > 1, 'Pointer lighting does not respond');
    await button.click();
    await page.waitForSelector('.theme-modal');
    await closeDialog(page);
    pass('Pointer lighting changes without moving the button or blocking its click target');

    // Relocate the actual registered control, keeping its production ::before
    // and filter. Only the --liquid-filter variable changes between captures.
    await page.mouse.move(0, 0);
    await page.evaluate(() => {
      const button = document.querySelector('.appearance-button');
      const stage = document.createElement('div');
      stage.id = 'glass-pixel-probe';
      stage.style.cssText = 'position:fixed;left:24px;top:24px;width:324px;height:176px;z-index:2147483646;display:grid;place-items:center;background:repeating-linear-gradient(45deg,#24272c 0 13px,#f5f6f8 13px 26px);';
      button.replaceChildren();
      button.style.cssText = 'width:260px;height:112px;min-height:112px;flex:none;margin:0;padding:0;border-radius:28px;transition:none;animation:none;';
      document.body.append(stage);
      stage.append(button);
    });
    await glassReady(page);
    await idle(page);
    const reference = await button.evaluate(element => element.style.getPropertyValue('--liquid-filter'));
    assert.match(reference, /url\(/);
    const on = await button.screenshot({ animations: 'disabled' });
    await button.evaluate(element => element.style.setProperty('--liquid-filter', 'blur(0px)', 'important'));
    await settle(page);
    const off = await button.screenshot({ animations: 'disabled' });
    await button.evaluate((element, reference) => element.style.setProperty('--liquid-filter', reference, 'important'), reference);
    await settle(page);
    const restored = await button.screenshot({ animations: 'disabled' });
    fs.writeFileSync(path.join(output, 'optics-refraction-on.png'), on);
    fs.writeFileSync(path.join(output, 'optics-refraction-off.png'), off);
    const difference = await pixelDifference(page, on, off);
    const repeat = await pixelDifference(page, on, restored);
    report.diagnostics.push({ case: activeCase, probe: difference, repeat });
    assert(repeat.rim.meanDifference < 1, 'Pixel probe changes even when the original filter is restored');
    assert(difference.rim.meanDifference > 1.5 && difference.rim.changedFraction > .08, 'SVG syntax is accepted but the backdrop shows no measurable rim displacement');
    assert(difference.centre.meanDifference < 6 && difference.rim.meanDifference > difference.centre.meanDifference * 1.8,
      'Refraction moves the centre as strongly as the rim: ' + JSON.stringify(difference));
    pass('Stripe captures prove real rim displacement with a stable centre', difference);

    // A backdrop-filtered ancestor provides a partly transparent SourceGraphic.
    // This catches RGB recombination that accidentally multiplies its alpha and
    // turns otherwise neutral search/button centres grey.
    await page.evaluate(() => {
      const frost = document.createElement('div');
      frost.className = 'topbar';
      frost.style.cssText = 'width:304px;height:156px;margin:0;padding:0;display:grid;place-items:center;';
      document.querySelector('#glass-pixel-probe').append(frost);
      frost.append(document.querySelector('.appearance-button'));
    });
    await idle(page);
    const nestedOn = await button.screenshot({ animations: 'disabled' });
    await button.evaluate(element => element.style.setProperty('--liquid-filter', 'blur(0px)', 'important'));
    await settle(page);
    const nestedOff = await button.screenshot({ animations: 'disabled' });
    fs.writeFileSync(path.join(output, 'optics-nested-refraction-on.png'), nestedOn);
    fs.writeFileSync(path.join(output, 'optics-nested-refraction-off.png'), nestedOff);
    const nestedDifference = await pixelDifference(page, nestedOn, nestedOff);
    report.diagnostics.push({ case: activeCase, nestedProbe: nestedDifference });
    assert(nestedDifference.centre.meanDifference < 3, 'Nested frost changes the neutral lens centre: ' + JSON.stringify(nestedDifference));
    pass('A lens inside a frosted panel preserves its centre colour and transparency', nestedDifference);
  });
}

async function content(browser, fixtures) {
  const books = fixtures.books.map(book => ({ ...book }));
  books[0].title = '纯白玻璃长标题检查 · White light / ' + '静物与光影的漫长旅途'.repeat(12);
  await withFixture(browser, { ...fixtures, books }, async page => {
    await glassReady(page);
    await page.locator('[data-view="grid"]').click();
    await page.waitForSelector('.book-grid');
    const book = page.locator(`#room [data-book="${books[0].id}"]`);
    await book.hover();
    await page.waitForSelector('.book-title-tooltip:not([hidden])[data-liquid-surface="lens"]');
    const tooltip = page.locator('.book-title-tooltip:not([hidden])');
    assert.equal((await tooltip.textContent()).trim(), books[0].title);
    const dimensions = await tooltip.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, height: element.clientHeight, scrollHeight: element.scrollHeight }));
    assert(dimensions.scrollWidth <= dimensions.width + 1 && dimensions.scrollHeight <= dimensions.height + 1, 'Glass title tooltip clips long text');
    await book.click();
    await page.waitForSelector('.drawer[data-liquid-surface]');
    await page.waitForFunction(() => {
      const drawer = document.querySelector('.drawer');
      return drawer && /url\(/.test(getComputedStyle(drawer).backdropFilter);
    });
    assert.equal(await page.locator('.drawer h2').evaluate(element => getComputedStyle(element).filter), 'none',
      'The large drawer surface must refract its background without filtering the heading');
    await page.waitForSelector('.drawer .reading-options[data-liquid-surface="sheen"]');
    // Primary actions keep their opaque accent for contrast; only secondary
    // controls refract the backdrop. Hover must never turn the read button white.
    const primary=page.locator('.drawer [data-read]');
    await primary.hover();
    const primaryStyle=await primary.evaluate(element=>({background:getComputedStyle(element).backgroundImage,color:getComputedStyle(element).color,filter:element.style.getPropertyValue('--liquid-filter')}));
    assert.match(primaryStyle.background,/linear-gradient/);
    assert.equal(primaryStyle.color,'rgb(255, 255, 255)');
    assert.equal(primaryStyle.filter,'');
    assert.equal((await page.locator('.drawer h2').textContent()).trim(), books[0].title);
    pass('Long-title tooltips and newly inserted drawer controls acquire the right glass layers');

    await page.locator('.drawer').evaluate(element => Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))));
    for (const width of [720, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await settle(page);
      const dimensions = await page.evaluate(() => {
        const drawer = document.querySelector('.drawer'), rect = drawer.getBoundingClientRect();
        return { viewport: innerWidth, document: document.documentElement.scrollWidth, left: rect.left, right: rect.right, client: drawer.clientWidth, scroll: drawer.scrollWidth };
      });
      assert(dimensions.document <= width + 1 && dimensions.scroll <= dimensions.client + 1 && dimensions.left >= -1 && dimensions.right <= width + 1,
        'Glass drawer overflows a narrow screen: ' + JSON.stringify(dimensions));
      await takeScreenshot(page, `${width}-drawer`);
    }
    await closeDialog(page);
    await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Glass home overflows at 390px');
    pass('Glass details and home remain within 720px and 390px viewports');

    await book.click();
    await page.locator('.drawer [data-read]').click();
    await page.waitForSelector('.reader-bar[data-liquid-surface="frost"]');
    await page.waitForFunction(() => document.querySelector('.reader-body img')?.naturalWidth > 0);
    const images = await page.locator('.book-grid img, .reader-body img').evaluateAll(elements => elements.map(element => ({
      filter: getComputedStyle(element).filter, surface: element.dataset.liquidSurface || null,
    })));
    assert(images.length > 0);
    for (const image of images) { assert.equal(image.filter, 'none'); assert.equal(image.surface, null); }
    pass('Dynamically opened reader chrome gets glass while covers and page images remain unfiltered');
  });
}

async function preferences(browser, fixtures) {
  await withFixture(browser, fixtures, async (page, context) => {
    await glassReady(page);
    const button = page.locator('.appearance-button');
    await button.hover();
    await page.mouse.move(1, 1);
    await button.hover();
    await settle(page);
    assert.equal(await button.evaluate(element => element.style.getPropertyValue('--liquid-x')), '', 'Reduced motion still tracks pointer lighting');
    const duration = await button.evaluate(element => {
      const css = getComputedStyle(element);
      return Math.max(...[css.transitionDuration, css.animationDuration].flatMap(value => value.split(',').map(part => parseFloat(part) * (part.trim().endsWith('ms') ? 1 : 1000))));
    });
    assert(duration <= 20, 'Reduced-motion glass still has a long transition');
    await idle(page);
    pass('Reduced motion keeps static refraction while suppressing pointer animation');

    const session = await context.newCDPSession(page);
    for (const feature of ['prefers-reduced-transparency', 'forced-colors']) {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: feature, value: feature === 'forced-colors' ? 'active' : 'reduce' }] });
      await glassReady(page, 'reduced');
      await assertFiltersReleased(page);
      const layer = await button.evaluate(element => {
        const css = getComputedStyle(element, '::before');
        return { content: css.content, backdrop: css.backdropFilter };
      });
      assert(layer.content === 'none' || layer.backdrop === 'none', `${feature} leaves a rendered backdrop filter active`);
      await button.click();
      await page.waitForSelector('.theme-modal');
      await closeDialog(page);
      await page.mouse.move(0, 0);
      await idle(page);
      await session.send('Emulation.setEmulatedMedia', { features: [] });
      await glassReady(page);
    }
    await session.detach();
    pass('Reduced transparency and forced colours remove filters, keep controls usable, and restore cleanly');
  }, { reducedMotion: 'reduce' });

  // Exercise the conservative engine fallback without claiming to run Safari.
  await withFixture(browser, fixtures, async page => {
    await glassReady(page, 'frosted');
    await assertFiltersReleased(page);
    const css = await page.locator('.appearance-button').evaluate(element => getComputedStyle(element, '::before').backdropFilter);
    assert(!css.includes('url('), 'Fallback still references an SVG filter');
    await idle(page);
    pass('A non-Chromium user agent selects the frosted fallback without SVG resources');
  }, { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' });
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('Usage: node tools/test-liquid-glass.cjs [--screenshots] [--case=lifecycle,optics,content,preferences]\nUses isolated fake IPC. Output defaults to a fresh system temp directory; override with LIQUID_GLASS_TEST_OUTPUT.');
    return;
  }
  const cases = { lifecycle, optics, content, preferences };
  for (const name of selected) assert(name in cases, 'Unknown liquid-glass case: ' + name);
  output = process.env.LIQUID_GLASS_TEST_OUTPUT ? path.resolve(process.env.LIQUID_GLASS_TEST_OUTPUT) : fs.mkdtempSync(path.join(os.tmpdir(), 'room-liquid-glass-'));
  fs.mkdirSync(output, { recursive: true });
  const fixtures = createFixtures(path.join(output, 'fixtures'), 3);
  const browser = await chromium.launch(launchOptions());
  try {
    for (const [name, callback] of Object.entries(cases)) {
      if (selected.size && !selected.has(name)) continue;
      activeCase = name;
      const start = Date.now();
      try { await callback(browser, fixtures); }
      catch (error) {
        report.failures.push({ case: name, message: error.message, stack: error.stack });
        console.error(`FAIL ${name}: ${error.message}`);
      }
      report.diagnostics.push({ case: name, durationMs: Date.now() - start });
    }
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(`${report.checks.length} checks passed; ${report.failures.length} cases failed. Report: ${path.join(output, 'checks.json')}`);
  if (report.failures.length) process.exitCode = 1;
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
