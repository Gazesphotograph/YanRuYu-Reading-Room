'use strict';

// Neutral generated covers and an ephemeral browser profile only. The harness
// cannot call Electron IPC or read the user's library, settings or progress.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('./playwright-runtime.cjs');
const {launchOptions}=require('./test-gallery.cjs');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-personalization-'));
const source=name=>pathToFileURL(path.resolve(__dirname,'../resources/app/dist',name)).href;
const harness=path.join(temporary,'index.html');
fs.writeFileSync(harness,`<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${source('room.css')}"><link rel="stylesheet" href="${source('room-themes.css')}"><link rel="stylesheet" href="${source('room-scene.css')}"><link rel="stylesheet" href="${source('room-personalization.css')}"><style>*{box-sizing:border-box}body{margin:0;background:#efeee8}.scene-viewport{height:630px;width:100%}#notice{position:fixed;bottom:0;left:0;background:white}@media(max-width:700px){.scene-viewport{height:920px}}</style><main class="scene-viewport" id="scene"></main><div id="modal-root"></div><div id="notice"></div><script type="module">
import {RoomScene} from '${source('room-scene.js')}';
import {createRoomPersonalization} from '${source('room-personalization.js')}';
import * as THREE from '${source('vendor/three.module.min.js')}';
window.THREE=THREE;
window.books=Array.from({length:16},(_,i)=>{const aspect=[.7,1.6,1,.67,1.95,.72][i%6],width=Math.round(500*aspect);return {id:'neutral-'+i,title:'静物档案 '+String(i+1).padStart(2,'0'),pages:50,cover:'data:image/svg+xml;charset=utf-8,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="500"><rect width="'+width+'" height="500" fill="hsl('+(80+i*17)+',17%,50%)"/><circle cx="'+(width*.66)+'" cy="185" r="90" fill="#e7e4d7"/><text x="30" y="440" fill="#fff" font-family="Georgia" font-size="22">Quiet Objects '+i+'</text></svg>')};});
window.state={theme:'paper',books:[...books,{id:'hidden',title:'隐藏书籍',hiddenBook:true}],progress:{'neutral-0':{page:4,total:50,time:Date.now()-3600000},'neutral-1':{page:50,total:50,time:Date.now()-86400000},hidden:{page:12,total:12,time:Date.now()}}};
window.stored=new Map();window.storage={get:(key,fallback)=>stored.has(key)?JSON.parse(stored.get(key)):fallback,set:(key,value)=>stored.set(key,JSON.stringify(value))};
window.room=new RoomScene(document.querySelector('#scene'));room.setBooks(books.slice(0,12),'paper');
window.dismiss=()=>{document.querySelector('#modal-root').replaceChildren();document.querySelector('#scene').inert=false;room.setSuspended(false)};
window.createPersonal=()=>createRoomPersonalization({storage,getState:()=>state,getScene:()=>room,showModal:html=>{document.querySelector('#modal-root').innerHTML='<div class="overlay"><section class="modal" role="dialog" aria-modal="true">'+html+'</section></div>';document.querySelector('#scene').inert=true;room.setSuspended(true);},dismiss,toast:message=>document.querySelector('#notice').textContent=message,openBook:id=>window.openedBook=id,showFeatured:()=>window.featuredShown=true});
window.personal=createPersonal();personal.applyScene();
document.addEventListener('click',event=>{if(event.target.closest('[data-action="dismiss"]'))dismiss()});
window.inspect=()=>{room.world.updateMatrixWorld(true);const ray=new THREE.Raycaster(),obstacles=[],occlusions=[],hits=[];room.environment.group.traverseVisible(object=>{if(object.isMesh&&(!object.material.transparent||object.material.opacity>.35))obstacles.push(object)});Object.values(room.furniture).forEach(group=>group.traverseVisible(object=>{if(object.isMesh&&(!object.material.transparent||object.material.opacity>.35))obstacles.push(object)}));for(const item of room.items){for(const xx of [-.38,0,.38])for(const yy of [.12,.5,.88]){const point=new THREE.Vector3(xx*item.modelWidth,yy*item.modelHeight,item.depth/2+.019).applyMatrix4(item.group.matrixWorld),screen=point.clone().project(room.camera);ray.setFromCamera(screen,room.camera);const hit=ray.intersectObjects(obstacles,false)[0];if(hit&&hit.distance<ray.ray.origin.distanceTo(point)-.007)occlusions.push({id:item.button.dataset.book,object:hit.object.parent.name});}const rect=item.button.getBoundingClientRect(),x=rect.left+rect.width/2,y=rect.top+rect.height/2;if(x>=0&&x<innerWidth&&y>=0&&y<innerHeight)hits.push(document.elementFromPoint(x,y)?.closest('[data-book]')?.dataset.book===item.button.dataset.book);}
return {occlusions,hits,aspects:room.items.map(item=>({actual:item.width/item.height,expected:item.aspect})),resources:room.getResourceStats()};};
</script>`,'utf8');

