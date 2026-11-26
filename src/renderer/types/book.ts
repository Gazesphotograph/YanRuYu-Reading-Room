export type TagValue = string | number;
export type TagMap = Record<string, TagValue | TagValue[]>;

export interface BookTag {
  group: string;
  value: string;
  key: string;
  inferred?: boolean;
}

export interface IndexedTag extends BookTag {
  count: number;
}

export type ReadingStatus = 'reading' | 'finished' | 'unread';
export type BookStatus = 'all' | ReadingStatus;

export interface Book {
  id: string;
  title?: string;
  title_jpn?: string;
  coverPath?: string;
  hash?: string;
  identityFingerprint?: string;
  sourceSignature?: string;
  filepath?: string;
  type?: string;
  pageCount?: number;
  bundleSize?: number;
  mtime?: string;
  coverHash?: string;
  status?: string;
  date?: number;
  createdAt?: string;
  updatedAt?: string;
  rating?: number;
  tags?: TagMap | string | null;
  filecount?: number;
  posted?: number;
  filesize?: number;
  category?: string;
  url?: string;
  mark?: boolean;
  hiddenBook?: boolean;
  readCount?: number;
  exist?: boolean;
  pageDiff?: boolean | number | string;
}

export interface FolderTreeNode {
  label: string;
  value: string;
  folderPath: string;
  children?: FolderTreeNode[];
}

export interface Collection {
  id: string;
  title: string;
  list: string[];
}

export interface IndexedCollection {
  id: string;
  title: string;
  ids: Set<string>;
}

export type SearchMode = 'metadata' | 'all' | 'text';
export type SortMode = 'recent' | 'title' | 'author' | 'pages' | 'rating';
export type ViewDensity = 'comfortable' | 'standard' | 'compact';
export type LegacyLibraryView = 'shelf' | 'grid';
export type WorkspaceKind = 'desk' | 'library' | 'room';
export type WorkspaceLibraryView = 'grid' | 'table';

export interface LibraryQuery {
  search: string;
  searchMode: SearchMode;
  folder: string;
  classicQuery: string;
  filter: BookStatus;
  favorites: boolean;
  featured: boolean;
  selectedTags: string[];
  excludedTags: string[];
  collectionId: string;
}

export interface LibraryStateSnapshot extends LibraryQuery {
  sort: SortMode;
  view: LegacyLibraryView;
  density: ViewDensity;
  page: number;
  scrollTop: number;
  tagScrollTop: number;
  tagSearch: string;
  tagGroup: string;
  tagLimit: number;
  shelfId: string;
}

export interface SmartShelf {
  id: string;
  name: string;
  query: LibraryQuery;
}

export interface LibraryPosition {
  page: number;
  scrollTop: number;
  selectedId: string;
}

export type FilteredBookNoticeReason = 'filtered' | 'hidden' | 'removed';

export interface FilteredBookNotice {
  bookId: string;
  reason: FilteredBookNoticeReason;
  message: string;
  canShowBook: boolean;
}

export interface ReturnTarget {
  workspace: WorkspaceKind;
  bookId?: string;
  focusTarget?: 'book' | 'filtered-notice' | 'empty' | 'workspace-nav';
}
