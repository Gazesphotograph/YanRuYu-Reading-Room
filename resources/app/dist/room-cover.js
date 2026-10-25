// Old covers were padded to 500 x 707 with #303133. Recover only that known
// format; general-purpose black-border trimming would remove real artwork.
const LEGACY_WIDTH = 500;
const LEGACY_HEIGHT = 707;
const MIN_BORDER = 10;
const KEEP_BORDER = 2;
const PADDING = [48, 49, 51];

function isPaddingPixel(data, offset) {
  return Math.abs(data[offset] - PADDING[0]) <= 6 &&
    Math.abs(data[offset + 1] - PADDING[1]) <= 6 &&
    Math.abs(data[offset + 2] - PADDING[2]) <= 6;
}

function legacyBounds(data, width, height) {
  // Alpha belongs to the artwork, not the opaque padding produced by the old
  // thumbnail pipeline. Do not flatten or interpret transparent covers.
  for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return null;

  const pixelAt = (axis, along, across) =>
    (axis === 'y' ? along * width + across : across * width + along) * 4;
  const extent = axis => axis === 'y' ? height : width;
  const lineLength = axis => axis === 'y' ? width : height;

  function edgeSignature(axis, reverse) {
    const length = lineLength(axis), depth = 8;
    let near = 0, exact = 0;
    for (let line = 0; line < depth; line++) {
      const position = reverse ? extent(axis) - 1 - line : line;
      for (let cross = 0; cross < length; cross++) {
        const i = pixelAt(axis, position, cross);
        if (isPaddingPixel(data, i)) near++;
        // Default JPEG preserves the original color; lossy WebP commonly
        // decodes it as 49,49,51. An exact-color core anchors the tolerant scan
        // to this padding color instead of any merely similar dark gray.
        if ((data[i] === 48 || data[i] === 49) && data[i + 1] === 49 && data[i + 2] === 51) exact++;
      }
    }
    return { near: near / (length * depth), exact: exact / (length * depth) };
  }

  function borderLength(axis, reverse) {
    const length = lineLength(axis), limit = Math.floor((extent(axis) - 32) / 2);
    for (let line = 0; line <= limit; line++) {
      const position = reverse ? extent(axis) - 1 - line : line;
      let different = 0;
      for (let cross = 0; cross < length; cross++) {
        if (!isPaddingPixel(data, pixelAt(axis, position, cross))) different++;
      }
      if (different > length * .005) return line;
    }
    // An almost uniform page or a tiny mark in a dark field is ambiguous.
    return -1;
  }

  function clearContentBoundary(axis, border, reverse) {
    const length = lineLength(axis), depth = 12;
    let different = 0;
    for (let line = border; line < border + depth; line++) {
      const position = reverse ? extent(axis) - 1 - line : line;
      for (let cross = 0; cross < length; cross++) {
        const i = pixelAt(axis, position, cross);
        if (Math.max(Math.abs(data[i] - 48), Math.abs(data[i + 1] - 49), Math.abs(data[i + 2] - 51)) > 18) different++;
      }
    }
    return different >= length * depth * .25;
  }

  const axes = ['y', 'x'].filter(axis => {
    const start = edgeSignature(axis, false), end = edgeSignature(axis, true);
    // WebP chroma blocks can affect most of one narrow strip. Require original
    // padding samples on both sides and a substantial combined exact-color
    // core, rather than mistaking that compression for a different border.
    return start.near >= .995 && end.near >= .995 &&
      Math.min(start.exact, end.exact) >= .12 && start.exact + end.exact >= .7;
  });
  // Contain resizing pads one axis only. A border around all four sides can
  // be a frame authored into the cover and must remain intact.
  if (axes.length !== 1) return null;
  const axis = axes[0], start = borderLength(axis, false), end = borderLength(axis, true);
  if (Math.min(start, end) < MIN_BORDER || Math.abs(start - end) > 4) return null;
  if (!clearContentBoundary(axis, start, false) || !clearContentBoundary(axis, end, true)) return null;

  // Keep a thin margin to preserve artwork at JPEG/WebP transition pixels.
  // Use the shorter side on both edges so any one-pixel rounding is retained.
  const inset = Math.min(start, end) - KEEP_BORDER;
  return axis === 'y'
    ? { x: 0, y: inset, width, height: height - inset * 2 }
    : { x: inset, y: 0, width: width - inset * 2, height };
}

/**
 * Normalize an already decoded Three.Texture in place and return it.
 * coverBounds uses source pixels with a top-left origin. coverAspect describes
 * the visible rectangle; offset/repeat perform its UV crop without rewriting
 * an image or allocating another GPU texture. Each texture is inspected once.
 */
export function normalizeCoverTexture(texture) {
  if (!texture) return texture;
  const details = texture.userData ||= {};
  if (details.coverNormalized) return texture;
  details.coverNormalized = true;
  const source = texture.image;
  const width = Number(source?.naturalWidth || source?.videoWidth || source?.width) || 0;
  const height = Number(source?.naturalHeight || source?.videoHeight || source?.height) || 0;
  details.coverSourceSize = { width, height };
  details.coverBounds = { x: 0, y: 0, width, height };
  details.coverAspect = width > 0 && height > 0 ? width / height : LEGACY_WIDTH / LEGACY_HEIGHT;
  details.coverCropped = false;
  if (width !== LEGACY_WIDTH || height !== LEGACY_HEIGHT) return texture;

  let canvas;
  try {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return texture;
    context.drawImage(source, 0, 0, width, height);
    const bounds = legacyBounds(context.getImageData(0, 0, width, height).data, width, height);
    if (!bounds) return texture;
    texture.repeat.set(bounds.width / width, bounds.height / height);
    texture.offset.set(bounds.x / width, texture.flipY === false ? bounds.y / height : 1 - (bounds.y + bounds.height) / height);
    texture.updateMatrix();
    details.coverBounds = bounds;
    details.coverAspect = bounds.width / bounds.height;
    details.coverCropped = true;
  } catch {
    // A CORS-tainted canvas, unavailable 2D context or unsupported source must
    // never prevent a cover from displaying at its original natural ratio.
  } finally {
    if (canvas) canvas.width = canvas.height = 0;
  }
  return texture;
}
