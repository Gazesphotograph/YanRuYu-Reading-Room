'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {chromium}=require('./playwright-runtime.cjs');
const {appURL,createFixtures,createFakeModel,attachFakeIpc,launchOptions}=require('./test-gallery.cjs');

async function main(){
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'yanruyu-selection-return-'));let browser;
  try {
    const {books,pages}=createFixtures(fixture,3,3),model=createFakeModel(books,pages);
    browser=await chromium.launch(launchOptions());const context=await browser.newContext({viewport:{width:1280,height:720},reducedMotion:'reduce'});
    await attachFakeIpc(context,model);await context.addInitScript(()=>{
      localStorage.setItem('room-workspace-preview','true');localStorage.setItem('room-workspace-start-page',JSON.stringify('library'));localStorage.setItem('room-workspace-library-view',JSON.stringify('table'));
    });
    const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(appURL);
    const table=page.getByRole('table',{name:'书库结果'});await table.waitFor();
    const book=id=>table.locator(`[data-book="${id}"]`),check=id=>table.locator(`[data-check-book="${id}"]`);
    const search=page.getByLabel('搜索书名、作者或标签');await search.fill('静物档案');
    await check(books[0].id).check();await check(books[1].id).check();await book(books[0].id).press('Enter');await page.keyboard.press('Escape');
    model.books.splice(0,1);await page.evaluate(()=>window.__galleryEmit('library-updated',{kind:'fixture-delete'}));
    await page.waitForFunction(()=>document.querySelectorAll('.library-table tbody tr').length===2);
    await page.waitForFunction(id=>document.activeElement.dataset.book===id,books[1].id);
    assert.equal(await book(books[1].id).evaluate(node=>node.hasAttribute('data-selected')),true);
    assert.equal(await check(books[1].id).isChecked(),true);assert.equal(await search.inputValue(),'静物档案');
    assert.match(await page.locator('#filtered-book-notice').innerText(),/从书库移除/);assert.equal(await page.locator('[data-show-filtered-book]').isVisible(),false);

    await book(books[1].id).press('Enter');model.books.find(book=>book.id===books[1].id).hiddenBook=true;
    await page.evaluate(()=>window.__galleryEmit('library-updated',{kind:'fixture-hide'}));
    await page.waitForFunction(()=>document.querySelectorAll('.library-table tbody tr').length===1);
    assert.equal(await page.getByRole('dialog',{name:'书籍详情',exact:true}).isVisible(),true);
    await page.keyboard.press('Escape');const viewBook=page.getByRole('button',{name:'查看此书',exact:true});
    assert.equal(await viewBook.evaluate(node=>node===document.activeElement),true);assert.match(await page.locator('#filtered-book-notice').innerText(),/已隐藏/);
    await viewBook.press('Enter');await page.getByRole('heading',{name:books[1].title,exact:true}).waitFor();await page.keyboard.press('Escape');
    assert.equal(await viewBook.evaluate(node=>node===document.activeElement),true);assert.equal(await search.inputValue(),'静物档案');

    model.books.find(book=>book.id===books[1].id).hiddenBook=false;await page.evaluate(()=>window.__galleryEmit('library-updated',{kind:'fixture-unhide'}));
    await book(books[1].id).waitFor();await check(books[1].id).check();await check(books[2].id).check();await book(books[1].id).press('Enter');
    model.books.find(book=>book.id===books[1].id).title='另一册';await page.evaluate(()=>window.__galleryEmit('library-updated',{kind:'fixture-metadata'}));
    await page.waitForFunction(()=>document.querySelectorAll('.library-table tbody tr').length===1);await page.keyboard.press('Escape');
    assert.equal(await viewBook.evaluate(node=>node===document.activeElement),true);assert.equal(await search.inputValue(),'静物档案');assert.equal(await check(books[2].id).isChecked(),true);
    await viewBook.press('Enter');await page.getByRole('heading',{name:'另一册',exact:true}).waitFor();await page.keyboard.press('Escape');
    assert.deepEqual(errors,[]);
    console.log('PASS Selected-book deletion, hiding and filtering preserve the query, neighboring selection, retained checks and return focus.');
  } finally {await browser?.close();assert(path.resolve(fixture).startsWith(path.join(os.tmpdir(),'yanruyu-selection-return-')));fs.rmSync(fixture,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
