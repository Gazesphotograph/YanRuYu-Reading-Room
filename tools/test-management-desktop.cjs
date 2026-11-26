'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const {fs,path,root,sha256,isWithin,electronExecutable} = require('./project/common.cjs');
const {build} = require('./project/build.cjs');
const {_electron} = require('./playwright-runtime.cjs');

async function main() {
  const reusable=process.env.YANRUYU_TEST_BUILD&&path.resolve(process.env.YANRUYU_TEST_BUILD);
  if(reusable&&(!isWithin(path.join(root,'.build'),reusable)||reusable===path.join(root,'.build')))throw new Error('Invalid reusable staging build');
  const target=reusable?{folder:reusable,app:path.join(reusable,'resources','app')}:build();
  const native=name=>require(path.join(target.app,'node_modules',name)),sharp=native('sharp');
  const {open}=native('sqlite'),{Database}=native('sqlite3');
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-management-desktop-'));
  const data=path.join(fixture,'data'),library=path.join(fixture,'library'),destination=path.join(library,'Destination'),recycle=path.join(fixture,'fixture-recycle');
  const originals=new Map(),errors=[];let application,page;
  const env={...process.env,YANRUYU_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  const launcher=path.join(fixture,'launcher.cjs');
  const payload={gmetadata:[{gid:123,token:'abcdef1234',title:'Neutral online title',tags:['artist:Online Studio'],rating:'4.5',filecount:'99',category:'Non-H'}]};
  async function launch(){
    application=await _electron.launch({executablePath:electronExecutable(),args:[launcher,'--enable-unsafe-swiftshader'],cwd:target.folder,env,timeout:45000});
    page=await application.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
    await page.locator('#local-count').filter({hasText:/本/}).waitFor();
  }
  async function close(){if(!application)return;await application.evaluate(({app})=>app.quit()).catch(()=>{});await application.close().catch(()=>{});application=null;}
  const invoke=(channel,...args)=>page.evaluate(({channel,args})=>window.ipcRenderer.invoke(channel,...args),{channel,args});
  const database=file=>open({filename:path.join(data,file),driver:Database});
  try {
    fs.mkdirSync(data);fs.mkdirSync(destination,{recursive:true});fs.mkdirSync(recycle);
    fs.writeFileSync(path.join(data,'setting.json'),JSON.stringify({library,hideTitleBar:true,loadOnStart:false,autoCheckUpdates:false,enabledLANBrowsing:false,closeToTray:false,minimizeOnStart:false,startOnLogin:false,requireGap:0,imageExplorer:'"C:/old release/resources/extraResources/manga_reader.exe"'}));
    for(let volume=1;volume<=2;volume++){
      const folder=path.join(library,'Neutral volume '+volume);fs.mkdirSync(folder);
      for(let index=1;index<=4;index++){
        const file=path.join(folder,`${index}.png`);await sharp({create:{width:80,height:120,channels:3,background:{r:40*volume,g:30*index,b:120}}}).png().toFile(file);originals.set(file,sha256(file));
      }
      const note=path.join(folder,'notes.txt');fs.writeFileSync(note,'Neutral notes '+volume);originals.set(note,sha256(note));
    }
    fs.writeFileSync(launcher,`const {app,Tray}=require('electron');
app.getAppPath=()=>${JSON.stringify(target.app)};
const setTrayMenu=Tray.prototype.setContextMenu;
Tray.prototype.setContextMenu=function(menu){app.fixtureTrayMenu=menu;return setTrayMenu.call(this,menu);};
app.fixtureMetadata={fail:true};
const sources=require(${JSON.stringify(path.join(target.app,'modules','metadata_sources.js'))});
const factory=sources.createMetadataSources;
sources.createMetadataSources=options=>factory({...options,request:async(url,options)=>{
  if(app.fixtureMetadata.fail){app.fixtureMetadata.fail=false;throw new Error('fixture HTTP 503');}
  if(app.fixtureMetadata.wait){app.fixtureMetadata.wait=false;await new Promise((resolve,reject)=>{
    const abort=()=>{const error=new Error('fixture cancelled');error.name='AbortError';reject(error);};
    options.signal.addEventListener('abort',abort,{once:true});app.releaseFixtureMetadata=()=>{options.signal.removeEventListener('abort',abort);resolve();};
  });}
  if(!options.data) return '<a href="/g/123/abcdef1234/">Neutral online title</a>';
  const response=${JSON.stringify(payload)};
  [response.gmetadata[0].gid,response.gmetadata[0].token]=options.data.gidlist[0];
  return JSON.stringify(response);
}});
require(${JSON.stringify(path.join(target.app,'index.js'))});`);
    await launch();assert.equal((await invoke('load-setting')).imageExplorer,'');await invoke('load-book-list',true);
    const books=(await invoke('load-book-list',false)).sort((a,b)=>a.filepath.localeCompare(b.filepath)),first=books[0],second=books[1];assert.equal(books.length,2);
    await page.evaluate(()=>{localStorage.setItem('reading-room-interface','classic');localStorage.setItem('room-workspace-library-view',JSON.stringify('table'));location.reload();});
    await page.getByRole('table',{name:'书库结果'}).waitFor();
    assert.equal(await page.locator('[data-action="classic"]').count(),0);
    assert.equal(await page.evaluate(()=>localStorage.getItem('reading-room-interface')),null);
    await invoke('save-reading-progress',first.id,{page:2,total:4,time:Date.now()-7200000,source:'room'});
    await close();
    const readingFile=path.join(data,'reading-state.json'),old=JSON.parse(fs.readFileSync(readingFile,'utf8'));
    delete old.visits;old.migrationSnapshots.push({storage:{recentRead:JSON.stringify([{id:second.id,read_time:Math.floor(Date.now()/1000)-3600}])}});
    fs.writeFileSync(readingFile,JSON.stringify(old));
    await launch();await page.getByRole('table',{name:'书库结果'}).waitFor();
    assert.equal((await invoke('load-reading-state')).visits[second.id].source,'migration');assert.equal((await invoke('load-reading-state')).progress[second.id],undefined);
    console.log('PASS Real startup recovers an archived open-only reading record without assigning a page.');

    const request={bookId:first.id,url:'https://exhentai.org/g/123/abcdef1234/'};
    await assert.rejects(invoke('metadata-source-preview',request),/HTTP 503/);
    assert.equal((await invoke('load-book-list',false)).find(book=>book.id===first.id).title,first.title);
    let failed=(await invoke('task-list')).find(task=>task.kind==='metadata-fetch'&&task.status==='failed');assert(failed?.canRetry);
    const retry=await invoke('task-retry',failed.id);
    await page.waitForFunction(id=>window.YanruyuTasks.tasks.some(task=>task.id===id&&task.status==='completed'),retry.id);
    const completed=(await invoke('task-list')).find(task=>task.id===retry.id),preview=await invoke('metadata-source-get-preview',completed.result.previewId);
    const metadata=await database('metadata.sqlite');
    try {
      await metadata.exec("CREATE TRIGGER fixture_metadata_failure BEFORE INSERT ON Metadata BEGIN SELECT RAISE(ABORT,'fixture metadata write failure'); END");
      await assert.rejects(invoke('metadata-source-apply',{previewId:preview.previewId,fields:['title','tags']}),/metadata write failure/);
      assert.equal((await invoke('load-book-list',false)).find(book=>book.id===first.id).title,first.title);
      await metadata.exec('DROP TRIGGER fixture_metadata_failure');
      await invoke('metadata-source-apply',{previewId:preview.previewId,fields:['title','tags']});
      const saved=(await invoke('load-book-list',false)).find(book=>book.id===first.id);
      assert.equal(saved.title,'Neutral online title');assert.equal(saved.pageCount,4);assert.equal(saved.coverPath,first.coverPath);assert.equal(saved.rating,first.rating);
    } finally {await metadata.close();}
    await application.evaluate(({app})=>{app.fixtureMetadata.wait=true;});
    const cancelledRequest=invoke('metadata-source-preview',request);const rejected=assert.rejects(cancelledRequest,/cancelled|取消/);
    await page.waitForFunction(()=>window.YanruyuTasks.tasks.some(task=>task.kind==='metadata-fetch'&&task.status==='running'));
    const active=(await invoke('task-list')).find(task=>task.kind==='metadata-fetch'&&task.status==='running');await invoke('task-cancel',active.id);await rejected;
    console.log('PASS Real IPC metadata failure, task retry, cancelled request and two-database rollback retain local data.');

    const created=await invoke('collection-command',{action:'create',title:'Neutral pair',bookIds:books.map(book=>book.id)});
    await invoke('collection-command',{action:'members',collectionId:created.collectionId,removeBookIds:[second.id]});
    assert.deepEqual((await invoke('load-collection-list'))[0].list,[first.id]);
    const sourceFile=path.join(fixture,'source.sqlite'),source=await open({filename:sourceFile,driver:Database});
    await source.exec('CREATE TABLE invalid_fixture (value TEXT)');await source.close();
    await application.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},sourceFile);
    const failedImport=await invoke('import-library-sqlite',{bookIds:[second.id]});assert.equal(failedImport.success,false);
    const importTask=(await invoke('task-list')).find(task=>task.kind==='sqlite-import');assert.equal(importTask.status,'completed-with-errors');
    const repaired=await open({filename:sourceFile,driver:Database});await repaired.exec('CREATE TABLE gallery (gid INTEGER, token TEXT, title TEXT, artist TEXT)');
    await repaired.run('INSERT INTO gallery VALUES (?,?,?,?)',[321,'abcdef3210',path.basename(second.filepath),'["Imported Studio"]']);await repaired.close();
    const sourceHash=sha256(sourceFile),importRetry=await invoke('task-retry',importTask.id);
    await page.waitForFunction(id=>window.YanruyuTasks.tasks.some(task=>task.id===id&&task.status==='completed'),importRetry.id);
    assert.equal((await invoke('load-book-list',false)).find(book=>book.id===second.id).tags.artist[0],'Imported Studio');assert.equal(sha256(sourceFile),sourceHash);
    console.log('PASS SQLite import records failure details, retries a repaired source and preserves stable collection IDs.');

    await application.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},destination);
    const sharedSource=await database('database.sqlite');
    try {
      await sharedSource.run("INSERT INTO Mangas (id,title,filepath,type,hash,createdAt,updatedAt) SELECT 'duplicate-fixture',title,UPPER(filepath),type,hash,createdAt,updatedAt FROM Mangas WHERE id=?",first.id);
      await assert.rejects(invoke('book-file-preview-move',first.id),/同一来源/);
      await assert.rejects(invoke('book-file-preview-recycle',first.id),/同一来源/);
      assert.equal(fs.existsSync(first.filepath),true);
      await sharedSource.run("DELETE FROM Mangas WHERE id='duplicate-fixture'");
    } finally {await sharedSource.close();}
    const move=await invoke('book-file-preview-move',first.id);assert.equal(fs.existsSync(first.filepath),true);
    await invoke('book-file-apply',move.token);const moved=path.join(destination,path.basename(first.filepath));
    assert.equal((await invoke('load-book-list',false)).find(book=>book.id===first.id).filepath,moved);
    await application.evaluate(({app,shell},value)=>{
      const fs=process.getBuiltinModule('fs/promises'),path=process.getBuiltinModule('path');app.fixtureRecycled=[];
      shell.trashItem=async filename=>{
        const resolved=path.resolve(filename);if(!resolved.startsWith(path.resolve(value.library)+path.sep))throw new Error('Fixture recycle outside its library');
        const target=path.join(value.recycle,`${app.fixtureRecycled.length}-${path.basename(filename)}`);await fs.rename(resolved,target);app.fixtureRecycled.push([resolved,target]);
      };
    },{library,recycle});
    const removal=await invoke('book-file-preview-recycle',first.id);assert.equal(removal.imageCount,4);await invoke('book-file-apply',removal.token);
    const retained=(await invoke('load-book-list',false)).find(book=>book.id===first.id);assert.equal(retained.exist,false);assert.equal((await invoke('load-reading-state')).progress[first.id].page,2);
    assert.equal(fs.readFileSync(path.join(moved,'notes.txt'),'utf8'),'Neutral notes 1');
    const recycled=new Map(await application.evaluate(({app})=>app.fixtureRecycled));
    for(const [filename,hash] of originals){let current=filename.startsWith(first.filepath+path.sep)?path.join(moved,path.relative(first.filepath,filename)):filename;current=recycled.get(current)||current;assert.equal(sha256(current),hash);}
    console.log('PASS Real file operations preserve the book ID, progress, notes and every original file hash.');

    await application.evaluate(({shell})=>{shell.openPath=async()=>'';});
    await page.locator(`#room [data-book="${second.id}"]`).press('Enter');
    const detail=page.getByRole('dialog',{name:'书籍详情',exact:true});await detail.getByRole('switch',{name:'使用外部阅读器'}).check();await detail.locator(`[data-read="${second.id}"]`).click();
    await page.waitForFunction(id=>window.readingState.visits[id]?.source==='external',second.id);
    assert.equal((await invoke('load-reading-state')).progress[second.id],undefined);await page.keyboard.press('Escape');
    const legacyOpen=await invoke('open-local-book',second.filepath);
    assert.equal(legacyOpen.recorded,true);assert.equal(legacyOpen.bookId,second.id);
    const beforeTray=(await invoke('load-reading-state')).visits[second.id].time;
    await application.evaluate(async({app})=>{await app.fixtureTrayMenu.items.find(item=>item.label==='随机打开漫画').click();});
    const afterTray=await invoke('load-reading-state');
    assert(afterTray.visits[second.id].time>=beforeTray);assert.equal(afterTray.visits[second.id].source,'external');assert.equal(afterTray.progress[second.id],undefined);
    await page.locator('.sidebar [data-action="reading-history"]').click();
    const history=page.getByRole('dialog',{name:'阅读记录',exact:true});
    assert.match(await history.innerText(),/外部阅读器/);assert.match(await history.innerText(),/未记录页码/);await page.keyboard.press('Escape');
    const settingFile=path.join(data,'setting.json'),settingBefore=await invoke('load-setting'),settingBytes=fs.readFileSync(settingFile);
    fs.chmodSync(settingFile,0o444);
    try {await assert.rejects(invoke('save-setting',{...settingBefore,readerClickToTurn:true}));assert.deepEqual(await invoke('load-setting'),settingBefore);assert.deepEqual(fs.readFileSync(settingFile),settingBytes);}
    finally {fs.chmodSync(settingFile,0o666);}
    await invoke('save-setting',{...settingBefore,readerClickToTurn:true});
    await close();await launch();
    assert.equal((await invoke('load-setting')).readerClickToTurn,true);
    assert.equal((await invoke('load-reading-state')).visits[second.id].source,'external');
    assert.deepEqual((await invoke('load-collection-list'))[0].list,[first.id]);
    assert.equal((await invoke('load-book-list',false)).length,2);assert.deepEqual(errors,[]);
    console.log('PASS External reading records and system settings persist after restart; failed settings writes change neither memory nor disk.');
    await application.evaluate(({app})=>{app.fixtureMetadata.fail=false;});
    const batch = async () => {
      const job = await invoke('task-start','metadata-batch',{scope:'all',source:'exhentai'});
      await page.waitForFunction(id=>window.YanruyuTasks.tasks.some(task=>task.id===id && !['queued','running'].includes(task.status)),job.id);
      const done = (await invoke('task-list')).find(task=>task.id===job.id);
      assert.equal(done.status,'completed',JSON.stringify(done.errors)); return done.result;
    };
    assert.equal((await batch()).updated,2);
    assert.equal((await batch()).unchanged,2);
    assert.equal((await invoke('load-reading-state')).progress[first.id].page,2);
    console.log('PASS Whole-library online metadata task saves both SQLite records, preserves progress and skips identical writes on refresh.');

    await page.locator('.sidebar [data-action="settings"]').click();
    await page.locator('[data-action="system-settings"]').click();
    const system=page.getByRole('dialog',{name:'系统与阅读设置'});
    await system.getByLabel('最小化时隐藏到托盘').check();
    await system.getByRole('button',{name:'保存系统设置'}).click();
    await system.getByRole('status').filter({hasText:'系统设置已保存'}).waitFor();
    const metadataFolder=path.join(fixture,'separate-metadata');
    fs.mkdirSync(metadataFolder);
    await application.evaluate(({dialog},folder)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[folder]});},metadataFolder);
    await system.getByRole('button',{name:'选择元数据目录'}).click();
    await system.locator('.data-location-info').filter({hasText:metadataFolder}).waitFor();
    assert.equal((await invoke('load-setting')).metadataPath,metadataFolder);
    assert(fs.existsSync(path.join(metadataFolder,'metadata.sqlite')));
    await system.getByRole('button',{name:'使用默认目录'}).click();
    await system.getByRole('status').filter({hasText:'已恢复默认元数据目录'}).waitFor();
    assert.equal((await invoke('data-locations')).metadataPath,path.join(data,'metadata.sqlite'));
    assert.equal((await invoke('load-setting')).minimizeToTray,true);
    await page.keyboard.press('Escape');

    await page.locator(`#room [data-book="${second.id}"]`).press('Enter');
    const options=page.getByRole('dialog',{name:'书籍详情',exact:true});
    await options.getByRole('switch',{name:'使用外部阅读器'}).uncheck();
    await options.locator('[data-read]').click();
    await page.waitForFunction(()=>document.querySelector('.reader-body img')?.naturalWidth>0);
    await page.locator('#reader-page-input').fill('3');
    await page.locator('#reader-page-input').press('Enter');
    await page.waitForFunction(()=>document.querySelector('[data-reader-page="3"] img')?.naturalWidth>0);
    await application.evaluate(({app,clipboard,shell},folder)=>{
      clipboard.writeImage=image=>{app.fixtureCopiedSize=image.getSize();};
      shell.trashItem=async filename=>{
        const path=process.getBuiltinModule('path');
        await process.getBuiltinModule('fs/promises').rename(filename,path.join(folder,'page-'+path.basename(filename)));
      };
    },recycle);
    await page.getByText('书页与切换',{exact:true}).click();
    await page.getByRole('button',{name:'复制当前页'}).click();
    await page.locator('#toast').filter({hasText:'图片已复制'}).waitFor();
    assert.deepEqual(await application.evaluate(({app})=>app.fixtureCopiedSize),{width:80,height:120});
    await page.getByRole('button',{name:'设当前页为封面'}).click();
    await page.locator('#toast').filter({hasText:'封面已保存'}).waitFor();
    const withCover=(await invoke('load-book-list',false)).find(book=>book.id===second.id);
    assert.match(path.basename(withCover.coverPath),/^custom-/);
    const thirdFile=path.join(second.filepath,'3.png');
    page.once('dialog',dialog=>dialog.dismiss());
    await page.getByRole('button',{name:'删除当前页'}).click();
    assert.equal(sha256(thirdFile),originals.get(thirdFile));
    page.once('dialog',dialog=>dialog.accept());
    await page.getByRole('button',{name:'删除当前页'}).click();
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent==='3 / 3'&&document.querySelector('[data-reader-page="3"] img')?.naturalWidth>0);
    await page.locator('[data-action="exit-reader"]').click();
    await page.locator('.reader').waitFor({state:'detached'});
    assert.equal(sha256(path.join(recycle,'page-3.png')),originals.get(thirdFile));
    const edited=(await invoke('load-book-list',false)).find(book=>book.id===second.id);
    assert.equal(edited.pageCount,3);assert.equal(edited.coverPath,withCover.coverPath);
    assert.equal(edited.readCount,withCover.readCount);
    assert.equal((await invoke('load-reading-state')).progress[second.id].page,3);
    assert.deepEqual(errors,[]);
    console.log('PASS Migrated classic profile, metadata directory switching, tray settings, page clipboard, cover, confirmed recycle and resume through the current UI.');

  } finally {
    await close();
    if(!isWithin(os.tmpdir(),fixture)||!path.basename(fixture).startsWith('yanruyu-management-desktop-'))throw new Error('Unsafe fixture cleanup');
    fs.rmSync(fixture,{recursive:true,force:true});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
