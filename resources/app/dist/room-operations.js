const esc = value => String(value ?? '').replace(/[&<>"']/g, letter => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[letter]));
const errorText = error => String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '');

export function createOperationsUI({ invoke, getState, showModal, openBook, onLibraryChange, onFilesChanged }) {
  function modal(html, name) {
    showModal(`<div class="drawer-top">${esc(name)}<button class="icon-btn" data-action="dismiss" aria-label="关闭${esc(name)}">×</button></div>${html}`);
    const dialog = document.querySelector('#modal-root [role="dialog"]');
    dialog.classList.add('management-modal'); dialog.setAttribute('aria-label', name);
    return dialog;
  }
  function status(dialog, text) { if (dialog.isConnected) dialog.querySelector('[role="status"]').textContent = text; }
  function importData(bookIds = []) {
    const dialog = modal(`<h2>书库导入</h2><section><h3>SQLite 元数据</h3>
      <p class="path">${bookIds.length ? `匹配表格所选的 ${bookIds.length} 本书` : '匹配当前书库中的书籍'}，已标记的书会跳过。结果会分别列出成功、跳过、未匹配和失败项目。</p>
      <button class="pill-button primary" data-import-sqlite>选择 SQLite 并导入</button><button class="pill-button" data-action="tasks">任务中心</button><div data-import-result></div></section>
      <section><h3>旧版元数据与合集</h3><p class="path">选择旧版 collectionList.json 与 metadata.sqlite，核对内容后导入。原主书库和阅读档案保留；导入前自动创建恢复点。</p><button class="pill-button" data-import-legacy>选择旧版数据</button></section>
      <section><h3>完整备份</h3><p class="path">恢复书目、进度、合集、界面偏好和封面。</p><button class="pill-button" data-action="data-protection">打开备份与恢复</button></section><p class="path" role="status"></p>`, '书库导入');
    dialog.querySelector('[data-import-sqlite]').onclick = async event => {
      const button = event.target; button.disabled = true; status(dialog, '正在导入，可在任务中心查看进度或取消。');
      try {
        const result = await invoke('import-library-sqlite', bookIds.length ? {bookIds} : {});
        if (result.canceled || result.cancelled) { status(dialog, '导入已取消。'); return; }
        await onLibraryChange();
        if (!dialog.isConnected) return;
        status(dialog, result.message);
        const failures = result.failureDetails || [];
        dialog.querySelector('[data-import-result]').innerHTML = `<p class="path">导入 ${result.counts.imported} · 跳过 ${result.counts.skipped} · 未匹配 ${result.counts.unmatched} · 失败 ${result.counts.failed}</p>
          ${failures.length ? `<details open><summary>失败明细</summary><ul>${failures.map(item => `<li>${esc(item.title || item.id || '来源校验')}：${esc(item.reason)}</li>`).join('')}</ul></details>` : ''}
          ${result.unmatched?.length ? `<details><summary>未匹配的书籍</summary><ul>${result.unmatched.map(item => `<li>${esc(item.title)}：${esc(item.reason)}</li>`).join('')}</ul></details>` : ''}`;
      } catch (error) { status(dialog, errorText(error)); }
      finally { button.disabled = false; }
    };
    dialog.querySelector('[data-import-legacy]').onclick = async event => {
      const button = event.target; button.disabled = true;
      try {
        const collectionListPath = await invoke('select-file','选择旧版 collectionList.json',[{name:'JSON',extensions:['json']}]);
        if (!collectionListPath) return;
        const metadataSqlitePath = await invoke('select-file','选择旧版 metadata.sqlite',[{name:'SQLite',extensions:['sqlite','db']}]);
        if (!metadataSqlitePath) return;
        const result = await invoke('import-database',{collectionListPath,metadataSqlitePath});
        status(dialog, result.canceled ? '已取消旧版导入。' : '导入完成，正在重新启动。');
      } catch (error) { status(dialog, errorText(error)); }
      finally { button.disabled = false; }
    };
  }
  async function systemSettings() {
    const setting = getState().setting;
    const options = [['loadOnStart','启动后增量扫描书库'],['closeToTray','关闭窗口时保留在托盘'],['minimizeToTray','最小化时隐藏到托盘'],['minimizeOnStart','启动时最小化'],['startOnLogin','登录 Windows 后启动'],['hideTitleBar','使用应用内标题栏'],['readerClickToTurn','点击页面左右区域翻页'],['autoNextManga','读到末页后再次向前翻页时打开下一本'],['enabledLANBrowsing','向局域网客户端共享书库']];
    const dialog = modal(`<h2>系统与阅读设置</h2><form class="system-settings">${options.map(([key,label]) => `<label><input type="checkbox" name="${key}" ${setting[key]?'checked':''}><span>${label}</span></label>`).join('')}
      <label>单页显示宽度上限（像素）<input type="number" min="0" max="16384" step="1" name="widthLimit" placeholder="自动" value="${esc(setting.widthLimit ?? '')}"></label>
      <p class="path">宽度留空或填 0 时随窗口适配。启动、标题栏和托盘选项会在下次启动时完整生效。</p>
      <div class="detail-actions"><button class="pill-button primary" type="submit">保存系统设置</button></div></form>
      <section><h3>外部阅读器</h3><p class="path" data-external-program></p><div class="detail-actions"><button class="pill-button" data-select-program>选择程序</button><button class="pill-button" data-reset-program>使用系统默认程序</button></div></section>
      <section><h3>数据位置</h3><div class="data-location-info"><p class="path">正在读取数据目录…</p></div><p class="path">更换目录会打开该目录中的元数据文件。可以先在此处备份当前数据。</p><div class="detail-actions"><button class="pill-button" data-select-metadata>选择元数据目录</button><button class="pill-button" data-reset-metadata>使用默认目录</button><button class="pill-button" data-action="data-protection">备份与恢复</button></div></section><p class="path" role="status"></p>`, '系统与阅读设置');
    const form = dialog.querySelector('form');
    let saving = false;
    function showProgram() {
      dialog.querySelector('[data-external-program]').textContent = String(getState().setting.imageExplorer || '').replace(/^"|"$/g, '') || '系统默认程序';
    }
    async function showLocations() {
      const locations = await invoke('data-locations');
      if (!dialog.isConnected) return;
      const host = dialog.querySelector('.data-location-info');
      host.innerHTML = `<p class="path">书库数据目录：${esc(locations.storePath)}</p><p class="path">元数据文件：${esc(locations.metadataPath)}</p><button class="pill-button" data-show-data-folder>在文件夹中显示</button>`;
      host.querySelector('button').onclick = () => invoke('show-file', locations.storePath);
    }
    async function save(pickPatch, message, afterSave) {
      if (saving) return;
      saving = true;
      const buttons = [...dialog.querySelectorAll('button:enabled')].filter(button => !button.matches('[data-action]'));
      buttons.forEach(button => { button.disabled = true; });
      try {
        const patch = await pickPatch();
        if (!patch || !dialog.isConnected) return;
        const latest = await invoke('load-setting');
        const next = { ...latest, ...patch };
        const saved = await invoke('save-setting', next);
        getState().setting = saved || next;
        status(dialog, message);
        await afterSave?.();
      } catch (error) { status(dialog, errorText(error)); }
      finally { saving = false; buttons.forEach(button => { button.disabled = false; }); }
    }
    form.onsubmit = async event => {
      event.preventDefault();
      await save(() => ({ ...Object.fromEntries(options.map(([key]) => [key, form.elements[key].checked])),
        widthLimit: form.elements.widthLimit.valueAsNumber || 0 }), '系统设置已保存。');
    };
    dialog.querySelector('[data-select-program]').onclick = () => save(async () => {
      const imageExplorer = await invoke('select-file', '选择外部阅读器', [{name:'阅读器程序', extensions:['exe']}]);
      return imageExplorer ? { imageExplorer } : null;
    }, '外部阅读器已保存。', showProgram);
    dialog.querySelector('[data-reset-program]').onclick = () => save(() => ({ imageExplorer: '' }), '已恢复系统默认程序。', showProgram);
    const refreshMetadata = async () => { await showLocations(); await onLibraryChange(); };
    dialog.querySelector('[data-select-metadata]').onclick = () => save(async () => {
      const metadataPath = await invoke('select-folder', '选择元数据目录');
      return metadataPath ? { metadataPath } : null;
    }, '元数据目录已保存。', refreshMetadata);
    dialog.querySelector('[data-reset-metadata]').onclick = () => save(() => ({ metadataPath: '' }), '已恢复默认元数据目录。', refreshMetadata);
    showProgram();
    try { await showLocations(); }
    catch (error) { if (dialog.isConnected) dialog.querySelector('.data-location-info').textContent = errorText(error); }
  }
  async function fileOperation(id, kind) {
    const preview = await invoke(kind==='move'?'book-file-preview-move':'book-file-preview-recycle', id);
    if (preview.canceled) return;
    const name = kind==='move'?'移动书籍':'回收本地文件';
    const dialog = modal(`<h2>${name}</h2><div class="file-operation-preview"><h3>当前来源</h3><p class="path">${esc(preview.from)}</p>
      ${kind==='move'?`<h3>移动到</h3><p class="path">${esc(preview.to)}</p><p class="path">移动后保留同一本书的标识、封面、收藏、合集和阅读记录。</p>`
        : `<p class="path">${preview.type==='folder'?`将 ${preview.imageCount} 张直接书页图片移入系统回收站；目录中的其他文件会保留。`:'将这个压缩包移入系统回收站。'}书库记录和阅读档案保留，可在恢复原文件后重新定位。</p>`}</div>
      <div class="detail-actions"><button class="pill-button primary" data-file-confirm>确认${kind==='move'?'移动':'移入回收站'}</button><button class="pill-button" data-file-cancel>取消</button></div><p class="path" role="status"></p>`, name);
    dialog.querySelector('[data-file-cancel]').onclick = () => openBook(id);
    dialog.querySelector('[data-file-confirm]').onclick = async event => {
      const button = event.target; button.disabled = true;
      try {
        const result = await invoke('book-file-apply',preview.token);
        onFilesChanged(result);
        await onLibraryChange();
        if (dialog.isConnected) openBook(id);
      } catch (error) { status(dialog,errorText(error)); }
      finally { button.disabled = false; }
    };
  }
  return { importData, systemSettings, fileOperation };
}
