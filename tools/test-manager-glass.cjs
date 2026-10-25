'use strict';

// Isolated classic-manager regression checks. A fresh headless browser receives
// neutral generated covers and fake IPC; the live app and its files are untouched.
// Run after manager-glass.css and manager-glass.js have been integrated:
//   node tools/test-manager-glass.cjs
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const out = path.join(__dirname, '.artifacts', 'manager-glass');
const report = { source: 'isolated fake library', checks: [], screenshots: [], diagnostics: [], errors: [] };
const pass = (message, details) => {
  report.checks.push({ message, ...(details ? { details } : {}) });
  console.log('PASS ' + message);
};
const clone = value => JSON.parse(JSON.stringify(value));

function modelFor(fixtures, withCollection = false) {
  const books = fixtures.books.map((book, index) => ({
    ...book, coverPath: pathToFileURL(book.coverPath).href,
    hash: `manager-glass-neutral-${index}`, status: 'tagged', date: book.createdAt,
    mtime: book.createdAt, posted: Math.floor(Date.parse(book.createdAt) / 1000),
    bundleSize: book.pageCount * 1024 * 1024,
    tags: { artist: ['Neutral Artist'], language: ['chinese'], misc: ['still life'] },
  }));
  const model = createFakeModel(books, fixtures.pages);
  Object.assign(model.setting, {
    theme: 'glass', language: 'zh-CN', pageSize: 24, loadOnStart: false,
    autoCheckUpdates: false, showTranslation: false, hideTitleBar: true,
    disableRandomTag: true, collectTag: [], showComment: false,
  });
  model.collections = withCollection
    ? [{ id: 'neutral-collection', title: '中性样例合集', list: books.slice(0, 2).map(book => book.hash) }]
    : [];
  const invoke = model.invoke.bind(model);
  model.invoke = async function (channel, ...args) {
    if (channel === 'load-collection-list') {
      this.calls.push({ channel, args: clone(args) });
      return clone(this.collections);
    }
    if (channel === 'get-folder-tree') {
      this.calls.push({ channel, args: clone(args) });
      return [{ label: '模拟书库', folderPath: path.dirname(books[0].filepath), children: [] }];
    }
    if (channel === 'get-default-manga-reader') {
      this.calls.push({ channel, args: clone(args) });
      return '';
    }
    if (['get-locale', 'window-is-maximized', 'update-tag-translation', 'set-progress-bar', 'switch-fullscreen'].includes(channel)) {
      this.calls.push({ channel, args: clone(args) });
      if (channel === 'get-locale') return 'zh-CN';
      if (channel === 'window-is-maximized') return false;
      return null;
    }
    return invoke(channel, ...args);
  };
  return model;
}

async function openManager(browser, fixtures, options = {}) {
  const model = modelFor(fixtures, options.withCollection);
  const context = await browser.newContext({
    viewport: { width: 1560, height: 1040 },
    reducedMotion: options.reducedMotion || 'no-preference',
    forcedColors: options.forcedColors || 'none',
    ...(options.firefoxIdentity ? {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0',
    } : {}),
  });
  await attachFakeIpc(context, model);
  await context.addInitScript(({ reducedTransparency }) => {
    window.ipcRenderer.sendSync = channel => {
      if (channel !== 'get-path-sep') throw Error('Unexpected sync channel: ' + channel);
      return '\\';
    };
    window.electronFunction = { 'get-zoom-level': () => 0, 'set-zoom-level': () => {}, 'insert-css': () => {} };
    if (!sessionStorage.getItem('manager-glass-test-initialized')) {
      localStorage.clear();
      localStorage.setItem('reading-room-interface', 'classic');
      localStorage.setItem('room-theme', JSON.stringify('glass'));
      sessionStorage.setItem('manager-glass-test-initialized', '1');
    }
    if (reducedTransparency) {
      const matchMedia = window.matchMedia.bind(window);
      window.matchMedia = query => {
        const result = matchMedia(query);
        if (/prefers-reduced-transparency\s*:\s*reduce/.test(query)) {
          Object.defineProperty(result, 'matches', { configurable: true, value: true });
        }
        return result;
      };
    }
    // Count delivered work without introducing a test animation loop. CSS
    // transitions and Playwright's waits do not increment these counters.
    const raf = window.requestAnimationFrame.bind(window);
    const cancel = window.cancelAnimationFrame.bind(window);
    const pending = new Set();
    let issued = 0;
    let delivered = 0;
    window.requestAnimationFrame = callback => {
      issued += 1;
      const id = raf(time => { pending.delete(id); delivered += 1; callback(time); });
      pending.add(id);
      return id;
    };
    window.cancelAnimationFrame = id => { pending.delete(id); cancel(id); };
    window.__managerTestRAF = () => ({ issued, delivered, pending: pending.size });
  }, { reducedTransparency: !!options.reducedTransparency });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', event => { if (event.type() === 'error') report.errors.push(event.text()); });
  await page.goto(appURL);
  await page.locator('.app-toolbar').waitFor();
  await page.locator('.book-card').first().waitFor();
  return { context, page, model };
}

