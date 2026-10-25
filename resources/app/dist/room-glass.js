/* A small, dependency-free liquid-glass layer, inspired by rdev/liquid-glass-react.
   Only the backdrop is displaced. Text, artwork and hit targets stay untouched.
   See vendor/liquid-glass-NOTICE.txt for the reference and its MIT license. */

const NS = 'http://www.w3.org/2000/svg';
const SURFACES = [
  ['.drawer, .modal, .themed-dialog', 'sheet'],
  ['.sidebar, .topbar, .reader-bar, .reader-bottom', 'frost'],
  ['.search, .appearance-button, .pill-button:not(.primary), .filters, .view-toggle, .scene-controls, .scene-caption, .book-title-tooltip, .toast', 'lens'],
  ['.brand-mark, .nav-btn, .reading-options', 'sheen'],
];
const selector = SURFACES.map(([query]) => query).join(',');
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function svgNode(name, attributes = {}) {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  return node;
}

// Rounded-rectangle normals encode displacement in R/G. The centre stays neutral;
// refraction and dispersion live exclusively in a narrow band inside the rim.
function displacementMap(width, height, radius) {
  const ratio = Math.min(1, 480 / Math.max(width, height), Math.sqrt(48000 / (width * height)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, Math.ceil(width * ratio));
  canvas.height = Math.max(2, Math.ceil(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('A 2D context is unavailable');
  const pixels = context.createImageData(canvas.width, canvas.height);
  const halfX = width / 2, halfY = height / 2;
  const band = clamp(Math.min(width, height) * .2, 7, 24);
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - halfX;
      const py = (y + .5) * height / canvas.height - halfY;
      const qx = Math.abs(px) - (halfX - radius);
      const qy = Math.abs(py) - (halfY - radius);
      const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
      const length = Math.hypot(ox, oy);
      const distance = length + Math.min(Math.max(qx, qy), 0) - radius;
      const t = clamp(-distance / band, 0, 1);
      const bend = distance < 0 && t < 1 ? Math.pow(Math.sin(t * Math.PI), 1.25) : 0;
      const nx = length ? ox / length : qx > qy ? 1 : 0;
      const ny = length ? oy / length : qy >= qx ? 1 : 0;
      const offset = (y * canvas.width + x) * 4;
      pixels.data[offset] = Math.round(127.5 + Math.sign(px) * nx * bend * 112);
      pixels.data[offset + 1] = Math.round(127.5 + Math.sign(py) * ny * bend * 112);
      pixels.data[offset + 2] = 128;
      pixels.data[offset + 3] = 255;
    }
  }
  context.putImageData(pixels, 0, 0);
  return canvas.toDataURL();
}

function createFilter(id, width, height, radius) {
  const filter = svgNode('filter', {
    id, x: '0%', y: '0%', width: '100%', height: '100%',
    'color-interpolation-filters': 'sRGB',
  });
  filter.append(svgNode('feImage', {
    href: displacementMap(width, height, radius), x: 0, y: 0, width, height,
    preserveAspectRatio: 'none', result: 'rim-map',
  }));
  const strength = clamp(Math.min(width, height) * .42, 12, 26);
  for (const [channel, delta, matrix] of [
    ['red', .55, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1'],
    ['green', 0, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1'],
    ['blue', -.55, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1'],
  ]) {
    filter.append(svgNode('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'rim-map', scale: strength + delta,
      xChannelSelector: 'R', yChannelSelector: 'G', result: `${channel}-bend`,
    }));
    filter.append(svgNode('feColorMatrix', { in: `${channel}-bend`, type: 'matrix', values: matrix, result: channel }));
  }
  filter.append(svgNode('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'red-green' }));
  filter.append(svgNode('feBlend', { in: 'red-green', in2: 'blue', mode: 'screen', result: 'color' }));
  // Blend opaque colour channels, then restore the sampled alpha once. Blending
  // three translucent copies darkens glass nested inside another frosted panel.
  filter.append(svgNode('feComposite', { in: 'color', in2: 'green-bend', operator: 'in' }));
  return filter;
}

let initialized = false;
export function initLiquidGlass() {
  if (initialized) return;
  initialized = true;
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const forcedColors = matchMedia('(forced-colors: active)');
  const hasBackdrop = CSS.supports('backdrop-filter', 'blur(1px)');
  // CSS.supports only checks grammar. Other engines retain the frosted fallback.
  const canRefract = hasBackdrop && /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)
    && typeof SVGFEDisplacementMapElement !== 'undefined';
  const surfaces = new Map(), filters = new Map(), dirty = new Set();
  let enabled = false, refracting = false, svg = null, defs = null, serial = 0;
  let frame = 0, scanNeeded = false, hot = null, pointer = null, scrollTimer = 0;

  function release(entry) {
    if (!entry.key) return;
    const cached = filters.get(entry.key);
    if (cached && --cached.refs === 0) { cached.node.remove(); filters.delete(entry.key); }
    entry.key = null;
    entry.element.style.removeProperty('--liquid-filter');
  }

  function resetPointer() {
    if (hot) for (const key of ['--liquid-x', '--liquid-y', '--liquid-angle']) hot.style.removeProperty(key);
    hot = null;
    pointer = null;
  }

  function unregister(element, entry) {
    if (hot === element) resetPointer();
    resizeObserver.unobserve(element);
    release(entry);
    dirty.delete(element);
    delete element.dataset.liquidSurface;
    element.classList.remove('liquid-positioned');
    surfaces.delete(element);
  }

  function scan() {
    for (const [element, entry] of surfaces) {
      if (!element.isConnected || !element.matches(selector)) unregister(element, entry);
    }
    for (const [query, kind] of SURFACES) for (const element of document.querySelectorAll(query)) {
      if (surfaces.has(element)) continue;
      const entry = { element, kind, key: null };
      surfaces.set(element, entry);
      element.dataset.liquidSurface = kind;
      if (getComputedStyle(element).position === 'static') element.classList.add('liquid-positioned');
      if ((kind === 'lens' || kind === 'sheet') && refracting) { resizeObserver.observe(element); dirty.add(element); }
    }
  }

  function sizeFilter(element) {
    const entry = surfaces.get(element);
    if (!entry || !element.isConnected) return;
    const width = element.clientWidth, height = element.clientHeight;
    // Large sheets reuse the same bounded map as small lenses. Only their rim
    // refracts, and scrolling temporarily keeps the cheaper frosted surface.
    const areaBudget = entry.kind === 'sheet' ? 2400000 : 180000;
    if (width < 2 || height < 2 || width * height > areaBudget) { release(entry); return; }
    const radius = Math.round(Math.min(parseFloat(getComputedStyle(element).borderTopLeftRadius) || 0, width / 2, height / 2));
    const key = `${width}:${height}:${radius}`;
    if (entry.key === key) return;
    release(entry);
    let cached = filters.get(key);
    if (!cached) {
      const id = `room-glass-${++serial}`;
      cached = { id, node: createFilter(id, width, height, radius), refs: 0 };
      filters.set(key, cached);
      defs.append(cached.node);
    }
    cached.refs++;
    entry.key = key;
    element.style.setProperty('--liquid-filter', `url("#${cached.id}")`);
  }

  function flush() {
    frame = 0;
    if (!enabled || document.hidden) return;
    if (scanNeeded) { scanNeeded = false; scan(); }
    if (refracting) {
      try { for (const element of dirty) sizeFilter(element); }
      catch { // A denied canvas or unavailable filter resource must never break the UI.
        refracting = false;
        root.dataset.liquidGlass = 'frosted';
        resizeObserver.disconnect();
        for (const entry of surfaces.values()) release(entry);
        svg?.remove(); svg = null; defs = null;
      }
    }
    dirty.clear();
    if (pointer && hot?.isConnected && !reducedMotion.matches) {
      const rect = hot.getBoundingClientRect();
      const x = clamp((pointer.x - rect.left) / rect.width, 0, 1);
      const y = clamp((pointer.y - rect.top) / rect.height, 0, 1);
      hot.style.setProperty('--liquid-x', `${(x * 100).toFixed(1)}%`);
      hot.style.setProperty('--liquid-y', `${(y * 100).toFixed(1)}%`);
      hot.style.setProperty('--liquid-angle', `${(Math.atan2(y - .5, x - .5) * 180 / Math.PI + 90).toFixed(1)}deg`);
    }
  }

  function schedule(rescan = false) {
    scanNeeded ||= rescan;
    if (enabled && !document.hidden && !frame) frame = requestAnimationFrame(flush);
  }

  const resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) dirty.add(entry.target);
    schedule();
  });
  const contentObserver = new MutationObserver(records => {
    // Image loads, page counters and WebGL hit-target updates do not add glass.
    // Only rescan when a real surface enters or leaves the document.
    if (records.some(record => !svg?.contains(record.target) && [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === Node.ELEMENT_NODE && (node.matches(selector) || node.querySelector(selector))
    ))) schedule(true);
  });

  function onPointerMove(event) {
    if (reducedMotion.matches || event.pointerType === 'touch' || scrollTimer) return;
    const target = event.target instanceof Element ? event.target.closest('[data-liquid-surface="lens"], [data-liquid-surface="sheen"]') : null;
    if (target !== hot) { resetPointer(); hot = target; }
    if (!hot) return;
    pointer = { x: event.clientX, y: event.clientY };
    schedule();
  }

  function onScroll() {
    if (!scrollTimer) { root.dataset.liquidScrolling = 'true'; resetPointer(); }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrollTimer = 0; delete root.dataset.liquidScrolling; }, 140);
  }

  function stop() {
    enabled = false;
    cancelAnimationFrame(frame); frame = 0; scanNeeded = false;
    contentObserver.disconnect(); resizeObserver.disconnect(); resetPointer();
    clearTimeout(scrollTimer); scrollTimer = 0; delete root.dataset.liquidScrolling;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', resetPointer);
    document.removeEventListener('scroll', onScroll, true);
    for (const [element, entry] of surfaces) unregister(element, entry);
    filters.clear(); dirty.clear();
    svg?.remove(); svg = null; defs = null;
    delete root.dataset.liquidGlass;
  }

  function syncTheme() {
    stop();
    if (root.dataset.roomTheme !== 'glass') return;
    enabled = true;
    const reduced = reducedTransparency.matches || forcedColors.matches;
    refracting = canRefract && !reduced;
    root.dataset.liquidGlass = reduced ? 'reduced' : refracting ? 'refraction' : 'frosted';
    if (refracting) {
      svg = svgNode('svg', { id: 'room-liquid-filters', 'aria-hidden': 'true', focusable: 'false' });
      defs = svgNode('defs'); svg.append(defs); document.body.append(svg);
    }
    contentObserver.observe(document.body, { childList: true, subtree: true });
    if (!reduced) {
      document.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('pointerleave', resetPointer);
      document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }
    schedule(true);
  }

  new MutationObserver(syncTheme).observe(root, { attributes: true, attributeFilter: ['data-room-theme'] });
  reducedTransparency.addEventListener('change', syncTheme);
  forcedColors.addEventListener('change', syncTheme);
  reducedMotion.addEventListener('change', resetPointer);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { cancelAnimationFrame(frame); frame = 0; resetPointer(); }
    else schedule(true);
  });
  window.addEventListener('pagehide', stop, { once: true });
  syncTheme();
}
