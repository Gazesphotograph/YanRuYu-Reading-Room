import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hasIpc, invoke } from '../services/ipc';
import { resolveReadingStatus, resolveReadingTime, useReadingStore } from './reading';
import type {
  Book,
  BookStatus,
  BookTag,
  Collection,
  FolderTreeNode,
  IndexedCollection,
  IndexedTag,
  LegacyLibraryView,
  LibraryQuery,
  LibraryStateSnapshot,
  ReadingStatus,
  SearchMode,
  SmartShelf,
  SortMode,
  ViewDensity,
  WorkspaceLibraryView,
} from '../types/book';
import type { ReadingProgress, ReadingVisit } from '../types/reading';

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

export const TAG_GROUPS: Readonly<Record<string, string>> = Object.freeze({
  artist: '作者',
  group: '社团',
  parody: '原作',
  character: '角色',
  language: '语言',
  male: '男性',
  female: '女性',
  mixed: '混合',
  other: '其他',
  misc: '其他',
  reclass: '分类',
  cosplayer: '角色扮演者',
});

export const GRID_DENSITIES: Readonly<Record<ViewDensity, number>> = Object.freeze({
  comfortable: 12,
  standard: 24,
  compact: 48,
});

const CLASSIC_TAG_ABBREVIATIONS = new Map<string, string>(
  Object.entries({
    language: 'l',
    parody: 'p',
    character: 'c',
    group: 'g',
    artist: 'a',
    female: 'f',
    male: 'm',
    mixed: 'x',
    other: 'o',
    cosplayer: 'cos',
  })
);

const CHINESE_FILENAME_PATTERN =
  /[\[【(]\s*(?:chinese|中文|简体中文|繁体中文|簡體中文|繁體中文|汉化|漢化|中国翻訳|中國翻譯)\s*[\]】)]/i;

export interface BookIndexMetadata {
  tags: BookTag[];
  authors: string[];
  keys: Set<string>;
  relativePath: string;
  search: string;
  classicText?: string;
}

export interface LibrarySelectOptions {
  search?: string;
  folder?: string;
  classicQuery?: string;
  selectedTags?: string[];
  excludedTags?: string[];
  collectionId?: string;
  favorites?: boolean;
  filter?: BookStatus;
  sort?: SortMode;
  progress?: Record<string, ReadingProgress | undefined>;
  visits?: Record<string, ReadingVisit | undefined>;
  bookIds?: Set<string> | null;
}

