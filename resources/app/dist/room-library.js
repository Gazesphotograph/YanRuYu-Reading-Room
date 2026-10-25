// Build text and tag indexes once per library refresh, rather than parsing every
// book's metadata on each keypress, filter change or return from the reader.
const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });
export const tagGroups = { artist:'作者', group:'社团', parody:'原作', character:'角色', language:'语言', male:'男性', female:'女性', mixed:'混合', other:'其他', misc:'其他', reclass:'分类', cosplayer:'角色扮演者' };
export const tagKey = (group, value) => JSON.stringify([group, value]);
export const bookTitle = book => book.title_jpn || book.title || '未命名书籍';
export function bookTags(book) {
  let tags = book.tags;
  if (typeof tags === 'string') { try { tags = JSON.parse(tags); } catch { tags = {}; } }
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) return [];
  const seen = new Set();
  return Object.entries(tags).flatMap(([group, items]) => (Array.isArray(items) ? items : [items]).flatMap(item => {
    if (typeof item !== 'string' && typeof item !== 'number') return [];
    const value = String(item).trim(), key = tagKey(group, value);
    if (!value || seen.has(key)) return [];
    seen.add(key);
    return [{ group, value, key }];
  }));
}
function compareAuthors(a, b) {
  if (!a.length) return b.length ? 1 : 0;
  if (!b.length) return -1;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const order = collator.compare(a[i], b[i]);
    if (order) return order;
  }
  return a.length - b.length;
}
export function readingStatus(book, progress) {
  const saved = progress[book.id];
  if (saved?.total > 0 && saved.page >= saved.total) return 'finished';
  return saved || book.readCount > 0 ? 'reading' : 'unread';
}
export class LibraryIndex {
  constructor(books = [], collections = []) {
    this.books = books.filter(book => !book.hiddenBook);
    this.metadata = new Map();
    this.tags = new Map();
    this.orders = new Map();
    this.collections = new Map();
    const references = new Map();
    for (const book of this.books) {
      for (const reference of [book.id, book.hash].filter(Boolean)) {
        if (!references.has(reference)) references.set(reference, new Set());
        references.get(reference).add(book.id);
      }
    }
    for (const collection of Array.isArray(collections) ? collections : []) {
      if (!collection || typeof collection.id !== 'string' || !Array.isArray(collection.list)) continue;
      const ids = new Set();
      for (const reference of collection.list) for (const id of references.get(reference) || []) ids.add(id);
      this.collections.set(collection.id, { id: collection.id, title: String(collection.title || '未命名合集'), ids });
    }
    for (const book of this.books) {
      const tags = bookTags(book);
      // Canonicalize coauthors once so tag order and duplicate spellings do not affect sorting.
      const authors = tags.filter(tag => tag.group === 'artist').map(tag => tag.value).sort(collator.compare)
        .filter((name, i, names) => !i || collator.compare(name, names[i - 1]) !== 0);
      this.metadata.set(book.id, {
        tags, authors, keys: new Set(tags.map(tag => tag.key)),
        search: [bookTitle(book), book.title, book.category, ...tags.map(tag => tag.value)].join(' ').toLocaleLowerCase(),
      });
      for (const tag of tags) {
        const existing = this.tags.get(tag.key);
        if (existing) existing.count++;
        else this.tags.set(tag.key, { ...tag, count: 1 });
      }
    }
    this.rankedTags = [...this.tags.values()].sort((a, b) => b.count - a.count || collator.compare(a.value, b.value) || collator.compare(a.group, b.group));
  }
  ordered(sort) {
    if (!this.orders.has(sort)) {
      const date = book => Date.parse(book.createdAt) || Number(book.date) || Date.parse(book.mtime) || 0;
      this.orders.set(sort, [...this.books].sort((a, b) => {
        if (sort === 'title') return collator.compare(bookTitle(a), bookTitle(b));
        if (sort === 'author') return compareAuthors(this.metadata.get(a.id).authors, this.metadata.get(b.id).authors)
          || collator.compare(bookTitle(a), bookTitle(b));
        if (sort === 'pages') return (b.pageCount || b.filecount || 0) - (a.pageCount || a.filecount || 0);
        if (sort === 'rating') return (b.rating || 0) - (a.rating || 0);
        return date(b) - date(a);
      }));
    }
    return this.orders.get(sort);
  }
  select({ search = '', selectedTags = [], excludedTags = [], collectionId = '', favorites = false, filter = 'all', sort = 'recent', progress = {}, bookIds = null }) {
    const words = search.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    const collection = collectionId ? this.collections.get(collectionId) : null;
    let books = this.ordered(sort).filter(book => {
      const metadata = this.metadata.get(book.id);
      return (!favorites || book.mark) && (filter === 'all' || readingStatus(book, progress) === filter)
        && (!bookIds || bookIds.has(book.id))
        && (!collectionId || collection?.ids.has(book.id))
        && selectedTags.every(key => metadata.keys.has(key)) && excludedTags.every(key => !metadata.keys.has(key))
        && words.every(word => metadata.search.includes(word));
    });
    if (filter === 'reading' && sort === 'recent') books = books.sort((a, b) => (progress[b.id]?.time || 0) - (progress[a.id]?.time || 0));
    return books;
  }
  // One metadata scan supplies both the visible list and all sidebar counts.
  // Counts deliberately ignore their own toggle, preserving combined filters.
  summarize(state) {
    const { favorites = false, filter = 'all', sort = 'recent', progress = {} } = state;
    const scoped = this.select({ ...state, favorites: false, filter: 'all' });
    const counts = { reading: 0, finished: 0, unread: 0 }, books = [];
    let favoriteCount = 0;
    for (const book of scoped) {
      const status = readingStatus(book, progress), matches = filter === 'all' || filter === status;
      if (book.mark && matches) favoriteCount++;
      if (favorites && !book.mark) continue;
      counts[status]++;
      if (matches) books.push(book);
    }
    if (filter === 'reading' && sort === 'recent') books.sort((a, b) => (progress[b.id]?.time || 0) - (progress[a.id]?.time || 0));
    return { books, counts, favoriteCount };
  }
}
