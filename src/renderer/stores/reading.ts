import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hasIpc, invoke, onEvent } from '../services/ipc';
import type { Book, ReadingStatus } from '../types/book';
import type {
  LegacyReadingMigrationPayload,
  ReadingDirection,
  ReadingFit,
  ReadingMode,
  ReadingPreferences,
  ReadingProfile,
  ReadingProgress,
  ReadingProgressSource,
  ReadingVisit,
  ReadingVisitSource,
} from '../types/reading';

const MAX_PAGE_COUNT = 1_000_000;
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const LEGACY_KEYS = ['room-progress', 'viewerReadingProgress', 'recentRead'] as const;
const VALID_PROGRESS_SOURCES = new Set<ReadingProgressSource>(['room', 'classic', 'comicread', 'migration']);
const VALID_VISIT_SOURCES = new Set<ReadingVisitSource>(['room', 'classic', 'comicread', 'external', 'migration']);
const VALID_MODES = new Set<ReadingMode>(['paged', 'double', 'continuous']);
const FORBIDDEN_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export const DEFAULT_READER_PREFERENCES: Readonly<ReadingPreferences> = Object.freeze({
  mode: 'paged',
  direction: 'ltr',
  fit: 'page',
  zoom: 100,
  coverAlone: true,
});

export function isValidBookId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 256 &&
    !/[\x00-\x1f]/.test(id) &&
    !FORBIDDEN_IDS.has(id)
  );
}

export function normalizeReadingProgress(value: Partial<ReadingProgress> | null | undefined): ReadingProgress {
  if (
    !value ||
    !Number.isSafeInteger(value.page) ||
    !Number.isSafeInteger(value.total) ||
    (value.page as number) < 1 ||
    (value.total as number) < 1 ||
    (value.total as number) > MAX_PAGE_COUNT
  ) {
    throw new Error('阅读进度无效');
  }
  const page = value.page as number;
  const total = value.total as number;
  const normalized: ReadingProgress = {
    page: Math.min(page, total),
    total,
    offset: Number.isFinite(value.offset) ? Math.max(0, Math.min(0.99, value.offset as number)) : 0,
    time: Number.isFinite(value.time) && (value.time as number) >= 0 ? (value.time as number) : Date.now(),
    source:
      typeof value.source === 'string' && VALID_PROGRESS_SOURCES.has(value.source as ReadingProgressSource)
        ? (value.source as ReadingProgressSource)
        : 'room',
  };
  return normalized;
}

export function normalizeReaderPreferences(
  value: Partial<ReadingPreferences> | null | undefined = {},
  defaults: Partial<ReadingPreferences> = {}
): ReadingPreferences {
  const input: Partial<ReadingPreferences> = {
    ...DEFAULT_READER_PREFERENCES,
    ...defaults,
    ...(value && typeof value === 'object' ? value : {}),
  };
  const mode: ReadingMode =
    typeof input.mode === 'string' && VALID_MODES.has(input.mode as ReadingMode)
      ? (input.mode as ReadingMode)
      : 'paged';
  const direction: ReadingDirection = input.direction === 'rtl' ? 'rtl' : 'ltr';
  const fit: ReadingFit = input.fit === 'width' ? 'width' : 'page';
  const zoom = Number.isFinite(input.zoom) ? Math.max(50, Math.min(250, Math.round(input.zoom as number))) : 100;
  const coverAlone = input.coverAlone !== false;
  return { mode, direction, fit, zoom, coverAlone };
}

export function normalizeReadingVisit(value: Partial<ReadingVisit> | null | undefined): ReadingVisit {
  if (
    !value ||
    !Number.isFinite(value.time) ||
    (value.time as number) < 0 ||
    (value.time as number) > MAX_TIMESTAMP ||
    typeof value.source !== 'string' ||
    !VALID_VISIT_SOURCES.has(value.source as ReadingVisitSource)
  ) {
    throw new Error('阅读记录无效');
  }
  return {
    time: value.time as number,
    source: value.source as ReadingVisitSource,
  };
}

export function resolveReadingStatus(
  book: Pick<Book, 'id' | 'readCount'>,
  progress: Record<string, ReadingProgress | undefined> = {},
  visits: Record<string, ReadingVisit | undefined> = {}
): ReadingStatus {
  const saved = progress[book.id];
  if (saved && saved.total > 0 && saved.page >= saved.total) return 'finished';
  return saved || visits[book.id] || (book.readCount ?? 0) > 0 ? 'reading' : 'unread';
}

export function resolveReadingTime(
  book: Pick<Book, 'id'>,
  progress: Record<string, ReadingProgress | undefined> = {},
  visits: Record<string, ReadingVisit | undefined> = {}
): number {
  return Math.max(progress[book.id]?.time || 0, visits[book.id]?.time || 0);
}

