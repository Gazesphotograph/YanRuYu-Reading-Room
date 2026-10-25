'use strict'

// Every archive, image and cache below is generated inside a fresh test folder.

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { createHash, randomUUID } = require('node:crypto')
const { createRequire } = require('node:module')
const { performance } = require('node:perf_hooks')
const project = path.resolve(__dirname, '..')
const appDir = path.join(project, 'resources/app')
const appRequire = createRequire(path.join(appDir, 'package.json'))
const { ArchiveCache, getArchiveCache, checkCancelled } = appRequire('./modules/archive_cache')
const { spawnPromise } = appRequire('./modules/process_runner')
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'yanruyu-archive-budget-'))
const output = path.resolve(__dirname, '.artifacts/phase2-cache')
const report = { date:new Date().toISOString(), checks:[], metrics:{}, errors:[] }
const pass = name => { report.checks.push(name); console.log('PASS '+name) }
const keyOf = name => createHash('sha256').update(name).digest('hex')
const abundant = async () => ({ bavail:100*1024**3, bsize:1 })
fs.mkdirSync(output,{recursive:true})

function fixtureCache(name, options={}) {
  return new ArchiveCache({rootPath:path.join(temporary,name),budgetBytes:60000,minFreeBytes:0,statfs:abundant,...options})
}

function fakeBook(cache,name,options={}) {
  const names=options.names||['page.png'],bytes=options.bytes||18000
  return cache.getOrCreate({key:keyOf(name),filepath:path.join(temporary,'sources',name+'.cbz'),owner:options.owner,signal:options.signal,onProgress:options.onProgress,
    inspect:async signal=>{checkCancelled(signal);return {names,expandedBytes:bytes*names.length}},
    extract:async(directory,info,signal,progress)=>{
      options.count?.()
      for(const relative of info.names){const filename=path.join(directory,relative);await fs.promises.mkdir(path.dirname(filename),{recursive:true});await fs.promises.writeFile(filename,Buffer.alloc(bytes,42))}
      if(options.extract)await options.extract(directory,info,signal,progress)
    }})
}

async function budgetChecks() {
  let time=10000,extractions=0
  const cache=fixtureCache('lru',{now:()=>++time})
  for(const name of ['a','b','c','d','e','f']){
    await fakeBook(cache,name,{owner:'reader',count:()=>extractions++})
    await cache.release('reader')
    const state=await cache.getStatus()
    assert(state.usedBytes<=state.budgetBytes)
  }
  assert.equal(extractions,6)
  const recent=await fakeBook(cache,'f',{owner:'reader',count:()=>extractions++})
  assert.equal(extractions,6,'A hot cache must avoid decompression')
  assert(fs.existsSync(recent[0].absolutePath))
  assert(!fs.existsSync(path.join(cache.rootPath,'archive-'+keyOf('a'))),'Least recently used entry is reclaimed')
  report.metrics.lru={requests:7,decompressions:extractions,...await cache.getStatus()}
  pass('Repeated books reuse disk cache; six different books stay within budget through LRU eviction')

  const pinned=fixtureCache('protected')
  const a=await fakeBook(pinned,'a',{owner:'one'})
  const b=await fakeBook(pinned,'b',{owner:'two'})
  let state=await pinned.clearUnused()
  assert.equal(state.removedEntries,0)
  assert.equal(state.activeEntries,2)
  await assert.rejects(fakeBook(pinned,'c',{owner:'three'}),/使用中/)
  assert(fs.existsSync(a[0].absolutePath)&&fs.existsSync(b[0].absolutePath))
  state=await pinned.setBudget(19000)
  assert(state.overBudgetBytes>0)
  assert(fs.existsSync(a[0].absolutePath)&&fs.existsSync(b[0].absolutePath))
  state=await pinned.release('one')
  assert(state.usedBytes<=state.budgetBytes)
  assert(!fs.existsSync(a[0].absolutePath)&&fs.existsSync(b[0].absolutePath))
  await pinned.release('two')
  assert.equal((await pinned.clearUnused()).entryCount,0)
  pass('In-use archives survive cleanup and budget reductions; released entries satisfy the new budget')

  let attempted=0
  const small=fixtureCache('too-large',{budgetBytes:20000})
  await assert.rejects(fakeBook(small,'large',{owner:'one',count:()=>attempted++}),/超过缓存预算/)
  assert.equal(attempted,0)
  const low=fixtureCache('low-disk',{minFreeBytes:5000,statfs:async()=>({bavail:30000,bsize:1})})
  await assert.rejects(fakeBook(low,'book',{owner:'one',count:()=>attempted++}),/磁盘空闲空间不足/)
  assert.equal(attempted,0)
  const unknown=fixtureCache('unknown-disk',{statfs:async()=>{throw new Error('simulated statfs failure')}})
  await assert.rejects(fakeBook(unknown,'book',{owner:'one'}),/无法确认缓存磁盘空闲空间/)
  pass('Oversized archives and insufficient or unreadable disk space are rejected before extraction')
}

