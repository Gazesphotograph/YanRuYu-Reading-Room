'use strict';

const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const importSource=name=>import('data:text/javascript;base64,'+fs.readFileSync(path.resolve(__dirname,'../resources/app/dist',name)).toString('base64'));

(async()=>{
  const {normalizeRoomPersonalization,normalizeRoomOptions,roomLayoutOffsets,selectFeaturedBooks,summarizeReadingProgress}=await importSource('room-personalization-state.js');
  const polluted=JSON.parse('{"themes":{"__proto__":{"current":{"layout":"airy"}},"paper":{"current":{"layout":"bogus","brightness":1000,"warmth":-100,"shelfOffset":"8","furnitureOffset":-999,"furniture":{"chair":false},"camera":{"yaw":100,"zoom":0}},"savedAt":"wrong"}},"featuredIds":["book-2","book-2","constructor","book-1","__proto__",5],"sound":{"kind":"remote-url","volume":999,"duringReading":"yes"}}');
  const normalized=normalizeRoomPersonalization(polluted);
  const {validateClientState}=require('../resources/app/modules/client_state');
  assert.doesNotThrow(()=>validateClientState({schemaVersion:1,values:{'room-personalization':JSON.stringify(normalized)}}),'Renderer normalization must match the portable backup validator');
  assert.doesNotThrow(()=>validateClientState({schemaVersion:1,values:{'room-personalization':JSON.stringify(normalizeRoomPersonalization())}}));
  assert.deepEqual(normalized.featuredIds,['book-2','book-1']);
  assert.equal(Object.keys(normalized.themes).length,8);
  assert.equal(normalized.themes.paper.current.layout,'balanced');
  assert.equal(normalized.themes.paper.current.brightness,125);
  assert.equal(normalized.themes.paper.current.warmth,-30);
  assert.equal(normalized.themes.paper.current.shelfOffset,0);
  assert.equal(normalized.themes.paper.current.furnitureOffset,-15);
  assert.deepEqual(normalized.themes.paper.current.camera,{yaw:.29,panX:0,panY:0,zoom:.72});
  assert.equal(normalized.themes.paper.current.furniture.chair,false);
  assert.equal(normalized.themes.paper.current.furniture.plants,true);
  assert.deepEqual(normalized.sound,{kind:'off',volume:40,duringReading:false});
  assert.deepEqual(normalizeRoomOptions({brightness:NaN,camera:{zoom:Infinity}}),normalizeRoomOptions());
  assert.equal(normalizeRoomPersonalization({featuredIds:Array.from({length:90},(_,index)=>'id-'+index)}).featuredIds.length,60);
  assert.deepEqual(roomLayoutOffsets({layout:'airy',shelfOffset:12,furnitureOffset:15},{narrow:true,capacity:12}),{shelf:[0],corner:0});
  const offsets=roomLayoutOffsets({layout:'cozy',shelfOffset:-12,furnitureOffset:-15},{capacity:12});
  assert(offsets.shelf[1]-offsets.shelf[0]>-.25,'Preset preserves sufficient cabinet spacing');
  const books=[{id:'book-1',title:'One'},{id:'book-2',title:'Two'},{id:'hidden',hiddenBook:true},{id:'book-3',title:'Three'},{id:'book-4'},{id:'book-1',title:'One'}];
  assert.deepEqual(selectFeaturedBooks(books,['missing','book-2','hidden','book-1','book-2']).map(book=>book.id),['book-2','book-1']);
  const now=1789344000000;
  const stats=summarizeReadingProgress(books,{'book-1':{page:4,total:10,time:now-1000},'book-2':{page:10,total:10,time:now-8*86400000},'book-3':{page:1,total:5,time:now+1000},'book-4':{page:'4',total:10,time:now},hidden:{page:30,total:30,time:now},missing:{page:4,total:10,time:now}},now);
  assert.deepEqual(Object.fromEntries(['total','recorded','finished','reading','unread','recentWeek'].map(key=>[key,stats[key]])),{total:4,recorded:3,finished:1,reading:2,unread:1,recentWeek:1});
  assert.deepEqual(stats.recent.map(record=>record.id),['book-1','book-2']);
  assert.equal('duration' in stats,false);

  const {RoomAmbientSound}=await importSource('room-ambient.js');
  let constructed=0,started=0,stopped=0;
  class FakeAudioContext {
    constructor(){constructed++;this.state='suspended';this.sampleRate=1000;this.currentTime=1;this.destination={};}
    resume(){this.state='running';return Promise.resolve();}
    suspend(){this.state='suspended';return Promise.resolve();}
    close(){this.state='closed';return Promise.resolve();}
    createBuffer(channels,length){return {getChannelData:()=>new Float32Array(length)};}
    createBufferSource(){return {connect(){},disconnect(){},start(){started++;},stop(){stopped++;}};}
    createBiquadFilter(){return {frequency:{value:0},connect(){},disconnect(){}};}
    createGain(){return {gain:{value:0,setTargetAtTime(){}},connect(){},disconnect(){}};}
  }
  const environment=new EventTarget();environment.document=new EventTarget();environment.document.hidden=false;environment.AudioContext=FakeAudioContext;
  const ambient=new RoomAmbientSound({environment});
  await ambient.configure({kind:'off',volume:20});assert.equal(constructed,0);
  await ambient.configure({kind:'rain',volume:20});assert.equal(constructed,0,'Remembered preference must not autoplay');
  await ambient.configure({kind:'rain',volume:20},{userGesture:true});assert.equal(constructed,1);assert.equal(ambient.context.state,'running');assert.equal(started,1);
  environment.document.hidden=true;environment.document.dispatchEvent(new Event('visibilitychange'));await ambient.queue;assert.equal(ambient.context.state,'suspended');
  environment.document.hidden=false;environment.document.dispatchEvent(new Event('visibilitychange'));await ambient.queue;assert.equal(ambient.context.state,'running');assert.equal(started,1,'Resume reuses its audio buffer');
  await ambient.setReaderOpen(true);assert.equal(ambient.context.state,'suspended');
  await ambient.configure({kind:'breeze',volume:20,duringReading:true},{userGesture:true});assert.equal(ambient.context.state,'running');assert.equal(started,2);assert.equal(stopped,1);
  environment.dispatchEvent(new Event('blur'));await ambient.queue;assert.equal(ambient.context.state,'suspended');
  environment.dispatchEvent(new Event('focus'));await ambient.queue;assert.equal(ambient.context.state,'running');
  await ambient.configure({kind:'off',volume:20});assert.equal(ambient.context.state,'suspended');assert.equal(stopped,2);
  const audioContext=ambient.context;ambient.dispose();assert.equal(audioContext.state,'closed');
  console.log('PASS room preferences: bounds, stable IDs, real progress statistics, narrow layout, optional audio lifecycle');
})().catch(error=>{console.error(error);process.exitCode=1;});
