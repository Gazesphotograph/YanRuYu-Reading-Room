const invoke = (channel, ...args) => window.ipcRenderer.invoke(channel, ...args);
const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[letter]));
const states = { queued: '等待中', running: '进行中', cancelling: '正在取消', completed: '已完成', 'completed-with-errors': '部分失败', failed: '失败', cancelled: '已取消', interrupted: '上次中断' };
let tasks = [], dialog, initialError = '', pending = new Set();

function ensureStyles() {
  if (document.querySelector('link[data-task-center-style]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet'; link.href = new URL('./task-center.css', import.meta.url).href;
  link.dataset.taskCenterStyle = ''; document.head.append(link);
}

function updateTasks(value) {
  tasks = Array.isArray(value) ? value : [];
  const count = tasks.filter(task => ['queued', 'running', 'cancelling'].includes(task.status)).length;
  document.querySelectorAll('[data-task-center-count]').forEach(element => { element.textContent = count ? String(count) : ''; element.hidden = !count; });
  window.dispatchEvent(new CustomEvent('yanruyu-tasks-changed', { detail: { tasks } }));
  render();
}

function render() {
  if (!dialog?.open) return;
  const host = dialog.querySelector('.task-center-list');
  const expanded = new Set([...host.querySelectorAll('details[open]')].map(element => element.dataset.taskDetails));
  const focused = host.contains(document.activeElement) ? { id: document.activeElement.dataset.taskId, action: document.activeElement.dataset.taskAction } : null;
  host.innerHTML = tasks.length ? tasks.map(task => {
    const active = ['queued', 'running', 'cancelling'].includes(task.status);
    const progress = Number.isFinite(task.progress) ? Math.max(0, Math.min(1, task.progress)) : null;
    const summary = task.result && ['scan', 'metadata'].includes(task.kind)
      ? `新增 ${task.result.added || 0} · 更新 ${task.result.updated || 0} · 未变 ${task.result.unchanged || 0} · 重定位 ${task.result.relocated || 0}` : '';
    const errors = Array.isArray(task.errors) ? task.errors : [];
    return `<article class="task-center-item" data-task-status="${esc(task.status)}"><div class="task-center-item-head"><strong>${esc(task.title)}</strong><span>${esc(states[task.status] || task.status)}</span></div>
      <p>${esc(task.message || '')}</p>${task.filepath ? `<p class="task-center-path" title="${esc(task.filepath)}">${esc(task.filepath)}</p>` : ''}
      ${active ? `<progress max="1" ${progress === null ? '' : `value="${progress}"`} aria-label="${esc(task.title)}进度"></progress><span class="task-center-progress">${task.total ? `${esc(task.current)} / ${esc(task.total)}` : '正在准备…'}${progress === null ? '' : ` · ${Math.round(progress * 100)}%`}</span>` : ''}
      ${summary ? `<p class="task-center-summary">${esc(summary)}</p>` : ''}
      ${errors.length ? `<details data-task-details="${esc(task.id)}" ${expanded.has(task.id) ? 'open' : ''}><summary>查看失败明细（${esc(task.errorCount || errors.length)}）</summary><ul>${errors.map(error => `<li>${error.filepath ? `<span class="task-center-path">${esc(error.filepath)}</span>` : ''}<span>${esc(error.message)}</span></li>`).join('')}</ul>${task.errorCount > errors.length ? `<p>面板显示前 ${errors.length} 条失败；重试会重新检查全部项目。</p>` : ''}</details>` : ''}
      ${task.historyWarning ? `<p class="task-center-warning">${esc(task.historyWarning)}</p>` : ''}
      <div class="task-center-item-actions">${task.canCancel ? `<button type="button" data-task-action="cancel" data-task-id="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>取消</button>` : ''}
      ${task.canRetry ? `<button type="button" data-task-action="retry" data-task-id="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>重试</button>` : ''}
      ${!active ? `<button type="button" data-task-action="dismiss" data-task-id="${esc(task.id)}" ${pending.has(task.id) ? 'disabled' : ''}>移除记录</button>` : ''}
      <time>${esc(new Date(task.createdAt).toLocaleString('zh-CN'))}</time></div></article>`;
  }).join('') : '<p class="task-center-empty">暂无任务。可以开始扫描书库，或刷新本地页数与封面。</p>';
  if (focused?.id && focused.action) {
    [...host.querySelectorAll('button')].find(button => button.dataset.taskId === focused.id && button.dataset.taskAction === focused.action)?.focus({ preventScroll: true });
  }
}

async function refresh() {
  try { updateTasks(await invoke('task-list')); initialError = ''; }
  catch (error) { initialError = String(error.message || error); }
  if (dialog?.open) dialog.querySelector('.task-center-status').textContent = initialError;
}

export async function openTaskCenter() {
  ensureStyles();
  if (dialog?.open) { dialog.focus(); return; }
  dialog = document.createElement('dialog'); dialog.className = 'task-center-dialog themed-dialog';
  dialog.setAttribute('aria-labelledby', 'task-center-title');
  dialog.innerHTML = `<header><div><h2 id="task-center-title">任务中心</h2><p>扫描时可以继续浏览和阅读。取消后可重试，书库记录保持可用。</p></div><button type="button" class="dialog-close" data-task-action="close" aria-label="关闭任务中心"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M5 19 19 5"/></svg></button></header>
    <div class="task-center-start"><button type="button" data-task-action="scan">增量扫描书库</button><button type="button" data-task-action="metadata">刷新本地页数与封面</button></div>
    <p class="task-center-status" role="status" aria-live="polite"></p><div class="task-center-list"></div>`;
  document.body.append(dialog);
  const instance = dialog;
  instance.addEventListener('cancel', event => { event.preventDefault(); instance.close(); });
  instance.addEventListener('keydown', event => event.stopPropagation());
  instance.addEventListener('close', () => { if (dialog === instance) dialog = null; instance.remove(); });
  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button[data-task-action]'); if (!button || button.disabled) return;
    const action = button.dataset.taskAction, id = button.dataset.taskId;
    if (action === 'close') { dialog.close(); return; }
    const activeDialog = dialog;
    const status = text => { if (activeDialog?.open) activeDialog.querySelector('.task-center-status').textContent = text; };
    button.disabled = true; if (id) pending.add(id);
    try {
      if (action === 'scan' || action === 'metadata') {
        await invoke('task-start', action, { rebuild: false });
        status('任务已加入队列，可以关闭此面板继续浏览。');
      } else {
        await invoke('task-' + action, id);
        status(action === 'cancel' ? '已请求安全取消。' : action === 'retry' ? '重试已加入队列。' : '已移除任务记录。');
      }
      await refresh();
    } catch (error) { status(String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
    finally { if (id) pending.delete(id); button.disabled = false; render(); }
  });
  dialog.showModal(); render(); await refresh();
}

export function installManagerTaskCenter() {
  ensureStyles();
  if (document.querySelector('.manager-task-center')) return;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'manager-room-return manager-task-center';
  button.innerHTML = '任务中心 <span data-task-center-count hidden></span>';
  button.addEventListener('click', () => openTaskCenter()); document.body.append(button);
  updateTasks(tasks);
}

window.YanruyuTasks = {
  open: openTaskCenter,
  startScan: async (options = {}) => {
    const task = await invoke('task-start', 'scan', { rebuild: options.rebuild === true });
    await openTaskCenter(); return task;
  },
  refresh,
  get tasks() { return tasks; }
};

// The two readers handle Escape globally. A native dialog can temporarily lose
// its focused button while a task update replaces a row, so handle its Escape
// before either reader sees the key, including that focus-transition frame.
window.addEventListener('keydown', event => {
  if (!dialog?.open || event.key !== 'Escape') return;
  event.preventDefault(); event.stopImmediatePropagation(); dialog.close();
}, true);

if (window.ipcRenderer?.on) {
  try {
    window.ipcRenderer.on('tasks-changed', (_event, payload) => updateTasks(payload?.tasks));
    window.ipcRenderer.on('library-updated', (_event, detail) => window.dispatchEvent(new CustomEvent('yanruyu-library-updated', { detail })));
  } catch {} // Older frontends can open without a connected task bridge.
}
refresh().catch(() => {});