(async()=>{
  let browser;
  try {
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1280,height:720},reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(pathToFileURL(harness).href);
    await page.waitForFunction(()=>window.room?.items.length===12&&room.items.every(item=>item.button.dataset.coverState==='loaded')&&room.frame===0);
    const initialBuilds=await page.evaluate(()=>room.roomBuilds);
    for(const capacity of [12,6])for(const layout of ['balanced','airy','cozy'])for(const direction of [-1,1]){
      await page.evaluate(({capacity,layout,direction})=>{room.setBooks(books.slice(0,capacity),state.theme,1,capacity);room.setPersonalization({layout,shelfOffset:direction*12,furnitureOffset:-direction*15,brightness:direction===1?125:75,warmth:direction*30});room.setCameraPose({yaw:direction*.29});},{capacity,layout,direction});
      await page.waitForFunction(()=>room.items.every(item=>item.button.dataset.coverState==='loaded')&&room.frame===0);
      const result=await page.evaluate(()=>inspect());
      assert.deepEqual(result.occlusions,[],capacity+' books '+layout+' must keep covers unobstructed');
      assert(result.hits.every(Boolean),capacity+' books '+layout+' retains native button hit targets');
      assert(result.aspects.every(aspect=>Math.abs(aspect.actual-aspect.expected)<.001),'Preserve portrait, square and landscape cover proportions');
    }
    assert.equal(await page.evaluate(()=>room.roomBuilds),initialBuilds+1,'Preset changes reuse the static room');
    await page.evaluate(()=>{room.setBooks(books.slice(0,6),'paper',1,6);room.setCameraPose({});room.setPersonalization({furniture:{chair:false,table:false,lamp:false,rug:false,plants:false,objects:false}})});
    await page.waitForFunction(()=>room.frame===0);
    assert(await page.evaluate(()=>Object.values(room.furniture).every(group=>!group.visible)),'Hidden furniture also hides its lights and contact shadows');
    const silent=await page.evaluate(()=>{const n=room.frameCount;room.setPersonalization(room.personalization);return n});
    await page.waitForTimeout(400);assert.equal(await page.evaluate(()=>room.frameCount),silent,'Unchanged preferences and idle scene must not render');
    await page.evaluate(()=>{room.setSuspended(true);room.setPersonalization({brightness:125});});
    await page.waitForTimeout(180);assert.equal(await page.evaluate(()=>room.frameCount),silent,'Personalization must not render behind the reader or a modal');
    await page.evaluate(()=>room.setSuspended(false));await page.waitForFunction(()=>room.frame===0);
    for(const quality of ['power','balanced','fine']){
      await page.evaluate(quality=>room.setQuality(quality),quality);await page.waitForFunction(()=>room.frame===0&&room.items.every(item=>item.button.dataset.coverState==='loaded'));
      assert.equal(await page.evaluate(()=>room.personalization.brightness),125);
      assert.equal(await page.evaluate(()=>room.renderer.shadowMap.enabled),quality!=='power');
    }

    await page.evaluate(()=>personal.open());
    await page.locator('[data-personal-layout="airy"]').click();
    await page.locator('#personal-brightness').fill('118');await page.locator('#personal-brightness').dispatchEvent('input');
    await page.locator('[data-personal-furniture="chair"]').uncheck();
    await page.evaluate(()=>room.setCameraPose({yaw:.13,panX:.3,panY:.1,zoom:1.2}));
    await page.locator('[data-personal-save]').click();
    await page.locator('[data-personal-layout="cozy"]').click();
    await page.locator('[data-personal-reset]').click();
    assert.equal(await page.evaluate(()=>personal.sceneOptions().layout),'balanced');
    await page.locator('[data-personal-restore]').click();
    const restored=await page.evaluate(()=>({options:personal.sceneOptions(),camera:room.getCameraPose(),saved:storage.get('personalization')}));
    assert.equal(restored.options.layout,'airy');assert.equal(restored.options.brightness,118);assert.equal(restored.options.furniture.chair,false);
    assert.deepEqual(restored.camera,{yaw:.13,panX:.3,panY:.1,zoom:1.2});
    await page.locator('[data-personal-tab="featured"]').click();
    await page.locator('[data-personal-add="neutral-1"]').click();
    await page.locator('#personal-featured-search').fill('档案 01');
    await page.locator('[data-personal-add="neutral-0"]').click();
    assert.equal(await page.locator('[data-personal-add="hidden"]').count(),0);
    await page.locator('[data-personal-move="neutral-0"][data-direction="-1"]').click();
    assert.deepEqual(await page.evaluate(()=>personal.getFeaturedBooks(state.books).map(book=>book.id)),['neutral-0','neutral-1']);
    await page.locator('[data-personal-tab="stats"]').click();
    assert.deepEqual(await page.locator('.personal-stats strong').allTextContents(),['2 本','1 本','1 本','2 本']);
    assert.equal(await page.locator('[data-personal-book="hidden"]').count(),0);
    await page.locator('[data-personal-book="neutral-0"]').click();assert.equal(await page.evaluate(()=>openedBook),'neutral-0');
    await page.evaluate(()=>{personal.dispose();personal=createPersonal();state.theme='forest';room.setTheme('forest');personal.applyScene();});
    assert.equal(await page.evaluate(()=>personal.sceneOptions().brightness),100,'Other themes retain their own defaults');
    await page.evaluate(()=>{state.theme='paper';room.setTheme('paper');personal.applyScene();});
    assert.equal(await page.evaluate(()=>personal.sceneOptions().brightness),118,'Saved preferences survive controller reinitialization');
    assert.deepEqual(await page.evaluate(()=>personal.getFeaturedBooks(state.books).map(book=>book.id)),['neutral-0','neutral-1']);

    await page.evaluate(()=>{const saved=storage.get('personalization');saved.featuredIds.push('removed-book','hidden');storage.set('personalization',saved);personal.dispose();personal=createPersonal();personal.open('featured')});
    await page.locator('[data-personal-clear-unavailable]').click();
    assert.deepEqual(await page.evaluate(()=>storage.get('personalization').featuredIds),['neutral-0','neutral-1'],'Unavailable entries can be explicitly removed without changing library metadata');
    await page.evaluate(()=>dismiss());

    await page.setViewportSize({width:390,height:844});
    await page.evaluate(()=>{room.setBooks(books.slice(0,12),'paper',1,12);personal.applyScene();room.setCameraPose({});});
    await page.waitForFunction(()=>room.narrow&&room.frame===0&&room.items.every(item=>item.button.dataset.coverState==='loaded'));
    assert.equal(await page.evaluate(()=>room.cabinets[0].group.position.x),0,'Narrow room remains centered regardless of saved offsets');
    assert.deepEqual((await page.evaluate(()=>inspect())).occlusions,[]);
    await page.evaluate(()=>personal.open());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Narrow personalization panel must not create horizontal overflow');
    assert(await page.locator('[data-personal-save]').isVisible());
    if(process.env.PERSONALIZATION_PREVIEW_DIRECTORY){
      const preview=path.resolve(process.env.PERSONALIZATION_PREVIEW_DIRECTORY);fs.mkdirSync(preview,{recursive:true});
      await page.screenshot({path:path.join(preview,'room-personalization-narrow.png')});
      await page.setViewportSize({width:1280,height:850});await page.screenshot({path:path.join(preview,'room-personalization-desktop.png')});
      await page.locator('[data-personal-tab="stats"]').click();await page.screenshot({path:path.join(preview,'room-statistics-desktop.png')});
    }
    await page.evaluate(()=>{dismiss();personal.dispose();room.dispose()});assert.deepEqual(errors,[]);
    console.log('PASS room personalization: presets and furniture, cover aspect/hits/occlusion, saved camera, per-theme restoration, curated order and filtering, real progress statistics, idle/suspended rendering, quality tiers and narrow layout');
  } finally {
    await browser?.close();
    if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('yanruyu-personalization-'))throw new Error('Unsafe temporary fixture directory');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
