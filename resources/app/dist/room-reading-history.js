import { summarizeReadingProgress } from './room-personalization-state.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[letter]));
const date = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '旧记录未保存时间';

export function createReadingHistory({ getState, showModal, dismiss, openBook, readBook }) {
  let query = '', filter = 'all', limit = 40, refresh;
  const changed = () => refresh?.();
  window.addEventListener('reading-visits-updated', changed);
  function open() {
    showModal(`<div class="drawer-top">阅读档案<button class="icon-btn" data-action="dismiss" aria-label="关闭阅读记录">×</button></div>
      <h2>阅读记录</h2><div class="history-summary" aria-live="polite"></div>
      <div class="history-controls"><label>查找读过的书<input type="search" data-history-search value="${esc(query)}" maxlength="1000"></label>
        <label>显示记录<select data-history-filter><option value="all">全部记录</option><option value="reading">阅读中</option><option value="finished">到达末页</option><option value="missing">来源失联</option></select></label></div>
      <p class="path">记录随书籍保存在本地。外部阅读器仅记录打开时间；有页码的记录可以继续阅读。</p>
      <ol class="reading-history-list"></ol><button class="pill-button" data-history-more hidden>显示更多记录</button>`);
    const dialog = document.querySelector('#modal-root [role="dialog"]');
    dialog.classList.add('management-modal');
    dialog.setAttribute('aria-label', '阅读记录');
    dialog.querySelector('[data-history-filter]').value = filter;
    const render = () => {
      if (!dialog.isConnected) return;
      const state = getState(), stats = summarizeReadingProgress(state.books, state.progress, Date.now(), state.visits);
      dialog.querySelector('.history-summary').textContent = `${stats.recorded} 本有记录 · ${stats.reading} 本阅读中 · ${stats.finished} 本到达末页`;
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const records = stats.records.filter(record => (filter === 'all' || filter === 'finished' && record.finished || filter === 'reading' && !record.finished || filter === 'missing' && record.book.exist === false)
        && words.every(word => `${record.book.title_jpn || ''} ${record.book.title || ''}`.toLowerCase().includes(word)));
      const list=dialog.querySelector('.reading-history-list'), focus=list.contains(document.activeElement)?document.activeElement:null;
      const markup = records.slice(0, limit).map(record => {
        const title = record.book.title_jpn || record.book.title || '未命名书籍';
        const position = record.page ? `第 ${record.page} / ${record.total} 页` : '未记录页码';
        return `<li><div><h3>${esc(title)}</h3><p>${position}${record.source === 'external' ? ' · 外部阅读器' : ''}${record.book.exist === false ? ' · 来源失联' : ''}</p><time>${esc(date(record.time))}</time></div>
          <div class="detail-actions">${record.book.exist === false ? '' : `<button class="pill-button primary" data-history-read="${esc(record.id)}">${record.page ? '继续阅读' : '打开阅读'}</button>`}
          <button class="pill-button" data-history-detail="${esc(record.id)}">书籍详情</button></div></li>`;
      }).join('') || '<li class="path">没有符合条件的阅读记录。</li>';
      if (list.innerHTML !== markup) {
        list.innerHTML = markup;
        if (focus) [...list.querySelectorAll('button')].find(button => button.dataset.historyRead === focus.dataset.historyRead && button.dataset.historyDetail === focus.dataset.historyDetail)?.focus({preventScroll:true});
      }
      dialog.querySelector('[data-history-more]').hidden = records.length <= limit;
    };
    refresh=render;
    dialog.querySelector('[data-history-search]').oninput = event => { query = event.target.value; limit = 40; render(); };
    dialog.querySelector('[data-history-filter]').onchange = event => { filter = event.target.value; limit = 40; render(); };
    dialog.querySelector('[data-history-more]').onclick = () => { limit += 40; render(); };
    dialog.addEventListener('click', event => {
      const button = event.target.closest('[data-history-read],[data-history-detail]');
      if (!button) return;
      const id = button.dataset.historyRead || button.dataset.historyDetail;
      dismiss();
      if (button.dataset.historyRead) readBook(id, open);
      else openBook(id);
    });
    render();
    dialog.querySelector('[data-history-search]').focus();
  }
  return { open, dispose() { window.removeEventListener('reading-visits-updated', changed);refresh=null; } };
}
