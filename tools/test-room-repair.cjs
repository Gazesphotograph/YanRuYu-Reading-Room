'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const {chromium}=require('./playwright-runtime.cjs');
const {createFixtures,createFakeModel,attachFakeIpc,launchOptions,appURL}=require('./test-gallery.cjs');
const out=fs.mkdtempSync(path.join(os.tmpdir(),'qiyue-room-repair-'));
const checks=[],errors=[];const pass=name=>{checks.push(name);console.log('PASS '+name);};
const waitCount=(page,count)=>page.waitForFunction(count=>document.querySelectorAll('#room [data-book]').length===count,count);
(async()=>{
  const {LibraryIndex}=await import(pathToFileURL(path.resolve(__dirname,'../resources/app/dist/room-library.js')).href);
  const fixture=createFixtures(path.join(out,'fixtures'),8,128);
  fixture.books[0].tags.artist.push('作者甲');
  fixture.books[2].tags.other=['风景'];
  fixture.books[7].hiddenBook=true;
  for(const i of [0,2,3])fixture.books[i].mark=true;
  const index=new LibraryIndex(fixture.books);
  assert.equal(index.tags.get(JSON.stringify(['artist','作者甲'])).count,4);
  assert.equal(index.books.length,7);
  assert.strictEqual(index.ordered('title'),index.ordered('title'));
  const malformed=new LibraryIndex([{id:'bad',tags:'broken'},{id:'null',tags:{artist:null}},{id:'duplicate',tags:{artist:['a','a'],other:['a']}}]);
  assert.equal(malformed.tags.size,2);assert.equal(malformed.tags.get(JSON.stringify(['artist','a'])).count,1);
  pass('Tag indexing counts each visible book once, separates namespaces, tolerates malformed metadata and reuses sorted results');
  const bigBooks=Array.from({length:10000},(_,i)=>({...fixture.books[i%7],id:'perf-'+i,tags:JSON.stringify(fixture.books[i%7].tags)}));
  const started=performance.now(),bigIndex=new LibraryIndex(bigBooks);bigIndex.ordered('title');
  const buildMs=performance.now()-started,filterStart=performance.now();
  for(let i=0;i<80;i++)bigIndex.select({search:'静物',selectedTags:[JSON.stringify(['artist','作者甲'])],sort:'title'});
  const filterMs=(performance.now()-filterStart)/80;
  console.log(JSON.stringify({librarySize:10000,indexBuildMs:Math.round(buildMs),filterAverageMs:+filterMs.toFixed(2)}));
  const browser=await chromium.launch(launchOptions());
  try{
    const context=await browser.newContext({viewport:{width:1560,height:1000}});
    const model=createFakeModel(fixture.books,fixture.pages);await attachFakeIpc(context,model);
    await context.addInitScript(()=>{
      localStorage.setItem('room-theme',JSON.stringify('glass'));localStorage.setItem('room-view',JSON.stringify('grid'));
      localStorage.setItem('room-progress',JSON.stringify({'gallery-book-00':{page:2,total:5,time:2},'gallery-book-02':{page:5,total:5,time:1}}));
    });
    const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
    await page.goto(appURL);await waitCount(page,7);
    assert.equal(await page.locator('.sidebar [data-nav]').count(),0);
    assert.equal(await page.locator('[data-filter]').count(),4);
    await page.getByTitle('作者：作者甲 · 4 本',{exact:true}).click();await waitCount(page,4);
    assert.equal(await page.locator('#search').inputValue(),'');
    assert.equal(await page.locator('#active-tags [data-tag-key]').count(),1);
    await page.getByTitle('其他：静物 · 6 本',{exact:true}).click();await waitCount(page,3);
    await page.locator('[data-action="favorites"]').click();await waitCount(page,1);
    await page.locator('[data-filter="reading"]').click();await waitCount(page,1);
    assert.equal(await page.locator('#count-favorites').textContent(),'1');
    await page.locator('[data-filter="finished"]').click();await waitCount(page,0);
    assert.equal(await page.locator('#count-favorites').textContent(),'0');
    await page.locator('[data-action="clear-tags"]').click();await waitCount(page,1);
    await page.locator('[data-action="favorites"]').click();await page.locator('[data-filter="all"]').click();await waitCount(page,7);
    await page.locator('#tag-search').fill('作者乙');assert.equal(await page.locator('#tag-list .tag-filter').count(),1);
    await page.locator('#tag-search').fill('');await page.locator('#tag-group').selectOption('artist');assert.equal(await page.locator('#tag-list .tag-filter').count(),2);
    await page.locator('#tag-group').selectOption('');
    pass('Sidebar tag search, namespace filtering, intersections, removable chips and combined reading/favorite counts work without duplicate navigation');

    const chrome=await page.evaluate(()=>{
      const prop=el=>getComputedStyle(el).getPropertyValue('-webkit-app-region');
      return {header:prop(document.querySelector('.topbar')),drag:prop(document.querySelector('.window-drag-region')),rim:getComputedStyle(document.querySelector('.topbar'),'::after').content,controls:[...document.querySelectorAll('.top-actions button,.top-actions input')].map(el=>{const r=el.getBoundingClientRect(),target=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {region:prop(el),hit:target===el||el.contains(target)};})};
    });
    assert.equal(chrome.header,'no-drag');assert.equal(chrome.drag,'drag');assert.equal(chrome.rim,'none');assert(chrome.controls.every(c=>c.region==='no-drag'&&c.hit));
    await page.locator('#search').click();await page.keyboard.type('静物档案 01');await waitCount(page,1);
    await page.locator('#search').fill('');await waitCount(page,7);
    await page.locator('[data-action="theme"]').click();await page.waitForSelector('.theme-modal');await page.keyboard.press('Escape');
    for(const action of ['minimize','maximize','close-window'])await page.locator(`[data-action="${action}"]`).click();
    assert(['window-minimize','window-toggle-maximize','window-close'].every(name=>model.calls.some(c=>c.channel===name)));
    pass('Glass header isolates the native drag strip, keeps all controls unobstructed and dispatches search, appearance and window actions');

    await page.locator('#room [data-book]').first().click();await page.waitForSelector('.drawer');
    await page.locator('.drawer').evaluate(el=>{window.__drawerProof=el;el.scrollTop=350;});
    const primary=page.locator('[data-read]');await primary.hover();
    assert.match(await primary.evaluate(el=>getComputedStyle(el).backgroundImage),/linear-gradient/);
    assert.equal(await page.locator('.drawer').evaluate(el=>getComputedStyle(el,'::after').content),'none');
    const scrollBefore=await page.locator('.drawer').evaluate(el=>el.scrollTop);
    await page.locator('[data-favorite]').click();
    await page.waitForFunction(()=>document.querySelector('[data-favorite]')?.getAttribute('aria-pressed')==='false');
    assert(await page.evaluate(()=>window.__drawerProof===document.querySelector('.drawer')));
    assert(Math.abs(await page.locator('.drawer').evaluate(el=>el.scrollTop)-scrollBefore)<2);
    await page.locator('.drawer').evaluate(el=>el.scrollTop=350);
    await page.screenshot({path:path.join(out,'glass-drawer.png')});
    pass('Scrolled details have one border, keep the read button blue on hover and preserve the drawer scroll position after favoriting');

    await page.locator('#continuous-reading').check();await primary.click();
    await page.waitForSelector('.continuous-page.is-loaded');
    const options=model.calls.filter(c=>c.channel==='load-manga-image-list').at(-1).args[1];assert.equal(options.backgroundProcessing,false);
    const imageCounts=[];
    for(const pageNumber of [60,6,110,4,90,2]){
      await page.locator('#page-slider').fill(String(pageNumber));
      await page.waitForFunction(n=>document.querySelector(`.continuous-page[data-reader-page="${n}"] img`)?.naturalWidth>0,pageNumber);
      await page.waitForTimeout(380);
      imageCounts.push(await page.locator('.continuous-page img[src]').count());
    }
    assert(Math.max(...imageCounts)<=12,JSON.stringify(imageCounts));
    await page.keyboard.press('Escape');await page.waitForSelector('.reader',{state:'detached'});
    pass('Rapid forward/backward jumps through 128 pages keep a bounded nearby-image window and bypass whole-book background processing');

    await page.setViewportSize({width:720,height:840});
    await page.locator('.tag-mobile-trigger').click();await page.waitForSelector('.tag-modal-list');
    await page.locator('#modal-tag-search').fill('作者甲');assert.equal(await page.locator('.tag-modal-list .tag-filter').count(),1);
    await page.locator('.tag-modal-list .tag-filter').click();await page.getByRole('button',{name:'查看结果',exact:true}).click();await waitCount(page,4);
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    pass('Compact windows expose a working tag picker and preserve selections without horizontal overflow');
    await page.setViewportSize({width:1560,height:1000});await page.locator('[data-action="clear-tags"]').click();
    await page.locator('[data-view="shelf"]').click();await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    await page.locator('.shelf-heading').click();await page.mouse.move(1550,980);await page.waitForTimeout(300);
    await page.screenshot({path:path.join(out,'glass-home.png'),fullPage:true});
    assert.deepEqual(errors,[]);pass('New controls and rendering paths complete without renderer errors');
  }finally{await browser.close();fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify({checks,errors,performance:{buildMs,filterMs}},null,2));console.log('Report: '+path.join(out,'checks.json'));}
})().catch(error=>{console.error(error);process.exitCode=1;});
