import type { Book, Collection, FolderTreeNode } from './book';
import type {
  LegacyReadingMigrationPayload,
  ReadingPreferences,
  ReadingProfile,
  ReadingProgress,
  ReadingVisit,
  ReadingVisitSavedEvent,
} from './reading';
import type { AppSetting, UiStateSnapshot } from './settings';
import type { TaskKind, TaskRecord, TasksChangedEvent } from './tasks';

export interface FileDialogFilter {
  name: string;
  extensions: string[];
}

export interface PatchBookMetadataResult {
  status?: 'refreshed' | 'missing' | 'invalid' | 'outside-library' | 'excluded' | string;
  book?: Book;
  message?: string;
  [key: string]: unknown;
}

export interface DataLocations {
  storePath: string;
  metadataPath: string;
}

export interface ImageCacheStatus {
  bytes?: number;
  budgetBytes?: number;
  entries?: number;
  [key: string]: unknown;
}

export interface SendActionEvent {
  action: string;
  [key: string]: unknown;
}

export interface LibraryUpdatedEvent {
  taskId?: string;
  kind?: string;
  [key: string]: unknown;
}

export interface ReaderPage {
  absolutePath: string;
  relativePath: string;
}

export interface InvokeChannelMap {
  'load-book-list': { args: [scan?: boolean]; result: Book[] };
  'force-gene-book-list': { args: []; result: Book[] };
  'patch-local-metadata': { args: [arg?: unknown]; result: unknown };
  'patch-local-metadata-by-book': {
    args: [book: Pick<Book, 'id'> & Partial<Book>, options?: { detailed?: boolean }];
    result: PatchBookMetadataResult;
  };
  'get-ehviewer-data': { args: [dir: string]; result: unknown };
  'get-ex-webpage': { args: [params: { url: string; cookie?: string }]; result: string };
  'post-data-ex': { args: [params: { url: string; data: unknown }]; result: unknown };
  'save-book': {
    args: [book: Pick<Book, 'id'> & Partial<Book>, authors?: string[]];
    result: Book;
  };
  'get-folder-tree': { args: [filePathList: Array<string | undefined>]; result: FolderTreeNode[] };
  'load-collection-list': { args: [arg?: unknown]; result: Collection[] };
  'save-collection-list': { args: [list: Collection[]]; result: unknown };
  'open-url': { args: [url: string]; result: void };
  'show-file': { args: [filepath: string]; result: void };
  'use-new-cover': { args: [filepath: string]; result: string | null };
  'open-local-book': { args: [filepath: string, options?: Record<string, unknown>]; result: unknown };
  'delete-local-book': { args: [filepath: string]; result: unknown };
  'move-local-book': { args: [oldPath: string, folderArr: string[]]; result: string | boolean };
  'load-manga-image-list': { args: [book: Book]; result: ReaderPage[] };
  'release-sendimagelock': { args: []; result: void };
  'delete-image': { args: [filename: string, filepath: string, type: string]; result: boolean };
  'select-folder': { args: [title?: string]; result: string | undefined };
  'select-file': { args: [title?: string, filters?: FileDialogFilter[]]; result: string | undefined };
  'load-setting': { args: [arg?: unknown]; result: AppSetting };
  'window-minimize': { args: []; result: void };
  'window-toggle-maximize': { args: []; result: boolean };
  'window-is-maximized': { args: []; result: boolean };
  'window-close': { args: []; result: void };
  'relaunch-app': { args: []; result: void };
  'save-setting': { args: [setting: AppSetting]; result: AppSetting | boolean | void };
  'export-database': { args: [folder?: string]; result: unknown };
  'import-database': { args: [files?: Record<string, unknown>]; result: unknown };
  'import-sqlite': { args: [bookList: Book[]]; result: unknown };
  'set-progress-bar': { args: [progress: number]; result: void };
  'get-locale': { args: [arg?: unknown]; result: string };
  'copy-image-to-clipboard': { args: [filepath: string]; result: void };
  'copy-text-to-clipboard': { args: [text: string]; result: void };
  'read-text-from-clipboard': { args: []; result: string };
  'update-window-title': { args: [title?: string]; result: void };
  'switch-fullscreen': { args: [arg?: unknown]; result: boolean | void };
  'update-tag-translation': { args: [tagTranslation?: unknown]; result: unknown };
  'enable-LAN-browsing': { args: [arg?: unknown]; result: unknown };
  'load-ui-state': { args: []; result: UiStateSnapshot | null };
  'save-ui-state': { args: [snapshot: UiStateSnapshot]; result: UiStateSnapshot };
  'backup-export': { args: [options?: Record<string, unknown>]; result: unknown };
  'backup-inspect': { args: []; result: unknown };
  'backup-restore': { args: [token: string]; result: unknown };
  'archive-recovery-list': { args: []; result: unknown[] };
  'archive-recovery-restore': { args: [id: string]; result: unknown };
  'data-protection-open-recovery': { args: []; result: unknown };
  'load-reading-state': { args: []; result: ReadingProfile };
  'save-reading-progress': { args: [id: string, progress: ReadingProgress]; result: ReadingProgress };
  'save-reading-preferences': { args: [id: string, preferences: ReadingPreferences]; result: ReadingPreferences };
  'save-reading-visit': { args: [id: string, visit: ReadingVisit]; result: ReadingVisit };
  'migrate-reading-state': { args: [payload: LegacyReadingMigrationPayload]; result: ReadingProfile };
  'metadata-source-search': { args: [value: unknown]; result: unknown };
  'metadata-source-preview': { args: [value: unknown]; result: unknown };
  'metadata-source-get-preview': { args: [token: string]; result: unknown };
  'metadata-source-apply': { args: [params: unknown]; result: unknown };
  'metadata-source-save-settings': { args: [patch: Record<string, unknown>]; result: unknown };
  'collection-command': { args: [params: Record<string, unknown>]; result: unknown };
  'book-file-preview-move': { args: [id: string]; result: unknown };
  'book-file-preview-recycle': { args: [id: string]; result: unknown };
  'book-file-apply': { args: [token: string]; result: unknown };
  'data-locations': { args: []; result: DataLocations };
  'import-library-sqlite': { args: [options?: Record<string, unknown>]; result: unknown };
  'task-list': { args: []; result: TaskRecord[] };
  'task-start': { args: [kind: TaskKind, options?: Record<string, unknown>]; result: TaskRecord };
  'task-cancel': { args: [id: string]; result: TaskRecord | boolean | void };
  'task-retry': { args: [id: string]; result: TaskRecord };
  'task-dismiss': { args: [id: string]; result: boolean | void };
  'relocate-book': { args: [bookId: string]; result: { success?: boolean; [key: string]: unknown } };
  'save-library-exclusion': { args: [pattern: string]; result: unknown };
  'image-cache-status': { args: []; result: ImageCacheStatus };
  'image-cache-budget': { args: [bytes: number]; result: ImageCacheStatus };
  'image-cache-clear': { args: []; result: ImageCacheStatus };
  'organizer-catalog': { args: [payload?: Record<string, unknown>]; result: unknown };
  'organizer-preview-batch': { args: [payload: Record<string, unknown>]; result: unknown };
  'organizer-preview-merge': { args: [payload: Record<string, unknown>]; result: unknown };
  'organizer-preview-remove-missing': { args: [payload?: Record<string, unknown>]; result: unknown };
  'organizer-apply': { args: [payload: Record<string, unknown>]; result: unknown };
  'organizer-history': { args: [payload?: Record<string, unknown>]; result: unknown };
  'organizer-undo': { args: [payload: Record<string, unknown>]; result: unknown };
  'organizer-health': { args: [payload?: Record<string, unknown>]; result: unknown };
  'organizer-duplicates': { args: [payload?: Record<string, unknown>]; result: unknown };
  'local-search-command': { args: [payload: Record<string, unknown>]; result: unknown };
  'local-search-ocr-image': { args: [options?: Record<string, unknown>]; result: unknown };
}

