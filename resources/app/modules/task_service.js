'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { serialQueue } = require('./safety')
const { checkCancelled } = require('./source_signature')

const ACTIVE = new Set(['queued', 'running', 'cancelling'])
const RETRYABLE = new Set(['failed', 'cancelled', 'interrupted', 'completed-with-errors'])
const copy = value => JSON.parse(JSON.stringify(value))

class TaskService {
  constructor({ storePath, onChange = () => {}, historyLimit = 60 } = {}) {
    this.filePath = storePath ? path.join(storePath, 'task-state.json') : null
    this.onChange = onChange
    this.historyLimit = historyLimit
    this.tasks = new Map()
    this.runners = new Map()
    this.retryStarts = new Map()
    this.lanes = new Set()
    this.persistQueue = serialQueue()
    this.ready = this.readHistory()
  }

  async readHistory() {
    if (!this.filePath) return
    try {
      const stat = await fs.promises.stat(this.filePath)
      if (stat.size > 8 * 1024 ** 2) throw new Error('任务历史文件过大')
      const document = JSON.parse(await fs.promises.readFile(this.filePath, 'utf8'))
      if (document.version !== 1 || !Array.isArray(document.tasks)) throw new Error('任务历史格式无效')
      for (const record of document.tasks.slice(-this.historyLimit)) {
        if (!record || typeof record.id !== 'string' || typeof record.kind !== 'string' || !record.params || typeof record.params !== 'object') continue
        const snapshot = { ...record, errors: Array.isArray(record.errors) ? record.errors.slice(0, 500) : [] }
        const params = snapshot.params, key = snapshot.key
        delete snapshot.params
        delete snapshot.key
        if (ACTIVE.has(snapshot.status)) {
          snapshot.status = 'interrupted'
          snapshot.message = '上次运行中断，可以重试；增量扫描会跳过已完成的书籍'
          snapshot.finishedAt = Date.now()
        }
        this.tasks.set(snapshot.id, { snapshot, params, key, retryOf: snapshot.retryOf })
      }
    } catch (error) {
      if (error.code === 'ENOENT') return
      // Preserve a malformed history before the first new task is persisted.
      await fs.promises.rename(this.filePath, this.filePath + '.invalid-' + Date.now()).catch(() => {})
      this.historyWarning = '上次任务历史无法读取，书库和阅读档案不受影响'
    }
  }

  register(kind, runner, { lane = kind, title = kind } = {}) {
    this.runners.set(kind, { runner, lane, title })
  }

  snapshot(record) {
    const value = copy(record.snapshot)
    value.canCancel = ACTIVE.has(value.status) && value.status !== 'cancelling'
    value.canRetry = RETRYABLE.has(value.status) && this.runners.has(value.kind)
    return value
  }

  async list() {
    await this.ready
    return [...this.tasks.values()].map(record => this.snapshot(record)).sort((a, b) => b.createdAt - a.createdAt)
  }

  async start(kind, params = {}, { key, retryOf } = {}) {
    await this.ready
    const definition = this.runners.get(kind)
    if (!definition) throw new Error('不支持的任务类型')
    if (key) {
      const existing = [...this.tasks.values()].find(record => record.key === key && ACTIVE.has(record.snapshot.status))
      if (existing) { if (!existing.persisted) await existing.admission; return this.snapshot(existing) }
    }
    const now = Date.now()
    let resolve, reject, admit, deny
    const done = new Promise((res, rej) => { resolve = res; reject = rej })
    const admission = new Promise((res, rej) => { admit = res; deny = rej })
    admission.catch(() => {})
    // Fire-and-forget tasks still retain a rejecting promise for callers that wait.
    done.catch(() => {})
    const record = {
      params: copy(params), key, retryOf, persisted: false, controller: new AbortController(), done, resolve, reject, admission,
      snapshot: { id: randomUUID(), kind, title: typeof definition.title === 'function' ? definition.title(params) : definition.title,
        status: 'queued', phase: 'queued', current: 0, total: 0, progress: null, message: '等待处理',
        errors: [], errorCount: 0, createdAt: now, updatedAt: now, ...(retryOf ? { retryOf } : {}) }
    }
    this.tasks.set(record.snapshot.id, record)
    this.trim()
    try { await this.persist(); record.persisted = true; admit() }
    catch (error) {
      this.tasks.delete(record.snapshot.id)
      deny(error)
      record.reject(error)
      this.notify()
      throw error
    }
    this.notify()
    queueMicrotask(() => this.pump())
    return this.snapshot(record)
  }

  async run(kind, params, options) {
    const task = await this.start(kind, params, options)
    return this.wait(task.id)
  }

  async wait(id) {
    await this.ready
    const record = this.tasks.get(id)
    if (!record?.done) throw new Error('此任务已经结束，请从任务中心重试')
    return record.done
  }

  report(record, update = {}) {
    if (!ACTIVE.has(record.snapshot.status)) return
    const value = record.snapshot
    for (const field of ['phase', 'message', 'filepath']) if (typeof update[field] === 'string') value[field] = update[field].slice(0, 4096)
    for (const field of ['current', 'total']) if (Number.isFinite(update[field]) && update[field] >= 0) value[field] = Math.floor(update[field])
    value.progress = value.total > 0 ? Math.min(1, value.current / value.total) : null
    if (Number.isFinite(update.progress)) value.progress = Math.max(0, Math.min(1, update.progress))
    value.updatedAt = Date.now()
    this.scheduleNotify()
  }

  addError(record, failure) {
    record.snapshot.errorCount++
    if (record.snapshot.errors.length < 500) record.snapshot.errors.push({
      filepath: String(failure.filepath || '').slice(0, 4096), bookId: String(failure.bookId || '').slice(0, 128),
      message: String(failure.message || failure.error || failure).slice(0, 4096), phase: String(failure.phase || '').slice(0, 100)
    })
    this.scheduleNotify()
  }

