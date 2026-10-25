export const THEMES = [
  {
    id: 'paper',
    name: '颜如玉 · 暖白',
    label: 'PAPER & WALNUT',
    desc: '暖纸墙、胡桃木、午后窗光与小猫。',
    colors: ['#f3f1eb', '#315445', '#a08b70'],
    dark: false,
    eyebrow: 'A ROOM FOR YOUR STORIES',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Quiet hours.',
    brand: 'YAN RU YU',
  },
  {
    id: 'forest',
    name: '颜如玉 · 静绿',
    label: 'FOREST / AFTER HOURS',
    desc: '深木墙、林间月光、蕨叶与小鸟。',
    colors: ['#202a24', '#b4c6a7', '#9c8467'],
    dark: true,
    eyebrow: 'YAN RU YU / AFTER HOURS',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'After hours.',
    brand: 'YAN RU YU',
  },
  {
    id: 'hub',
    name: '黑橙放映厅',
    label: 'PORNHUB INSPIRED',
    desc: '炭砖、黄铜灯具与都市暮色。',
    colors: ['#191918', '#ff9900', '#b2afa5'],
    dark: true,
    eyebrow: 'PRIVATE COLLECTION / NOW SHOWING',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Now showing.',
    brand: 'YAN RU YU',
  },
  {
    id: 'ex',
    name: 'EX 私人图库',
    label: 'EXHENTAI INSPIRED',
    desc: '织纹墙、石材地板与米金色静夜。',
    colors: ['#34353b', '#e2d1a6', '#98969d'],
    dark: true,
    eyebrow: 'PRIVATE GALLERY / LOCAL ARCHIVE',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'The archives.',
    brand: 'YAN RU YU',
  },
  {
    id: 'terminal',
    name: '终端档案',
    label: 'TERMINAL / LOCAL',
    desc: '墨绿墙板、盆景、生态盒与青蛙。',
    colors: ['#121b15', '#91c89b', '#526e53'],
    dark: true,
    eyebrow: 'LOCAL LIBRARY / READY',
    headline: '书中自有<em>颜如玉</em>',
    motto: '$ read_next',
    brand: 'YAN RU YU',
  },
  {
    id: 'neon',
    name: '霓虹协议',
    label: 'VIOLET / NIGHT READING',
    desc: '紫灰石面、圆窗月光与窗边小兔。',
    colors: ['#1d1927', '#c6b2e1', '#9bced0'],
    dark: true,
    eyebrow: 'NIGHT READING / PRIVATE EDITION',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Night reading.',
    brand: 'YAN RU YU',
  },
  {
    id: 'acid',
    name: '酸性印刷',
    label: 'INDEPENDENT PRESS',
    desc: '棋盘地面、粉陶花盆与柔暖日光。',
    colors: ['#eff0e6', '#3c5523', '#b57492'],
    dark: false,
    eyebrow: 'INDEPENDENT TASTE / PRIVATE PRESS',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Your edition.',
    brand: 'YAN RU YU',
  },
  {
    id: 'glass',
    name: '纯白 · 液态玻璃',
    label: 'PURE / LIQUID GLASS',
    desc: '纯白玻璃、水磨石、薄纱晴窗与桉叶。',
    colors: ['#f5f5f7', '#2469b5', '#d8dce2'],
    dark: false,
    eyebrow: 'A CLEAR SPACE / YOUR STORIES',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'A little clarity.',
    brand: 'YAN RU YU',
  },
];

// One preference is shared by the reading room and the complete manager.
// Legacy names are accepted only while migrating; they are never offered as themes.
const LEGACY_THEMES = Object.freeze({
  light: 'paper',
  dark: 'forest',
  'light e-hentai': 'paper',
  'dark exhentai': 'ex',
  'dark nhentai': 'neon',
});

function readSaved(key) {
  try {
    const value = localStorage.getItem(key);
    if (value === null) return null;
    try { return JSON.parse(value); } catch { return value; }
  } catch { return null; }
}

export function normalizeTheme(id) {
  if (THEMES.some(theme => theme.id === id)) return id;
  return typeof id === 'string' ? LEGACY_THEMES[id.trim()] || null : null;
}

export function resolveTheme(legacySettingTheme) {
  return normalizeTheme(readSaved('room-theme'))
    || (readSaved('room-night') === true ? 'forest' : null)
    || normalizeTheme(readSaved('appTheme'))
    || normalizeTheme(legacySettingTheme)
    || 'paper';
}

export function saveThemePreference(id) {
  const theme = normalizeTheme(id) || 'paper';
  try {
    localStorage.setItem('room-theme', JSON.stringify(theme));
    for (const key of ['appTheme', 'room-night', 'lastDarkTheme', 'lastLightTheme']) {
      localStorage.removeItem(key);
    }
  } catch { /* The current session still works if storage is unavailable. */ }
  return theme;
}

export function paintTheme(id) {
  const theme = THEMES.find(item => item.id === id) || THEMES[0];
  const root = document.documentElement;
  root.classList.remove('e-hentai', 'exhentai', 'nhentai');
  root.classList.toggle('dark', theme.dark);
  root.classList.toggle('light', !theme.dark);
  root.classList.toggle('night', theme.id === 'forest');
  root.dataset.roomTheme = theme.id;
  root.dataset.themeDark = String(theme.dark);

  const set = (selector, value, html = false) => {
    const element = document.querySelector(selector);
    if (!element) return;
    if (html) element.innerHTML = value;
    else element.textContent = value;
  };
  set('.hero .eyebrow', theme.eyebrow);
  set('.hero h1', theme.headline, true);
  set('.room-card', `${theme.motto}<small>${theme.brand}</small>`, true);
  set('.brand small', theme.brand);
  set('#active-theme-name', theme.name);
  set('.theme-current', `当前：${theme.name} · 点击切换，自动保存`);
  document.querySelectorAll('[data-theme-choice]').forEach(element => {
    element.setAttribute('aria-pressed', String(element.dataset.themeChoice === theme.id));
  });
  return theme;
}

export function themeCards(active) {
  return `<div class="theme-grid" role="group" aria-label="选择外观主题">${THEMES.map((theme, index) => {
    const wordmark = theme.id === 'hub' ? '颜如<b>玉</b>' : '颜如玉';
    return `<button class="theme-card" data-theme-choice="${theme.id}" aria-pressed="${active === theme.id}" style="--preview-bg:${theme.colors[0]};--preview-accent:${theme.colors[1]};--preview-detail:${theme.colors[2]}">
      <span class="theme-preview preview-${theme.id}" aria-hidden="true">
        <span class="preview-sidebar"></span><span class="preview-heading">${wordmark}</span>
        <span class="preview-books"><i></i><i></i><i></i></span><span class="preview-plank"></span><span class="theme-check">✓</span>
      </span>
      <span class="theme-card-label"><strong>${theme.name}</strong><small>${String(index + 1).padStart(2, '0')}</small></span>
      <span class="theme-card-sub">${theme.label}</span><span class="theme-card-desc">${theme.desc}</span>
    </button>`;
  }).join('')}</div>`;
}
