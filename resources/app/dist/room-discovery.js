import { bookTags, bookTitle } from './room-library.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[letter]));
const normalize = value => String(value || '').normalize('NFKC').toLocaleLowerCase('en-US').replace(/\s+/gu, ' ').trim();
const originalSearch = new WeakMap();
const kinds = { author: '作者', series: '系列' };
const bytes = value => value < 1024 ? `${value || 0} B` : value < 1048576 ? `${(value / 1024).toFixed(1)} KiB` : `${(value / 1048576).toFixed(1)} MiB`;
const selected = value => value ? ' selected' : '';

// Call after constructing LibraryIndex and after a saved alias change. Only the
// in-memory search document changes; book metadata and original tag keys stay intact.
export function applyDiscoveryAliases(index, aliases = []) {
  if (!index?.metadata || !Array.isArray(index.books)) return index;
  const maps = { author: new Map(), series: new Map() };
  for (const rule of Array.isArray(aliases) ? aliases : []) {
    if (!maps[rule.kind] || typeof rule.canonical !== 'string' || !Array.isArray(rule.aliases)) continue;
    for (const name of [rule.canonical, ...rule.aliases]) maps[rule.kind].set(normalize(name), rule);
  }
  for (const book of index.books) {
    const metadata = index.metadata.get(book.id); if (!metadata) continue;
    if (!originalSearch.has(metadata)) originalSearch.set(metadata, metadata.search);
    const names = [];
    const tags = bookTags(book);
    if (typeof book.author === 'string') tags.push({ group: 'artist', value: book.author });
    if (typeof book.series === 'string') tags.push({ group: 'series', value: book.series });
    for (const tag of tags) {
      const kind = tag.group === 'artist' ? 'author' : ['parody', 'series'].includes(tag.group) ? 'series' : '';
      const rule = kind && maps[kind].get(normalize(tag.value));
      if (rule) names.push(rule.canonical, ...rule.aliases);
    }
    const added = [...new Set(names)].join(' ');
    metadata.search = `${originalSearch.get(metadata)} ${added.toLocaleLowerCase()} ${normalize(added)}`.trim();
  }
  return index;
}