  pump() {
    for (const record of this.tasks.values()) {
      if (record.snapshot.status !== 'queued' || !record.persisted) continue
      const definition = this.runners.get(record.snapshot.kind)
      if (!definition || this.lanes.has(definition.lane)) continue
      this.lanes.add(definition.lane)
      this.execute(record, definition).catch(() => {})
    }
  }

  async execute(record, definition) {
    record.snapshot.status = 'running'
    record.snapshot.startedAt = Date.now()
    this.report(record, { phase: 'prepare', message: '正在准备' })
    this.notify()
    let result, error
    try {
      checkCancelled(record.controller.signal)
      result = await definition.runner(copy(record.params), {
        id: record.snapshot.id, signal: record.controller.signal,
        report: value => this.report(record, value), error: value => this.addError(record, value),
        checkpoint: () => checkCancelled(record.controller.signal)
      })
      record.snapshot.status = record.controller.signal.aborted || result?.cancelled ? 'cancelled'
        : record.snapshot.errorCount || result?.failures ? 'completed-with-errors' : 'completed'
      if (result && !Array.isArray(result)) {
        const summary = {}
        for (const field of ['changed', 'count', 'failures', 'processed', 'added', 'updated', 'unchanged', 'relocated', 'cancelled']) {
          if (['number', 'boolean'].includes(typeof result[field])) summary[field] = result[field]
        }
        record.snapshot.result = summary
      }
      record.snapshot.message = record.snapshot.status === 'cancelled' ? '已取消；已完成的书目保持可用，可以重试继续'
        : record.snapshot.status === 'completed-with-errors' ? '处理结束，部分项目失败，请查看明细后重试' : '已完成'
      if (record.snapshot.status === 'completed') record.snapshot.progress = 1
    } catch (caught) {
      error = caught
      const cancelled = record.controller.signal.aborted || caught.name === 'AbortError' || caught.code === 'ABORT_ERR'
      record.snapshot.status = cancelled ? 'cancelled' : 'failed'
      record.snapshot.message = cancelled ? '已取消，可以重试继续' : caught.message || String(caught)
      if (!cancelled) this.addError(record, { message: caught.message || String(caught) })
    } finally {
      record.snapshot.finishedAt = record.snapshot.updatedAt = Date.now()
      this.lanes.delete(definition.lane)
      this.trim()
      try { await this.persist() }
      catch (persistError) { record.snapshot.historyWarning = '任务结果已生效，但任务历史保存失败：' + persistError.message }
      this.notify()
      if (error) record.reject(error)
      else record.resolve(result)
      this.pump()
    }
  }

  async cancel(id) {
    await this.ready
    const record = this.tasks.get(id)
    if (!record) throw new Error('任务不存在')
    if (!ACTIVE.has(record.snapshot.status)) return this.snapshot(record)
    record.controller?.abort()
    if (record.snapshot.status === 'queued') {
      record.snapshot.status = 'cancelled'
      record.snapshot.message = '已取消，尚未开始'
      record.snapshot.finishedAt = Date.now()
      record.resolve?.({ cancelled: true, changed: false })
    } else {
      record.snapshot.status = 'cancelling'
      record.snapshot.message = '正在安全停止当前操作…'
    }
    await this.persist()
    this.notify()
    this.pump()
    return this.snapshot(record)
  }

  async retry(id) {
    await this.ready
    const record = this.tasks.get(id)
    if (!record || !RETRYABLE.has(record.snapshot.status)) throw new Error('此任务当前不能重试')
    if (this.retryStarts.has(id)) return this.retryStarts.get(id)
    const active = [...this.tasks.values()].find(item => item.retryOf === id && ACTIVE.has(item.snapshot.status))
    if (active) return this.snapshot(active)
    const pending = this.start(record.snapshot.kind, record.params, { key: record.key || 'retry:' + id, retryOf: id })
    this.retryStarts.set(id, pending)
    try { return await pending }
    finally { if (this.retryStarts.get(id) === pending) this.retryStarts.delete(id) }
  }

  async dismiss(id) {
    await this.ready
    const record = this.tasks.get(id)
    if (record && ACTIVE.has(record.snapshot.status)) throw new Error('请先停止正在运行的任务')
    this.tasks.delete(id)
    await this.persist()
    this.notify()
    return true
  }

  async stopAll({ wait = true } = {}) {
    await this.ready
    const active = [...this.tasks.values()].filter(record => ACTIVE.has(record.snapshot.status))
    await Promise.all(active.map(record => this.cancel(record.snapshot.id)))
    if (wait) await Promise.allSettled(active.map(record => record.done))
    await this.persist()
  }

  trim() {
    const finished = [...this.tasks.values()].filter(record => !ACTIVE.has(record.snapshot.status))
    while (this.tasks.size > this.historyLimit && finished.length) this.tasks.delete(finished.shift().snapshot.id)
  }

  scheduleNotify() {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.notify()
      this.persist().catch(() => {})
    }, 120)
    this.notifyTimer.unref?.()
  }

  notify() {
    try { this.onChange([...this.tasks.values()].map(record => this.snapshot(record)).sort((a, b) => b.createdAt - a.createdAt)) } catch {}
  }

  persist() {
    if (!this.filePath) return Promise.resolve()
    return this.persistQueue(async () => {
      const records = [...this.tasks.values()].map(record => ({ ...record.snapshot, params: record.params, key: record.key }))
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = this.filePath + '.tmp'
      await fs.promises.writeFile(temporary, JSON.stringify({ version: 1, tasks: records }))
      await fs.promises.rename(temporary, this.filePath)
    })
  }
}

module.exports = { TaskService }
