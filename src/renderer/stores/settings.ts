import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { hasIpc, invoke } from '../services/ipc';
import type {
  AppSetting,
  QualityPreset,
  QualityPresetId,
  ThemeId,
  WorkspaceStartPage,
} from '../types/settings';

const MiB = 1024 ** 2;

export const CANONICAL_THEMES: readonly ThemeId[] = Object.freeze(['paper', 'dark', 'glass', 'ex']);

export const DARK_THEMES: ReadonlySet<ThemeId> = new Set<ThemeId>(['dark', 'ex']);

export const LEGACY_THEME_MIGRATION_MAP: Readonly<Record<string, ThemeId>> = Object.freeze({
  paper: 'paper',
  dark: 'dark',
  glass: 'glass',
  ex: 'ex',
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

export const QUALITY_PRESETS: Readonly<Record<QualityPresetId, QualityPreset>> = Object.freeze({
  power: Object.freeze({
    id: 'power',
    label: '省电',
    pixelRatio: 1,
    shadows: false,
    shadowSize: 512,
    shadowSamples: 2,
    anisotropy: 1,
    coverDimension: 512,
    coverBudgetBytes: 24 * MiB,
    coverCount: 18,
    coverConcurrency: 2,
    dust: false,
  }),
  balanced: Object.freeze({
    id: 'balanced',
    label: '平衡',
    pixelRatio: 1.5,
    shadows: true,
    shadowSize: 1024,
    shadowSamples: 4,
    anisotropy: 4,
    coverDimension: 1024,
    coverBudgetBytes: 96 * MiB,
    coverCount: 32,
    coverConcurrency: 4,
    dust: true,
  }),
  fine: Object.freeze({
    id: 'fine',
    label: '精细',
    pixelRatio: 2,
    shadows: true,
    shadowSize: 2048,
    shadowSamples: 8,
    anisotropy: 8,
    coverDimension: 1600,
    coverBudgetBytes: 192 * MiB,
    coverCount: 48,
    coverConcurrency: 4,
    dust: true,
  }),
});

export function normalizeThemeId(value: unknown): ThemeId | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  if (!key) return null;
  return Object.hasOwn(LEGACY_THEME_MIGRATION_MAP, key) ? LEGACY_THEME_MIGRATION_MAP[key] : null;
}

export function resolveThemeId(candidates: {
  roomTheme?: unknown;
  roomNight?: unknown;
  appTheme?: unknown;
  settingTheme?: unknown;
}): ThemeId {
  return (
    normalizeThemeId(candidates.roomTheme) ||
    (candidates.roomNight === true ? 'dark' : null) ||
    normalizeThemeId(candidates.appTheme) ||
    normalizeThemeId(candidates.settingTheme) ||
    'paper'
  );
}

export function normalizeQualityPreset(value: unknown): QualityPresetId {
  return typeof value === 'string' && Object.hasOwn(QUALITY_PRESETS, value)
    ? (value as QualityPresetId)
    : 'balanced';
}

export function getQualityPreset(value: unknown): QualityPreset {
  return QUALITY_PRESETS[normalizeQualityPreset(value)];
}

export function normalizeStartPage(value: unknown): WorkspaceStartPage {
  return value === 'library' || value === 'room' ? value : 'desk';
}

export function normalizeAppSetting(input: unknown): AppSetting {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return { ...(input as AppSetting) };
}

function readLocalStorageJson(key: string): unknown {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  } catch {
    return null;
  }
}

function writeLocalStorageJson(key: string, value: unknown): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage quota or sandbox restrictions.
  }
}

function applyThemeToDom(theme: ThemeId): void {
  if (typeof document === 'undefined' || !document.documentElement) return;
  const root = document.documentElement;
  const isDark = DARK_THEMES.has(theme);
  root.classList.remove('e-hentai', 'exhentai', 'nhentai', 'night');
  root.classList.toggle('dark', isDark);
  root.classList.toggle('light', !isDark);
  root.dataset.roomTheme = theme;
  root.dataset.themeDark = String(isDark);
}

export const useSettingsStore = defineStore('settings', () => {
  const setting = ref<AppSetting>({});
  const theme = ref<ThemeId>('paper');
  const quality = ref<QualityPresetId>('balanced');
  const startPage = ref<WorkspaceStartPage>('desk');
  const loaded = ref(false);
  const saving = ref(false);
  const error = ref<string | null>(null);

  const isDarkTheme = computed(() => DARK_THEMES.has(theme.value));
  const qualityPreset = computed<QualityPreset>(() => QUALITY_PRESETS[quality.value]);

  function hydrateLocalPreferences(legacySettingTheme?: unknown): void {
    theme.value = resolveThemeId({
      roomTheme: readLocalStorageJson('room-theme'),
      roomNight: readLocalStorageJson('room-night'),
      appTheme: readLocalStorageJson('appTheme'),
      settingTheme: legacySettingTheme,
    });
    quality.value = normalizeQualityPreset(readLocalStorageJson('room-quality'));
    startPage.value = normalizeStartPage(readLocalStorageJson('room-workspace-start-page'));
    applyThemeToDom(theme.value);
  }

  async function load(): Promise<AppSetting> {
    error.value = null;
    try {
      if (hasIpc()) {
        const raw = await invoke('load-setting');
        setting.value = normalizeAppSetting(raw);
      }
      hydrateLocalPreferences(setting.value.theme);
      loaded.value = true;
      return setting.value;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  async function saveSetting(patch: Partial<AppSetting>): Promise<AppSetting> {
    const next: AppSetting = { ...setting.value, ...patch };
    saving.value = true;
    error.value = null;
    try {
      if (hasIpc()) {
        const saved = await invoke('save-setting', next);
        setting.value =
          saved && typeof saved === 'object' && !Array.isArray(saved)
            ? normalizeAppSetting(saved)
            : next;
      } else {
        setting.value = next;
      }
      return setting.value;
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      saving.value = false;
    }
  }

  function setTheme(nextTheme: ThemeId | string): ThemeId {
    const normalized = normalizeThemeId(nextTheme) ?? 'paper';
    theme.value = normalized;
    writeLocalStorageJson('room-theme', normalized);
    if (typeof localStorage !== 'undefined') {
      try {
        for (const legacyKey of ['appTheme', 'room-night', 'lastDarkTheme', 'lastLightTheme']) {
          localStorage.removeItem(legacyKey);
        }
      } catch {
        // Ignore storage cleanup failures.
      }
    }
    applyThemeToDom(normalized);
    return normalized;
  }

  function setQuality(nextQuality: QualityPresetId | string): QualityPresetId {
    const normalized = normalizeQualityPreset(nextQuality);
    quality.value = normalized;
    writeLocalStorageJson('room-quality', normalized);
    return normalized;
  }

  function setStartPage(nextPage: WorkspaceStartPage | string): WorkspaceStartPage {
    const normalized = normalizeStartPage(nextPage);
    startPage.value = normalized;
    writeLocalStorageJson('room-workspace-start-page', normalized);
    return normalized;
  }

  return {
    setting,
    theme,
    quality,
    startPage,
    loaded,
    saving,
    error,
    isDarkTheme,
    qualityPreset,
    load,
    saveSetting,
    setTheme,
    setQuality,
    setStartPage,
    hydrateLocalPreferences,
  };
});
