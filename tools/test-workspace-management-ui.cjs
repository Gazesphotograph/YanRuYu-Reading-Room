'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('./playwright-runtime.cjs');
const { appURL, attachFakeIpc, createFakeModel, createFixtures, launchOptions } = require('./test-gallery.cjs');
const { createCollectionService } = require('../resources/app/modules/collections');
const { createLocalSearchService } = require('../resources/app/modules/local_search');

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-workspace-management-ui-'));
  let browser, searchService;
  try {
    const {books,pages}=createFixtures(directory,3,4), model=createFakeModel(books,pages);
    const collectionService=createCollectionService({getCollections:()=>model.collections,getBooks:async()=>model.books,saveCollections:async collections=>{model.collections=collections;}});
    searchService=createLocalSearchService({storePath:directory,getBooks:async()=>model.books});
    const importedText=await searchService.command({action:'preview-text',bookId:books[2].id,page:3,text:'Northern lights in a quiet neutral reading room.'});
    await searchService.command({action:'save-text',token:importedText.token});await searchService.waitForIdle();
    const originalInvoke=model.invoke.bind(model);
    let holdNextTextSearch=false, releaseTextSearch, notifyTextHeld;
    const textHeld=new Promise(resolve=>notifyTextHeld=resolve);
    model.invoke=async(channel,...args)=>{
      if(channel==='collection-command')return collectionService.command(args[0]);
      if(channel==='local-search-command'){
        if(args[0].action==='search'&&args[0].workspace&&holdNextTextSearch){holdNextTextSearch=false;await new Promise(resolve=>{releaseTextSearch=resolve;notifyTextHeld();});}
        return searchService.command(args[0]);
      }
      if(channel==='data-locations')return {storePath:directory,metadataPath:path.join(directory,'metadata.sqlite')};
      if(channel==='import-library-sqlite')return {success:true,canceled:false,counts:{imported:1,skipped:2,unmatched:0,failed:0},failureDetails:[],unmatched:[],message:'导入完成：成功 1，跳过 2。'};
      return originalInvoke(channel,...args);
    };
    browser=await chromium.launch(launchOptions());
    const context=await browser.newContext({viewport:{width:720,height:520},reducedMotion:'reduce'});
    await attachFakeIpc(context,model,{forceWebglUnavailable:true});
    await context.addInitScript(()=>localStorage.setItem('room-workspace-preview','true'));
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(appURL);await page.locator('[data-desk-book]').first().waitFor();
    const nav=name=>page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name,exact:true});
    await nav('书库').click();await page.getByRole('button',{name:'表格视图'}).click();
    const table=page.getByRole('table',{name:'书库结果'});
    await table.locator(`[data-check-book="${books[0].id}"]`).check();await table.locator(`[data-check-book="${books[1].id}"]`).check();
    await page.getByRole('button',{name:'加入合集',exact:true}).click();
    const collections=page.getByRole('dialog',{name:'管理合集',exact:true});
    await collections.getByLabel('新合集名称').fill('中性两册');
    await collections.getByRole('button',{name:'创建合集并加入所选 2 本'}).click();
    await collections.getByRole('status').filter({hasText:'合集已创建'}).waitFor();
    assert.deepEqual(model.collections[0].list,[books[0].id,books[1].id]);
    await collections.locator(`[data-collection-book="${books[0].id}"]`).uncheck();
    await collections.getByRole('button',{name:'保存成员变更'}).click();
    await collections.getByRole('status').filter({hasText:'合集成员已保存'}).waitFor();
    assert.deepEqual(model.collections[0].list,[books[1].id]);
    await page.keyboard.press('Escape');
    await page.getByLabel('按合集浏览').selectOption(model.collections[0].id);
    await page.waitForFunction(()=>document.querySelectorAll('.library-table tbody tr').length===1);
    assert.equal(await table.locator('[data-book]').getAttribute('data-book'),books[1].id);
    await page.getByLabel('按合集浏览').selectOption('');
    await page.getByLabel('搜索范围').selectOption('text');
    await page.getByLabel('搜索书名、作者或标签').fill('Northern lights');
    await table.locator(`[data-match-book="${books[2].id}"]`).waitFor();
    assert.equal(await table.locator('tbody tr').count(),1);
    const currentCheck=table.locator(`[data-check-book="${books[2].id}"]`);
    await currentCheck.check();holdNextTextSearch=true;
    await page.evaluate(()=>window.__galleryEmit('library-updated',{kind:'fixture-refresh'}));
    await page.waitForFunction(()=>document.querySelector('#workspace-search-status')?.textContent.includes('正在匹配'));
    assert.equal(await currentCheck.isChecked(),true,'Refreshing the same text query retains selection while results are pending');
    assert.equal(await table.locator('tbody tr').count(),1);
    await textHeld;
    releaseTextSearch();
    await page.waitForFunction(()=>document.querySelector('#workspace-search-status')?.textContent.includes('匹配 1 本'));
    assert.equal(await currentCheck.isChecked(),true);
    await table.getByRole('button',{name:'文本命中 · 第 3 页'}).click();
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent==='3 / 4');
    await page.locator('[data-action="exit-reader"]').click();
    await page.waitForFunction(()=>!document.querySelector('.reader'));
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(),'Northern lights');
    const target=table.locator(`[data-book="${books[2].id}"]`);
    assert.equal(await target.evaluate(node=>node===document.activeElement),true);
    assert.equal(await target.evaluate(node=>node.hasAttribute('data-selected')),true);
    await target.press('Enter');
    const detail=page.getByRole('dialog',{name:'书籍详情',exact:true});
    await detail.getByRole('button',{name:'在阅览室看'}).click();
    await page.locator(`#room [data-book="${books[2].id}"]`).waitFor();
    await page.locator('#room-selection').getByRole('button',{name:'在书库显示'}).click();
    await table.waitFor();assert.equal(await page.getByLabel('搜索范围').inputValue(),'text');
    assert.equal(await page.getByLabel('搜索书名、作者或标签').inputValue(),'Northern lights');
    await page.reload();await page.locator('[data-desk-resume]').waitFor();await nav('书库').click();await table.locator(`[data-match-book="${books[2].id}"]`).waitFor();
    assert.equal(await table.locator('tbody tr').count(),1);
    await page.locator('[data-action="settings"]').click();
    await page.getByRole('button',{name:'打开设置',exact:true}).click();
    const system=page.getByRole('dialog',{name:'系统与阅读设置',exact:true});
    await system.getByLabel('点击页面左右区域翻页').check();
    await system.getByRole('button',{name:'保存系统设置'}).click();
    await system.getByRole('status').filter({hasText:'系统设置已保存'}).waitFor();
    assert.equal(model.setting.readerClickToTurn,true);assert.equal(model.setting.library,'仅供自动检查的模拟书库');
    await page.keyboard.press('Escape');
    await table.getByRole('button',{name:'文本命中 · 第 3 页'}).click();
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent==='3 / 4');
    const body=page.locator('#reader-body'),box=await body.boundingBox();
    await page.mouse.click(box.x+box.width*.25,box.y+box.height*.5);
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent==='2 / 4');
    await page.getByLabel('阅读方向').selectOption('rtl');
    await page.mouse.click(box.x+box.width*.75,box.y+box.height*.5);
    await page.waitForFunction(()=>document.querySelector('#reader-page')?.textContent==='1 / 4');
    await page.locator('[data-action="exit-reader"]').click();
    await page.locator('.sidebar [data-action="library-import"]').click();
    const imports=page.getByRole('dialog',{name:'书库导入',exact:true});
    await imports.getByRole('button',{name:'选择 SQLite 并导入'}).click();
    await imports.getByRole('status').filter({hasText:'导入完成'}).waitFor();
    assert.match(await imports.innerText(),/导入 1 · 跳过 2/);
    assert.deepEqual(errors,[]);
    console.log('PASS Three-book management UI: table-to-collection, member edits, local page search, reader and room return, restart, system settings, page clicks and import feedback.');
  } finally {
    await browser?.close();await searchService?.dispose();
    assert(path.resolve(directory).startsWith(path.join(os.tmpdir(),'yanruyu-workspace-management-ui-')));fs.rmSync(directory,{recursive:true,force:true});
  }
}

main().catch(error=>{console.error(error);process.exitCode=1;});
