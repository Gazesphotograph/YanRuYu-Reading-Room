const invoke = (channel, ...args) => window.ipcRenderer.invoke(channel, ...args);
const esc = value => String(value ?? '').replace(/[&<>"']/g, value => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[value]));
const displayDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN') : '未知日期'; };
const displaySize = value => (Number(value) / 1048576).toFixed(1) + ' MB';
let activeDialog;

function ensureStyles() {
  if (document.querySelector('link[data-protection-style]')) return;
  const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = new URL('./data-protection.css', import.meta.url).href;
  link.dataset.protectionStyle = ''; document.head.append(link);
}

export function installManagerDataProtection() {
  ensureStyles();
  if (document.querySelector('.manager-data-protection')) return;
  const button = document.createElement('button'); button.type = 'button';
  button.className = 'manager-room-return manager-data-protection'; button.textContent = '备份与恢复';
  button.onclick = () => openDataProtection({ onLibraryChange: () => location.reload() });
  document.body.append(button);
}

export async function openDataProtection({ onLibraryChange } = {}) {
  if (activeDialog?.open) { activeDialog.focus(); return; }
  ensureStyles();
  const dialog = document.createElement('dialog'); dialog.className = 'data-protection-dialog themed-dialog';
  dialog.setAttribute('aria-labelledby', 'protection-title'); dialog.setAttribute('role', 'dialog');
  dialog.innerHTML = `<header><div><h2 id="protection-title">备份与恢复</h2><p class="protection-note">让书库、收藏与每一次续读都有归处。</p></div><button type="button" class="dialog-close" data-protection="close" aria-label="关闭备份与恢复"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5l14 14M5 19 19 5"/></svg></button></header><div class="protection-content">
    <section><h3>创建完整备份</h3><p>保存书目、元数据、合集、阅读档案和界面偏好。</p><label><input type="checkbox" id="backup-include-covers" checked>包含封面</label><p class="protection-note">漫画原文件不包含在备份内，请单独保管原文件目录。备份包含程序设置，请存放在可信的位置。</p><div class="protection-actions"><button class="protection-primary" data-protection="export">选择位置并创建备份</button></div></section>
    <section><h3>从备份恢复</h3><p>先查看内容并完成校验，确认后恢复并重新启动。恢复前会自动保存当前数据；已有损坏时保留原始文件副本。</p><div class="protection-actions"><button data-protection="inspect">选择备份并预览</button><button data-protection="recovery-folder">打开自动恢复点文件夹</button></div><div id="backup-preview" hidden></div></section>
    <section><h3>压缩包删页恢复点</h3><p class="protection-note">每次删页前保留原包。恢复前也会保存当前版本，便于再次撤回。</p><button data-protection="points">查看可恢复版本</button><div id="archive-points"></div></section></div>
    <p class="protection-status" role="status" aria-live="polite" id="protection-status"></p>`;
  document.body.append(dialog); activeDialog = dialog;
  let preview = null, busy = false, restarting = false, libraryChanged = false, pendingPoint = null;
  const status = (message, level = '') => { const element = dialog.querySelector('#protection-status'); element.textContent = message; element.dataset.level = level; };
  const setBusy = value => { busy = value; dialog.setAttribute('aria-busy', String(value)); for (const button of dialog.querySelectorAll('button')) button.disabled = value || button.dataset.unavailable === 'true'; };
  const fail = error => status(String(error?.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''), 'error');

  async function listPoints() {
    const points = await invoke('archive-recovery-list');
    const host = dialog.querySelector('#archive-points');
    host.innerHTML = points.length ? points.map(point => `<article class="protection-point"><strong>${esc(point.filename)}</strong><span>${esc(displayDate(point.createdAt))} · ${esc(displaySize(point.size))}</span><div class="protection-path">${esc(point.originalPath)}</div>${point.removedEntry ? `<p class="protection-note">删页前版本：${esc(point.removedEntry)}</p>` : ''}${point.available === false ? `<p class="protection-note">${esc(point.error || '该恢复点暂不可用')}</p>` : ''}<button data-point-id="${esc(point.id)}" data-unavailable="${point.available === false}" ${point.available === false ? 'disabled' : ''}>选择此版本</button></article>`).join('') : '<p class="protection-note">还没有压缩包删页恢复点。</p>';
  }

  dialog.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button || busy || button.disabled) return;
    if (button.dataset.protection === 'close') { dialog.close(); return; }
    if (button.dataset.pointId) {
      pendingPoint = button.dataset.pointId;
      const article = button.closest('article');
      dialog.querySelectorAll('[data-protection="restore-point"]').forEach(element => element.remove());
      const confirm = document.createElement('button'); confirm.className = 'protection-primary'; confirm.dataset.protection = 'restore-point'; confirm.textContent = '确认恢复此版本'; article.append(confirm);
      status('将替换上方显示的压缩包。当前版本也会保留为新的恢复点。');
      return;
    }
    setBusy(true);
    try {
      switch (button.dataset.protection) {
        case 'export': {
          await globalThis.YanruyuClientState?.flush();
          await window.readingState?.flush();
          status('正在创建并校验备份…');
          const result = await invoke('backup-export', { includeCovers: dialog.querySelector('#backup-include-covers').checked });
          status(result.canceled ? '已取消创建备份。' : `完整备份已保存。\n${result.path}`);
          break;
        }
        case 'inspect': {
          preview = null;
          dialog.querySelector('#backup-preview').hidden = true;
          dialog.querySelector('#backup-preview').replaceChildren();
          status('正在检查备份完整性…');
          const result = await invoke('backup-inspect');
          if (result.canceled) { status('已取消选择备份。'); break; }
          preview = result;
          const s = result.summary, host = dialog.querySelector('#backup-preview'); host.hidden = false; host.className = 'protection-preview';
          host.innerHTML = `<h3>恢复内容预览</h3><p>${esc(displayDate(s.createdAt))} · 版本 ${esc(s.appVersion)}</p><dl><dt>书目 / 元数据</dt><dd>${esc(s.books)} / ${esc(s.metadata)}</dd><dt>合集 / 阅读记录</dt><dd>${esc(s.collections)} / ${esc(s.readingRecords)}</dd><dt>封面</dt><dd>${s.includesCovers ? esc(s.covers) + ' 张' : '未包含'}</dd><dt>数据大小</dt><dd>${esc(displaySize(s.bytes))}</dd></dl><p class="protection-path">原书库目录：${esc(s.libraryPath || '未设置')}</p><p class="protection-note">将替换当前副本的数据，漫画原文件保持原位。元数据恢复到本副本；原目录不可用时需重新选择漫画文件夹。${s.includesCovers ? '' : '未包含的封面可在完整管理界面重新生成。'}</p><button class="protection-primary" data-protection="restore">确认恢复并重新启动</button>`;
          status('备份校验通过。请核对以上内容后确认恢复。');
          break;
        }
        case 'restore': {
          if (!preview) throw new Error('请先选择并预览备份。');
          await globalThis.YanruyuClientState?.flush();
          await window.readingState?.flush();
          status('正在保存当前恢复点并恢复数据，请稍候…');
          const result = await invoke('backup-restore', preview.token);
          restarting = true;
          globalThis.YanruyuClientState?.suspend();
          status(`恢复完成，程序即将重新启动。\n之前的数据保存在：${result.recoveryPath}`);
          return;
        }
        case 'recovery-folder': await invoke('data-protection-open-recovery'); status('已打开自动恢复点文件夹。'); break;
        case 'points': status('正在检查压缩包恢复点…'); await listPoints(); status('选择版本后可确认恢复。'); break;
        case 'restore-point': {
          if (!pendingPoint) throw new Error('请先选择要恢复的版本。');
          status('正在校验并恢复压缩包…');
          const result = await invoke('archive-recovery-restore', pendingPoint);
          libraryChanged = true; pendingPoint = null;
          await listPoints();
          status(result.warning || '压缩包已恢复，当前版本也已保存为恢复点。关闭面板后会刷新书库。');
          break;
        }
      }
    } catch (error) { if (button.dataset.protection === 'restore') { preview = null; dialog.querySelector('#backup-preview').hidden = true; } fail(error); }
    finally { if (!restarting) setBusy(false); }
  });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { dialog.remove(); if (activeDialog === dialog) activeDialog = null; if (libraryChanged) Promise.resolve(onLibraryChange?.()).catch(console.error); }, { once: true });
  dialog.showModal();
  dialog.querySelector('[data-protection="close"]').focus();
}
