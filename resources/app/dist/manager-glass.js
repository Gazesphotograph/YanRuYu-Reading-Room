/* Optical surfaces for the complete manager. The SVG affects only a CSS
   backdrop layer: labels, artwork, scrolling content and hit targets stay crisp.
   No dependency, permanent animation loop, or per-book observer is needed. */

const SVG_NS = 'http://www.w3.org/2000/svg';
const SURFACES = [
  ['.app-toolbar, .pagination-bar .el-pagination, .manager-room-return, .catalog-bar, .mx-context-menu', 'lens'],
  ['.themed-dialog', 'dialog'],
  ['.el-dialog:not(.is-fullscreen), .el-message-box, .el-drawer:not(.viewer-drawer), .el-popper.is-light', 'panel'],
  ['.app-toolbar .search-input .el-input__wrapper', 'sheen'],
];
const SURFACE_SELECTOR = SURFACES.map(([selector]) => selector).join(',');
const POINTER_SELECTOR = '[data-manager-glass="lens"], [data-manager-glass="sheen"]';
const REFRACTIVE_KINDS = new Set(['lens', 'dialog']);
const filterProperty = kind => kind === 'dialog' ? '--liquid-filter' : '--mg-filter';
const LIGHT_PROPERTIES = ['--mg-x', '--mg-y', '--mg-angle'];
const RADIUS_PROPERTIES = ['borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius'];
const GEOMETRY_PROPERTIES = ['display', 'visibility', 'contentVisibility', 'opacity', 'position', 'left', 'top', 'right', 'bottom', 'transform', 'width', 'height', 'borderRadius', ...RADIUS_PROPERTIES];
const clamp = (number, min, max) => Math.max(min, Math.min(max, number));

function svgElement(tag, attributes = {}) {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}

function cornerRadii(style, width, height) {
  const length = (value, reference) => Math.max(0, (parseFloat(value) || 0) * (value.endsWith('%') ? reference / 100 : 1));
  const corners = RADIUS_PROPERTIES.map(property => {
    const [horizontal, vertical = horizontal] = style[property].trim().split(/\s+/);
    return [length(horizontal, width), length(vertical, height)];
  });
  // Follow CSS's overlap reduction, including pill radii expressed as percentages.
  const factor = Math.min(1, width / (corners[0][0] + corners[1][0]), width / (corners[3][0] + corners[2][0]),
    height / (corners[0][1] + corners[3][1]), height / (corners[1][1] + corners[2][1]));
  return corners.map(pair => pair.map(value => Math.round(value * factor * 4) / 4));
}

// A quarter-circle cross section transitions from a steep convex rim to a flat
// centre. Snell's law (air -> glass, n = 1.45) determines the sampling offset.
// The profile is evaluated once; there is no turbulence or moving noise texture.
const RIM_PROFILE = (() => {
  const profile = new Float32Array(257);
  let peak = 0;
  for (let index = 1; index < 256; index++) {
    const t = index / 256;
    const thickness = Math.sqrt(t * (2 - t));
    const incident = Math.atan(.85 * (1 - t) / thickness);
    const transmitted = Math.asin(Math.sin(incident) / 1.45);
    profile[index] = thickness * Math.tan(incident - transmitted);
    peak = Math.max(peak, profile[index]);
  }
  for (let index = 0; index < profile.length; index++) profile[index] /= peak;
  return profile;
})();