async function optics(page, expected) {
  await page.waitForFunction(expected => document.documentElement.dataset.managerOptics === expected, expected);
  if (expected === 'refraction') {
    await page.waitForFunction(() => {
      const toolbar = document.querySelector('.app-toolbar');
      return toolbar?.dataset.managerGlass === 'lens'
        && /url\(/.test(getComputedStyle(toolbar).getPropertyValue('--mg-filter'))
        && document.querySelector('#manager-liquid-filters filter');
    });
  }
}

async function settleVisuals(page) {
  // Element visibility can become true at the beginning of a Vue/CSS entrance
  // transition. Wait for fonts and finite transitions to finish before judging
  // their paint; perpetual decorative animation must not block this helper.
  await page.evaluate(async () => {
    const deadline = performance.now() + 3000;
    let quietSince = null;
    while (performance.now() < deadline) {
      const finite = document.getAnimations().filter(animation =>
        (animation.pending || animation.playState === 'running')
        && Number.isFinite(animation.effect?.getComputedTiming().endTime));
      if (document.fonts.status === 'loaded' && finite.length === 0) {
        if (quietSince !== null && performance.now() - quietSince >= 80) return;
        quietSince ??= performance.now();
      } else {
        quietSince = null;
      }
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Fonts or finite entrance transitions did not settle within three seconds');
  });
}

async function screenshot(page, name) {
  await settleVisuals(page);
  fs.mkdirSync(out, { recursive: true });
  const file = path.join(out, name + '.png');
  await page.screenshot({ path: file, fullPage: true });
  report.screenshots.push(file);
  return file;
}

async function dismiss(page, selector) {
  await page.keyboard.press('Escape');
  await page.locator(selector).waitFor({ state: 'hidden' });
}

async function assertSettingsFields(page) {
  const state = await page.locator('.setting-dialog').evaluate(dialog => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const pane = dialog.querySelector('#pane-general');
    const groups = [...pane.querySelectorAll('.el-input-group--append')].map(group => {
      const append = group.querySelector('.el-input-group__append');
      const wrapper = group.querySelector('.el-input__wrapper');
      return {
        rect: rect(group), append: rect(append), wrapper: rect(wrapper),
        actions: [...append.querySelectorAll('button')].map(button => ({
          rect: rect(button), radius: getComputedStyle(button).borderTopLeftRadius,
        })),
      };
    });
    return { dialog: rect(dialog), viewportHeight: innerHeight, paneWidth: pane.clientWidth, paneScrollWidth: pane.scrollWidth, groups };
  });
  assert(state.dialog.top >= 0 && state.dialog.bottom <= state.viewportHeight, 'Settings extend below the viewport');
  assert(state.paneScrollWidth <= state.paneWidth + 1, 'General settings require horizontal scrolling');
  assert.equal(state.groups.length, 4);
  for (const group of state.groups) {
    assert(Math.abs(group.wrapper.right - group.append.left) <= 1, 'An appended action detaches from its input');
    assert(Math.abs(group.actions[0].rect.left - group.append.left) <= 1, 'An appended action has a leading gap');
    assert(Math.abs(group.actions.at(-1).rect.right - group.append.right) <= 1, 'An appended action has a trailing gap');
    let previous = null;
    for (const action of group.actions) {
      assert(Math.abs(action.rect.top - group.rect.top) <= 1 && Math.abs(action.rect.bottom - group.rect.bottom) <= 1, 'An appended action does not match its field height');
      assert.equal(action.radius, '0px', 'An independent inner corner leaves a gap at the field join');
      if (previous) assert(Math.abs(action.rect.left - previous.right) <= 1, 'Joined actions overlap or have a gap');
      previous = action.rect;
    }
  }
  return { joinedFields: state.groups.length, actionCount: state.groups.reduce((count, group) => count + group.actions.length, 0), dialogBottom: state.dialog.bottom };
}

async function assertSettingsShortcuts(page) {
  const state = await page.locator('#pane-accelerator').evaluate(pane => {
    const rect = element => element.getBoundingClientRect().toJSON();
    const cells = [...pane.querySelectorAll('.el-descriptions__cell')];
    return {
      scrollWidth: pane.scrollWidth, width: pane.clientWidth,
      first: rect(cells[0]), second: rect(cells[1]),
      count: cells.length,
      broken: cells.flatMap(cell => {
        const label = cell.querySelector('.el-descriptions__label');
        const tag = cell.querySelector('.el-tag');
        const key = cell.querySelector('.el-tag__content');
        const bounds = rect(cell), name = rect(label), keyBounds = rect(tag);
        return cell.scrollWidth > cell.clientWidth + 1 || tag.scrollWidth > tag.clientWidth + 1
          || name.right > keyBounds.left - 2 || keyBounds.right > bounds.right + 1
          || !key.textContent.trim() ? [cell.textContent.trim()] : [];
      }),
    };
  });
  assert(state.scrollWidth <= state.width + 1, 'Shortcuts require horizontal scrolling');
  assert(state.count > 30, 'A shortcut group or its entries disappeared');
  assert.deepEqual(state.broken, [], 'Shortcut names and key combinations overlap or overflow');
  return { count: state.count, columns: Math.abs(state.first.top - state.second.top) < 1 ? 2 : 1 };
}

async function settingsChecks(page, model) {
  const viewport = page.viewportSize();
  const sizes = [{ width: 1564, height: 1003 }, { width: 720, height: 900 }, { width: 480, height: 640 }];
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.getByRole('tab', { name: '常用', exact: true }).click();
    await settleVisuals(page);
    const fields = await assertSettingsFields(page);
    await screenshot(page, 'settings-general-' + size.width);
    await page.getByRole('tab', { name: '高级', exact: true }).click();
    await settleVisuals(page);
    await page.locator('#pane-advanced').evaluate(element => { element.scrollTop = element.scrollHeight; });
    if (size.width === 1564) await screenshot(page, 'settings-advanced-1564');
    await page.getByRole('tab', { name: '快捷键', exact: true }).click();
    await settleVisuals(page);
    assert.equal(await page.locator('#pane-accelerator').evaluate(element => element.scrollTop), 0, 'Advanced settings left the opening shortcuts scrolled out of view');
    const shortcuts = await assertSettingsShortcuts(page);
    assert.equal(shortcuts.columns, size.width > 1000 ? 2 : 1);
    await screenshot(page, 'settings-shortcuts-' + size.width);
    const bottom = await page.locator('#pane-accelerator').evaluate(element => {
      element.scrollTop = element.scrollHeight;
      const last = element.querySelector('.el-descriptions:last-child .el-descriptions__cell:last-child .el-tag').getBoundingClientRect();
      const pane = element.getBoundingClientRect();
      return { bottom: last.bottom, paneBottom: pane.bottom, scrollTop: element.scrollTop };
    });
    assert(bottom.scrollTop > 0 && bottom.bottom <= bottom.paneBottom, 'The final shortcut cannot be reached by scrolling');
    // Reset while this pane is visible; browsers ignore scrollTop writes to a
    // display:none pane, which would otherwise reuse this test's previous run.
    await page.locator('#pane-accelerator').evaluate(element => { element.scrollTop = 0; });
    pass(`Settings at ${size.width} × ${size.height} keep joined actions aligned, shortcuts readable, and tab scrolling independent`, { fields, shortcuts });
  }
  await page.setViewportSize(viewport);
  await page.getByRole('tab', { name: '常用', exact: true }).click();
  await settleVisuals(page);
  const buttons = page.locator('#pane-general .el-input-group__append button');
  const channels = ['select-folder', 'select-folder', 'get-default-manga-reader', 'select-file'];
  for (const [index, channel] of channels.entries()) {
    const before = model.calls.filter(call => call.channel === channel).length;
    await buttons.nth(index).click();
    assert.equal(model.calls.filter(call => call.channel === channel).length, before + 1, 'The attached settings action no longer responds: ' + channel);
  }
  let proxyRequests = 0;
  await page.route('https://e-hentai.org/**', route => {
    proxyRequests += 1;
    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'isolated test response' });
  });
  await buttons.last().click();
  await page.waitForFunction(() => !!document.querySelector('.el-message--success'));
  assert.equal(proxyRequests, 1, 'The attached proxy test action no longer responds');
  pass('All five attached choose, reset, and test buttons retain their original actions against isolated fixtures');
}

