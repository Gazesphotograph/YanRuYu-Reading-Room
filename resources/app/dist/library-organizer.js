// UI for the main-process preview/commit/undo service. All user-controlled text
// is escaped; apply receives an opaque server preview token, never edited rows.
const invoke = (channel, ...args) => window.ipcRenderer.invoke(channel, ...args);
const esc = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const labels = { title:'书名', title_jpn:'显示书名', category:'分类', rating:'评分', mark:'收藏', hiddenBook:'隐藏来源副本', readCount:'阅读次数', tags:'作者与标签', status:'元数据状态', filecount:'记录页数', posted:'发布时间', filesize:'记录大小', url:'来源链接' };
const groups = { artist:'作者', group:'社团', parody:'原作 / 系列', character:'角色', language:'语言', male:'男性', female:'女性', mixed:'混合', other:'其他', misc:'其他', cosplayer:'角色扮演者' };
const healthLabels = { missing: '已确认缺失', unavailable: '暂不可访问', invalid: '路径类型异常' };
const canRemoveMissing = book => book.canRemove === true && ['missing', 'unavailable'].includes(book.status);
let active;

function styles() {
  if (document.querySelector('[data-library-organizer-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./library-organizer.css', import.meta.url).href;
  link.dataset.libraryOrganizerStyle = ''; document.head.append(link);
}
const progressLabel = value => value ? `第 ${value.page} / ${value.total} 页` : '暂无阅读进度';
function fieldValue(key, value) {
  if (key === 'tags') return Object.entries(value || {}).map(([group, values]) => `${groups[group] || group}：${(Array.isArray(values) ? values : [values]).join('、')}`).join('\n') || '无标签';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return value == null || value === '' ? '未填写' : String(value);
}
function fieldsTable(before, after, { changedOnly = false } = {}) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !changedOnly || JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  return `<div class="organizer-table-wrap"><table><thead><tr><th>项目</th><th>当前</th><th>应用后</th></tr></thead><tbody>${keys.map(key => `<tr><th>${esc(labels[key] || key)}</th><td>${esc(fieldValue(key, before[key]))}</td><td>${esc(fieldValue(key, after[key]))}</td></tr>`).join('')}</tbody></table></div>`;
}
const sourceTitle = book => `${book.originalTitle && book.title !== book.originalTitle ? '显示书名：' : ''}${esc(book.title)}`;
function sourceDetails(book) {
  const filename = String(book.filepath ?? '').replace(/[\\/]+$/, '').split(/[\\/]/).pop();
  const originalTitle = book.originalTitle && book.title !== book.originalTitle
    ? `<p class="organizer-note organizer-path" data-original-title>书名：${esc(book.originalTitle)}</p>` : '';
  return `${originalTitle}<p class="organizer-note organizer-path" data-source-name>${book.type === 'folder' ? '文件夹名' : '文件名'}：${esc(filename)}</p>`;
}
function sourceCard(book, label) {
  return `<article class="organizer-source"><strong>${esc(label)} · ${sourceTitle(book)}</strong>${sourceDetails(book)}<p>${book.pageCount || '未知'} 页 · ${esc(progressLabel(book.progress))}${book.hiddenBook ? ' · 原本已隐藏' : ''}</p><p class="organizer-path" data-source-path>${esc(book.filepath)}</p><small>书籍标识：${esc(book.id)}</small></article>`;
}

async function syncReading() {
  const profile = window.readingState;
  if (!profile?.progress) return;
  const snapshot = await invoke('load-reading-state');
  for (const id of Object.keys(profile.progress)) if (!profile.pending?.has(id) && !snapshot.progress[id]) delete profile.progress[id];
  for (const [id, value] of Object.entries(snapshot.progress)) if (!profile.pending?.has(id)) profile.progress[id] = value;
  profile.mirror?.();
}

