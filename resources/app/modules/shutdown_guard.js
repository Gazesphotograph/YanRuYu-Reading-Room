'use strict'

// A native close event cannot await pagehide. Evaluate one fixed application
// function in the still-live renderer, wait for its async acknowledgement, then
// drain the main-process writes before allowing Electron's normal lifecycle.
const RENDERER_FLUSH_SCRIPT = `(async () => {
  const profile = globalThis.readingState;
  if (profile) await profile.flush();
  const preferences = globalThis.YanruyuClientState;
  if (preferences) await preferences.flush();
  return { saved: true, readingProfile: Boolean(profile) };
})()`

function withTimeout(task, milliseconds) {
  let timer
  return Promise.race([
    Promise.resolve().then(task),
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('保存确认超时；请等待当前任务完成后重试关闭')), milliseconds)
    })
  ]).finally(() => clearTimeout(timer))
}

function createShutdownGuard({ app, getWindow, flushMain, setQuitting, reportError,
  bypass = () => false, timeoutMs = 10000, flushRenderer = async win => {
    if (!win || win.isDestroyed()) return { saved: true, readingProfile: false }
    return win.webContents.executeJavaScript(RENDERER_FLUSH_SCRIPT)
  } }) {
  let quitApproved = false
  let pending = null
  const closeApproved = new WeakSet()
  const live = win => win && !win.isDestroyed()
  const flush = win => withTimeout(async () => {
    const receipt = await flushRenderer(win)
    if (receipt?.saved !== true) throw new Error('阅读档案未收到保存确认')
    await flushMain(receipt)
    return true
  }, timeoutMs)
  const report = (error, win) => {
    if (live(win)) win.setEnabled?.(true)
    setQuitting(false)
    reportError(error, win)
  }
  const request = (kind, win) => {
    if (pending) {
      if (kind === 'relaunch' || (kind === 'quit' && pending.kind !== 'relaunch')) {
        pending.kind = kind
        setQuitting(true)
      }
      return pending.promise
    }
    const action = { kind, win, promise: null }
    pending = action
    if (kind !== 'close') setQuitting(true)
    if (live(win)) win.setEnabled?.(false)
    action.promise = flush(win).then(() => {
      if (pending !== action) return false
      pending = null
      if (live(win)) win.setEnabled?.(true)
      if (action.kind === 'quit' || action.kind === 'relaunch') {
        // Electron remembers relaunch() until the next exit. Schedule it only
        // after every save succeeded, so a cancelled restart cannot leak into
        // a later ordinary quit.
        if (action.kind === 'relaunch') app.relaunch()
        quitApproved = true
        setQuitting(true)
        app.quit()
      } else if (live(win)) {
        closeApproved.add(win)
        try { win.close() } finally { closeApproved.delete(win) }
      }
      return true
    }).catch(error => {
      if (pending === action) pending = null
      report(error, win)
      return false
    })
    return action.promise
  }
  return {
    beforeQuit(event) {
      // A restore has already replaced the store and must never flush the old
      // renderer into it. Before the first window exists there is no renderer
      // state to lose, so the startup tray can still exit immediately.
      const win = getWindow()
      if (quitApproved || bypass() || (!pending && !live(win))) {
        quitApproved = true
        setQuitting(true)
        return
      }
      event.preventDefault()
      return request('quit', win)
    },
    windowClose(event, win) {
      if (quitApproved || bypass() || closeApproved.has(win)) return
      event.preventDefault()
      return request('close', win)
    },
    relaunch() {
      if (bypass()) return Promise.reject(new Error('恢复正在完成，请等待重启'))
      return request('relaunch', getWindow())
    },
    // Hiding a window does not terminate its renderer. Preserve the immediate
    // close-to-tray interaction but surface any failed background capture.
    hideToTray(win) {
      if (bypass() || quitApproved) return Promise.resolve(true)
      return flush(win).catch(error => { if (!pending) report(error, win); return false })
    },
    wait: () => pending?.promise || Promise.resolve(true)
  }
}

module.exports = { RENDERER_FLUSH_SCRIPT, withTimeout, createShutdownGuard }
