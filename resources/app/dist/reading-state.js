// One main-process profile backs both interfaces. localStorage below is only a
// compatibility cache; its original values are archived before the first write.
import { normalizeReaderPreferences } from './room-reader-tools.js';
const LEGACY_KEYS = ['room-progress', 'viewerReadingProgress', 'recentRead'];
const validId = id => typeof id === 'string' && id.length > 0 && id.length <= 256 && !['__proto__', 'constructor', 'prototype'].includes(id);
const invoke = (channel, ...args) => window.ipcRenderer.invoke(channel, ...args);
let initialized;

function normalize(value) {
  if (!value || !Number.isSafeInteger(value.page) || !Number.isSafeInteger(value.total) || value.page < 1 || value.total < 1) throw new Error('阅读进度无效');
  return { page: Math.min(value.page, value.total), total: value.total,
    offset: Number.isFinite(value.offset) ? Math.max(0, Math.min(.99, value.offset)) : 0,
    time: Number.isFinite(value.time) ? value.time : Date.now(), source: value.source || 'room' };
}
function normalizeVisit(value) {
  if (!value || !Number.isFinite(value.time) || value.time < 0 || value.time > 8640000000000000 ||
      !['room','classic','comicread','external','migration'].includes(value.source)) throw new Error('阅读记录无效');
  return { time:value.time, source:value.source };
}