async function quietRAF(page, label) {
  await page.mouse.move(2, 400);
  await page.waitForTimeout(600);
  const before = await page.evaluate(() => window.__managerTestRAF());
  await page.waitForTimeout(320);
  const after = await page.evaluate(() => window.__managerTestRAF());
  assert.equal(after.issued, before.issued, label + ': requestAnimationFrame kept scheduling while idle');
  assert.equal(after.pending, 0, label + ': an animation frame remained pending while idle');
  return { issuedDuringIdle: after.issued - before.issued, pending: after.pending };
}

async function searchOne(page) {
  const search = page.locator('.app-toolbar .search-input input');
  await search.fill('"静物档案 01"');
  await search.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.book-card-frame').length === 1);
  assert.equal((await page.locator('.book-title').first().textContent()).trim(), '静物档案 01');
  await search.fill('');
  await search.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('.book-card-frame').length === 24);
}

async function assertCatalogActions(page) {
  const primary = page.locator('.catalog-actions .cbtn.cbtn-solid');
  const danger = page.locator('.catalog-actions .cbtn.cbtn-danger');
  const neutral = page.locator('.catalog-actions .cbtn:not(.cbtn-solid):not(.cbtn-danger):not(.is-on)').first();
  const paint = locator => locator.evaluate(element => {
    const style = getComputedStyle(element);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d');
    const rgba = color => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    };
    const stops = style.backgroundImage.match(/(?:rgba?|hsla?|color|oklab|oklch|lab|lch)\([^)]*\)|#[\da-f]{3,8}\b/gi) || [];
    return {
      color: rgba(style.color), opacity: Number(style.opacity),
      fill: stops.length ? stops.map(rgba) : [rgba(style.backgroundColor)],
    };
  });
  const luminance = color => color.slice(0, 3).map(value => {
    const c = value / 255;
    return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
  }).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
  const states = {};
  await page.mouse.move(2, 400);
  for (const state of ['normal', 'hover']) {
    if (state === 'hover') await primary.hover();
    await settleVisuals(page);
    const result = await paint(primary);
    assert(result.opacity >= .99 && result.color.every(channel => channel >= 245), `The primary reading action loses white text in its ${state} state: ${JSON.stringify(result)}`);
    assert(result.fill.length > 0 && result.fill.every(color => color[3] >= 250), `The primary reading action loses its opaque fill in its ${state} state: ${JSON.stringify(result)}`);
    assert(result.fill.every(color => (luminance(result.color) + .05) / (luminance(color) + .05) >= 3), `The primary reading action loses its visibly colored fill in its ${state} state: ${JSON.stringify(result)}`);
    states[state] = result;
  }
  await page.mouse.move(2, 400);
  await settleVisuals(page);
  const dangerPaint = await paint(danger);
  const neutralPaint = await paint(neutral);
  const colorDistance = Math.hypot(...dangerPaint.color.slice(0, 3).map((value, index) => value - neutralPaint.color[index]));
  assert(colorDistance >= 40, `The delete action is styled like a neutral action: ${JSON.stringify({ danger: dangerPaint.color, neutral: neutralPaint.color })}`);
  return { ...states, dangerColor: dangerPaint.color, neutralColor: neutralPaint.color };
}

