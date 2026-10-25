'use strict';

// A neutral, isolated browser harness. It never opens the app or user data.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { launchOptions } = require('./test-gallery.cjs');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-scene-budget-'));
const output = path.resolve(__dirname, '.artifacts/phase2-scene');
const dist = path.resolve(__dirname, '../resources/app/dist');
const source = name => pathToFileURL(path.join(dist, name)).href;
const baseline = process.env.SCENE_BENCHMARK_ONLY === '1';
const report = { mode: baseline ? 'before' : 'after', platform: process.platform, node: process.version, pages: [], checks: [] };
fs.mkdirSync(output, { recursive: true });
const harness = path.join(temporary, 'index.html');
fs.writeFileSync(harness, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${source('room-scene.css')}"><style>*{box-sizing:border-box}body{margin:0;background:#eee}#scene{height:640px;width:100%;--ink:#626961;--line:#bbb;--paper:#f3f0e8;--surface:#fff}</style><main class="scene-viewport" id="scene"></main><script type="module">
import {RoomScene} from '${source('room-scene.js')}';
window.room=new RoomScene(document.querySelector('#scene'));
window.books=page=>Array.from({length:12},(_,i)=>({id:'page-'+page+'-'+i,title:'Neutral volume '+page+' / '+i,pages:40+((page*43+i*89)%1600),cover:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="1000"><rect width="700" height="1000" fill="hsl('+((page*13+i*21)%360)+',18%,56%)"/><circle cx="470" cy="390" r="155" fill="#eae7de"/><text x="50" y="850" fill="white" font-size="42">Volume '+page+' / '+i+'</text></svg>')}));
window.geometryCount=()=>{const geometry=new Set();room.world.traverse(o=>{if(o.geometry)geometry.add(o.geometry)});return geometry.size};
room.setBooks(books(0),'paper');
</script>`);

(async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 660 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(harness).href);
    await page.waitForFunction(() => room?.items.length === 12 && room.items.every(item => item.button.dataset.coverState === 'loaded') && room.frame === 0);
    report.gpu = await page.evaluate(() => {const gl=room.renderer.getContext(),ext=gl.getExtension('WEBGL_debug_renderer_info');return {renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),viewport:[innerWidth,innerHeight],deviceScaleFactor:devicePixelRatio};});
    for (let index = 1; index <= 20; index++) {
      const changed = await page.evaluate(index => {
        const world=room.world,environment=room.environment.group,geometries=new Set();let disposed=0;
        room.world.traverse(object=>{if(object.geometry)geometries.add(object.geometry)});
        for(const geometry of geometries)geometry.addEventListener('dispose',()=>disposed++);
        const started=performance.now();room.setBooks(books(index),'paper',index+1);
        return {worldChanged:world!==room.world,environmentChanged:environment!==room.environment.group,disposed,updateMs:performance.now()-started};
      }, index);
      await page.waitForFunction(() => room.items.every(item=>item.button.dataset.coverState==='loaded') && room.frame===0);
      report.pages.push({ ...changed, ...await page.evaluate(() => ({geometries:room.renderer.info.memory.geometries,textures:room.renderer.info.memory.textures,geometryCache:room.worldGeometries.size,bookGeometryCache:room.bookGeometries?.size,coverCache:room.coverCache.size,calls:room.renderer.info.render.calls,triangles:room.renderer.info.render.triangles})) });
    }
    const beforeIdle = await page.evaluate(() => room.frameCount);
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => room.frameCount), beforeIdle, 'Idle room must not continue rendering');
    report.checks.push('static room stops rendering');
    if (!baseline) {
      assert(report.pages.every(result => !result.worldChanged && !result.environmentChanged), 'Pagination must retain room and environment objects');
      assert(Math.max(...report.pages.map(result=>result.geometryCache))-Math.min(...report.pages.map(result=>result.geometryCache))<=1, 'Book thicknesses must not accumulate in the room geometry cache');
      assert(Math.max(...report.pages.map(result=>result.geometries)) < report.pages[0].geometries + 12, 'GPU geometry stays bounded across 20 distinct pages');
      report.checks.push('room and environment reuse', 'bounded geometry under changing book thickness');
      report.quality = {};
      for (const quality of ['power','balanced','fine','power','balanced']) {
        const same = await page.evaluate(quality => { const world=room.world,environment=room.environment.group;room.setQuality(quality);return world===room.world&&environment===room.environment.group; }, quality);
        assert(same, 'Quality changes retain static room');
        await page.waitForFunction(() => room.items.every(item=>item.button.dataset.coverState==='loaded') && room.frame===0);
        const metrics = await page.evaluate(() => ({quality:room.quality,pixelRatio:room.renderer.getPixelRatio(),shadows:room.renderer.shadowMap.enabled,shadowSize:room.keyLight.shadow.mapSize.x,coverBytes:room.getResourceStats().coverBytes,textures:room.renderer.info.memory.textures,framebuffer:room.renderer.domElement.width*room.renderer.domElement.height}));
        report.quality[quality]=metrics;
      }
      assert(report.quality.power.framebuffer<report.quality.balanced.framebuffer&&report.quality.balanced.framebuffer<report.quality.fine.framebuffer);
      assert.equal(report.quality.power.shadows,false);
      assert(report.quality.power.coverBytes<report.quality.balanced.coverBytes);
      report.checks.push('quality reduces framebuffer, cover memory and shadow workload');
      // Empty rows, a partial final page, and going back must not leak decorations.
      const dynamic = await page.evaluate(() => { const staticWorld=room.world;room.setBooks(books(30).slice(0,1),'paper',31,12);const items=room.items.length;room.setBooks(books(31),'paper',32,12);return {items,staticSame:staticWorld===room.world}; });
      assert.deepEqual(dynamic,{items:1,staticSame:true});
      report.checks.push('partial page reuses room and restores full book rows');
    }
    assert.deepEqual(errors, []);
    const disposed = await page.evaluate(() => {const gl=room.renderer.getContext();room.dispose();return {lost:gl.isContextLost(),covers:room.coverCache.size,staticTextures:room.staticTextures.size};});
    assert.deepEqual(disposed,{lost:true,covers:0,staticTextures:0});
    report.checks.push('dispose releases all caches and WebGL context');
    const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    report.summary = {worldRebuilds:report.pages.filter(p=>p.worldChanged).length,environmentRebuilds:report.pages.filter(p=>p.environmentChanged).length,totalGeometriesDisposed:report.pages.reduce((sum,p)=>sum+p.disposed,0),medianUpdateMs:median(report.pages.map(p=>p.updateMs)),peakGeometries:Math.max(...report.pages.map(p=>p.geometries)),peakTextures:Math.max(...report.pages.map(p=>p.textures))};
    console.log(JSON.stringify({mode:report.mode,summary:report.summary,quality:report.quality,checks:report.checks},null,2));
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output,report.mode+'.json'),JSON.stringify(report,null,2));
    // The exact fresh mkdtemp path is the only recursive cleanup target.
    if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('yanruyu-scene-budget-'))throw new Error('Unsafe temporary directory');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
