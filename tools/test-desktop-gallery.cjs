const { _electron }=require('./playwright-runtime.cjs');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base=path.resolve(__dirname,'..'),out=path.join(base,'tools','.artifacts','desktop');
fs.mkdirSync(out,{recursive:true});
const checks=[],errors=[];const pass=name=>{checks.push(name);console.log('PASS '+name);};
(async()=>{
  const app=await _electron.launch({executablePath:path.join(base,'exhentai-manga-manager.exe'),cwd:base,timeout:35000});
  let page,originalStorage,selected,originalCount;
  try{
    page=await app.firstWindow();page.on('pageerror',error=>errors.push(error.message));
    await page.waitForLoadState('domcontentloaded');
    originalStorage=await page.evaluate(()=>Object.fromEntries(Object.entries(localStorage).filter(([key])=>key.startsWith('room-')||key==='reading-room-interface')));
    await page.evaluate(()=>{localStorage.setItem('reading-room-interface','room');localStorage.setItem('room-view','"shelf"');localStorage.setItem('room-reading-mode','"paged"');localStorage.setItem('room-external-reader','false');});
    await page.reload();await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    const books=await page.evaluate(()=>window.ipcRenderer.invoke('load-book-list',false));
    assert(books.length>0);
    await page.waitForFunction(()=>[...document.querySelectorAll('.scene-book-target')].every(el=>el.dataset.coverState==='loaded'));
    pass(`Packaged Electron starts in WebGL with ${books.filter(book=>!book.hiddenBook).length} real books; visible first-page covers load`);
    await page.locator('[data-book]').first().click();await page.waitForSelector('.drawer');await page.keyboard.press('Escape');
    assert(await page.evaluate(()=>!!document.activeElement?.dataset.book));pass('Real book details open and return keyboard focus');
    const originalTheme=await page.locator('html').getAttribute('data-room-theme');
    await page.locator('[data-action="theme"]').first().click();
    for(const theme of ['paper','forest','hub','ex','terminal','neon','acid','glass']){
      await page.locator(`[data-theme-choice="${theme}"]`).click();
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-scene-theme'),theme);
      assert.equal(await page.locator('.scene-viewport').getAttribute('data-scene-state'),'ready');
    }
    await page.locator(`[data-theme-choice="${originalTheme}"]`).click();await page.keyboard.press('Escape');pass('All eight material and interface themes apply in the desktop app');
    selected=books.filter(book=>!book.hiddenBook&&book.filepath&&fs.existsSync(book.filepath)).sort((a,b)=>(a.bundleSize||0)-(b.bundleSize||0))[0];
    if(selected){
    originalCount=selected.readCount;
    await page.locator('[data-view="grid"]').click();
    const visible=page.locator(`[data-book="${selected.id}"]`);
    if(!(await visible.count())){await page.locator('#search').fill(selected.title_jpn||selected.title);}
    await page.locator(`[data-book="${selected.id}"]`).dblclick();
    await page.waitForFunction(()=>document.querySelector('.reader-body img')?.naturalWidth>0,{},{timeout:120000});
    await page.locator('#page-slider').fill('2');
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent.startsWith('2 /')&&document.querySelector('.reader-body img')?.naturalWidth>0,{},{timeout:60000});
    await page.keyboard.press('Escape');await page.waitForSelector('.reader',{state:'detached'});pass('Actual source book opens, displays page two and returns to the library');
    }else{
      const fixtureRoot=path.resolve(process.env.GALLERY_REAL_LIBRARY||path.join(base,'..','..','Comic'));
      const dirs=fs.readdirSync(fixtureRoot,{withFileTypes:true}).filter(entry=>entry.isDirectory()).map(entry=>path.join(fixtureRoot,entry.name));
      assert(dirs.length,'No source folders are available for read-only verification');
      const total=await page.evaluate(async dirs=>{
        let pages=0;
        for(const [i,filepath] of dirs.entries()){
          const list=await window.ipcRenderer.invoke('load-manga-image-list',{id:'audit-fixture-'+i,type:'folder',filepath},{backgroundProcessing:false});
          if(!list.length)throw new Error('Fixture folder has no pages');
          for(const entry of list){
            const image=new Image();
            image.src='file:///'+entry.absolutePath.replace(/\\/g,'/').split('/').map((part,index)=>index===0?part:encodeURIComponent(part)).join('/');
            await image.decode();if(!image.naturalWidth)throw new Error('Image has no width');
            image.removeAttribute('src');pages++;
          }
        }
        await window.ipcRenderer.invoke('release-sendimagelock');return pages;
      },dirs);
      pass(`Configured source is unavailable; ${dirs.length} Desktop Comic folders / ${total} pages pass real IPC loading and image decoding without changing the library`);
      await page.locator('[data-view="grid"]').click();
    }
    await page.locator('#search').fill('');
    await page.locator('[data-action="classic"]').click({noWaitAfter:true});
    await page.waitForFunction(()=>!document.querySelector('.shell')&&document.querySelector('#app')?.children.length>0,{},{timeout:30000});
    await page.getByRole('button',{name:'返回 3D 阅览室',exact:true}).click({noWaitAfter:true});await page.waitForSelector('#room [data-book]');pass('Full management interface and return work');
    await page.locator('[data-view="shelf"]').click();await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    const size=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getContentSize());
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setContentSize(720,700));
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);pass('Native 720px desktop window has no horizontal overflow');
    await app.evaluate(({BrowserWindow},size)=>BrowserWindow.getAllWindows()[0].setContentSize(...size),size);
    assert.deepEqual(errors,[]);pass('No renderer JavaScript errors in the packaged desktop app');
  }finally{
    if(page&&!page.isClosed()){
      if(selected)await page.evaluate(async patch=>{
        const all=await window.ipcRenderer.invoke('load-book-list',false),current=all.find(book=>book.id===patch.id);
        if(current&&current.readCount!==patch.readCount)await window.ipcRenderer.invoke('save-book',{...current,readCount:patch.readCount});
      },{id:selected.id,readCount:originalCount}).catch(error=>errors.push('restore read count: '+error.message));
      if(originalStorage)await page.evaluate(original=>{
        for(const key of Object.keys(localStorage))if(key.startsWith('room-')||key==='reading-room-interface')localStorage.removeItem(key);
        for(const [key,value]of Object.entries(original))localStorage.setItem(key,value);
      },originalStorage);
    }
    fs.writeFileSync(path.join(out,'desktop-checks.json'),JSON.stringify({date:new Date().toISOString(),checks,errors},null,2));
    await app.evaluate(({BrowserWindow,app})=>{for(const win of BrowserWindow.getAllWindows())win.destroy();app.quit();}).catch(()=>{});
    await app.close().catch(()=>{});
  }
})().catch(error=>{console.error(error.message);process.exitCode=1});
