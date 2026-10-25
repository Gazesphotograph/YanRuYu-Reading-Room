'use strict';

// Isolated scene regression and rendering-work checks. Only neutral generated
// covers are used; no desktop process, IPC bridge or library database is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, launchOptions } = require('./test-gallery.cjs');

const base = path.resolve(__dirname, '..');
const output = path.resolve(process.env.SCENE_TEST_OUTPUT || path.join(__dirname, '.artifacts', 'scene-motion'));
const report = { source: 'isolated neutral scene', checks: [], errors: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };

async function settled(page) {
  const stable = await page.evaluate(() => new Promise(resolve => {
    const start = performance.now();
    let previous = -1, quietSince = start;
    const sample = () => {
      const now = performance.now(), count = window.scene.frameCount;
      if (count !== previous) { previous = count; quietSince = now; }
      if (count > 0 && now - quietSince >= 240) return resolve(true);
      if (now - start >= 8000) return resolve(false);
      setTimeout(sample, 40);
    };
    sample();
  }));
  assert(stable, 'The scene should stop rendering when movement has settled');
}

async function metrics(page, reset = false) {
  return page.evaluate(reset => {
    if (reset) for (const key of Object.keys(window.sceneWork)) window.sceneWork[key] = 0;
    return { ...window.sceneWork };
  }, reset);
}

async function blankDragPoint(page) {
  return page.evaluate(() => {
    const canvas = window.scene.renderer.domElement, box = canvas.getBoundingClientRect();
    for (const yOffset of [18, 60, 100, box.height - 80]) {
      for (const fraction of [.5, .7, .3]) {
        const x = box.left + box.width * fraction, y = box.top + yOffset;
        if (Array.from({ length: 17 }, (_, i) => x - 160 + i * 20).every(px => document.elementFromPoint(px, y) === canvas)) return { x, y };
      }
    }
    throw new Error('A clear canvas drag path was not found');
  });
}

async function drag(page, point, delta, button = 'left') {
  await page.mouse.move(point.x, point.y);
  await page.mouse.down({ button });
  await page.mouse.move(point.x + delta, point.y, { steps: 8 });
  await page.mouse.up({ button });
  await page.mouse.move(0, 0);
  await settled(page);
}

