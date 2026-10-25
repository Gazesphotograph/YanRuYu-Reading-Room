import { paintTheme, resolveTheme } from './room-themes.js';

// Loaded before either interface, so the first painted surface uses the same theme.
// Persistence happens on a real choice or after the manager loads legacy settings.
export const initialTheme = paintTheme(resolveTheme());
document.documentElement.style.backgroundColor = initialTheme.colors[0];
