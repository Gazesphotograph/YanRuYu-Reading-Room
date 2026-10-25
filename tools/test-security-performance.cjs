'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
const {pathToFileURL}=require('node:url');
const {performance}=require('node:perf_hooks');
const {chromium}=require('./playwright-runtime.cjs');
const {createFixtures,createFakeModel,attachFakeIpc,launchOptions,appURL}=require('./test-gallery.cjs');
const appDir=path.resolve(__dirname,'../resources/app');
const out=path.join(__dirname,'.artifacts','security-performance');fs.mkdirSync(out,{recursive:true});
const report={date:new Date().toISOString(),checks:[],errors:[],metrics:{}};
const pass=name=>{report.checks.push(name);console.log('PASS '+name);};

async function backendChecks(){
  const source=fs.readFileSync(path.join(appDir,'index.js'),'utf8');
  const servers=[],handlers=new Map();
  const context={port:0,setting:{enabledLANBrowsing:true},console:{error(){}},sendMessageToWebContents(){},ipcMain:{handle:(name,fn)=>handlers.set(name,fn)},LANBrowsing:{listen(){
    const server=new EventEmitter();Object.assign(server,{listening:true,closed:false,connectionsClosed:false,
      close(callback){this.listening=false;this.closed=true;this.callback=callback;},
      closeAllConnections(){this.connectionsClosed=true;}});servers.push(server);return server;
  }}};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('let LANBrowsingInstance')),context);
  const run=code=>vm.runInContext(code,context);
  run('enableLANBrowsing();enableLANBrowsing()');
  assert.equal(servers.length,1);
  run('disableLANBrowsing()');assert(servers[0].closed&&servers[0].connectionsClosed);
  servers[0].callback();assert.equal(servers.length,1);
  run('enableLANBrowsing()');assert.equal(servers.length,2);
  servers[0].emit('error',Object.assign(new Error('old server'),{code:'ECONNRESET'}));
  run('enableLANBrowsing()');assert.equal(servers.length,2);
  run('disableLANBrowsing()');servers[1].callback();assert.equal(servers.length,2);
  pass('LAN enable is idempotent; disable closes active connections and late callbacks cannot restart sharing');

  const nativeRequire=require('node:module').createRequire(path.join(appDir,'fileLoader/folder.js'));
  const trashed=[],folderContext={module:{exports:{}},require(name){
    if(name==='electron')return {shell:{trashItem:async file=>trashed.push(file)}};
    return nativeRequire(name);
  }};
  vm.runInNewContext(fs.readFileSync(path.join(appDir,'fileLoader/folder.js'),'utf8'),folderContext);
  const folder=path.join(out,'deletion-fixtures');fs.mkdirSync(folder,{recursive:true});
  const keep=path.join(folder,'notes.sqlite');fs.writeFileSync(keep,'keep');
  await assert.rejects(()=>folderContext.module.exports.deleteImageFromFolder('notes.sqlite',folder),/Only image/);
  await assert.rejects(()=>folderContext.module.exports.deleteImageFromFolder('../outside.jpg',folder),/Unsafe/);
  assert.equal(fs.readFileSync(keep,'utf8'),'keep');assert.equal(trashed.length,0);
  fs.writeFileSync(path.join(folder,'page.png'),'neutral fixture');
  assert.equal(await folderContext.module.exports.deleteImageFromFolder('page.png',folder),true);assert.equal(trashed.length,1);
  pass('Image deletion rejects non-image files and traversal while preserving valid image deletion');
}

async function libraryChecks(){
  const {LibraryIndex,readingStatus,tagKey}=await import(pathToFileURL(path.join(appDir,'dist/room-library.js')).href);
  const books=Array.from({length:30000},(_,i)=>({id:'b'+i,title:'Book '+i,date:i,mark:i%3===0,readCount:i%7===0?1:0,tags:{artist:['Artist '+i%50],other:['group '+i%4]}}));
  const progress=Object.fromEntries(books.filter((_,i)=>i%5===0).map((b,i)=>[b.id,{page:i%2?5:10,total:10,time:i}]));
  const index=new LibraryIndex(books);
  const old=state=>{
    const visible=index.select(state),scoped=index.select({...state,filter:'all',favorites:false}),counts={reading:0,finished:0,unread:0};
    for(const book of scoped)if(!state.favorites||book.mark)counts[readingStatus(book,progress)]++;
    return {books:visible,counts,favoriteCount:index.select({...state,favorites:false}).filter(book=>book.mark).length};
  };
  for(const sort of ['recent','title','author','pages','rating'])for(const filter of ['all','reading','finished','unread'])for(const favorites of [false,true]){
    const state={sort,filter,favorites,search:'book',selectedTags:[tagKey('other','group 1')],progress};
    assert.deepEqual(index.summarize(state),old(state));
  }
  pass('Single-pass summaries match the original results and counts across 40 sort/filter/favorite combinations');
  let metadataReads=0;const get=index.metadata.get.bind(index.metadata);index.metadata.get=id=>{metadataReads++;return get(id);};
  const state={search:'book',selectedTags:[],progress,sort:'title',filter:'all'};
  old(state);const oldReads=metadataReads;metadataReads=0;index.summarize(state);const newReads=metadataReads;
  assert.equal(oldReads,90000);assert.equal(newReads,30000);
  const timings=fn=>{const times=[];for(let i=0;i<17;i++){const t=performance.now();fn(state);if(i>2)times.push(performance.now()-t);}return times.sort((a,b)=>a-b)[Math.floor(times.length/2)];};
  report.metrics.library={books:books.length,oldMetadataReads:oldReads,newMetadataReads:newReads,oldMedianMs:timings(old),newMedianMs:timings(s=>index.summarize(s))};
  pass('30,000-book refresh reduces metadata lookups from 90,000 to 30,000');
}