async function assertPanelControls(page, selector) {
  const panel = page.locator(selector);
  await panel.waitFor({ state: 'visible' });
  await settleVisuals(page);
  const position = await panel.evaluate(element => {
    const r = element.getBoundingClientRect();
    const area = document.querySelector('.book-card-area').getBoundingClientRect();
    return {
      box: { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
      contained: r.width > 0 && r.height > 0 && r.left >= Math.max(0, area.left) - 1
        && r.right <= Math.min(innerWidth, area.right) + 1 && r.top >= Math.max(0, area.top) - 1
        && r.bottom <= Math.min(innerHeight, area.bottom) + 1,
    };
  });
  assert(position.contained, `The ${selector} operation panel is outside its visible library area: ${JSON.stringify(position)}`);
  const controls = panel.locator('button, .el-select__wrapper, .el-input__wrapper');
  let checked = 0;
  for (const control of await controls.all()) {
    if (!await control.isVisible() || await control.isDisabled()) continue;
    // Exercise the side panel's own scrolling, without activating destructive
    // or metadata-changing operations. A visible DOM node alone is not enough.
    await control.scrollIntoViewIfNeeded();
    const target = await control.evaluate((element, selector) => {
      const r = element.getBoundingClientRect();
      const p = document.querySelector(selector).getBoundingClientRect();
      const x = r.x + r.width / 2;
      const y = r.y + r.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        label: element.textContent.trim() || element.getAttribute('aria-label') || element.className,
        contained: r.left >= Math.max(0, p.left) - 1 && r.right <= Math.min(innerWidth, p.right) + 1
          && r.top >= Math.max(0, p.top) - 1 && r.bottom <= Math.min(innerHeight, p.bottom) + 1,
        receivesPointer: !!hit && element.contains(hit),
      };
    }, selector);
    assert(target.contained && target.receivesPointer, `An operation control is clipped or covered in ${selector}: ${JSON.stringify(target)}`);
    checked += 1;
  }
  assert(checked > 0, `No usable controls were found in ${selector}`);
  await panel.evaluate(element => { element.scrollTop = 0; });
  return { box: position.box, controlsChecked: checked };
}