function makeDisplacementMap(width, height, radii) {
  const ratio = Math.min(1, 640 / Math.max(width, height), Math.sqrt(100000 / (width * height)));
  const canvas = document.createElement('canvas');
  // Flooring keeps both the long side and the total pixel budget strictly capped.
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The optical map has no canvas context');
  const image = context.createImageData(canvas.width, canvas.height);
  const halfWidth = width / 2, halfHeight = height / 2;
  const band = clamp(Math.min(width, height) * .21, 6, 20);
  for (let y = 0; y < canvas.height; y++) {
    const py = (y + .5) * height / canvas.height - halfHeight;
    for (let x = 0; x < canvas.width; x++) {
      const px = (x + .5) * width / canvas.width - halfWidth;
      const edgeX = halfWidth - Math.abs(px), edgeY = halfHeight - Math.abs(py);
      const [rx, ry] = radii[py < 0 ? (px < 0 ? 0 : 1) : (px < 0 ? 3 : 2)];
      let distance, nx, ny;
      if (rx > 0 && ry > 0 && edgeX < rx && edgeY < ry) {
        const cx = rx - edgeX, cy = ry - edgeY;
        const ellipse = Math.hypot(cx / rx, cy / ry);
        const gx = cx / (rx * rx), gy = cy / (ry * ry), gradient = Math.hypot(gx, gy);
        // Exact for circular corners; first-order signed distance for elliptical
        // corners follows their contour and normal instead of a square bevel.
        distance = gradient ? ellipse * (ellipse - 1) / gradient : -Math.min(rx, ry);
        nx = gradient ? gx / gradient : 0;
        ny = gradient ? gy / gradient : 0;
      } else {
        distance = -Math.min(edgeX, edgeY);
        nx = edgeX < edgeY ? 1 : 0;
        ny = edgeY <= edgeX ? 1 : 0;
      }
      const depth = -distance / band;
      const bend = depth > 0 && depth < 1 ? RIM_PROFILE[Math.round(depth * 256)] : 0;
      const offset = (y * canvas.width + x) * 4;
      image.data[offset] = Math.round(128 + Math.sign(px) * nx * bend * 112);
      image.data[offset + 1] = Math.round(128 + Math.sign(py) * ny * bend * 112);
      image.data[offset + 2] = 128;
      image.data[offset + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

function makeFilter(id, width, height, radii, onError) {
  const filter = svgElement('filter', {
    id, x: 0, y: 0, width, height,
    filterUnits: 'userSpaceOnUse', primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB',
  });
  const map = svgElement('feImage', {
    href: makeDisplacementMap(width, height, radii), x: 0, y: 0, width, height,
    preserveAspectRatio: 'none', result: 'encoded-rim',
  });
  map.addEventListener('error', onError, { once: true });
  filter.append(map);
  // 128/255 is not exactly 0.5. Correct the 8-bit map so its flat centre has
  // precisely zero displacement, including at high-contrast text in the backdrop.
  const neutral = svgElement('feComponentTransfer', { in: 'encoded-rim', result: 'rim-map' });
  neutral.append(svgElement('feFuncR', { type: 'linear', slope: .99609375 }), svgElement('feFuncG', { type: 'linear', slope: .99609375 }));
  filter.append(neutral);
  const strength = clamp(Math.min(width, height) * .34, 10, 23);
  // The full red-to-blue separation peaks at about 0.7 CSS pixels at the rim.
  for (const [channel, dispersion, values] of [
    ['red', .8, '1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 0 1'],
    ['green', 0, '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 0 1'],
    ['blue', -.8, '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 0 1'],
  ]) {
    filter.append(svgElement('feDisplacementMap', {
      in: 'SourceGraphic', in2: 'rim-map', scale: strength + dispersion,
      xChannelSelector: 'R', yChannelSelector: 'G', result: `${channel}-sample`,
    }));
    filter.append(svgElement('feColorMatrix', { in: `${channel}-sample`, type: 'matrix', values, result: channel }));
  }
  filter.append(svgElement('feBlend', { in: 'red', in2: 'green', mode: 'screen', result: 'red-green' }));
  filter.append(svgElement('feBlend', { in: 'red-green', in2: 'blue', mode: 'screen', result: 'color' }));
  // Reassemble unpremultiplied RGB, then restore the sampled alpha exactly once.
  // This avoids dark edges or three overlapping alpha layers inside another panel.
  filter.append(svgElement('feComposite', { in: 'color', in2: 'green-sample', operator: 'in' }));
  return filter;
}

let disposeManagerGlass = null;

export function initManagerGlass() {
  if (disposeManagerGlass) return disposeManagerGlass;
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', initManagerGlass, { once: true });
    return;
  }
  const root = document.documentElement;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const reducedTransparency = matchMedia('(prefers-reduced-transparency: reduce)');
  const forcedColors = matchMedia('(forced-colors: active)');
  const hasBackdrop = typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'blur(1px)');
  // A syntax check alone does not establish support for SVG backdrop filters.
  // Firefox and Safari (including their emulated UAs) retain the CSS material.
  const canRefract = hasBackdrop && /(?:Chrome|Chromium|Edg)\//.test(navigator.userAgent)
    && !/(?:Firefox|FxiOS|CriOS|EdgiOS)\//.test(navigator.userAgent)
    && typeof SVGFEDisplacementMapElement !== 'undefined' && typeof ResizeObserver !== 'undefined';
  const surfaces = new Map(), filters = new Map(), dirty = new Set();
  let enabled = false, refracting = false, watching = false, destroyed = false;
  let svg = null, defs = null, serial = 0, frame = 0, scanNeeded = false, scrollTimer = 0;
  let pointer = null, pointerTarget = null, litElement = null, pointerDirty = false;

  function clearLight(element) {
    if (element) for (const property of LIGHT_PROPERTIES) element.style.removeProperty(property);
  }

  function resetPointer() {
    clearLight(litElement);
    pointer = null; pointerTarget = null; litElement = null; pointerDirty = false;
  }

  function release(entry) {
    if (entry.key) {
      const cached = filters.get(entry.key);
      if (cached && --cached.references === 0) { cached.node.remove(); filters.delete(entry.key); }
      entry.key = null;
    }
    entry.element.style.removeProperty(filterProperty(entry.kind));
  }

  function geometrySignature(element) {
    // Pointer CSS variables and --mg-filter are deliberately excluded: updating
    // our lighting must not feed the observer back into another animation frame.
    return [element.className, element.hidden, element.getAttribute('aria-hidden'),
      ...GEOMETRY_PROPERTIES.map(property => element.style[property])].join('|');
  }

  function watchSurface(entry) {
    if (!watching) return;
    surfaceObserver.observe(entry.element, { attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
    if (REFRACTIVE_KINDS.has(entry.kind) && refracting) resizeObserver?.observe(entry.element);
  }

  function updateSurface(entry) {
    const element = entry.element;
    const kind = SURFACES.find(([selector]) => element.matches(selector))?.[1] || null;
    if (entry.kind !== kind) {
      release(entry);
      resizeObserver?.unobserve(element);
      if (litElement === element || pointerTarget === element) resetPointer();
      entry.kind = kind;
      if (kind) element.dataset.managerGlass = kind;
      else delete element.dataset.managerGlass;
    }
    // A framework may replace className while retaining this same surface.
    // Repair its containing block even when we positioned it on an earlier scan.
    if (kind && getComputedStyle(element).position === 'static') {
      element.classList.add('mg-positioned');
      entry.positioned = true;
    }
    if (!kind && entry.positioned) { element.classList.remove('mg-positioned'); entry.positioned = false; }
    entry.geometry = geometrySignature(element);
    watchSurface(entry);
    if (REFRACTIVE_KINDS.has(kind) && refracting) dirty.add(element);
  }

  function unregister(element, entry) {
    if (litElement === element || pointerTarget === element) resetPointer();
    resizeObserver?.unobserve(element);
    release(entry);
    dirty.delete(element);
    delete element.dataset.managerGlass;
    if (entry.positioned) element.classList.remove('mg-positioned');
    surfaces.delete(element);
  }

  function scan() {
    // Rebuild the small target-only attribute subscription to release removed
    // dialogs as well. MutationObserver has no unobserve(element) operation.
    surfaceObserver.disconnect();
    for (const [element, entry] of surfaces) {
      if (!element.isConnected) unregister(element, entry);
      else updateSurface(entry);
    }
    for (const element of document.querySelectorAll(SURFACE_SELECTOR)) {
      if (surfaces.has(element)) continue;
      const entry = { element, kind: null, key: null, positioned: false, geometry: '' };
      surfaces.set(element, entry);
      updateSurface(entry);
    }
  }

  function sizeFilter(element) {
    const entry = surfaces.get(element);
    if (!entry || !REFRACTIVE_KINDS.has(entry.kind) || !element.isConnected) return;
    const width = element.clientWidth, height = element.clientHeight;
    const style = getComputedStyle(element);
    if (width < 2 || height < 2 || style.display === 'none' || style.visibility === 'hidden'
      || style.contentVisibility === 'hidden' || element.hidden || element.getAttribute('aria-hidden') === 'true') {
      release(entry);
      if (litElement === element || pointerTarget === element) resetPointer();
      return;
    }
    const radii = cornerRadii(style, width, height);
    const key = `${width}:${height}:${radii.flat().join(':')}`;
    if (entry.key === key) return;
    let cached = filters.get(key);
    if (!cached) {
      const id = `manager-glass-${++serial}`;
      cached = { id, node: makeFilter(id, width, height, radii, failFilters), references: 0 };
      defs.append(cached.node);
      filters.set(key, cached);
    }
    release(entry);
    cached.references++;
    entry.key = key;
    // Shared dialog materials resolve their filter on the actual panel, so a
    // large sheet gets its own rim while its text and controls remain crisp.
    element.style.setProperty(filterProperty(entry.kind), `url("#${cached.id}")`);
  }

  function failFilters() {
    if (!enabled || !refracting) return;
    refracting = false;
    root.dataset.managerOptics = 'frosted';
    resizeObserver?.disconnect();
    for (const entry of surfaces.values()) release(entry);
    dirty.clear(); filters.clear();
    svg?.remove(); svg = null; defs = null;
  }

  function paintPointer() {
    if (!pointerDirty) return;
    pointerDirty = false;
    if (litElement !== pointerTarget) clearLight(litElement);
    litElement = pointerTarget;
    if (!pointer || !litElement?.isConnected || reducedMotion.matches || scrollTimer) { resetPointer(); return; }
    const rect = litElement.getBoundingClientRect();
    if (!rect.width || !rect.height) { resetPointer(); return; }
    const x = clamp((pointer.x - rect.left) / rect.width, 0, 1);
    const y = clamp((pointer.y - rect.top) / rect.height, 0, 1);
    litElement.style.setProperty('--mg-x', `${(x * 100).toFixed(1)}%`);
    litElement.style.setProperty('--mg-y', `${(y * 100).toFixed(1)}%`);
    litElement.style.setProperty('--mg-angle', `${(Math.atan2(y - .5, x - .5) * 180 / Math.PI + 90).toFixed(1)}deg`);
  }

  function flush() {
    frame = 0;
    if (!enabled || document.hidden) return;
    if (scanNeeded) { scanNeeded = false; scan(); }
    if (refracting) {
      try { for (const element of dirty) sizeFilter(element); }
      catch { failFilters(); } // Canvas denial or a failed resource cannot stop the app.
    }
    dirty.clear();
    paintPointer();
  }

  function schedule(rescan = false) {
    scanNeeded ||= rescan;
    if (enabled && !document.hidden && !frame) frame = requestAnimationFrame(flush);
  }

  const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(entries => {
    for (const { target } of entries) dirty.add(target);
    schedule();
  });
  const surfaceObserver = new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      const entry = surfaces.get(record.target);
      if (!entry || geometrySignature(entry.element) === entry.geometry) continue;
      updateSurface(entry);
      changed = true;
    }
    if (changed) schedule();
  });
  const contentObserver = new MutationObserver(records => {
    // Book covers, tag text, progress labels and the filter's own nodes do not
    // trigger scans. Only insertion/removal of an actual material surface does.
    // A previously registered dialog may have changed to fullscreen before it
    // was removed, so also release disconnected entries that no longer match.
    if ([...surfaces.keys()].some(element => !element.isConnected) || records.some(record => !svg?.contains(record.target) && [...record.addedNodes, ...record.removedNodes].some(node =>
      node.nodeType === Node.ELEMENT_NODE && (node.matches(SURFACE_SELECTOR) || node.querySelector(SURFACE_SELECTOR))
    ))) schedule(true);
  });

  function watch() {
    if (watching || !enabled || document.hidden) return;
    watching = true;
    contentObserver.observe(document.body, { childList: true, subtree: true });
    for (const entry of surfaces.values()) watchSurface(entry);
  }

  function pause() {
    watching = false;
    contentObserver.disconnect(); surfaceObserver.disconnect(); resizeObserver?.disconnect();
    cancelAnimationFrame(frame); frame = 0;
    resetPointer();
    clearTimeout(scrollTimer); scrollTimer = 0; delete root.dataset.managerScrolling;
  }

  function onPointerMove(event) {
    if (document.hidden || reducedMotion.matches || event.pointerType === 'touch' || scrollTimer) return;
    pointerTarget = event.target instanceof Element ? event.target.closest(POINTER_SELECTOR) : null;
    pointer = pointerTarget ? { x: event.clientX, y: event.clientY } : null;
    if (!pointerTarget && !litElement) return;
    pointerDirty = true;
    schedule();
  }

  function onPointerLeave() {
    pointerTarget = null; pointer = null;
    if (litElement) { pointerDirty = true; schedule(); }
  }

  function onScroll() {
    if (document.hidden) return;
    if (!scrollTimer) { root.dataset.managerScrolling = 'true'; resetPointer(); }
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => { scrollTimer = 0; delete root.dataset.managerScrolling; }, 160);
  }

  function stop() {
    enabled = false;
    pause(); scanNeeded = false;
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerleave', onPointerLeave);
    document.removeEventListener('scroll', onScroll, true);
    for (const [element, entry] of surfaces) unregister(element, entry);
    filters.clear(); dirty.clear();
    svg?.remove(); svg = null; defs = null;
    delete root.dataset.managerOptics;
  }

  function syncTheme() {
    stop();
    if (destroyed || root.dataset.roomTheme !== 'glass') return;
    enabled = true;
    const reduced = reducedTransparency.matches || forcedColors.matches;
    refracting = canRefract && !reduced;
    root.dataset.managerOptics = reduced ? 'reduced' : refracting ? 'refraction' : 'frosted';
    if (refracting) {
      svg = svgElement('svg', { id: 'manager-liquid-filters', 'aria-hidden': 'true', focusable: 'false', width: 0, height: 0 });
      svg.style.cssText = 'position:fixed;overflow:hidden;pointer-events:none';
      defs = svgElement('defs'); svg.append(defs); document.body.append(svg);
    }
    watch();
    if (!reduced) {
      document.addEventListener('pointermove', onPointerMove, { passive: true });
      document.addEventListener('pointerleave', onPointerLeave);
      document.addEventListener('scroll', onScroll, { passive: true, capture: true });
    }
    schedule(true);
  }

  function onVisibilityChange() {
    if (document.hidden) pause();
    else if (enabled) { watch(); schedule(true); }
  }

  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(root, { attributes: true, attributeFilter: ['data-room-theme'] });
  reducedTransparency.addEventListener('change', syncTheme);
  forcedColors.addEventListener('change', syncTheme);
  reducedMotion.addEventListener('change', resetPointer);
  document.addEventListener('visibilitychange', onVisibilityChange);
  function dispose() {
    if (destroyed) return;
    destroyed = true;
    stop(); themeObserver.disconnect();
    reducedTransparency.removeEventListener('change', syncTheme);
    forcedColors.removeEventListener('change', syncTheme);
    reducedMotion.removeEventListener('change', resetPointer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', dispose);
    document.removeEventListener('DOMContentLoaded', initManagerGlass);
    disposeManagerGlass = null;
  }
  disposeManagerGlass = dispose;
  window.addEventListener('pagehide', dispose, { once: true });
  syncTheme();
  return dispose;
}