async function resetCamera(page) {
  await page.locator('[data-scene-camera="reset"]').click();
  await page.mouse.move(0, 0);
  await settled(page);
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const fixtures = createFixtures(path.join(output, 'fixtures'), 3);
  const books = fixtures.books.map(book => ({ id: book.id, title: book.title, cover: pathToFileURL(book.coverPath).href, pages: book.pageCount, mark: false, progress: 0 }));
  const source = pathToFileURL(path.join(base, 'resources', 'app', 'dist', 'room-scene.js')).href;
  const styles = ['room.css', 'room-scene.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(base, 'resources', 'app', 'dist', file)).href}">`).join('');
  const harness = path.join(output, 'scene-harness.html');
  fs.writeFileSync(harness, `<!doctype html><html><head><meta charset="utf-8">${styles}<style>html,body{overflow:auto;height:auto}body{min-height:2000px}.scene-viewport{margin:40px;width:calc(100% - 80px);height:600px}</style></head><body><div class="scene-viewport"></div><script type="module">
    import { RoomScene } from ${JSON.stringify(source)};
    const scene = window.scene = new RoomScene(document.querySelector('.scene-viewport'));
    window.sceneWork = { builds:0, renders:0, shadows:0, projections:0, bufferResizes:0 };
    for (const [name, counter] of [['build','builds'], ['positionTargets','projections']]) {
      const original = scene[name].bind(scene);
      scene[name] = (...args) => { window.sceneWork[counter]++; return original(...args); };
    }
    const render = scene.renderer.render.bind(scene.renderer), resize = scene.renderer.setSize.bind(scene.renderer);
    scene.renderer.render = (...args) => { window.sceneWork.renders++; if (scene.renderer.shadowMap.needsUpdate) window.sceneWork.shadows++; return render(...args); };
    scene.renderer.setSize = (...args) => { window.sceneWork.bufferResizes++; return resize(...args); };
    scene.setBooks(window.fixtureBooks, 'glass');
  </script></body></html>`, 'utf8');

  const browser = await chromium.launch(launchOptions());
  const context = await browser.newContext({ viewport: { width: 1480, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.errors.push(error.message));
  let releaseCover;
  try {
    await context.addInitScript(books => { window.fixtureBooks = books; }, books);
    await page.goto(pathToFileURL(harness).href);
    await page.waitForFunction(() => window.scene?.element.dataset.sceneState === 'ready' && window.scene.items.every(item => item.button.dataset.coverState === 'loaded'));
    await settled(page);
    await metrics(page, true);
    const kept = await page.evaluate(() => {
      const scene = window.scene, world = scene.world, buttons = scene.items.map(item => item.button);
      scene.setBooks(scene.books.map(book => ({ ...book })), 'glass');
      scene.resize();
      return scene.world === world && scene.items.every((item, index) => item.button === buttons[index]);
    });
    await settled(page);
    assert(kept, 'Unchanged visible books must retain their scene and interactive targets');
    assert.deepEqual(await metrics(page), { builds: 0, renders: 0, shadows: 0, projections: 0, bufferResizes: 0 });
    pass('An unchanged refresh preserves the room and performs no render, rebuild or canvas resize');

    const marked = await page.evaluate(() => {
      const scene = window.scene, world = scene.world, button = scene.items[0].button;
      scene.setBooks(scene.books.map((book, index) => ({ ...book, mark: index === 0, progress: index === 0 ? 44 : 0 })), 'glass');
      return { same: scene.world === world && scene.items[0].button === button, favorite: !!button.querySelector('.scene-book-favorite'), progress: button.querySelector('.scene-book-progress')?.style.getPropertyValue('--progress'), label: button.getAttribute('aria-label') };
    });
    assert(marked.same && marked.favorite);
    assert.equal(marked.progress, '44%');
    assert.match(marked.label, /44%/);
    await settled(page);
    assert.equal((await metrics(page)).renders, 0);
    pass('Favorite and progress refreshes update accessible book markers without rebuilding or rendering the scene');

    const point = await blankDragPoint(page);
    await metrics(page, true);
    await drag(page, point, -150);
    const left = await page.evaluate(() => ({ yaw: scene.yaw, panX: scene.panX, panY: scene.panY, zoom: scene.zoom }));
    assert(left.yaw > .25 && left.yaw <= .29, 'A leftward drag must now increase yaw, reversing the former direction');
    assert.equal(left.panX, 0);assert.equal(left.panY, 0);assert.equal(left.zoom, 1);
    await resetCamera(page);
    await drag(page, point, 150);
    const right = await page.evaluate(() => scene.yaw);
    assert(right < -.25 && right >= -.29, 'A rightward drag must now decrease yaw');
    const cameraWork = await metrics(page);
    assert(cameraWork.renders > 3, 'Camera motion should still animate');
    assert.equal(cameraWork.shadows, 0, 'Camera-only movement must reuse the existing light-space shadows');
    pass('Left and right drags are reversed, remain bounded, animate normally and reuse static shadows');

    await resetCamera(page);
    const originalWidth = await page.locator('.scene-book-target').first().evaluate(button => parseFloat(button.style.width));
    await metrics(page, true);
    await page.mouse.move(point.x, point.y);
    const scroll = await page.evaluate(() => scrollY);
    await page.mouse.wheel(0, -260);
    await page.mouse.move(0, 0);
    await settled(page);
    assert((await page.evaluate(() => scene.zoom)) > 1);
    assert((await page.locator('.scene-book-target').first().evaluate(button => parseFloat(button.style.width))) > originalWidth);
    assert.equal(await page.evaluate(() => scrollY), scroll);
    assert.equal((await metrics(page)).shadows, 0);
    await resetCamera(page);
    const middleBook = await page.locator('.scene-book-target').first().boundingBox();
    await drag(page, { x: middleBook.x + middleBook.width / 2, y: middleBook.y + middleBook.height / 2 }, 90, 'middle');
    const panned = await page.evaluate(() => ({ yaw: scene.yaw, panX: scene.panX, zoom: scene.zoom }));
    assert(panned.panX < 0 && panned.yaw === 0 && panned.zoom === 1, 'Middle drag must retain its existing pan direction and preserve rotation and zoom');
    await resetCamera(page);
    assert(Math.abs((await page.locator('.scene-book-target').first().evaluate(button => parseFloat(button.style.width))) - originalWidth) < 1);
    pass('Wheel zoom, middle-button panning and reset preserve their behavior and correctly projected book targets');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await settled(page);
    await metrics(page, true);
    await page.evaluate(() => {
      for (let i = 0; i < 40; i++) { scene.targetYaw = i * .005; scene.requestCameraUpdate(); }
    });
    await settled(page);
    const coalesced = await metrics(page);
    assert.equal(coalesced.renders, 1);
    assert.equal(coalesced.projections, 1);
    assert.equal(coalesced.shadows, 0);
    assert.equal(await page.evaluate(() => scene.yaw), .195);
    pass('Rapid reduced-motion camera updates coalesce into one render and one target projection');

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await settled(page);
    await page.evaluate(() => { scene.setSuspended(true); scene.targetYaw = -.2; scene.requestCameraUpdate(); });
    await metrics(page, true);
    await page.waitForTimeout(180);
    assert.equal((await metrics(page)).renders, 0);
    await page.evaluate(() => scene.setSuspended(false));
    await settled(page);
    assert((await metrics(page)).renders > 0);
    await page.evaluate(() => scrollTo(0, 1100));
    await page.waitForFunction(() => scene.inView === false);
    await metrics(page, true);
    await page.evaluate(() => { scene.targetYaw = 0; scene.requestCameraUpdate(); });
    await page.waitForTimeout(180);
    assert.equal((await metrics(page)).renders, 0);
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForFunction(() => scene.inView === true);
    await settled(page);
    assert((await metrics(page)).renders > 0);
    pass('Suspended and fully offscreen scenes stop rendering and resume with the requested camera state');

    let requests = 0;
    const delayedURL = 'https://scene-fixture.invalid/neutral-delayed-cover.svg';
    const coverGate = new Promise(resolve => { releaseCover = resolve; });
    await page.route(delayedURL, async route => {
      requests++;
      await coverGate;
      await route.fulfill({ contentType: 'image/svg+xml', headers: { 'access-control-allow-origin': '*' }, body: fs.readFileSync(fixtures.books[0].coverPath, 'utf8') });
    });
    const requested = page.waitForRequest(delayedURL);
    await page.evaluate(url => {
      const books = scene.books.map(book => ({ ...book, cover: url }));
      for (let cycle = 0; cycle < 4; cycle++) scene.setBooks(books.map((book, index) => ({ ...book, id: `delayed-${cycle}-${index}`, title: `Neutral delayed cover ${cycle} / ${index}` })), 'glass');
    }, delayedURL);
    await requested;
    await page.waitForTimeout(150);
    assert.equal(requests, 1, 'Repeated books and rapid refreshes must share their pending cover request');
    releaseCover();
    await page.waitForFunction(() => scene.items.every(item => item.button.dataset.coverState === 'loaded'));
    await settled(page);
    assert.deepEqual(await page.locator('.scene-book-target').evaluateAll(buttons => buttons.map(button => button.dataset.book)), ['delayed-3-0', 'delayed-3-1', 'delayed-3-2']);
    assert.equal(requests, 1);
    pass('Rapid page changes share one pending cover load and only the latest visible books receive it');

    assert.deepEqual(report.errors, [], 'Scene checks must not emit uncaught browser errors');
    await page.screenshot({ path: path.join(output, 'neutral-scene.png') });
    await page.evaluate(() => scene.dispose());
  } finally {
    releaseCover?.();
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(output, 'checks.json'), JSON.stringify(report, null, 2), 'utf8');
  }
  console.log(`${report.checks.length} scene checks passed. Report: ${path.join(output, 'checks.json')}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
