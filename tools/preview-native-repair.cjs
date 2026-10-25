'use strict';
// An isolated packaged Electron window for Windows-native hit testing. It shares
// renderer files only, and never loads the real main process or book databases.
const fs=require('node:fs'),path=require('node:path');
const {createFixtures}=require('./test-gallery.cjs');
const base=path.resolve(__dirname,'..');
const runtime=path.join(base,'tmp','native-repair-runtime');
const appDir=path.join(runtime,'resources','app');
fs.mkdirSync(appDir,{recursive:true});
for(const entry of fs.readdirSync(base,{withFileTypes:true})){
  if(!entry.isFile()||!(/\.(exe|dll|pak|bin)$/i.test(entry.name)||['icudtl.dat','vk_swiftshader_icd.json','version'].includes(entry.name)))continue;
  const target=path.join(runtime,entry.name);if(!fs.existsSync(target))fs.linkSync(path.join(base,entry.name),target);
}
const locales=path.join(runtime,'locales');if(!fs.existsSync(locales))fs.symlinkSync(path.join(base,'locales'),locales,'junction');
const fixture=createFixtures(path.join(runtime,'fixtures'),12,64);
fs.writeFileSync(path.join(appDir,'fixture.json'),JSON.stringify(fixture));
fs.writeFileSync(path.join(appDir,'package.json'),JSON.stringify({name:'qiyue-native-repair-check',version:'1.0.0',main:'index.js'}));
const renderer=path.join(base,'resources','app','dist','index.html');
const icon=path.join(base,'resources','app','dist','icon.ico');
const profile=path.join(runtime,'profile');
fs.writeFileSync(path.join(appDir,'preload.js'),`const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('ipcRenderer',{invoke:(...args)=>ipcRenderer.invoke(...args),on:(channel,callback)=>ipcRenderer.on(channel,callback)});`);
fs.writeFileSync(path.join(appDir,'index.js'),`
const {app,BrowserWindow,ipcMain,Tray,Menu}=require('electron');
const fs=require('node:fs'),path=require('node:path');
app.setPath('userData',${JSON.stringify(profile)});
app.commandLine.appendSwitch('allow-file-access-from-files');
const fixture=require('./fixture.json'),events=[];let win,tray;
const report=()=>fs.writeFileSync(path.join(__dirname,'events.json'),JSON.stringify({events,visible:win?.isVisible(),maximized:win?.isMaximized(),bounds:win?.getBounds(),tray:!!tray},null,2));
const handle=(name,fn)=>ipcMain.handle(name,async(_,...args)=>{events.push({channel:name,args});const value=await fn(...args);report();return value;});
handle('load-setting',()=>({library:'模拟书库',imageExplorer:'',closeToTray:true}));
handle('save-setting',setting=>setting);
handle('load-book-list',()=>fixture.books);
handle('load-manga-image-list',()=>fixture.pages.map(absolutePath=>({absolutePath})));
handle('save-book',book=>{Object.assign(fixture.books.find(b=>b.id===book.id),book);return book;});
for(const name of ['release-sendimagelock','update-window-title','show-file','open-local-book'])handle(name,()=>null);
handle('window-minimize',()=>win.minimize());
handle('window-toggle-maximize',()=>win.isMaximized()?win.unmaximize():win.maximize());
handle('window-is-maximized',()=>win.isMaximized());
handle('window-close',()=>win.hide());
handle('select-folder',()=>null);handle('select-file',()=>null);
app.whenReady().then(async()=>{
  tray=new Tray(${JSON.stringify(icon)});tray.setToolTip('颜如玉 · 模拟交互验证');tray.setContextMenu(Menu.buildFromTemplate([{label:'显示验证窗口',click:()=>{win.show();win.restore();}},{label:'结束验证',click:()=>app.quit()}]));tray.on('click',()=>{win.show();win.restore();});
  win=new BrowserWindow({width:1420,height:920,minWidth:720,frame:false,title:'颜如玉 · 交互验证（模拟书库）',webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false}});
  win.on('page-title-updated',e=>e.preventDefault());
  win.on('move',report);win.on('resize',report);win.on('minimize',report);win.on('hide',report);
  await win.loadFile(${JSON.stringify(renderer)});
  await win.webContents.executeJavaScript('localStorage.setItem("room-theme",JSON.stringify("glass"));localStorage.setItem("reading-room-interface","room");');
  win.reload();report();
});
app.on('window-all-closed',()=>app.quit());
`);
console.log(JSON.stringify({executable:path.join(runtime,'exhentai-manga-manager.exe'),events:path.join(appDir,'events.json')}));
