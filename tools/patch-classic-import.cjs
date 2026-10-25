'use strict';

// Matching upstream Vue is preserved under source/manager-upstream-v1.6.15/. These narrowly
// scoped, idempotent patches document the local manager's import/export adapter.
const fs = require('node:fs');
const path = require('node:path');
const patches = [
  [
    '$=async()=>{const{success:Q,bList:ee}=await ipcRenderer.invoke("import-sqlite",_.cloneDeep(s.value));Q?(s.value=ee,c("success",d("c.importMessage"))):c("info",d("c.canceled"))}',
    '$=async()=>{try{const Q=await ipcRenderer.invoke("import-sqlite",_.cloneDeep(s.value));Q.bList&&(s.value=Q.bList),Q.canceled?c("info",d("c.canceled")):c(Q.success?"success":Q.partial?"warning":"error",Q.message||d("c.importMessage"))}catch(Q){c("error",String(Q.message||Q))}}',
  ],
  [
    'q=async()=>{const Q=await ipcRenderer.invoke("select-folder",d("c.exportFolder"));await ipcRenderer.invoke("export-database",Q)&&c("success",d("c.exportMessage"))}',
    'q=async()=>{try{const Q=await ipcRenderer.invoke("select-folder",d("c.exportFolder"));Q&&await ipcRenderer.invoke("export-database",Q)&&c("success","完整备份已保存，可从备份与恢复面板还原。") }catch(Q){c("error",String(Q.message||Q))}}',
  ],
  [
    'R=async()=>{const Q=await ipcRenderer.invoke("select-file",d("c.selectCollectionList"),[{name:"JSON",extensions:["json"]}]),ee=await ipcRenderer.invoke("select-file",d("c.selectMetadataSqlite"),[{name:"SQLite",extensions:["sqlite"]}]);await ipcRenderer.invoke("import-database",{collectionListPath:Q,metadataSqlitePath:ee})}',
    'R=async()=>{try{const Q=await ipcRenderer.invoke("select-file",d("c.selectCollectionList"),[{name:"JSON",extensions:["json"]}]);if(!Q)return;const ee=await ipcRenderer.invoke("select-file",d("c.selectMetadataSqlite"),[{name:"SQLite",extensions:["sqlite"]}]);ee&&await ipcRenderer.invoke("import-database",{collectionListPath:Q,metadataSqlitePath:ee})}catch(Q){c("error",String(Q.message||Q))}}',
  ],
];

function patchClassicImports(source) {
  for (const [before, after] of patches) {
    if (source.includes(after)) continue;
    if (source.split(before).length !== 2) throw new Error('The manager import adapter no longer matches its recorded source; review instead of guessing.');
    source = source.replace(before, after);
  }
  return source;
}

if (require.main === module) {
  const target = path.resolve(process.argv[2] || path.join(__dirname, '../resources/app/dist/assets/index-Db6-k1a1.js'));
  const before = fs.readFileSync(target, 'utf8'), after = patchClassicImports(before);
  if (before !== after) fs.writeFileSync(target, after);
  console.log(before === after ? 'Classic import adapter already current.' : 'Classic import adapter patched.');
}

module.exports = { patchClassicImports };