function buildDialog(initialIds) {
  const dialog = document.createElement('dialog'); dialog.className = 'library-organizer-dialog themed-dialog'; dialog.setAttribute('aria-labelledby', 'organizer-title');
  dialog.innerHTML = `<header><div><h2 id="organizer-title">书库整理</h2><p>先查看变化，再应用。每次整理都有可撤销记录。</p></div><button type="button" class="dialog-close" data-organizer="close" aria-label="关闭书库整理"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M5 19 19 5"/></svg></button></header>
    <nav class="organizer-tabs" role="tablist" aria-label="书库整理功能"><button type="button" role="tab" aria-selected="true" aria-controls="organizer-batch" data-tab="batch">批量编辑与合并</button><button type="button" role="tab" aria-selected="false" aria-controls="organizer-health" data-tab="health">缺失文件</button><button type="button" role="tab" aria-selected="false" aria-controls="organizer-duplicates" data-tab="duplicates">疑似重复</button><button type="button" role="tab" aria-selected="false" aria-controls="organizer-history" data-tab="history">整理历史</button></nav>
    <p class="organizer-status" role="status" aria-live="polite"></p><div class="organizer-content">
    <section id="organizer-batch" role="tabpanel" data-panel="batch"><div class="organizer-workspace"><div class="organizer-selection"><h3>选择书籍 <span data-selected-count>0</span></h3><label class="organizer-search"><span>查找书名、作者、标签或路径</span><input type="search" data-search placeholder="输入关键词…" autocomplete="off"></label><label class="organizer-check"><input type="checkbox" data-include-hidden>显示隐藏书籍与合并来源</label><div class="organizer-actions"><button type="button" data-organizer="select-results">选择筛选结果</button><button type="button" data-organizer="clear-selection">清空选择</button></div><div class="organizer-book-list" role="group" aria-label="选择待整理书籍"></div><div class="organizer-paging"><button type="button" data-organizer="previous">上一页</button><span data-page-label></span><button type="button" data-organizer="next">下一页</button></div></div>
    <div class="organizer-editing"><section class="organizer-card"><h3>修改作者与标签</h3><div class="organizer-form-row"><label>标签分组<select data-edit-namespace>${Object.entries(groups).map(([key, label]) => `<option value="${key}">${label}</option>`).join('')}</select></label><label>修改方式<select data-edit-mode><option value="add">添加</option><option value="remove">移除指定标签</option><option value="replace">替换整组标签</option><option value="rename">改正一个名称</option></select></label></div><label data-old-label hidden>原名称<input data-edit-from placeholder="需要改正的完整标签名称"></label><label>新内容<textarea data-edit-values rows="2" placeholder="每行一个名称，也可用中文逗号分隔"></textarea></label><p class="organizer-note" data-edit-note>只改变所选分组，其他标签保持原样。</p><button type="button" class="organizer-primary" data-organizer="preview-tags">预览作者 / 标签修改</button></section>
    <details class="organizer-card"><summary>编辑书目信息</summary><p class="organizer-note">勾选需要修改的字段。书名一次编辑一本，分类、评分和收藏支持批量。</p><div class="organizer-meta-fields">${[['title','书名','text'],['title_jpn','显示书名','text'],['category','分类','text'],['rating','评分（0–5）','number']].map(([key, label, type]) => `<label><span><input type="checkbox" data-field-enabled="${key}">${label}</span><input type="${type}" data-field="${key}" ${key === 'rating' ? 'min="0" max="5" step="0.5"' : ''} aria-label="新的${label}"></label>`).join('')}<label><span><input type="checkbox" data-field-enabled="mark">收藏状态</span><select data-field="mark" aria-label="新的收藏状态"><option value="true">加入收藏</option><option value="false">取消收藏</option></select></label></div><button type="button" data-organizer="preview-fields">预览书目信息修改</button></details>
    <details class="organizer-card" data-merge-card><summary>合并所选书籍的书架展示</summary><p class="organizer-note">保留一本显示在书架，其余隐藏为来源副本。原文件、每本书的标识与阅读档案都保留，可从整理历史撤销。</p><div data-merge-options></div><button type="button" data-organizer="preview-merge">核对完整内容并预览合并</button></details></div></div><div class="organizer-preview" data-preview hidden></div></section>
    <section id="organizer-health" role="tabpanel" data-panel="health" hidden><div class="organizer-section-head"><div><h3>缺失文件报告</h3><p>检查书籍路径，重新定位失联书籍，或选择删除书库中的失联记录。</p></div><button type="button" data-organizer="health">检查书库</button></div><div class="organizer-preview organizer-remove-preview" data-health-preview hidden></div><div data-health-results><p class="organizer-empty">先检查书库，再选择要重新定位或删除的缺失、暂不可访问记录。</p></div></section>
    <section id="organizer-duplicates" role="tabpanel" data-panel="duplicates" hidden><div class="organizer-section-head"><div><h3>疑似重复书</h3><p>依据完整指纹，或书名与页数寻找线索；确认前重新核对文件。</p></div><button type="button" data-organizer="duplicates">查找疑似重复</button></div><div data-duplicate-results><p class="organizer-empty">结果会解释推荐整理的原因。相同封面不会直接判成同一本。</p></div></section>
    <section id="organizer-history" role="tabpanel" data-panel="history" hidden><div class="organizer-section-head"><div><h3>整理历史与撤销</h3><p>撤销前核对数据；后续编辑或新阅读进度发生冲突时会保留新内容。</p></div><button type="button" data-organizer="history">刷新记录</button></div><div data-history-results></div></section></div>`;
  const context = { dialog, selected: new Set(initialIds), missingSelected: new Set(), healthReport: null, books: [], page: 1, preview: null, busy: false, duplicateGroups: [], tab: 'batch' };
  context.status = (message, failure = false) => { const element = dialog.querySelector('.organizer-status'); element.textContent = message; element.dataset.failure = String(failure); };
  context.invalidate = () => { context.preview = null; dialog.querySelectorAll('[data-preview], [data-health-preview]').forEach(host => { host.hidden = true; host.replaceChildren(); }); };
  return context;
}

