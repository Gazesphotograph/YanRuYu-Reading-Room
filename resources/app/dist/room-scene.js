import * as THREE from './vendor/three.module.min.js';
import { RoundedBoxGeometry } from './vendor/RoundedBoxGeometry.js';
import { DEFAULT_COVER_ASPECT, bookRowLayout } from './room-book-layout.js';
import { normalizeCoverTexture } from './room-cover.js';
import { createRoomEnvironment } from './room-environment.js';
import { normalizeQuality, getQualityPreset, limitCoverTexture, textureMemoryBytes } from './room-quality.js';
import { normalizeRoomOptions, normalizeRoomCamera, roomLayoutOffsets } from './room-personalization-state.js';

// The room uses one camera and one lighting rig. HTML buttons follow the book
// projections so keyboard navigation and the existing reader remain native DOM.
const PALETTES = {
  paper: { wall:'#e8e5dc', floor:'#d7d2c4', wood:'#59483b', edge:'#342c24', fabric:'#566850', rug:'#c4bcaa', metal:'#49453c', accent:'#b19469', print:'#f0ebdf', light:'#fff6e8', exposure:1.05 },
  glass: { wall:'#f6f6f5', floor:'#eef0ef', wood:'#ffffff', edge:'#c5cbcd', fabric:'#fbfbfa', rug:'#e7eae8', metal:'#bec4c6', accent:'#aebbbd', print:'#fdfdfc', light:'#ffffff', exposure:1.03 },
  forest: { wall:'#333d35', floor:'#394137', wood:'#554b3a', edge:'#292d25', fabric:'#74816a', rug:'#535b4b', metal:'#aaa48b', accent:'#bbc49e', print:'#c9cbb6', light:'#f3ebd1', exposure:0.94 },
  hub: { wall:'#252525', floor:'#30302e', wood:'#383531', edge:'#171716', fabric:'#8f6137', rug:'#49433b', metal:'#9d7e51', accent:'#ff9900', print:'#d9c9b2', light:'#ffce89', exposure:0.94 },
  ex: { wall:'#45464b', floor:'#424247', wood:'#625d54', edge:'#303136', fabric:'#82817a', rug:'#64625d', metal:'#b1a78e', accent:'#d9caa3', print:'#d7d0bf', light:'#fff1d7', exposure:0.93 },
  terminal: { wall:'#192720', floor:'#203026', wood:'#344b39', edge:'#16241b', fabric:'#536e4c', rug:'#394b37', metal:'#71977a', accent:'#9cdb9f', print:'#bdc9af', light:'#e1f1cb', exposure:0.90 },
  neon: { wall:'#2b253c', floor:'#312c43', wood:'#4f415e', edge:'#211c2d', fabric:'#756888', rug:'#484254', metal:'#ada2bc', accent:'#87c6cd', print:'#d4c9df', light:'#e4dbff', exposure:0.93 },
  acid: { wall:'#e0e2cf', floor:'#cbd0b9', wood:'#555b36', edge:'#252b20', fabric:'#b6648f', rug:'#b8be9b', metal:'#32392a', accent:'#b1cb50', print:'#e5edb8', light:'#fff7e3', exposure:1.03 },
};
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const CAMERA_LIMITS = { yaw:.29, panX:1.8, panY:1.15, zoomMin:.72, zoomMax:1.9 };
let titleHintId=0;

// One content-sized tooltip per view keeps complete titles outside clipping and
// perspective containers. The returned disposer also supports update() / hide().
export function bindBookTitles(root) {
  if(!root)return Object.assign(()=>{},{update:()=>{},hide:()=>{}});
  const abort=new AbortController(),signal=abort.signal,nativeTitles=new Map();
  const tooltip=document.createElement('div');tooltip.className='book-title-tooltip scene-book-label';
  tooltip.id=`book-title-tooltip-${++titleHintId}`;tooltip.setAttribute('role','tooltip');tooltip.hidden=true;
  document.body.append(tooltip);
  let active=null,hovered=null,focused=null,overHint=false,hideTimer=0,frame=0;
  const removeNativeTitle=button=>{
    if(button.hasAttribute('title')){nativeTitles.set(button,button.getAttribute('title'));button.removeAttribute('title');}
  };
  root.querySelectorAll('[data-book]').forEach(removeNativeTitle);
  const bookFrom=target=>{
    const button=target instanceof Element?target.closest('[data-book]'):null;
    return button&&root.contains(button)?button:null;
  };
  const describe=(button,add)=>{
    if(!button)return;
    const ids=(button.getAttribute('aria-describedby')||'').split(/\s+/).filter(id=>id&&id!==tooltip.id);
    if(add)ids.push(tooltip.id);
    if(ids.length)button.setAttribute('aria-describedby',ids.join(' '));else button.removeAttribute('aria-describedby');
  };
  const hide=()=>{
    clearTimeout(hideTimer);cancelAnimationFrame(frame);frame=0;
    describe(active,false);active=null;tooltip.hidden=true;overHint=false;
  };
  const position=()=>{
    frame=0;
    if(!active)return;
    if(!active.isConnected||active.closest('[inert]')){hide();return;}
    const rect=active.getBoundingClientRect(),view=window.visualViewport;
    const width=view?.width||document.documentElement.clientWidth,height=view?.height||document.documentElement.clientHeight;
    const x=view?.offsetLeft||0,y=view?.offsetTop||0,margin=12,gap=11;
    if(rect.bottom<y||rect.top>y+height||rect.right<x||rect.left>x+width){hide();return;}
    tooltip.style.maxWidth=`${Math.max(1,Math.min(680,width-margin*2))}px`;
    tooltip.style.maxHeight=`${Math.max(1,height-margin*2)}px`;
    const size=tooltip.getBoundingClientRect();
    const left=clamp(rect.left+rect.width/2-size.width/2,x+margin,Math.max(x+margin,x+width-margin-size.width));
    const below=rect.bottom+gap,above=rect.top-gap-size.height;
    const top=below+size.height<=y+height-margin?below:above>=y+margin?above:clamp(below,y+margin,Math.max(y+margin,y+height-margin-size.height));
    tooltip.style.left=`${Math.round(left)}px`;tooltip.style.top=`${Math.round(top)}px`;
    tooltip.dataset.placement=top<rect.top?'above':'below';
  };
  const update=()=>{if(active&&!frame)frame=requestAnimationFrame(position);};
  const show=button=>{
    if(!button||button.closest('[inert]')){hide();return;}
    clearTimeout(hideTimer);removeNativeTitle(button);
    if(active!==button){
      describe(active,false);active=button;
      const title=button.dataset.bookTitle||button.closest('.book-slot')?.querySelector('.book-label')?.textContent||nativeTitles.get(button)||button.getAttribute('aria-label')||'';
      tooltip.replaceChildren();
      const text=document.createElement('span');text.textContent=title;tooltip.append(text);
      tooltip.dataset.book=button.dataset.book;describe(button,true);
    }
    tooltip.hidden=false;position();
  };
  const reconcile=()=>{
    clearTimeout(hideTimer);
    hideTimer=setTimeout(()=>{if(overHint)return;const button=hovered||focused;if(button)show(button);else hide();},100);
  };
  root.addEventListener('pointerover',e=>{if(e.pointerType==='touch')return;const button=bookFrom(e.target);if(button){hovered=button;show(button);}},{signal});
  root.addEventListener('pointerout',e=>{const button=bookFrom(e.target);if(!button||button.contains(e.relatedTarget))return;if(hovered===button)hovered=null;reconcile();},{signal});
  root.addEventListener('focusin',e=>{focused=bookFrom(e.target);if(focused)show(focused);},{signal});
  root.addEventListener('focusout',e=>{const button=bookFrom(e.target);if(button&&!button.contains(e.relatedTarget)){focused=null;reconcile();}},{signal});
  root.addEventListener('click',()=>{hovered=null;focused=null;hide();},{signal});
  root.addEventListener('pointerdown',e=>{if(e.button===1){hovered=null;hide();}},{signal});
  tooltip.addEventListener('pointerenter',()=>{overHint=true;clearTimeout(hideTimer);},{signal});
  tooltip.addEventListener('pointerleave',()=>{overHint=false;reconcile();},{signal});
  window.addEventListener('resize',update,{signal});window.addEventListener('scroll',update,{signal,capture:true});
  window.visualViewport?.addEventListener('resize',update,{signal});window.visualViewport?.addEventListener('scroll',update,{signal});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){hovered=null;focused=null;hide();}},{signal});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)hide();},{signal});
  const dispose=()=>{abort.abort();hide();tooltip.remove();nativeTitles.forEach((title,button)=>{if(!button.hasAttribute('title'))button.setAttribute('title',title);});};
  return Object.assign(dispose,{update,hide});
}

