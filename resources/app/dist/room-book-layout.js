// Covers keep their own proportions. A shelf row shares its available width,
// including the small footprint of each book's spine and rotation.
export const DEFAULT_COVER_ASPECT = 500 / 707;

export function bookRowLayout(books, { width = 3.16, gap = .12, maxHeight = 1.33, maxWidth = 2.02, area = 1.16 } = {}) {
  if (!books.length) return [];
  const desired = books.map(book => {
    const aspect = Number.isFinite(book.aspect) && book.aspect > 0 ? book.aspect : DEFAULT_COVER_ASPECT;
    const height = Math.min(maxHeight, Math.sqrt(area / aspect), maxWidth / aspect);
    const coverWidth = height * aspect;
    const angle = Number.isFinite(book.rotation) ? book.rotation : 0;
    const cosine = Math.abs(Math.cos(angle));
    const depth = Number.isFinite(book.depth) ? Math.max(0, book.depth) : .14;
    return { width: coverWidth, height, cosine, spine: Math.abs(Math.sin(angle)) * (depth + .024) + .016 };
  });
  const gaps = gap * Math.max(0, books.length - 1);
  const spines = desired.reduce((sum, book) => sum + book.spine, 0);
  const faces = desired.reduce((sum, book) => sum + book.width * book.cosine, 0);
  const scale = Math.min(1, Math.max(.001, width - gaps - spines) / faces);
  const total = faces * scale + spines + gaps;
  let cursor = -total / 2;
  return desired.map(book => {
    const footprint = book.width * book.cosine * scale + book.spine;
    const placement = { x: cursor + footprint / 2, width: book.width * scale, height: book.height * scale, footprint };
    cursor += footprint + gap;
    return placement;
  });
}