function filtered(context) {
  const query = context.dialog.querySelector('[data-search]').value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const includeHidden = context.dialog.querySelector('[data-include-hidden]').checked;
  return context.books.filter(book => (includeHidden || !book.hiddenBook) && query.every(word => [book.title, book.originalTitle, book.filepath, ...Object.values(book.tags || {}).flat()].join(' ').toLocaleLowerCase().includes(word)));
}
function updateSelection(context) {
  context.dialog.querySelector('[data-selected-count]').textContent = `已选 ${context.selected.size} 本`;
  const selected = context.books.filter(book => context.selected.has(book.id));
  const host = context.dialog.querySelector('[data-merge-options]');
  const previousKeeper = host.querySelector('[data-keeper]')?.value;
  const previousProgress = host.querySelector('[data-progress-source]')?.value;
  const previousPolicy = host.querySelector('[data-metadata-policy]')?.value || 'union';
  if (selected.length < 2) { host.innerHTML = '<p class="organizer-note">选择 2 至 30 本书后，可以指定保留本、进度和元数据来源。</p>'; return; }
  const options = selected.map(book => `<option value="${esc(book.id)}">${esc(book.title)} · ${book.pageCount || '?'} 页</option>`).join('');
  host.innerHTML = `<label>保留在书架上的书籍<select data-keeper>${options}</select></label><label>阅读进度来源<select data-progress-source>${selected.map(book => `<option value="${esc(book.id)}">${esc(book.title)} · ${esc(progressLabel(book.progress))}</option>`).join('')}</select></label><label>元数据保留方式<select data-metadata-policy><option value="union">合并全部标签，优先保留本的信息</option><option value="keeper">使用保留本的作者、标签与信息</option></select></label><details><summary>分别指定书名、分类与评分来源</summary>${['title', 'title_jpn', 'category', 'rating'].map(key => `<label>${labels[key]}<select data-source-field="${key}"><option value="">按所选保留方式</option>${selected.map(book => `<option value="${esc(book.id)}">${esc(book.title)}：${esc(fieldValue(key, key === 'title' ? book.originalTitle : book[key]))}</option>`).join('')}</select></label>`).join('')}</details>`;
  if (selected.some(book => book.id === previousKeeper)) host.querySelector('[data-keeper]').value = previousKeeper;
  const progressed = selected.filter(book => book.progress);
  const defaultProgress = progressed.length === 1 ? progressed[0].id : host.querySelector('[data-keeper]').value;
  host.querySelector('[data-progress-source]').value = selected.some(book => book.id === previousProgress) ? previousProgress : defaultProgress;
  host.querySelector('[data-metadata-policy]').value = previousPolicy;
}
function renderBooks(context) {
  const list = filtered(context), pages = Math.max(1, Math.ceil(list.length / 60));
  context.page = Math.max(1, Math.min(context.page, pages));
  context.dialog.querySelector('.organizer-book-list').innerHTML = list.slice((context.page - 1) * 60, context.page * 60).map(book => `<label class="organizer-book"><input type="checkbox" data-book-id="${esc(book.id)}" ${context.selected.has(book.id) ? 'checked' : ''} ${book.mergedInto ? 'disabled' : ''}><span><strong>${esc(book.title)}</strong><small>${book.pageCount || '?'} 页 · ${esc((book.tags?.artist || []).join('、') || '作者未填写')}${book.mergedInto ? ' · 已合并来源（请先撤销合并）' : book.hiddenBook ? ' · 已隐藏' : ''}</small><small class="organizer-path">${esc(book.filepath)}</small></span></label>`).join('') || '<p class="organizer-empty">没有符合条件的书籍。</p>';
  context.dialog.querySelector('[data-page-label]').textContent = `${context.page} / ${pages} · ${list.length} 本`;
  context.dialog.querySelector('[data-organizer="previous"]').disabled = context.page <= 1;
  context.dialog.querySelector('[data-organizer="next"]').disabled = context.page >= pages;
  updateSelection(context);
}
async function refreshCatalog(context) {
  const result = await invoke('organizer-catalog');
  context.books = result.books || []; context.maxBatch = result.maxBatch || 2000;
  context.maxRemoveMissing = result.maxRemoveMissing || 100000;
  const ids = new Set(context.books.filter(book => !book.mergedInto).map(book => book.id));
  context.selected = new Set([...context.selected].filter(id => ids.has(id)));
  renderBooks(context);
}
function switchTab(context, tab) {
  context.tab = tab;
  context.dialog.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab; });
  context.dialog.querySelectorAll('[data-tab]').forEach(button => { const selected = button.dataset.tab === tab; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
}
function renderPreview(context, preview) {
  context.preview = preview;
  const removing = preview.kind === 'remove-missing';
  const host = context.dialog.querySelector(removing ? '[data-health-preview]' : '[data-preview]'); host.hidden = false;
  const warning = (preview.warnings || []).map(message => `<li>${esc(message)}</li>`).join('');
  if (removing) host.innerHTML = `<h3 tabindex="-1" data-remove-heading>确认删除 ${preview.changed} 本书库记录？</h3><p>只删除下面的书库记录，<strong>不会删除磁盘文件</strong>。元数据、阅读档案和合集引用保留，之后可在「整理历史」撤销。</p><p class="organizer-note">暂不可访问可能只是磁盘未连接。提交时会再次检查，已经恢复访问的书籍不会被删除。</p><ul class="organizer-removal-list" aria-label="待删除的书库记录">${preview.rows.map(row => `<li><div><strong>${esc(row.title)}</strong><span class="organizer-badge">${healthLabels[row.status] || esc(row.status)}</span></div><p class="organizer-path">${esc(row.filepath)}</p></li>`).join('')}</ul>`;
  else if (preview.kind === 'batch') host.innerHTML = `<h3>修改预览 · ${preview.changed} 本发生变化</h3><p class="organizer-note">已选择 ${preview.selected} 本；只记录实际变动的字段。</p>${preview.rows.map(row => `<details ${preview.rows.length <= 3 ? 'open' : ''}><summary>${esc(row.title)}</summary>${fieldsTable(row.before, row.after)}</details>`).join('')}`;
  else host.innerHTML = `<h3>合并预览</h3><p class="organizer-evidence">${esc(preview.evidence)}</p>${sourceCard(preview.keeper, '保留展示')}${preview.donors.map(book => sourceCard(book, '隐藏为来源副本')).join('')}<h4>保留本的元数据</h4>${fieldsTable(preview.metadata.before, preview.metadata.after, { changedOnly: true })}<p><strong>阅读进度：</strong>${esc(progressLabel(preview.progress.before))} → ${esc(progressLabel(preview.progress.after))}</p><p><strong>合集：</strong>${preview.collections.length ? preview.collections.map(collection => esc(collection.title) + (collection.added ? '（加入保留本）' : '（已包含）')).join('、') : '未加入任何合集'}</p><p class="organizer-note">阅读偏好沿用保留本；阅读次数保留最大值 ${preview.retainedReadCount}。每份来源的进度、偏好、合集引用与原文件都会保留。</p>`;
  host.insertAdjacentHTML('beforeend', `${warning ? `<ul class="organizer-warnings">${warning}</ul>` : ''}<div class="organizer-actions"><button type="button" class="${removing ? 'organizer-danger organizer-danger-primary' : 'organizer-primary'}" data-organizer="apply" ${!preview.changed && preview.kind !== 'merge' ? 'disabled' : ''}>${removing ? `确认删除 ${preview.changed} 本记录` : preview.kind === 'merge' ? '确认合并书架展示' : '确认应用修改'}</button><button type="button" data-organizer="discard-preview">${removing ? '取消删除' : '返回修改'}</button></div>`);
  host.scrollIntoView({ behavior: 'smooth', block: removing ? 'start' : 'nearest' });
  if (removing) host.querySelector('[data-remove-heading]').focus({ preventScroll: true });
}
function missingCandidates(context) { return context.healthReport?.issues.filter(canRemoveMissing) || []; }
function updateMissingSelection(context) {
  const { dialog } = context, candidates = missingCandidates(context), ids = new Set(candidates.map(book => book.id));
  context.missingSelected = new Set([...context.missingSelected].filter(id => ids.has(id)));
  const count = context.missingSelected.size, all = dialog.querySelector('[data-missing-all]');
  if (all) { all.checked = count > 0 && count === candidates.length; all.indeterminate = count > 0 && count < candidates.length; all.disabled = context.busy || !candidates.length; }
  const label = dialog.querySelector('[data-missing-selected-count]');
  if (label) label.textContent = `已选 ${count} / ${candidates.length} 本`;
  for (const input of dialog.querySelectorAll('[data-missing-id]')) {
    input.checked = context.missingSelected.has(input.dataset.missingId); input.disabled = context.busy || !ids.has(input.dataset.missingId);
    input.closest('.organizer-health-book').classList.toggle('is-selected', input.checked);
  }
  for (const button of dialog.querySelectorAll('[data-organizer="remove-selected"], [data-organizer="clear-missing-selection"]')) button.disabled = context.busy || !count;
  const removeAll = dialog.querySelector('[data-organizer="remove-all"]');
  if (removeAll) removeAll.disabled = context.busy || !candidates.length;
  dialog.querySelectorAll('[data-remove-missing], [data-relocate]').forEach(button => { button.disabled = context.busy; });
}
function renderHealth(context, report) {
  context.healthReport = report;
  const candidates = missingCandidates(context);
  context.dialog.querySelector('[data-health-results]').innerHTML = `<div class="organizer-metrics"><span>正常 <b>${report.present}</b></span><span>缺失 <b>${report.missing}</b></span><span>暂不可访问 <b>${report.unavailable}</b></span><span>路径异常 <b>${report.invalid}</b></span></div>${!report.libraryAvailable ? `<p class="organizer-warnings">书库目录当前不可访问。暂不可访问不代表文件已删除，请核对后选择要移除的记录。</p>` : ''}${candidates.length ? `<div class="organizer-missing-toolbar"><div class="organizer-missing-selection"><label class="organizer-check"><input type="checkbox" data-missing-all>全选失联记录</label><span data-missing-selected-count role="status" aria-live="polite"></span><button type="button" data-organizer="clear-missing-selection" disabled>清空选择</button></div><div class="organizer-actions"><button type="button" class="organizer-danger" data-organizer="remove-selected" disabled>删除所选记录</button><button type="button" class="organizer-danger" data-organizer="remove-all">一键删除全部失联记录（${candidates.length}）</button></div><p class="organizer-note">可以保留记录并重新定位，也可以删除书库记录。删除不会移除磁盘文件，且可从整理历史撤销。</p></div>` : ''}${report.issues.length ? `<div role="group" aria-label="缺失和暂不可访问的书库记录">${report.issues.map(book => `<article class="organizer-card organizer-health-book" data-health-book="${esc(book.id)}"><div class="organizer-health-book-head"><label class="organizer-health-check"><input type="checkbox" data-missing-id="${esc(book.id)}" aria-label="选择 ${esc(book.title)}" ${canRemoveMissing(book) ? '' : 'disabled'}><strong>${esc(book.title)}</strong></label><span class="organizer-badge">${healthLabels[book.status] || esc(book.status)}</span></div><p class="organizer-path">${esc(book.filepath)}</p><p>${esc(book.message)}</p>${!book.canRelocate ? `<p class="organizer-note">${book.status === 'missing' ? '此旧书目没有完整内容指纹，请恢复原路径并扫描以建立指纹。' : book.status === 'invalid' ? '路径类型异常的记录不能在此删除，请先修复路径并重新检查。' : '连接磁盘或恢复路径后，可重新检查和定位。'}</p>` : ''}<div class="organizer-actions">${book.canRelocate ? `<button type="button" data-relocate="${esc(book.id)}">重新定位原书</button>` : ''}${canRemoveMissing(book) ? `<button type="button" class="organizer-danger" data-remove-missing="${esc(book.id)}">删除此记录</button>` : ''}</div></article>`).join('')}</div>` : `<p class="organizer-empty">${report.total === 0 ? '书库暂无记录，无需清理。' : '所有已入库书籍路径均可访问，没有需要清理的失联记录。'}</p>`}`;
  updateMissingSelection(context);
}
async function refreshHealth(context) { context.missingSelected.clear(); renderHealth(context, await invoke('organizer-health')); }
function renderDuplicates(context, report) {
  context.duplicateGroups = report.groups;
  context.dialog.querySelector('[data-duplicate-results]').innerHTML = `<p class="organizer-note">检查 ${report.total} 本可见书籍，找到 ${report.groupCount} 组线索。${esc(report.note)}</p>${report.groups.length ? report.groups.map((group, index) => `<article class="organizer-card"><h4>${group.kind === 'exact-candidate' ? '完整指纹一致的候选' : '书名与页数相似的候选'} · ${group.books.length} 本</h4><p class="organizer-evidence">${group.evidence.map(esc).join(' · ')}</p>${group.books.map(book => `<div><strong>${sourceTitle(book)}</strong>${sourceDetails(book)}<p class="organizer-path" data-source-path>${esc(book.filepath)}</p></div>`).join('')}<p class="organizer-note">${esc(group.note)}</p><button type="button" data-duplicate-group="${index}">选择此组并指定保留内容</button></article>`).join('') : '<p class="organizer-empty">没有找到符合条件的疑似重复书。</p>'}`;
}
async function renderHistory(context) {
  const history = await invoke('organizer-history');
  const states = { applied:'已应用', undone:'已撤销', prepared:'等待恢复', undoing:'正在恢复撤销', 'rolled-back':'失败后已回滚', 'recovery-conflict':'恢复遇到后续修改' };
  context.dialog.querySelector('[data-history-results]').innerHTML = history.length ? history.map(item => `<article class="organizer-card"><div class="organizer-section-head"><strong>${esc(item.title)}</strong><span>${states[item.status] || esc(item.status)}</span></div><p class="organizer-note">${esc(new Date(item.createdAt).toLocaleString('zh-CN'))} · ${item.changed} 本书记录${item.recoveredAt ? ' · 已从中断恢复' : ''}</p>${item.error ? `<p class="organizer-warnings">${esc(item.error)}</p>` : ''}${item.canUndo ? `<button type="button" data-undo="${esc(item.id)}">${item.kind === 'remove-missing' ? '恢复删除的书库记录' : '撤销这次整理'}</button>` : ''}</article>`).join('') : '<p class="organizer-empty">还没有整理记录。修改标签、合并书籍或删除失联记录后，可在这里查看和撤销。</p>';
}

async function handleAction(context, button) {
  const { dialog } = context;
  const action = button.dataset.organizer;
  if (action === 'close') { dialog.close(); return; }
  if (context.busy) return;
  if (button.dataset.tab) { switchTab(context, button.dataset.tab); if (button.dataset.tab === 'history') await renderHistory(context); return; }
  if (action === 'previous' || action === 'next') { context.page += action === 'next' ? 1 : -1; renderBooks(context); return; }
  if (action === 'clear-selection') { context.selected.clear(); context.invalidate(); renderBooks(context); return; }
  if (action === 'clear-missing-selection') { context.missingSelected.clear(); context.invalidate(); updateMissingSelection(context); return; }
  if (action === 'select-results') {
    const candidates = filtered(context).filter(book => !book.mergedInto);
    if (new Set([...context.selected, ...candidates.map(book => book.id)]).size > context.maxBatch) throw new Error(`一次最多整理 ${context.maxBatch} 本，请缩小搜索范围。`);
    candidates.forEach(book => context.selected.add(book.id)); context.invalidate(); renderBooks(context); return;
  }
  if (action === 'discard-preview') {
    const removing = context.preview?.kind === 'remove-missing'; context.invalidate();
    if (removing) (dialog.querySelector('[data-missing-id]:checked') || dialog.querySelector('[data-missing-all]'))?.focus();
    return;
  }
  if (button.dataset.duplicateGroup !== undefined) {
    const group = context.duplicateGroups[Number(button.dataset.duplicateGroup)];
    if (!group) return;
    context.selected = new Set(group.books.map(book => book.id)); context.invalidate(); renderBooks(context); switchTab(context, 'batch');
    dialog.querySelector('[data-merge-card]').open = true;
    dialog.querySelector('[data-merge-card]').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    context.status('已选中该组。请指定保留本和进度来源，再查看完整合并预览。'); return;
  }
  if (context.busy) return;
  context.busy = true; dialog.setAttribute('aria-busy', 'true'); button.disabled = true;
  const controls = [...dialog.querySelectorAll('input, select, textarea')].map(element => [element, element.disabled]);
  controls.forEach(([element]) => { element.disabled = true; });
  updateMissingSelection(context);
  try {
    if (action === 'remove-selected' || action === 'remove-all' || button.dataset.removeMissing) {
      const candidates = missingCandidates(context), ids = new Set(candidates.map(book => book.id));
      const bookIds = button.dataset.removeMissing ? [button.dataset.removeMissing] : action === 'remove-all' ? [...ids] : [...context.missingSelected];
      if (!bookIds.length) throw new Error('请先勾选要删除的缺失或暂不可访问记录。');
      if (bookIds.some(id => !ids.has(id))) throw new Error('缺失文件报告已变化，请重新检查后选择。');
      if (bookIds.length > context.maxRemoveMissing) throw new Error(`一次最多删除 ${context.maxRemoveMissing} 本失联记录，请分批选择。`);
      context.invalidate(); await window.readingState?.flush?.(); context.status('正在重新核对书籍路径并准备删除清单…');
      try { renderPreview(context, await invoke('organizer-preview-remove-missing', { bookIds })); }
      catch (error) { await refreshCatalog(context); await refreshHealth(context); throw error; }
      context.status('请核对删除清单。确认后仅删除书库记录，可以从整理历史恢复。');
    } else if (action?.startsWith('preview-')) {
      context.invalidate(); await window.readingState?.flush?.();
      const bookIds = [...context.selected];
      if (!bookIds.length) throw new Error('请先选择要整理的书籍。');
      let preview;
      if (action === 'preview-tags') {
        const mode = dialog.querySelector('[data-edit-mode]').value;
        const edit = { namespace: dialog.querySelector('[data-edit-namespace]').value, mode,
          values: dialog.querySelector('[data-edit-values]').value.split(/[\n\r，]+/).map(value => value.trim()).filter(Boolean),
          from: dialog.querySelector('[data-edit-from]').value.trim() };
        context.status('正在核对作者与标签修改…');
        preview = await invoke('organizer-preview-batch', { bookIds, tags: [edit] });
      } else if (action === 'preview-fields') {
        const fields = {};
        for (const input of dialog.querySelectorAll('[data-field-enabled]:checked')) {
          const key = input.dataset.fieldEnabled, value = dialog.querySelector(`[data-field="${key}"]`).value;
          if (key === 'rating' && value.trim() === '') throw new Error('请填写评分，或取消勾选评分字段。');
          fields[key] = key === 'rating' ? Number(value) : key === 'mark' ? value === 'true' : value;
        }
        context.status('正在准备书目信息预览…'); preview = await invoke('organizer-preview-batch', { bookIds, fields });
      } else {
        if (bookIds.length < 2 || bookIds.length > 30) throw new Error('合并请选择 2 至 30 本书。');
        const fieldSources = Object.fromEntries([...dialog.querySelectorAll('[data-source-field]')].filter(input => input.value).map(input => [input.dataset.sourceField, input.value]));
        context.status('正在核对所选文件的完整内容；大文件可能需要一些时间…');
        preview = await invoke('organizer-preview-merge', { bookIds, keeperId: dialog.querySelector('[data-keeper]').value,
          progressSourceId: dialog.querySelector('[data-progress-source]').value, metadataPolicy: dialog.querySelector('[data-metadata-policy]').value, fieldSources });
      }
      renderPreview(context, preview); context.status('预览已准备好。核对下面的保留内容后应用。');
    } else if (action === 'apply') {
      if (!context.preview) throw new Error('请先重新生成预览。');
      const preview = context.preview;
      await window.readingState?.flush?.(); context.status('正在保存整理结果与撤销记录…');
      let result;
      try { result = await invoke('organizer-apply', preview.token); }
      catch (error) { if (preview.kind === 'remove-missing') { await refreshCatalog(context); await refreshHealth(context); } throw error; }
      context.invalidate();
      await syncReading(); await refreshCatalog(context); await renderHistory(context);
      if (context.healthReport) await refreshHealth(context);
      window.dispatchEvent(new CustomEvent('yanruyu-library-updated', { detail: { kind: 'organizer' } }));
      context.status(result.noChanges ? '内容已一致，没有需要保存的变化。' : preview.kind === 'remove-missing' ? `已删除 ${result.changed ?? preview.changed} 本书库记录。磁盘文件与阅读档案保留，可在「整理历史」恢复。` : '整理已保存。可以在「整理历史」撤销这次操作。');
    } else if (action === 'health') {
      if (context.preview?.kind === 'remove-missing') context.invalidate();
      context.status('正在检查书籍路径…'); await refreshHealth(context); context.status('检查已完成。');
    } else if (action === 'duplicates') {
      context.status('正在寻找重复线索…'); renderDuplicates(context, await invoke('organizer-duplicates')); context.status('疑似重复检查已完成。');
    } else if (action === 'history') { await renderHistory(context); context.status('已载入整理历史。'); }
    else if (button.dataset.relocate) {
      const result = await invoke('relocate-book', button.dataset.relocate);
      context.status(result?.canceled ? '已取消定位。' : '重新定位任务已加入任务中心，完成后可再次检查。');
    } else if (button.dataset.undo) {
      await window.readingState?.flush?.(); context.status('正在核对并撤销这次整理…');
      await invoke('organizer-undo', button.dataset.undo); context.invalidate(); await syncReading(); await refreshCatalog(context); await renderHistory(context);
      if (context.healthReport) await refreshHealth(context);
      window.dispatchEvent(new CustomEvent('yanruyu-library-updated', { detail: { kind: 'organizer-undo' } }));
      context.status('已撤销本次整理，原文件与阅读档案完整保留。');
    }
  } finally {
    controls.forEach(([element, disabled]) => { if (element.isConnected) element.disabled = disabled; });
    context.busy = false; dialog.removeAttribute('aria-busy'); if (button.isConnected) button.disabled = false;
    updateMissingSelection(context);
  }
}

export async function openLibraryOrganizer({ bookIds = [] } = {}) {
  styles();
  if (active?.dialog.open) { active.dialog.focus(); return; }
  const context = buildDialog(bookIds); active = context;
  const { dialog } = context;
  document.body.append(dialog);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('close', () => { if (active === context) active = null; dialog.remove(); });
  dialog.addEventListener('keydown', event => {
    event.stopPropagation();
    if (event.target.matches('[role="tab"]') && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const buttons = [...dialog.querySelectorAll('[role="tab"]')]; let index = buttons.indexOf(event.target);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[index].click(); buttons[index].focus();
    }
  });
  dialog.addEventListener('input', event => {
    if (event.target.matches('[data-search]')) { context.page = 1; renderBooks(context); return; }
    if (event.target.closest('.organizer-editing')) context.invalidate();
  });
  dialog.addEventListener('change', event => {
    const input = event.target;
    if (input.dataset.missingId) {
      if (context.busy || !missingCandidates(context).some(book => book.id === input.dataset.missingId)) { updateMissingSelection(context); return; }
      if (input.checked) context.missingSelected.add(input.dataset.missingId); else context.missingSelected.delete(input.dataset.missingId);
      context.invalidate(); updateMissingSelection(context);
    } else if (input.matches('[data-missing-all]')) {
      if (context.busy) return;
      context.missingSelected = new Set(input.checked ? missingCandidates(context).map(book => book.id) : []);
      context.invalidate(); updateMissingSelection(context);
    } else if (input.dataset.bookId) {
      if (input.checked) { if (context.selected.size >= context.maxBatch) { input.checked = false; context.status(`一次最多选择 ${context.maxBatch} 本。`, true); return; } context.selected.add(input.dataset.bookId); }
      else context.selected.delete(input.dataset.bookId);
      context.invalidate(); updateSelection(context);
    } else if (input.matches('[data-include-hidden]')) { context.page = 1; renderBooks(context); }
    else if (input.matches('[data-edit-mode]')) {
      dialog.querySelector('[data-old-label]').hidden = input.value !== 'rename';
      dialog.querySelector('[data-edit-note]').textContent = input.value === 'replace' ? '替换整组会清空该分组原有标签；留空表示清空该组。请仔细核对预览。' : '只改变所选分组，其他标签保持原样。';
      context.invalidate();
    } else if (input.closest('.organizer-editing')) context.invalidate();
  });
  dialog.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button || button.disabled) return;
    handleAction(context, button).catch(error => { context.invalidate(); context.status(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), true); });
  });
  dialog.showModal(); context.status('正在载入书库…');
  try { await window.readingState?.flush?.(); await refreshCatalog(context); context.status('选择书籍，开始整理。'); }
  catch (error) { context.status(error.message || String(error), true); }
  dialog.querySelector('[data-search]').focus();
}

// Root can mount this in its single toolbar, or invoke open directly from a
// book detail action. No global sidebar button is inserted automatically.
export function mountLibraryOrganizer(target) {
  if (!target || target.querySelector('[data-open-library-organizer]')) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'pill-button';
  button.dataset.openLibraryOrganizer = ''; button.textContent = '书库整理'; button.addEventListener('click', () => openLibraryOrganizer()); target.append(button);
  return button;
}
window.YanruyuOrganizer = { open: openLibraryOrganizer, mount: mountLibraryOrganizer };
window.addEventListener('keydown', event => {
  if (!active?.dialog.open || event.key !== 'Escape') return;
  event.preventDefault(); event.stopImmediatePropagation(); active.dialog.close();
}, true);