async function cancellationChecks() {
  const cache=fixtureCache('cancel'),controller=new AbortController()
  const attempt=fakeBook(cache,'cancelled',{owner:'reader',signal:controller.signal,extract:async()=>{controller.abort();checkCancelled(controller.signal)}})
  await assert.rejects(attempt,{name:'AbortError'})
  await cache.release('reader')
  assert.deepEqual(fs.readdirSync(cache.rootPath),[])
  const retry=await fakeBook(cache,'cancelled',{owner:'reader'})
  assert(fs.existsSync(retry[0].absolutePath))
  pass('Cancellation removes incomplete extraction and the same book can be retried')

  const concurrent=fixtureCache('concurrent')
  let calls=0
  const result=await Promise.all([fakeBook(concurrent,'same',{owner:'a',count:()=>calls++}),fakeBook(concurrent,'same',{owner:'b',count:()=>calls++})])
  assert.equal(calls,1)
  assert.deepEqual(result[0],result[1])
  await concurrent.release('a')
  assert.equal((await concurrent.clearUnused()).activeEntries,1)
  pass('Concurrent requests decompress once and independent owners keep their protection')

  const queued=fixtureCache('queued'),abort=new AbortController()
  let unlock,started
  const running=new Promise(resolve=>{started=resolve})
  const first=fakeBook(queued,'first',{owner:'first',extract:()=>new Promise(resolve=>{unlock=resolve;started()})})
  await running
  let secondExtracted=false
  const second=fakeBook(queued,'second',{owner:'second',signal:abort.signal,count:()=>{secondExtracted=true}})
  abort.abort()
  await assert.rejects(Promise.race([second,new Promise((_,reject)=>setTimeout(()=>reject(new Error('Queued cancellation delayed')),150))]),{name:'AbortError'})
  unlock();await first;await queued.release('first')
  assert.equal(secondExtracted,false)
  pass('Queued cancellation returns immediately and never starts a later extraction')

  const processAbort=new AbortController()
  const processWork=spawnPromise(process.execPath,['-e','setTimeout(()=>{},30000)'],60000,{signal:processAbort.signal})
  processAbort.abort()
  await assert.rejects(processWork,{name:'AbortError'})
  pass('Cancelling a running child process terminates it and reports AbortError')
}