export interface LibrarySummary {
  books: Book[];
  counts: Record<ReadingStatus, number>;
  favoriteCount: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function choice<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function clampText(value: unknown, max = 1000): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function tagKey(group: string, value: string): string {
  return JSON.stringify([group, value]);
}

export function describeTag(key: string): BookTag {
  try {
    const pair = JSON.parse(key);
    if (Array.isArray(pair) && pair.length === 2) {
      return { group: String(pair[0]), value: String(pair[1]), key };
    }
  } catch {
    // Fallback to raw label in 'other' group.
  }
  return { group: 'other', value: String(key), key };
}

export function bookTitle(book: Pick<Book, 'title_jpn' | 'title'>): string {
  return book.title_jpn || book.title || '未命名书籍';
}

export function bookPageCount(book: Pick<Book, 'pageCount' | 'filecount'>): number {
  const n = Number(book.pageCount || book.filecount);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function bookTags(book: Pick<Book, 'tags' | 'filepath'>): BookTag[] {
  let rawTags: unknown = book.tags;
  if (typeof rawTags === 'string') {
    try {
      rawTags = JSON.parse(rawTags);
    } catch {
      rawTags = {};
    }
  }
  const tagObject: Record<string, unknown> = isRecord(rawTags) ? rawTags : {};
  const seen = new Set<string>();
  const result: BookTag[] = [];

  for (const [group, items] of Object.entries(tagObject)) {
    const list = Array.isArray(items) ? items : [items];
    for (const item of list) {
      if (typeof item !== 'string' && typeof item !== 'number') continue;
      const value = String(item).trim();
      const key = tagKey(group, value);
      if (!value || seen.has(key)) continue;
      seen.add(key);
      result.push({ group, value, key });
    }
  }

  if (!result.some(tag => tag.group === 'language')) {
    const filename = String(book.filepath || '')
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .pop()
      ?.normalize('NFKC');
    if (filename && CHINESE_FILENAME_PATTERN.test(filename)) {
      result.push({
        group: 'language',
        value: 'chinese',
        key: tagKey('language', 'chinese'),
        inferred: true,
      });
    }
  }

  return result;
}

export function compareAuthors(a: readonly string[], b: readonly string[]): number {
  if (!a.length) return b.length ? 1 : 0;
  if (!b.length) return -1;
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i++) {
    const order = collator.compare(a[i], b[i]);
    if (order !== 0) return order;
  }
  return a.length - b.length;
}

function classicText(book: Book, tags: readonly BookTag[]): string {
  const fields: Record<string, unknown> = {
    title: book.title,
    title_jpn: book.title_jpn,
    status: book.status,
    filepath: book.filepath,
    url: book.url,
    pageDiff: book.pageDiff,
  };
  const groups = new Map<string, string[]>();
  for (const { group, value } of tags) {
    let list = groups.get(group);
    if (!list) {
      list = [];
      groups.set(group, list);
    }
    list.push(value);
  }
  fields.tags = [...groups].map(([group, values]) => [
    ...values.map(value => `${CLASSIC_TAG_ABBREVIATIONS.get(group) || group}:${value}`),
    ...values.map(value => `${group}:${value}`),
  ]);
  fields.category = `cat:${book.category}`;
  return JSON.stringify(fields).toLowerCase();
}

type ClassicPredicate = (book: Book, metadata: BookIndexMetadata) => boolean;

function compileClassicComparison(term: string): ClassicPredicate {
  const rule = /^:(mtime|atime|ptime|count)([<>=])(.*)$/.exec(term);
  if (!rule) return () => false;
  const [, field, operator, value] = rule;
  if (field === 'count') {
    const count = Number.parseInt(value, 10);
    return book => {
      const readCount = book.readCount ?? 0;
      if (operator === '=') return readCount === count;
      return operator === '>' ? readCount > count : readCount < count;
    };
  }
  const expected = new Date(value);
  return book => {
    const rawDate =
      field === 'ptime'
        ? (book.posted ?? 0) * 1000
        : field === 'mtime'
          ? book.mtime ?? 0
          : book.date ?? 0;
    const date = new Date(rawDate);
    if (operator === '=') return date.toLocaleDateString() === expected.toLocaleDateString();
    return operator === '>' ? date >= expected : date <= expected;
  };
}

export function compileClassicQuery(query: string): ClassicPredicate | null {
  if (!query) return null;
  const required: ClassicPredicate[] = [];
  const alternatives: ClassicPredicate[] = [];
  for (const term of query.split(/\s+(?=(?:[^'"]*['"][^'"]*['"])*[^'"]*$)/)) {
    if (term.startsWith(':')) {
      required.push(compileClassicComparison(term));
      continue;
    }
    const alternative = term.startsWith('~');
    const excluded = term.startsWith('-');
    const literal = (alternative || excluded ? term.slice(1) : term)
      .replace(/["']/g, '')
      .replace(/\$/g, '"')
      .toLowerCase();
    const matches: ClassicPredicate = (book, metadata) => {
      metadata.classicText ??= classicText(book, metadata.tags);
      return metadata.classicText.includes(literal) !== excluded;
    };
    (alternative ? alternatives : required).push(matches);
  }
  return (book, metadata) =>
    required.every(test => test(book, metadata)) || alternatives.some(test => test(book, metadata));
}

function normalizeTagKeys(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const valid = input.filter((value): value is string => {
    if (typeof value !== 'string' || value.length > 600) return false;
    try {
      const pair = JSON.parse(value);
      return (
        Array.isArray(pair) &&
        pair.length === 2 &&
        pair.every(part => typeof part === 'string' && part.length > 0)
      );
    } catch {
      return false;
    }
  });
  return [...new Set(valid)].slice(0, 200).sort();
}

export function normalizeShelfQuery(input: Partial<LibraryQuery> | unknown = {}): LibraryQuery {
  const value = isRecord(input) ? input : {};
  const selectedTags = normalizeTagKeys(value.selectedTags);
  return {
    search: clampText(value.search),
    searchMode: choice<SearchMode>(value.searchMode, ['metadata', 'all', 'text'], 'metadata'),
    folder: clampText(value.folder, 32767).replaceAll('\\', '/'),
    classicQuery: clampText(value.classicQuery),
    filter: choice<BookStatus>(value.filter, ['all', 'reading', 'finished', 'unread'], 'all'),
    favorites: value.favorites === true,
    featured: value.featured === true,
    selectedTags,
    excludedTags: normalizeTagKeys(value.excludedTags).filter(key => !selectedTags.includes(key)),
    collectionId: clampText(value.collectionId, 200),
  };
}

export function normalizeLibraryState(
  input: unknown,
  defaults: Partial<Pick<LibraryStateSnapshot, 'sort' | 'view'>> = {}
): LibraryStateSnapshot {
  const value = isRecord(input) ? input : {};
  return {
    ...normalizeShelfQuery(value),
    sort: choice<SortMode>(value.sort || defaults.sort, ['recent', 'title', 'author', 'pages', 'rating'], 'recent'),
    view: choice<LegacyLibraryView>(value.view || defaults.view, ['shelf', 'grid'], 'shelf'),
    density: choice<ViewDensity>(value.density, ['comfortable', 'standard', 'compact'], 'comfortable'),
    page: Number.isSafeInteger(value.page) && (value.page as number) > 0 ? Math.min(value.page as number, 1_000_000) : 1,
    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, Math.min(value.scrollTop as number, 10_000_000)) : 0,
    tagScrollTop: Number.isFinite(value.tagScrollTop)
      ? Math.max(0, Math.min(value.tagScrollTop as number, 10_000_000))
      : 0,
    tagSearch: clampText(value.tagSearch, 200),
    tagGroup: clampText(value.tagGroup, 100),
    tagLimit: Number.isSafeInteger(value.tagLimit)
      ? Math.max(40, Math.min(value.tagLimit as number, 10_000))
      : 40,
    shelfId: clampText(value.shelfId, 100),
  };
}

export function normalizeSmartShelves(input: unknown): SmartShelf[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: SmartShelf[] = [];
  for (const item of input.slice(0, 100)) {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) ||
      seen.has(item.id) ||
      typeof item.name !== 'string' ||
      !item.name.trim()
    ) {
      continue;
    }
    seen.add(item.id);
    result.push({
      id: item.id,
      name: item.name.trim().slice(0, 80),
      query: normalizeShelfQuery(item.query),
    });
  }
  return result;
}

export function shelfMatches(shelf: SmartShelf | undefined | null, state: Partial<LibraryQuery>): boolean {
  return !!shelf && JSON.stringify(normalizeShelfQuery(shelf.query)) === JSON.stringify(normalizeShelfQuery(state));
}

export function booksPerPage(view: LegacyLibraryView | WorkspaceLibraryView, density: ViewDensity): number {
  return view === 'grid' || view === 'table'
    ? GRID_DENSITIES[density] || GRID_DENSITIES.comfortable
    : 12;
}

export class LibraryIndex {
  readonly books: Book[];
  readonly metadata: Map<string, BookIndexMetadata>;
  readonly tags: Map<string, IndexedTag>;
  readonly collections: Map<string, IndexedCollection>;
  readonly rankedTags: IndexedTag[];
  private readonly orders: Map<SortMode, Book[]>;

  constructor(books: readonly Book[] = [], collections: readonly Collection[] = [], library = '') {
    this.books = books.filter(book => !book.hiddenBook);
    this.metadata = new Map();
    this.tags = new Map();
    this.orders = new Map();
    this.collections = new Map();

    const references = new Map<string, Set<string>>();
    const root =
      typeof library === 'string' && library
        ? library.replaceAll('\\', '/').replace(/\/+$/, '') + '/'
        : '';

    for (const book of this.books) {
      for (const reference of [book.id, book.hash].filter((v): v is string => Boolean(v))) {
        let ids = references.get(reference);
        if (!ids) {
          ids = new Set();
          references.set(reference, ids);
        }
        ids.add(book.id);
      }
    }

    for (const collection of Array.isArray(collections) ? collections : []) {
      if (!collection || typeof collection.id !== 'string' || !Array.isArray(collection.list)) continue;
      const ids = new Set<string>();
      for (const reference of collection.list) {
        for (const id of references.get(reference) || []) ids.add(id);
      }
      this.collections.set(collection.id, {
        id: collection.id,
        title: String(collection.title || '未命名合集'),
        ids,
      });
    }

    for (const book of this.books) {
      const tags = bookTags(book);
      const file = typeof book.filepath === 'string' ? book.filepath.replaceAll('\\', '/') : '';
      const authors = tags
        .filter(tag => tag.group === 'artist')
        .map(tag => tag.value)
        .sort(collator.compare)
        .filter((name, i, names) => !i || collator.compare(name, names[i - 1]) !== 0);

      this.metadata.set(book.id, {
        tags,
        authors,
        keys: new Set(tags.map(tag => tag.key)),
        relativePath: root && file.startsWith(root) ? file.slice(root.length) : '',
        search: [bookTitle(book), book.title, book.category, ...tags.map(tag => tag.value)]
          .filter(Boolean)
          .join(' ')
          .toLocaleLowerCase(),
      });

      for (const tag of tags) {
        const existing = this.tags.get(tag.key);
        if (existing) existing.count++;
        else this.tags.set(tag.key, { ...tag, count: 1 });
      }
    }

    this.rankedTags = [...this.tags.values()].sort(
      (a, b) => b.count - a.count || collator.compare(a.value, b.value) || collator.compare(a.group, b.group)
    );
  }

  ordered(sort: SortMode = 'recent'): Book[] {
    const cached = this.orders.get(sort);
    if (cached) return cached;

    const bookDate = (book: Book): number =>
      Date.parse(book.createdAt || '') || Number(book.date) || Date.parse(book.mtime || '') || 0;

    const sorted = [...this.books].sort((a, b) => {
      if (sort === 'title') return collator.compare(bookTitle(a), bookTitle(b));
      if (sort === 'author') {
        const authorsA = this.metadata.get(a.id)?.authors ?? [];
        const authorsB = this.metadata.get(b.id)?.authors ?? [];
        return compareAuthors(authorsA, authorsB) || collator.compare(bookTitle(a), bookTitle(b));
      }
      if (sort === 'pages') return bookPageCount(b) - bookPageCount(a);
      if (sort === 'rating') return (b.rating || 0) - (a.rating || 0);
      return bookDate(b) - bookDate(a);
    });

    this.orders.set(sort, sorted);
    return sorted;
  }

  select(options: LibrarySelectOptions = {}): Book[] {
    const {
      search = '',
      folder = '',
      classicQuery = '',
      selectedTags = [],
      excludedTags = [],
      collectionId = '',
      favorites = false,
      filter = 'all',
      sort = 'recent',
      progress = {},
      visits = {},
      bookIds = null,
    } = options;

    const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const collection = collectionId ? this.collections.get(collectionId) : null;
    const classicMatch = compileClassicQuery(classicQuery);
    const folderPrefix = folder ? folder + '/' : '';

    let books = this.ordered(sort).filter(book => {
      const metadata = this.metadata.get(book.id);
      if (!metadata) return false;
      return (
        (!favorites || Boolean(book.mark)) &&
        (filter === 'all' || resolveReadingStatus(book, progress, visits) === filter) &&
        (!bookIds || bookIds.has(book.id)) &&
        (!folderPrefix || metadata.relativePath.startsWith(folderPrefix)) &&
        (!classicMatch || classicMatch(book, metadata)) &&
        (!collectionId || Boolean(collection?.ids.has(book.id))) &&
        selectedTags.every(key => metadata.keys.has(key)) &&
        excludedTags.every(key => !metadata.keys.has(key)) &&
        words.every(word => metadata.search.includes(word))
      );
    });

    if (filter === 'reading' && sort === 'recent') {
      books = books.sort(
        (a, b) => resolveReadingTime(b, progress, visits) - resolveReadingTime(a, progress, visits)
      );
    }
    return books;
  }

  summarize(state: LibrarySelectOptions = {}): LibrarySummary {
    const { favorites = false, filter = 'all', sort = 'recent', progress = {}, visits = {} } = state;
    const scoped = this.select({ ...state, favorites: false, filter: 'all' });
    const counts: Record<ReadingStatus, number> = { reading: 0, finished: 0, unread: 0 };
    const books: Book[] = [];
    let favoriteCount = 0;

    for (const book of scoped) {
      const status = resolveReadingStatus(book, progress, visits);
      const matches = filter === 'all' || filter === status;
      if (book.mark && matches) favoriteCount++;
      if (favorites && !book.mark) continue;
      counts[status]++;
      if (matches) books.push(book);
    }

    if (filter === 'reading' && sort === 'recent') {
      books.sort((a, b) => resolveReadingTime(b, progress, visits) - resolveReadingTime(a, progress, visits));
    }
    return { books, counts, favoriteCount };
  }
}

export const useLibraryStore = defineStore('library', () => {
  const books = ref<Book[]>([]);
  const collections = ref<Collection[]>([]);
  const smartShelves = ref<SmartShelf[]>([]);
  const folderTree = ref<FolderTreeNode[]>([]);
  const libraryRoot = ref('');
  const loading = ref(false);
  const error = ref<string | null>(null);

  const query = ref<LibraryQuery>(normalizeShelfQuery({}));
  const sort = ref<SortMode>('recent');
  const density = ref<ViewDensity>('comfortable');
  const displayView = ref<LegacyLibraryView | WorkspaceLibraryView>('grid');
  const page = ref(1);
  const tagSearch = ref('');
  const tagGroup = ref('');
  const tagLimit = ref(40);
  const shelfId = ref('');
  const featuredIds = ref<string[]>([]);
  const textMatchBookIds = ref<Set<string> | null>(null);

  let reloadPending = false;

  const index = computed(() => new LibraryIndex(books.value, collections.value, libraryRoot.value));

  const scopedBookIds = computed<Set<string> | null>(() => {
    let ids: Set<string> | null = query.value.featured ? new Set(featuredIds.value) : null;
    if (query.value.searchMode !== 'metadata' && query.value.search.trim() && textMatchBookIds.value) {
      const searched = new Set<string>(textMatchBookIds.value);
      if (query.value.searchMode === 'all') {
        for (const book of index.value.select({ search: query.value.search })) {
          searched.add(book.id);
        }
      }
      ids = ids ? new Set([...ids].filter(id => searched.has(id))) : searched;
    }
    return ids;
  });

  const summary = computed<LibrarySummary>(() => {
    const readingStore = useReadingStore();
    const useTextIds = query.value.searchMode !== 'metadata' && Boolean(query.value.search.trim()) && textMatchBookIds.value !== null;
    return index.value.summarize({
      ...query.value,
      search: useTextIds ? '' : query.value.search,
      sort: sort.value,
      progress: readingStore.progress,
      visits: readingStore.visits,
      bookIds: scopedBookIds.value,
    });
  });

  const visibleBooks = computed(() => summary.value.books);
  const statusCounts = computed(() => summary.value.counts);
  const favoriteCount = computed(() => summary.value.favoriteCount);

  const perPage = computed(() => booksPerPage(displayView.value, density.value));
  const totalPages = computed(() => Math.max(1, Math.ceil(visibleBooks.value.length / perPage.value)));
  const clampedPage = computed(() => Math.max(1, Math.min(page.value, totalPages.value)));
  const pagedBooks = computed(() => {
    const start = (clampedPage.value - 1) * perPage.value;
    return visibleBooks.value.slice(start, start + perPage.value);
  });

  const rankedTags = computed(() => index.value.rankedTags);
  const tagGroupKeys = computed(() => [...new Set(index.value.rankedTags.map(tag => tag.group))]);
  const filteredTags = computed(() => {
    const needle = tagSearch.value.trim().toLocaleLowerCase();
    return index.value.rankedTags.filter(tag => {
      if (tagGroup.value && tag.group !== tagGroup.value) return false;
      if (!needle) return true;
      const groupLabel = TAG_GROUPS[tag.group] || tag.group;
      return `${tag.value} ${groupLabel}`.toLocaleLowerCase().includes(needle);
    });
  });

  function setBooks(nextBooks: Book[], nextCollections?: Collection[], nextLibraryRoot?: string): void {
    books.value = Array.isArray(nextBooks) ? nextBooks : [];
    if (nextCollections !== undefined) {
      collections.value = Array.isArray(nextCollections) ? nextCollections : [];
    }
    if (nextLibraryRoot !== undefined) {
      libraryRoot.value = nextLibraryRoot;
    }
  }

  async function loadFolderTree(): Promise<FolderTreeNode[]> {
    if (!hasIpc()) return folderTree.value;
    const paths = index.value.books.map(book => book.filepath);
    const tree = await invoke('get-folder-tree', paths);
    folderTree.value = Array.isArray(tree) ? tree : [];
    return folderTree.value;
  }

  async function refresh(options: { scan?: boolean; includeFolderTree?: boolean } = {}): Promise<void> {
    if (!hasIpc()) return;
    if (loading.value) {
      reloadPending = true;
      return;
    }
    loading.value = true;
    error.value = null;
    try {
      const readingStore = useReadingStore();
      const [loadedBooks, loadedCollections] = await Promise.all([
        invoke('load-book-list', options.scan === true),
        invoke('load-collection-list'),
        readingStore.loaded ? readingStore.refresh() : readingStore.load(),
      ]);
      books.value = Array.isArray(loadedBooks) ? loadedBooks : [];
      collections.value = Array.isArray(loadedCollections) ? loadedCollections : [];
      if (options.includeFolderTree) {
        await loadFolderTree();
      }
      if (tagGroup.value && !tagGroupKeys.value.includes(tagGroup.value)) {
        tagGroup.value = '';
      }
      page.value = clampedPage.value;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      loading.value = false;
      if (reloadPending) {
        reloadPending = false;
        void refresh(options).catch(() => {});
      }
    }
  }

  function updateQuery(patch: Partial<LibraryQuery>): void {
    query.value = normalizeShelfQuery({ ...query.value, ...patch });
    page.value = 1;
    if (shelfId.value && !shelfMatches(smartShelves.value.find(s => s.id === shelfId.value), query.value)) {
      shelfId.value = '';
    }
  }

  function setSearch(value: string): void {
    updateQuery({ search: value });
  }

  function setSearchMode(mode: SearchMode): void {
    updateQuery({ searchMode: mode });
  }

  function setFilter(filter: BookStatus): void {
    updateQuery({ filter });
  }

  function setFavorites(enabled: boolean): void {
    updateQuery({ favorites: enabled });
  }

  function setFeatured(enabled: boolean): void {
    updateQuery({ featured: enabled });
  }

  function setFolder(folder: string): void {
    updateQuery({ folder });
  }

  function setClassicQuery(classicQuery: string): void {
    updateQuery({ classicQuery });
  }

  function setCollection(collectionId: string): void {
    updateQuery({ collectionId });
  }

  function toggleTag(key: string, exclude = false): boolean {
    const inSelected = query.value.selectedTags.includes(key);
    const inExcluded = query.value.excludedTags.includes(key);
    if (!index.value.tags.has(key) && !inSelected && !inExcluded) return false;

    const currentField = exclude ? query.value.excludedTags : query.value.selectedTags;
    const isPresent = currentField.includes(key);
    if (!isPresent && currentField.length >= 200) return false;

    const nextField = isPresent ? currentField.filter(item => item !== key) : [...currentField, key];
    const nextOpposite = (exclude ? query.value.selectedTags : query.value.excludedTags).filter(
      item => item !== key
    );

    updateQuery(
      exclude
        ? { excludedTags: nextField, selectedTags: nextOpposite }
        : { selectedTags: nextField, excludedTags: nextOpposite }
    );
    return true;
  }

  function clearTags(): void {
    updateQuery({ selectedTags: [], excludedTags: [] });
  }

  function setSort(nextSort: SortMode): void {
    sort.value = nextSort;
    page.value = 1;
  }

  function setDensity(nextDensity: ViewDensity): void {
    density.value = nextDensity;
    page.value = 1;
  }

  function setPage(nextPage: number): void {
    if (!Number.isSafeInteger(nextPage) || nextPage < 1) return;
    page.value = Math.min(nextPage, totalPages.value);
  }

  function resetFilters(): void {
    query.value = normalizeShelfQuery({});
    shelfId.value = '';
    page.value = 1;
  }

  function applySmartShelf(id: string): boolean {
    const shelf = smartShelves.value.find(item => item.id === id);
    if (!shelf) return false;
    query.value = normalizeShelfQuery(shelf.query);
    shelfId.value = shelf.id;
    page.value = 1;
    return true;
  }

  function setSmartShelves(shelves: SmartShelf[]): void {
    smartShelves.value = normalizeSmartShelves(shelves);
  }

  return {
    books,
    collections,
    smartShelves,
    folderTree,
    libraryRoot,
    loading,
    error,
    query,
    sort,
    density,
    displayView,
    page,
    tagSearch,
    tagGroup,
    tagLimit,
    shelfId,
    featuredIds,
    textMatchBookIds,
    index,
    visibleBooks,
    statusCounts,
    favoriteCount,
    perPage,
    totalPages,
    clampedPage,
    pagedBooks,
    rankedTags,
    tagGroupKeys,
    filteredTags,
    setBooks,
    loadFolderTree,
    refresh,
    updateQuery,
    setSearch,
    setSearchMode,
    setFilter,
    setFavorites,
    setFeatured,
    setFolder,
    setClassicQuery,
    setCollection,
    toggleTag,
    clearTags,
    setSort,
    setDensity,
    setPage,
    resetFilters,
    applySmartShelf,
    setSmartShelves,
  };
});