export class ReadingProfile {
  constructor(snapshot) {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.pageBase !== 1 || !snapshot.progress) throw new Error('主进程未返回有效阅读档案');
    this.progress = Object.create(null);
    for (const [id, value] of Object.entries(snapshot.progress)) if (validId(id)) this.progress[id] = normalize(value);
    this.preferences = Object.create(null);
    for (const [id, value] of Object.entries(snapshot.preferences || {})) if (validId(id)) this.preferences[id] = normalizeReaderPreferences(value);
    this.pending = new Map();
    this.pendingPreferences = new Map();
    this.visits = Object.assign(Object.create(null), snapshot.visits || {});
    this.pendingVisits = new Map();
    this.timer = 0;
    this.flushing = null;
    this.classicReader = null;
    this.roomReader = null;
    this.comic = null;
    this.classicSession = null;
    this.mirror();
    // Periodic capture reduces unsaved work. The main process additionally
    // awaits flush before native close or quit; pagehide alone is not durable.
    this.captureTimer = setInterval(() => { this.captureClassic(); this.captureComicReader(); }, 400);
    try {
      window.ipcRenderer.on('reading-visit-saved', (_event, payload) => {
        if (validId(payload?.bookId)) this.acceptVisit(payload.bookId, payload.visit);
      });
    } catch { /* Older preload versions still receive the invoke acknowledgement. */ }
    window.addEventListener('pagehide', () => this.flush().catch(error => this.report(error)));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.flush().catch(error => this.report(error)); });
  }
  report(error) {
    console.error('Reading state could not be saved:', error);
    window.dispatchEvent(new CustomEvent('reading-state-error', { detail: error.message || String(error) }));
  }
  get(id) { return this.progress[id]; }
  getPreferences(id, defaults = {}) { return normalizeReaderPreferences(this.preferences[id], defaults); }
  stagePreferences(id, value) {
    if (!validId(id)) throw new Error('书籍 ID 无效');
    const next = normalizeReaderPreferences(value);
    this.preferences[id] = next;
    this.pendingPreferences.set(id, next);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = 0; this.flush().catch(error => this.report(error)); }, 160);
    return next;
  }
  stage(id, value) {
    if (!validId(id)) throw new Error('书籍 ID 无效');
    const next = normalize(value);
    this.progress[id] = next;
    this.pending.set(id, next);
    this.visits[id] = { time: next.time, source: next.source };
    this.mirror();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = 0; this.flush().catch(error => this.report(error)); }, 160);
    return next;
  }
  stageVisit(id, value) {
    if (!validId(id)) throw new Error('书籍 ID 无效');
    const next = normalizeVisit(value);
    if (this.visits[id]?.time > next.time) return this.visits[id];
    this.visits[id] = next;
    this.pendingVisits.set(id, next);
    this.mirror();
    this.notifyVisit(id);
    if (!this.timer) this.timer = setTimeout(() => { this.timer = 0; this.flush().catch(error => this.report(error)); }, 160);
    return next;
  }
  acceptVisit(id, value) {
    if (!validId(id)) throw new Error('书籍 ID 无效');
    const next = normalizeVisit(value), pending = this.pendingVisits.get(id);
    if (pending && pending.time <= next.time) this.pendingVisits.delete(id);
    if (!this.visits[id] || this.visits[id].time <= next.time) this.visits[id] = next;
    this.mirror();
    this.notifyVisit(id);
  }
  notifyVisit(id) { window.dispatchEvent(new CustomEvent('reading-visits-updated', { detail:{bookId:id} })); }
  async visit(id, source = 'external') {
    this.stageVisit(id, { time:Date.now(), source });
    await this.flush({ capture: false });
  }
  async refresh() {
    await this.flush({ capture: false });
    const snapshot = await invoke('load-reading-state');
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.pageBase !== 1) throw new Error('无法载入最新阅读档案');
    // Preserve the shared objects held by the workspace and any progress staged
    // while this IPC was pending. Organizer undo can also remove a record.
    for (const [target, saved, pending] of [[this.progress, snapshot.progress || {}, this.pending],
      [this.preferences, snapshot.preferences || {}, this.pendingPreferences], [this.visits, snapshot.visits || {}, this.pendingVisits]]) {
      for (const id of Object.keys(target)) if (!Object.hasOwn(saved, id) && !pending.has(id)) delete target[id];
      for (const [id, value] of Object.entries(saved)) if (validId(id) && !pending.has(id)) target[id] = value;
    }
    this.mirror();
  }
  async flush({ capture = true } = {}) {
    if (capture) {
      this.roomReader?.();
      this.captureClassic({ throwOnError: true });
      this.captureComicReader({ throwOnError: true });
    }
    clearTimeout(this.timer); this.timer = 0;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      while (this.pending.size || this.pendingPreferences.size || this.pendingVisits.size) {
        if (this.pending.size) {
          const [id, value] = this.pending.entries().next().value;
          const saved = await invoke('save-reading-progress', id, value);
          if (!saved || !Number.isSafeInteger(saved.page)) throw new Error('阅读进度未获得保存确认，请重试');
          if (this.pending.get(id) === value) this.pending.delete(id);
        }
        if (this.pendingPreferences.size) {
          const [id, value] = this.pendingPreferences.entries().next().value;
          const saved = await invoke('save-reading-preferences', id, value);
          if (!saved || !['paged', 'double', 'continuous'].includes(saved.mode)) throw new Error('阅读偏好未获得保存确认，请重试');
          if (this.pendingPreferences.get(id) === value) this.pendingPreferences.delete(id);
        }
        if (this.pendingVisits.size) {
          const [id, value] = this.pendingVisits.entries().next().value;
          const saved = await invoke('save-reading-visit', id, value);
          if (!saved || !Number.isFinite(saved.time)) throw new Error('阅读记录未获得保存确认，请重试');
          if (this.pendingVisits.get(id) === value) this.acceptVisit(id, saved);
        }
      }
    })();
    try { await this.flushing; }
    finally { this.flushing = null; }
  }
  classicEntries() {
    return Object.entries(this.progress).sort((a, b) => b[1].time - a[1].time)
      .map(([bookId, progress]) => ({ bookId, pageId: `${bookId}_${progress.page}` }));
  }
  classicResume(bookId) {
    const progress = this.progress[bookId];
    return progress ? { bookId, pageId: `${bookId}_${progress.page}` } : null;
  }
  mirror() {
    try {
      localStorage.setItem('room-progress', JSON.stringify(this.progress));
      localStorage.setItem('viewerReadingProgress', JSON.stringify(this.classicEntries()));
      const visits = { ...this.visits };
      for (const [id, value] of Object.entries(this.progress)) if (!visits[id] || visits[id].time < value.time) visits[id] = value;
      localStorage.setItem('recentRead', JSON.stringify(Object.entries(visits).filter(([, value]) => value.time > 0)
        .sort((a, b) => a[1].time - b[1].time).slice(-100).map(([id, value]) => ({ id, read_time: Math.floor(value.time / 1000) }))));
    } catch (error) { console.warn('Reading state cache unavailable; the main-process profile remains authoritative.', error); }
  }
  saveClassic(book, pageId, { total = book?.pageCount || book?.filecount, offset = 0, visiblePageIds = [], force = false, mode } = {}) {
    if (!book || typeof pageId !== 'string' || !pageId.startsWith(book.id + '_')) return;
    const suffix = pageId.slice(book.id.length + 1);
    if (!/^[1-9]\d*$/.test(suffix)) return;
    let page = Number(suffix);
    total = Number(total);
    if (!Number.isSafeInteger(total) || total < 1 || page > total) return;
    if (this.classicSession?.id === book.id && !this.classicSession.visited) {
      this.classicSession.visited = true;
      this.stageVisit(book.id, { time:Date.now(), source:'classic' });
    }
    if (['paged','double','continuous'].includes(mode)) {
      const preferences=this.getPreferences(book.id);
      if(preferences.mode!==mode)this.stagePreferences(book.id,{...preferences,mode});
    }
    const old = this.progress[book.id];
    if (old && Array.isArray(visiblePageIds) && visiblePageIds.includes(`${book.id}_${old.page}`)) page = old.page;
    if (!force && old?.page === page && old?.total === total && Math.abs((old.offset || 0) - offset) < .01) return;
    this.stage(book.id, { page, total, offset, time: Date.now(), source: 'classic' });
  }
  registerClassicReader(reader) { this.classicReader = reader; }
  beginClassicSession(id) { this.classicSession = { id, visited:false }; }
  registerRoomReader(reader) { this.roomReader = reader; }
  captureClassic({ throwOnError = false } = {}) {
    try {
      const current = this.classicReader?.();
      if (current?.ready) {
        if (!this.classicSession || this.classicSession.id !== current.book.id) this.beginClassicSession(current.book.id);
        this.saveClassic(current.book, current.pageId, current);
      } else if (this.classicSession?.visited) this.classicSession = null;
    } catch (error) { if (throwOnError) throw error; this.report(error); }
  }
  attachComicReader(reader, book) {
    if (this.comic?.reader === reader && this.comic.book.id === book.id) return;
    this.comic = { reader, book, target: Math.max(0, (this.progress[book.id]?.page || 1) - 1), ready: false, restoring: false, visited:false };
    this.captureComicReader();
  }
  captureComicReader({ throwOnError = false } = {}) {
    const current = this.comic;
    if (!current) return;
    try {
      const { reader, book } = current;
      const pages = reader.store?.pageList;
      if (!Array.isArray(pages) || !pages.length || reader.props?.show === false) return;
      if (!current.ready) {
        if (current.restoring) return;
        // ComicRead pageList contains ZERO-based image indices. Its goto takes
        // a spread index, which can differ in double-page mode.
        const targetSpread = pages.findIndex(page => Array.isArray(page) && page.includes(current.target));
        if (targetSpread < 0) return;
        current.restoring = true;
        reader.goto(targetSpread);
        requestAnimationFrame(() => requestAnimationFrame(() => { if (this.comic === current) current.ready = true; }));
        return;
      }
      const visiblePages = pages[reader.store.activePageIndex];
      let page = visiblePages?.find(index => Number.isInteger(index) && index >= 0);
      const total = Number(reader.props?.imgList?.length || book.pageCount || book.filecount);
      if (!Number.isInteger(page) || !Number.isSafeInteger(total) || total < 1) return;
      if (!current.visited) {
        current.visited = true;
        this.stageVisit(book.id, { time:Date.now(), source:'comicread' });
      }
      const old = this.progress[book.id];
      if (old && visiblePages.includes(old.page - 1)) page = old.page - 1;
      if (old?.page === page + 1 && old?.total === total) return;
      this.stage(book.id, { page: page + 1, total, offset: 0, time: Date.now(), source: 'comicread' });
    } catch (error) { if (throwOnError) throw error; this.report(error); }
  }
  closeComicReader() { this.captureComicReader(); this.comic = null; }
}

export function initializeReadingState() {
  if (!initialized) initialized = (async () => {
    let snapshot = await invoke('load-reading-state');
    if (!snapshot?.migrations?.legacyV1) {
      const legacy = Object.fromEntries(LEGACY_KEYS.map(key => [key, localStorage.getItem(key)]));
      snapshot = await invoke('migrate-reading-state', legacy);
    }
    const profile = new ReadingProfile(snapshot);
    window.readingState = profile;
    return profile;
  })();
  return initialized;
}
