'use strict';

// Isolated scene verification. This only uses generated neutral covers and a
// temporary HTML harness; it cannot open the app database or call Electron IPC.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('./playwright-runtime.cjs');
const { launchOptions } = require('./test-gallery.cjs');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-environment-'));
const dist = path.resolve(__dirname, '../resources/app/dist');
const themes = ['paper', 'glass', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid'];
const source = value => pathToFileURL(path.join(dist, value)).href;
const errors = [], checks = [];
const harness = path.join(output, 'scene.html');
fs.writeFileSync(harness, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${source('room-scene.css')}"><style>
*{box-sizing:border-box}html,body{margin:0;background:#eee;font:13px system-ui}body{padding:16px;--ink:#626961;--line:#bbb;--paper:#f3f0e8;--surface:#fff;--green:#6b8367}.scene-viewport{width:100%;height:620px;border-radius:18px}.scene-controls button{color:var(--ink)}button{font:inherit}body.dark{--ink:#dbddcf;--line:#555;--paper:#283128;--surface:#3b4839}@media(max-width:700px){.scene-viewport{height:920px}}
</style><main class="scene-viewport" id="scene"></main><script type="module">
import {RoomScene} from '${source('room-scene.js')}';
import * as THREE from '${source('vendor/three.module.min.js')}';
window.THREE=THREE;
const shades=['#6c817b','#a58c73','#728692','#96786b','#8c947d','#898199'];
window.fixtureBooks=Array.from({length:12},(_,i)=>{
 const aspect=[.69,1.48,1,.72,1.95,.68][i%6],w=Math.round(600*aspect),h=600;
 const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'" viewBox="0 0 '+w+' '+h+'"><rect width="'+w+'" height="'+h+'" fill="'+shades[i%6]+'"/><rect x="22" y="22" width="'+(w-44)+'" height="556" fill="none" stroke="#e8e4d6" opacity=".6"/><circle cx="'+(w*.7)+'" cy="235" r="115" fill="#ede8d9" opacity=".72"/><path d="M30 476 150 340 320 483 500 389 800 490V540H30Z" fill="#203b32" opacity=".25"/><text x="45" y="86" fill="#fff9e7" font-family="Georgia" font-size="22">STILL LIFE / '+String(i+1).padStart(2,'0')+'</text><text x="45" y="555" fill="#fff9e7" font-family="Georgia" font-size="25">Quiet Objects</text></svg>';
 return {id:'neutral-'+i,title:'静物档案 '+String(i+1).padStart(2,'0'),cover:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg),pages:80,progress:i===0?22:0};
});
window.room=new RoomScene(document.querySelector('#scene'));window.room.setBooks(window.fixtureBooks,'paper');
window.setScene=(theme,count=12)=>{document.body.classList.toggle('dark',['forest','hub','ex','terminal','neon'].includes(theme));window.room.setBooks(window.fixtureBooks.slice(0,count),theme)};
window.inspectCovers=()=>{
 const {room,THREE}=window,ray=new THREE.Raycaster(),occlusions=[],environment=[];
 room.world.updateMatrixWorld(true);
 room.environment.group.traverse(o=>{if(o.isMesh&&(!o.material.transparent||o.material.opacity>.35))environment.push(o)});
 for(const item of room.items) for(const xx of [-.40,0,.40]) for(const yy of [.10,.50,.90]){
  const point=new THREE.Vector3(xx*item.modelWidth,yy*item.modelHeight,item.depth/2+.019).applyMatrix4(item.group.matrixWorld),screen=point.clone().project(room.camera);
  ray.setFromCamera(screen,room.camera);const hit=ray.intersectObjects(environment,false)[0];
  if(hit&&hit.distance<ray.ray.origin.distanceTo(point)-.007)occlusions.push({book:item.button.dataset.book,object:hit.object.parent.name,xx,yy});
 }
 return occlusions;
};
</script>`, 'utf8');

(async () => {
  const browser = await chromium.launch(launchOptions());
  try {
    const context = await browser.newContext({ viewport:{ width:1280, height:652 }, reducedMotion:'reduce' });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(pathToFileURL(harness).href);
    await page.waitForFunction(() => window.room?.items.length === 12 && window.room.items.every(item => item.button.dataset.coverState === 'loaded'));
    for (const theme of themes) {
      await page.evaluate(theme => window.setScene(theme), theme);
      await page.waitForFunction(theme => document.querySelector('#scene').dataset.sceneTheme === theme && window.room.items.every(item => item.button.dataset.coverState === 'loaded') && window.room.frame === 0, theme);
      const info = await page.evaluate(() => {
        const room = window.room; let objects = 0; room.environment.group.traverse(() => objects++);
        return { theme:room.theme, objects, textures:room.renderer.info.memory.textures, calls:room.renderer.info.render.calls, triangles:room.renderer.info.render.triangles, bounds:room.bounds, occlusions:window.inspectCovers(), frames:room.frameCount };
      });
      assert.deepEqual(info.occlusions, [], theme + ': decorations must not cover the resting book faces');
      assert(info.textures < 72, 'Texture cache should remain bounded across all themes');
      await page.screenshot({ path:path.join(output, theme + '-double.png') });
      for (const yaw of [-.29, .29]) {
        const occlusions = await page.evaluate(yaw => { const room = window.room; room.yaw=room.targetYaw=yaw; room.cameraDirty=true; room.updateCamera(); return window.inspectCovers(); }, yaw);
        assert.deepEqual(occlusions, [], theme + ': decorations must not occlude covers at orbit ' + yaw);
      }
      await page.evaluate(() => { const room=window.room; room.yaw=room.targetYaw=0; room.cameraDirty=true; room.updateCamera(); });
      checks.push(info); console.log('PASS ' + theme + ': materials, unobstructed covers and camera limits');
    }
    const before = await page.evaluate(() => window.room.frameCount);
    await page.waitForTimeout(650);
    assert.equal(await page.evaluate(() => window.room.frameCount), before, 'Environment must not start an idle render loop');
    for (const theme of ['glass', 'forest', 'neon']) {
      await page.evaluate(theme => window.setScene(theme, 6), theme);
      await page.waitForFunction(() => window.room.items.length === 6 && window.room.frame === 0);
      assert.deepEqual(await page.evaluate(() => window.inspectCovers()), [], theme + ': single cabinet');
      await page.screenshot({ path:path.join(output, theme + '-single.png') });
    }
    await page.setViewportSize({ width:560, height:952 });
    await page.evaluate(() => window.setScene('paper'));
    await page.waitForFunction(() => window.room.narrow && window.room.frame === 0);
    assert.deepEqual(await page.evaluate(() => window.inspectCovers()), [], 'Narrow four-row cabinet');
    await page.screenshot({ path:path.join(output, 'paper-narrow.png') });
    assert.deepEqual(errors, []);
    const disposed = await page.evaluate(() => {
      const room=window.room, textures=[...room.staticTextures].filter(([key])=>key.startsWith('environment:')).map(([,map])=>map);
      let released=0;for(const map of textures)map.addEventListener('dispose',()=>released++);
      room.dispose();return {expected:textures.length,released};
    });
    assert(disposed.expected > 30, 'All eight environment themes should have been exercised');
    assert.equal(disposed.released, disposed.expected, 'Disposing the room releases every environment texture');
    console.log('PASS single and narrow layouts, static rendering, disposal and browser errors');
  } finally {
    await browser.close(); fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({checks,errors}, null, 2));
    console.log('Report: ' + path.join(output, 'report.json'));
  }
})().catch(error => { console.error(error); process.exitCode=1; });
