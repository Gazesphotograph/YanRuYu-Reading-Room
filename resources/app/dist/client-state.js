// Restore portable preferences before themes or either reader are initialized.
const keys = [
  'reading-room-interface', 'recentRead', 'viewerReadingProgress',
  'viewerImageWidth', 'imageStyleType', 'imageStyleFit', 'showViewerSide',
  'expandNodes', 'sortValue', 'room-theme', 'room-sort', 'room-view',
  'room-progress', 'room-reading-mode', 'room-external-reader',
  'room-library-state', 'room-smart-shelves', 'room-quality', 'room-personalization',
  'reading-room-theme', 'manager-theme', 'theme', 'room-night', 'appTheme',
];
let lastSaved = '', timer = 0, unavailable = false, suspended = false;
let captureCurrentView;

function snapshot() {
  captureCurrentView?.();
  const values = Object.create(null);
  for (const key of keys) {
    const value = localStorage.getItem(key);
    if (value !== null) values[key] = value;
  }
  return { schemaVersion: 1, values, savedAt: Date.now() };
}

async function flush() {
  clearTimeout(timer); timer = 0;
  if (unavailable || suspended) return;
  const value = snapshot(), signature = JSON.stringify(value.values);
  if (signature === lastSaved) return;
  await window.ipcRenderer.invoke('save-ui-state', value);
  lastSaved = signature;
}

function schedule() {
  if (!timer && !unavailable && !suspended) timer = setTimeout(() => flush().catch(error => console.warn('界面偏好保存失败：', error)), 800);
}

globalThis.YanruyuClientState = Object.freeze({ snapshot, flush, registerCapture(callback) { captureCurrentView = typeof callback === 'function' ? callback : undefined; }, suspend() { suspended = true; clearTimeout(timer); } });

try {
  const saved = await window.ipcRenderer.invoke('load-ui-state');
  if (saved?.schemaVersion === 1 && saved.values) {
    const pendingRestore = saved.restoreToken && saved.restoreToken !== localStorage.getItem('yanruyu-restored-backup-id');
    const freshProfile = Object.keys(snapshot().values).length === 0;
    if (pendingRestore || freshProfile) {
      for (const key of keys) {
        if (typeof saved.values[key] === 'string') localStorage.setItem(key, saved.values[key]);
        else localStorage.removeItem(key);
      }
      if (saved.restoreToken) localStorage.setItem('yanruyu-restored-backup-id', saved.restoreToken);
    }
  }
  await flush();
} catch (error) {
  // A standalone browser preview may not offer persistent desktop IPC. Keep it
  // usable, while a desktop backup still reports a failed state capture.
  unavailable = true;
  console.warn('界面偏好存储暂不可用：', error);
}

document.addEventListener('click', schedule);
document.addEventListener('change', schedule);
document.addEventListener('input', schedule);
window.addEventListener('yanruyu-library-position', schedule);
document.addEventListener('visibilitychange', () => { if (document.hidden) flush().catch(() => {}); });
window.addEventListener('pagehide', () => { flush().catch(() => {}); });

export { snapshot, flush };
