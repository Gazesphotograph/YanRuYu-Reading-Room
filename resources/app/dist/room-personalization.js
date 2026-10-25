import { THEMES } from './room-themes.js';
import { ROOM_LAYOUTS, ROOM_FURNITURE, normalizeRoomPersonalization, normalizeRoomOptions, selectFeaturedBooks, summarizeReadingProgress, validFeaturedId } from './room-personalization-state.js';
import { RoomAmbientSound } from './room-ambient.js';

const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const title=book=>String(book?.title_jpn||book?.title||'未命名书籍');
const dateText=time=>{try{return new Intl.DateTimeFormat('zh-CN',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}).format(time);}catch{return '未知时间';}};
function localCover(book) {
  if(!book?.coverPath)return '';
  const value=String(book.coverPath).replace(/\\/g,'/');
  if(value.startsWith('file:')){try{const url=new URL(value);return url.protocol==='file:'?url.href:'';}catch{return '';}}
  if(value.startsWith('//'))return 'file:'+value.split('/').map(encodeURIComponent).join('/');
  if(!/^[A-Za-z]:\//.test(value)&&!value.startsWith('/'))return '';
  return 'file:///'+value.replace(/^\//,'').split('/').map((part,index)=>index===0&&/^[A-Za-z]:$/.test(part)?part:encodeURIComponent(part)).join('/');
}
const tabs=[{id:'room',name:'布置与声音'},{id:'featured',name:'精选陈列'},{id:'stats',name:'阅读统计'}];
const personalIcon=path=>`<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="${path}"/></svg>`;

export function createRoomPersonalization({storage,getState,getScene,showModal,dismiss,toast=()=>{},onChange=()=>{},openBook=()=>{},showFeatured}={}) {
  let preferences=normalizeRoomPersonalization(storage?.get('personalization',null)),panel=null,tab='room',search='',events=null,disposed=false;
  const theme=()=>THEMES.some(item=>item.id===getState()?.theme)?getState().theme:'paper';
  const current=()=>preferences.themes[theme()].current;
  const statusText=()=>{const status=document.querySelector('#personal-sound-status');if(status)status.textContent=ambient.status();};
  const ambient=new RoomAmbientSound({onStatus:statusText});
  ambient.configure(preferences.sound);
  const persist=next=>{
    const normalized=normalizeRoomPersonalization(next);
    storage?.set('personalization',normalized);preferences=normalized;
  };
  const error=reason=>toast('房间设置未能保存：'+(reason?.message||reason),6000);
  const guard=callback=>{try{return callback();}catch(reason){error(reason);return false;}};
  const applyScene=(restoreCamera=false)=>getScene?.()?.setPersonalization(current(),{restoreCamera});
  const saveCurrent=options=>{const id=theme();persist({...preferences,themes:{...preferences.themes,[id]:{...preferences.themes[id],current:normalizeRoomOptions(options)}}});applyScene();};
  const featuredBooks=books=>selectFeaturedBooks(books??getState().books,preferences.featuredIds);
  const announce=message=>{const node=panel?.querySelector('[data-personal-status]');if(node)node.textContent=message;};

  function roomMarkup() {
    const value=current(),entry=preferences.themes[theme()],sound=preferences.sound;
    const range=(key,label,min,max,suffix='')=>`<label class="personal-range" for="personal-${key}"><span>${label}<output id="personal-${key}-value">${value[key]}${suffix}</output></span><input id="personal-${key}" data-personal-option="${key}" type="range" min="${min}" max="${max}" value="${value[key]}" aria-describedby="personal-layout-note"></label>`;
    return `<section aria-labelledby="personal-layout-title"><div class="personal-section-title"><h3 id="personal-layout-title">${esc(THEMES.find(item=>item.id===theme())?.name)}的布置</h3><span>每套主题分别保存</span></div>
      <div class="personal-layouts" role="group" aria-label="房间布局">${ROOM_LAYOUTS.map(layout=>`<button type="button" data-personal-layout="${layout.id}" aria-pressed="${value.layout===layout.id}"><strong>${layout.name}</strong><span>${layout.description}</span></button>`).join('')}</div>
      <div class="personal-ranges">${range('shelfOffset','书架左右微调',-12,12)}${range('furnitureOffset','阅读角左右微调',-15,15)}${range('brightness','房间亮度',75,125,'%')}${range('warmth','光线冷暖',-30,30)}</div>
      <p class="personal-note" id="personal-layout-note">负数向左或偏冷，正数向右或偏暖。窄屏自动保持书架居中，封面比例不变。</p>
      <fieldset class="personal-furniture"><legend>陈设</legend>${ROOM_FURNITURE.map(item=>`<label><input type="checkbox" data-personal-furniture="${item.id}" ${value.furniture[item.id]?'checked':''}>${item.name}</label>`).join('')}</fieldset>
      <p class="personal-note">阅读椅、边桌、落地灯和地毯在横向六本书架中展示。调整自动保存，关闭面板后查看效果。</p>
      <div class="personal-actions"><button type="button" class="pill-button primary" data-personal-save>保存当前布置与视角</button><button type="button" class="pill-button" data-personal-restore ${entry.savedAt?'':'disabled'}>恢复已存布置</button><button type="button" class="pill-button" data-personal-reset>重置本主题</button></div>
      <p class="personal-note" data-personal-saved>${entry.savedAt?'上次保存：'+esc(dateText(entry.savedAt)):'在书架调整好视角后，可在这里保存；之后一键恢复。'}</p>
    </section>
    <section class="personal-sound" aria-labelledby="personal-sound-title"><div class="personal-section-title"><h3 id="personal-sound-title">环境声音</h3><span>本地生成 · 默认关闭</span></div>
      <div class="personal-sound-controls"><label for="personal-sound-kind">声音<select id="personal-sound-kind"><option value="off" ${sound.kind==='off'?'selected':''}>关闭</option><option value="rain" ${sound.kind==='rain'?'selected':''}>轻雨</option><option value="breeze" ${sound.kind==='breeze'?'selected':''}>微风</option></select></label><label for="personal-sound-volume">音量 <output id="personal-sound-volume-value">${sound.volume}%</output><input id="personal-sound-volume" type="range" min="0" max="40" value="${sound.volume}"></label><button type="button" class="pill-button" data-personal-play ${sound.kind==='off'?'disabled':''}>播放声音</button></div>
      <label class="personal-check"><input id="personal-sound-reading" type="checkbox" ${sound.duringReading?'checked':''}>阅读时继续播放</label><p id="personal-sound-status" class="personal-note" role="status">${esc(ambient.status())}</p><p class="personal-note">切到其他窗口、最小化或隐藏时暂停；回来后恢复。重新启动程序需要点击播放。</p>
    </section>`;
  }

  function featuredMarkup() {
    return `<section aria-labelledby="personal-featured-title"><div class="personal-section-title"><h3 id="personal-featured-title">把喜欢的书摆在一起</h3><span id="personal-featured-count"></span></div><p class="personal-note">按你安排的顺序陈列，最多 60 本。也可以在书籍详情中加入或移出精选。</p><div class="personal-actions">${showFeatured?'<button type="button" class="pill-button primary" data-personal-show-featured>在书架中陈列</button>':''}</div><ol class="personal-featured-list" id="personal-featured-list"></ol><p class="personal-note" id="personal-unavailable"></p><button type="button" class="pill-button" data-personal-clear-unavailable hidden>移出不可见的精选条目</button><label class="personal-search" for="personal-featured-search">从书库加入精选<input id="personal-featured-search" type="search" maxlength="200" value="${esc(search)}" placeholder="搜索书名…" autocomplete="off"></label><p class="personal-note" id="personal-search-count"></p><div class="personal-candidates" id="personal-featured-candidates"></div></section>`;
  }

  function statsMarkup() {
    const state=getState(),stats=summarizeReadingProgress(state.books,state.progress),counts=[['有阅读记录',stats.recorded],['阅读中',stats.reading],['到达末页',stats.finished],['近 7 天有记录',stats.recentWeek]],bars=[['未开始',stats.unread],['阅读中',stats.reading],['到达末页',stats.finished]];
    return `<section aria-labelledby="personal-stats-title"><div class="personal-section-title"><h3 id="personal-stats-title">你的本地阅读档案</h3><span>${stats.total} 本可见藏书</span></div><div class="personal-stats">${counts.map(([label,count])=>`<div><strong>${count}<small> 本</small></strong><span>${label}</span></div>`).join('')}</div><div class="personal-stat-bars" aria-label="书库阅读进度分布">${bars.map(([label,count])=>`<div><span>${label}</span><div class="personal-stat-track"><i style="width:${stats.total?count/stats.total*100:0}%"></i></div><strong>${count}</strong></div>`).join('')}</div><p class="personal-note">依据当前书库的已保存进度统计，不计隐藏书籍。“到达末页”表示最近保存的位置在最后一页；未记录阅读时长，不推算累计阅读量。</p><h3>最近保存的阅读位置</h3><ol class="personal-recent">${stats.recent.map(record=>`<li><button type="button" data-personal-book="${esc(record.id)}"><strong>${esc(title(record.book))}</strong><span>第 ${record.page} / ${record.total} 页 · ${esc(dateText(record.time))}</span></button></li>`).join('')||'<li class="personal-note">还没有阅读记录。翻开一本书，保存的进度会出现在这里。</li>'}</ol></section>`;
  }

  function renderFeatured() {
    if(!panel?.isConnected||tab!=='featured')return;
    const books=featuredBooks(),ids=new Set(preferences.featuredIds),count=panel.querySelector('#personal-featured-count');
    count.textContent=`${books.length} 本可见 / ${preferences.featuredIds.length} 个精选条目`;
    const button=panel.querySelector('[data-personal-show-featured]');if(button)button.disabled=!books.length;
    panel.querySelector('#personal-featured-list').innerHTML=books.map((book,index)=>{const cover=localCover(book);return `<li><button type="button" class="personal-book-title" data-personal-book="${esc(book.id)}"><span class="personal-featured-cover" aria-hidden="true"><i>${String(index+1).padStart(2,'0')}</i>${cover?`<img src="${esc(cover)}" alt="" loading="lazy" decoding="async">`:''}</span><strong>${esc(title(book))}</strong></button><div class="personal-order"><button type="button" data-personal-move="${esc(book.id)}" data-direction="-1" aria-label="上移 ${esc(title(book))}" ${index?'':'disabled'}>${personalIcon('M12 19V5m-6 6 6-6 6 6')}</button><button type="button" data-personal-move="${esc(book.id)}" data-direction="1" aria-label="下移 ${esc(title(book))}" ${index<books.length-1?'':'disabled'}>${personalIcon('M12 5v14m-6-6 6 6 6-6')}</button><button type="button" data-personal-remove="${esc(book.id)}" aria-label="移出精选：${esc(title(book))}">移出</button></div></li>`;}).join('')||'<li class="personal-note">精选陈列还空着，从下方挑选几本书吧。</li>';
    const missing=preferences.featuredIds.length-books.length;
    panel.querySelector('#personal-unavailable').textContent=missing?`${missing} 个条目当前不在可见书库中；恢复可见后会按原顺序出现。也可以仅从精选移出这些条目，书库与阅读进度不变。`:'';
    panel.querySelector('[data-personal-clear-unavailable]').hidden=!missing;
    const query=search.trim().toLocaleLowerCase(),candidates=(getState().books||[]).filter(book=>book&&!book.hiddenBook&&validFeaturedId(book.id)&&!ids.has(book.id)&&(!query||title(book).toLocaleLowerCase().includes(query))),shown=candidates.slice(0,query?40:12);
    panel.querySelector('#personal-search-count').textContent=candidates.length?`显示 ${shown.length} / ${candidates.length} 本${query?'匹配书籍':'待选藏书'}${!query&&candidates.length>12?'，输入书名继续查找':''}`:query?'没有匹配的书名':'书库中的可见书籍已全部加入精选';
    panel.querySelector('#personal-featured-candidates').innerHTML=shown.map(book=>`<div><span>${esc(title(book))}</span><button type="button" class="pill-button" data-personal-add="${esc(book.id)}" ${preferences.featuredIds.length>=60?'disabled':''} aria-label="加入精选：${esc(title(book))}">加入</button></div>`).join('');
  }

  function toggleFeatured(id) {
    return guard(()=>{
      if(!validFeaturedId(id))return false;
      const exists=preferences.featuredIds.includes(id);
      if(!exists&&!getState().books.some(book=>book.id===id&&!book.hiddenBook))return false;
      if(!exists&&preferences.featuredIds.length>=60){toast('精选陈列最多保存 60 本，请先移出部分书籍。');return false;}
      const ids=exists?preferences.featuredIds.filter(value=>value!==id):[...preferences.featuredIds,id];
      persist({...preferences,featuredIds:ids});onChange();renderFeatured();
      announce(exists?'已移出精选':'已加入精选');return true;
    });
  }

  function updateControl(target) {
    guard(()=>{
      if(target.dataset.personalOption){
        const key=target.dataset.personalOption;saveCurrent({...current(),[key]:Number(target.value)});
        const output=panel.querySelector(`#personal-${key}-value`);if(output)output.textContent=current()[key]+(key==='brightness'?'%':'');announce('调整已自动保存');
      } else if(target.dataset.personalFurniture){
        saveCurrent({...current(),furniture:{...current().furniture,[target.dataset.personalFurniture]:target.checked}});announce('陈设已自动保存');
      } else if(['personal-sound-kind','personal-sound-volume','personal-sound-reading'].includes(target.id)){
        const sound={kind:panel.querySelector('#personal-sound-kind').value,volume:Number(panel.querySelector('#personal-sound-volume').value),duringReading:panel.querySelector('#personal-sound-reading').checked};
        // Stopping playback must still work if preference storage is full.
        if(sound.kind==='off'||sound.volume===0)ambient.configure(sound,{userGesture:false});
        persist({...preferences,sound});panel.querySelector('#personal-sound-volume-value').textContent=sound.volume+'%';panel.querySelector('[data-personal-play]').disabled=sound.kind==='off';ambient.configure(sound,{userGesture:true});
      }
    });
  }

  function open(nextTab='room') {
    if(disposed)return;
    tab=tabs.some(item=>item.id===nextTab)?nextTab:'room';events?.abort();events=new AbortController();
    showModal(`<section id="room-personalization" class="room-personalization"><header class="modal-header"><div class="drawer-top">私人阅览室<button type="button" class="icon-btn" data-action="dismiss" aria-label="关闭私人阅览室">${personalIcon('M5 5l14 14M5 19 19 5')}</button></div><h2>在喜欢的空间里，慢慢读。</h2><nav class="personal-tabs" aria-label="私人阅览室设置">${tabs.map(item=>`<button type="button" data-personal-tab="${item.id}" ${tab===item.id?'aria-current="page"':''}>${item.name}</button>`).join('')}</nav></header><div class="modal-body personal-body"><div class="personal-panel">${tab==='room'?roomMarkup():tab==='featured'?featuredMarkup():statsMarkup()}</div><p class="personal-status" role="status" data-personal-status></p></div></section>`);
    panel=document.querySelector('#room-personalization');if(!panel)return;
    const modal=panel.closest('.modal');if(modal){modal.classList.add('personal-modal','structured-modal');modal.setAttribute('aria-label','私人阅览室');}
    const signal=events.signal;
    panel.addEventListener('error',event=>{if(event.target.matches?.('.personal-featured-cover img'))event.target.hidden=true;},{signal,capture:true});
    panel.addEventListener('input',event=>{
      const target=event.target;
      if(target.id==='personal-featured-search'){search=target.value;renderFeatured();}
      else if(target.matches('input[type="range"]'))updateControl(target);
    },{signal});
    panel.addEventListener('change',event=>{if(!event.target.matches('input[type="range"]'))updateControl(event.target);},{signal});
    panel.addEventListener('click',event=>{
      const button=event.target.closest('button');if(!button||button.disabled||button.dataset.action==='dismiss')return;
      event.preventDefault();event.stopPropagation();
      guard(()=>{
        if(button.dataset.personalTab){open(button.dataset.personalTab);panel?.querySelector(`[data-personal-tab="${tab}"]`)?.focus();}
        else if(button.dataset.personalLayout){
          saveCurrent({...current(),layout:button.dataset.personalLayout});panel.querySelectorAll('[data-personal-layout]').forEach(item=>item.setAttribute('aria-pressed',String(item.dataset.personalLayout===current().layout)));announce('布局已自动保存');
        } else if(button.hasAttribute('data-personal-save')){
          const id=theme(),options=normalizeRoomOptions({...current(),camera:getScene?.()?.getCameraPose()||current().camera});
          persist({...preferences,themes:{...preferences.themes,[id]:{current:options,saved:options,savedAt:Date.now()}}});
          panel.querySelector('[data-personal-restore]').disabled=false;panel.querySelector('[data-personal-saved]').textContent='上次保存：'+dateText(preferences.themes[id].savedAt);announce('当前主题的布置与视角已保存');
        } else if(button.hasAttribute('data-personal-restore')){
          const entry=preferences.themes[theme()];saveCurrent(entry.saved);applyScene(true);open('room');announce('已恢复保存的布置与视角');
        } else if(button.hasAttribute('data-personal-reset')){
          saveCurrent(normalizeRoomOptions());applyScene(true);open('room');announce('已恢复本主题的默认布置；已存布置仍可恢复');
        } else if(button.hasAttribute('data-personal-play'))ambient.configure(preferences.sound,{userGesture:true});
        else if(button.hasAttribute('data-personal-show-featured')){dismiss();showFeatured?.();}
        else if(button.dataset.personalBook){dismiss();openBook(button.dataset.personalBook);}
        else if(button.dataset.personalAdd)toggleFeatured(button.dataset.personalAdd);
        else if(button.dataset.personalRemove)toggleFeatured(button.dataset.personalRemove);
        else if(button.hasAttribute('data-personal-clear-unavailable')){
          persist({...preferences,featuredIds:featuredBooks().map(book=>book.id)});onChange();renderFeatured();announce('已从精选移出不可见条目');
        }
        else if(button.dataset.personalMove){
          const id=button.dataset.personalMove,visible=featuredBooks().map(book=>book.id),other=visible[visible.indexOf(id)+Number(button.dataset.direction)];
          if(!other)return;
          const ids=[...preferences.featuredIds],a=ids.indexOf(id),b=ids.indexOf(other);[ids[a],ids[b]]=[ids[b],ids[a]];
          persist({...preferences,featuredIds:ids});onChange();renderFeatured();panel.querySelectorAll('[data-personal-move]').forEach(item=>{if(item.dataset.personalMove===id&&item.dataset.direction===button.dataset.direction&&!item.disabled)item.focus();});announce('陈列顺序已保存');
        }
      });
    },{signal});
    renderFeatured();
  }

  return {
    open,sceneOptions:(id=theme())=>normalizeRoomOptions(preferences.themes[id]?.current),applyScene,
    toggleFeatured,isFeatured:id=>preferences.featuredIds.includes(id),getFeaturedBooks:featuredBooks,featuredCount:()=>featuredBooks().length,
    setReaderOpen:value=>ambient.setReaderOpen(value),
    refresh(){if(panel?.isConnected){if(tab==='featured')renderFeatured();else if(tab==='stats'){panel.querySelector('.personal-panel').innerHTML=statsMarkup();}}},
    dispose(){disposed=true;events?.abort();ambient.dispose();panel=null;},
  };
}
