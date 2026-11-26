export type ReadingMode = 'paged' | 'double' | 'continuous';
export type ReadingDirection = 'ltr' | 'rtl';
export type ReadingFit = 'page' | 'width';

export type ReadingProgressSource = 'room' | 'classic' | 'comicread' | 'migration';
export type ReadingVisitSource = 'room' | 'classic' | 'comicread' | 'external' | 'migration';

export interface ReadingProgress {
  page: number;
  total: number;
  offset: number;
  time: number;
  source?: ReadingProgressSource;
}

export interface ReadingPreferences {
  mode: ReadingMode;
  direction: ReadingDirection;
  fit: ReadingFit;
  zoom: number;
  coverAlone: boolean;
}

export interface ReadingVisit {
  time: number;
  source: ReadingVisitSource;
}

export interface ReadingProfile {
  schemaVersion: 1;
  pageBase: 1;
  revision: number;
  progress: Record<string, ReadingProgress>;
  preferences?: Record<string, ReadingPreferences>;
  visits?: Record<string, ReadingVisit>;
  migrations: Record<string, unknown>;
  migrationSnapshots: unknown[];
}

export interface LegacyReadingMigrationPayload {
  'room-progress'?: string | null;
  viewerReadingProgress?: string | null;
  recentRead?: string | null;
}

export interface ReadingVisitSavedEvent {
  bookId: string;
  visit: ReadingVisit;
}
