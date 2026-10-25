'use strict';

// The distributed classic UI is a preserved vendor bundle. These narrowly
// checked patches keep its reader connected to the maintained profile bridge.
const fs = require('node:fs');
const path = require('node:path');
const target = process.argv[2] || path.join(__dirname, '../resources/app/dist/assets/index-Db6-k1a1.js');
let source = fs.readFileSync(target, 'utf8');
const patches = [
  ['de.value=!1,localStorage.setItem("viewerReadingProgress",JSON.stringify([])),s.value=await ipcRenderer.invoke("force-gene-book-list")',
    'de.value=!1,await window.readingState.flush(),s.value=await ipcRenderer.invoke("force-gene-book-list")'],
  ['let d=null;const h=U(!1),p=_.throttle(re=>{d&&(h.value=!0,d.open(re))},1e3),m=()=>{if(d){h.value=!1',
    'let d=null,__readingReady=false;const h=U(!1),p=_.throttle(re=>{d&&(h.value=!0,d.open(re),window.readingState.attachComicReader(d,s.value))},1e3),m=()=>{if(d){window.readingState.closeComicReader();h.value=!1'],
  ['T.value=JSON.parse(localStorage.getItem("viewerReadingProgress"))||[]',
    'T.value=window.readingState.classicEntries()'],
  ['const de=(re,Se="100%")=>{J.value=!1,G.value=Se',
    'const de=(re,Se="100%")=>{__readingReady=false,T.value=window.readingState.classicEntries(),J.value=!1,G.value=Se'],
  ['ipcRenderer.invoke("load-manga-image-list",_.cloneDeep(re)).then(()=>{!a.value.viewerType||a.value.viewerType==="original"?(b.value=!0,a.value.keepReadingProgress&&E.value===!1&&je(re),te.close())',
    'ipcRenderer.invoke("load-manga-image-list",_.cloneDeep(re)).then(async()=>{!a.value.viewerType||a.value.viewerType==="original"?(b.value=!0,a.value.keepReadingProgress&&E.value===!1&&await je(re),__readingReady=true,te.close())'],
  ['re.readCount+=1,l(re)', 're.readCount=(re.readCount||0)+1,l(re)'],
  ['const Pe=(re=null)=>{ut(()=>{const Se=re||ie();if(y.value',
    'const Pe=(re=null)=>{ut(()=>{const Se=re||ie();if(__readingReady)window.readingState.captureClassic();if(y.value'],
  ['_e=()=>{C.value==="double"&&i("info",u("c.insertEmptyPageInfo"))',
    '_e=()=>{const __modePage=x.value||window.readingState.classicResume(s.value.id)?.pageId;C.value==="double"&&i("info",u("c.insertEmptyPageInfo"))'],
  ['setTimeout(()=>{ue(x.value),document.querySelector(".viewer-close-button").focus()},500)',
    'setTimeout(()=>{ue(__modePage),document.querySelector(".viewer-close-button").focus()},500)'],
  ['oe=()=>{J.value=!0;try{let re=ie();O.value.findIndex(we=>we.id===re)>s.value.pageCount-6&&(re=O.value[0].id),T.value.unshift({bookId:s.value.id,pageId:re}),localStorage.setItem("viewerReadingProgress",JSON.stringify(T.value.slice(0,1e3)))}catch{}}',
    '__readingOffset=re=>{if(C.value!=="scroll")return 0;const Se=Ae.value,we=document.getElementById(re)?.closest(".image-frame");return Se&&we?Math.max(0,Math.min(.99,(Se.getBoundingClientRect().top-we.getBoundingClientRect().top)/Math.max(1,we.offsetHeight))):0},oe=()=>{J.value=!0;try{if(!__readingReady)return;const re=ie();window.readingState.saveClassic(s.value,re,{total:O.value[0]?.total||s.value.pageCount,offset:__readingOffset(re),visiblePageIds:C.value==="double"?(I.value[Q.value]?.page||[]).map(we=>we.id):[],force:true}),T.value=window.readingState.classicEntries(),window.readingState.flush().catch(we=>i("error",we.message))}catch(re){i("error",re.message)}}'],
  ['je=async re=>{const Se=T.value.find(we=>we.bookId===re.id);if(Se){const we=Be=>new Promise(Oe=>setTimeout(Oe,Be));for(;!J.value;)',
    'je=async re=>{const Se=window.readingState.classicResume(re.id)||T.value.find(we=>we.bookId===re.id);if(Se){const we=Be=>new Promise(Oe=>setTimeout(Oe,Be));for(let __resumeWait=0;!J.value&&__resumeWait<240;__resumeWait++)'],
  ['if(O.value.length>re.pageCount-5||s.value.id!==re.id)break;',
    'if(O.value.length>=(O.value[0]?.total||re.pageCount)||s.value.id!==re.id)break;'],
  ['return ut(()=>document.querySelector(".drawer-viewer-body").scrollTop=Se),!1;',
    'return ut(()=>document.querySelector(".drawer-viewer-body").scrollTop=Se+parseFloat(pe(we).height)*(window.readingState.get(s.value.id)?.page===Number(re.slice(s.value.id.length+1))?window.readingState.get(s.value.id)?.offset||0:0)),!1;'],
  [';return t({drawerVisibleViewer:b,showThumbnail:E,currentImageIndex:Q,viewerImageList:O',
    ';window.readingState.registerClassicReader(()=>{if(!__readingReady||!b.value||E.value||(C.value==="single"&&!O.value[Q.value])||(C.value==="double"&&!I.value[Q.value]?.page?.length))return null;const re=ie();return{ready:true,book:s.value,pageId:re,total:O.value[0]?.total||s.value.pageCount,offset:__readingOffset(re),visiblePageIds:C.value==="double"?(I.value[Q.value]?.page||[]).map(we=>we.id):[]}});return t({drawerVisibleViewer:b,showThumbnail:E,currentImageIndex:Q,viewerImageList:O'],
];
for (const [before, after] of patches) {
  if (source.includes(after)) continue;
  if (source.split(before).length !== 2) throw new Error('Classic reader patch no longer matches: ' + before.slice(0, 100));
  source = source.replace(before, after);
}
fs.writeFileSync(target, source, 'utf8');
console.log('Classic reading-state bridge: ' + patches.length + ' verified patches');
