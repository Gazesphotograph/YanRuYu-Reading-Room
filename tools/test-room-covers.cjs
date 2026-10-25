'use strict';

// Only generated neutral artwork is read. The real Electron process, library,
// archive extraction and user data directories are never opened by this test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { chromium } = require('./playwright-runtime.cjs');
const { launchOptions } = require('./test-gallery.cjs');

const app = path.resolve(__dirname, '../resources/app');
const output = path.join(__dirname, '.artifacts', 'cover-normalization');
const fixturesDir = path.join(output, 'fixtures');
const appRequire = createRequire(path.join(app, 'package.json'));
const sharp = appRequire('sharp');
const report = { source: 'generated neutral artwork; isolated thumbnail backend', checks: [], results: [], errors: [] };
const pass = name => { report.checks.push(name); console.log('PASS ' + name); };

function artwork(width, height) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#668d8e"/><rect x="0" y="${height / 2}" width="100%" height="${height / 2}" fill="#8e7060"/><circle cx="${width * .65}" cy="${height * .4}" r="${Math.min(width, height) * .25}" fill="#e6d9b9"/><path d="M${width * .08} ${height * .82}L${width * .27} ${height * .5}L${width * .51} ${height * .82}Z" fill="#3c565a"/></svg>`);
}

async function generateFixtures() {
  fs.mkdirSync(fixturesDir, { recursive: true });
  const fixtures = [];
  const save = async (name, pipeline, expected = {}) => {
    const file = path.join(fixturesDir, name);
    await pipeline.toFile(file);
    const { width, height } = await sharp(file).metadata();
    const fixture = { name, file, width, height, crop: false, ...expected };
    fixtures.push(fixture);
    return fixture;
  };
  const shapes = [
    ['portrait', 800, 1200], ['landscape', 1800, 960], ['square', 1100, 1100],
    ['near-square', 990, 1000], ['panorama', 3600, 400], ['tall', 400, 2000],
  ];
  for (const [name, width, height] of shapes) {
    await save(`natural-${name}.png`, sharp(artwork(width, height)), { natural: true, aspect: width / height });
    for (const format of ['webp', 'jpeg', 'png']) {
      const contained = await sharp(artwork(width, height)).resize(500, 707, { fit: 'inside' }).toBuffer({ resolveWithObject: true });
      const contentWidth = contained.info.width, contentHeight = contained.info.height;
      const paddingX = (500 - contentWidth) / 2, paddingY = (707 - contentHeight) / 2;
      await save(`legacy-${name}.${format}`, sharp(artwork(width, height)).flatten({ background: '#ffffff' }).resize(500, 707, { fit: 'contain', background: '#303133' }).toFormat(format), {
        crop: Math.max(paddingX, paddingY) >= 12,
        aspect: contentWidth / contentHeight,
        contentWidth,
        contentHeight,
      });
    }
  }
  await save('native-500x707.png', sharp(artwork(500, 707)), { aspect: 500 / 707 });
  for (const [name, background] of [['black', '#000000'], ['padding-color', '#303133'], ['near-padding-color', '#323335']]) {
    await save(`${name}.png`, sharp({ create: { width: 500, height: 707, channels: 3, background } }));
  }
  await save('original-dark-art.png', sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="500" height="707"><rect width="500" height="707" fill="#303133"/><circle cx="250" cy="354" r="18" fill="#d4d7cf"/></svg>')));
  await save('near-color-bands.png', sharp(artwork(500, 307)).extend({ top: 200, bottom: 200, left: 0, right: 0, background: '#323335' }));
  await save('near-color-content.png', sharp({ create: { width: 500, height: 307, channels: 3, background: '#363639' } }).extend({ top: 200, bottom: 200, left: 0, right: 0, background: '#303133' }));
  await save('asymmetric-bands.png', sharp(artwork(500, 407)).extend({ top: 100, bottom: 200, left: 0, right: 0, background: '#303133' }));
  await save('single-band.png', sharp(artwork(500, 507)).extend({ top: 200, bottom: 0, left: 0, right: 0, background: '#303133' }));
  await save('authored-frame.png', sharp(artwork(360, 547)).extend({ top: 80, bottom: 80, left: 70, right: 70, background: '#303133' }));
  await save('transparent-content.png', sharp({ create: { width: 500, height: 307, channels: 4, background: { r: 50, g: 80, b: 90, alpha: .5 } } }).extend({ top: 200, bottom: 200, left: 0, right: 0, background: '#303133' }));
  await save('different-size-bands.png', sharp(artwork(501, 300)).extend({ top: 204, bottom: 204, left: 0, right: 0, background: '#303133' }));
  const rotated = await save('exif-rotation.jpeg', sharp(artwork(640, 960)).withMetadata({ orientation: 6 }).jpeg(), { natural: true, aspect: 960 / 640, orientedWidth: 960, orientedHeight: 640 });
  assert.equal((await sharp(rotated.file).metadata()).orientation, 6);
  return fixtures;
}

async function verifyThumbnailBackend(fixtures) {
  const temp = path.join(output, 'isolated-temp'), covers = path.join(output, 'isolated-covers');
  fs.mkdirSync(temp, { recursive: true });
  fs.mkdirSync(covers, { recursive: true });
  const allowedInputs = new Set(fixtures.filter(fixture => fixture.natural).map(fixture => fixture.file));
  const loaderFile = path.join(app, 'fileLoader/index.js');
  const requireLoader = createRequire(loaderFile);
  const context = {
    module: { exports: {} }, __dirname: path.dirname(loaderFile), console, setTimeout, clearTimeout,
    require(name) {
      if (name === '../modules/init_folder_setting.js') return { TEMP_PATH: temp, COVER_PATH: covers, VIEWER_PATH: path.join(output, 'isolated-viewer') };
      if (name === './folder.js') return {
        async solveBookTypeFolder(filepath) {
          assert(allowedInputs.has(filepath), 'The thumbnail generator accessed an unexpected file');
          return { targetFilePath: filepath, tempCoverPath: filepath, coverPath: path.join(covers, path.basename(filepath) + '.webp'), pageCount: 1, bundleSize: fs.statSync(filepath).size, mtime: new Date(0) };
        },
      };
      if (name === './archive.js' || name === './zip.js') return {};
      return requireLoader(name);
    },
  };
  vm.runInNewContext(fs.readFileSync(loaderFile, 'utf8'), context, { filename: loaderFile });
  for (const fixture of fixtures.filter(fixture => fixture.natural)) {
    const before = fs.readFileSync(fixture.file);
    const result = await context.module.exports.geneCover(fixture.file, 'folder');
    const metadata = await sharp(result.coverPath).metadata();
    const originalWidth = fixture.orientedWidth || fixture.width, originalHeight = fixture.orientedHeight || fixture.height;
    assert(metadata.width <= 1000 && metadata.height <= 1000, fixture.name);
    assert(metadata.width <= originalWidth && metadata.height <= originalHeight, fixture.name + ' must not upscale');
    assert(Math.abs(metadata.width / metadata.height - fixture.aspect) / fixture.aspect < .004, fixture.name + ' must retain the correctly oriented source ratio');
    assert.deepEqual(fs.readFileSync(fixture.file), before, 'The original artwork must remain unchanged');
    assert.equal(result.coverHash.length, 40);
    report.results.push({ backend: fixture.name, width: metadata.width, height: metadata.height });
  }
  pass('The real thumbnail generator keeps portrait, landscape, square, near-square, panorama and tall proportions within 1000 pixels without upscaling');
  pass('EXIF rotation is applied before resizing; source artwork is unchanged and its hash remains available');
}

async function serve(routes) {
  const server = http.createServer((request, response) => {
    const route = routes.get(new URL(request.url, 'http://127.0.0.1').pathname);
    if (!route) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { 'Content-Type': route.type });
    response.end(route.body || fs.readFileSync(route.file));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function verifyTextureNormalization(fixtures) {
  const harness = '<!doctype html><meta charset="utf-8"><title>Neutral cover normalization test</title><script type="module">import * as THREE from "/three.module.min.js";import {normalizeCoverTexture} from "/room-cover.js";window.THREE=THREE;window.normalizeCoverTexture=normalizeCoverTexture;window.ready=true;</script>';
  fs.writeFileSync(path.join(output, 'harness.html'), harness);
  const routes = new Map([
    ['/', { type: 'text/html', body: harness }],
    ['/three.module.min.js', { type: 'text/javascript', file: path.join(app, 'dist/vendor/three.module.min.js') }],
    ['/room-cover.js', { type: 'text/javascript', file: path.join(app, 'dist/room-cover.js') }],
  ]);
  fixtures.forEach((fixture, index) => routes.set(`/fixture-${index}`, { type: fixture.name.endsWith('.jpeg') ? 'image/jpeg' : fixture.name.endsWith('.webp') ? 'image/webp' : 'image/png', file: fixture.file }));
  const local = await serve(routes);
  const foreign = await serve(new Map([['/foreign-cover', { type: 'image/png', file: fixtures.find(fixture => fixture.name === 'legacy-landscape.png').file }]]));
  let browser;
  try {
    browser = await chromium.launch(launchOptions());
    const page = await browser.newPage();
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(local.origin);
    await page.waitForFunction(() => window.ready);
    const results = await page.evaluate(async inputs => {
      const readPixels = CanvasRenderingContext2D.prototype.getImageData;
      let reads = 0;
      CanvasRenderingContext2D.prototype.getImageData = function (...args) { reads++; return readPixels.apply(this, args); };
      const loadImage = url => new Promise((resolve, reject) => { const img = new Image(); img.onload = () => resolve(img); img.onerror = reject; img.src = url; });
      const results = [];
      for (const input of inputs.fixtures) {
        const image = await loadImage(input.url), texture = new THREE.Texture(image);
        const before = reads;
        const returned = normalizeCoverTexture(texture);
        const after = reads;
        normalizeCoverTexture(texture);
        results.push({ name: input.name, details: texture.userData, width: image.naturalWidth, height: image.naturalHeight, repeat: texture.repeat.toArray(), offset: texture.offset.toArray(), reads: after - before, repeatedReads: reads - after, returnedSame: returned === texture });
        texture.dispose();
      }

      // A genuinely cross-origin image without CORS permission exercises the
      // browser's SecurityError, not a synthetic exception or file-origin flag.
      const foreignImage = await loadImage(inputs.foreign);
      const probe = document.createElement('canvas');
      probe.width = foreignImage.naturalWidth; probe.height = foreignImage.naturalHeight;
      const probeContext = probe.getContext('2d');
      probeContext.drawImage(foreignImage, 0, 0);
      let tainted = false;
      try { probeContext.getImageData(0, 0, 1, 1); } catch (error) { tainted = error.name === 'SecurityError'; }
      const foreignTexture = new THREE.Texture(foreignImage);
      normalizeCoverTexture(foreignTexture);
      const cors = { tainted, details: foreignTexture.userData, repeat: foreignTexture.repeat.toArray(), offset: foreignTexture.offset.toArray() };

      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function () { return null; };
      const noContextTexture = new THREE.Texture(await loadImage(inputs.fixtures.find(fixture => fixture.name === 'legacy-square.png').url));
      normalizeCoverTexture(noContextTexture);
      HTMLCanvasElement.prototype.getContext = getContext;
      CanvasRenderingContext2D.prototype.getImageData = readPixels;
      return { results, cors, noContext: noContextTexture.userData };
    }, { fixtures: fixtures.map((fixture, index) => ({ name: fixture.name, url: `${local.origin}/fixture-${index}` })), foreign: foreign.origin + '/foreign-cover' });

    for (let index = 0; index < fixtures.length; index++) {
      const fixture = fixtures[index], actual = results.results[index];
      assert.equal(actual.returnedSame, true, fixture.name);
      assert.equal(actual.details.coverNormalized, true, fixture.name);
      assert.equal(actual.repeatedReads, 0, fixture.name + ' should only be inspected once');
      assert.equal(actual.details.coverCropped, fixture.crop, fixture.name);
      const { x, y, width, height } = actual.details.coverBounds;
      if (fixture.crop) {
        assert(width >= fixture.contentWidth && height >= fixture.contentHeight, fixture.name + ' must retain all artwork');
        assert(width - fixture.contentWidth <= 18 && height - fixture.contentHeight <= 18, fixture.name + ' should remove the old padding');
        assert.equal(actual.details.coverAspect, width / height);
        assert.deepEqual(actual.repeat, [width / actual.width, height / actual.height]);
        assert(Math.abs(actual.offset[0] - x / actual.width) < 1e-12);
        assert(Math.abs(actual.offset[1] - (1 - (y + height) / actual.height)) < 1e-12);
      } else {
        assert.deepEqual(actual.details.coverBounds, { x: 0, y: 0, width: actual.width, height: actual.height }, fixture.name);
        assert.equal(actual.details.coverAspect, actual.width / actual.height, fixture.name);
        assert.deepEqual(actual.repeat, [1, 1], fixture.name);
        assert.deepEqual(actual.offset, [0, 0], fixture.name);
      }
      assert.equal(actual.reads, actual.width === 500 && actual.height === 707 ? 1 : 0, fixture.name + ' should skip pixel reads for natural sizes');
    }
    assert(results.cors.tainted, 'The fixture must genuinely taint a canvas');
    for (const fallback of [results.cors.details, results.noContext]) {
      assert.equal(fallback.coverCropped, false);
      assert.equal(fallback.coverAspect, 500 / 707);
    }
    assert.deepEqual(results.cors.repeat, [1, 1]);
    assert.deepEqual(results.cors.offset, [0, 0]);
    report.results.push(...results.results, { cors: results.cors, noContext: results.noContext });
    pass('Old PNG, default JPEG and lossy WebP padding is recovered on either axis with safe visible bounds and correct UV transforms');
    pass('Black artwork, all-dark covers, similar colors, asymmetric or single borders, authored frames and transparency keep their full image');
    pass('Natural proportions skip canvas work; repeated texture normalization never reads pixels twice');
    pass('Real CORS restrictions and missing canvas contexts safely retain the natural cover and never block rendering');
    assert.deepEqual(report.errors, []);
  } finally {
    if (browser) await browser.close();
    await Promise.all([local.server, foreign.server].map(server => new Promise(resolve => server.close(resolve))));
  }
}

(async () => {
  const fixtures = await generateFixtures();
  await verifyThumbnailBackend(fixtures);
  await verifyTextureNormalization(fixtures);
})().catch(error => {
  report.errors.push(error.stack || error.message);
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, 'checks.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2));
  console.log('Report: ' + file);
});
