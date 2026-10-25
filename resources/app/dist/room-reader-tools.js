// Reading rules are independent of the DOM so keyboard and spread changes use
// the same one-based page anchor as the shared reading profile.
export const DEFAULT_READER_PREFERENCES = Object.freeze({
  mode: 'paged', direction: 'ltr', fit: 'page', zoom: 100, coverAlone: true,
});

export function normalizeReaderPreferences(value = {}, defaults = {}) {
  const input = { ...DEFAULT_READER_PREFERENCES, ...defaults, ...(value && typeof value === 'object' ? value : {}) };
  return {
    mode: ['paged', 'double', 'continuous'].includes(input.mode) ? input.mode : 'paged',
    direction: input.direction === 'rtl' ? 'rtl' : 'ltr',
    fit: input.fit === 'width' ? 'width' : 'page',
    zoom: Number.isFinite(input.zoom) ? Math.max(50, Math.min(250, Math.round(input.zoom))) : 100,
    coverAlone: input.coverAlone !== false,
  };
}

export const isLandscapePage = ratio => Number.isFinite(ratio) && ratio >= 1.15;

export function buildReaderSpreads(total, dimensions = new Map(), { coverAlone = true } = {}) {
  const spreads = [];
  if (!Number.isSafeInteger(total) || total < 1) return spreads;
  for (let page = 1; page <= total;) {
    // Covers and images that already contain a spread occupy the whole view.
    // A portrait before a spread is kept alone instead of shrinking the spread.
    if ((page === 1 && coverAlone) || isLandscapePage(dimensions.get(page)) || page === total || isLandscapePage(dimensions.get(page + 1))) {
      spreads.push([page++]);
    } else {
      spreads.push([page, page + 1]); page += 2;
    }
  }
  return spreads;
}

export function readerSpreadIndex(spreads, page) {
  let low = 0, high = spreads.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2), spread = spreads[middle];
    if (page < spread[0]) high = middle - 1;
    else if (page > spread.at(-1)) low = middle + 1;
    else return middle;
  }
  return -1;
}

export function readerTurnTarget(page, total, direction, spreads = null) {
  if (!total) return page;
  if (!spreads) return Math.max(1, Math.min(total, page + direction));
  const index = readerSpreadIndex(spreads, page);
  const target = spreads[index + direction];
  return target ? target[0] : page;
}

export function readerHorizontalDirection(key, direction) {
  const logical = key === 'ArrowLeft' ? -1 : key === 'ArrowRight' ? 1 : 0;
  return logical && direction === 'rtl' ? -logical : logical;
}