async function browserChecks(){
  const fixtures=createFixtures(path.join(out,'books'),3,5),model=createFakeModel(fixtures.books,fixtures.pages);
  const original=model.invoke.bind(model);let release;
  model.invoke=async(channel,...args)=>{
    if(channel==='release-sendimagelock'&&release){const pending=release;release=null;await pending;}
    return original(channel,...args);
  };
  const browser=await chromium.launch(launchOptions());
  try{
    const context=await browser.newContext({viewport:{width:1280,height:850}});await attachFakeIpc(context,model);
    await context.addInitScript(()=>{localStorage.setItem('room-view','"grid"');localStorage.setItem('room-progress',JSON.stringify({'gallery-book-00':{page:'<img id="progress-injection">',total:5}}));});
    model.books[0].pageCount='<img id="metadata-injection" src="invalid">';
    const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
    await page.goto(appURL);await page.waitForSelector('#room [data-book]');
    assert.equal(await page.locator('#metadata-injection,#progress-injection').count(),0);
    await page.locator('[data-book]').first().click();await page.waitForSelector('.drawer');
    assert.equal(await page.locator('#metadata-injection,#progress-injection').count(),0);
    assert.equal(await page.locator('[data-read-start]').count(),0);
    pass('Malformed page counts and stored progress cannot inject DOM into grid or details');
    await page.keyboard.press('Escape');await page.locator('[data-book]').first().dblclick();
    await page.waitForFunction(()=>document.querySelector('.reader-body img')?.naturalWidth>0);
    let finish;release=new Promise(resolve=>{finish=resolve;});
    await page.evaluate(()=>{
      document.querySelectorAll('#room [data-book]')[1].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      document.querySelectorAll('#room [data-book]')[2].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    });
    // Closing is shared by both requests. Do not start another extraction until
    // the prior cache owner has released its files; the final request wins then.
    await page.waitForFunction(()=>!document.querySelector('.reader'));
    // A later burst after the old DOM has gone must join the same release,
    // rather than treating a null reader as permission to start early.
    await page.evaluate(()=>{
      document.querySelectorAll('#room [data-book]')[1].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
      document.querySelectorAll('#room [data-book]')[2].dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));
    });
    assert(!model.calls.some(call=>call.channel==='load-manga-image-list'&&[fixtures.books[1].id,fixtures.books[2].id].includes(call.args[0].id)));
    finish();
    await page.waitForFunction(title=>document.querySelector('.reader-title')?.textContent===title,fixtures.books[2].title);
    assert.equal(await page.locator('.reader-title').textContent(),fixtures.books[2].title);
    assert(!model.calls.some(call=>call.channel==='load-manga-image-list'&&call.args[0].id===fixtures.books[1].id));
    pass('Rapid A → B → C opening waits for the previous cache release and loads only C');
    await page.keyboard.press('Escape');await page.waitForSelector('.reader',{state:'detached'});
    await page.evaluate(async()=>{
      const {RoomScene}=await import('./room-scene.js');
      const host=document.createElement('div');host.style.cssText='position:fixed;left:0;top:0;width:900px;height:600px;z-index:10000';document.body.append(host);
      window.auditScene=new RoomScene(host);
      window.auditOldGl=auditScene.renderer.getContext();
    });
    let pendingRoutes=[],requests=[];
    await context.route('https://covers.invalid/**',route=>{requests.push(route.request().url());pendingRoutes.push(route);});
    await page.evaluate(()=>{
      auditScene.setBooks(Array.from({length:12},(_,i)=>({id:'old'+i,title:'Old '+i,cover:'https://covers.invalid/old'+i})), 'paper');
    });
    for(let attempt=0;requests.length<4&&attempt<100;attempt++)await page.waitForTimeout(50);
    assert.equal(requests.length,4);
    await page.evaluate(()=>auditScene.setBooks(Array.from({length:12},(_,i)=>({id:'new'+i,title:'New '+i,cover:'https://covers.invalid/new'+i})), 'paper'));
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=','base64');
    for(let batch=0;batch<8;batch++){
      const routes=pendingRoutes.splice(0);await Promise.all(routes.map(route=>route.fulfill({status:200,contentType:'image/png',headers:{'Access-Control-Allow-Origin':'*'},body:png})));
      await page.waitForTimeout(80);
    }
    await page.waitForFunction(()=>auditScene.coverLoads.size===0);
    await page.waitForFunction(()=>auditScene.items.every(item=>item.button.dataset.coverState==='loaded'));
    assert.equal(requests.filter(url=>url.includes('/old')).length,4);assert.equal(requests.filter(url=>url.includes('/new')).length,12);
    report.metrics.coverQueue={oldPageRequested:4,oldPageSkipped:8,newPageLoaded:12,concurrencyLimit:4};
    pass('Cover loading starts at most four requests and drops eight obsolete queued covers during page changes');
    await page.evaluate(()=>auditScene.dispose());
    assert(await page.evaluate(()=>auditOldGl.isContextLost()));
    pass('Disposing the 3D view releases its WebGL context immediately');
    assert.deepEqual(report.errors,[]);
  }finally{await browser.close();}
}

(async()=>{try{await backendChecks();await libraryChecks();await browserChecks();}catch(error){report.errors.push(error.message);throw error;}finally{fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(report,null,2));}})().catch(error=>{console.error(error);process.exitCode=1;});
