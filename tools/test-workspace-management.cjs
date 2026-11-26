'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createCollectionService } = require('../resources/app/modules/collections');
const { createBookFileService } = require('../resources/app/modules/book_files');
const { moveWithIdentity } = require('../resources/app/modules/library_identity');

test('legacy hash members become stable IDs while unresolved and unrelated collections remain intact', async () => {
  const books = [{ id:'copy-a', hash:'shared' }, { id:'copy-b', hash:'shared' }, { id:'third', hash:'third-hash' }];
  let collections = [{ id:'legacy', title:'Legacy', list:['shared','unresolved'] }, { id:'empty', title:'Other', list:[] }];
  const service = createCollectionService({ getBooks:async () => books, getCollections:async () => collections, saveCollections:async next => { collections=next; } });
  const listed = await service.command({ action:'list' });
  assert.deepEqual(listed.memberships.legacy.bookIds, ['copy-a','copy-b']);
  await service.command({ action:'members', collectionId:'legacy', removeBookIds:['copy-a'], addBookIds:['third'] });
  assert.deepEqual(collections[0].list, ['copy-b','third','unresolved']);
  assert.deepEqual(collections[1], { id:'empty', title:'Other', list:[] });
  await service.command({ action:'rename', collectionId:'legacy', title:'Changed' });
  assert.equal(collections[0].title, 'Changed');
  const created = await service.command({ action:'create', title:'New', bookIds:['copy-a','copy-a'] });
  assert.deepEqual(created.collections.at(-1).list, ['copy-a']);
});

test('collection write failure leaves the acknowledged archive and concurrent unrelated members intact', async () => {
  let collections = [{ id:'group', title:'Group', list:['one'] }], failed = true;
  const service = createCollectionService({ getBooks:async () => ['one','two','three'].map(id => ({id})), getCollections:async () => collections,
    saveCollections:async next => { if (failed) throw new Error('fixture read-only'); collections=next; } });
  await assert.rejects(service.command({ action:'members', collectionId:'group', addBookIds:['two'] }), /read-only/);
  assert.deepEqual(collections[0].list, ['one']);
  collections[0].list.push('three'); failed=false;
  await service.command({ action:'members', collectionId:'group', addBookIds:['two'] });
  assert.deepEqual(collections[0].list, ['one','three','two']);
  await assert.rejects(service.command({ action:'members', collectionId:'group', addBookIds:['missing'] }), /不在书库/);
  assert.deepEqual(collections[0].list, ['one','three','two']);
});

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yanruyu-book-files-'));
  t.after(async () => { assert(path.resolve(directory).startsWith(path.join(os.tmpdir(),'yanruyu-book-files-'))); await fs.rm(directory,{recursive:true,force:true}); });
  const library = path.join(directory,'library'), source = path.join(library,'Book'), destination = path.join(library,'Destination'), recycle = path.join(directory,'fixture-recycle');
  await Promise.all([fs.mkdir(source,{recursive:true}),fs.mkdir(destination,{recursive:true}),fs.mkdir(recycle)]);
  const originals = new Map();
  for (let index=1;index<=3;index++) {
    const filename = `${index}.png`, contents = Buffer.from(`neutral page ${index}`);
    await fs.writeFile(path.join(source,filename),contents); originals.set(filename,createHash('sha256').update(contents).digest('hex'));
  }
  await fs.writeFile(path.join(source,'notes.txt'),'unrelated user notes');
  let book = {id:'book',type:'folder',filepath:source,exist:true,readCount:7,mark:true,coverPath:'custom-cover'}, failSave=false, trashCalls=0, failTrash=0;
  const service = createBookFileService({ getBook:async id => id===book.id?book:null, getLibrary:() => library,
    listImages:async folder => (await fs.readdir(folder)).filter(name=>name.endsWith('.png')).map(name=>path.join(folder,name)),
    saveLocation:async (_id,patch) => { if(failSave)throw new Error('fixture database failure');book={...book,...patch}; },
    trash:async filename => {
      trashCalls++; if(trashCalls===failTrash)throw new Error('fixture recycle failure');
      assert(filename.startsWith(library+path.sep)); await fs.rename(filename,path.join(recycle,`${trashCalls}-${path.basename(filename)}`));
    } });
  return {directory,library,source,destination,recycle,service,originals,getBook:()=>book,setFailSave:value=>failSave=value,setFailTrash:value=>failTrash=value};
}

