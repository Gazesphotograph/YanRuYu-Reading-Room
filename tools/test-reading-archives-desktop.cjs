'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const {execFileSync} = require('node:child_process');
const {fs,path,root,isWithin,sha256,electronExecutable} = require('./project/common.cjs');
const {build} = require('./project/build.cjs');
const {_electron} = require('./playwright-runtime.cjs');

async function main() {
  const packageArg = process.argv.find(arg => arg.startsWith('--package='));
  const packaged = packageArg && fs.realpathSync.native(path.resolve(packageArg.slice('--package='.length)));
  if (packaged && (!isWithin(path.join(root, 'out'), packaged) || packaged === path.join(root, 'out'))) {
    throw new Error('Archive desktop tests only accept generated packages below out/.');
  }
  const reusable=process.env.YANRUYU_TEST_BUILD&&path.resolve(process.env.YANRUYU_TEST_BUILD);
  if(!packaged&&reusable&&!isWithin(path.join(root,'.build'),reusable))throw new Error('Invalid reusable build');
  const folder = packaged || reusable;
  const target=folder?{folder,app:path.join(folder,'resources','app')}:build();
  const executable = packaged ? path.join(packaged, 'exhentai-manga-manager.exe') : electronExecutable();
  const args = packaged ? [] : [target.app];
  const sharp=require(path.join(target.app,'node_modules','sharp'));
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-archive-reading-'));
  const data=path.join(fixture,'data'),library=path.join(fixture,'library'),input=path.join(fixture,'pages');
  const env={...process.env,YANRUYU_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  const originals=new Map(),cases=[],errors=[],coldOpens=[];let application,page;
  const invoke=(channel,...args)=>page.evaluate(({channel,args})=>window.ipcRenderer.invoke(channel,...args),{channel,args});
  async function launch(){
    application=await _electron.launch({executablePath:executable,args:[...args,'--enable-unsafe-swiftshader'],cwd:target.folder,env,timeout:45000});
    page=await application.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#local-count').filter({hasText:/本/}).waitFor();
  }
  async function close(){if(!application)return;await application.evaluate(({app})=>app.quit()).catch(()=>{});await application.close().catch(()=>{});application=null;}
  async function nativeClose(){
    const processHandle=application.process();
    const stopped=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Native archive reader close did not finish')),30000);
      if(processHandle.exitCode!==null){clearTimeout(timer);resolve();return;}
      processHandle.once('exit',()=>{clearTimeout(timer);resolve();});
    });
    await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await stopped;await application.close().catch(()=>{});application=null;
  }
  async function readPage(number,mode){
    await page.waitForFunction(({number,mode})=>{
      const image=document.querySelector(mode==='continuous'?`.continuous-page[data-reader-page="${number}"] img`:`.paged-sheet[data-reader-page="${number}"] img`);
      return document.querySelector('#reader-page')?.textContent===`${number} / 8`&&image?.naturalWidth>0;
    },{number,mode});
  }
  async function open(id,number,mode){await page.locator(`#room [data-book="${id}"]`).dblclick();await readPage(number,mode);}
  async function setOffset(number,offset){
    await page.evaluate(({number,offset})=>{
      const body=document.querySelector('#reader-body'),sheet=document.querySelector(`.continuous-page[data-reader-page="${number}"]`);
      body.scrollTop=sheet.offsetTop+sheet.offsetHeight*offset;body.dispatchEvent(new Event('scroll'));
    },{number,offset});
  }
  async function assertOffset(number,offset){
    await page.waitForFunction(({number,offset})=>{
      const body=document.querySelector('#reader-body'),sheet=document.querySelector(`.continuous-page[data-reader-page="${number}"]`);
      return sheet&&Math.abs((body.scrollTop-sheet.offsetTop)/sheet.offsetHeight-offset)<.03;
    },{number,offset});
  }
  try {
    fs.mkdirSync(data);fs.mkdirSync(library);fs.mkdirSync(input);
    fs.writeFileSync(path.join(data,'setting.json'),JSON.stringify({library,hideTitleBar:true,loadOnStart:false,autoCheckUpdates:false,enabledLANBrowsing:false,closeToTray:false,minimizeOnStart:false}));
    for(let number=1;number<=8;number++){
      const file=path.join(input,`${String(number).padStart(3,'0')}.png`);
      await sharp({create:{width:300,height:450,channels:3,background:{r:20*number,g:80,b:130}}}).png().toFile(file);originals.set(file,sha256(file));
    }
    for(const extension of ['zip','cbz','7z']){
      const file=path.join(library,'Neutral reading.'+extension);
      assert(isWithin(fixture,file));
      execFileSync(path.join(root,'resources','extraResources','7z.exe'),['a',extension==='7z'?'-t7z':'-tzip','-mx=0',file,'*.png'],{cwd:input,windowsHide:true,stdio:'pipe'});
      originals.set(file,sha256(file));
    }
    await launch();await invoke('load-book-list',true);
    const books=await invoke('load-book-list',false);assert.equal(books.length,3);assert.equal(new Set(books.map(book=>book.id)).size,3);
    await page.evaluate(()=>{localStorage.setItem('room-workspace-preview','true');localStorage.setItem('room-workspace-start-page',JSON.stringify('library'));localStorage.setItem('room-workspace-library-view',JSON.stringify('table'));location.reload();});
    await page.getByRole('table',{name:'书库结果'}).waitFor();
    await application.evaluate(({app})=>{
      const path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));
      const {ArchiveCache}=require('./modules/archive_cache');const validate=ArchiveCache.prototype.validateImages;
      let blocked=false;app.archiveGateReached=new Promise(resolve=>{app.resolveArchiveGate=resolve;});
      ArchiveCache.prototype.validateImages=async function(entry,signal){
        if(!blocked){blocked=true;ArchiveCache.prototype.validateImages=validate;app.resolveArchiveGate();
          await new Promise((resolve,reject)=>{const abort=()=>{const error=new Error('fixture cancelled cold preparation');error.name='AbortError';reject(error);};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
        }
        return validate.call(this,entry,signal);
      };
    });
    const coldPreparation=invoke('load-manga-image-list',books[0],{backgroundProcessing:false});
    await application.evaluate(({app})=>app.archiveGateReached);
    const extraction=(await invoke('task-list')).find(task=>task.kind==='extract'&&task.status==='running');assert(extraction);
    const cancellingAt=Date.now();await invoke('task-cancel',extraction.id);assert.equal((await coldPreparation).length,0);
    const cancellationMs=Date.now()-cancellingAt;assert(cancellationMs<3000);
    console.log(`PASS Cold archive cancellation before cache commit completes in ${cancellationMs} ms with no readable result.`);
    for(const book of books)for(const mode of ['paged','double','continuous']){
      await invoke('save-reading-preferences',book.id,{mode});
      await page.evaluate(()=>window.dispatchEvent(new CustomEvent('yanruyu-library-updated')));
      await page.waitForFunction(({id,mode})=>window.readingState.preferences[id]?.mode===mode,{id:book.id,mode});
      const previous=(await invoke('load-reading-state')).progress[book.id];
      const openingAt=Date.now();await open(book.id,previous?.page||1,mode);
      if(mode==='paged')coldOpens.push({extension:path.extname(book.filepath),milliseconds:Date.now()-openingAt});
      await page.locator('#page-slider').fill('5');await readPage(5,mode);
      if(mode==='continuous'){await setOffset(5,.23);await assertOffset(5,.23);}
      await page.locator('[data-action="exit-reader"]').click();await page.locator('.reader').waitFor({state:'detached'});
      const saved=(await invoke('load-reading-state')).progress[book.id];assert.equal(saved.page,5);assert.equal(saved.total,8);
      if(mode==='continuous')assert(Math.abs(saved.offset-.23)<.03);
      await open(book.id,5,mode);if(mode==='continuous')await assertOffset(5,.23);
      await page.locator('#page-slider').fill('6');await readPage(6,mode);
      if(mode==='continuous')await setOffset(6,.37);
      await nativeClose();
      const persisted=JSON.parse(fs.readFileSync(path.join(data,'reading-state.json'),'utf8'));
      assert.equal(persisted.progress[book.id].page,6);assert.equal(persisted.preferences[book.id].mode,mode);
      if(mode==='continuous')assert(Math.abs(persisted.progress[book.id].offset-.37)<.03);
      await launch();await page.getByRole('table',{name:'书库结果'}).waitFor();await open(book.id,6,mode);
      assert.equal(await page.getByLabel('阅读模式').inputValue(),mode);if(mode==='continuous')await assertOffset(6,.37);
      await page.locator('[data-action="exit-reader"]').click();await page.locator('.reader').waitFor({state:'detached'});
      cases.push({extension:path.extname(book.filepath),mode,page:6,offset:mode==='continuous'?.37:0});
      console.log(`PASS ${path.extname(book.filepath)} ${mode}: normal exit, immediate native close and restart restore page and offset.`);
    }
    for(const book of books){
      await page.locator(`#room [data-book="${book.id}"]`).press('Enter');await page.getByRole('button',{name:'在阅览室看'}).click();
      await page.locator('.scene-viewport[data-scene-state="ready"]').waitFor();await page.locator('#room-selection [data-read]').click();
      await readPage(6,'continuous');await assertOffset(6,.37);await page.locator('[data-action="exit-reader"]').click();
      await page.waitForFunction(()=>!document.querySelector('.reader')&&document.activeElement.matches('#room-selection [data-read]'));
      await page.locator('#room-selection [data-in-library]').click();
      await page.waitForFunction(id=>document.activeElement.dataset.book===id,book.id);
    }
    const layouts=[];
    for(const [width,height,zoom] of [[1280,720,1],[2560,1080,1],[1280,720,1.5],[640,720,1.5]]){
      await application.evaluate(({BrowserWindow},{width,height,zoom})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(width,height);win.webContents.setZoomFactor(zoom);},{width,height,zoom});
      const button=page.locator(`#room [data-book="${books[0].id}"]`);await button.scrollIntoViewIfNeeded();await button.press('Enter');
      const detail=page.getByRole('dialog',{name:'书籍详情',exact:true});await detail.waitFor();
      const detailBounds=await detail.evaluate(node=>{const bounds=node.getBoundingClientRect();return {x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height,viewportWidth:innerWidth,viewportHeight:innerHeight,overflow:node.scrollWidth>node.clientWidth+1};});
      assert(detailBounds.x>=-1&&detailBounds.y>=-1&&detailBounds.width<=detailBounds.viewportWidth+1&&detailBounds.height<=detailBounds.viewportHeight+1&&!detailBounds.overflow);
      await page.keyboard.press('Escape');await page.waitForFunction(id=>document.activeElement.dataset.book===id,books[0].id);
      await page.locator('.sidebar [data-action="reading-history"]').press('Enter');
      const history=page.getByRole('dialog',{name:'阅读记录',exact:true});await history.waitFor();
      assert.equal(await history.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
      await history.getByLabel('查找读过的书').fill('Neutral');await page.keyboard.press('Escape');
      layouts.push({width,height,zoom,detailBounds});
      console.log(`PASS Actual Electron ${width}x${height} at ${zoom*100}%: keyboard details, reading history and return focus fit the viewport.`);
    }
    for(const [file,hash] of originals)assert.equal(sha256(file),hash);assert.deepEqual(errors,[]);
    const output=path.join(root,'tools','.artifacts','reading-archives');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({date:new Date().toISOString(),cases,layouts,coldOpens,cancellation:{milliseconds:cancellationMs,phase:'after extraction before cache validation'},errors,originalHashesPreserved:originals.size,build:target.folder,packaged:Boolean(packaged),executableSha256:sha256(executable)},null,2));
    console.log('PASS All archive formats return from the room to the same book; original archives and pages keep their hashes.');
  } finally {await close();if(!isWithin(os.tmpdir(),fixture)||!path.basename(fixture).startsWith('yanruyu-archive-reading-'))throw new Error('Unsafe archive fixture cleanup');fs.rmSync(fixture,{recursive:true,force:true});}
}

main().catch(error=>{console.error(error);process.exitCode=1;});