async function assertLayout(page, width) {
  await page.setViewportSize({ width, height: width <= 950 ? 820 : 1040 });
  await page.waitForTimeout(220);
  await settleVisuals(page);
  const result = await page.evaluate(() => {
    const box = element => {
      const r = element.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom };
    };
    const visible = element => {
      const r = element.getBoundingClientRect();
      const s = getComputedStyle(element);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const returnButton = document.querySelector('.manager-room-return');
    const returnBox = box(returnButton);
    const controls = [...document.querySelectorAll('.pagination-bar button, .pagination-bar input, .pagination-bar .el-select__wrapper, .pagination-bar .el-pager li')].filter(visible);
    const overlaps = controls.filter(element => {
      const r = box(element);
      return Math.min(r.right, returnBox.right) - Math.max(r.x, returnBox.x) > 1
        && Math.min(r.bottom, returnBox.bottom) - Math.max(r.y, returnBox.y) > 1;
    }).map(element => ({ class: element.className, box: box(element) }));
    const clipped = [...document.querySelectorAll('.app-toolbar .el-button, .app-toolbar .search-input, .app-toolbar .sort-select, .pagination-bar .el-pagination__total, .pagination-bar .el-pagination__sizes, .pagination-bar .el-pagination__jump, .pagination-bar .el-pager, .pagination-bar .btn-prev, .pagination-bar .btn-next')]
      .filter(visible).filter(element => { const r = box(element); return r.x < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1; })
      .map(element => ({ class: element.className, box: box(element) }));
    const toolbar = document.querySelector('.app-toolbar');
    const firstBook = document.querySelector('.book-card');
    const readingButtons = [...firstBook.querySelectorAll('.outer-read-button-group button')];
    const ratingItems = [...firstBook.querySelectorAll('.el-rate__item')].filter(visible);
    const cardControls = [...readingButtons, firstBook.querySelector('.book-status-tag'), ...ratingItems].filter(Boolean).map(box);
    const cardBox = box(firstBook);
    const ticker = document.querySelector('.cat-ticker');
    const statisticsItems = [...document.querySelectorAll('.cat-ticker-track > span')].filter(visible);
    const statisticsClipped = [];
    for (const element of [ticker, ...statisticsItems].filter(Boolean)) {
      const r = box(element);
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        const a = box(ancestor);
        const clipBox = {
          x: a.x + ancestor.clientLeft, y: a.y + ancestor.clientTop,
          right: a.x + ancestor.clientLeft + ancestor.clientWidth,
          bottom: a.y + ancestor.clientTop + ancestor.clientHeight,
        };
        const clipsX = style.overflowX !== 'visible' && (r.x < clipBox.x - 1 || r.right > clipBox.right + 1);
        const clipsY = style.overflowY !== 'visible' && (r.y < clipBox.y - 1 || r.bottom > clipBox.bottom + 1);
        if (clipsX || clipsY) {
          statisticsClipped.push({
            element: element === ticker ? '.cat-ticker' : element.textContent.trim(),
            ancestor: ancestor.className || ancestor.tagName, box: r, clipBox,
          });
          break;
        }
      }
    }
    return {
      width: innerWidth, documentWidth: document.documentElement.scrollWidth,
      toolbarWidth: toolbar.clientWidth, toolbarScrollWidth: toolbar.scrollWidth,
      returnBox, overlaps, clipped,
      cardControls: {
        readingTitles: readingButtons.map(button => button.title), ratingItems: ratingItems.length,
        rowIntersection: Math.min(...cardControls.map(r => r.bottom)) - Math.max(...cardControls.map(r => r.y)),
        insideCard: cardControls.every(r => r.x >= cardBox.x - 1 && r.right <= cardBox.right + 1),
      },
      statistics: { visibleItems: statisticsItems.length, box: ticker ? box(ticker) : null, clipped: statisticsClipped },
    };
  });
  assert(result.documentWidth <= width + 1, `Document overflows at ${width}px: ${JSON.stringify(result)}`);
  assert(result.toolbarScrollWidth <= result.toolbarWidth + 1, `Toolbar clips controls at ${width}px: ${JSON.stringify(result)}`);
  assert.deepEqual(result.clipped, [], `Controls leave the viewport at ${width}px`);
  assert.deepEqual(result.overlaps, [], `Return button covers pagination controls at ${width}px`);
  assert(result.returnBox.x >= 0 && result.returnBox.right <= width + 1, 'Return button is outside the viewport');
  assert.equal(result.statistics.visibleItems, 7, `The statistics row must show all seven totals at ${width}px`);
  assert.deepEqual(result.statistics.clipped, [], `The statistics row is clipped by an ancestor at ${width}px`);
  assert.equal(result.cardControls.readingTitles.length, 2, `A book must retain two separate reading actions at ${width}px`);
  assert.match(result.cardControls.readingTitles[0], /外置|外部/, 'The external reading action lost its explanatory title');
  assert.match(result.cardControls.readingTitles[1], /内置|内部/, 'The internal reading action lost its explanatory title');
  assert.equal(result.cardControls.ratingItems, 5, 'A book must retain all five rating controls');
  assert(result.cardControls.rowIntersection > 0 && result.cardControls.insideCard, `Reading buttons, status and rating wrap or overflow at ${width}px: ${JSON.stringify(result.cardControls)}`);
  return result;
}

