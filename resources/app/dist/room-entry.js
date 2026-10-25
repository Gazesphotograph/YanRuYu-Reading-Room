(async () => {
  await import('./client-state.js');
  const classic = localStorage.getItem('reading-room-interface') === 'classic';
  document.documentElement.classList.toggle('manager-interface', classic);
  await import('./theme-init.js');
  await (await import('./reading-state.js')).initializeReadingState();

  const styles = classic
    ? ['./assets/index-CCnLQEYT.css', './room-themes.css', './manager-themes.css', './manager-glass.css']
    : ['./room.css', './room-themes.css', './room-scene.css', './room-glass.css', './room-shelves.css', './room-reader-tools.css', './room-personalization.css'];
  for (const href of [...styles, './room-fonts.css']) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.append(link);
  }

  if (classic) {
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'manager-room-return';
    back.textContent = '↗ 返回 3D 阅览室';
    back.setAttribute('aria-label', '返回 3D 阅览室');
    back.onclick = async () => {
      try { await window.readingState.flush(); }
      catch (error) { back.textContent = '进度尚未保存，请重试'; console.error(error); return; }
      localStorage.setItem('reading-room-interface', 'room');
      location.hash = '';
      location.reload();
    };
    document.body.append(back);
  }

  await import(classic ? './assets/index-Db6-k1a1.js' : './room.js');
  if (classic) {
    // The material is optional: a graphics failure must not replace the manager.
    (await import('./data-protection.js')).installManagerDataProtection();
    (await import('./task-center.js')).installManagerTaskCenter();
    try { (await import('./manager-glass.js')).initManagerGlass(); }
    catch (error) { console.warn('Glass enhancement unavailable:', error); }
  }
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
