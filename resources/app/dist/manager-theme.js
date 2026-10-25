import { THEMES, normalizeTheme, resolveTheme, paintTheme, saveThemePreference, themeCards } from './room-themes.js';

export { THEMES, themeCards };

export function applyManagerTheme(id) {
  const next = saveThemePreference(normalizeTheme(id) || resolveTheme());
  const theme = paintTheme(next);
  document.documentElement.style.backgroundColor = theme.colors[0];
  return next;
}

export function adoptManagerSettingTheme(setting) {
  // A room selection takes precedence over an older theme in setting.json.
  // Update only this field; folder, reader, account and metadata options are preserved.
  setting.theme = applyManagerTheme(resolveTheme(setting.theme));
  return setting;
}

export function managerThemeIsDark(id) {
  return THEMES.find(theme => theme.id === normalizeTheme(id))?.dark || false;
}

export function selectManagerTheme(event, onSelect) {
  const host = event.currentTarget;
  const choice = event.target.closest('[data-theme-choice]');
  if (!choice || !host.contains(choice)) return;
  const id = choice.dataset.themeChoice;
  onSelect(id);
  // Vue replaces the preview markup after selection. Preserve keyboard focus on
  // the chosen card after its render, without observing or scanning the document.
  queueMicrotask(() => host.querySelector(`[data-theme-choice="${id}"]`)?.focus({ preventScroll: true }));
}
