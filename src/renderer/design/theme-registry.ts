export type ThemeId = 'paper' | 'dark' | 'glass' | 'ex';

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly label: string;
  readonly desc: string;
  readonly colors: readonly [string, string, string];
  readonly dark: boolean;
  readonly eyebrow: string;
  readonly headline: string;
  readonly motto: string;
  readonly brand: string;
}

export const THEMES: readonly ThemeDefinition[] = Object.freeze([
  Object.freeze({
    id: 'paper',
    name: '颜如玉 · 暖白',
    label: 'PAPER & WALNUT',
    desc: '暖纸墙、胡桃木、午后窗光与小猫。',
    colors: ['#f5f6f8', '#137963', '#d4503a'] as const,
    dark: false,
    eyebrow: 'A ROOM FOR YOUR STORIES',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Quiet hours.',
    brand: 'YAN RU YU',
  }),
  Object.freeze({
    id: 'dark',
    name: '颜如玉 · 静夜',
    label: 'NEUTRAL DARK',
    desc: '中性深灰、深木书架、柔雾夜窗与静默光感。',
    colors: ['#0c0e13', '#38bdf8', '#34d399'] as const,
    dark: true,
    eyebrow: 'YAN RU YU / AFTER HOURS',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'Quiet night.',
    brand: 'YAN RU YU',
  }),
  Object.freeze({
    id: 'glass',
    name: '纯白 · 液态玻璃',
    label: 'PURE / LIQUID GLASS',
    desc: '纯白玻璃、水磨石、薄纱晴窗与桉叶。',
    colors: ['#f2f6fc', '#1d64e0', '#0d9488'] as const,
    dark: false,
    eyebrow: 'A CLEAR SPACE / YOUR STORIES',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'A little clarity.',
    brand: 'YAN RU YU',
  }),
  Object.freeze({
    id: 'ex',
    name: 'EX 私人图库',
    label: 'EXHENTAI INSPIRED',
    desc: '织纹墙、石材地板与米金色静夜。',
    colors: ['#1a1b20', '#e4c37b', '#df6a57'] as const,
    dark: true,
    eyebrow: 'PRIVATE GALLERY / LOCAL ARCHIVE',
    headline: '书中自有<em>颜如玉</em>',
    motto: 'The archives.',
    brand: 'YAN RU YU',
  }),
]);

export const LEGACY_THEME_MAP: Readonly<Record<string, ThemeId>> = Object.freeze({
  light: 'paper',
  'light e-hentai': 'paper',
  acid: 'paper',
  forest: 'dark',
  hub: 'dark',
  terminal: 'dark',
  neon: 'dark',
  'dark nhentai': 'dark',
  'dark exhentai': 'ex',
  gallery: 'ex',
});

const CANONICAL_IDS = new Set<ThemeId>(['paper', 'dark', 'glass', 'ex']);
const DEPRECATED_STORAGE_KEYS = ['appTheme', 'room-night', 'lastDarkTheme', 'lastLightTheme'] as const;

type StorageReader = Pick<Storage, 'getItem'>;
type StorageWriter = Pick<Storage, 'setItem' | 'removeItem'>;

function getDefaultStorage(): Storage | null {
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis ? globalThis.localStorage : null;
  } catch {
    return null;
  }
}

function readSaved(key: string, storage: StorageReader | null): unknown {
  if (!storage) return null;
  try {
    const value = storage.getItem(key);
    if (value === null) return null;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } catch {
    return null;
  }
}

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && CANONICAL_IDS.has(value as ThemeId);
}

export function normalizeTheme(id: unknown): ThemeId | null {
  if (typeof id !== 'string') return null;
  const trimmed = id.trim();
  if (!trimmed) return null;
  if (isThemeId(trimmed)) return trimmed;
  const lowered = trimmed.toLowerCase();
  if (isThemeId(lowered)) return lowered;
  return LEGACY_THEME_MAP[lowered] ?? null;
}

export function getThemeDefinition(id: ThemeId): ThemeDefinition {
  return THEMES.find(theme => theme.id === id) ?? THEMES[0];
}

export function resolveTheme(legacySettingTheme?: unknown, storage: StorageReader | null = getDefaultStorage()): ThemeId {
  return (
    normalizeTheme(readSaved('room-theme', storage)) ??
    (readSaved('room-night', storage) === true ? 'dark' : null) ??
    normalizeTheme(readSaved('appTheme', storage)) ??
    normalizeTheme(legacySettingTheme) ??
    'paper'
  );
}

export function saveThemePreference(id: unknown, storage: StorageWriter | null = getDefaultStorage()): ThemeId {
  const theme = normalizeTheme(id) ?? 'paper';
  if (storage) {
    try {
      storage.setItem('room-theme', JSON.stringify(theme));
      for (const key of DEPRECATED_STORAGE_KEYS) {
        storage.removeItem(key);
      }
    } catch {
      // The current session still works if storage is unavailable.
    }
  }
  return theme;
}

export function applyThemeToDocument(
  id: unknown,
  targetDocument: Document | null = typeof document !== 'undefined' ? document : null,
): ThemeDefinition {
  const resolvedId = normalizeTheme(id) ?? 'paper';
  const theme = getThemeDefinition(resolvedId);
  if (targetDocument?.documentElement) {
    const root = targetDocument.documentElement;
    root.classList.remove('e-hentai', 'exhentai', 'nhentai');
    root.classList.toggle('dark', theme.dark);
    root.classList.toggle('light', !theme.dark);
    root.classList.toggle('night', theme.id === 'dark');
    root.dataset.roomTheme = theme.id;
    root.dataset.themeDark = String(theme.dark);
  }
  return theme;
}