async function ownershipChecks() {
  const cache=fixtureCache('missing',{budgetBytes:150000})
  let extracts=0
  const args={owner:'reader',names:['01.png','02.png','03.png'],count:()=>extracts++}
  const list=await fakeBook(cache,'missing',args)
  await cache.release('reader')
  fs.unlinkSync(list[1].absolutePath)
  const retry=await fakeBook(cache,'missing',args)
  assert.equal(extracts,2)
  assert(fs.existsSync(retry[1].absolutePath))
  pass('A missing middle page invalidates the entire cache and triggers a complete rebuild')

  const recovery=fixtureCache('recovery')
  fs.mkdirSync(recovery.rootPath,{recursive:true})
  const unfinished=path.join(recovery.rootPath,'.archive-pending-'+keyOf('interrupted')+'-'+randomUUID())
  fs.mkdirSync(unfinished)
  fs.writeFileSync(path.join(unfinished,'.manager-cache.json'),JSON.stringify({application:'yanruyu-archive-cache',version:1,state:'complete'}))
  fs.writeFileSync(path.join(unfinished,'page.png'),'unfinished')
  const personal=path.join(recovery.rootPath,'personal-notes')
  fs.mkdirSync(personal);fs.writeFileSync(path.join(personal,'keep.txt'),'keep')
  const legacy=path.join(recovery.rootPath,'archive-'+keyOf('legacy'))
  fs.mkdirSync(legacy);fs.writeFileSync(path.join(legacy,'.manager-images.json'),JSON.stringify(['old.png']));fs.writeFileSync(path.join(legacy,'old.png'),'neutral')
  await recovery.initialize()
  assert(!fs.existsSync(unfinished))
  assert.equal((await recovery.getStatus()).entryCount,1)
  await recovery.clearUnused()
  assert(!fs.existsSync(legacy))
  assert.equal(fs.readFileSync(path.join(personal,'keep.txt'),'utf8'),'keep')
  pass('Startup removes owned incomplete stages and adopts legacy cache without touching unrelated files')

  const linked=fixtureCache('linked'),external=path.join(temporary,'outside-cache')
  fs.mkdirSync(external);fs.writeFileSync(path.join(external,'keep.txt'),'outside stays')
  const linkedList=await fakeBook(linked,'linked',{owner:'reader'})
  await linked.release('reader')
  const link=path.join(path.dirname(linkedList[0].absolutePath),'unexpected-link')
  fs.symlinkSync(external,link,process.platform==='win32'?'junction':'dir')
  await assert.rejects(linked.clearUnused(),/链接/)
  assert.equal(fs.readFileSync(path.join(external,'keep.txt'),'utf8'),'outside stays')
  fs.unlinkSync(link)
  await linked.clearUnused()
  pass('Cleanup refuses linked directories and preserves files outside the managed cache')
}

function loadModule(relative,overrides) {
  const filename=path.join(appDir,relative),nativeRequire=createRequire(filename)
  const context={module:{exports:{}},console,Buffer,process,setTimeout,clearTimeout,require:name=>Object.hasOwn(overrides,name)?overrides[name]:nativeRequire(name)}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),context,{filename})
  return context.module.exports
}

