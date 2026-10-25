import { THEMES, resolveTheme, paintTheme, themeCards, saveThemePreference } from './room-themes.js';
import { RoomScene, bindBookTitles } from './room-scene.js';
import { initLiquidGlass } from './room-glass.js';
import { shellMarkup } from './room-shell.js';
import { LibraryIndex, bookTags, tagKey, tagGroups } from './room-library.js';
import { normalizeLibraryState, normalizeSmartShelves, normalizeShelfQuery, shelfMatches, booksPerPage, describeTag } from './room-shelves.js';
import { normalizeQuality } from './room-quality.js';
import { openLibraryOrganizer } from './library-organizer.js';
import { createDiscoveryUI, applyDiscoveryAliases } from './room-discovery.js';
import { createRoomPersonalization } from './room-personalization.js';
import './task-center.js';
import { initializeReadingState } from './reading-state.js';
import { buildReaderSpreads, readerSpreadIndex, readerTurnTarget, readerHorizontalDirection } from './room-reader-tools.js';
const readingProfile = await initializeReadingState();
const $ = (s, root = document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths = {
  palette:'M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 1.5 1.5 0 0 1 1-2.8h2A4 4 0 0 0 21 10a9 9 0 0 0-9-7 M7 10h.01 M10 7h.01 M15 7h.01 M17 11h.01',
  book:'M3 4h6a4 4 0 0 1 3 2 4 4 0 0 1 3-2h6v15h-6a4 4 0 0 0-3 2 4 4 0 0 0-3-2H3z M12 6v15',
  shelf:'M4 3v18 M20 3v18 M3 10h18 M3 19h18 M7 4v5 M10 3v6 M14 4l2 5 M7 13v5 M11 12v6 M15 13v5',
  heart:'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z',
  clock:'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
  search:'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
  folder:'M3 7V4h6l2 3h10v13H3z',
  tag:'M3 3h7l11 11-7 7L3 10z M7 7h.01',
  refresh:'M20 6v5h-5 M4 18v-5h5 M5 7a8 8 0 0 1 13-2l2 3 M4 16l2 3a8 8 0 0 0 13-2',
  settings:'M9 3h6l1 4 4 1v7l-4 1-1 5H9l-1-5-4-1V8l4-1z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
  moon:'M21 13a9 9 0 1 1-10-10 7 7 0 0 0 10 10',
  sun:'M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0 M12 2v2 M12 20v2 M2 12h2 M20 12h2 M5 5l1 1 M18 18l1 1 M5 19l1-1 M18 6l1-1',
  shuffle:'M3 6h3c5 0 7 12 12 12h3 M18 15l3 3-3 3 M3 18h3c2 0 3-2 4-4 M14 8c1-2 2-2 4-2h3 M18 3l3 3-3 3',
  arrow:'M5 12h14 M14 7l5 5-5 5',
  close:'M5 5l14 14 M5 19L19 5',
  minimize:'M5 12h14',maximize:'M5 5h14v14H5z',
  left:'M15 5l-7 7 7 7',right:'M9 5l7 7-7 7',
  leaf:'M20 3C8 2 2 7 5 16c9 4 16-2 15-13z M3 21L15 9',
  expand:'M8 3H3v5 M16 3h5v5 M3 16v5h5 M21 16v5h-5',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.book}"/></svg>`;
const invoke = (channel, ...args) => window.ipcRenderer.invoke(channel, ...args);
const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem('room-' + key)) ?? fallback; } catch { return fallback; } }, set(key, value) { localStorage.setItem('room-' + key, JSON.stringify(value)); } };
const state = { books:[], collections:[], setting:{}, ...normalizeLibraryState(storage.get('library-state',null), {sort:storage.get('sort','recent'),view:storage.get('view','shelf')}), smartShelves:normalizeSmartShelves(storage.get('smart-shelves',[])), quality:normalizeQuality(storage.get('quality','balanced')), perPage:12, progress:readingProfile.progress, theme:resolveTheme(), reader:null, loading:false };
state.readingMode = storage.get('reading-mode', 'paged') === 'continuous' ? 'continuous' : 'paged';
state.externalReader = storage.get('external-reader', false) === true;
let libraryIndex = new LibraryIndex();
let discoveryAliases = [];
const names = { all:'全部藏书', reading:'阅读中', finished:'已读完', unread:'未开始' };
// Imported metadata and local preferences are data, including numeric fields.
const pageCount = b => { const n=Number(b.pageCount||b.filecount);return Number.isSafeInteger(n)&&n>0?n:0; };
const title = b => b.title_jpn || b.title || '未命名书籍';
const percent = b => { const p = state.progress[b.id]; return p ? Math.min(100,Math.round(p.page / Math.max(1,p.total) * 100)) : 0; };
function fileURL(path) {
  if (!path) return '';
  let p = String(path).replace(/\\/g,'/');
  if (p.startsWith('file:')) return p;
  if (p.startsWith('//')) return 'file:' + p.split('/').map(encodeURIComponent).join('/');
  return 'file:///' + p.replace(/^\//,'').split('/').map((x,i) => i===0 && /^[A-Za-z]:$/.test(x) ? x : encodeURIComponent(x)).join('/');
}
function tagsOf(b) { return libraryIndex.metadata.get(b.id)?.tags || bookTags(b); }
function visibleBooks() {
  const books = libraryIndex.select(scopedLibraryState());
  return state.featured ? personalization.getFeaturedBooks(books) : books;
}
function scopedLibraryState() {
  return {...state, bookIds:state.featured?new Set(personalization.getFeaturedBooks(state.books).map(book=>book.id)):null};
}
function rebuildLibraryIndex() {
  libraryIndex = new LibraryIndex(state.books, state.collections);
  applyDiscoveryAliases(libraryIndex, discoveryAliases);
}
function toast(message, duration=3500) { const el=$('#toast'); el.textContent=message; el.hidden=false; clearTimeout(toast.timer); toast.timer=setTimeout(()=>el.hidden=true,duration); }
function fail(error) { console.error(error); toast('操作未完成：' + (error?.message || error),6000); }
function bookMarkup(b, detail=false) {
  const p = percent(b);
  return `<button class="book" ${detail?'tabindex="-1"':`data-book="${esc(b.id)}"`} aria-label="${esc(title(b))}" title="${esc(title(b))}" style="--book-color:${['#687861','#ad8c6d','#667781','#967663'][String(b.id).length%4]}"><span class="book-face">${b.coverPath ? `<img src="${esc(fileURL(b.coverPath))}" alt="" loading="${detail?'eager':'lazy'}" draggable="false">` : ''}<span class="fallback">${esc(title(b))}</span></span>${b.mark?'<span class="bookmark-ribbon">♥</span>':''}${p?`<span class="book-progress" style="width:${p}%"></span>`:''}</button>`;
}
let spatialRoom;
const personalization = createRoomPersonalization({
  storage, getState:()=>state, getScene:()=>spatialRoom, showModal, dismiss, toast,
  onChange:()=>{state.page=1;renderBooks();}, openBook:details,
  showFeatured:()=>{Object.assign(state,normalizeShelfQuery({featured:true}),{shelfId:'',page:1});$('#search').value='';renderBooks();},
});
const discovery = createDiscoveryUI({
  invoke, getBooks:()=>state.books, openBook:details,
  openReader:async(id,page)=>{await openReader(id);if(Number.isSafeInteger(page)&&page>0&&state.reader?.book.id===id)goPage(page);}, toast,
  onAliasesChanged:aliases=>{discoveryAliases=aliases;rebuildLibraryIndex();if(!state.loading&&$('#room'))renderBooks();},
});
let disposeGridTitles;
let searchTimer;
let gridSignature = '';
let restoringLibraryPosition = true;
let positionTimer;
function saveLibraryPosition() {
  if (!restoringLibraryPosition) {
    state.scrollTop = $('.content')?.scrollTop || 0;
    state.tagScrollTop = $('#tag-list')?.scrollTop || 0;
  }
  storage.set('library-state', normalizeLibraryState(state));
}
function restoreLibraryPosition() {
  if (!restoringLibraryPosition) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $('.content')?.scrollTo(0, state.scrollTop);
    if ($('#tag-list')) $('#tag-list').scrollTop = state.tagScrollTop;
    restoringLibraryPosition = false;
  }));
}
function renderLibraryControls() {
  if (!shelfMatches(state.smartShelves.find(shelf=>shelf.id===state.shelfId),state)) state.shelfId='';
  $('#smart-shelf').innerHTML='<option value="">当前筛选</option>'+state.smartShelves.map(shelf=>`<option value="${esc(shelf.id)}">${esc(shelf.name)}</option>`).join('');
  $('#smart-shelf').value=state.shelfId;
  const collections=[...libraryIndex.collections.values()];
  $('#collection-select').innerHTML='<option value="">全部合集与单本</option>'+collections.map(collection=>`<option value="${esc(collection.id)}">${esc(collection.title)} · ${collection.ids.size} 本</option>`).join('')+(state.collectionId&&!libraryIndex.collections.has(state.collectionId)?`<option value="${esc(state.collectionId)}">原合集暂不可用</option>`:'');
  $('#collection-select').value=state.collectionId;
  $('#grid-density').value=state.density;$('#density-control').hidden=state.view!=='grid';
  $('#reset-filters').hidden=JSON.stringify(normalizeShelfQuery(state))===JSON.stringify(normalizeShelfQuery({}));
}
function applyShelf(id) {
  const shelf=state.smartShelves.find(shelf=>shelf.id===id);if(!shelf)return;
  Object.assign(state,normalizeShelfQuery(shelf.query),{shelfId:id,page:1});
  $('#search').value=state.search;renderBooks();
}
function shelfSummary(query) {
  const items=[];
  if(query.search)items.push(`搜索「${query.search}」`);
  if(query.filter!=='all')items.push(names[query.filter]);
  if(query.favorites)items.push('仅收藏');
  if(query.featured)items.push('精选陈列');
  if(query.selectedTags.length)items.push('包含 '+query.selectedTags.map(key=>describeTag(key).value).join('、'));
  if(query.excludedTags.length)items.push('排除 '+query.excludedTags.map(key=>describeTag(key).value).join('、'));
  if(query.collectionId)items.push('合集 '+(libraryIndex.collections.get(query.collectionId)?.title||'暂不可用'));
  return items.join(' · ')||'全部藏书';
}
function shelfEditor(id='') {
  const shelf=state.smartShelves.find(shelf=>shelf.id===id);
  showModal(`<div class="drawer-top">智能书架<button class="icon-btn" data-action="dismiss" aria-label="关闭书架编辑">${icon('close')}</button></div><h2>${shelf?'重命名书架':'保存当前筛选'}</h2><form id="shelf-editor" class="shelf-editor"><label>书架名称<input id="shelf-name" maxlength="80" required autocomplete="off" value="${esc(shelf?.name||'')}" placeholder="例如：待读画集"></label><p class="path">${esc(shelfSummary(shelf?.query||normalizeShelfQuery(state)))}</p><p class="path">新加入的书只要符合这些条件，就会自动出现在书架中。</p><div class="shelf-editor-actions"><button type="button" class="pill-button" data-action="dismiss">取消</button><button class="pill-button primary" type="submit">保存书架</button></div></form>`);
  $('.modal').setAttribute('aria-label','保存智能书架');
  $('#shelf-editor').onsubmit=event=>{
    event.preventDefault();
    const name=$('#shelf-name').value.trim();if(!name)return;
    if(!shelf&&state.smartShelves.length>=100){toast('最多保存 100 个书架，请先整理已有书架。');return;}
    const saved=shelf?{...shelf,name}:{id:crypto.randomUUID(),name,query:normalizeShelfQuery(state)};
    const next=shelf?state.smartShelves.map(item=>item.id===id?saved:item):[...state.smartShelves,saved];
    try{storage.set('smart-shelves',next);state.smartShelves=next;if(!shelf)state.shelfId=saved.id;dismiss();renderBooks();toast('智能书架已保存');}catch(error){fail(error);}
  };
  $('#shelf-name').focus();
}
function manageShelves() {
  showModal(`<div class="drawer-top">智能书架<button class="icon-btn" data-action="dismiss" aria-label="关闭书架管理">${icon('close')}</button></div><h2>常看的书，随时回来。</h2><div class="saved-shelf-list">${state.smartShelves.map(shelf=>`<article class="saved-shelf-item"><strong>${esc(shelf.name)}</strong><p>${esc(shelfSummary(shelf.query))}</p><div class="saved-shelf-actions"><button class="pill-button" data-shelf-open="${esc(shelf.id)}">打开</button><button class="pill-button" data-shelf-rename="${esc(shelf.id)}">重命名</button><button class="pill-button" data-shelf-update="${esc(shelf.id)}">改用当前筛选</button><button class="pill-button" data-shelf-delete="${esc(shelf.id)}">删除书架</button></div></article>`).join('')||'<p class="path">还没有保存的书架。组合搜索、标签和阅读状态后，点击“保存筛选”。</p>'}</div><p class="path">删除书架只移除筛选规则，书籍和阅读记录会保留。</p>`);
  $('.modal').setAttribute('aria-label','管理智能书架');
}
function updateShelf(id,remove=false) {
  const next=remove?state.smartShelves.filter(shelf=>shelf.id!==id):state.smartShelves.map(shelf=>shelf.id===id?{...shelf,query:normalizeShelfQuery(state)}:shelf);
  storage.set('smart-shelves',next);state.smartShelves=next;
  if(!remove)state.shelfId=id;
  renderBooks();manageShelves();toast(remove?'已删除书架规则':'已更新为当前筛选');
}
function disposeRoom() { spatialRoom?.dispose(); spatialRoom=null; }
function focusBook(id) {
  const target=id && document.querySelector(`[data-book="${CSS.escape(String(id))}"]`);
  (target || document.querySelector('[data-filter].active'))?.focus({preventScroll:true});
}
function renderShell() {
  paintTheme(state.theme);
  $('#app').innerHTML = shellMarkup(icon);
  paintTheme(state.theme);
  $('#sort').value=state.sort;
  $('#search').value=state.search;$('#tag-search').value=state.tagSearch;
  $('#search').addEventListener('input',e=>{state.search=e.target.value;state.page=1;clearTimeout(searchTimer);searchTimer=setTimeout(renderBooks,110);});
  $('#sort').addEventListener('change',e=>{state.sort=e.target.value;storage.set('sort',state.sort);state.page=1;renderBooks();});
  $('#tag-search').addEventListener('input',e=>{state.tagSearch=e.target.value;state.tagLimit=40;renderTagList();});
  $('#tag-group').addEventListener('change',e=>{state.tagGroup=e.target.value;state.tagLimit=40;renderTagList();});
  $('#smart-shelf').onchange=e=>{if(e.target.value)applyShelf(e.target.value);else{state.shelfId='';saveLibraryPosition();}};
  $('#collection-select').onchange=e=>{state.collectionId=e.target.value;state.page=1;renderBooks();};
  $('#grid-density').onchange=e=>{state.density=e.target.value;state.page=1;renderBooks();};
  $('#shelf-jump').onsubmit=e=>{e.preventDefault();const page=Number($('#shelf-page').value);if(Number.isSafeInteger(page)&&page>0){state.page=page;renderBooks();}};
}
function renderTagList() {
  const query=state.tagSearch.trim().toLocaleLowerCase();
  const tags=libraryIndex.rankedTags.filter(tag=>(!state.tagGroup||tag.group===state.tagGroup)&&(!query||`${tag.value} ${tagGroups[tag.group]||tag.group}`.toLocaleLowerCase().includes(query)));
  const html=tags.slice(0,state.tagLimit).map(tag=>`<div class="tag-filter-row"><button class="tag-filter" data-tag-key="${esc(tag.key)}" aria-pressed="${state.selectedTags.includes(tag.key)}" title="${esc(tagGroups[tag.group]||tag.group)}：${esc(tag.value)} · ${tag.count} 本"><span class="tag-filter-label"><span>${esc(tag.value)}</span><small>${esc(tagGroups[tag.group]||tag.group)}</small></span><span class="count">${tag.count}</span></button><button class="tag-exclude" data-tag-exclude="${esc(tag.key)}" aria-pressed="${state.excludedTags.includes(tag.key)}" aria-label="排除标签 ${esc(tag.value)}" title="排除 ${esc(tag.value)}">−</button></div>`).join('')||'<p class="tag-empty">没有匹配的标签</p>';
  document.querySelectorAll('#tag-list, .tag-modal-list').forEach(list=>{list.innerHTML=html;});
  document.querySelectorAll('[data-action="more-tags"]').forEach(button=>{button.hidden=tags.length<=state.tagLimit;button.textContent=`显示更多标签 · 还有 ${Math.max(0,tags.length-state.tagLimit)} 个`;});
  $('#tag-total').textContent=libraryIndex.tags.size;
}
function updateTagGroups() {
  const groups=[...new Set(libraryIndex.rankedTags.map(tag=>tag.group))];
  if(!groups.includes(state.tagGroup))state.tagGroup='';
  $('#tag-group').innerHTML='<option value="">所有分组</option>'+groups.map(group=>`<option value="${esc(group)}">${esc(tagGroups[group]||group)}</option>`).join('');
  $('#tag-group').value=state.tagGroup;
  renderTagList();
}
function updateTagSelection() {
  document.querySelectorAll('[data-tag-key]').forEach(button=>button.setAttribute('aria-pressed',String(state.selectedTags.includes(button.dataset.tagKey))));
  document.querySelectorAll('[data-tag-exclude]').forEach(button=>button.setAttribute('aria-pressed',String(state.excludedTags.includes(button.dataset.tagExclude))));
  const container=$('#active-tags'),signature=JSON.stringify([state.selectedTags,state.excludedTags]);
  if(container.dataset.selection===signature)return;
  container.dataset.selection=signature;container.hidden=!state.selectedTags.length&&!state.excludedTags.length;
  container.innerHTML=[...state.selectedTags.map(key=>({key,exclude:false})),...state.excludedTags.map(key=>({key,exclude:true}))].map(({key,exclude})=>{const tag=libraryIndex.tags.get(key)||describeTag(key);return `<button class="selected-tag${exclude?' excluded':''}" data-tag-${exclude?'exclude':'key'}="${esc(key)}" aria-label="移除${exclude?'排除':''}标签 ${esc(tag.value)}"><small>${exclude?'排除 · ':''}${esc(tagGroups[tag.group]||tag.group)}</small>${esc(tag.value)} ${icon('close')}</button>`;}).join('')+'<button class="clear-tags" data-action="clear-tags">清除标签</button>';
}
function toggleTag(key,exclude=false) {
  if(!libraryIndex.tags.has(key)&&!state.selectedTags.includes(key)&&!state.excludedTags.includes(key))return;
  const field=exclude?'excludedTags':'selectedTags',opposite=exclude?'selectedTags':'excludedTags';
  if(!state[field].includes(key)&&state[field].length>=200){toast(`最多同时${exclude?'排除':'包含'} 200 个标签，请先移除部分条件。`);return;}
  state[field]=state[field].includes(key)?state[field].filter(item=>item!==key):[...state[field],key];
  state[opposite]=state[opposite].filter(item=>item!==key);
  state.page=1;renderBooks();
}
function tagBrowser() {
  showModal(`<div class="drawer-top">BROWSE BY TAG<button class="icon-btn" data-action="dismiss" aria-label="关闭标签筛选">${icon('close')}</button></div><h2>按标签找一本书</h2><label class="tag-search">${icon('search')}<input id="modal-tag-search" aria-label="查找标签" placeholder="查找标签…" value="${esc(state.tagSearch)}"></label><select id="modal-tag-group" aria-label="标签分组">${$('#tag-group').innerHTML}</select><p class="tag-browser-note">多选取交集 · 数量按藏书统计</p><div class="tag-modal-list" role="group" aria-label="书库标签"></div><button class="tag-more" data-action="more-tags">显示更多标签</button><div class="tag-modal-actions"><button class="pill-button" data-action="clear-tags">清除标签</button><button class="pill-button primary" data-action="dismiss">查看结果</button></div>`);
  $('.modal').setAttribute('aria-label','标签筛选');
  $('#modal-tag-group').value=state.tagGroup;
  $('#modal-tag-search').oninput=e=>{state.tagSearch=e.target.value;$('#tag-search').value=state.tagSearch;state.tagLimit=40;renderTagList();};
  $('#modal-tag-group').onchange=e=>{state.tagGroup=e.target.value;$('#tag-group').value=state.tagGroup;state.tagLimit=40;renderTagList();};
  renderTagList();
}
function renderBooks() {
  clearTimeout(searchTimer);
  state.perPage=booksPerPage(state.view,state.density);
  const {books:matchingBooks,counts,favoriteCount}=libraryIndex.summarize(scopedLibraryState());
  const books=state.featured?personalization.getFeaturedBooks(matchingBooks):matchingBooks;
  const pages=Math.max(1,Math.ceil(books.length/state.perPage));state.page=Math.max(1,Math.min(state.page,pages));
  const slice=books.slice((state.page-1)*state.perPage,state.page*state.perPage);
  $('#room').className='room '+(state.view==='grid'?'grid-mode':'');
  $('#room').dataset.density=state.density;
  if (!slice.length) {
    disposeGridTitles?.();disposeGridTitles=null;gridSignature='';
    disposeRoom();
    $('#room').innerHTML=`<div class="empty">${icon('book')}<h2>${state.books.length?'这里还没有故事':'欢迎来到你的阅览室'}</h2><p>${state.search?'换一个书名或标签试试。':state.books.length?'试试其他分类，或把喜欢的书加入收藏。':'选择漫画所在的文件夹，第一页会成为它的封面。'}</p><button class="pill-button primary" data-action="${state.books.length?'reset':'library'}">${state.books.length?'查看全部藏书':'选择书库文件夹'}</button></div>`;
  } else if (state.view==='grid') {
    disposeRoom();
    const signature=JSON.stringify(slice.map(b=>[b.id,b.coverPath,b.mark,percent(b),title(b)]));
    if(signature!==gridSignature||!$('.book-grid')){
      disposeGridTitles?.();
      $('#room').innerHTML=`<div class="book-grid">${slice.map(b=>`<div class="book-slot">${bookMarkup(b)}<span class="book-label">${esc(title(b))}</span><span class="book-subtitle">${pageCount(b)||'—'} 页${percent(b)?` · 已读 ${percent(b)}%`:''}</span></div>`).join('')}</div>`;
      gridSignature=signature;disposeGridTitles = bindBookTitles($('.book-grid'));
    }
  } else {
    disposeGridTitles?.();disposeGridTitles=null;gridSignature='';
    if(!spatialRoom){$('#room').innerHTML='<div class="scene-viewport" data-scene-state="loading"></div>';spatialRoom=new RoomScene($('.scene-viewport'),{quality:state.quality});spatialRoom.setSuspended(!!state.reader||!!$('#modal-root').children.length||!!document.querySelector('dialog[open]'));}
    spatialRoom.setBooks(slice.map(b=>({id:b.id,title:title(b),cover:fileURL(b.coverPath),pages:pageCount(b),mark:b.mark,progress:percent(b)})),state.theme,state.page,Math.min(state.perPage,books.length));
    personalization.applyScene();
  }
  const all=libraryIndex.books;
  $('#count-favorites').textContent=favoriteCount;
  for(const key of Object.keys(counts))$('#count-'+key).textContent=counts[key];
  $('#local-count').textContent=`${all.length} 本藏书 · 只属于你`;
  $('#hero-note').textContent=`${all.length} 本故事静候翻阅，在自己的节奏里，翻开下一页。`;
  $('#filter-count').textContent=Object.values(counts).reduce((sum,count)=>sum+count,0);
  const label=(state.featured?'精选 · ':'')+(state.favorites?'收藏 · ':'')+names[state.filter];$('#breadcrumb').textContent=label;
  $('#shelf-title').textContent=state.search||state.selectedTags.length||state.excludedTags.length||state.collectionId?`筛选结果 / ${books.length} 本`:`${label} / COLLECTION ${String(state.page).padStart(2,'0')}`;
  $('#results').textContent=books.length?`展示 ${(state.page-1)*state.perPage+1}–${Math.min(state.page*state.perPage,books.length)} 本 · 共 ${books.length} 本`:'0 本藏书';
  $('#pagination').textContent=`${String(state.page).padStart(2,'0')} / ${String(pages).padStart(2,'0')}`;
  $('#shelf-page').value=state.page;$('#shelf-page').max=pages;
  $('[data-action="prev"]').disabled=state.page<=1; $('[data-action="next"]').disabled=state.page>=pages;
  document.querySelectorAll('[data-filter]').forEach(el=>{const active=el.dataset.filter===state.filter;el.classList.toggle('active',active);el.setAttribute('aria-pressed',String(active));});
  $('[data-action="favorites"]').setAttribute('aria-pressed',String(state.favorites));
  $('[data-action="featured"]').setAttribute('aria-pressed',String(state.featured));
  updateTagSelection();
  document.querySelectorAll('[data-view]').forEach(el=>{el.classList.toggle('active',el.dataset.view===state.view);el.setAttribute('aria-pressed',el.dataset.view===state.view);});
  renderLibraryControls();saveLibraryPosition();
}
let lastFocus,lastFocusBook;
function showModal(html, drawer=false) {
  if(!$('#modal-root').children.length){lastFocus=document.activeElement;lastFocusBook=lastFocus?.dataset.book;}
  $('#modal-root').innerHTML=`<div class="overlay" data-overlay="true"><section class="${drawer?'drawer':'modal'}" role="dialog" aria-modal="true" aria-label="${drawer?'书籍详情':'阅览室设置'}">${html}</section></div>`;
  const modal=$('#modal-root .modal');
  if(modal){
    const top=modal.querySelector(':scope > .drawer-top');
    if(top){
      const header=document.createElement('header');header.className='modal-header';
      const body=document.createElement('div');body.className='modal-body';
      top.before(header);header.append(top);
      if(header.nextElementSibling?.tagName==='H2')header.append(header.nextElementSibling);
      if(header.nextElementSibling?.classList.contains('theme-current'))header.append(header.nextElementSibling);
      while(header.nextSibling)body.append(header.nextSibling);
      modal.append(body);
    }
    if(modal.querySelector('.modal-header'))modal.classList.add('structured-modal');
  }
  $('.shell').inert=true;spatialRoom?.setSuspended(true);
  $('[data-action="dismiss"]')?.focus({preventScroll:true});
}
function dismiss() { $('#modal-root').innerHTML=''; $('.shell').inert=!!state.reader; spatialRoom?.setSuspended(!!state.reader); if(lastFocus?.isConnected)lastFocus.focus({preventScroll:true});else if(lastFocusBook)focusBook(lastFocusBook); }
function readingOptionsMarkup() {
  return `<section class="reading-options detail-section" aria-label="阅读方式"><h3>阅读方式 <small>自动记住，下次沿用</small></h3><label class="reading-option" for="continuous-reading"><span><strong>连续瀑布阅读</strong><small id="continuous-reading-note">图片从上到下无缝相连，像手机上看漫画</small></span><input id="continuous-reading" type="checkbox" role="switch" aria-describedby="continuous-reading-note"><span class="option-switch" aria-hidden="true"></span></label><label class="reading-option" for="external-reader"><span><strong>使用外部阅读器</strong><small>用选定的本地程序打开这本书</small></span><input id="external-reader" type="checkbox" role="switch"><span class="option-switch" aria-hidden="true"></span></label><div id="external-reader-config" class="external-reader-config" hidden><div class="external-reader-program"><span id="external-reader-path" class="path"></span><button id="reader-program" class="pill-button" data-action="reader-program">选择程序</button></div><p class="path">阅读模式与进度由外部阅读器管理。</p></div><p id="reader-option-status" class="reader-option-status" role="status" hidden></p></section>`;
}
function updateReadingOptions() {
  if (!$('#continuous-reading')) return;
  const button = $('[data-read]');
  const preferences=readingProfile.getPreferences(button?.dataset.read,{mode:state.readingMode});
  $('#continuous-reading').checked = preferences.mode === 'continuous';
  $('#continuous-reading').disabled = state.externalReader;
  $('#external-reader').checked = state.externalReader;
  $('#external-reader-config').hidden = !state.externalReader;
  $('#external-reader-path').textContent = String(state.setting.imageExplorer || '').replace(/^"|"$/g, '') || '使用系统默认程序，也可自行选择';
  $('#continuous-reading-note').textContent = state.externalReader ? '已记住选择，使用内置阅读器时生效' : preferences.mode==='double'?'这本书使用双页；阅读中可切换模式、方向和缩放':'图片从上到下无缝相连；单本阅读工具会自动记住';
  if (button) {
    const p = state.progress[button.dataset.read];
    button.innerHTML = icon('book') + (state.externalReader ? '用外部阅读器打开' : p ? `继续阅读 · 第 ${p.page} 页` : '翻开这本书');
  }
  const restart = $('[data-read-start]');
  if (restart) restart.hidden = state.externalReader;
}
function bindReadingOptions() {
  updateReadingOptions();
  $('#continuous-reading').onchange = e => {
    state.readingMode = e.target.checked ? 'continuous' : 'paged';
    storage.set('reading-mode', state.readingMode);
    const id=$('[data-read]')?.dataset.read;
    if(id)readingProfile.stagePreferences(id,{...readingProfile.getPreferences(id,{direction:state.setting.reverseLeftRight?'rtl':'ltr'}),mode:state.readingMode});
    updateReadingOptions();
  };
  $('#external-reader').onchange = e => {
    state.externalReader = e.target.checked;
    storage.set('external-reader', state.externalReader);
    $('#reader-option-status').hidden = true;
    updateReadingOptions();
  };
}
async function chooseReaderProgram() {
  const button = $('[data-action="reader-program"]');
  if (button) button.disabled = true;
  try {
    const executable = await invoke('select-file', '选择外部阅读器', [{name:'阅读器程序', extensions:['exe']}]);
    if (!executable) return;
    const next = {...state.setting, imageExplorer:executable};
    await invoke('save-setting', next);
    state.setting = next;
    updateReadingOptions();
    const status = $('#reader-option-status');
    if (status) { status.hidden = false; status.textContent = '阅读器已保存。'; }
  } finally { if (button?.isConnected) button.disabled = false; }
}
function details(id) {
  const b=state.books.find(b=>b.id===id); if(!b)return;
  const p=state.progress[id], tags=tagsOf(b);
  showModal(`<div class="drawer-top">ON YOUR SHELF <button class="icon-btn" data-action="dismiss" aria-label="关闭详情">${icon('close')}</button></div><div class="detail-art">${bookMarkup(b,true)}</div><div class="eyebrow">${esc(b.category||'PRIVATE COLLECTION')}</div><h2>${esc(title(b))}</h2><div class="detail-meta"><span>${pageCount(b)||'—'} 页</span><span>${b.bundleSize?(b.bundleSize/1048576).toFixed(1)+' MB':'本地藏书'}</span><span>${b.rating?'★ '+Number(b.rating).toFixed(1):'未评分'}</span></div><div class="detail-actions"><button class="pill-button primary" data-read="${esc(id)}">${icon('book')}${p?'继续阅读 · 第 '+p.page+' 页':'翻开这本书'}</button><button class="pill-button" data-favorite="${esc(id)}" aria-pressed="${!!b.mark}" title="${b.mark?'取消收藏':'加入收藏'}">${icon('heart')}${b.mark?'已收藏':'收藏'}</button></div>${p?`<div class="detail-section"><h3>上次读到 ${p.page} / ${p.total} 页 <span style="float:right">${percent(b)}%</span></h3><div class="progress-track"><div style="width:${percent(b)}%"></div></div><button class="pill-button" data-read-start="${esc(id)}">从第一页重读</button></div>`:''}<div class="detail-section"><h3>关于这本书</h3><div class="tags">${tags.length?tags.slice(0,40).map(t=>`<button class="tag" data-tag-key="${esc(t.key || tagKey(t.group,t.value))}">${esc(t.value)}</button>`).join(''):'<span class="path">尚无标签，可在完整管理界面中补充元数据。</span>'}</div></div><div class="detail-section"><h3>书籍位置</h3><div class="path">${esc(b.filepath)}</div><button class="pill-button" data-reveal="${esc(id)}">${icon('folder')}在文件夹中显示</button></div>`,true);
  $('.detail-actions').insertAdjacentHTML('afterend', readingOptionsMarkup());
  $('.drawer').insertAdjacentHTML('beforeend',`<div class="detail-section"><h3>整理与发现</h3><div class="detail-actions"><button class="pill-button" data-organize-book="${esc(id)}">编辑作者与标签</button><button class="pill-button" data-discover-book="${esc(id)}">相似书籍</button><button class="pill-button" data-index-book="${esc(id)}">本书文本与识别</button><button class="pill-button" data-feature-book="${esc(id)}" aria-pressed="${personalization.isFeatured(id)}">${personalization.isFeatured(id)?'移出精选':'加入精选陈列'}</button></div></div>`);
  bindReadingOptions();
  if (b.exist === false) {
    const locationSection=$('[data-reveal]')?.closest('.detail-section');
    locationSection?.insertAdjacentHTML('beforeend',`<p class="library-missing">原文件暂时找不到。重新定位会核对内容并保留收藏和阅读档案。</p><button class="pill-button primary" data-relocate="${esc(id)}">${icon('folder')}重新定位文件</button>`);
  }
}
async function relocateBook(id) {
  const button=$('[data-relocate]');if(button)button.disabled=true;
  try{const result=await invoke('relocate-book',id);if(result?.success){await load(false);details(id);toast('已重新连接文件，阅读记录已保留');}}
  finally{if(button?.isConnected)button.disabled=false;}
}
async function favorite(id) {
  const b=state.books.find(b=>b.id===id); if(!b)return;
  const button=$('[data-favorite]'); if(button)button.disabled=true;
  try {
    const next={id:b.id,mark:!b.mark},saved=await invoke('save-book',next);
    const current=state.books.find(book=>book.id===id)||b;
    Object.assign(current,saved?.id===id?saved:next);if(current!==b)Object.assign(b,current);
    rebuildLibraryIndex();renderBooks();
    if(button?.isConnected){button.disabled=false;button.setAttribute('aria-pressed',String(!!b.mark));button.title=b.mark?'取消收藏':'加入收藏';button.innerHTML=icon('heart')+(b.mark?'已收藏':'收藏');}
    toast(b.mark?'已加入收藏':'已取消收藏');
  }catch(e){if(button)button.disabled=false;throw e;}
}
function chooseTheme(id) {
  if(!THEMES.some(t=>t.id===id)||state.theme===id)return;
  saveThemePreference(id);state.theme=id;paintTheme(id);spatialRoom?.setTheme(id);personalization.applyScene();
}
function appearance() {
  showModal(`<div class="drawer-top">CHANGE THE ATMOSPHERE<button class="icon-btn" data-action="dismiss" aria-label="关闭主题选择">${icon('close')}</button></div><h2>同一个书库，另一种性格。</h2><p class="theme-current"></p>${themeCards(state.theme)}<footer class="theme-footer"><span>书架、详情、阅读器同步换装</span><button class="pill-button primary" data-action="dismiss">回到书架 ${icon('arrow')}</button></footer>`);
  $('.modal').classList.add('theme-modal');$('.modal').setAttribute('aria-label','外观主题');paintTheme(state.theme);
}
function settings() {
  showModal(`<div class="drawer-top">MAKE YOURSELF AT HOME<button class="icon-btn" data-action="dismiss" aria-label="关闭设置">${icon('close')}</button></div><h2>让阅读，更合你的心意。</h2><div class="setting-row"><div>外观主题<small id="active-theme-name">${THEMES.find(t=>t.id===state.theme).name}</small></div><button class="pill-button" data-action="theme">${icon('palette')}选择主题</button></div><div class="setting-row"><div>书架视图<small>立体陈列或紧凑平铺</small></div><select id="setting-view" aria-label="书架视图"><option value="shelf">立体书架</option><option value="grid">平铺封面</option></select></div><div class="setting-row"><div>漫画文件夹<small>读取目录中的图片与漫画压缩包</small></div><button class="pill-button" data-action="library">更换</button></div><div class="path">${esc(state.setting.library||'尚未选择')}</div><button class="pill-button" data-action="classic">打开完整管理界面 ${icon('arrow')}</button><p class="path">标签编辑、元数据获取、导入导出等功能保留在完整管理界面中。右下角可随时返回阅览室。</p>`);
  $('#setting-view').value=state.view; $('#setting-view').onchange=e=>{state.view=e.target.value;storage.set('view',state.view);renderBooks();};
  const protection=document.createElement('div');protection.className='setting-row';
  protection.innerHTML='<div>数据保护<small>完整备份、恢复与压缩包删页恢复点</small></div><button class="pill-button" data-action="data-protection">备份与恢复</button>';
  $('#setting-view').closest('.setting-row').after(protection);
  const quality=document.createElement('div');quality.className='setting-row';
  quality.innerHTML='<div>场景画质<small>按设备调整清晰度、阴影与资源占用</small></div><select id="setting-quality" aria-label="场景画质"><option value="power">省电</option><option value="balanced">平衡</option><option value="fine">精细</option></select>';
  protection.after(quality);$('#setting-quality').value=state.quality;
  $('#setting-quality').onchange=e=>{state.quality=normalizeQuality(e.target.value);storage.set('quality',state.quality);spatialRoom?.setQuality(state.quality);};
  const cache=document.createElement('div');cache.className='cache-setting';
  cache.innerHTML='<div class="setting-row"><div>解压缓存<small>保留最近打开的漫画，正在阅读的内容会受保护</small></div></div><div class="cache-controls"><select id="cache-budget" aria-label="解压缓存上限"><option value="1073741824">1 GB</option><option value="2147483648">2 GB</option><option value="4294967296">4 GB</option><option value="8589934592">8 GB</option><option value="17179869184">16 GB</option></select><button class="pill-button" data-action="clear-cache">清理空闲缓存</button></div><p class="cache-status" id="cache-status" role="status">正在读取缓存用量…</p>';
  quality.after(cache);$('#cache-budget').disabled=true;
  $('#cache-budget').onchange=async e=>{const control=e.target;control.disabled=true;try{const status=await invoke('image-cache-budget',Number(control.value));state.setting.imageCacheBudgetMB=status.budgetBytes/1048576;renderCacheStatus(status);}catch(error){fail(error);await refreshCacheStatus();}finally{if(control.isConnected)control.disabled=false;}};
  refreshCacheStatus();
}
const byteLabel=value=>Number.isFinite(value)?(value>=1073741824?(value/1073741824).toFixed(1)+' GB':(value/1048576).toFixed(0)+' MB'):'暂不可用';
function renderCacheStatus(status) {
  const control=$('#cache-budget'),label=$('#cache-status');if(!control||!label)return;
  if(!status||!Number.isFinite(status.budgetBytes)){label.textContent='缓存用量暂不可用';return;}
  if(![...control.options].some(option=>Number(option.value)===status.budgetBytes)){const option=document.createElement('option');option.value=status.budgetBytes;option.textContent=byteLabel(status.budgetBytes);control.append(option);}
  control.value=String(status.budgetBytes);control.disabled=false;
  label.textContent=`已用 ${byteLabel(status.usedBytes)} / ${byteLabel(status.budgetBytes)} · ${Number(status.entryCount)||0} 本\n阅读中保护 ${byteLabel(status.protectedBytes)} · 磁盘可用 ${byteLabel(status.freeBytes)}`;
}
async function refreshCacheStatus() {
  try{renderCacheStatus(await invoke('image-cache-status'));}catch(error){if($('#cache-status'))$('#cache-status').textContent='缓存用量暂不可用：'+error.message;}
}
async function clearIdleCache() {
  const button=$('[data-action="clear-cache"]');if(button)button.disabled=true;
  try{const status=await invoke('image-cache-clear');renderCacheStatus(status);toast(`已清理 ${byteLabel(status.removedBytes||0)} 空闲缓存`);}finally{if(button?.isConnected)button.disabled=false;}
}
async function load(scan=false) {
  if(scan)return window.YanruyuTasks.startScan();
  if(state.loading){state.reloadPending=true;return;}
  state.loading=true;
  try {
    const [books,collections]=await Promise.all([invoke('load-book-list',false),invoke('load-collection-list')]);
    state.books=books;state.collections=Array.isArray(collections)?collections:[];
    rebuildLibraryIndex();gridSignature='';updateTagGroups();renderBooks();restoreLibraryPosition();personalization.refresh();
  } finally {
    state.loading=false;
    if(state.reloadPending){state.reloadPending=false;queueMicrotask(()=>load(false).catch(fail));}
  }
}
async function chooseLibrary() {
  if(state.loading)return;
  const folder=await invoke('select-folder','选择漫画所在的文件夹'); if(!folder)return;
  const next={...state.setting,library:folder}; await invoke('save-setting',next); state.setting=next;dismiss();state.page=1;await load(true);
}
let readerIntent=0;
let pendingReaderClose=null;
function persistProgress() { return readingProfile.flush({capture:false}); }
function saveProgress(reader) {
  if(!reader.total || !reader.viewed.has(reader.page))return;
  const progress = {page:reader.page,total:reader.total,time:Date.now(),source:'room'};
  if (reader.mode === 'continuous') {
    const body = $('#reader-body'), page = reader.pageElements[reader.page - 1];
    if (body && page) {
      reader.resumeOffset = Math.max(0, Math.min(.99, (body.scrollTop - page.offsetTop) / Math.max(1, page.offsetHeight)));
      reader.offsetPage = reader.page;
    }
  }
  progress.offset = reader.offsetPage === reader.page ? reader.resumeOffset || 0 : 0;
  readingProfile.stage(reader.book.id,progress);
}
function readerSpreads(r) {
  if(r.mode!=='double')return null;
  if(!r.spreads||r.spreadsDirty){r.spreads=buildReaderSpreads(r.total,r.dimensions,r.preferences);r.spreadsDirty=false;}
  return r.spreads;
}
function visibleReaderPages(r) {
  const spreads=readerSpreads(r);
  return spreads?.[readerSpreadIndex(spreads,r.page)] || [r.page];
}
function readerMarkup(r) {
  return `<section class="reader reader-with-tools" data-reading-mode="${r.mode}" role="dialog" aria-modal="true" aria-label="漫画阅读器"><header class="reader-bar"><button class="pill-button" data-action="exit-reader">${icon('left')}书架</button><div class="reader-title" title="${esc(title(r.book))}">${esc(title(r.book))}</div><button class="pill-button" data-action="reader-thumbnails" aria-controls="reader-thumbnails" aria-expanded="false" title="缩略图 (T)">缩略图</button><button class="icon-btn" data-action="fullscreen" title="全屏 (F)" aria-label="全屏">${icon('expand')}</button><div class="reader-tools" aria-label="阅读工具"><label>模式<select id="reader-mode" aria-label="阅读模式"><option value="paged">单页</option><option value="double">双页</option><option value="continuous">连续</option></select></label><label>方向<select id="reader-direction" aria-label="阅读方向"><option value="ltr">从左向右</option><option value="rtl">从右向左</option></select></label><label id="reader-fit-control">显示<select id="reader-fit" aria-label="页面显示方式"><option value="page">完整一页</option><option value="width">适合宽度</option></select></label><label id="reader-cover-control" class="reader-cover-option"><input id="reader-cover-alone" type="checkbox">封面独页</label><div class="reader-zoom-controls" aria-label="页面缩放"><button class="icon-btn" data-action="reader-zoom-out" aria-label="缩小页面" title="缩小 (-)">−</button><label><input id="reader-zoom" type="number" min="50" max="250" step="25" inputmode="numeric" aria-label="缩放百分比"><span>%</span></label><button class="icon-btn" data-action="reader-zoom-in" aria-label="放大页面" title="放大 (+)">+</button><button class="pill-button" data-action="reader-zoom-reset" title="重置缩放 (0)">重置</button></div><details class="reader-shortcuts"><summary>快捷键</summary><p>← →：按阅读方向翻页<br>↑ ↓ / 空格 / PageUp / PageDown：滚动或翻页<br>Home / End：首末页<br>G：输入页码　T：缩略图　F：全屏<br>M：切换模式　R：切换方向　W：切换显示<br>+ / −：缩放　0：重置缩放　Esc：返回</p></details></div></header><div class="reader-workspace"><aside id="reader-thumbnails" class="reader-thumbnails" aria-label="页面缩略图" hidden><div class="reader-thumbnail-header"><button class="icon-btn" data-action="reader-thumbs-prev" aria-label="上一组缩略图">${icon('left')}</button><span id="reader-thumbnail-range"></span><button class="icon-btn" data-action="reader-thumbs-next" aria-label="下一组缩略图">${icon('right')}</button></div><div id="reader-thumbnail-grid" class="reader-thumbnail-grid"></div></aside><div class="reader-body" id="reader-body" tabindex="0" aria-label="漫画页面"><div class="reader-placeholder">正在翻开这本书…</div></div></div><footer class="reader-bottom"><button class="icon-btn" data-action="page-prev" aria-label="上一页" disabled>${icon('left')}</button><span id="reader-page" aria-live="polite">— / —</span><input id="page-slider" aria-label="跳转页码" type="range" min="1" max="${Math.max(1,r.total)}" value="1" disabled><button class="icon-btn" data-action="page-next" aria-label="下一页" disabled>${icon('right')}</button><div class="reader-page-jump"><label><input id="reader-page-input" type="number" min="1" max="${Math.max(1,r.total)}" value="${r.page}" inputmode="numeric" aria-label="直接输入页码" disabled><span>页</span></label><button class="pill-button" data-action="reader-page-jump" disabled>跳转</button></div><span id="reader-spread-label" class="reader-spread-label"></span><span class="reader-hint">← → 翻页 · G 页码 · Esc 返回</span></footer></section>`;
}
function applyReaderAppearance(r) {
  if(state.reader!==r)return;
  const prefs=r.preferences,body=$('#reader-body');
  $('.reader').dataset.readingMode=r.mode;
  $('.reader').dataset.readingDirection=prefs.direction;
  $('#reader-mode').value=r.mode;$('#reader-direction').value=prefs.direction;$('#reader-fit').value=prefs.fit;
  $('#reader-zoom').value=prefs.zoom;$('#reader-cover-alone').checked=prefs.coverAlone;
  $('#reader-fit-control').hidden=r.mode==='continuous';$('#reader-cover-control').hidden=r.mode!=='double';
  body.classList.toggle('continuous-mode',r.mode==='continuous');body.classList.toggle('paged-mode',r.mode!=='continuous');
  body.classList.toggle('fit-width',r.mode!=='continuous'&&prefs.fit==='width');
  body.setAttribute('aria-label',r.mode==='continuous'?'漫画页面，向下滚动连续阅读':'漫画页面，方向键翻页');
  $('[data-action="reader-zoom-out"]').disabled=prefs.zoom<=50;$('[data-action="reader-zoom-in"]').disabled=prefs.zoom>=250;
  $('[data-action="page-prev"]').innerHTML=icon(prefs.direction==='rtl'?'right':'left');
  $('[data-action="page-next"]').innerHTML=icon(prefs.direction==='rtl'?'left':'right');
  $('.reader-hint').textContent=r.mode==='continuous'?'滚轮连续阅读 · G 页码 · Esc 返回':`${prefs.direction==='rtl'?'← 下一页':'→ 下一页'} · G 页码 · Esc 返回`;
  updatePagedLayout(r);
}
function clearReaderLayout(r) {
  r.pageObserver?.disconnect();r.pageObserver=null;
  cancelAnimationFrame(r.scrollFrame);r.scrollFrame=0;cancelAnimationFrame(r.layoutFrame);r.layoutFrame=0;
  clearTimeout(r.progressTimer);r.progressTimer=0;clearTimeout(r.releaseTimer);r.releaseTimer=0;
  r.pageElements=[];r.nearbyPages.clear();r.keepPages.clear();r.mountedPages.clear();
  for(const image of r.preloaded.values())image.removeAttribute('src');r.preloaded.clear();
  r.renderSignature='';
}
function changeReaderPreferences(patch) {
  const r=state.reader;if(!r)return;
  if(r.mode==='continuous')updateContinuousPosition(r);
  saveProgress(r);
  const oldMode=r.mode;
  r.preferences=readingProfile.stagePreferences(r.book.id,{...r.preferences,...patch});r.mode=r.preferences.mode;r.spreadsDirty=true;
  if(oldMode!==r.mode)clearReaderLayout(r);
  applyReaderAppearance(r);
  if(!r.listReady||!r.total)return;
  if(r.mode==='continuous'){
    if(oldMode!==r.mode)renderContinuous(r);
    else {updatePagedLayout(r);scrollToReaderPage(r,r.page,r.resumeOffset);}
  }else renderPage();
  updateReaderControls(r);
}
function changeReaderZoom(delta) { const r=state.reader;if(r)changeReaderPreferences({zoom:r.preferences.zoom+delta}); }
async function openReader(id, fromStart=false) {
  const book=state.books.find(b=>b.id===id); if(!book)return;
  const intent=++readerIntent;
  if (state.externalReader) {
    if (state.openingExternal) return;
    state.openingExternal = true;
    const button = $('[data-read]'); if (button) button.disabled = true;
    try {
      await invoke('open-local-book', book.filepath);
      toast('已交给外部阅读器打开。');
    } catch (error) {
      if (!$('.reading-options')) details(id);
      const status = $('#reader-option-status');
      status.textContent = '无法启动外部阅读器，请检查程序路径或重新选择程序。'; status.hidden = false;
      status.scrollIntoView({block:'nearest'});
    } finally { state.openingExternal = false; if (button?.isConnected) button.disabled = false; }
    return;
  }
  if(state.reader)await closeReader(false);
  else if(pendingReaderClose)await pendingReaderClose;
  if(intent!==readerIntent)return;
  dismiss();
  $('.shell').inert=true;
  spatialRoom?.setSuspended(true);
  const preferences=readingProfile.getPreferences(id,{mode:state.readingMode,direction:state.setting.reverseLeftRight?'rtl':'ltr'});
  const r={book,page:fromStart?1:state.progress[id]?.page||1,total:pageCount(book),mode:preferences.mode,preferences,loaded:new Map(),dimensions:new Map(),preloaded:new Map(),mountedPages:new Set(),nearbyPages:new Set(),keepPages:new Set(),viewed:new Set(),pageElements:[],counted:false,listReady:false,events:new AbortController(),lastWheelTurn:0,wheelAmount:0,thumbnailStart:1};state.reader=r;
  r.resumeOffset = fromStart ? 0 : Number(state.progress[id]?.offset) || 0;
  r.offsetPage=r.page;
  $('#reader-root').innerHTML=readerMarkup(r);applyReaderAppearance(r);
  personalization.setReaderOpen(true);
  $('[data-action="exit-reader"]').focus();
  $('#reader-mode').onchange=e=>changeReaderPreferences({mode:e.target.value});
  $('#reader-direction').onchange=e=>changeReaderPreferences({direction:e.target.value});
  $('#reader-fit').onchange=e=>changeReaderPreferences({fit:e.target.value});
  $('#reader-cover-alone').onchange=e=>changeReaderPreferences({coverAlone:e.target.checked});
  $('#reader-zoom').onchange=e=>{const value=e.target.valueAsNumber;changeReaderPreferences({zoom:Number.isFinite(value)?value:100});};
  $('#page-slider').oninput=e=>goPage(Number(e.target.value));
  $('#reader-page-input').onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();jumpReaderPage();}};
  const body = $('#reader-body');
  body.addEventListener('wheel', event => readerWheel(event, r), {passive:false, signal:r.events.signal});
  body.addEventListener('pointerdown', event => { r.resumePage=null;if (event.button === 1 && r.mode !== 'continuous') event.preventDefault(); }, {signal:r.events.signal});
  body.addEventListener('auxclick', event => { if (event.button === 1 && r.mode !== 'continuous') event.preventDefault(); }, {signal:r.events.signal});
  body.addEventListener('scroll', () => scheduleContinuousPosition(r), {passive:true, signal:r.events.signal});
  r.resizeObserver=new ResizeObserver(()=>{if(r.mode==='continuous'){updatePagedLayout(r);scheduleContinuousPosition(r);}else updatePagedLayout(r);});r.resizeObserver.observe(body);
  try {
    const list=await invoke('load-manga-image-list',book,{backgroundProcessing:false}); if(state.reader!==r)return;
    r.total=list.length;r.listReady=true;r.page=Math.max(1,Math.min(r.page,r.total||1));r.spreadsDirty=true;
    // Original paths make every page immediately reachable; optimized images replace them as they arrive.
    list.forEach((img,i)=>{if(!r.loaded.has(i+1))r.loaded.set(i+1,img.absolutePath);setPageDimensions(r,i+1,img.width,img.height);});
    updateReaderControls(r);
    if(!list.length){body.innerHTML='<div class="reader-placeholder">这本书中没有可读取的图片。</div>';return;}
    if (r.mode === 'continuous') renderContinuous(r); else renderPage();
  } catch(e) {if(state.reader===r){$('#reader-body').innerHTML='<div class="reader-placeholder">无法打开文件，请检查书籍是否已被移动。</div>';toast('无法读取这本书：'+e.message,6000);}}
}
function updateReaderControls(r) {
  if (state.reader !== r) return;
  $('#reader-page').textContent=`${r.total?r.page:0} / ${r.listReady?r.total:'…'}`;
  $('#page-slider').max=Math.max(1,r.total);$('#page-slider').value=r.page;$('#page-slider').disabled=!r.listReady||!r.total;
  const visible=visibleReaderPages(r);
  $('[data-action="page-prev"]').disabled=!r.listReady||visible[0]<=1;
  $('[data-action="page-next"]').disabled=!r.listReady||!r.total||visible.at(-1)>=r.total;
  const direct=$('#reader-page-input');direct.max=Math.max(1,r.total);direct.disabled=!r.listReady||!r.total;
  if(document.activeElement!==direct)direct.value=r.page;
  $('[data-action="reader-page-jump"]').disabled=direct.disabled;
  $('[data-action="reader-thumbnails"]').disabled=direct.disabled;
  $('#reader-spread-label').textContent=r.mode==='double'?(visible.length===2?`双页 ${visible[0]}–${visible[1]}`:'独页'):'';
  if(r.thumbnailsOpen){
    if(!r.thumbnailManual&&(r.page<r.thumbnailStart||r.page>=r.thumbnailStart+60))renderReaderThumbnails(r,true);
    $('#reader-thumbnail-grid').querySelectorAll('[data-reader-thumbnail]').forEach(button=>button.setAttribute('aria-current',Number(button.dataset.readerThumbnail)===r.page?'page':'false'));
  }
}
function markPageViewed(r, page) {
  if (state.reader !== r || !(r.mode==='continuous'?r.page===page:visibleReaderPages(r).includes(page))) return;
  r.viewed.add(page);saveProgress(r);
  if (!r.counted) {
    r.counted=true;
    const updated={id:r.book.id,readCount:Math.max(0,Number(r.book.readCount)||0)+1};
    invoke('save-book',updated).then(saved=>Object.assign(r.book,saved||updated)).catch(fail);
  }
}
function setPageDimensions(r, page, width, height) {
  if (!(Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0)) return;
  const ratio = width / height;
  if (r.dimensions.get(page) === ratio) return;
  r.dimensions.set(page, ratio);r.spreadsDirty=true;
  if(state.reader===r&&r.mode!=='continuous'&&r.listReady&&!r.layoutFrame){
    r.layoutFrame=requestAnimationFrame(()=>{r.layoutFrame=0;if(state.reader===r&&r.mode!=='continuous')renderPage();});
  }
  const element = r.pageElements[page - 1], body = $('#reader-body');
  if (!element || !body || state.reader !== r) return;
  // Keep the page being read at the same screen position when preceding placeholders resize.
  const anchor = r.pageElements[r.page - 1];
  const top = anchor?.getBoundingClientRect().top;
  element.style.aspectRatio = String(ratio);
  if (anchor && Number.isFinite(top)) body.scrollTop += anchor.getBoundingClientRect().top - top;
}
function createReaderImage(r, page, holder) {
  const image = document.createElement('img');
  image.alt = `第 ${page} 页`;image.draggable = false;image.decoding = 'async';image.dataset.readerImage=page;
  image.onload = () => {
    if (state.reader !== r || !image.isConnected) return;
    image.classList.remove('failed');holder.querySelector('.reader-placeholder')?.remove();holder.classList.add('is-loaded');
    setPageDimensions(r,page,image.naturalWidth,image.naturalHeight);
    if (r.mode === 'continuous') {
      if (r.resumePage === page) { scrollToReaderPage(r,page,r.resumeOffset);r.resumePage=null; }
      scheduleContinuousPosition(r);
    } else { markPageViewed(r,page);updatePagedLayout(r);preloadNeighborPages(r); }
  };
  image.onerror = () => {
    if (state.reader !== r || !image.isConnected || !image.hasAttribute('src')) return;
    image.classList.add('failed');holder.classList.remove('is-loaded');
    if (!holder.querySelector('.reader-placeholder')) {
      const message = document.createElement('div');message.className='reader-placeholder';
      message.innerHTML=`第 ${page} 页暂时无法显示<button class="pill-button" data-retry-page="${page}">重新加载</button>`;
      holder.append(message);
    }
  };
  holder.append(image);
  return image;
}
function renderPage() {
  const r=state.reader;if(!r||r.mode==='continuous')return;
  updateReaderControls(r);
  const pages=visibleReaderPages(r),signature=pages.join(','),body=$('#reader-body');
  let spread=$('.reader-spread',body);
  if(!spread||r.renderSignature!==signature){
    spread=document.createElement('div');spread.className='reader-spread';
    for(const page of pages){
      const holder=document.createElement('figure');holder.className='paged-sheet';holder.dataset.readerPage=page;
      holder.setAttribute('aria-label',`第 ${page} 页`);spread.append(holder);
    }
    body.replaceChildren(spread);body.scrollTop=0;body.scrollLeft=0;r.renderSignature=signature;
  }
  spread.style.flexDirection=r.preferences.direction==='rtl'?'row-reverse':'row';
  for(const page of pages){
    const holder=spread.querySelector(`[data-reader-page="${page}"]`),file=r.loaded.get(page);
    if(!file){if(!holder.querySelector('.reader-placeholder'))holder.innerHTML='<div class="reader-placeholder">这一页正在加载…</div>';continue;}
    let image=holder.querySelector('img');if(!image)image=createReaderImage(r,page,holder);
    const src=fileURL(file);if(image.getAttribute('src')!==src)image.src=src;
    else if(image.complete&&image.naturalWidth&&!image.classList.contains('failed'))markPageViewed(r,page);
  }
  updatePagedLayout(r);preloadNeighborPages(r);
}
function updatePagedLayout(r) {
  if(state.reader!==r)return;
  const body=$('#reader-body');if(!body)return;
  if(r.mode==='continuous'){
    const pages=$('.continuous-pages',body);
    if(pages){
      const width=Math.max(1,Math.min(body.clientWidth,1000)*r.preferences.zoom/100);
      if(Math.abs(pages.getBoundingClientRect().width-width)>.5){
        // A sidebar or window resize changes every preceding page's height.
        // Preserve the current page fraction before the column width changes.
        const anchor=r.pageElements[r.page-1];
        const offset=anchor?Math.max(0,Math.min(.99,(body.scrollTop-anchor.offsetTop)/Math.max(1,anchor.offsetHeight))):0;
        pages.style.width=`${width}px`;
        if(anchor)body.scrollTop=anchor.offsetTop+offset*anchor.offsetHeight;
      }else if(!pages.style.width)pages.style.width=`${width}px`;
    }
    return;
  }
  const spread=$('.reader-spread',body);if(!spread)return;
  const holders=[...spread.children],ratios=holders.map(holder=>r.dimensions.get(Number(holder.dataset.readerPage))||500/707);
  const style=getComputedStyle(body),width=Math.max(1,body.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight));
  const height=Math.max(1,body.clientHeight-parseFloat(style.paddingTop)-parseFloat(style.paddingBottom));
  const ratioSum=ratios.reduce((sum,ratio)=>sum+ratio,0);
  const imageHeight=(r.preferences.fit==='width'?width/ratioSum:Math.min(height,width/ratioSum))*r.preferences.zoom/100;
  holders.forEach((holder,index)=>{holder.style.width=`${ratios[index]*imageHeight}px`;holder.style.height=`${imageHeight}px`;});
}
function preloadNeighborPages(r) {
  if(state.reader!==r||r.mode==='continuous')return;
  const spreads=readerSpreads(r),index=spreads?readerSpreadIndex(spreads,r.page):-1;
  const wanted=new Set((spreads?[...(spreads[index-1]||[]),...(spreads[index+1]||[])]:[r.page-1,r.page+1]).filter(page=>page>=1&&page<=r.total));
  for(const [page,image] of r.preloaded)if(!wanted.has(page)){image.removeAttribute('src');r.preloaded.delete(page);}
  for(const page of wanted)if(!r.preloaded.has(page)&&r.loaded.has(page)){
    const image=new Image();image.decoding='async';image.fetchPriority='low';
    image.onload=()=>{if(state.reader===r&&r.preloaded.get(page)===image)setPageDimensions(r,page,image.naturalWidth,image.naturalHeight);};
    r.preloaded.set(page,image);image.src=fileURL(r.loaded.get(page));
  }
}
function mountContinuousPage(r, page) {
  const holder=r.pageElements[page-1], file=r.loaded.get(page);
  if (!holder || !file || state.reader!==r) return;
  let image=holder.querySelector('img');
  if (!image) image=createReaderImage(r,page,holder);
  const src=fileURL(file);
  if (image.getAttribute('src')!==src) { image.fetchPriority=page===r.page?'high':'low';image.src=src; }
  r.mountedPages.add(page);
}
function trimContinuousPages(r) {
  if(state.reader!==r)return;
  for(const page of r.mountedPages)if(!r.keepPages.has(page)&&page!==r.page){
    const holder=r.pageElements[page-1],image=holder?.querySelector('img');
    image?.removeAttribute('src');holder?.classList.remove('is-loaded');r.mountedPages.delete(page);
  }
}
function mountContinuousWindow(r) {
  const body=$('#reader-body');if(!body||state.reader!==r)return;
  const top=body.scrollTop,bottom=top+body.clientHeight,center=(top+bottom)/2;
  const nearby=[...r.nearbyPages].map(page=>{const el=r.pageElements[page-1];return {page,top:el.offsetTop,bottom:el.offsetTop+el.offsetHeight};});
  const keep=new Set(nearby.filter(item=>item.bottom>top&&item.top<bottom).map(item=>item.page));
  keep.add(r.page);
  // Always display the viewport, even for many very short strips. Offscreen
  // preloads are bounded instead of decoding the entire observer margin.
  const limit=Math.max(12,keep.size+2);
  nearby.sort((a,b)=>Math.abs((a.top+a.bottom)/2-center)-Math.abs((b.top+b.bottom)/2-center));
  for(const item of nearby){if(keep.size>=limit)break;keep.add(item.page);}
  r.keepPages=keep;for(const page of keep)mountContinuousPage(r,page);
  clearTimeout(r.releaseTimer);r.releaseTimer=setTimeout(()=>trimContinuousPages(r),320);
  if(r.mountedPages.size>limit)trimContinuousPages(r);
}
function renderContinuous(r) {
  const body=$('#reader-body'), pages=document.createElement('div');pages.className='continuous-pages';
  r.pageObserver?.disconnect();r.pageElements=[];
  body.replaceChildren(pages);
  for(let page=1;page<=r.total;page++) {
    const holder=document.createElement('figure');holder.className='continuous-page';holder.dataset.readerPage=page;
    holder.style.aspectRatio=String(r.dimensions.get(page)||500/707);
    holder.setAttribute('aria-label',`第 ${page} 页`);
    pages.append(holder);r.pageElements.push(holder);
  }
  updatePagedLayout(r);
  r.resumePage=r.page;
  scrollToReaderPage(r,r.page,r.resumeOffset);
  r.pageObserver=new IntersectionObserver(entries=>{
    if(state.reader!==r||r.mode!=='continuous')return;
    for(const entry of entries) {
      const page=Number(entry.target.dataset.readerPage);
      if(entry.isIntersecting) r.nearbyPages.add(page);
      else r.nearbyPages.delete(page);
    }
    // A brief retention window avoids decode churn when quickly reversing scroll.
    mountContinuousWindow(r);
  },{root:body,rootMargin:`${Math.max(900,Math.round(body.clientHeight*2))}px 0px`});
  r.pageElements.forEach(element=>r.pageObserver.observe(element));
}
function scrollToReaderPage(r, page, offset=0) {
  const body=$('#reader-body'), element=r.pageElements[page-1];
  if(!element||!body)return;
  body.scrollTop=element.offsetTop+Math.max(0,Math.min(.99,offset))*element.offsetHeight;
  mountContinuousPage(r,page);
  if(page<r.total)mountContinuousPage(r,page+1);
  updateReaderControls(r);
}
function scheduleContinuousPosition(r) {
  if(state.reader!==r||r.mode!=='continuous'||!r.pageElements.length||r.scrollFrame)return;
  r.scrollFrame=requestAnimationFrame(()=>{r.scrollFrame=0;updateContinuousPosition(r);});
}
function updateContinuousPosition(r) {
  const body=$('#reader-body');
  if(state.reader!==r||r.mode!=='continuous'||!body||!r.pageElements.length)return;
  const marker=body.scrollTop+1;
  let low=0,high=r.pageElements.length-1;
  while(low<high) {const middle=Math.floor((low+high)/2),element=r.pageElements[middle];if(element.offsetTop+element.offsetHeight<=marker)low=middle+1;else high=middle;}
  const atEnd=body.scrollHeight>body.clientHeight+2&&body.scrollTop+body.clientHeight>=body.scrollHeight-2;
  const page=atEnd?r.total:low+1;
  if(page!==r.page) {saveProgress(r);r.page=page;updateReaderControls(r);}
  const image=r.pageElements[page-1].querySelector('img');
  if(image?.hasAttribute('src')&&image.complete&&image.naturalWidth&&!image.classList.contains('failed')) {
    if(!r.viewed.has(page))markPageViewed(r,page);
    if(!r.progressTimer)r.progressTimer=setTimeout(()=>{r.progressTimer=0;if(state.reader===r)saveProgress(r);},160);
  }
}
function readerWheel(event, r) {
  if(state.reader!==r||event.ctrlKey||!event.deltaY||Math.abs(event.deltaY)<Math.abs(event.deltaX))return;
  r.resumePage=null;
  if(r.mode==='continuous')return;
  const body=$('#reader-body'), direction=Math.sign(event.deltaY), now=performance.now();
  if(body.classList.contains('fit-width')||r.preferences.zoom>100) {
    const limit=body.scrollHeight-body.clientHeight;
    if(limit>2&&(direction>0?body.scrollTop<limit-2:body.scrollTop>2)){r.lastWheelTurn=now;return;}
  }
  event.preventDefault();
  if(!r.listReady||!r.total)return;
  if(r.wheelDirection!==direction||now-(r.lastWheelEvent||0)>180)r.wheelAmount=0;
  if(r.wheelDirection===direction&&now-r.lastWheelTurn<260){r.lastWheelEvent=now;return;}
  r.wheelDirection=direction;r.lastWheelEvent=now;
  r.wheelAmount+=Math.abs(event.deltaY)*(event.deltaMode===1?16:event.deltaMode===2?body.clientHeight:1);
  if(r.wheelAmount<30)return;
  r.wheelAmount=0;r.lastWheelTurn=now;turnReaderPage(direction);
}
function goPage(page) {
  const r=state.reader;if(!r||!r.listReady||!r.total||!Number.isFinite(page))return;
  saveProgress(r);r.resumePage=null;r.page=Math.max(1,Math.min(Math.round(page),r.total));r.resumeOffset=0;r.offsetPage=r.page;r.thumbnailManual=false;
  if(r.mode==='continuous')scrollToReaderPage(r,r.page);else renderPage();
}
function turnReaderPage(direction) {
  const r=state.reader;if(!r)return;
  const target=readerTurnTarget(r.page,r.total,direction,readerSpreads(r));
  if(target!==r.page)goPage(target);
}
function jumpReaderPage() {
  const input=$('#reader-page-input'),r=state.reader;if(!input||!r)return;
  if(!Number.isFinite(input.valueAsNumber)){input.value=r.page;input.focus();return;}
  goPage(input.valueAsNumber);input.value=r.page;$('#reader-body').focus({preventScroll:true});
}
function toggleReaderThumbnails() {
  const r=state.reader;if(!r||!r.listReady)return;
  r.thumbnailsOpen=!r.thumbnailsOpen;$('#reader-thumbnails').hidden=!r.thumbnailsOpen;
  $('[data-action="reader-thumbnails"]').setAttribute('aria-expanded',String(r.thumbnailsOpen));
  if(r.thumbnailsOpen)renderReaderThumbnails(r,true);
  else {r.thumbnailObserver?.disconnect();$('#reader-thumbnail-grid').replaceChildren();}
  updatePagedLayout(r);
}
function renderReaderThumbnails(r,followCurrent=false) {
  if(state.reader!==r||!r.thumbnailsOpen)return;
  r.thumbnailObserver?.disconnect();
  if(followCurrent){r.thumbnailStart=Math.floor((r.page-1)/60)*60+1;r.thumbnailManual=false;}
  const end=Math.min(r.total,r.thumbnailStart+59),grid=$('#reader-thumbnail-grid');grid.replaceChildren();
  $('#reader-thumbnail-range').textContent=`${r.thumbnailStart}–${end}`;
  $('[data-action="reader-thumbs-prev"]').disabled=r.thumbnailStart<=1;$('[data-action="reader-thumbs-next"]').disabled=end>=r.total;
  const fragment=document.createDocumentFragment();
  for(let page=r.thumbnailStart;page<=end;page++){
    const button=document.createElement('button');button.className='reader-thumbnail';button.dataset.readerThumbnail=page;
    button.setAttribute('aria-label',`跳到第 ${page} 页`);button.setAttribute('aria-current',page===r.page?'page':'false');
    const image=document.createElement('img');image.alt='';image.decoding='async';image.draggable=false;
    const label=document.createElement('span');label.textContent=page;button.append(image,label);fragment.append(button);
  }
  grid.append(fragment);grid.scrollTop=0;
  r.thumbnailObserver=new IntersectionObserver(entries=>{
    if(state.reader!==r||!r.thumbnailsOpen)return;
    for(const entry of entries){
      const image=entry.target.querySelector('img'),file=r.loaded.get(Number(entry.target.dataset.readerThumbnail));
      if(entry.isIntersecting&&file){const src=fileURL(file);if(image.getAttribute('src')!==src)image.src=src;}
      else image.removeAttribute('src');
    }
  },{root:grid,rootMargin:'160px 0px'});
  grid.querySelectorAll('button').forEach(button=>r.thumbnailObserver.observe(button));
  grid.querySelector(`[data-reader-thumbnail="${r.page}"]`)?.scrollIntoView({block:'nearest'});
}
function turnReaderThumbnails(direction) {
  const r=state.reader;if(!r?.thumbnailsOpen)return;
  r.thumbnailStart=Math.max(1,Math.min(Math.floor((r.total-1)/60)*60+1,r.thumbnailStart+60*direction));
  r.thumbnailManual=true;renderReaderThumbnails(r);
}
function retryPage(page) {
  const r=state.reader;if(!r)return;
  const holder=r.mode==='continuous'?r.pageElements[page-1]:$(`.paged-sheet[data-reader-page="${page}"]`);
  holder?.querySelector('img')?.remove();holder?.querySelector('.reader-placeholder')?.remove();
  if(r.mode==='continuous')mountContinuousPage(r,page);else renderPage();
}
async function closeReader(cancelPending=true) {
  if(cancelPending)++readerIntent;
  const r=state.reader;if(!r)return pendingReaderClose;
  if(r.closing)return r.closing;
  r.closing=(async()=>{
    if(r.mode==='continuous')updateContinuousPosition(r);
    saveProgress(r);await persistProgress();r.events.abort();r.resizeObserver?.disconnect();r.thumbnailObserver?.disconnect();clearReaderLayout(r);
    state.reader=null;$('#reader-root').innerHTML='';$('.shell').inert=false;
    personalization.setReaderOpen(false);
    spatialRoom?.setSuspended(false);renderBooks();focusBook(r.book.id);
    const release=invoke('release-sendimagelock');
    if(document.fullscreenElement)await document.exitFullscreen();
    await release;
  })();
  pendingReaderClose=r.closing;
  try{return await r.closing;}finally{if(pendingReaderClose===r.closing)pendingReaderClose=null;r.closing=null;}
}
const actions={
  dismiss,settings,library:chooseLibrary,scan:()=>load(true),
  organizer:()=>{dismiss();return openLibraryOrganizer();},
  discovery:()=>{dismiss();return discovery.open({tab:'search'});},
  personalization:()=>personalization.open(),
  featured:()=>{state.featured=!state.featured;state.page=1;renderBooks();},
  'data-protection':async()=>{dismiss();const {openDataProtection}=await import('./data-protection.js');await openDataProtection({onLibraryChange:()=>load(false)});},
  theme:appearance,
  'tag-browser':tagBrowser,
  'more-tags':()=>{state.tagLimit+=40;renderTagList();},
  'clear-tags':()=>{state.selectedTags=[];state.excludedTags=[];state.page=1;renderBooks();},
  'save-shelf':()=>shelfEditor(), 'manage-shelves':manageShelves,
  tasks:()=>{dismiss();return window.YanruyuTasks.open();}, 'clear-cache':clearIdleCache,
  favorites:()=>{state.favorites=!state.favorites;state.page=1;renderBooks();},
  'reader-program':chooseReaderProgram,
  classic:async()=>{saveLibraryPosition();if(state.reader)await closeReader();await persistProgress();localStorage.setItem('reading-room-interface','classic');await window.YanruyuClientState?.flush();location.hash='';location.reload();},
  random:()=>{const books=visibleBooks();if(books.length)details(books[Math.floor(Math.random()*books.length)].id);else toast('这个书架还是空的，先添加一些藏书吧。');},
  reset:()=>{Object.assign(state,normalizeShelfQuery({}),{shelfId:'',page:1});$('#search').value='';renderBooks();},
  prev:()=>{state.page=Math.max(1,state.page-1);renderBooks();},next:()=>{state.page++;renderBooks();},
  minimize:()=>invoke('window-minimize'),maximize:()=>invoke('window-toggle-maximize'),'close-window':async()=>{if(state.reader)saveProgress(state.reader);await persistProgress();return invoke('window-close');},
  'exit-reader':closeReader,'page-prev':()=>turnReaderPage(-1),'page-next':()=>turnReaderPage(1),
  'reader-thumbnails':toggleReaderThumbnails,'reader-thumbs-prev':()=>turnReaderThumbnails(-1),'reader-thumbs-next':()=>turnReaderThumbnails(1),
  'reader-page-jump':jumpReaderPage,'reader-zoom-out':()=>changeReaderZoom(-25),'reader-zoom-in':()=>changeReaderZoom(25),'reader-zoom-reset':()=>changeReaderPreferences({zoom:100}),
  fullscreen:()=>document.fullscreenElement?document.exitFullscreen():$('.reader').requestFullscreen(),
};
document.addEventListener('error',e=>{if(e.target.tagName==='IMG'&&!e.target.closest('.reader-body'))e.target.classList.add('failed');},true);
let clickTimer;
document.addEventListener('click',e=>{
  const el=e.target.closest('button,[data-overlay]');if(!el||el.disabled)return;
  Promise.resolve().then(()=>{
    if(el.dataset.overlay && e.target===el)return dismiss();
    if(el.dataset.themeChoice)return chooseTheme(el.dataset.themeChoice);
    if(el.dataset.book){clearTimeout(clickTimer);clickTimer=setTimeout(()=>details(el.dataset.book),230);return;}
    if(el.dataset.read)return openReader(el.dataset.read);
    if(el.dataset.readStart)return openReader(el.dataset.readStart,true);
    if(el.dataset.retryPage)return retryPage(Number(el.dataset.retryPage));
    if(el.dataset.readerThumbnail){goPage(Number(el.dataset.readerThumbnail));$('#reader-body')?.focus({preventScroll:true});return;}
    if(el.dataset.favorite)return favorite(el.dataset.favorite);
    if(el.dataset.organizeBook){dismiss();return openLibraryOrganizer({bookIds:[el.dataset.organizeBook]});}
    if(el.dataset.discoverBook){dismiss();return discovery.open({tab:'similar',bookId:el.dataset.discoverBook});}
    if(el.dataset.indexBook){dismiss();return discovery.open({tab:'text',bookId:el.dataset.indexBook});}
    if(el.dataset.featureBook){const id=el.dataset.featureBook;personalization.toggleFeatured(id);details(id);return;}
    if(el.dataset.shelfOpen){applyShelf(el.dataset.shelfOpen);dismiss();return;}
    if(el.dataset.shelfRename)return shelfEditor(el.dataset.shelfRename);
    if(el.dataset.shelfUpdate)return updateShelf(el.dataset.shelfUpdate);
    if(el.dataset.shelfDelete)return updateShelf(el.dataset.shelfDelete,true);
    if(el.dataset.relocate)return relocateBook(el.dataset.relocate);
    if(el.dataset.reveal)return invoke('show-file',state.books.find(b=>b.id===el.dataset.reveal).filepath);
    if(el.dataset.tagKey){const inDetails=!!el.closest('.drawer');toggleTag(el.dataset.tagKey);if(inDetails)dismiss();return;}
    if(el.dataset.tagExclude)return toggleTag(el.dataset.tagExclude,true);
    if(el.dataset.filter){if(state.filter!==el.dataset.filter){state.filter=el.dataset.filter;state.page=1;renderBooks();}return;}
    if(el.dataset.view){if(state.view!==el.dataset.view){state.view=el.dataset.view;storage.set('view',state.view);renderBooks();}return;}
    if(el.dataset.action)return actions[el.dataset.action]?.();
  }).catch(fail);
});
document.addEventListener('dblclick',e=>{const el=e.target.closest('[data-book]');if(el){clearTimeout(clickTimer);openReader(el.dataset.book).catch(fail);}});
document.addEventListener('keydown',e=>{
  if(e.defaultPrevented)return;
  // Native dialogs own their Escape/Tab behavior while the room is inert.
  if(document.querySelector('dialog[open]'))return;
  if(e.key==='Tab') {const modal=$('.reader')||$('[role="dialog"]');if(modal){const els=[...modal.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex="0"]')].filter(el=>el.offsetParent!==null&&!el.closest('[hidden],[inert]'));const first=els[0],last=els.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}return;}
  if(e.key==='Escape'){
    e.preventDefault();
    if(state.reader){
      const help=$('.reader-shortcuts');
      if(help?.open){help.open=false;help.querySelector('summary').focus();}
      else if(state.reader.thumbnailsOpen){toggleReaderThumbnails();$('[data-action="reader-thumbnails"]').focus();}
      else closeReader().catch(fail);
    }else dismiss();
    return;
  }
  if(e.ctrlKey && e.key.toLowerCase()==='k'&&!state.reader){e.preventDefault();$('#search').focus();return;}
  if(e.ctrlKey||e.metaKey||e.altKey||e.target.closest('input,select,textarea,[contenteditable="true"],[role="textbox"]'))return;
  const r=state.reader;if(!r)return;
  // Space and Enter must keep their native meaning on focused controls.
  if([' ','Enter'].includes(e.key)&&e.target.closest('button,a,summary,[role="button"]'))return;
  const horizontal=readerHorizontalDirection(e.key,r.preferences.direction);
  if(horizontal){e.preventDefault();turnReaderPage(horizontal);return;}
  if(['ArrowUp','ArrowDown','PageUp','PageDown',' '].includes(e.key)){
    e.preventDefault();r.resumePage=null;
    const direction=['ArrowUp','PageUp'].includes(e.key)||(e.key===' '&&e.shiftKey)?-1:1;
    const body=$('#reader-body'),limit=body.scrollHeight-body.clientHeight;
    if(r.mode==='continuous'||(limit>2&&(direction>0?body.scrollTop<limit-2:body.scrollTop>2))){
      body.scrollBy({top:direction*(e.key.startsWith('Arrow')?60:body.clientHeight*.85),behavior:'auto'});
    }else turnReaderPage(direction);
    return;
  }
  if(e.key==='Home'||e.key==='End'){e.preventDefault();goPage(e.key==='Home'?1:r.total);return;}
  if(['+','=','-','_','0'].includes(e.key)){
    e.preventDefault();if(e.key==='0')changeReaderPreferences({zoom:100});else changeReaderZoom(['+','='].includes(e.key)?25:-25);return;
  }
  if(e.repeat)return;
  switch(e.key.toLowerCase()){
    case 'g':e.preventDefault();$('#reader-page-input').focus();$('#reader-page-input').select();break;
    case 't':e.preventDefault();toggleReaderThumbnails();break;
    case 'm':e.preventDefault();changeReaderPreferences({mode:({paged:'double',double:'continuous',continuous:'paged'})[r.mode]});break;
    case 'r':e.preventDefault();changeReaderPreferences({direction:r.preferences.direction==='ltr'?'rtl':'ltr'});break;
    case 'w':e.preventDefault();changeReaderPreferences({fit:r.preferences.fit==='page'?'width':'page'});break;
    case 'f':e.preventDefault();Promise.resolve(actions.fullscreen()).catch(fail);break;
  }
});
document.addEventListener('visibilitychange',()=>{if(document.hidden&&state.reader){saveProgress(state.reader);persistProgress().catch(fail);}});
readingProfile.registerRoomReader(()=>{const r=state.reader;if(r){if(r.mode==='continuous')updateContinuousPosition(r);saveProgress(r);}});
window.addEventListener('pagehide',()=>{if(state.reader)saveProgress(state.reader);persistProgress().catch(fail);});
window.addEventListener('reading-state-error',event=>toast('阅读档案尚未保存：'+event.detail,6000));
window.addEventListener('yanruyu-library-updated',()=>load(false).catch(fail));
window.addEventListener('yanruyu-tasks-changed',event=>{
  const tasks=event.detail?.tasks||[];
  const active=tasks.filter(task=>['queued','running','canceling','cancelling'].includes(task.status));
  const count=$('#task-count');if(count){count.hidden=!active.length;count.textContent=active.length;}
  $('[data-action="scan"]')?.classList.toggle('busy',active.some(task=>task.kind==='scan'||task.kind==='rebuild'));
});
window.addEventListener('pagehide',saveLibraryPosition);
const overlayObserver=new MutationObserver(()=>{
  const suspended=!!state.reader||!!$('#modal-root')?.children.length||!!document.querySelector('dialog[open]');
  if(spatialRoom&&spatialRoom.suspended!==suspended)spatialRoom.setSuspended(suspended);
});
overlayObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','inert']});
window.addEventListener('pagehide',()=>{overlayObserver.disconnect();personalization.dispose();discovery.dispose();});
window.YanruyuClientState?.registerCapture(saveLibraryPosition);
document.addEventListener('visibilitychange',()=>{if(document.hidden)saveLibraryPosition();});
document.addEventListener('scroll',event=>{
  if(state.reader||(event.target!==$('.content')&&event.target!==$('#tag-list')))return;
  clearTimeout(positionTimer);positionTimer=setTimeout(()=>{saveLibraryPosition();window.dispatchEvent(new Event('yanruyu-library-position'));},120);
},true);
renderShell();
initLiquidGlass();
window.ipcRenderer.on('manga-image',(_event,img)=>{
  const r=state.reader;if(!r||img.id!==`${r.book.id}_${img.index}`)return;
  r.loaded.set(img.index,img.filepath);if(!r.listReady)r.total=img.total;
  setPageDimensions(r,img.index,img.width,img.height);
  if(!r.listReady)return;
  if(r.mode==='continuous'){
    const image=r.pageElements[img.index-1]?.querySelector('img');
    if(image?.hasAttribute('src'))mountContinuousPage(r,img.index);
  }else if(visibleReaderPages(r).includes(img.index))renderPage();
});
window.ipcRenderer.on('send-message',(_event,message)=>{if(state.loading)toast(String(message),6000);});
window.ipcRenderer.on('send-action',(_event,data)=>{if(data.action==='send-progress'&&state.loading&&data.progress>=0)$('#local-count').textContent=`正在整理书库 ${Math.round(data.progress*100)}%`;});
try {state.setting=await invoke('load-setting');await load(false);await discovery.refreshAliases().catch(error=>console.warn('本地别名暂不可用：',error));await invoke('update-window-title','私人漫画阅览室');} catch(error) {$('#room').innerHTML=`<div class="empty"><h2>书库暂时未能打开</h2><p>${esc(error.message)}</p><button class="pill-button" data-action="scan">重新载入</button></div>`;fail(error);}