export function resolveReadingPercent(
  book: Pick<Book, 'id'>,
  progress: Record<string, ReadingProgress | undefined> = {}
): number {
  const saved = progress[book.id];
  return saved ? Math.min(100, Math.round((saved.page / Math.max(1, saved.total)) * 100)) : 0;
}

function readLegacyMigrationPayload(): LegacyReadingMigrationPayload {
  const payload: LegacyReadingMigrationPayload = {};
  if (typeof localStorage === 'undefined') return payload;
  for (const key of LEGACY_KEYS) {
    try {
      payload[key] = localStorage.getItem(key);
    } catch {
      payload[key] = null;
    }
  }
  return payload;
}

export const useReadingStore = defineStore('reading', () => {
  const loaded = ref(false);
  const revision = ref(0);
  const progress = ref<Record<string, ReadingProgress>>({});
  const preferences = ref<Record<string, ReadingPreferences>>({});
  const visits = ref<Record<string, ReadingVisit>>({});
  const error = ref<string | null>(null);

  const pendingProgress = new Map<string, ReadingProgress>();
  const pendingPreferences = new Map<string, ReadingPreferences>();
  const pendingVisits = new Map<string, ReadingVisit>();

  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let flushingPromise: Promise<void> | null = null;
  let unsubscribeVisitEvent: (() => void) | null = null;

  const hasPendingWrites = computed(
    () => pendingProgress.size > 0 || pendingPreferences.size > 0 || pendingVisits.size > 0
  );

  function scheduleFlush(): void {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush().catch(err => {
        error.value = err instanceof Error ? err.message : String(err);
      });
    }, 160);
  }

  function applyProfileSnapshot(snapshot: ReadingProfile): void {
    if (!snapshot || snapshot.schemaVersion !== 1 || snapshot.pageBase !== 1 || !snapshot.progress) {
      throw new Error('主进程未返回有效阅读档案');
    }
    revision.value = Number.isSafeInteger(snapshot.revision) ? snapshot.revision : 0;

    const nextProgress: Record<string, ReadingProgress> = {};
    for (const [id, value] of Object.entries(snapshot.progress)) {
      if (isValidBookId(id) && !pendingProgress.has(id)) {
        nextProgress[id] = normalizeReadingProgress(value);
      }
    }
    for (const [id, value] of pendingProgress.entries()) {
      nextProgress[id] = value;
    }
    progress.value = nextProgress;

    const nextPreferences: Record<string, ReadingPreferences> = {};
    for (const [id, value] of Object.entries(snapshot.preferences || {})) {
      if (isValidBookId(id) && !pendingPreferences.has(id)) {
        nextPreferences[id] = normalizeReaderPreferences(value);
      }
    }
    for (const [id, value] of pendingPreferences.entries()) {
      nextPreferences[id] = value;
    }
    preferences.value = nextPreferences;

    const nextVisits: Record<string, ReadingVisit> = {};
    for (const [id, value] of Object.entries(snapshot.visits || {})) {
      if (isValidBookId(id) && !pendingVisits.has(id)) {
        nextVisits[id] = normalizeReadingVisit(value);
      }
    }
    for (const [id, value] of pendingVisits.entries()) {
      nextVisits[id] = value;
    }
    visits.value = nextVisits;
  }

  function subscribe(): () => void {
    if (!unsubscribeVisitEvent) {
      unsubscribeVisitEvent = onEvent('reading-visit-saved', payload => {
        if (payload && isValidBookId(payload.bookId) && payload.visit) {
          acceptVisit(payload.bookId, payload.visit);
        }
      });
    }
    return () => {
      unsubscribeVisitEvent?.();
      unsubscribeVisitEvent = null;
    };
  }

  async function load(): Promise<void> {
    error.value = null;
    if (!hasIpc()) {
      loaded.value = true;
      return;
    }
    subscribe();
    try {
      let snapshot = await invoke('load-reading-state');
      if (!snapshot?.migrations?.legacyV1) {
        snapshot = await invoke('migrate-reading-state', readLegacyMigrationPayload());
      }
      applyProfileSnapshot(snapshot);
      loaded.value = true;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function refresh(): Promise<void> {
    if (!hasIpc()) return;
    await flush();
    const snapshot = await invoke('load-reading-state');
    applyProfileSnapshot(snapshot);
    loaded.value = true;
  }

  function readingStatus(book: Pick<Book, 'id' | 'readCount'>): ReadingStatus {
    return resolveReadingStatus(book, progress.value, visits.value);
  }

  function readingTime(book: Pick<Book, 'id'>): number {
    return resolveReadingTime(book, progress.value, visits.value);
  }

  function readingPercent(book: Pick<Book, 'id'>): number {
    return resolveReadingPercent(book, progress.value);
  }

  function getProgress(bookId: string): ReadingProgress | undefined {
    return progress.value[bookId];
  }

  function getPreferences(bookId: string, defaults: Partial<ReadingPreferences> = {}): ReadingPreferences {
    return normalizeReaderPreferences(preferences.value[bookId], defaults);
  }

  async function saveProgress(
    bookId: string,
    value: Partial<ReadingProgress>,
    options: { immediate?: boolean } = {}
  ): Promise<ReadingProgress> {
    if (!isValidBookId(bookId)) throw new Error('书籍 ID 无效');
    const next = normalizeReadingProgress(value);
    progress.value = { ...progress.value, [bookId]: next };
    visits.value = { ...visits.value, [bookId]: { time: next.time, source: next.source || 'room' } };
    pendingProgress.set(bookId, next);
    if (options.immediate) {
      await flush();
    } else if (hasIpc()) {
      scheduleFlush();
    }
    return next;
  }

  async function savePreferences(
    bookId: string,
    value: Partial<ReadingPreferences>,
    options: { immediate?: boolean } = {}
  ): Promise<ReadingPreferences> {
    if (!isValidBookId(bookId)) throw new Error('书籍 ID 无效');
    const next = normalizeReaderPreferences(value);
    preferences.value = { ...preferences.value, [bookId]: next };
    pendingPreferences.set(bookId, next);
    if (options.immediate) {
      await flush();
    } else if (hasIpc()) {
      scheduleFlush();
    }
    return next;
  }

  function acceptVisit(bookId: string, value: Partial<ReadingVisit>): ReadingVisit {
    if (!isValidBookId(bookId)) throw new Error('书籍 ID 无效');
    const next = normalizeReadingVisit(value);
    const pending = pendingVisits.get(bookId);
    if (pending && pending.time <= next.time) {
      pendingVisits.delete(bookId);
    }
    const existing = visits.value[bookId];
    if (!existing || existing.time <= next.time) {
      visits.value = { ...visits.value, [bookId]: next };
    }
    return visits.value[bookId];
  }

  async function saveVisit(
    bookId: string,
    value: Partial<ReadingVisit>,
    options: { immediate?: boolean } = {}
  ): Promise<ReadingVisit> {
    if (!isValidBookId(bookId)) throw new Error('书籍 ID 无效');
    const next = normalizeReadingVisit(value);
    const existing = visits.value[bookId];
    if (existing && existing.time > next.time) {
      return existing;
    }
    visits.value = { ...visits.value, [bookId]: next };
    pendingVisits.set(bookId, next);
    if (options.immediate) {
      await flush();
    } else if (hasIpc()) {
      scheduleFlush();
    }
    return next;
  }

  async function flush(): Promise<void> {
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    if (!hasIpc()) {
      pendingProgress.clear();
      pendingPreferences.clear();
      pendingVisits.clear();
      return;
    }
    if (flushingPromise) return flushingPromise;

    flushingPromise = (async () => {
      while (pendingProgress.size > 0 || pendingPreferences.size > 0 || pendingVisits.size > 0) {
        if (pendingProgress.size > 0) {
          const entry = pendingProgress.entries().next().value as [string, ReadingProgress];
          const [id, value] = entry;
          const saved = await invoke('save-reading-progress', id, value);
          if (!saved || !Number.isSafeInteger(saved.page)) {
            throw new Error('阅读进度未获得保存确认，请重试');
          }
          if (pendingProgress.get(id) === value) pendingProgress.delete(id);
        }
        if (pendingPreferences.size > 0) {
          const entry = pendingPreferences.entries().next().value as [string, ReadingPreferences];
          const [id, value] = entry;
          const saved = await invoke('save-reading-preferences', id, value);
          if (!saved || !VALID_MODES.has(saved.mode)) {
            throw new Error('阅读偏好未获得保存确认，请重试');
          }
          if (pendingPreferences.get(id) === value) pendingPreferences.delete(id);
        }
        if (pendingVisits.size > 0) {
          const entry = pendingVisits.entries().next().value as [string, ReadingVisit];
          const [id, value] = entry;
          const saved = await invoke('save-reading-visit', id, value);
          if (!saved || !Number.isFinite(saved.time)) {
            throw new Error('阅读记录未获得保存确认，请重试');
          }
          if (pendingVisits.get(id) === value) {
            acceptVisit(id, saved);
          }
        }
      }
    })();

    try {
      await flushingPromise;
      error.value = null;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      flushingPromise = null;
    }
  }

  return {
    loaded,
    revision,
    progress,
    preferences,
    visits,
    error,
    hasPendingWrites,
    load,
    refresh,
    subscribe,
    readingStatus,
    readingTime,
    readingPercent,
    getProgress,
    getPreferences,
    saveProgress,
    savePreferences,
    saveVisit,
    acceptVisit,
    flush,
    applyProfileSnapshot,
  };
});
