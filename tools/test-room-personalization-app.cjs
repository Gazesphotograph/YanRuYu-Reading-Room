'use strict';

// Full room entry point with fake IPC, generated covers, an ephemeral profile
// and strict portable-state validation. No live app or user data is accessed.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {chromium}=require('./playwright-runtime.cjs');
const {createFixtures,createFakeModel,attachFakeIpc,launchOptions,appURL}=require('./test-gallery.cjs');
const {validateClientState}=require('../resources/app/modules/client_state');
const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-personal-app-'));

(async()=>{
  let browser;
  const errors=[];
  try {
    const fixture=createFixtures(temporary,21,5);fixture.books[20].hiddenBook=true;
    const model=createFakeModel(fixture.books,fixture.pages),original=model.invoke.bind(model);
    model.invoke=async(channel,...args)=>{
      if(channel==='save-ui-state')validateClientState(args[0]);
      if(channel==='local-search-command')return {aliases:[],textPages:0,indexedBooks:0};
      return original(channel,...args);
    };
    const first=fixture.books[0].id,second=fixture.books[1].id;
    model.readingState.progress={[first]:{page:2,total:5,time:Date.now()-3600000,source:'room'},[second]:{page:5,total:5,time:Date.now()-86400000,source:'room'}};
    model.readingState.migrations.legacyV1={migratedAt:Date.now()};
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
    await context.route(/^https?:/,route=>route.abort());await attachFakeIpc(context,model);
    await context.addInitScript(()=>{
      window.AudioContext=class {
        constructor(){window.__personalAudio=this;this.state='suspended';this.sampleRate=1000;this.currentTime=1;this.destination={};}
        resume(){this.state='running';return Promise.resolve();}suspend(){this.state='suspended';return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
        createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
        createBufferSource(){return {connect(){},disconnect(){},start(){},stop(){}};}
        createBiquadFilter(){return {frequency:{value:0},connect(){},disconnect(){}};}
        createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){},disconnect(){}};}
      };
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    await page.goto(appURL);await page.locator('#room [data-book]').first().waitFor();
    await page.locator('[data-action="featured"]').click();await page.locator('#room .empty').waitFor();
    await page.locator('[data-action="personalization"]').click();await page.locator('[data-personal-tab="featured"]').click();
    await page.locator(`[data-personal-add="${first}"]`).click();
    await page.waitForFunction(()=>document.querySelector('.scene-viewport'));
    const behind=await page.locator('.scene-viewport').getAttribute('data-render-count');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-render-count'),behind,'Scene created behind an open modal must remain suspended');
    await page.locator(`[data-personal-add="${second}"]`).click();
    await page.locator(`[data-personal-move="${second}"][data-direction="-1"]`).click();
    await page.locator('[data-personal-show-featured]').click();
    await page.locator('#room [data-book]').first().waitFor();
    assert.deepEqual(await page.locator('#room [data-book]').evaluateAll(nodes=>nodes.map(node=>node.dataset.book)),[second,first]);
    assert.match(await page.textContent('#results'),/共 2 本/);
    await page.locator('[data-scene-camera="right"]').click();
    await page.locator('[data-action="personalization"]').click();
    await page.locator('[data-personal-layout="airy"]').click();
    await page.locator('#personal-brightness').fill('113');await page.locator('#personal-brightness').dispatchEvent('input');
    await page.locator('[data-personal-save]').click();await page.locator('#personal-sound-kind').selectOption('rain');
    await page.waitForFunction(()=>window.__personalAudio?.state==='running');
    await page.locator('[data-action="dismiss"]').click();
    await page.locator('[data-scene-camera="reset"]').click();
    await page.locator('[data-action="personalization"]').click();await page.locator('[data-personal-restore]').click();await page.locator('[data-action="dismiss"]').click();
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-camera-target-yaw'),'0.13');
    await page.evaluate(()=>window.YanruyuClientState.flush());
    const saved=JSON.parse(model.uiState.values['room-personalization']);
    assert.equal(saved.themes.paper.current.brightness,113);assert.equal(saved.themes.paper.saved.layout,'airy');assert.deepEqual(saved.featuredIds,[second,first]);
    await page.reload();await page.locator('#room [data-book]').first().waitFor();
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-room-arrangement'),'airy');
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-room-brightness'),'113');
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-camera-target-yaw'),'0.13');
    assert.equal(await page.evaluate(()=>!!window.__personalAudio),false,'Reloaded root shell must not autoplay saved ambience');
    assert.equal(await page.locator('[data-action="featured"]').getAttribute('aria-pressed'),'true');
    for(const expected of [{theme:'forest',layout:'balanced',brightness:'100',yaw:'0'},{theme:'paper',layout:'airy',brightness:'113',yaw:'0.13'}]){
      await page.locator('[data-action="theme"]').first().click();await page.locator(`[data-theme-choice="${expected.theme}"]`).click();
      await page.locator('[data-action="dismiss"]').first().click();
      await page.waitForFunction(expected=>{const node=document.querySelector('.scene-viewport');return node?.dataset.sceneTheme===expected.theme&&node.dataset.cameraYaw===expected.yaw;},expected);
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-room-arrangement'),expected.layout);
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-room-brightness'),expected.brightness);
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-camera-target-yaw'),expected.yaw);
      assert(await page.locator('#room [data-book]').evaluateAll(nodes=>nodes.every(node=>{const rect=node.getBoundingClientRect();return document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.closest('[data-book]')===node;})),'Restored cameras and theme changes preserve actual cover click targets');
    }
    await page.locator('[data-action="personalization"]').click();await page.locator('[data-personal-play]').click();
    await page.waitForFunction(()=>window.__personalAudio?.state==='running');await page.locator('[data-action="dismiss"]').click();
    await page.locator(`#room [data-book="${first}"]`).click();await page.locator('[data-read]').click();
    await page.locator('.reader').waitFor();await page.waitForFunction(()=>window.__personalAudio?.state==='suspended');
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent.includes('/ 5'));
    const readerFrame=await page.locator('.scene-viewport').getAttribute('data-render-count');await page.waitForTimeout(180);
    assert.equal(await page.locator('.scene-viewport').getAttribute('data-render-count'),readerFrame);
    await page.locator('[data-action="exit-reader"]').click();await page.waitForFunction(()=>!document.querySelector('.reader')&&window.__personalAudio?.state==='running');
    await page.locator('[data-action="personalization"]').click();await page.locator('[data-personal-tab="stats"]').click();
    assert.deepEqual(await page.locator('.personal-stats strong').allTextContents(),['2 本','1 本','1 本','2 本']);
    await page.locator('[data-personal-tab="featured"]').click();
    assert.equal(await page.locator('.personal-featured-cover img').count(),2);
    await page.waitForFunction(()=>[...document.querySelectorAll('.personal-featured-cover img')].every(image=>image.complete&&image.naturalWidth>0));
    const preview=process.env.PERSONALIZATION_PREVIEW_DIRECTORY?path.resolve(process.env.PERSONALIZATION_PREVIEW_DIRECTORY):null;
    if(preview){fs.mkdirSync(preview,{recursive:true});await page.screenshot({path:path.join(preview,'root-featured-desktop.png')});}
    await page.locator('[data-action="dismiss"]').click();
    if(preview)await page.screenshot({path:path.join(preview,'root-room-desktop.png')});
    await page.setViewportSize({width:420,height:900});
    await page.waitForFunction(()=>document.querySelector('.scene-viewport')?.dataset.sceneLayout==='narrow');
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Full 420px shell fits horizontally');
    if(preview)await page.screenshot({path:path.join(preview,'root-room-420.png')});
    await page.locator('[data-action="personalization"]').click();
    assert(await page.locator('[data-personal-layout="airy"]').isVisible());
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(preview)await page.screenshot({path:path.join(preview,'root-personalization-420.png')});
    await page.locator('[data-personal-tab="stats"]').click();if(preview)await page.screenshot({path:path.join(preview,'root-statistics-420.png')});
    await page.evaluate(()=>window.YanruyuClientState.flush());assert.deepEqual(errors,[]);
    console.log('PASS full root shell: featured empty-to-filled modal suspension, curated covers/order, portable backup/reload, saved camera, optional audio reader hooks, local statistics, 420px and desktop UI');
  } finally {
    await browser?.close();
    if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('yanruyu-personal-app-'))throw new Error('Unsafe temporary fixture directory');
    fs.rmSync(temporary,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
