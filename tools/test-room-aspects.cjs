'use strict';

// Synthetic covers only. This suite never opens the desktop process or library.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { launchOptions, createFakeModel, attachFakeIpc, appURL } = require('./test-gallery.cjs');

const app = path.resolve(__dirname, '../resources/app/dist');
const output = path.resolve(__dirname, '.artifacts/room-aspects');
const report = { source: 'neutral mixed-aspect covers', checks: [], errors: [], themes: [] };
const themes = ['paper', 'glass', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid'];
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };
const definitions = [
  { name: 'PORTRAIT', w: 500, h: 707 },
  { name: 'SQUARE', w: 650, h: 650 },
  { name: 'LANDSCAPE', w: 1000, h: 650 },
  { name: 'PANORAMA', w: 1200, h: 480 },
  { name: 'TALL', w: 390, h: 900 },
  { name: 'LEGACY WIDE', w: 500, h: 707, content: [0, 203, 500, 300] },
  { name: 'LEGACY SQUARE', w: 500, h: 707, content: [0, 103, 500, 500] },
  { name: 'LEGACY TALL', w: 500, h: 707, content: [90, 0, 320, 707] },
  { name: 'ALMOST SQUARE', w: 700, h: 750 },
  { name: 'CINEMA', w: 1600, h: 900 },
  { name: 'MISSING COVER', w: 500, h: 707, missing: true },
  { name: 'WIDE STRIP', w: 1600, h: 400 },
];

function fixtures() {
  fs.mkdirSync(output, { recursive: true });
  return definitions.map((d, index) => {
    const coverPath = path.join(output, `cover-${index}.svg`);
    const [x, y, width, height] = d.content || [0, 0, d.w, d.h];
    const color = ['#536d67', '#aa8a70', '#677889', '#987678'][index % 4];
    const unit = Math.min(width, height);
    if (!d.missing) fs.writeFileSync(coverPath, `<svg xmlns="http://www.w3.org/2000/svg" width="${d.w}" height="${d.h}" viewBox="0 0 ${d.w} ${d.h}"><rect width="100%" height="100%" fill="#303133"/><svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="${color}"/><path d="M0 ${height * .17} Q${width * .3} ${height * .48} ${width} ${height * .17}V${height * .72}H0Z" fill="#b3c0ad" opacity=".45"/><circle cx="${width * .69}" cy="${height * .41}" r="${unit * .18}" fill="#dbcca7"/><rect x="${width * .08}" y="${height * .66}" width="${width * .62}" height="${unit * .016}" fill="#f1eadb"/><text x="${width * .08}" y="${height * .78}" font-family="Georgia,serif" font-size="${unit * .078}" fill="#f1eadb">Still Life ${String(index + 1).padStart(2, '0')}</text><text x="${width * .08}" y="${height * .85}" font-family="Arial,sans-serif" font-size="${unit * .038}" fill="#f1eadb">${d.name}</text><text x="${width * .08}" y="${height * .90}" font-family="Arial,sans-serif" font-size="${unit * .024}" fill="#f1eadb">YAN RU YU / NEUTRAL TEST COVER</text></svg></svg>`, 'utf8');
    return { id: `aspect-${index}`, title: `静物集 ${index + 1} · ${d.name}`, coverPath, filepath: path.join(output, `book-${index}`), pageCount: 100 + index, createdAt: new Date(Date.UTC(2026, 8, 12 - index)).toISOString(), tags: {}, mark: false };
  });
}

async function settled(page) {
  await page.waitForFunction(() => window.scene?.element.dataset.sceneState === 'ready' && window.scene.items.every(item => item.button.dataset.coverState !== 'loading'));
  assert(await page.evaluate(() => new Promise(resolve => {
    const start = performance.now(); let count = -1, quiet = start;
    const sample = () => {
      const now = performance.now();
      if (scene.frameCount !== count) { count = scene.frameCount; quiet = now; }
      if (now - quiet > 200) return resolve(true);
      if (now - start > 10000) return resolve(false);
      setTimeout(sample, 40);
    }; sample();
  })), 'The decorated room should become idle');
}

async function geometryAndTargets(page) {
  return page.evaluate(() => {
    const canvas = scene.renderer.domElement.getBoundingClientRect();
    return scene.items.map(item => {
      const r = item.button.getBoundingClientRect();
      const centerX = r.left + r.width / 2, centerY = r.top + r.height / 2;
      return { id: item.button.dataset.book, aspect: item.aspect, ratio: item.width / item.height, format: item.button.dataset.coverFormat, cropped: item.button.dataset.coverCropped === 'true', state: item.button.dataset.coverState,
        onShelf: Math.abs(item.group.position.y - item.baseY) < .001,
        hit: document.elementFromPoint(centerX, centerY)?.closest('[data-book]') === item.button,
        contained: r.left >= canvas.left && r.right <= canvas.right && r.top >= canvas.top && r.bottom <= canvas.bottom,
        width: r.width, height: r.height };
    });
  });
}