function ensureStyles() {
  if (document.querySelector('link[data-discovery-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('./room-discovery.css', import.meta.url).href;
  link.dataset.discoveryStyle = ''; document.head.append(link);
}

export function createDiscoveryUI({ invoke, getBooks, openBook = () => {}, openReader = () => {}, toast = () => {}, onAliasesChanged = () => {} }) {
  if (typeof invoke !== 'function' || typeof getBooks !== 'function') throw new Error('本地发现需要书库和桌面接口');
  let dialog = null, request = 0, busy = false;
  const state = { tab: 'search', bookId: '', bookFilter: '', status: null, ocr: null, query: '', mode: 'all', results: null,
    recommendations: null, message: '', error: '', preview: null,
    aliasDraft: { id: '', kind: 'author', canonical: '', aliases: '' },
    textDraft: { page: 1, text: '', source: 'manual', language: '' } };
  const command = payload => invoke('local-search-command', payload);
  const books = () => (getBooks() || []).filter(book => book && !book.hiddenBook);
  const book = () => books().find(item => item.id === state.bookId);
  const qs = selector => dialog?.querySelector(selector);

  function takeStatus(value, notifyAliases = false) {
    if (!value || !Array.isArray(value.aliases) || !Array.isArray(value.texts)) throw new Error('暂时无法读取本地检索状态，请重新打开面板');
    state.status = value;
    if (notifyAliases) onAliasesChanged(value.aliases);
  }
  function setError(error) {
    state.error = String(error?.message || error); state.message = '';
    const el = qs('[data-discovery-notice]'); if (el) { el.textContent = state.error; el.dataset.error = 'true'; }
  }
  function setMessage(message) {
    state.message = message; state.error = '';
    const el = qs('[data-discovery-notice]'); if (el) { el.textContent = message; el.dataset.error = 'false'; }
  }
  async function perform(message, task) {
    if (busy || !dialog?.open) return;
    busy = true; const instance = dialog;
    const controls = [...dialog.querySelectorAll('button:not([data-discovery-close]),input,select,textarea')].map(element => [element, element.disabled]);
    controls.forEach(([element]) => { element.disabled = true; });
    setMessage(message);
    try { await task(instance); }
    catch (error) { if (dialog === instance && instance.open) setError(error); }
    finally { busy = false; controls.forEach(([element, disabled]) => { if (element.isConnected) element.disabled = disabled; }); updateOcrControls(); }
  }

  function updateOcrControls() {
    const language = qs('[data-discovery-text] [name="language"]'), button = qs('[data-discovery-action="ocr-image"]');
    if (!language || !button || !state.ocr) return;
    const available = state.ocr.available === true;
    language.innerHTML = '<option value="">系统首选语言</option>' + (state.ocr.languages || []).map(item =>
      `<option value="${esc(item.tag)}"${selected(state.textDraft.language === item.tag)}>${esc(item.name || item.tag)}</option>`).join('');
    language.disabled = !available || busy; button.disabled = !available || busy;
    qs('[data-discovery-ocr-capability]').textContent = available
      ? '系统 OCR 可用 · 单图最多 20 MiB、4000 万像素 · 识别最长 35 秒 · 无模型下载'
      : `系统 OCR 暂不可用：${state.ocr.reason || '未安装可用的识别语言'}。可以继续粘贴文本。`;
  }

  function bookPicker() {
    const available = books(), needle = normalize(state.bookFilter);
    const matched = available.filter(item => !needle || normalize(bookTitle(item)).includes(needle));
    const shown = matched.slice(0, 200), chosen = available.find(item => item.id === state.bookId);
    if (chosen && !shown.some(item => item.id === chosen.id)) shown.unshift(chosen);
    return `<div class="discovery-book-picker"><label>查找书籍<input data-discovery-book-filter type="search" placeholder="输入书名缩小范围" value="${esc(state.bookFilter)}"></label><label>当前书籍<select data-discovery-book-select aria-label="当前书籍"><option value="">请选择书籍</option>${shown.map(item => `<option value="${esc(item.id)}"${selected(item.id === state.bookId)}>${esc(bookTitle(item))}</option>`).join('')}</select></label></div>${matched.length > 200 ? '<p class="discovery-note">最多显示前 200 本，请输入书名查找。</p>' : ''}`;
  }

  function costsMarkup() {
    const value = state.status;
    if (!value) return '';
    return `<section class="discovery-index" aria-label="文本索引状态"><div class="discovery-index-title"><strong>${value.paused ? '文本索引已暂停' : value.pendingPages ? '正在建立文本索引' : '文本索引就绪'}</strong><span>${esc(value.indexedPages)} / ${esc(value.savedPages)} 页</span></div><progress max="${Math.max(1, value.savedPages)}" value="${value.indexedPages}" aria-label="文本索引进度"></progress><dl><div><dt>已保存文本</dt><dd>${bytes(value.textBytes)} / 8 MiB</dd></div><div><dt>索引内存估算</dt><dd>${bytes(value.estimatedIndexBytes)}</dd></div><div><dt>本次建索引耗时</dt><dd>${esc(value.buildMilliseconds)} ms</dd></div><div><dt>模型下载 / 内容上传</dt><dd>0 B / 0 次</dd></div></dl><div class="discovery-actions"><button type="button" data-discovery-action="${value.paused ? 'resume' : 'pause'}">${value.paused ? '继续索引' : '暂停索引'}</button><button type="button" data-discovery-action="refresh-status">刷新状态</button><button type="button" data-discovery-action="clear-index">清空索引</button></div><p class="discovery-note">清空索引会暂停检索建档，保留已导入文本；点击“继续索引”可重建。最多保存 500 页，每页 30000 字符。</p>${value.truncatedPages ? `<p class="discovery-note">${esc(value.truncatedPages)} 页达到每页 ${esc(value.limits.termsPerPage)} 个词项的上限，部分后续词项未纳入索引。</p>` : ''}</section>`;
  }

  function resultsMarkup(result, similar = false) {
    if (!result) return `<p class="discovery-empty">${similar ? '选择一本书，查看相似的本地藏书。' : '搜索书名、作者、系列别名，或已导入的页内文字。'}</p>`;
    return `<p class="discovery-result-count" role="status">共 ${esc(result.total)} 本${result.total > result.results.length ? `，显示前 ${result.results.length} 本` : ''}</p>${result.results.length ? `<div class="discovery-results">${result.results.map(item => `<article class="discovery-result"><div class="discovery-result-head"><h3>${esc(item.title)}</h3>${item.missing ? '<span>文件失联</span>' : ''}</div><ul class="discovery-reasons" aria-label="${similar ? '推荐理由' : '匹配原因'}">${item.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>${(item.matches || []).map(match => `<blockquote><span>第 ${esc(match.page)} 页</span><p>${esc(match.snippet)}</p></blockquote>`).join('')}<div class="discovery-actions"><button type="button" data-discovery-open-book="${esc(item.bookId)}">查看书籍</button>${!similar && item.page && !item.missing ? `<button type="button" data-discovery-read-book="${esc(item.bookId)}" data-discovery-page="${esc(item.page)}">阅读第 ${esc(item.page)} 页</button>` : ''}</div></article>`).join('')}</div>` : `<p class="discovery-empty">${similar ? '暂无足够的共同作者、系列或标签。补充元数据或别名后再试。' : '没有找到匹配内容。文本检索仅覆盖已导入并完成索引的页面。'}</p>`}<p class="discovery-note">${esc(result.method)}</p>`;
  }

  function searchMarkup() {
    return `<section aria-labelledby="discovery-search-title"><h3 id="discovery-search-title">找回书名，也找回某一页。</h3><form data-discovery-search class="discovery-search-form"><label class="discovery-grow">检索内容<input name="query" type="search" required maxlength="500" placeholder="作者别名、系列名、页内文字…" value="${esc(state.query)}"></label><label>范围<select name="mode"><option value="all"${selected(state.mode === 'all')}>书目信息与文本</option><option value="metadata"${selected(state.mode === 'metadata')}>书目信息与别名</option><option value="text"${selected(state.mode === 'text')}>已导入文本</option></select></label><button class="discovery-primary" type="submit">检索</button></form><div data-discovery-results>${resultsMarkup(state.results)}</div>${state.status?.paused ? '<p class="discovery-note">索引已暂停：仍可检索已完成索引的页面；新文本需继续索引后才能查到。</p>' : ''}</section>`;
  }

  function aliasesMarkup() {
    const draft = state.aliasDraft, rules = state.status?.aliases || [];
    return `<section aria-labelledby="discovery-alias-title"><h3 id="discovery-alias-title">让同一作者与系列，用熟悉的名字相遇。</h3><p class="discovery-note">别名同时用于书架搜索和相似推荐。保存前会展示影响范围，原书名、标签和作者字段保持原样。系列对应书库的“原作 / 系列”标签。</p><form data-discovery-alias class="discovery-form"><div class="discovery-two-columns"><label>类型<select name="kind"><option value="author"${selected(draft.kind === 'author')}>作者</option><option value="series"${selected(draft.kind === 'series')}>系列</option></select></label><label>标准名称<input name="canonical" required maxlength="120" value="${esc(draft.canonical)}" placeholder="例如：林间笔记"></label></div><label>其他写法<textarea name="aliases" rows="3" maxlength="2500" required placeholder="每行一个，例如英文名、译名或旧名">${esc(draft.aliases)}</textarea></label><div class="discovery-actions"><button type="submit" class="discovery-primary">${draft.id ? '预览别名修改' : '预览新增别名'}</button>${draft.id ? '<button type="button" data-discovery-action="reset-alias">取消编辑</button>' : ''}</div></form><div data-discovery-preview></div><div class="discovery-alias-list">${rules.map(rule => `<article><div><span class="discovery-badge">${kinds[rule.kind]}</span><strong>${esc(rule.canonical)}</strong><p>${rule.aliases.map(esc).join(' · ')}</p></div><div class="discovery-actions"><button type="button" data-discovery-edit-alias="${esc(rule.id)}">编辑</button><button type="button" data-discovery-delete-alias="${esc(rule.id)}">删除规则</button></div></article>`).join('') || '<p class="discovery-empty">尚未保存别名。</p>'}</div></section>`;
  }

  function textMarkup() {
    const draft = state.textDraft, selectedBook = book(), pages = state.status?.texts.filter(entry => entry.bookId === state.bookId) || [];
    const available = state.ocr?.available;
    return `<section aria-labelledby="discovery-text-title"><h3 id="discovery-text-title">把需要检索的页面，留在本机。</h3><p class="discovery-note">这是小样本内容检索：粘贴文本，或选一张图片交给 Windows 系统识别，再确认保存。当前按关键词匹配，尚未启用神经语义检索，也不会自动扫描整本图片。</p>${bookPicker()}<form data-discovery-text class="discovery-form"><div class="discovery-two-columns"><label>对应页码<input type="number" name="page" min="1" max="${Number(selectedBook?.pageCount || selectedBook?.filecount) || 1000000}" required value="${esc(draft.page)}"></label><label>系统识别语言<select name="language"${available ? '' : ' disabled'}><option value="">系统首选语言</option>${(state.ocr?.languages || []).map(item => `<option value="${esc(item.tag)}"${selected(draft.language === item.tag)}>${esc(item.name || item.tag)}</option>`).join('')}</select></label></div><div class="discovery-actions"><button type="button" data-discovery-action="ocr-image"${available ? '' : ' disabled'}>从本地图片识别</button></div><p class="discovery-note" data-discovery-ocr-capability>${state.ocr ? available ? '系统 OCR 可用 · 单图最多 20 MiB、4000 万像素 · 识别最长 35 秒 · 无模型下载' : `系统 OCR 暂不可用：${esc(state.ocr.reason || '未安装可用的识别语言')}。可以继续粘贴文本。` : '正在检查系统 OCR 支持…'}</p><label>待保存的页面文字<textarea name="text" rows="8" maxlength="30000" required placeholder="粘贴已有文字，或先识别本地图片；保存前可修正识别错误。">${esc(draft.text)}</textarea></label><div class="discovery-actions"><button type="submit" class="discovery-primary"${selectedBook ? '' : ' disabled'}>预览并保存此页文本</button></div></form><div data-discovery-preview></div>${costsMarkup()}<details class="discovery-saved-texts"><summary>当前书籍已导入 ${pages.length} 页文本</summary>${pages.map(entry => `<div class="discovery-text-row"><span>第 ${entry.page} 页 · ${entry.characters} 字符 · ${entry.source === 'windows-ocr' ? '系统 OCR' : '手动文本'}</span><div class="discovery-actions"><button type="button" data-discovery-edit-text="${entry.page}">查看 / 编辑</button><button type="button" data-discovery-remove-text="${entry.page}" data-discovery-revision="${entry.revision}">移除此页文本</button></div></div>`).join('') || '<p class="discovery-note">选择书籍并保存文本后，会显示在这里。</p>'}</details><button type="button" class="discovery-remove-all" data-discovery-action="confirm-clear-texts">清除全部导入文本…</button></section>`;
  }

  function similarMarkup() {
    return `<section aria-labelledby="discovery-similar-title"><h3 id="discovery-similar-title">从喜欢的一本，找到下一本。</h3>${bookPicker()}<div class="discovery-actions"><button type="button" class="discovery-primary" data-discovery-action="recommend"${state.bookId ? '' : ' disabled'}>查看相似书籍</button></div><div data-discovery-results>${resultsMarkup(state.recommendations, true)}</div></section>`;
  }

  function renderPreview() {
    const host = qs('[data-discovery-preview]'), value = state.preview;
    if (!host) return;
    if (!value) { host.innerHTML = ''; return; }
    let markup = '';
    if (value.kind === 'alias') markup = `<h4>${value.operation === 'delete' ? '删除这组别名' : '确认这组别名'}</h4><p><strong>${esc(value.alias.canonical)}</strong> ↔ ${value.alias.aliases.map(esc).join('、')}</p><p>当前可见书库有 ${value.affectedCount} 本会使用这组检索规则，原始元数据保持原样。</p>${value.affectedBooks.length ? `<ul>${value.affectedBooks.map(item => `<li>${esc(item.title)}</li>`).join('')}</ul>` : ''}<button type="button" class="discovery-primary" data-discovery-action="save-alias">确认${value.operation === 'delete' ? '删除规则' : '保存别名'}</button>`;
    if (value.kind === 'text') markup = `<h4>确认保存此页文本</h4><p>${esc(value.title)} · 第 ${value.page} 页 · ${value.characters} 字符（${bytes(value.bytes)}）</p>${value.replacesExisting ? `<p>将替换此页原有的 ${value.previousCharacters} 字符文本。请确认上方内容已检查。</p>` : '<p>仅将上方文本保存到本地检索档案，漫画图片保持原样。</p>'}<button type="button" class="discovery-primary" data-discovery-action="save-text">确认保存${state.status?.paused ? '，稍后索引' : '并索引'}</button>`;
    if (value.kind === 'remove-text') markup = `<h4>移除第 ${value.page} 页的导入文本</h4><p>该页的文本副本和关键词索引会移除，原始漫画图片不变。</p><button type="button" class="discovery-primary" data-discovery-action="remove-text">确认移除此页文本</button>`;
    if (value.kind === 'clear-texts') markup = `<h4>清除全部导入文本</h4><p>将移除全部书籍中已导入的 ${state.status?.savedPages || 0} 页文本和关键词索引。作者 / 系列别名、书籍及阅读记录保留。需要保留的文本请先完成数据备份。</p><button type="button" class="discovery-primary" data-discovery-action="clear-texts">确认清除全部导入文本</button>`;
    host.innerHTML = `<section class="discovery-preview" aria-label="变更预览">${markup}<button type="button" data-discovery-action="cancel-preview">取消</button></section>`;
  }

  function render() {
    if (!dialog?.open) return;
    for (const element of dialog.querySelectorAll('[data-discovery-tab]')) element.setAttribute('aria-selected', String(element.dataset.discoveryTab === state.tab));
    const content = qs('[data-discovery-content]');
    content.innerHTML = !state.status ? '<p class="discovery-empty">正在读取本地检索档案…</p>' :
      state.tab === 'aliases' ? aliasesMarkup() : state.tab === 'text' ? textMarkup() : state.tab === 'similar' ? similarMarkup() : searchMarkup();
    content.setAttribute('aria-labelledby', `discovery-tab-${state.tab}`);
    renderPreview(); bindForms();
    if (state.error) setError(state.error); else setMessage(state.message);
  }

  function readDraft(form) {
    if (form.matches('[data-discovery-alias]')) state.aliasDraft = { id: state.aliasDraft.id, kind: form.elements.kind.value, canonical: form.elements.canonical.value, aliases: form.elements.aliases.value };
    if (form.matches('[data-discovery-text]')) state.textDraft = { ...state.textDraft, page: Number(form.elements.page.value), text: form.elements.text.value, language: form.elements.language.value };
  }

  function bindForms() {
    const searchForm = qs('[data-discovery-search]');
    const rememberSearch = () => { state.query = searchForm.elements.query.value; state.mode = searchForm.elements.mode.value; };
    searchForm?.addEventListener('input', rememberSearch);
    searchForm?.addEventListener('change', rememberSearch);
    qs('[data-discovery-search]')?.addEventListener('submit', event => {
      event.preventDefault(); const form = event.currentTarget;
      state.query = form.elements.query.value; state.mode = form.elements.mode.value;
      const current = ++request;
      perform('正在检索本地书库…', async instance => {
        const result = await command({ action: 'search', query: state.query, mode: state.mode });
        if (dialog !== instance || request !== current) return;
        state.results = result; setMessage(`检索完成，共 ${result.total} 本。`); render();
      });
    });
    for (const form of dialog.querySelectorAll('[data-discovery-alias],[data-discovery-text]')) {
      form.addEventListener('input', () => { readDraft(form); state.preview = null; renderPreview(); });
      form.addEventListener('change', () => { readDraft(form); state.preview = null; renderPreview(); });
      form.addEventListener('submit', event => {
        event.preventDefault(); readDraft(form);
        perform('正在生成变更预览…', async instance => {
          const isAlias = form.matches('[data-discovery-alias]');
          const payload = isAlias ? { action: 'preview-alias', ...state.aliasDraft, id: state.aliasDraft.id || undefined,
            aliases: state.aliasDraft.aliases.split(/[\n,，;；]+/u).map(value => value.trim()).filter(Boolean) } :
            { action: 'preview-text', bookId: state.bookId, ...state.textDraft };
          const value = await command(payload); if (dialog !== instance) return;
          state.preview = { ...value, kind: isAlias ? 'alias' : 'text' }; setMessage('预览已就绪，请确认影响范围。'); renderPreview();
          qs('.discovery-preview')?.scrollIntoView({ block: 'nearest' });
        });
      });
    }
    qs('[data-discovery-book-filter]')?.addEventListener('input', event => {
      state.bookFilter = event.target.value;
      const position = event.target.selectionStart;
      render(); const input = qs('[data-discovery-book-filter]'); input?.focus();
      try { input?.setSelectionRange(position, position); } catch { /* Search input selection is optional. */ }
    });
    qs('[data-discovery-book-select]')?.addEventListener('change', event => {
      state.bookId = event.target.value; state.preview = null; state.recommendations = null;
      state.textDraft = { page: 1, text: '', source: 'manual', language: state.textDraft.language };
      render();
    });
  }

  async function recommend(instance = dialog) {
    const result = await command({ action: 'recommend', bookId: state.bookId });
    if (dialog !== instance) return;
    state.recommendations = result; setMessage('推荐理由已显示在每本书下方。'); render();
  }

  async function click(event) {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    if (button.hasAttribute('data-discovery-close')) { dialog.close(); return; }
    if (busy) return;
    if (button.dataset.discoveryTab) {
      state.tab = button.dataset.discoveryTab; state.preview = null; state.message = ''; state.error = ''; render();
      if (state.tab === 'similar' && state.bookId) await perform('正在查找共同作者、系列和标签…', recommend);
      return;
    }
    if (button.dataset.discoveryOpenBook) { const id = button.dataset.discoveryOpenBook; dialog.close(); await openBook(id); return; }
    if (button.dataset.discoveryReadBook) { const id = button.dataset.discoveryReadBook, page = Number(button.dataset.discoveryPage); dialog.close(); await openReader(id, page); return; }
    if (button.dataset.discoveryEditAlias) {
      const rule = state.status.aliases.find(item => item.id === button.dataset.discoveryEditAlias); if (!rule) return;
      state.aliasDraft = { ...rule, aliases: rule.aliases.join('\n') }; state.preview = null; render(); qs('[name="canonical"]')?.focus(); return;
    }
    if (button.dataset.discoveryDeleteAlias) {
      await perform('正在预览别名删除范围…', async instance => {
        const result = await command({ action: 'preview-alias', operation: 'delete', id: button.dataset.discoveryDeleteAlias });
        if (dialog !== instance) return; state.preview = { ...result, kind: 'alias' }; renderPreview(); setMessage('请确认删除规则的影响范围。'); qs('.discovery-preview')?.scrollIntoView({ block: 'nearest' });
      }); return;
    }
    if (button.dataset.discoveryEditText) {
      await perform('正在读取本地文本…', async instance => {
        const entry = await command({ action: 'get-text', bookId: state.bookId, page: Number(button.dataset.discoveryEditText) });
        if (dialog !== instance || !entry) return; state.textDraft = entry; state.preview = null; render(); setMessage('已载入这页文本，修改后需再次预览保存。'); qs('[name="text"]')?.focus();
      }); return;
    }
    if (button.dataset.discoveryRemoveText) { state.preview = { kind: 'remove-text', page: Number(button.dataset.discoveryRemoveText), revision: Number(button.dataset.discoveryRevision) }; renderPreview(); qs('.discovery-preview')?.scrollIntoView({ block: 'nearest' }); return; }
    const action = button.dataset.discoveryAction;
    if (!action) return;
    if (action === 'cancel-preview') { state.preview = null; renderPreview(); return; }
    if (action === 'reset-alias') { state.aliasDraft = { id: '', kind: 'author', canonical: '', aliases: '' }; state.preview = null; render(); return; }
    if (action === 'confirm-clear-texts') { state.preview = { kind: 'clear-texts' }; renderPreview(); qs('.discovery-preview')?.scrollIntoView({ block: 'nearest' }); return; }
    if (action === 'recommend') { await perform('正在查找共同作者、系列和标签…', recommend); return; }
    if (action === 'ocr-image') {
      await perform('请选择一张本地图片，系统识别最长等待 35 秒…', async instance => {
        const result = await invoke('local-search-ocr-image', { language: state.textDraft.language });
        if (dialog !== instance) return;
        if (result?.cancelled) { setMessage('已取消图片识别。'); return; }
        if (!result || typeof result.text !== 'string') throw new Error('图片识别没有返回文字');
        state.textDraft = { ...state.textDraft, text: result.text, source: 'windows-ocr', language: result.language || '' }; state.preview = null;
        render(); setMessage(result.text.trim() ? `已识别 ${result.text.length} 字符。请检查文字和对应页码，再预览保存。` : '这张图片没有识别到文字，可以换图或粘贴文本。');
      }); return;
    }
    await perform('正在保存本地检索设置…', async instance => {
      let payload = { action: action === 'refresh-status' ? 'status' : action };
      if (['save-alias', 'save-text'].includes(action)) {
        if (!state.preview?.token) throw new Error('请先生成预览');
        payload.token = state.preview.token;
      }
      if (action === 'clear-texts') { if (state.preview?.kind !== 'clear-texts') return; payload.confirmation = '清除全部导入文本'; }
      if (action === 'remove-text') { if (state.preview?.kind !== 'remove-text') return; payload = { ...payload, bookId: state.bookId, page: state.preview.page, revision: state.preview.revision }; }
      const result = await command(payload); takeStatus(result, action === 'save-alias');
      if (dialog !== instance) return;
      state.preview = null;
      if (action === 'save-alias') state.aliasDraft = { id: '', kind: 'author', canonical: '', aliases: '' };
      if (action === 'save-text') state.textDraft = { page: 1, text: '', source: 'manual', language: state.textDraft.language };
      const messages = { 'save-alias': '别名已保存，书架搜索和相似推荐已更新。', 'save-text': '文本已保存到本机。', pause: '文本索引已暂停。', resume: '已继续建立文本索引。', 'clear-index': '索引已清空并暂停，已导入文本保留。', 'clear-texts': '已清除全部导入文本及索引。', 'remove-text': '已移除此页的导入文本。', 'refresh-status': '索引状态已刷新。' };
      setMessage(messages[action] || '已保存。'); render();
      if (action === 'save-alias') toast('本地别名已更新');
    });
  }

  async function open(options = {}) {
    ensureStyles();
    state.tab = ['search', 'aliases', 'text', 'similar'].includes(options.tab) ? options.tab : 'search';
    if (options.bookId) { state.bookId = options.bookId; state.recommendations = null; }
    state.preview = null; state.error = ''; state.message = '';
    if (dialog?.open) { render(); dialog.focus(); return; }
    dialog = document.createElement('dialog'); const instance = dialog;
    dialog.className = 'discovery-dialog themed-dialog'; dialog.setAttribute('aria-labelledby', 'discovery-title');
    dialog.innerHTML = `<header class="discovery-header"><div><p>LOCAL DISCOVERY</p><h2 id="discovery-title">本地发现</h2></div><button type="button" class="dialog-close" data-discovery-close aria-label="关闭本地发现"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M5 19 19 5"/></svg></button></header><nav class="discovery-tabs" role="tablist" aria-label="本地发现功能">${[['search', '检索'], ['similar', '相似书籍'], ['aliases', '作者 / 系列别名'], ['text', '页内文本 / OCR']].map(([tab, label]) => `<button type="button" role="tab" id="discovery-tab-${tab}" data-discovery-tab="${tab}" aria-selected="${state.tab === tab}">${label}</button>`).join('')}</nav><p class="discovery-notice" role="status" aria-live="polite" data-discovery-notice></p><div class="discovery-content" role="tabpanel" data-discovery-content></div>`;
    dialog.addEventListener('click', event => { click(event).catch(setError); });
    dialog.addEventListener('keydown', event => {
      event.stopPropagation();
      if (event.key === 'Escape' && busy) { event.preventDefault(); setMessage('操作进行中，结果会在本机完成；也可点击“关闭”返回。'); }
      const tab = event.target.closest('[data-discovery-tab]');
      if (tab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); const tabs = [...dialog.querySelectorAll('[data-discovery-tab]')];
        const index = tabs.indexOf(tab), target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowLeft' ? -1 : 1) + tabs.length) % tabs.length;
        tabs[target].focus(); tabs[target].click();
      }
    });
    dialog.addEventListener('close', () => { request++; if (dialog === instance) dialog = null; instance.remove(); });
    document.body.append(dialog); dialog.showModal(); render();
    // System OCR detection can take seconds on a first launch. Its completion
    // must not remount a search/alias/text form the user has already started.
    const statusRequest = command({ action: 'status' }).then(value => ({ value }), error => ({ error }));
    const ocrRequest = command({ action: 'ocr-capability' }).then(value => ({ value }), error => ({ error }));
    const result = await statusRequest;
    if (dialog !== instance) return;
    const firstStatus = !state.status;
    if (result.value) takeStatus(result.value, true); else setError(result.error);
    if (firstStatus) render();
    const ocrResult = await ocrRequest;
    if (dialog !== instance) return;
    state.ocr = ocrResult.value || { available: false, reason: String(ocrResult.error?.message || ocrResult.error), languages: [] };
    updateOcrControls();
    if (state.tab === 'similar' && state.bookId) await perform('正在查找相似藏书…', recommend);
  }

  return { open, async refreshAliases() { takeStatus(await command({ action: 'status' }), true); return state.status.aliases; },
    get aliases() { return state.status?.aliases || []; },
    dispose() { request++; dialog?.close(); dialog = null; } };
}