test('file move validates paths and occupied targets, preserves book identity and rolls back a failed database commit', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.previewMove('book',f.directory), /书库/);
  const nested = path.join(f.source,'Nested'); await fs.mkdir(nested);
  await assert.rejects(f.service.previewMove('book',nested), /子目录/);
  const occupied = path.join(f.destination,'Book'); await fs.mkdir(occupied);
  await assert.rejects(f.service.previewMove('book',f.destination), /同名/);
  await fs.rmdir(occupied);
  const preview = await f.service.previewMove('book',f.destination);
  assert.equal(f.getBook().filepath,f.source);
  f.setFailSave(true);
  await assert.rejects(f.service.apply(preview.token), /database failure/);
  assert.equal(f.getBook().filepath,f.source); assert.equal((await fs.stat(f.source)).isDirectory(),true);
  f.setFailSave(false);
  const retry = await f.service.previewMove('book',f.destination);
  await f.service.apply(retry.token);
  const book=f.getBook(); assert.equal(book.filepath,path.join(f.destination,'Book')); assert.equal(book.readCount,7);assert.equal(book.mark,true);assert.equal(book.coverPath,'custom-cover');
  for(const [name,hash] of f.originals) assert.equal(createHash('sha256').update(await fs.readFile(path.join(book.filepath,name))).digest('hex'),hash);
});

test('file changes after preview stop recycling before touching originals', async t => {
  const f = await fixture(t), preview = await f.service.previewRecycle('book');
  await fs.rename(path.join(f.source,'1.png'),path.join(f.source,'renamed.png'));
  await assert.rejects(f.service.apply(preview.token), /预览后改变/);
  assert.equal((await fs.readdir(f.recycle)).length,0); assert.equal(f.getBook().exist,true);
});

test('a destination created during archive fingerprinting is never overwritten', async t => {
  const f = await fixture(t), source = path.join(f.library,'neutral.cbz'), destination = path.join(f.destination,'neutral.cbz');
  await fs.writeFile(source,'neutral original archive');
  let persisted = false;
  await assert.rejects(moveWithIdentity({ oldPath:source, newPath:destination, type:'zip', libraryRoot:f.library,
    fingerprint:async () => { await fs.writeFile(destination,'concurrent destination'); return 'fixture-fingerprint'; },
    persist:async () => { persisted=true; } }), error => error.code === 'EEXIST' || /目标路径已存在/.test(error.message));
  assert.equal(await fs.readFile(source,'utf8'),'neutral original archive');
  assert.equal(await fs.readFile(destination,'utf8'),'concurrent destination');
  assert.equal(persisted,false);
});

test('recycling retains notes and book records, and a partial failure reports exactly what was moved', async t => {
  const f = await fixture(t);
  let preview=await f.service.previewRecycle('book'); f.setFailTrash(2);
  await assert.rejects(f.service.apply(preview.token), /已将 1 项/);
  assert.equal(f.getBook().exist,true);assert.equal((await fs.readdir(f.recycle)).length,1);
  assert.equal(await fs.readFile(path.join(f.source,'notes.txt'),'utf8'),'unrelated user notes');
  f.setFailTrash(0); preview=await f.service.previewRecycle('book');
  const result=await f.service.apply(preview.token);
  assert.equal(result.recordRetained,true);assert.equal(f.getBook().id,'book');assert.equal(f.getBook().exist,false);
  assert.equal(f.getBook().readCount,7);assert.equal(f.getBook().mark,true);
  assert.deepEqual(await fs.readdir(f.source),['notes.txt']);
  const recycled = await fs.readdir(f.recycle);
  for(const [name,hash] of f.originals){const filename=recycled.find(file=>file.endsWith('-'+name));assert(filename);assert.equal(createHash('sha256').update(await fs.readFile(path.join(f.recycle,filename))).digest('hex'),hash);}
});
