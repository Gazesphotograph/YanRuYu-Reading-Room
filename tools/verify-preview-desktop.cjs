'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const {fs,path,root,isWithin,sha256} = require('./project/common.cjs');
const {auditRelease} = require('./project/audit.cjs');
const {_electron} = require('./playwright-runtime.cjs');

async function verify(folder) {
  folder=path.resolve(folder);
  if(!isWithin(path.join(root,'out'),folder))throw new Error('Preview package must be a generated folder below out/.');
  const executable=path.join(folder,'exhentai-manga-manager.exe');
  const manifest=JSON.parse(fs.readFileSync(path.join(folder,'build-manifest.json'),'utf8'));
  assert.equal(manifest.developmentPreview,true);
  auditRelease(folder);
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-preview-verification-'));
  const data=path.join(fixture,'data'),library=path.join(fixture,'library'),bookFolder=path.join(library,'Neutral packaged reader');
  const env={...process.env,YANRUYU_DATA_DIR:data};delete env.ELECTRON_RUN_AS_NODE;
  const sharp=require(path.join(folder,'resources','app','node_modules','sharp'));
  const hashes=new Map(),checks=[],errors=[];let application,page;
  const pass=message=>{checks.push(message);console.log('PASS '+message);};
  const invoke=(channel,...args)=>page.evaluate(({channel,args})=>window.ipcRenderer.invoke(channel,...args),{channel,args});
  async function launch(){
    application=await _electron.launch({executablePath:executable,args:['--enable-unsafe-swiftshader'],cwd:folder,env,timeout:45000});
    page=await application.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>errors.push(error.message));
  }
  async function close(){if(!application)return;await application.evaluate(({app})=>app.quit()).catch(()=>{});await application.close().catch(()=>{});application=null;}
  const readPage=number=>page.waitForFunction(number=>document.querySelector('#reader-page')?.textContent===`${number} / 4`&&document.querySelector(`.paged-sheet[data-reader-page="${number}"] img`)?.naturalWidth>0,number);
  try {
    fs.mkdirSync(bookFolder,{recursive:true});
    for(let number=1;number<=4;number++){
      const file=path.join(bookFolder,`${number}.png`);await sharp({create:{width:90,height:130,channels:3,background:{r:40*number,g:100,b:130}}}).png().toFile(file);hashes.set(file,sha256(file));
    }
    await launch();
    assert.equal(await application.evaluate(({app})=>app.isPackaged),true);
    assert.equal(await application.evaluate(({app})=>app.getVersion()),manifest.appVersion);
    assert.equal(await application.evaluate(({app})=>app.getPath('userData')),path.join(data,'.reading-room'));
    const decoded=await application.evaluate(({app})=>{
      const path=process.getBuiltinModule('path'),require=process.getBuiltinModule('module').createRequire(path.join(app.getAppPath(),'package.json'));
      return require('./modules/metadata_sources').decodeText('Caf&eacute; &NotEqualTilde;');
    });
    assert.equal(decoded,'Café ≂̸');
    await page.locator('[data-action="settings"]').click();await page.getByRole('button',{name:'启用 2.0 预览'}).click();
    await application.evaluate(({dialog},selected)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[selected]});},library);
    await page.locator('#reading-desk').getByRole('button',{name:'选择书库文件夹'}).click();
    const book=page.locator('[data-desk-book]').first();await book.waitFor();const id=await book.getAttribute('data-read');
    await book.press('Enter');await readPage(1);await page.getByLabel('阅读模式').selectOption('double');
    await page.locator('#page-slider').fill('3');await readPage(3);await page.locator('[data-action="exit-reader"]').click();
    await page.locator('.reader').waitFor({state:'detached'});await page.evaluate(()=>window.YanruyuClientState.flush());
    const windowTitle=await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].getTitle());
    assert.ok(windowTitle.includes(manifest.appVersion),windowTitle);
    pass('Packaged executable, native dependencies, decoder and isolated first scan open a real book.');
    await close();await launch();await page.locator('[data-desk-resume]').click();await readPage(3);
    assert.equal(await page.getByLabel('阅读模式').inputValue(),'double');await page.locator('[data-action="exit-reader"]').click();
    await page.locator('.reader').waitFor({state:'detached'});
    const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true});
    await nav('书库').click();await page.getByRole('button',{name:'表格视图'}).click();
    await page.locator(`#room [data-book="${id}"]`).press('Enter');await page.getByRole('button',{name:'在阅览室看'}).click();
    await page.locator('.scene-viewport[data-scene-state="ready"]').waitFor();
    await page.locator('#room-selection [data-in-library]').click();
    assert.equal(await page.getByRole('table',{name:'书库结果'}).isVisible(),true);
    await page.waitForFunction(id=>document.activeElement.dataset.book===id,id);
    pass('Packaged restart resumes the same page and mode; room assets load and return to the selected table row.');
    const profile=await invoke('load-reading-state');assert.equal(profile.progress[id].page,3);assert.equal(profile.preferences[id].mode,'double');
    for(const [file,hash] of hashes)assert.equal(sha256(file),hash);
    assert.deepEqual(errors,[]);await close();const audit=auditRelease(folder);
    pass('Package audit remains clean after startup; all original neutral pages and saved reading records are intact.');
    const output=path.join(root,'tools','.artifacts','preview-desktop');fs.mkdirSync(output,{recursive:true});
    fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({date:new Date().toISOString(),folder,checks,errors,audit,sourceHashes:manifest.sourceHashes},null,2));
  } finally {
    await close();if(!isWithin(os.tmpdir(),fixture)||!path.basename(fixture).startsWith('yanruyu-preview-verification-'))throw new Error('Unexpected preview verification fixture');
    fs.rmSync(fixture,{recursive:true,force:true});
  }
}

if(!process.argv[2])throw new Error('Provide the generated 2.0 preview package folder.');
verify(process.argv[2]).catch(error=>{console.error(error);process.exitCode=1;});