async function stripedRefraction(page) {
  // A temporary striped sheet behind the real return control makes optical
  // sampling measurable. Only the fixture page is changed, then fully restored.
  await page.mouse.move(2, 400);
  const prepared = await page.evaluate(() => {
    const lens = document.querySelector('.manager-room-return');
    const previous = { id: lens.id, style: lens.getAttribute('style') };
    lens.id = 'manager-test-optical-control';
    lens.style.zIndex = '2140';
    const r = lens.getBoundingClientRect();
    const sheet = document.createElement('div');
    sheet.id = 'manager-test-optical-sheet';
    sheet.style.cssText = `position:fixed;pointer-events:none;z-index:2139;left:${r.x - 40}px;top:${r.y - 40}px;width:${r.width + 80}px;height:${r.height + 80}px;background:repeating-linear-gradient(115deg,#142748 0 14px,#f5ead9 14px 28px,#648eb0 28px 42px,#eab7a3 42px 56px)`;
    document.body.append(sheet);
    const freeze = document.createElement('style');
    freeze.id = 'manager-test-optical-freeze';
    freeze.textContent = '#manager-test-optical-control,#manager-test-optical-control::before,#manager-test-optical-control::after{transition:none!important;animation:none!important}';
    document.head.append(freeze);
    return { previous, clip: { x: Math.floor(r.x), y: Math.floor(r.y), width: Math.ceil(r.width), height: Math.ceil(r.height) } };
  });
  let withOptics;
  let withoutOptics;
  try {
    await page.waitForTimeout(250);
    withOptics = await page.screenshot({ clip: prepared.clip, path: path.join(out, 'optics-striped.png') });
    const replaced = await page.evaluate(() => {
      const lens = document.querySelector('#manager-test-optical-control');
      const overrides = [];
      for (const pseudo of ['', '::before', '::after']) {
        const style = getComputedStyle(lens, pseudo || null);
        const backdrop = style.backdropFilter || style.webkitBackdropFilter;
        if (/url\(/.test(backdrop)) {
          const replacement = backdrop.replace(/url\((?:[^()]|\([^)]*\))*\)/g, 'blur(0px)');
          overrides.push(`#manager-test-optical-control${pseudo}{backdrop-filter:${replacement}!important;-webkit-backdrop-filter:${replacement}!important}`);
        }
      }
      const sheet = document.createElement('style');
      sheet.id = 'manager-test-optical-disable';
      sheet.textContent = overrides.join('\n');
      document.head.append(sheet);
      return overrides.length;
    });
    assert(replaced > 0, 'The real control has no SVG backdrop-filter to compare');
    await page.waitForTimeout(100);
    withoutOptics = await page.screenshot({ clip: prepared.clip, path: path.join(out, 'optics-no-refraction.png') });
    const difference = await page.evaluate(async ({ first, second }) => {
      const decode = source => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = img.width; canvas.height = img.height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0);
          resolve({ canvas, pixels: ctx.getImageData(0, 0, img.width, img.height) });
        };
        img.onerror = reject;
        img.src = source;
      });
      const [a, b] = await Promise.all([decode(first), decode(second)]);
      let changed = 0;
      let total = 0;
      for (let i = 0; i < a.pixels.data.length; i += 4) {
        let maximum = 0;
        for (let c = 0; c < 3; c += 1) {
          const delta = Math.abs(a.pixels.data[i + c] - b.pixels.data[i + c]);
          total += delta; maximum = Math.max(maximum, delta);
          a.pixels.data[i + c] = Math.min(255, delta * 6);
        }
        if (maximum > 3) changed += 1;
        a.pixels.data[i + 3] = 255;
      }
      a.canvas.getContext('2d').putImageData(a.pixels, 0, 0);
      return { changed, meanDifference: total / (a.pixels.data.length / 4 * 3), diff: a.canvas.toDataURL() };
    }, { first: 'data:image/png;base64,' + withOptics.toString('base64'), second: 'data:image/png;base64,' + withoutOptics.toString('base64') });
    fs.writeFileSync(path.join(out, 'optics-difference.png'), Buffer.from(difference.diff.split(',')[1], 'base64'));
    delete difference.diff;
    assert(difference.changed > 20 && difference.meanDifference > 0.08, 'SVG refraction did not visibly change the striped backdrop: ' + JSON.stringify(difference));
    pass('The real glass control visibly refracts a striped backdrop through its SVG backdrop filter', difference);
    report.screenshots.push(...['optics-striped.png', 'optics-no-refraction.png', 'optics-difference.png'].map(name => path.join(out, name)));
  } finally {
    await page.evaluate(({ previous }) => {
      for (const id of ['manager-test-optical-sheet', 'manager-test-optical-freeze', 'manager-test-optical-disable']) document.getElementById(id)?.remove();
      const lens = document.getElementById('manager-test-optical-control');
      lens.id = previous.id;
      if (previous.style === null) lens.removeAttribute('style'); else lens.setAttribute('style', previous.style);
    }, prepared);
  }
}

