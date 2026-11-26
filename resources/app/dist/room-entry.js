(async () => {
  await import('./client-state.js');
  if (localStorage.getItem('reading-room-interface') === 'classic') {
    if (!localStorage.getItem('room-workspace-start-page')) localStorage.setItem('room-workspace-start-page', '"library"');
  }
  localStorage.removeItem('reading-room-interface');
  localStorage.removeItem('room-workspace-preview');
  await import('./theme-init.js');
  await (await import('./reading-state.js')).initializeReadingState();

  const styles = ['./room.css', './room-themes.css', './room-scene.css', './room-glass.css', './room-shelves.css', './room-reader-tools.css', './room-personalization.css', './room-workspace.css', './room-management.css'];
  for (const href of [...styles, './room-fonts.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }

  await import('./room.js');
})().catch(error => {
  console.error('Interface startup failed:', error);
  const message = document.createElement('p');
  message.textContent = '阅览室暂时未能载入。原始数据已保留，可以重新启动，或打开备份与恢复。';
  message.style.cssText = 'margin:0 0 18px;font:16px/1.7 system-ui;color:#46515e';
  const detail = document.createElement('p'); detail.textContent = error.message || String(error);
  detail.style.cssText = 'font:13px/1.6 system-ui;color:#6c747b;overflow-wrap:anywhere';
  const button = document.createElement('button'); button.type = 'button'; button.textContent = '打开备份与恢复';
  button.style.cssText = 'padding:10px 18px;border:1px solid #5c7665;border-radius:12px;background:#345d47;color:white;cursor:pointer';
  button.onclick = async () => { try { (await import('./data-protection.js')).openDataProtection(); } catch (failure) { detail.textContent = failure.message; } };
  const panel = document.createElement('section'); panel.style.cssText = 'margin:60px auto;padding:28px;max-width:680px';
  panel.setAttribute('data-recovery-mode', 'true'); panel.append(message, detail, button);
  document.querySelector('#app')?.replaceChildren(panel);
});
