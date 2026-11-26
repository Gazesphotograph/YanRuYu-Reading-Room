import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './app/App.vue';
import { startLegacyInterface } from './legacy/bootstrap';

// Phase 0 of the UI refactor: the Vue root owns startup and hosts the existing
// native interface unchanged. Later phases move the shell, desk, library and
// panels into components and shrink the legacy host until it can be removed.
function mountShell(): void {
  const host = document.createElement('div');
  host.id = 'yr-root';
  document.body.append(host);
  createApp(App).use(createPinia()).mount(host);
}

try {
  mountShell();
} catch (error) {
  // A failure in the new shell must never keep the reader from opening.
  console.error('Vue shell failed to mount; continuing with the legacy interface.', error);
}

startLegacyInterface().catch(error => console.error('Legacy interface failed to load:', error));