async function mainChecks(browser, fixtures) {
  const { context, page, model } = await openManager(browser, fixtures);
  try {
    await optics(page, 'refraction');
    assert.equal(await page.locator('#manager-liquid-filters').count(), 1);
    assert.equal(await page.locator('.book-card[data-manager-glass], .book-card [data-manager-glass]').count(), 0);
    assert.equal(await page.locator('.book-card-frame').count(), 24);
    pass('Glass resources start once; virtualized books remain available without per-card refraction');
    pass('The settled manager schedules no idle animation frames', await quietRAF(page, 'Initial manager'));

    await page.locator('[data-manager-theme-open]').click();
    await page.locator('.manager-appearance').waitFor({ state: 'visible' });
    await screenshot(page, 'appearance');
    await page.locator('.manager-appearance [data-theme-choice="paper"]').click();
    await page.waitForFunction(() => document.documentElement.dataset.roomTheme === 'paper' && !document.querySelector('#manager-liquid-filters'));
    assert.equal(await page.locator('[data-manager-glass]').count(), 0);
    assert.equal(await page.locator('[style*="--mg-filter"]').count(), 0);
    await page.locator('.manager-appearance [data-theme-choice="glass"]').click();
    await optics(page, 'refraction');
    assert.equal(await page.locator('#manager-liquid-filters').count(), 1);
    await dismiss(page, '.setting-dialog');
    await page.waitForTimeout(350);
    assert.equal(model.setting.theme, 'glass');
    assert.equal(model.setting.library, '仅供自动检查的模拟书库');
    assert.equal(model.setting.imageExplorer, '');
    pass('Theme switching releases and restores optical resources while preserving unrelated settings');

    await searchOne(page);
    pass('Search filters and restores the library with refraction active');
    await page.locator('.sort-select').click();
    await page.locator('.el-select-dropdown:visible').waitFor();
    await screenshot(page, 'sort-menu');
    await page.getByRole('option', { name: '页数倒序', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.book-title')?.textContent.trim() === '静物档案 36');
    await page.locator('.sort-select').click();
    await page.getByRole('option', { name: '页数正序', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.book-title')?.textContent.trim() === '静物档案 01');
    pass('The sorting popover remains selectable and changes the displayed book order');

    await page.locator('.book-cover').first().click({ button: 'right' });
    await page.locator('.mx-context-menu:visible').waitFor();
    await page.waitForFunction(() => document.querySelector('.mx-context-menu')?.dataset.managerGlass === 'lens');
    await screenshot(page, 'context-menu');
    await page.keyboard.press('Escape');
    // The context-menu package also dismisses on outside pointer input.
    if (await page.locator('.mx-context-menu:visible').count()) await page.locator('.library-hero').click({ position: { x: 10, y: 10 } });
    await page.locator('.mx-context-menu:visible').waitFor({ state: 'hidden' });
    pass('Right-click menus remain visible, clickable, and dismissible above the library');

    await page.locator('[data-manager-theme-open]').click();
    await page.locator('.setting-dialog [role="tab"]').first().click();
    await screenshot(page, 'settings');
    assert(await page.locator('.setting-dialog input:visible').count() > 0);
    await settingsChecks(page, model);
    await dismiss(page, '.setting-dialog');
    await page.locator('.book-title').first().click();
    await page.locator('.catalog-shell').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelector('.catalog-bar')?.dataset.managerGlass === 'lens');
    pass('The reading action keeps white text and an opaque fill before and during hover, while delete remains visually distinct', await assertCatalogActions(page));
    await screenshot(page, 'book-detail');
    assert(!/NaN|Invalid Date/.test(await page.locator('.catalog-shell').textContent()), 'The fixture details contain invalid numeric or date metadata');
    await page.locator('.catalog-close').click();
    await page.locator('.catalog-shell').waitFor({ state: 'hidden' });
    assert(await page.locator('.book-card:visible').count() > 0);
    pass('Settings and full-screen book details preserve their controls and return to the library');

    await page.locator('.app-toolbar button').first().click();
    await page.locator('.folder-tree-drawer').waitFor({ state: 'visible' });
    assert(await page.locator('.folder-tree-drawer').getByText('模拟书库', { exact: true }).isVisible());
    await screenshot(page, 'folder-drawer');
    await page.locator('.folder-tree-drawer .el-drawer__close-btn').click();
    await page.locator('.folder-tree-drawer').waitFor({ state: 'hidden' });
    pass('The folder drawer displays only its fixture tree and closes normally');

    // The original Vue toolbar has two icon-only management buttons: collections
    // then tags. Restrict the positional lookup to this existing final group.
    await page.locator('.app-toolbar .toolbar-group').last().locator('button').last().click();
    await page.locator('.book-tag-edit-card').first().waitFor();
    const tagPanel = await assertPanelControls(page, '.book-tag-edit-operation');
    await page.locator('.book-tag-edit-operation').getByRole('button', { name: '全选', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.book-tag-edit-card.is-picked').length === 24);
    await page.locator('.book-tag-edit-operation').getByRole('button', { name: '全不选', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.book-tag-edit-card.is-picked').length === 0);
    const card = page.locator('.book-tag-edit-card').first();
    const unselected = await card.evaluate(el => { const s = getComputedStyle(el); return [s.borderColor, s.background, s.boxShadow]; });
    await card.click();
    await page.locator('.book-tag-edit-card.is-picked').first().waitFor();
    const selected = await card.evaluate(el => { const s = getComputedStyle(el); return [s.borderColor, s.background, s.boxShadow]; });
    assert.notDeepEqual(selected, unselected, 'Glass styling erases the selected card state');
    await screenshot(page, 'tag-management');
    await page.locator('.app-toolbar .toolbar-group').last().locator('button').last().click();
    await page.locator('.book-card').first().waitFor();
    pass('Tag management keeps every operation reachable, selects and clears all books, and gives selected books a visible state', tagPanel);

    await page.locator('.pagination-bar .btn-next').click();
    await page.waitForFunction(() => document.querySelectorAll('.book-card-frame').length === 12);
    await page.locator('.pagination-bar .btn-prev').click();
    await page.waitForFunction(() => document.querySelectorAll('.book-card-frame').length === 24);
    pass('Pagination changes and restores the visible book group');
    await page.locator('.book-card-area').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await page.waitForFunction(() => document.documentElement.dataset.managerScrolling === 'true');
    await page.waitForFunction(() => !document.documentElement.hasAttribute('data-manager-scrolling'));
    await page.locator('.book-card-area').evaluate(el => { el.scrollTop = 0; });
    await page.waitForTimeout(650);
    pass('Scrolling settles and clears the transient optical interaction state');

    for (const width of [1560, 1280, 950, 720]) {
      const layout = await assertLayout(page, width);
      await screenshot(page, 'library-' + width);
      pass(`At ${width}px, the toolbar and statistics are fully visible and the return button does not cover pagination`, layout);
    }
    await page.setViewportSize({ width: 1560, height: 1040 });
    await page.waitForTimeout(250);
    await stripedRefraction(page);
    pass('Opening panels, resizing, and optical verification leave no idle animation loop', await quietRAF(page, 'Manager after interactions'));

    await page.emulateMedia({ forcedColors: 'active' });
    await optics(page, 'reduced');
    assert.equal(await page.locator('#manager-liquid-filters').count(), 0);
    await screenshot(page, 'forced-colors');
    await searchOne(page);
    await page.emulateMedia({ forcedColors: 'none' });
    await optics(page, 'refraction');
    pass('A live forced-colors change releases refraction, keeps search usable, and restores the material afterward');

    await page.getByRole('button', { name: '返回 3D 阅览室', exact: true }).click();
    await page.locator('.shell').waitFor();
    assert.equal(await page.locator('#manager-liquid-filters').count(), 0);
    await page.locator('[data-action="classic"]').first().click();
    await page.locator('.app-toolbar').waitFor();
    await optics(page, 'refraction');
    assert.equal(await page.locator('#manager-liquid-filters').count(), 1);
    assert.equal(await page.locator('html').getAttribute('data-room-theme'), 'glass');
    pass('Returning to the reading room and reopening the manager retains the theme without stale manager resources');
  } catch (error) {
    try { await screenshot(page, 'main-failure'); }
    catch (captureError) { report.diagnostics.push('Failure screenshot could not be captured: ' + captureError.message); }
    throw error;
  } finally {
    await context.close();
  }
}

async function collectionChecks(browser, fixtures) {
  const { context, page } = await openManager(browser, { ...fixtures, books: fixtures.books.slice(0, 8) }, { withCollection: true });
  try {
    await optics(page, 'refraction');
    const collection = page.locator('.book-card').filter({ has: page.locator('.book-title', { hasText: '中性样例合集' }) });
    // Collections can occur after the first virtualized rows; locating the frame
    // after scrolling exercises the real lazy-rendering path.
    if (await collection.count() === 0) await page.locator('.book-card-area').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await collection.locator('.book-cover').click();
    await page.locator('.collection-drawer').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.collection-drawer .book-card').count(), 2);
    await screenshot(page, 'collection-drawer');
    await page.locator('.collection-drawer .collection-edit-button').click();
    await page.locator('.collection-drawer').waitFor({ state: 'hidden' });
    await page.locator('.book-collection').waitFor({ state: 'visible' });
    assert(await page.locator('.book-collect-card.is-picked').count() > 0);
    assert.equal(await page.locator('.book-collection-line').count(), 2);
    const collectionPanel = await assertPanelControls(page, '.book-collection');
    await screenshot(page, 'collection-management');
    pass('A fixture collection opens its drawer and its reachable management sidebar with the correct two books', collectionPanel);
  } finally {
    await context.close();
  }
}

async function preferenceChecks(browser, fixtures) {
  for (const item of [
    { name: 'reduced-motion', options: { reducedMotion: 'reduce' }, mode: 'refraction' },
    { name: 'reduced-transparency', options: { reducedTransparency: true }, mode: 'reduced' },
    { name: 'firefox-fallback', options: { firefoxIdentity: true }, mode: 'frosted' },
  ]) {
    const { context, page } = await openManager(browser, fixtures, item.options);
    try {
      await optics(page, item.mode);
      await page.waitForTimeout(450);
      if (item.mode !== 'refraction') assert.equal(await page.locator('#manager-liquid-filters').count(), 0);
      if (item.options.reducedMotion) {
        const toolbar = page.locator('.app-toolbar');
        const before = await toolbar.getAttribute('style');
        await toolbar.hover({ position: { x: 70, y: 20 } });
        await page.waitForTimeout(150);
        assert.equal(await toolbar.getAttribute('style'), before, 'Reduced motion still updates pointer-driven optical styles');
        const perpetual = await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations === Infinity).length);
        assert.equal(perpetual, 0, 'Reduced motion leaves an infinite visual animation running');
      }
      await searchOne(page);
      await screenshot(page, item.name);
      const idle = await quietRAF(page, item.name);
      pass(`${item.name} keeps the library usable and the renderer idle in ${item.mode} mode`, idle);
      if (item.options.firefoxIdentity) report.diagnostics.push('Firefox fallback was tested by a Firefox user-agent in Chromium; this does not claim native Firefox rendering coverage.');
      if (item.options.reducedTransparency) report.diagnostics.push('Reduced transparency was supplied through matchMedia because Playwright has no native reduced-transparency emulation option.');
    } finally {
      await context.close();
    }
  }
}

async function run() {
  fs.mkdirSync(out, { recursive: true });
  const fixtures = createFixtures(path.join(out, 'fixtures'), 36);
  const browser = await chromium.launch(launchOptions());
  try {
    await mainChecks(browser, fixtures);
    await collectionChecks(browser, fixtures);
    await preferenceChecks(browser, fixtures);
    assert.deepEqual(report.errors, [], 'The isolated manager emitted browser errors');
    pass('All exercised manager views completed without browser errors');
  } catch (error) {
    report.errors.push(error.stack || error.message);
    throw error;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
  }
}

module.exports = {
  openManager, optics, screenshot, settleVisuals, modelFor, assertLayout, assertCatalogActions, assertPanelControls,
  createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL,
  dismiss, quietRAF, searchOne, stripedRefraction, report, out, run,
  assertSettingsFields, assertSettingsShortcuts, settingsChecks,
};

if (require.main === module) {
  run().catch(error => { console.error(error); process.exitCode = 1; });
}
