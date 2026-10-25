// Bounded, serializable room preferences. No scene, storage or DOM dependency.
export const PERSONAL_ROOM_THEMES = ['paper', 'glass', 'forest', 'hub', 'ex', 'terminal', 'neon', 'acid'];
export const ROOM_LAYOUTS = [
  { id:'balanced', name:'经典布置', description:'保留熟悉的书架与阅读角' },
  { id:'airy', name:'舒展陈列', description:'书架间留出更多空隙，阅读角向外舒展' },
  { id:'cozy', name:'紧凑书房', description:'书架与阅读角稍稍靠拢' },
];
export const ROOM_FURNITURE = [
  { id:'chair', name:'阅读椅' }, { id:'table', name:'边桌' }, { id:'lamp', name:'落地灯' },
  { id:'rug', name:'地毯' }, { id:'plants', name:'绿植' }, { id:'objects', name:'摆件与挂画' },
];
const plain = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const finite = (value, fallback, min, max) => typeof value === 'number' && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
export const validFeaturedId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(id);

export function normalizeRoomCamera(value) {
  value=plain(value);
  return { yaw:finite(value.yaw,0,-.29,.29), panX:finite(value.panX,0,-1.8,1.8), panY:finite(value.panY,0,-1.15,1.15), zoom:finite(value.zoom,1,.72,1.9) };
}

export function normalizeRoomOptions(value) {
  value=plain(value);
  const furniture=plain(value.furniture);
  return {
    layout:ROOM_LAYOUTS.some(layout=>layout.id===value.layout)?value.layout:'balanced',
    shelfOffset:Math.round(finite(value.shelfOffset,0,-12,12)),
    furnitureOffset:Math.round(finite(value.furnitureOffset,0,-15,15)),
    brightness:Math.round(finite(value.brightness,100,75,125)),
    warmth:Math.round(finite(value.warmth,0,-30,30)),
    furniture:Object.fromEntries(ROOM_FURNITURE.map(item=>[item.id,furniture[item.id]!==false])),
    camera:normalizeRoomCamera(value.camera),
  };
}

export function normalizeRoomPersonalization(value) {
  value=plain(value);
  const themes=plain(value.themes), sound=plain(value.sound);
  return {
    schemaVersion:1,
    themes:Object.fromEntries(PERSONAL_ROOM_THEMES.map(theme=>{
      const entry=plain(themes[theme]);
      return [theme,{current:normalizeRoomOptions(entry.current),saved:normalizeRoomOptions(entry.saved),savedAt:finite(entry.savedAt,0,0,Number.MAX_SAFE_INTEGER)}];
    })),
    featuredIds:[...new Set(Array.isArray(value.featuredIds)?value.featuredIds.filter(validFeaturedId):[])].slice(0,60),
    sound:{kind:['rain','breeze'].includes(sound.kind)?sound.kind:'off',volume:Math.round(finite(sound.volume,20,0,40)),duringReading:sound.duringReading===true},
  };
}

// Layout offsets are small and do not alter the cover aspect or cabinet size.
// Narrow windows always keep a centered, vertical shelf arrangement.
export function roomLayoutOffsets(value, { narrow=false, capacity=6 }={}) {
  const options=normalizeRoomOptions(value);
  const spread=options.layout==='airy'?.16:options.layout==='cozy'?-.12:0;
  const corner=options.layout==='airy'?.20:options.layout==='cozy'?-.08:0;
  const shift=narrow?0:options.shelfOffset/100;
  return { shelf:capacity>6&&!narrow?[-spread+shift,spread+shift]:[shift], corner:narrow?0:corner+options.furnitureOffset/100 };
}

export function selectFeaturedBooks(books, ids) {
  const byId=new Map();
  for(const book of books||[])if(book&&!book.hiddenBook&&validFeaturedId(book.id)&&!byId.has(book.id))byId.set(book.id,book);
  return [...new Set((ids||[]).filter(validFeaturedId))].flatMap(id=>byId.has(id)?[byId.get(id)]:[]);
}

export function summarizeReadingProgress(books, progress, now=Date.now()) {
  const visible=new Map(), records=[];
  for(const book of books||[])if(book&&!book.hiddenBook&&validFeaturedId(book.id))visible.set(book.id,book);
  for(const [id,book] of visible){
    const value=Object.prototype.hasOwnProperty.call(progress||{},id)?progress[id]:null;
    if(!value||!Number.isSafeInteger(value.page)||!Number.isSafeInteger(value.total)||value.page<1||value.total<1)continue;
    const page=Math.min(value.page,value.total), time=typeof value.time==='number'&&Number.isFinite(value.time)&&value.time>0&&value.time<=now?value.time:0;
    records.push({id,book,page,total:value.total,time,finished:page===value.total});
  }
  const finished=records.filter(record=>record.finished).length;
  return {total:visible.size,recorded:records.length,finished,reading:records.length-finished,unread:visible.size-records.length,
    recentWeek:records.filter(record=>record.time>0&&record.time>=now-7*86400000).length,
    recent:records.filter(record=>record.time>0).sort((a,b)=>b.time-a.time||a.id.localeCompare(b.id)).slice(0,8)};
}