function canvasTexture(width, height, paint) {
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  paint(canvas.getContext('2d'), width, height);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
function grainTexture() {
  return canvasTexture(1024, 256, (ctx, w, h) => {
    ctx.fillStyle='#dedede';ctx.fillRect(0,0,w,h);
    for (let y=0; y<h; y+=1.4) {
      const seed=(Math.sin(y*127.1)*43758.5453)%1;
      ctx.strokeStyle=seed>0?'rgba(55,55,55,.08)':'rgba(255,255,255,.11)';
      ctx.lineWidth=.35+Math.abs(seed)*.45;ctx.beginPath();
      for(let x=0;x<=w;x+=16){const yy=y+Math.sin(x*.003+y*.093)*1.2; x?ctx.lineTo(x,yy):ctx.moveTo(x,yy);}ctx.stroke();
    }
  });
}
function fabricTexture() {
  return canvasTexture(128, 128, (ctx,w,h) => {
    ctx.fillStyle='#c6c6c6';ctx.fillRect(0,0,w,h);
    for(let y=0;y<h;y+=2)for(let x=0;x<w;x+=2){ctx.fillStyle=(x+y)%4?'#a4a4a4':'#dedede';ctx.fillRect(x,y,1,1);}
  });
}
function shadowTexture(glass=false) {
  return canvasTexture(128,128,(ctx,w,h)=>{
    const gradient=ctx.createRadialGradient(w/2,h/2,5,w/2,h/2,w/2);
    const color=glass?'38,42,43':'32,27,20';
    gradient.addColorStop(0,`rgba(${color},${glass?.23:.29})`);gradient.addColorStop(.4,`rgba(${color},${glass?.09:.13})`);gradient.addColorStop(1,`rgba(${color},0)`);
    ctx.fillStyle=gradient;ctx.fillRect(0,0,w,h);
  });
}
function glassReflectionTexture() {
  // A small, static studio reflection keeps the clear edges legible without a
  // transmission render pass or a second view of the books behind the shelves.
  const texture=canvasTexture(512,256,(ctx,w,h)=>{
    const room=ctx.createLinearGradient(0,0,0,h);
    room.addColorStop(0,'#ffffff');room.addColorStop(.4,'#f3f4f3');room.addColorStop(.53,'#b8bfc0');room.addColorStop(.7,'#e5e8e6');room.addColorStop(1,'#d5d9d7');
    ctx.fillStyle=room;ctx.fillRect(0,0,w,h);
    for(const [x,width,alpha] of [[.12,.12,.95],[.59,.20,.78],[.91,.025,.72]]){
      const light=ctx.createLinearGradient(w*x,0,w*(x+width),0);
      light.addColorStop(0,'rgba(255,255,255,0)');light.addColorStop(.2,`rgba(255,255,255,${alpha})`);light.addColorStop(.8,`rgba(255,255,255,${alpha})`);light.addColorStop(1,'rgba(255,255,255,0)');
      ctx.fillStyle=light;ctx.fillRect(w*x,h*.08,w*width,h*.8);
    }
  });
  texture.mapping=THREE.EquirectangularReflectionMapping;
  return texture;
}
function printTexture(p) {
  return canvasTexture(600,800,(ctx,w,h)=>{
    ctx.fillStyle=p.print;ctx.fillRect(0,0,w,h);
    ctx.strokeStyle=p.wood;ctx.lineWidth=2;ctx.strokeRect(30,30,w-60,h-60);
    ctx.fillStyle=p.edge;ctx.font='20px "Segoe UI Variable Text", "Noto Sans SC", sans-serif';ctx.fillText('颜如玉',65,87);
    ctx.font='italic 63px Georgia, serif';ctx.fillText('One more',62,188);ctx.fillText('chapter.',62,263);
    ctx.fillStyle=p.fabric;ctx.beginPath();ctx.roundRect(150,355,290,350,[145,145,0,0]);ctx.fill();
    ctx.fillStyle=p.accent;ctx.beginPath();ctx.arc(383,440,65,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.print;ctx.fillRect(155,616,150,92);
    ctx.fillStyle=p.edge;ctx.font='19px "Segoe UI Variable Text", "Noto Sans SC", sans-serif';ctx.fillText('书中自有颜如玉',65,756);
  });
}
function placeholderTexture(book,index) {
  return canvasTexture(420,600,(ctx,w,h)=>{
    const colors=['#627366','#8d7159','#576976','#887772','#696e55','#6e647d'];
    ctx.fillStyle=colors[index%colors.length];ctx.fillRect(0,0,w,h);
    ctx.fillStyle='#e6ddc5';ctx.fillRect(27,31,2,535);ctx.font='12px "Segoe UI Variable Text",sans-serif';ctx.fillText('PRIVATE COLLECTION',48,67);
    ctx.globalAlpha=.17;ctx.beginPath();ctx.arc(315,195,130,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
    ctx.font='29px "Segoe UI Variable Text", "Noto Sans SC", "Microsoft YaHei UI",sans-serif';
    const text=Array.from(book.title || '未命名书籍').slice(0,32);
    for(let line=0;line<4&&line*8<text.length;line++)ctx.fillText(text.slice(line*8,line*8+8).join(''),49,370+line*43);
    ctx.font='12px "Segoe UI Variable Text",sans-serif';ctx.fillText('LOCAL LIBRARY',50,551);
  });
}

export class RoomScene {
  constructor(element,{quality='balanced',personalization}={}) {
    this.element=element;this.books=[];this.items=[];this.theme='paper';this.version=0;this.capacity=6;
    this.personalization=normalizeRoomOptions(personalization);this.personalizationTheme=null;this.cabinets=[];this.furniture={};this.anchoredProps=[];
    this.quality=normalizeQuality(quality);this.qualityPreset=getQualityPreset(this.quality);this.roomBuilds=0;this.bookUpdates=0;
    this.frame=0;this.frameCount=0;this.yaw=0;this.targetYaw=0;this.destroyed=false;
    this.panX=0;this.panY=0;this.targetPanX=0;this.targetPanY=0;this.zoom=1;this.targetZoom=1;
    this.generated=new Set();this.bookGenerated=new Set();this.staticTextures=new Map();this.coverCache=new Map();this.coverLoads=new Map();this.worldGeometries=new Map();this.bookGeometries=new Map();this.abort=new AbortController();
    this.coverQueue=[];this.activeCoverLoads=0;
    this.cameraTarget=new THREE.Vector3();this.cameraOffset=new THREE.Vector3();this.cameraUp=new THREE.Vector3();
    this.projectionPoint=new THREE.Vector3();this.projectionPosition=new THREE.Vector3();this.projectionMatrix=new THREE.Matrix4();
    this.reduced=matchMedia('(prefers-reduced-motion: reduce)');
    element.innerHTML=`<div class="scene-topline"><span class="scene-edition">YAN RU YU <i></i> PRIVATE COLLECTION</span><span class="scene-material">胡桃木 · 日光</span></div><div class="scene-surface"><div class="scene-book-layer" role="group" aria-label="立体书架上的藏书"></div></div><div class="scene-bottomline"><span class="scene-caption">书中自有颜如玉</span><div class="scene-controls" role="group" aria-label="书架视角"><span class="scene-drag-hint">左键环顾 · 中键拖动 · 滚轮缩放</span><button type="button" data-scene-camera="left" aria-label="向左查看书架" title="向左查看"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5-7 7 7 7"/></svg></button><button type="button" data-scene-camera="reset" aria-label="恢复书架视角、位置和缩放" title="恢复视角、位置和缩放"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 5v8l-8 5-8-5V8l8-5ZM4 8l8 5 8-5m-8 5v8m0-18v10"/></svg></button><button type="button" data-scene-camera="right" aria-label="向右查看书架" title="向右查看"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg></button></div></div>`;
    this.surface=element.querySelector('.scene-surface');this.layer=element.querySelector('.scene-book-layer');
    try {
      this.renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'low-power'});
      this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,this.qualityPreset.pixelRatio));
      this.renderer.outputColorSpace=THREE.SRGBColorSpace;
      this.renderer.toneMapping=THREE.ACESFilmicToneMapping;
      this.renderer.shadowMap.enabled=this.qualityPreset.shadows;this.renderer.shadowMap.type=THREE.VSMShadowMap;
      this.renderer.shadowMap.autoUpdate=false;
      this.renderer.domElement.className='scene-canvas';this.renderer.domElement.setAttribute('aria-hidden','true');
      this.surface.prepend(this.renderer.domElement);
      this.scene=new THREE.Scene();this.camera=new THREE.OrthographicCamera(-5,5,3,-3,.1,70);
      this.renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();this.useFallback();},{signal:this.abort.signal});
      this.installControls();
    } catch { this.renderer?.dispose();this.renderer=null; }
    this.resizeObserver=new ResizeObserver(()=>this.resize());this.resizeObserver.observe(this.surface);
    this.intersectionObserver=new IntersectionObserver(entries=>{
      this.inView=entries[0]?.isIntersecting!==false;
      if(this.inView)this.invalidate();else{cancelAnimationFrame(this.frame);this.frame=0;this.cancelCameraDrag?.();this.titleHints?.hide();}
    });this.intersectionObserver.observe(element);
    this.reduced.addEventListener('change',()=>this.requestCameraUpdate(),{signal:this.abort.signal});
    document.addEventListener('visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(this.frame);this.frame=0;}else this.invalidate();},{signal:this.abort.signal});
    this.element.dataset.sceneQuality=this.quality;
  }

  installControls() {
    const canvas=this.renderer.domElement,surface=this.surface,signal=this.abort.signal;
    let pointer=null;
    surface.addEventListener('pointerdown',e=>{
      if(this.failed||this.suspended||!this.bounds||pointer)return;
      if(e.button!==1&&(e.button!==0||e.target!==canvas))return;
      e.preventDefault();
      const span=Math.max(this.bounds.height,this.bounds.width/(this.width/this.height));
      pointer={id:e.pointerId,mode:e.button===1?'pan':'orbit',x:e.clientX,y:e.clientY,yaw:this.targetYaw,panX:this.targetPanX,panY:this.targetPanY,scale:span/(this.height*this.targetZoom)};
      surface.setPointerCapture(e.pointerId);canvas.classList.add('is-dragging');surface.classList.toggle('is-panning',pointer.mode==='pan');
      this.titleHints?.hide();
    },{signal});
    surface.addEventListener('pointermove',e=>{
      if(!pointer||e.pointerId!==pointer.id)return;
      if(this.suspended||this.failed||this.element.closest('[inert]')){this.cancelCameraDrag();return;}
      e.preventDefault();
      if(pointer.mode==='pan'){
        this.targetPanX=clamp(pointer.panX-(e.clientX-pointer.x)*pointer.scale,-CAMERA_LIMITS.panX,CAMERA_LIMITS.panX);
        this.targetPanY=clamp(pointer.panY+(e.clientY-pointer.y)*pointer.scale,-CAMERA_LIMITS.panY,CAMERA_LIMITS.panY);
      }else this.targetYaw=clamp(pointer.yaw-(e.clientX-pointer.x)*.0018,-CAMERA_LIMITS.yaw,CAMERA_LIMITS.yaw);
      this.requestCameraUpdate();
    },{signal});
    const end=e=>{
      if(!pointer||e.pointerId!==pointer.id)return;
      const id=pointer.id;pointer=null;
      if(surface.hasPointerCapture(id))surface.releasePointerCapture(id);
      canvas.classList.remove('is-dragging');surface.classList.remove('is-panning');
    };
    surface.addEventListener('pointerup',end,{signal});surface.addEventListener('pointercancel',end,{signal});surface.addEventListener('lostpointercapture',end,{signal});
    this.cancelCameraDrag=()=>{if(pointer)end({pointerId:pointer.id});};
    window.addEventListener('blur',this.cancelCameraDrag,{signal});
    surface.addEventListener('auxclick',e=>{if(e.button===1&&!this.failed){e.preventDefault();e.stopPropagation();}},{signal});
    surface.addEventListener('wheel',e=>{
      if(this.failed||this.suspended||!this.bounds||!e.deltaY)return;
      e.preventDefault();
      const delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?this.height:1);
      this.targetZoom=clamp(this.targetZoom*Math.exp(-clamp(delta,-2400,2400)*.0018),CAMERA_LIMITS.zoomMin,CAMERA_LIMITS.zoomMax);
      this.requestCameraUpdate();
    },{signal,passive:false});
    this.element.querySelectorAll('[data-scene-camera]').forEach(button=>button.addEventListener('click',()=>{
      if(button.dataset.sceneCamera==='reset'){
        this.targetYaw=0;this.targetPanX=0;this.targetPanY=0;this.targetZoom=1;
      }else this.targetYaw=clamp(this.targetYaw+(button.dataset.sceneCamera==='left'?-.13:.13),-CAMERA_LIMITS.yaw,CAMERA_LIMITS.yaw);
      this.requestCameraUpdate();
    },{signal}));
  }

  requestCameraUpdate() {
    Object.assign(this.element.dataset,{cameraTargetYaw:String(this.targetYaw),cameraTargetPanX:String(this.targetPanX),cameraTargetPanY:String(this.targetPanY),cameraTargetZoom:String(this.targetZoom)});
    if(this.reduced.matches){this.yaw=this.targetYaw;this.panX=this.targetPanX;this.panY=this.targetPanY;this.zoom=this.targetZoom;this.cameraDirty=true;}
    this.invalidate();
  }

  setBooks(books,theme,page=1,capacity=books.length) {
    const nextTheme=PALETTES[theme]?theme:'paper',narrow=this.surface.clientWidth<700;
    const nextCapacity=Number(capacity)>6?12:6;
    // Counts, reading progress and favorites often refresh without changing the
    // visible shelves. Keep the existing camera, meshes, textures and targets.
    const sameLayout=this.world&&this.theme===nextTheme&&this.narrow===narrow&&nextCapacity===this.capacity;
    const sameBooks=sameLayout&&books.length===this.books.length&&books.every((book,index)=>{
      const previous=this.books[index];
      return book.id===previous.id&&book.title===previous.title&&book.cover===previous.cover&&book.pages===previous.pages;
    });
    this.books=books;this.theme=nextTheme;this.page=page;this.narrow=narrow;this.capacity=nextCapacity;
    this.element.classList.toggle('scene-tall',this.narrow&&this.capacity>6);
    if(!this.renderer||this.failed){this.useFallback();return;}
    if(sameBooks){this.items.forEach((item,index)=>this.updateBookMarkers(item,books[index]));this.resize();return;}
    if(sameLayout)this.replaceBooks();else this.build();
    this.resize();
  }
  setTheme(theme) { if(this.theme===theme)return;this.setBooks(this.books,theme,this.page,this.capacity); }
  getCameraPose() {return normalizeRoomCamera({yaw:this.targetYaw,panX:this.targetPanX,panY:this.targetPanY,zoom:this.targetZoom});}
  setCameraPose(value) {
    const pose=normalizeRoomCamera(value);
    this.yaw=this.targetYaw=pose.yaw;this.panX=this.targetPanX=pose.panX;this.panY=this.targetPanY=pose.panY;this.zoom=this.targetZoom=pose.zoom;
    this.cameraDirty=true;this.requestCameraUpdate();
  }
  setPersonalization(value,{restoreCamera=false}={}) {
    const next=normalizeRoomOptions(value),themeChanged=this.personalizationTheme!==this.theme;
    const changed=JSON.stringify({...next,camera:null})!==JSON.stringify({...this.personalization,camera:null});
    this.personalization=next;this.personalizationTheme=this.theme;
    if(changed)this.applyPersonalization();
    if(restoreCamera||themeChanged)this.setCameraPose(next.camera);
  }
  applyPersonalization() {
    if(!this.world||!this.renderer||this.failed)return;
    const options=this.personalization,offsets=roomLayoutOffsets(options,{narrow:this.narrow,capacity:this.capacity});
    this.cabinets.forEach((cabinet,index)=>{cabinet.group.position.x=cabinet.baseX+(offsets.shelf[index]||0);if(cabinet.shadow)cabinet.shadow.position.x=cabinet.baseX+(offsets.shelf[index]||0);});
    for(const entry of this.anchoredProps)entry.object.position.x=entry.baseX+(offsets.shelf[entry.cabinet]||0);
    for(const [name,group] of Object.entries(this.furniture)){
      group.position.x=offsets.corner;
      group.visible=options.furniture[name==='artwork'?'objects':name]!==false;
    }
    for(const object of this.environment?.group.children||[]){
      if(object.name.startsWith('environment-plant-'))object.visible=options.furniture.plants;
      else if(object.name&&!['environment-window','environment-window-light','environment-static-dust'].includes(object.name))object.visible=options.furniture.objects;
    }
    this.renderer.toneMappingExposure=this.palette.exposure*options.brightness/100;
    if(this.keyLight){
      this.keyLight.color.set(this.palette.light);
      if(options.warmth)this.keyLight.color.lerp(new THREE.Color(options.warmth>0?'#ffc98d':'#c6dfff'),Math.abs(options.warmth)/75);
    }
    this.items.forEach(item=>{item.projectedLayout=null;});this.targetsDirty=true;
    this.element.dataset.roomArrangement=options.layout;
    this.element.dataset.roomBrightness=String(options.brightness);
    this.renderer.shadowMap.needsUpdate=true;this.invalidate();
  }
  setQuality(value) {
    const quality=normalizeQuality(value);
    if(this.quality===quality)return;
    this.quality=quality;this.qualityPreset=getQualityPreset(quality);this.element.dataset.sceneQuality=quality;
    if(!this.renderer||this.failed)return;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio||1,this.qualityPreset.pixelRatio));
    this.renderer.shadowMap.enabled=this.qualityPreset.shadows;
    if(this.keyLight){
      this.keyLight.castShadow=this.qualityPreset.shadows;
      this.keyLight.shadow.dispose();this.keyLight.shadow.map=null;this.keyLight.shadow.mapPass=null;
      this.keyLight.shadow.mapSize.set(this.qualityPreset.shadowSize,this.qualityPreset.shadowSize);
      this.keyLight.shadow.blurSamples=this.qualityPreset.shadowSamples;
    }
    this.staticTextures.forEach(texture=>{texture.anisotropy=Math.min(this.renderer.capabilities.getMaxAnisotropy()||1,this.qualityPreset.anisotropy);texture.needsUpdate=true;});
    this.environment?.setQuality?.(this.qualityPreset);
    if(this.world)this.replaceBooks({dropCoverCache:true});
    this.cameraDirty=true;this.resize();this.renderer.shadowMap.needsUpdate=true;this.invalidate();
  }
  getResourceStats() {
    return {quality:this.quality,roomBuilds:this.roomBuilds,bookUpdates:this.bookUpdates,staticGeometries:this.worldGeometries.size,bookGeometries:this.bookGeometries.size,coverCount:this.coverCache.size,coverBytes:[...this.coverCache.values()].reduce((sum,texture)=>sum+textureMemoryBytes(texture),0),coverBudgetBytes:this.qualityPreset.coverBudgetBytes,renderCount:this.frameCount,...this.renderer?.info.memory};
  }
  setSuspended(value) {
    this.suspended=value;
    if(value){cancelAnimationFrame(this.frame);this.frame=0;this.cancelCameraDrag?.();this.titleHints?.hide();}else this.invalidate();
  }

  ownTexture(texture) {this.generated.add(texture);return texture;}
  ownBookTexture(texture) {this.bookGenerated.add(texture);return texture;}
  staticTexture(key,create) {if(!this.staticTextures.has(key))this.staticTextures.set(key,create());return this.staticTextures.get(key);}
  geometry(key,create) {const cache=this.resourceScope==='book'?this.bookGeometries:this.worldGeometries;if(!cache.has(key))cache.set(key,create());return cache.get(key);}
  material(color,options={}) {return new THREE.MeshStandardMaterial({color,roughness:.7,...options});}
  box(parent,w,h,d,material,x=0,y=0,z=0,r=.015) {
    const geometry=this.geometry(`box:${w}:${h}:${d}:${r}`,()=>r>0?new RoundedBoxGeometry(w,h,d,2,Math.min(r,w/3,h/3,d/3)):new THREE.BoxGeometry(w,h,d));
    const clearGlass=this.theme==='glass'&&(material===this.wood||material===this.endgrain);
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.castShadow=!clearGlass;mesh.receiveShadow=!clearGlass;parent.add(mesh);return mesh;
  }
  cylinder(parent,rt,rb,h,material,x,y,z,segments=40) {
    const clearGlass=this.theme==='glass'&&(material===this.wood||material===this.endgrain);
    const geometry=this.geometry(`cylinder:${rt}:${rb}:${h}:${segments}`,()=>new THREE.CylinderGeometry(rt,rb,h,segments));
    const mesh=new THREE.Mesh(geometry,material);mesh.position.set(x,y,z);mesh.castShadow=!clearGlass;mesh.receiveShadow=!clearGlass;parent.add(mesh);return mesh;
  }
  contact(parent,x,z,sx,sz,opacity=1) {
    const mesh=new THREE.Mesh(new THREE.PlaneGeometry(sx,sz),new THREE.MeshBasicMaterial({map:this.shadow,transparent:true,opacity,depthWrite:false,toneMapped:false}));
    mesh.rotation.x=-Math.PI/2;mesh.position.set(x,.007,z);parent.add(mesh);return mesh;
  }
  disposeWorld() {
    this.disposeBooks();
    if(this.world){
      const geometries=new Set(),materials=new Set();
      this.world.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)(Array.isArray(object.material)?object.material:[object.material]).forEach(m=>materials.add(m));if(object.isLight)object.shadow?.dispose();});
      geometries.forEach(g=>g.dispose());materials.forEach(m=>m.dispose());this.scene.remove(this.world);this.world=null;
    }
    this.generated.forEach(texture=>texture.dispose());this.generated.clear();this.worldGeometries.clear();this.items=[];this.bookRows=[];this.environment=null;this.keyLight=null;this.cabinets=[];this.furniture={};this.anchoredProps=[];
  }
  disposeBooks() {
    this.titleHints?.();this.titleHints=null;
    const geometries=new Set(this.bookGeometries.values()),materials=new Set();
    for(const row of this.bookRows||[]){
      row.bookGroup.traverse(object=>{if(object.geometry)geometries.add(object.geometry);if(object.material)(Array.isArray(object.material)?object.material:[object.material]).forEach(material=>materials.add(material));});
      row.bookGroup.clear();row.items=[];
    }
    geometries.forEach(geometry=>geometry.dispose());materials.forEach(material=>material.dispose());
    this.bookGenerated.forEach(texture=>texture.dispose());this.bookGenerated.clear();this.bookGeometries.clear();
    this.items=[];this.pageMaterial=null;this.boardMaterials=[];this.layer?.replaceChildren();
  }
  replaceBooks({dropCoverCache=false}={}) {
    ++this.version;++this.bookUpdates;this.disposeBooks();
    if(dropCoverCache){this.coverCache.forEach(texture=>texture.dispose());this.coverCache.clear();}
    for(const row of this.bookRows){
      const selection=this.books.slice(row.offset,row.offset+3);row.building=true;
      this.resourceScope='book';
      try {selection.forEach((book,index)=>this.createBook(row.bookGroup,book,row.offset+index,0,row.base,.13,row));}
      finally {this.resourceScope=null;}
      row.building=false;this.layoutBookRow(row);
      if(!selection.length&&!row.decorations){row.decorations=new THREE.Group();row.parent.add(row.decorations);this.shelfObjects(row.decorations,row.base,row.index);}
      if(row.decorations)row.decorations.visible=!selection.length;
    }
    this.titleHints=bindBookTitles(this.layer);this.trimCoverCache();this.pumpCovers();
    this.targetsDirty=true;this.renderer.shadowMap.needsUpdate=true;this.invalidate();
  }
  build() {
    ++this.version;++this.roomBuilds;this.disposeWorld();this.world=new THREE.Group();this.scene.add(this.world);
    this.cameraDirty=true;this.targetsDirty=true;this.pageMaterial=null;this.boardMaterials=[];this.bookRows=[];
    const p=PALETTES[this.theme];this.palette=p;this.scene.background=new THREE.Color(p.wall);this.renderer.toneMappingExposure=p.exposure;
    this.element.dataset.sceneState='loading';this.element.dataset.sceneTheme=this.theme;
    const materials={paper:'胡桃木 · 日光',glass:'纯白玻璃 · 柔光',forest:'深木 · 夜读',hub:'炭黑 · 琥珀',ex:'石墨 · 米金',terminal:'墨绿 · 档案',neon:'紫灰 · 冷光',acid:'橄榄 · 玫粉'};
    this.element.querySelector('.scene-material').textContent=materials[this.theme];
    const natural=this.theme==='paper'||this.theme==='forest';
    const coated=this.theme==='acid',glass=this.theme==='glass';
    const grain=natural?this.staticTexture('grain',grainTexture):null;if(grain)grain.wrapS=grain.wrapT=THREE.RepeatWrapping;
    const weave=!this.narrow&&this.capacity<=6?this.staticTexture('fabric',fabricTexture):null;if(weave){weave.wrapS=weave.wrapT=THREE.RepeatWrapping;weave.repeat.set(9,9);}
    this.shadow=this.staticTexture(glass?'shadow-glass':'shadow',()=>shadowTexture(glass));
    const reflection=glass?this.staticTexture('glass-reflection',glassReflectionTexture):null;
    this.wood=glass?new THREE.MeshPhysicalMaterial({color:p.wood,roughness:.18,metalness:.02,transparent:true,opacity:.58,ior:1.46,envMap:reflection,envMapIntensity:.5,depthWrite:false}):this.material(p.wood,{map:natural?grain:null,bumpMap:natural?grain:null,bumpScale:.007,roughness:natural?.66:coated?.82:.48,metalness:natural||coated?0:.24});
    this.endgrain=glass?new THREE.MeshBasicMaterial({color:'#8f9b9e',transparent:true,opacity:.2,depthWrite:false,toneMapped:false}):this.wood.clone();
    if(!glass)this.endgrain.roughness=.78;
    this.fabric=this.material(p.fabric,{bumpMap:weave,bumpScale:glass?.003:.019,roughness:.94});
    this.edge=this.material(p.edge,{roughness:glass?.25:.64});this.metal=this.material(p.metal,{metalness:glass?.72:.35,roughness:glass?.24:.45,envMap:reflection,envMapIntensity:glass?.6:1});
    this.accent=this.material(p.accent,{roughness:glass?.28:.6});
    const floor=new THREE.Mesh(new THREE.PlaneGeometry(90,90),this.material(p.floor,{roughness:glass?.78:1}));floor.rotation.x=-Math.PI/2;floor.receiveShadow=true;this.world.add(floor);
    const wall=new THREE.Mesh(new THREE.PlaneGeometry(100,30),this.material(p.wall,{roughness:1}));wall.position.set(0,10,-1.04);wall.receiveShadow=true;this.world.add(wall);
    this.box(this.world,60,.065,.055,this.material(p.wall),0,.035,-.99,.008);
    const hemi=new THREE.HemisphereLight(glass?'#ffffff':'#fff8ed',glass?'#d9dcd9':'#9b9382',glass?2.55:2.45);this.world.add(hemi);
    const key=new THREE.DirectionalLight(p.light,glass?2.5:2.65);key.position.set(-3.8,7.8,5.6);key.target.position.set(0,1.6,0);
    key.castShadow=this.qualityPreset.shadows;key.shadow.mapSize.set(this.qualityPreset.shadowSize,this.qualityPreset.shadowSize);Object.assign(key.shadow.camera,{left:-8,right:8,top:8,bottom:-6,near:.5,far:25});key.shadow.normalBias=.02;key.shadow.bias=-.00015;key.shadow.radius=glass?6:5;key.shadow.blurSamples=this.qualityPreset.shadowSamples;this.keyLight=key;
    this.world.add(key,key.target);
    const fill=new THREE.DirectionalLight(glass?'#ffffff':'#dfe8ed',glass?.72:.65);fill.position.set(5,3,4);this.world.add(fill);
    this.layer.replaceChildren();
    if(this.narrow){
      const rows=this.capacity>6?4:2;this.cabinet(0,rows,0,this.books);
      this.bounds={width:4.75,height:rows*1.55+.9,targetY:rows*1.55/2+.27,targetX:0};
    } else if(this.capacity>6){
      this.cabinet(-2.04,2,0,this.books.slice(0,6));this.cabinet(2.04,2,6,this.books.slice(6));
      this.bounds={width:9.6,height:4.95,targetY:1.74,targetX:0};
    } else {
      this.cabinet(-1.95,2,0,this.books);this.readingCorner();
      this.bounds={width:9.0,height:4.95,targetY:1.7,targetX:0};
    }
    const layout=this.narrow?'narrow':this.capacity>6?'double':'single';
    this.environment=createRoomEnvironment(this,{layout,rows:this.narrow&&this.capacity>6?4:2,floor,wall});
    const shelfTop=(this.narrow&&this.capacity>6?4:2)*1.55+.3975;
    this.anchoredProps=this.environment.group.children.filter(object=>object.name&&object.name!=='environment-window'&&object.position.y>=shelfTop-.01).map(object=>({object,baseX:object.position.x,cabinet:!this.narrow&&this.capacity>6&&object.position.x>0?1:0}));
    if(this.environment.bounds)this.bounds={...this.bounds,...this.environment.bounds};
    if(this.environment.label)this.element.querySelector('.scene-material').textContent=this.environment.label;
    this.element.dataset.sceneLayout=layout;
    this.replaceBooks();
    this.applyPersonalization();
    this.renderer.shadowMap.needsUpdate=true;this.element.dataset.sceneState='ready';this.invalidate();
  }

  cabinet(x,rows,offset,books) {
    const group=new THREE.Group();group.name='room-cabinet';group.position.x=x;this.world.add(group);
    const cabinet={group,baseX:x,shadow:null};this.cabinets.push(cabinet);
    const height=rows*1.55+.4, half=1.71;
    // Joined rectangular posts, full-depth shelves and a slim back crossbar.
    for(const xx of [-half,half])for(const z of [-.58,.40])this.box(group,.11,height,.11,this.wood,xx,height/2,z,.012);
    for(let i=0;i<=rows;i++){
      this.box(group,3.63,.115,1.08,this.wood,0,.34+i*1.55,-.09,.019);
      // The polished front edge gives clear shelving a visible thickness.
      if(this.theme==='glass')this.box(group,3.59,.055,.006,this.endgrain,0,.345+i*1.55,.452,.002);
    }
    for(let i=0;i<rows;i++)this.box(group,3.39,.065,.065,this.wood,0,.44+i*1.55,-.58,.009);
    // Dark ferrules and small brass joinery catch the side light.
    for(const xx of [-half,half])for(const z of [-.58,.40])this.box(group,.116,.08,.116,this.edge,xx,.04,z,.009);
    for(const xx of [-half,half])for(let row=0;row<=rows;row++){
      const screw=this.cylinder(group,.018,.018,.008,this.metal,xx,.34+row*1.55,.46,12);screw.rotation.x=Math.PI/2;
    }
    cabinet.shadow=this.contact(this.world,x,0,4.7,2.05,.7);
    for(let row=0;row<rows;row++){
      const base=.398+(rows-1-row)*1.55;
      const bookGroup=new THREE.Group();group.add(bookGroup);
      this.bookRows.push({items:[],building:true,bookGroup,parent:group,base,offset:offset+row*3,index:row,decorations:null});
    }
  }
  shelfObjects(parent,y,index) {
    const glass=this.theme==='glass';
    const paper=this.material(glass?'#f5f5f2':'#d8d1bf',{roughness:.93});
    for(let i=0;i<3;i++){
      const stack=new THREE.Group();stack.position.set(-.95+(i%2)*.045,y+i*.115,.09);stack.rotation.y=(i-1)*.09;parent.add(stack);
      this.box(stack,.81,.085,.55,paper,0,.043,0,.004);
      this.box(stack,.84,.017,.58,i===1?this.accent:this.edge,0,.005,0,.004);this.box(stack,.84,.017,.58,i===1?this.accent:this.edge,0,.09,0,.004);
    }
    const points=[new THREE.Vector2(.11,0),new THREE.Vector2(.21,.04),new THREE.Vector2(.24,.29),new THREE.Vector2(.15,.44),new THREE.Vector2(.11,.5),new THREE.Vector2(.105,.52)];
    const vase=new THREE.Mesh(new THREE.LatheGeometry(points,48),this.material(glass?'#f8f9f6':'#b7b6a4',{roughness:glass?.3:.89}));vase.position.set(.97,y,-.1);vase.castShadow=true;vase.receiveShadow=true;parent.add(vase);
    const stemMaterial=this.material(glass?'#a1afa4':'#737c56',{roughness:1});
    for(let i=0;i<3;i++){
      const stem=this.cylinder(parent,.006,.007,.78,stemMaterial,.97+(i-1)*.035,y+.74,-.10+(i-1)*.02,8);stem.rotation.z=(i-1)*.25;
      for(let k=0;k<3;k++){
        const leaf=new THREE.Mesh(new THREE.SphereGeometry(.07,12,8),stemMaterial);leaf.scale.set(1,.45,1.65);leaf.position.set(.97+(i-1)*(.12+k*.04),y+.7+k*.13,-.1+(k%2)*.07);leaf.rotation.z=i*.6;leaf.castShadow=true;parent.add(leaf);
      }
    }
  }

  layoutBookRow(row) {
    const placements=bookRowLayout(row.items.map(item=>({aspect:item.aspect,depth:item.depth,rotation:item.baseRotation})));
    row.items.forEach((item,index)=>{
      const placement=placements[index];
      item.width=placement.width;item.height=placement.height;item.baseX=placement.x;
      item.group.position.x=item.baseX;item.group.scale.set(item.width/item.modelWidth,item.height/item.modelHeight,1);
      item.layoutVersion=(item.layoutVersion||0)+1;
      Object.assign(item.button.dataset,{coverAspect:String(item.aspect),bookWidth:item.width.toFixed(5),bookHeight:item.height.toFixed(5),coverFormat:item.aspect>1.12?'landscape':item.aspect<.88?'portrait':'square'});
    });
    this.targetsDirty=true;
    if(this.renderer)this.renderer.shadowMap.needsUpdate=true;
    this.invalidate();
  }

  createBook(parent,book,index,x,y,z,row) {
    const group=new THREE.Group();group.position.set(x,y,z);group.rotation.y=-.10+(index%3)*.03;parent.add(group);
    const height=1.28,width=.86,depth=clamp(.105+(book.pages||50)/2000,.10,.22);
    const board=this.boardMaterials[index%4]??=this.material(['#43584c','#806953','#526674','#79666b'][index%4],{roughness:.75});
    const pagesTexture=this.staticTexture('book-pages',()=>canvasTexture(32,128,(ctx,w,h)=>{
      ctx.fillStyle='#e4dece';ctx.fillRect(0,0,w,h);ctx.fillStyle='#c7bfac';for(let i=2;i<h;i+=3)ctx.fillRect(0,i,w,.5);
    }));
    const pages=this.pageMaterial??=this.material('#eee9dc',{map:pagesTexture,roughness:.98});
    this.box(group,width-.027,height-.035,depth,pages,0,height/2,0,.005);
    this.box(group,width,height,.014,board,0,height/2,-depth/2-.009,.004);
    this.box(group,width,height,.014,board,0,height/2,depth/2+.008,.004);
    this.box(group,.025,height,depth+.022,board,-width/2+.004,height/2,0,.005);
    const cached=book.cover?this.coverCache.get(book.cover):null;
    const placeholder=cached?null:this.ownBookTexture(placeholderTexture(book,index));
    const frontMaterial=new THREE.MeshBasicMaterial({map:cached||placeholder,toneMapped:false});
    const front=new THREE.Mesh(new THREE.PlaneGeometry(width,height),frontMaterial);front.position.set(0,height/2,depth/2+.017);group.add(front);
    const crease=new THREE.Mesh(new THREE.PlaneGeometry(.022,height-.008),new THREE.MeshBasicMaterial({color:'#16150f',transparent:true,opacity:.19,depthWrite:false}));crease.position.set(-width/2+.029,height/2,depth/2+.018);group.add(crease);
    const button=document.createElement('button');button.type='button';button.className='scene-book-target';button.dataset.book=book.id;button.dataset.coverState=book.cover?'loading':'fallback';
    button.dataset.bookTitle=book.title;
    this.layer.append(button);
    const item={group,button,baseX:x,baseY:y,baseZ:z,baseRotation:group.rotation.y,width,height,modelWidth:width,modelHeight:height,depth,lift:0,targetLift:0,
      aspect:cached?.userData?.coverAspect||DEFAULT_COVER_ASPECT,row,frontMaterial,
      restRotation:group.quaternion.clone(),worldCorners:Array.from({length:4},()=>new THREE.Vector3())};this.items.push(item);row.items.push(item);
    this.updateBookMarkers(item,book);
    const hover=value=>{item.targetLift=this.reduced.matches?0:value;button.classList.toggle('is-hovered',!!value);this.invalidate();};
    button.addEventListener('pointerenter',()=>hover(1));button.addEventListener('pointerleave',()=>hover(button===document.activeElement?1:0));
    button.addEventListener('focus',()=>hover(1));button.addEventListener('blur',()=>hover(0));
    const version=this.version;
    const applyCover=texture=>{
      if(!texture||this.destroyed||this.failed||this.version!==version)return;
      frontMaterial.map=texture;
      if(placeholder&&this.bookGenerated.delete(placeholder))placeholder.dispose();
      item.aspect=texture.userData.coverAspect||texture.image.width/texture.image.height||DEFAULT_COVER_ASPECT;
      button.dataset.coverState='loaded';button.dataset.coverCropped=String(!!texture.userData.coverCropped);
      if(!row.building)this.layoutBookRow(row);
    };
    if(book.cover){
      if(cached)applyCover(cached);
      else this.loadCover(book.cover).then(applyCover,()=>{if(this.version===version&&!this.destroyed)button.dataset.coverState='fallback';});
    }
  }

  updateBookMarkers(item,book) {
    const progress=clamp(Number(book.progress)||0,0,100),marked=!!book.mark;
    if(item.progress===progress&&item.marked===marked)return;
    item.progress=progress;item.marked=marked;
    item.button.setAttribute('aria-label',book.title+(progress?`，已读 ${progress}%`:''));
    item.button.innerHTML=`<span class="scene-book-outline" aria-hidden="true"></span>${marked?'<span class="scene-book-favorite" aria-label="已收藏">♥</span>':''}${progress?`<span class="scene-book-progress" style="--progress:${progress}%" aria-hidden="true"></span>`:''}`;
  }

  loadCover(url) {
    if(this.coverCache.has(url)){const texture=this.coverCache.get(url);this.coverCache.delete(url);this.coverCache.set(url,texture);return Promise.resolve(texture);}
    if(this.coverLoads.has(url))return this.coverLoads.get(url);
    const pending=new Promise((resolve,reject)=>this.coverQueue.push({url,resolve,reject}));
    this.coverLoads.set(url,pending);this.pumpCovers();return pending;
  }

  pumpCovers() {
    // Drop work for pages that are no longer visible before decoding anything.
    const wanted=new Set(this.books.map(book=>book.cover));
    this.coverQueue=this.coverQueue.filter(job=>{
      if(!this.destroyed&&!this.failed&&wanted.has(job.url))return true;
      this.coverLoads.delete(job.url);job.resolve(null);return false;
    });
    while(this.activeCoverLoads<this.qualityPreset.coverConcurrency&&this.coverQueue.length){
      const job=this.coverQueue.shift();this.activeCoverLoads++;
      new Promise((resolve,reject)=>new THREE.TextureLoader().load(job.url,resolve,undefined,reject)).then(texture=>{
        if(this.destroyed||this.failed){texture.dispose();job.resolve(null);return;}
        normalizeCoverTexture(texture);
        limitCoverTexture(texture,this.qualityPreset.coverDimension);
        texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(this.renderer.capabilities.getMaxAnisotropy()||1,this.qualityPreset.anisotropy);
        this.coverCache.set(job.url,texture);this.trimCoverCache();job.resolve(texture);
      }).catch(job.reject).finally(()=>{
        this.coverLoads.delete(job.url);this.activeCoverLoads--;this.pumpCovers();
      });
    }
  }

  trimCoverCache() {
    let bytes=[...this.coverCache.values()].reduce((sum,texture)=>sum+textureMemoryBytes(texture),0);
    const {coverBudgetBytes,coverCount}=this.qualityPreset;
    if(this.coverCache.size<=coverCount&&bytes<=coverBudgetBytes)return;
    const visibleURLs=new Set(this.books.map(book=>book.cover));
    for(const [url,texture] of this.coverCache){
      if(!visibleURLs.has(url)){bytes-=textureMemoryBytes(texture);texture.dispose();this.coverCache.delete(url);}
      if(this.coverCache.size<=coverCount&&bytes<=coverBudgetBytes)break;
    }
  }

  readingCorner() {
    const p=this.palette;
    const furniture=name=>{const group=new THREE.Group();group.name='room-furniture-'+name;this.world.add(group);this.furniture[name]=group;return group;};
    const rugGroup=furniture('rug'),chairGroup=furniture('chair'),tableGroup=furniture('table'),lampGroup=furniture('lamp'),artGroup=furniture('artwork');
    const rug=this.cylinder(rugGroup,1,1,.018,this.material(p.rug,{roughness:1}),2.03,.012,.60,96);rug.scale.set(1.60,1,1.18);rug.castShadow=false;
    // Low, upholstered lounge chair on a visible solid wood frame.
    const chair=new THREE.Group();chair.position.set(2.13,0,.42);chair.rotation.y=-.32;chair.scale.setScalar(.95);chairGroup.add(chair);
    this.contact(chairGroup,2.18,.73,2.55,2.35,1.0);
    for(const xx of [-.64,.64])for(const zz of [-.39,.65]){
      const leg=this.cylinder(chair,.045,.035,.59,this.wood,xx,.30,zz,20);leg.rotation.z=-xx*.12;leg.rotation.x=zz*.12;
    }
    this.box(chair,1.45,.10,1.24,this.wood,0,.55,.13,.025);
    this.box(chair,1.26,.27,1.12,this.fabric,0,.735,.20,.11);
    const back=this.box(chair,1.39,1.12,.32,this.fabric,0,1.24,-.35,.13);back.rotation.x=-.17;
    const cushion=this.box(chair,1.08,.74,.155,this.fabric,0,1.27,-.115,.065);cushion.rotation.x=-.20;
    const seam=this.material(p.fabric,{roughness:1});seam.color.multiplyScalar(this.theme==='glass'?.93:.85);
    this.box(chair,1.15,.012,.012,seam,0,.795,.764,.005);
    for(const xx of [-.76,.76]){
      this.box(chair,.115,.44,.105,this.wood,xx,.79,.49,.025);
      const arm=this.box(chair,.18,.11,1.19,this.wood,xx,1.035,.04,.048);arm.rotation.x=-.045;
    }
    // A single pedestal table, ceramic cup and a restrained floor light.
    this.contact(tableGroup,.74,1.25,1.32,1.08,.55);
    this.cylinder(tableGroup,.29,.31,.025,this.wood,.70,.025,1.26);
    this.cylinder(tableGroup,.07,.105,.62,this.wood,.70,.35,1.26);
    this.cylinder(tableGroup,.47,.47,.065,this.wood,.70,.685,1.26,64);
    const ceramic=this.material(this.theme==='glass'?'#fafbf8':'#d7ceba',{roughness:this.theme==='glass'?.28:.8});
    this.cylinder(tableGroup,.092,.070,.15,ceramic,.76,.794,1.28,40);
    this.cylinder(tableGroup,.077,.077,.004,this.material('#534035'),.76,.871,1.28,40);
    const handle=new THREE.Mesh(new THREE.TorusGeometry(.062,.014,10,28),ceramic);handle.position.set(.863,.805,1.28);tableGroup.add(handle);
    this.contact(lampGroup,3.39,-.10,1.03,.78,.7);
    this.cylinder(lampGroup,.24,.27,.045,this.metal,3.39,.035,-.10,48);
    this.cylinder(lampGroup,.017,.021,2.39,this.metal,3.39,1.235,-.10,18);
    const shade=this.material(p.print,{side:THREE.DoubleSide,roughness:.94,emissive:new THREE.Color(p.light),emissiveIntensity:.12});
    const lamp=new THREE.Mesh(new THREE.CylinderGeometry(.25,.41,.48,64,1,true),shade);lamp.position.set(3.39,2.5,-.10);lamp.castShadow=true;lampGroup.add(lamp);
    const rim=new THREE.Mesh(new THREE.TorusGeometry(.408,.0045,8,64),this.metal);rim.rotation.x=Math.PI/2;rim.position.set(3.39,2.26,-.1);lampGroup.add(rim);
    const glow=new THREE.PointLight(p.light,4.0,4,2);glow.position.set(3.39,2.27,-.1);lampGroup.add(glow);
    const fx=1.86,fy=2.58,fw=1.12,fh=1.47;
    this.box(artGroup,fw+.065,fh+.065,.060,this.wood,fx,fy,-.951,.013);
    const artwork=new THREE.Mesh(new THREE.PlaneGeometry(fw-.045,fh-.045),new THREE.MeshBasicMaterial({map:this.ownTexture(printTexture(p)),toneMapped:true}));artwork.position.set(fx,fy,-.913);artGroup.add(artwork);
  }

  resize() {
    if(this.destroyed||!this.renderer||this.failed)return;
    const narrow=this.surface.clientWidth<700;
    if(this.books.length&&this.narrow!==narrow){this.narrow=narrow;this.element.classList.toggle('scene-tall',narrow&&this.capacity>6);this.build();}
    const width=this.surface.clientWidth,height=this.surface.clientHeight;if(!width||!height)return;
    if(width===this.width&&height===this.height&&!this.cameraDirty)return;
    if(width!==this.width||height!==this.height)this.renderer.setSize(width,height,false);
    this.width=width;this.height=height;this.updateCamera();this.invalidate();
  }
  updateCamera() {
    if(!this.bounds||!this.width)return;
    const {width,height}=this,aspect=width/height;
    const span=Math.max(this.bounds.height,this.bounds.width/aspect);
    this.camera.left=-span*aspect/2;this.camera.right=span*aspect/2;this.camera.top=span/2;this.camera.bottom=-span/2;
    const angle=.20+this.yaw;
    const target=this.cameraTarget.set(this.bounds.targetX,this.bounds.targetY,.12);
    this.camera.position.set(this.bounds.targetX+Math.sin(angle)*14,this.bounds.targetY+4.15,Math.cos(angle)*14);
    this.camera.lookAt(target);this.camera.updateMatrixWorld();
    // Pan in the camera's own right/up plane so the room follows the cursor at
    // every orbit angle without moving closer to or farther from the furniture.
    const offset=this.cameraOffset.setFromMatrixColumn(this.camera.matrixWorld,0).multiplyScalar(this.panX);
    offset.addScaledVector(this.cameraUp.setFromMatrixColumn(this.camera.matrixWorld,1),this.panY);
    this.camera.position.add(offset);target.add(offset);this.camera.lookAt(target);
    this.camera.zoom=this.zoom;this.camera.updateProjectionMatrix();this.camera.updateMatrixWorld();
    Object.assign(this.element.dataset,{cameraYaw:String(this.yaw),cameraPanX:String(this.panX),cameraPanY:String(this.panY),cameraZoom:String(this.zoom),cameraTargetYaw:String(this.targetYaw),cameraTargetPanX:String(this.targetPanX),cameraTargetPanY:String(this.targetPanY),cameraTargetZoom:String(this.targetZoom)});
    this.cameraDirty=false;this.positionTargets();
  }
  positionTargets() {
    if(!this.camera||!this.width||!this.world)return;
    for(const item of this.items){
      // Project the resting location, not the hover lift, to avoid hit-area jitter.
      // Furniture does not move with the camera; cache its world-space corners
      // and refresh them when a decoded cover changes this row's dimensions.
      if(item.projectedLayout!==item.layoutVersion){
        item.group.parent.updateWorldMatrix(true,false);
        const matrix=this.projectionMatrix.compose(this.projectionPosition.set(item.baseX,item.baseY,item.baseZ),item.restRotation,item.group.scale).premultiply(item.group.parent.matrixWorld);
        for(let i=0;i<4;i++)item.worldCorners[i].set(i===0||i===3?-item.modelWidth/2:item.modelWidth/2,i<2?0:item.modelHeight,item.depth/2+.019).applyMatrix4(matrix);
        item.projectedLayout=item.layoutVersion;
      }
      let left=Infinity,top=Infinity,right=-Infinity,bottom=-Infinity;
      for(const corner of item.worldCorners){
        const point=this.projectionPoint.copy(corner).project(this.camera),x=(point.x+1)/2*this.width,y=(1-point.y)/2*this.height;
        left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
      }
      Object.assign(item.button.style,{left:`${left}px`,top:`${top}px`,width:`${right-left}px`,height:`${bottom-top}px`});
    }
    this.targetsDirty=false;
    this.titleHints?.update();
  }

  invalidate() {if(!this.frame&&!this.destroyed&&!this.failed&&!this.suspended&&this.inView!==false&&!document.hidden&&this.renderer)this.frame=requestAnimationFrame(time=>this.draw(time));}
  draw(time) {
    this.frame=0;if(this.destroyed||this.failed||this.suspended||this.inView===false||document.hidden||!this.bounds)return;
    const dt=Math.min((time-(this.lastTime||time-16))/1000,.06),ease=this.reduced.matches?1:1-Math.exp(-13*dt);this.lastTime=time;
    let moving=false,cameraMoved=false,booksMoved=false;
    for(const [current,target] of [['yaw','targetYaw'],['panX','targetPanX'],['panY','targetPanY'],['zoom','targetZoom']]){
      const distance=this[target]-this[current];
      if(!distance)continue;
      if(Math.abs(distance)>.0001){this[current]+=distance*ease;moving=true;}else this[current]=this[target];
      cameraMoved=true;
    }
    if(cameraMoved||this.cameraDirty)this.updateCamera();else if(this.targetsDirty)this.positionTargets();
    for(const item of this.items){
      const target=this.reduced.matches?0:item.targetLift,previous=item.lift;
      if(Math.abs(item.lift-target)>.001){item.lift+=(target-item.lift)*ease;moving=true;}
      else item.lift=target;
      if(item.lift!==previous){
        item.group.position.y=item.baseY+item.lift*.09;item.group.position.z=item.baseZ+item.lift*.26;item.group.rotation.y=item.baseRotation+item.lift*.10;booksMoved=true;
      }
    }
    // Orbit, pan and zoom only move the camera. The light-space shadow map is
    // unchanged until a book lifts, a cover changes size or the room is rebuilt.
    if(booksMoved)this.renderer.shadowMap.needsUpdate=true;
    this.renderer.render(this.scene,this.camera);this.element.dataset.renderCount=String(++this.frameCount);
    if(moving)this.invalidate();
  }

  useFallback() {
    if(this.destroyed)return;
    this.failed=true;++this.version;cancelAnimationFrame(this.frame);this.frame=0;this.cancelCameraDrag?.();
    this.element.dataset.sceneState='fallback';this.element.dataset.sceneTheme=this.theme;this.element.classList.remove('scene-tall');
    this.element.querySelector('.scene-material').textContent='兼容视图';
    this.element.querySelector('.scene-caption').textContent='当前设备使用封面视图，阅读功能正常可用。';
    this.surface.innerHTML=`<div class="book-grid scene-fallback-grid">${this.books.map(book=>`<div class="book-slot"><button class="book" data-book="${escapeHTML(book.id)}" aria-label="${escapeHTML(book.title)}"><span class="book-face">${book.cover?`<img src="${escapeHTML(book.cover)}" alt="" loading="lazy">`:''}<span class="fallback">${escapeHTML(book.title)}</span></span></button><span class="book-label">${escapeHTML(book.title)}</span></div>`).join('')}</div>`;
    this.element.querySelector('.scene-controls').hidden=true;
    this.renderer?.dispose();this.renderer=null;this.disposeWorld();
    this.coverCache.forEach(texture=>texture.dispose());this.coverCache.clear();
    this.staticTextures.forEach(texture=>texture.dispose());this.staticTextures.clear();this.pumpCovers();
    this.titleHints=bindBookTitles(this.surface);
  }
  dispose() {
    this.destroyed=true;++this.version;cancelAnimationFrame(this.frame);this.cancelCameraDrag?.();this.abort.abort();this.resizeObserver.disconnect();this.intersectionObserver.disconnect();this.disposeWorld();
    this.pumpCovers();this.renderer?.forceContextLoss();
    this.coverCache.forEach(texture=>texture.dispose());this.coverCache.clear();this.coverLoads.clear();
    this.staticTextures.forEach(texture=>texture.dispose());this.staticTextures.clear();this.renderer?.dispose();
  }
}
