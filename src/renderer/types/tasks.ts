export type TaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'completed'
  | 'completed-with-errors'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

export type KnownTaskKind =
  | 'scan'
  | 'rebuild'
  | 'metadata'
  | 'metadata-search'
  | 'metadata-fetch'
  | 'metadata-batch'
  | 'sqlite-import'
  | 'extract'
  | 'relocate';

export type TaskKind = KnownTaskKind | (string & {});

export interface TaskErrorItem {
  filepath?: string;
  bookId?: string;
  message: string;
  phase?: string;
}

export interface TaskResult {
  added?: number;
  updated?: number;
  unchanged?: number;
  relocated?: number;
  skipped?: number;
  failures?: number;
  imported?: number;
  unmatched?: number;
  previewId?: string;
  [key: string]: unknown;
}

export interface TaskRecord {
  id: string;
  kind: TaskKind;
  title: string;
  status: TaskStatus;
  phase?: string;
  current: number;
  total: number;
  progress: number | null;
  message: string;
  filepath?: string;
  errors: TaskErrorItem[];
  errorCount: number;
  result?: TaskResult | null;
  historyWarning?: string;
  canCancel?: boolean;
  canRetry?: boolean;
  retryOf?: string;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface TasksChangedEvent {
  tasks: TaskRecord[];
}
