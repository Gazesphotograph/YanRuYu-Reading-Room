const { chromium } = require('./playwright-runtime.cjs');
const { createFixtures, createFakeModel, attachFakeIpc, launchOptions, appURL } = require('./test-gallery.cjs');
const fs=require('node:fs'),path=require('node:path');
(async()=>{
  const out=path.resolve(process.env.GALLERY_PREVIEW_OUTPUT||path.join(__dirname,'.artifacts','previews'));fs.mkdirSync(out,{recursive:true});
  const fixture=createFixtures(path.join(out,'fixtures'),25);
  const browser=await chromium.launch(launchOptions());
  try{
    const context=await browser.newContext({viewport:{width:1560,height:1000}});
    const model=createFakeModel(fixture.books.slice(0,Number(process.env.GALLERY_COUNT||3)),fixture.pages);
    await attachFakeIpc(context,model);const page=await context.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(appURL);await page.waitForSelector('.scene-viewport[data-scene-state="ready"]');
    await page.waitForFunction(()=>[...document.querySelectorAll('.scene-book-target')].every(el=>el.dataset.coverState!=='loading'));
    const theme=process.env.GALLERY_THEME||'paper';
    if(theme!=='paper'){await page.locator('[data-action="theme"]').first().click();await page.locator(`[data-theme-choice="${theme}"]`).click();await page.keyboard.press('Escape');}
    await page.mouse.move(1540,970);await page.waitForTimeout(700);
    await page.screenshot({path:path.join(out,`${theme}-${model.books.length}-全景.png`),fullPage:true});
    console.log(JSON.stringify({errors,scene:await page.locator('.scene-viewport').evaluate(el=>({state:el.dataset.sceneState,rect:el.getBoundingClientRect().toJSON(),renderCount:el.dataset.renderCount})),books:await page.locator('[data-book]').evaluateAll(els=>els.map(el=>({id:el.dataset.book,state:el.dataset.coverState,rect:el.getBoundingClientRect().toJSON()})))},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