export interface EventChannelMap {
  'send-action': SendActionEvent;
  'send-message': string;
  'tasks-changed': TasksChangedEvent;
  'library-updated': LibraryUpdatedEvent;
  'reading-visit-saved': ReadingVisitSavedEvent;
}

export type InvokeChannel = keyof InvokeChannelMap;
export type EventChannel = keyof EventChannelMap;
export type SyncChannel = 'get-path-sep';

export const INVOKE_CHANNELS = [
  'load-book-list',
  'force-gene-book-list',
  'patch-local-metadata',
  'patch-local-metadata-by-book',
  'get-ehviewer-data',
  'get-ex-webpage',
  'post-data-ex',
  'save-book',
  'get-folder-tree',
  'load-collection-list',
  'save-collection-list',
  'open-url',
  'show-file',
  'use-new-cover',
  'open-local-book',
  'delete-local-book',
  'move-local-book',
  'load-manga-image-list',
  'release-sendimagelock',
  'delete-image',
  'select-folder',
  'select-file',
  'load-setting',
  'window-minimize',
  'window-toggle-maximize',
  'window-is-maximized',
  'window-close',
  'relaunch-app',
  'save-setting',
  'export-database',
  'import-database',
  'import-sqlite',
  'set-progress-bar',
  'get-locale',
  'copy-image-to-clipboard',
  'copy-text-to-clipboard',
  'read-text-from-clipboard',
  'update-window-title',
  'switch-fullscreen',
  'update-tag-translation',
  'enable-LAN-browsing',
  'load-ui-state',
  'save-ui-state',
  'backup-export',
  'backup-inspect',
  'backup-restore',
  'archive-recovery-list',
  'archive-recovery-restore',
  'data-protection-open-recovery',
  'load-reading-state',
  'save-reading-progress',
  'save-reading-preferences',
  'save-reading-visit',
  'migrate-reading-state',
  'metadata-source-search',
  'metadata-source-preview',
  'metadata-source-get-preview',
  'metadata-source-apply',
  'metadata-source-save-settings',
  'collection-command',
  'book-file-preview-move',
  'book-file-preview-recycle',
  'book-file-apply',
  'data-locations',
  'import-library-sqlite',
  'task-list',
  'task-start',
  'task-cancel',
  'task-retry',
  'task-dismiss',
  'relocate-book',
  'save-library-exclusion',
  'image-cache-status',
  'image-cache-budget',
  'image-cache-clear',
  'organizer-catalog',
  'organizer-preview-batch',
  'organizer-preview-merge',
  'organizer-preview-remove-missing',
  'organizer-apply',
  'organizer-history',
  'organizer-undo',
  'organizer-health',
  'organizer-duplicates',
  'local-search-command',
  'local-search-ocr-image',
] as const satisfies readonly InvokeChannel[];

export const EVENT_CHANNELS = [
  'send-action',
  'send-message',
  'tasks-changed',
  'library-updated',
  'reading-visit-saved',
] as const satisfies readonly EventChannel[];

export interface PreloadIpcRenderer {
  invoke<K extends InvokeChannel>(
    channel: K,
    ...args: InvokeChannelMap[K]['args']
  ): Promise<InvokeChannelMap[K]['result']>;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on<K extends EventChannel>(
    channel: K,
    listener: (event: null, payload: EventChannelMap[K]) => void
  ): void;
  on(channel: string, listener: (event: null, ...args: unknown[]) => void): void;
  sendSync(channel: SyncChannel): string;
}

export interface ElectronFunctionBridge {
  'get-zoom-level': () => number;
  'set-zoom-level': (level: number) => void;
  'insert-css': (css: string) => Promise<string> | string;
}

declare global {
  interface Window {
    ipcRenderer?: PreloadIpcRenderer;
    electronFunction?: ElectronFunctionBridge;
  }
}
