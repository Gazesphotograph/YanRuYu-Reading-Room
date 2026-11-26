const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
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
