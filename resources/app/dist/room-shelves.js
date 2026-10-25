// Saved shelves hold queries, so future books can match without rewriting IDs.
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const choice = (value, allowed, fallback) => allowed.includes(value) ? value : fallback;
const text = (value, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
export const GRID_DENSITIES = Object.freeze({ comfortable: 12, standard: 24, compact: 48 });

function tagKeys(input) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.filter(value => {
    if (typeof value !== 'string' || value.length > 600) return false;
    try { const pair = JSON.parse(value); return Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === 'string' && part.length > 0); }
    catch { return false; }
  }))].slice(0, 200).sort();
}

export function normalizeShelfQuery(input = {}) {
  const value = record(input) ? input : {};
  const selectedTags = tagKeys(value.selectedTags);
  return {
    search: text(value.search),
    filter: choice(value.filter, ['all', 'reading', 'finished', 'unread'], 'all'),
    favorites: value.favorites === true,
    featured: value.featured === true,
    selectedTags,
    excludedTags: tagKeys(value.excludedTags).filter(key => !selectedTags.includes(key)),
    collectionId: text(value.collectionId, 200),
  };
}

export function normalizeLibraryState(input, defaults = {}) {
  const value = record(input) ? input : {};
  return {
    ...normalizeShelfQuery(value),
    sort: choice(value.sort || defaults.sort, ['recent', 'title', 'author', 'pages', 'rating'], 'recent'),
    view: choice(value.view || defaults.view, ['shelf', 'grid'], 'shelf'),
    density: choice(value.density, Object.keys(GRID_DENSITIES), 'comfortable'),
    page: Number.isSafeInteger(value.page) && value.page > 0 ? Math.min(value.page, 1000000) : 1,
    scrollTop: Number.isFinite(value.scrollTop) ? Math.max(0, Math.min(value.scrollTop, 10000000)) : 0,
    tagScrollTop: Number.isFinite(value.tagScrollTop) ? Math.max(0, Math.min(value.tagScrollTop, 10000000)) : 0,
    tagSearch: text(value.tagSearch, 200),
    tagGroup: text(value.tagGroup, 100),
    tagLimit: Number.isSafeInteger(value.tagLimit) ? Math.max(40, Math.min(value.tagLimit, 10000)) : 40,
    shelfId: text(value.shelfId, 100),
  };
}

export function normalizeSmartShelves(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  return input.slice(0, 100).flatMap(item => {
    if (!record(item) || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || seen.has(item.id) || typeof item.name !== 'string' || !item.name.trim()) return [];
    seen.add(item.id);
    return [{ id: item.id, name: item.name.trim().slice(0, 80), query: normalizeShelfQuery(item.query) }];
  });
}

export function shelfMatches(shelf, state) {
  return !!shelf && JSON.stringify(normalizeShelfQuery(shelf.query)) === JSON.stringify(normalizeShelfQuery(state));
}

export function booksPerPage(view, density) {
  return view === 'grid' ? (GRID_DENSITIES[density] || GRID_DENSITIES.comfortable) : 12;
}

export function describeTag(key) {
  try {
    const pair = JSON.parse(key);
    if (Array.isArray(pair) && pair.length === 2) return { group: String(pair[0]), value: String(pair[1]), key };
  } catch {}
  return { group: 'other', value: String(key), key };
}