async function archiveChecks() {
  const AdmZip=appRequire('adm-zip'),sharp=appRequire('sharp')
  const store=path.join(temporary,'archive-integration'),viewer=path.join(store,'viewer'),tempRoot=path.join(store,'scan-temp'),coverRoot=path.join(store,'cover'),sourceRoot=path.join(store,'source')
  for(const directory of [viewer,tempRoot,coverRoot,sourceRoot])fs.mkdirSync(directory,{recursive:true})
  const archive=loadModule('fileLoader/archive.js',{'../modules/utils.js':{getRootPath:()=>project}})
  let state=931
  const raw=Buffer.alloc(256*256*3)
  for(let i=0;i<raw.length;i++){state=(Math.imul(state,1664525)+1013904223)>>>0;raw[i]=165+(state%70)}
  const png=await sharp(raw,{raw:{width:256,height:256,channels:3}}).png().toBuffer()
  const archives=[]
  for(let index=0;index<7;index++){
    const zip=new AdmZip(),filename=path.join(sourceRoot,'neutral-'+index+'.cbz')
    for(let page=0;page<4;page++)zip.addFile('章节 '+index+'/'+String(page+1).padStart(2,'0')+' #%.png',png)
    zip.addFile('notes.txt',Buffer.alloc(200000,42))
    zip.addFile('__MACOSX/ignored.png',png)
    zip.writeZip(filename);archives.push(filename)
  }
  const cache=getArchiveCache(viewer),budget=png.length*9+25000
  await cache.setBudget(budget)
  const metrics=[],progress=[]
  for(const filename of archives){
    await cache.release('reader')
    const start=performance.now()
    const list=await archive.getImageListFromArchive(filename,viewer,{owner:'reader',onProgress:item=>progress.push(item.phase)})
    assert.equal(list.length,4)
    for(const page of list)assert.deepEqual(fs.readFileSync(page.absolutePath),png)
    assert(!fs.existsSync(path.join(path.dirname(path.dirname(list[0].absolutePath)),'notes.txt')))
    const status=await cache.getStatus()
    assert(status.usedBytes<=budget)
    metrics.push({coldMs:performance.now()-start,usedBytes:status.usedBytes,entries:status.entryCount})
  }
  const cold=metrics.at(-1),hotStart=performance.now()
  await archive.getImageListFromArchive(archives.at(-1),viewer,{owner:'reader'})
  const hotMs=performance.now()-hotStart
  report.metrics.archives={format:'CBZ / ZIP',books:7,pagesPerBook:4,width:256,height:256,pngBytes:png.length,budgetBytes:budget,uncappedImageBytes:png.length*4*7,actualPeakBytes:Math.max(...metrics.map(item=>item.usedBytes)),peakEntries:Math.max(...metrics.map(item=>item.entries)),coldLastMs:cold.coldMs,hotLastMs:hotMs}
  assert(progress.includes('inspect')&&progress.includes('extract')&&progress.includes('complete'))
  pass('Real 7-Zip extraction handles Unicode and special filenames, excludes non-images, reports progress and obeys a disk budget')

  const cancel=new AbortController(),cancelViewer=path.join(store,'cancel-viewer')
  await assert.rejects(archive.getImageListFromArchive(archives[0],cancelViewer,{owner:'reader',signal:cancel.signal,onProgress:item=>{if(item.phase==='extract')cancel.abort()}}),{name:'AbortError'})
  await getArchiveCache(cancelViewer).release('reader')
  assert.deepEqual(fs.readdirSync(cancelViewer),[])
  await archive.getImageListFromArchive(archives[0],cancelViewer,{owner:'reader'})
  pass('Real archive cancellation leaves no partial files and retry succeeds')

  const paths={TEMP_PATH:tempRoot,COVER_PATH:coverRoot,VIEWER_PATH:viewer,STORE_PATH:store}
  const folder=loadModule('fileLoader/folder.js',{electron:{shell:{}}})
  const loader=loadModule('fileLoader/index.js',{'./archive.js':archive,'./folder.js':folder,'../modules/init_folder_setting.js':paths})
  const taskRoot=path.join(tempRoot,'task-fixture')
  const cover=await loader.geneCover(archives[0],'zip',{tempRoot:taskRoot})
  assert(fs.existsSync(cover.coverPath)&&fs.existsSync(cover.targetFilePath))
  assert(cover.targetFilePath.startsWith(taskRoot+path.sep))
  assert.equal(cover.pageCount,4)
  const listing=await loader.getBookFilelist(sourceRoot)
  assert.equal(listing.length,7)
  const signal=new AbortController();signal.abort()
  await assert.rejects(loader.geneCover(archives[0],'zip',{signal:signal.signal,tempRoot:path.join(tempRoot,'cancelled')}),{name:'AbortError'})
  await assert.rejects(loader.getBookFilelist(sourceRoot,{signal:signal.signal}),{name:'AbortError'})
  assert(!fs.existsSync(path.join(tempRoot,'cancelled')))
  pass('Scanner cover extraction honors its own temporary root and cancelled scanning starts no file work')
}

(async()=>{
  try{await budgetChecks();await cancellationChecks();await ownershipChecks();await archiveChecks();console.log(JSON.stringify(report.metrics,null,2))}
  catch(error){report.errors.push(error.stack);throw error}
  finally{
    fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(report,null,2))
    if(path.dirname(temporary)!==os.tmpdir()||!path.basename(temporary).startsWith('yanruyu-archive-budget-'))throw new Error('Unsafe test cleanup path')
    fs.rmSync(temporary,{recursive:true,force:true})
  }
})().catch(error=>{console.error(error);process.exitCode=1})
