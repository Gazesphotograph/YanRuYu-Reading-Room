const { contextBridge, ipcRenderer, webFrame } = require('electron')

const invokeChannels = new Set(["load-book-list","force-gene-book-list","patch-local-metadata","patch-local-metadata-by-book","get-ehviewer-data","get-ex-webpage","post-data-ex","save-book","get-folder-tree","load-collection-list","save-collection-list","open-url","show-file","use-new-cover","open-local-book","get-default-manga-reader","delete-local-book","move-local-book","load-manga-image-list","release-sendimagelock","delete-image","select-folder","select-file","load-setting","window-minimize","window-toggle-maximize","window-is-maximized","window-close","relaunch-app","save-setting","export-database","import-database","import-sqlite","set-progress-bar","get-locale","copy-image-to-clipboard","copy-text-to-clipboard","read-text-from-clipboard","update-window-title","switch-fullscreen","update-tag-translation","enable-LAN-browsing"])
const eventChannels = new Set(['send-action', 'send-message', 'manga-image', 'manga-thumbnail-image', 'tasks-changed', 'library-updated'])
for (const channel of ['load-ui-state', 'save-ui-state', 'backup-export', 'backup-inspect', 'backup-restore',
  'archive-recovery-list', 'archive-recovery-restore', 'data-protection-open-recovery']) invokeChannels.add(channel)
for (const channel of ['load-reading-state', 'save-reading-progress', 'save-reading-preferences', 'migrate-reading-state']) invokeChannels.add(channel)
for (const channel of ['task-list', 'task-start', 'task-cancel', 'task-retry', 'task-dismiss', 'relocate-book',
  'image-cache-status', 'image-cache-budget', 'image-cache-clear']) invokeChannels.add(channel)
for (const channel of ['organizer-catalog', 'organizer-preview-batch', 'organizer-preview-merge', 'organizer-preview-remove-missing',
  'organizer-apply', 'organizer-history', 'organizer-undo', 'organizer-health', 'organizer-duplicates',
  'local-search-command', 'local-search-ocr-image']) invokeChannels.add(channel)
const listeners = new Map()
contextBridge.exposeInMainWorld('ipcRenderer', {
  invoke: (channel, ...args) => {
    if (!invokeChannels.has(channel)) return Promise.reject(new Error('IPC channel is not allowed'))
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel, listener) => {
    if (!eventChannels.has(channel) || typeof listener !== 'function') throw new Error('IPC event is not allowed')
    // These are singleton UI consumers; remounting must not accumulate stale listeners.
    const previous = listeners.get(channel)
    if (previous) ipcRenderer.removeListener(channel, previous)
    const wrapped = (_event, ...args) => listener(null, ...args)
    listeners.set(channel, wrapped)
    ipcRenderer.on(channel, wrapped)
  },
  sendSync: channel => {
    if (channel !== 'get-path-sep') throw new Error('IPC channel is not allowed')
    return ipcRenderer.sendSync(channel)
  },
})

contextBridge.exposeInMainWorld('electronFunction', {
  'get-zoom-level': () => webFrame.getZoomLevel(),
  'set-zoom-level': (level) => webFrame.setZoomLevel(level),
  'insert-css': (css) => webFrame.insertCSS(css, { cssOrigin: 'user' }),
})