async function main() {
  const books = fixtures();
  const { bookRowLayout } = await import(pathToFileURL(path.join(app, 'room-book-layout.js')).href);
  for (const a of [.12, .45, .707, 1, 1.5, 2.6, 4, 12]) for (const b of [.5, 1, 1.9, 3.4]) {
    const input = [a, b, .707].map((aspect, index) => ({ aspect, depth: .22, rotation: -.1 + index * .03 }));
    const row = bookRowLayout(input);
    row.forEach((book, index) => {
      assert(Number.isFinite(book.width) && book.width > 0 && book.height > 0 && book.height <= 1.33);
      assert(Math.abs(book.width / book.height - input[index].aspect) < 1e-10);
      assert(book.x - book.footprint / 2 >= -1.58 - 1e-8 && book.x + book.footprint / 2 <= 1.58 + 1e-8);
      if (index) assert(book.x - book.footprint / 2 - row[index - 1].x - row[index - 1].footprint / 2 >= .12 - 1e-8);
    });
  }
  assert.equal(bookRowLayout([]).length, 0);
  assert(bookRowLayout([{ aspect: NaN }, { aspect: 0 }]).every(book => Number.isFinite(book.width)));
  pass('32 mixed rows preserve exact cover proportions, shelf bounds and spine clearance, including extreme formats');

  const harness = path.join(output, 'scene.html');
  const styles = ['room.css', 'room-themes.css', 'room-scene.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(app, file)).href}">`).join('');
  fs.writeFileSync(harness, `<!doctype html><html><head><meta charset="utf-8">${styles}<style>body{height:auto;overflow:auto}.scene-viewport{margin:32px;width:calc(100% - 64px);height:650px}.scene-viewport.scene-tall{height:960px}</style></head><body><div class="scene-viewport"></div><script type="module">import {RoomScene} from ${JSON.stringify(pathToFileURL(path.join(app, 'room-scene.js')).href)};import {paintTheme} from ${JSON.stringify(pathToFileURL(path.join(app, 'room-themes.js')).href)};window.paintTheme=paintTheme;paintTheme('glass');window.scene=new RoomScene(document.querySelector('.scene-viewport'));scene.setBooks(window.testBooks,'glass');</script></body></html>`, 'utf8');
  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1520, height: 1120 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  page.on('pageerror', error => report.errors.push(error.message));
  try {
    await context.addInitScript(books => { window.testBooks = books; }, books.map(book => ({ id: book.id, title: book.title, cover: pathToFileURL(book.coverPath).href, pages: book.pageCount })));
    await page.goto(pathToFileURL(harness).href);
    await settled(page);
    const initial = await geometryAndTargets(page);
    initial.forEach((book, index) => {
      assert(Math.abs(book.ratio - book.aspect) < 1e-10, `Distorted ${book.id}`);
      assert(book.onShelf && book.hit && book.contained && book.width > 15 && book.height > 15, `Unusable ${book.id}: ${JSON.stringify(book)}`);
      const definition = definitions[index];
      if (definition.content) {
        assert(book.cropped, `Legacy bars remain on ${book.id}`);
        assert(Math.abs(book.aspect / (definition.content[2] / definition.content[3]) - 1) < .025);
      } else if (!definition.missing) assert(Math.abs(book.aspect - definition.w / definition.h) < 1e-10);
    });
    assert.equal(initial[10].state, 'fallback');
    pass('Native portrait, square, landscape and panorama models fit their covers; legacy bars are recovered and missing covers stay usable');

    await page.evaluate(() => scene.setBooks(scene.books.map((book, index) => index === 10 ? { ...book, cover: '' } : book), scene.theme));
    await settled(page);
    assert.equal((await geometryAndTargets(page))[10].state, 'fallback');
    assert.equal(await page.locator('.scene-book-target').count(), 12);
    pass('A book with no cover path still has its placeholder and never prevents the shelf from loading');

    const previous = await page.evaluate(() => {
      const middle = scene.items[1].group.position.x;
      scene.items[0].aspect = 2.4; scene.layoutBookRow(scene.bookRows[0]);
      return middle;
    });
    await settled(page);
    assert.notEqual(await page.evaluate(() => scene.items[1].group.position.x), previous);
    assert((await geometryAndTargets(page)).every(item => item.hit && item.contained));
    await page.evaluate(() => { scene.items[0].aspect = 500 / 707; scene.layoutBookRow(scene.bookRows[0]); });
    await settled(page);
    pass('A newly discovered aspect repositions the entire row and refreshes all projected click targets');

    const firstCount = await page.evaluate(() => scene.frameCount);
    await page.waitForTimeout(320);
    assert.equal(await page.evaluate(() => scene.frameCount), firstCount);
    pass('Window light, dust, plants and animals do not keep WebGL rendering while idle');

    for (const theme of themes) {
      await page.evaluate(theme => { paintTheme(theme); scene.setTheme(theme); }, theme);
      await settled(page);
      assert((await geometryAndTargets(page)).every(item => item.hit && item.contained && item.onShelf));
      const info = await page.evaluate(() => ({ theme: scene.theme, label: scene.environment.label, textures: scene.renderer.info.memory.textures, geometries: scene.renderer.info.memory.geometries, calls: scene.renderer.info.render.calls, world: scene.world.children.length, decor: scene.environment.group.children.length }));
      assert(info.decor > 2 && info.label);
      report.themes.push(info);
      await page.screenshot({ path: path.join(output, `mixed-${theme}.png`) });
    }
    pass('All eight decorated themes retain twelve visible, bottom-aligned and clickable mixed-format books');

    await page.evaluate(() => { paintTheme('glass'); scene.setTheme('glass'); });
    await settled(page);
    const baseline = await page.evaluate(() => ({ textures: scene.renderer.info.memory.textures, geometries: scene.renderer.info.memory.geometries }));
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => scene.setTheme('forest')); await settled(page);
      await page.evaluate(() => scene.setTheme('glass')); await settled(page);
    }
    assert.deepEqual(await page.evaluate(() => ({ textures: scene.renderer.info.memory.textures, geometries: scene.renderer.info.memory.geometries })), baseline);
    pass('Repeated theme changes reuse textures and reclaim the previous geometry without growing GPU resources');

    await page.setViewportSize({ width: 720, height: 1120 });
    await settled(page);
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-scene-layout'), 'narrow');
    assert.equal(await page.locator('.scene-book-target').count(), 12);
    assert((await geometryAndTargets(page)).every(item => item.hit && item.contained));
    await page.screenshot({ path: path.join(output, 'mixed-narrow.png') });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-scene-camera="right"]').click();
    await page.mouse.move(0, 0); await settled(page);
    assert((await geometryAndTargets(page)).every(item => item.hit));
    pass('Four-row narrow layouts and reduced-motion camera controls preserve aspect ratios and hit targets');

    await page.setViewportSize({ width: 1520, height: 1120 });
    await page.evaluate(() => { scene.setBooks(testBooks.slice(0, 3), 'paper'); scene.targetYaw = 0; scene.requestCameraUpdate(); });
    await settled(page);
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-scene-layout'), 'single');
    assert((await geometryAndTargets(page)).every(item => item.hit && item.contained));
    await page.screenshot({ path: path.join(output, 'mixed-single.png') });
    pass('Single-shelf rooms retain their reading corner and proportionate books');
    await page.evaluate(() => scene.dispose());

    const ui = await browser.newContext({ viewport: { width: 1560, height: 1000 } });
    await attachFakeIpc(ui, createFakeModel(books, books.filter(book => !definitions[Number(book.id.split('-')[1])].missing).map(book => book.coverPath)));
    await ui.addInitScript(() => localStorage.setItem('room-theme', JSON.stringify('glass')));
    const full = await ui.newPage(); full.on('pageerror', error => report.errors.push(error.message));
    await full.goto(appURL);
    await full.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    await full.waitForFunction(() => [...document.querySelectorAll('.scene-book-target')].every(button => button.dataset.coverState !== 'loading'));
    await full.evaluate(() => document.fonts.ready); await full.waitForTimeout(400);
    assert.match(await full.title(), /颜如玉/);
    assert.equal(await full.locator('.hero h1').textContent(), '书中自有颜如玉');
    await full.screenshot({ path: path.join(output, '颜如玉-纯白玻璃.png'), fullPage: true });
    await full.locator('[data-action="theme"]').first().click();
    await full.locator('[data-theme-choice="forest"]').click(); await full.keyboard.press('Escape');
    await full.waitForFunction(() => document.querySelector('.scene-viewport')?.dataset.sceneTheme === 'forest' && [...document.querySelectorAll('.scene-book-target')].every(button => button.dataset.coverState !== 'loading'));
    await full.waitForTimeout(400);
    await full.screenshot({ path: path.join(output, '颜如玉-林间月光.png'), fullPage: true });
    await full.locator('.scene-book-target').nth(1).click();
    await full.waitForSelector('.drawer');
    assert.match(await full.locator('.drawer h2').textContent(), /SQUARE/);
    await full.keyboard.press('Escape');
    pass('The complete application shows the new brand and slogan and opens the selected square cover correctly');
    await ui.close();
    assert.deepEqual(report.errors, []);
  } finally {
    await context.close(); await browser.close();
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(report, null, 2));
  }
  console.log(`${report.checks.length} aspect and environment checks passed.`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
