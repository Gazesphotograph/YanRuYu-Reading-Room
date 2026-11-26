const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[letter]));
const sourceOptions = [['exhentai', 'ExHentai · 页面哈希'], ['e-hentai', 'E-Hentai · 页面哈希'], ['exsearch', 'ExHentai · 书名'], ['e-search', 'E-Hentai · 书名'], ['hentag', 'Hentag · 书名'], ['.ehviewer', '本地 .ehviewer']];
const fieldNames = { title:'书名', title_jpn:'原文书名', tags:'作者与标签', category:'分类', rating:'评分', posted:'发布日期', filecount:'来源页数', filesize:'来源大小', url:'来源链接' };
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');
function valueText(field, value) {
  if (value == null || value === '') return '未填写';
  if (field === 'tags') return Object.entries(value).map(([group, names]) => `${group}: ${Array.isArray(names) ? names.join('、') : names}`).join('\n') || '无标签';
  if (field === 'posted' && Number.isFinite(Number(value))) return new Date(Number(value) * 1000).toLocaleDateString('zh-CN');
  return String(value);
}

export function createMetadataUI({ invoke, getState, showModal, dismiss, openBook, onSaved, toast }) {
  let currentBook = '', dialog, generation = 0;
  const status = (instance, text) => { if (instance.isConnected) instance.querySelector('[data-metadata-status]').textContent = text; };
  function renderPreview(instance, preview) {
    if (!instance.isConnected) return;
    const result = instance.querySelector('[data-metadata-results]');
    result.innerHTML = `<h3>应用前预览</h3><p class="path">勾选需要采用的字段。页数与封面仍以本地文件为准。</p>
      <form data-metadata-apply><div class="metadata-preview">${preview.changes.map(change => `<label class="metadata-change"><span><input type="checkbox" name="field" value="${esc(change.field)}" checked> ${esc(fieldNames[change.field] || change.field)}</span>
        <span><small>当前</small><span>${esc(valueText(change.field, change.before))}</span></span><span><small>来源</small><span>${esc(valueText(change.field, change.after))}</span></span></label>`).join('')}</div>
        <div class="detail-actions">${preview.changes.length ? '<button class="pill-button primary" type="submit">应用所选字段</button>' : ''}
        <button class="pill-button" type="button" data-metadata-back>返回书籍详情</button></div></form>`;
    status(instance, preview.changes.length ? '拉取完成，请核对字段后应用。' : '来源数据与当前书籍一致，无需修改。');
    result.querySelector('[data-metadata-back]').onclick = () => openBook(preview.bookId);
    result.querySelector('form').onsubmit = async event => {
      event.preventDefault();
      const form = event.target, button = form.querySelector('[type="submit"]');
      const fields = [...form.querySelectorAll('input:checked')].map(input => input.value);
      if (!fields.length) { status(instance, '请选择至少一个字段。'); return; }
      button.disabled = true;
      try {
        const saved = await invoke('metadata-source-apply', { previewId: preview.previewId, fields });
        onSaved(saved);
        if (instance.isConnected) {
          status(instance, '所选元数据已保存。');
          form.querySelectorAll('input').forEach(input => input.disabled = true);
          button.remove();
        }
        toast('元数据已保存');
      } catch (error) { status(instance, errorText(error)); }
      finally { button.disabled = false; }
    };
    result.scrollIntoView({ block: 'start' });
    result.querySelector('input')?.focus({ preventScroll: true });
  }
  async function previewURL(instance, url) {
    const intent = ++generation, id = currentBook;
    const buttons = instance.querySelectorAll('form button[type="submit"]');
    buttons.forEach(button => button.disabled = true);
    status(instance, '正在拉取元数据，可在任务中心取消。');
    instance.querySelector('[data-metadata-results]').replaceChildren();
    try {
      const preview = await invoke('metadata-source-preview', { bookId: id, url });
      if (intent === generation && instance.isConnected) renderPreview(instance, preview);
    } catch (error) { if (intent === generation) status(instance, errorText(error)); }
    finally { buttons.forEach(button => button.disabled = false); }
  }
  function open(bookId) {
    const book = getState().books.find(item => item.id === bookId);
    if (!book) return;
    currentBook = bookId; generation++;
    const title = book.title_jpn || book.title || '';
    const filename = (book.filepath || '').split(/[\\/]/).pop();
    const query = title === filename && book.type !== 'folder' ? title.replace(/\.(?:zip|cbz|rar|cbr|7z|cb7)$/i, '') : title;
    showModal(`<div class="drawer-top">书籍元数据<button class="icon-btn" data-action="dismiss" aria-label="关闭元数据拉取">×</button></div>
      <h2>拉取元数据</h2><p class="path">${esc(book.title_jpn || book.title)}</p>
      <form class="metadata-search" data-metadata-search><label>来源<select name="source">${sourceOptions.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
        <label>搜索书名<input name="query" value="${esc(query.slice(0, 1000))}" maxlength="1000"></label><button type="submit" class="pill-button">搜索来源</button></form>
      <form class="metadata-link" data-metadata-link><label>画廊或作品链接<input name="url" type="url" value="${esc(book.url || '')}" maxlength="4096" required placeholder="https://exhentai.org/g/…/…/"></label><button type="submit" class="pill-button primary">拉取预览</button></form>
      <div class="detail-actions"><button class="pill-button" data-action="metadata-settings">元数据来源设置</button><button class="pill-button" data-action="tasks">任务中心</button></div>
      <p class="path" role="status" aria-live="polite" data-metadata-status></p><div data-metadata-results></div>`);
    dialog = document.querySelector('#modal-root [role="dialog"]');
    const instance = dialog;
    instance.classList.add('management-modal');
    instance.setAttribute('aria-label', '拉取元数据');
    const search = instance.querySelector('[data-metadata-search]');
    search.elements.source.value = getState().setting.defaultScraper || 'exhentai';
    if (!search.elements.source.value) search.elements.source.value = 'exhentai';
    search.onsubmit = async event => {
      event.preventDefault();
      const intent = ++generation, id = currentBook, submit = search.querySelector('[type="submit"]');
      submit.disabled = true; status(instance, '正在搜索来源…');
      instance.querySelector('[data-metadata-results]').replaceChildren();
      try {
        const results = await invoke('metadata-source-search', { bookId: id, source: search.elements.source.value, query: search.elements.query.value });
        if (intent !== generation || !instance.isConnected) return;
        status(instance, results.length ? `找到 ${results.length} 个结果，选择作品后预览。` : '没有搜索结果，可以换用书名搜索或填写作品链接。');
        const host = instance.querySelector('[data-metadata-results]');
        host.innerHTML = `<ul class="metadata-results">${results.map((result, index) => `<li><button class="pill-button" data-metadata-result="${index}">${esc(result.title)}</button></li>`).join('')}</ul>`;
        host.querySelectorAll('[data-metadata-result]').forEach(button => button.onclick = () => {
          const url = results[Number(button.dataset.metadataResult)].url;
          instance.querySelector('[data-metadata-link]').elements.url.value = url;
          previewURL(instance, url);
        });
      } catch (error) { if (intent === generation) status(instance, errorText(error)); }
      finally { submit.disabled = false; }
    };
    instance.querySelector('[data-metadata-link]').onsubmit = event => { event.preventDefault(); previewURL(instance, event.target.elements.url.value); };
  }
  function batch() {
    currentBook = ''; generation++;
    const { books, setting } = getState();
    const visible = books.filter(book => !book.hiddenBook);
    const missing = visible.filter(book => book.status !== 'tagged').length;
    showModal(`<div class="drawer-top">书库管理<button class="icon-btn" data-action="dismiss" aria-label="关闭批量拉取">×</button></div>
      <h2>批量拉取元数据</h2><form class="source-settings">
      <label>拉取范围<select name="scope"><option value="missing">仅未标记书籍（${missing} 本）</option><option value="all">全部可见藏书（${visible.length} 本）</option></select></label>
      <label>搜索来源<select name="source">${sourceOptions.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
      <p class="path">按整个书库处理，优先使用书籍已有的来源链接。搜索到唯一作品时自动保存书名、标签等来源字段。多个候选会列在任务明细中。</p>
      <p class="path" data-batch-overwrite hidden>全库刷新会用来源字段更新已标记书籍，包括手动编辑过的书名和标签。</p>
      <p class="path" role="status" data-metadata-status></p><div class="detail-actions"><button type="submit" class="pill-button primary">开始批量拉取</button></div></form>`);
    const instance = document.querySelector('#modal-root [role="dialog"]');
    instance.classList.add('management-modal');
    instance.setAttribute('aria-label', '批量拉取元数据');
    const form = instance.querySelector('form'), submit = form.querySelector('[type="submit"]');
    form.elements.source.value = sourceOptions.some(([id]) => id === setting.defaultScraper) ? setting.defaultScraper : 'exhentai';
    const update = () => {
      const all = form.elements.scope.value === 'all';
      form.querySelector('[data-batch-overwrite]').hidden = !all;
      submit.disabled = !(all ? visible.length : missing);
    };
    form.elements.scope.onchange = update;
    update();
    form.onsubmit = async event => {
      event.preventDefault();
      if (submit.disabled) return;
      submit.disabled = true;
      try {
        await invoke('task-start', 'metadata-batch', { scope:form.elements.scope.value, source:form.elements.source.value });
        if (instance.isConnected) { dismiss(); await window.YanruyuTasks.open(); }
      } catch (error) { status(instance, errorText(error)); }
      finally { update(); }
    };
  }
  function settings() {
    const setting = getState().setting;
    showModal(`<div class="drawer-top">设置<button class="icon-btn" data-action="dismiss" aria-label="关闭元数据来源设置">×</button></div><h2>元数据来源设置</h2>
      <form class="source-settings"><label>默认来源<select name="defaultScraper">${sourceOptions.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label>
        <label>HTTP 或 HTTPS 代理<input name="proxy" value="${esc(setting.proxy || '')}" placeholder="http://127.0.0.1:7890" autocomplete="off"></label>
        <label>请求间隔（毫秒）<input type="number" name="requireGap" min="0" max="60000" step="100" value="${Number.isSafeInteger(setting.requireGap)?setting.requireGap:3000}"></label>
        <fieldset><legend>ExHentai 登录 Cookie</legend>${['ipb_member_id','ipb_pass_hash','igneous','star'].map(key => `<label>${key}<input type="password" name="${key}" value="${esc(setting[key] || '')}" autocomplete="off"></label>`).join('')}</fieldset>
        <p class="path">分别填写 Cookie 的值。设置保存在本机，用于后续拉取。</p><p class="path" role="status" data-metadata-status></p>
        <div class="detail-actions"><button class="pill-button primary" type="submit">保存来源设置</button>${currentBook ? '<button class="pill-button" type="button" data-metadata-return>返回拉取</button>' : ''}</div></form>`);
    const instance = document.querySelector('#modal-root [role="dialog"]'), form = instance.querySelector('form');
    instance.classList.add('management-modal');
    instance.setAttribute('aria-label', '元数据来源设置');
    form.elements.defaultScraper.value = setting.defaultScraper || 'exhentai';
    form.querySelector('[data-metadata-return]')?.addEventListener('click', () => open(currentBook));
    form.onsubmit = async event => {
      event.preventDefault();
      const patch = Object.fromEntries(new FormData(form)); patch.requireGap = Number(patch.requireGap);
      const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
      try {
        getState().setting = await invoke('metadata-source-save-settings', patch);
        status(instance, '来源设置已保存。');
      } catch (error) { status(instance, errorText(error)); }
      finally { submit.disabled = false; }
    };
  }
  const fromTask = async event => {
    const { bookId, previewId } = event.detail || {};
    open(bookId);
    if (!previewId) return;
    const instance = dialog, intent = generation;
    if (!instance?.isConnected) return;
    try {
      const preview = await invoke('metadata-source-get-preview', previewId);
      if (intent === generation) renderPreview(instance, preview);
    } catch (error) { if (intent === generation) status(instance, errorText(error)); }
  };
  window.addEventListener('yanruyu-metadata-preview', fromTask);
  return { open, batch, settings, dispose() { window.removeEventListener('yanruyu-metadata-preview', fromTask); } };
}
