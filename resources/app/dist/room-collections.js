const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[letter]));
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function createCollectionUI({ invoke, getState, showModal, onChanged }) {
  async function open(incomingIds = []) {
    showModal(`<div class="drawer-top">书库合集<button class="icon-btn" data-action="dismiss" aria-label="关闭合集管理">×</button></div><h2>管理合集</h2>
      <form class="collection-create"><label>新合集名称<input name="title" required maxlength="200"></label><button class="pill-button" type="submit">创建合集${incomingIds.length ? `并加入所选 ${incomingIds.length} 本` : ''}</button></form>
      <label class="collection-control-label">编辑合集<select data-collection-editor></select></label><div class="collection-editor"></div><p class="path" role="status" data-collection-status>正在载入合集…</p>`);
    const dialog = document.querySelector('#modal-root [role="dialog"]');
    dialog.classList.add('management-modal'); dialog.setAttribute('aria-label', '管理合集');
    const status = text => { if (dialog.isConnected) dialog.querySelector('[data-collection-status]').textContent = text; };
    let data, selected = getState().collectionId, query = '', limit = 60, draft = new Set(), initial = new Set();
    const applyData = result => { data = result; onChanged(result.collections); };
    async function command(params, message) {
      const buttons = [...dialog.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
      try {
        const result = await invoke('collection-command', params);
        applyData(result); selected = result.collectionId || selected;
        if (dialog.isConnected) { render(); status(message); }
      } catch (error) { status(errorText(error)); }
      finally { buttons.forEach(button => button.disabled = false); }
    }
    function renderMembers() {
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      const books = getState().books.filter(book => !book.hiddenBook && words.every(word => `${book.title_jpn || ''} ${book.title || ''}`.toLowerCase().includes(word)));
      dialog.querySelector('.collection-member-list').innerHTML = books.slice(0, limit).map(book => `<label><input type="checkbox" data-collection-book="${esc(book.id)}" ${draft.has(book.id) ? 'checked' : ''}><span>${esc(book.title_jpn || book.title)}</span></label>`).join('') || '<p class="path">没有符合条件的书。</p>';
      dialog.querySelector('[data-collection-more]').hidden = books.length <= limit;
      dialog.querySelector('[data-collection-count]').textContent = `合集含 ${draft.size} 本；当前列表 ${books.length} 本`;
    }
    function render() {
      const select = dialog.querySelector('[data-collection-editor]');
      if (!data.collections.some(collection => collection.id === selected)) selected = data.collections[0]?.id || '';
      select.innerHTML = data.collections.map(collection => `<option value="${esc(collection.id)}">${esc(collection.title)} · ${data.memberships[collection.id].bookIds.length} 本</option>`).join('') || '<option value="">尚无合集</option>';
      select.value = selected;
      const collection = data.collections.find(item => item.id === selected), host = dialog.querySelector('.collection-editor');
      if (!collection) { host.innerHTML = '<p class="path">先创建一个合集，再加入书籍。</p>'; return; }
      initial = new Set(data.memberships[selected].bookIds); draft = new Set(initial); query = ''; limit = 60;
      host.innerHTML = `<form class="collection-rename"><label>合集名称<input name="title" value="${esc(collection.title)}" required maxlength="200"></label><button class="pill-button" type="submit">保存名称</button><button class="pill-button" type="button" data-collection-remove>删除合集</button></form>
        ${incomingIds.length ? `<button class="pill-button primary" data-collection-add>将所选 ${incomingIds.length} 本加入此合集</button>` : ''}
        <label class="collection-control-label">查找成员<input type="search" data-collection-search maxlength="1000"></label><p class="path" data-collection-count></p>
        <div class="collection-member-list" role="group" aria-label="合集成员"></div>
        <div class="detail-actions"><button class="pill-button" data-collection-more hidden>显示更多书籍</button><button class="pill-button primary" data-collection-save>保存成员变更</button></div>
        ${data.memberships[selected].unresolved.length ? `<p class="path">${data.memberships[selected].unresolved.length} 个旧引用暂未匹配到书籍，将继续保留。</p>` : ''}`;
      host.querySelector('form').onsubmit = event => { event.preventDefault(); command({ action:'rename', collectionId:selected, title:event.target.elements.title.value }, '合集名称已保存。'); };
      host.querySelector('[data-collection-remove]').onclick = () => {
        const remove = host.querySelector('[data-collection-remove]');
        if (!host.querySelector('[data-collection-confirm-remove]')) {
          remove.insertAdjacentHTML('afterend', '<button type="button" class="pill-button" data-collection-confirm-remove>确认删除合集</button>');
          status('删除合集会移除这个分组，书籍、原文件和阅读记录仍保留。');
          host.querySelector('[data-collection-confirm-remove]').onclick = () => command({ action:'remove', collectionId:selected }, '合集已删除。');
        }
      };
      host.querySelector('[data-collection-add]')?.addEventListener('click', () => command({ action:'members', collectionId:selected, addBookIds:incomingIds }, '所选书籍已加入合集。'));
      host.querySelector('[data-collection-search]').oninput = event => { query = event.target.value; limit = 60; renderMembers(); };
      host.querySelector('[data-collection-more]').onclick = () => { limit += 60; renderMembers(); };
      host.querySelector('.collection-member-list').onchange = event => {
        if (!event.target.dataset.collectionBook) return;
        event.target.checked ? draft.add(event.target.dataset.collectionBook) : draft.delete(event.target.dataset.collectionBook);
        host.querySelector('[data-collection-count]').textContent = `合集含 ${draft.size} 本；成员变更尚未保存`;
      };
      host.querySelector('[data-collection-save]').onclick = () => command({ action:'members', collectionId:selected,
        addBookIds:[...draft].filter(id => !initial.has(id)), removeBookIds:[...initial].filter(id => !draft.has(id)) }, '合集成员已保存。');
      renderMembers();
    }
    dialog.querySelector('.collection-create').onsubmit = event => {
      event.preventDefault(); command({ action:'create', title:event.target.elements.title.value, bookIds:incomingIds }, '合集已创建。');
    };
    dialog.querySelector('[data-collection-editor]').onchange = event => { selected = event.target.value; render(); };
    try { data = await invoke('collection-command', { action:'list' }); if (dialog.isConnected) { render(); status('勾选或取消成员后，点击“保存成员变更”。'); } }
    catch (error) { status(errorText(error)); }
  }
  return { open };
}
