const glyphs = {
  scan: ['M12 5a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'M20 5v5h-5 M4 19v-5h5 M5.4 9A7.2 7.2 0 0 1 18.3 7.6L20 10 M4 14l1.7 2.4A7.2 7.2 0 0 0 18.6 15'],
  metadata: ['M3 3h7l11 11-7 7L3 10z', 'M3 3h7l11 11-7 7L3 10z M7.5 7.5h.01', 'M18 1.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'],
  tasks: ['M5 5h14v16H5z', 'M5 5h3 M16 5h3 M5 5v16h14V5 M9 3h6v4H9z', 'M8.5 13.5l2.3 2.3 4.8-4.8'],
  history: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M21 12a9 9 0 1 1-2.6-6.4 M21 3v5h-5 M12 7.5V12l3 2'],
  organizer: ['M15 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z M9 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z', 'M3 7h9.5 M17.5 7H21 M3 17h3.5 M11.5 17H21 M15 4.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z M9 14.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z'],
  import: ['M3 14h5l1.5 2.5h5L16 14h5v6H3z', 'M12 3v9 M8 8.5l4 4 4-4 M3 14v6h18v-6 M3 14l2.5-6H8 M21 14l-2.5-6H16 M3 14h5l1.5 2.5h5L16 14h5'],
  discovery: ['M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z', 'M21 21l-5.6-5.6 M17 10.5a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0', 'M10.5 7l.9 2.6 2.6.9-2.6.9-.9 2.6-.9-2.6-2.6-.9 2.6-.9z'],
  folder: ['M3 9h18v10H3z', 'M3 19V5h6l2 2.5h10V19z M3 10h18'],
  settings: ['M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z', 'M10 3h4l.7 2.6 2.3 1.3 2.6-.7 2 3.5-1.9 1.9v2.8l1.9 1.9-2 3.5-2.6-.7-2.3 1.3L14 21h-4l-.7-2.6-2.3-1.3-2.6.7-2-3.5 1.9-1.9v-2.8L2.4 7.7l2-3.5 2.6.7 2.3-1.3z M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  desk: ['M4 12h16v3H4z M13.5 4.5h4.5l-1.5 4.5h-4z', 'M3 12h18 M5 12v8 M19 12v8 M4 15h16 M8 12V9.5A1.5 1.5 0 0 1 9.5 8H11 M15 12l1-3 M13.5 4.5h4.5l-1.5 4.5h-4z'],
  library: ['M4 4h4v16H4z M14.5 4.6l3.8-1 4 15.4-3.8 1z', 'M4 4h4v16H4z M10 6h4v14h-4z M14.5 4.6l3.8-1 4 15.4-3.8 1z M2 20h20'],
  room: ['M12 3l8 4.5L12 12 4 7.5z', 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M4 7.5l8 4.5 8-4.5 M12 12v9'],
  books: ['M4 5h5v15H4z', 'M4 5h5v15H4z M9 7h4v13H9z M14 6.2l3.6-1.2 4 13.8-3.6 1.2z'],
  reading: ['M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3z', 'M3 5h7a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H3z M21 5h-7a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h7z'],
  finished: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', 'M8 12.3l2.7 2.7L16.3 9.4'],
  unread: ['M6 3h12v18l-6-4-6 4z', 'M6 3h12v18l-6-4-6 4z M12 7v6 M9 10h6'],
  heart: ['M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z', 'M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z'],
  play: ['M8 5.5v13l10.5-6.5z', 'M8 5.5v13l10.5-6.5z'],
  restart: ['', 'M4 4v6h6 M4.6 15a8 8 0 1 0 1.9-8.3L4 10'],
  info: ['', 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z M12 11v6 M12 7.5h.01'],
  dice: ['M5 5h14v14H5z', 'M5 5h14v14H5z', 'M9 9h.01 M15 9h.01 M12 12h.01 M9 15h.01 M15 15h.01'],
  spark: ['M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z', 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z'],
  filter: ['M3 5h18l-7 8v5l-4 2v-7z', 'M3 5h18l-7 8v5l-4 2v-7z'],
};
export const glyph = name => {
  const [fill, stroke, accent] = glyphs[name] || glyphs.books;
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true">${fill ? `<path class="glyph-fill" d="${fill}"/>` : ''}<path class="glyph-line" d="${stroke}"/>${accent ? `<path class="glyph-accent" d="${accent}"/>` : ''}</svg>`;
};
const navButton = (action, name, label, tone, extra = '') =>
  `<button class="nav-btn" data-action="${action}" data-tone="${tone}" title="${label}"${extra}><span class="nav-ico">${glyph(name)}</span><span>${label}</span>${action === 'tasks' ? '<span id="task-count" class="count" hidden></span>' : ''}</button>`;

export function shellMarkup(icon) {
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand" aria-label="颜如玉"><div class="brand-mark" aria-hidden="true"><span class="brand-seal">玉</span></div><div class="brand-copy"><strong><span>颜如</span><b>玉</b></strong><small>YAN RU YU</small></div></div>
      <section class="tag-browser" aria-label="标签筛选">
        <div class="tag-browser-heading"><span>标签筛选</span><span id="tag-total" class="count">0</span><button class="icon-btn tag-mobile-trigger" data-action="tag-browser" title="标签筛选" aria-label="标签筛选">${icon('tag')}</button></div>
        <label class="tag-search">${icon('search')}<input id="tag-search" placeholder="查找标签…" aria-label="查找标签" autocomplete="off"></label>
        <select id="tag-group" aria-label="标签分组"><option value="">所有分组</option></select>
        <p class="tag-browser-note">点击包含 · 右侧 − 排除</p>
        <div id="tag-list" class="tag-list" role="group" aria-label="书库标签"></div>
        <button class="tag-more" data-action="more-tags" hidden>显示更多标签</button>
      </section>
      <div class="nav-label">整理书库</div>
      ${navButton('scan', 'scan', '扫描书库', 'emerald')}
      ${navButton('metadata-batch', 'metadata', '批量拉取元数据', 'violet')}
      ${navButton('organizer', 'organizer', '整理与检查', 'amber', ' aria-label="批量整理与书库检查"')}
      ${navButton('library-import', 'import', '书库导入', 'cyan')}
      <div class="nav-label nav-label-sub">发现与记录</div>
      ${navButton('discovery', 'discovery', '本地检索', 'teal', ' aria-label="本地检索与相似推荐"')}
      ${navButton('reading-history', 'history', '阅读记录', 'indigo')}
      ${navButton('tasks', 'tasks', '任务中心', 'emerald')}
      ${navButton('library', 'folder', '书库文件夹', 'amber', ' aria-label="选择书库文件夹"')}
      <div class="sidebar-bottom">
        <div id="now-reading" class="now-reading" hidden></div>
        ${navButton('settings', 'settings', '阅览室设置', 'slate')}
        <div class="library-note"><span class="library-note-head"><span class="status-dot"></span>本地私人书库</span><span id="local-count">正在整理书架…</span></div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="window-drag-region"></div>
        <nav class="workspace-nav" aria-label="主导航">
          <button type="button" data-workspace="desk" data-tone="amber">${glyph('desk')}书桌</button>
          <button type="button" data-workspace="library" data-tone="cyan">${glyph('library')}书库</button>
          <button type="button" data-workspace="room" data-tone="violet">${glyph('room')}阅览室</button>
        </nav>
        <div class="top-actions">
          <div class="search-capsule">
            <label class="search">${icon('search')}<input id="search" aria-label="搜索书名、作者或标签" placeholder="找一本书，或一个标签…" autocomplete="off"><kbd>Ctrl K</kbd></label>
            <select id="search-scope" aria-label="搜索范围"><option value="metadata">书目信息</option><option value="all">书目与文本</option><option value="text">页内文本</option></select>
          </div>
          <button class="appearance-button" data-action="theme" title="外观主题" aria-label="外观主题">${icon('palette')}<span class="theme-dots" aria-hidden="true"><i></i><i></i><i></i></span><span>外观</span></button>
          <div class="window-controls"><button data-action="minimize" title="最小化" aria-label="最小化">${icon('minimize')}</button><button data-action="maximize" title="最大化" aria-label="最大化">${icon('maximize')}</button><button data-action="close-window" title="关闭窗口" aria-label="关闭窗口">${icon('close')}</button></div>
        </div>
      </header>
      <div class="content">
        <section id="reading-desk" aria-label="书桌" hidden><h1>书桌</h1><p>正在打开书库…</p></section>
        <div id="catalog-workspace">
        <div class="room-context" hidden><span class="room-context-badge" aria-hidden="true">${glyph('room')}</span><strong id="room-context-label"></strong><button class="pill-button" data-action="personalization" title="布置私人阅览室" aria-label="布置私人阅览室">${glyph('spark')}<span>布置阅览室</span></button><div id="room-selection"></div></div>
        <div class="toolbar">
          <div class="collection-filters">
            <div class="filters" role="group" aria-label="阅读状态">
              <button class="filter active" data-filter="all" aria-pressed="true">全部藏书 <span id="filter-count"></span></button>
              <button class="filter" data-filter="reading" aria-pressed="false">阅读中 <span id="count-reading"></span></button>
              <button class="filter" data-filter="finished" aria-pressed="false">已读完 <span id="count-finished"></span></button>
              <button class="filter" data-filter="unread" aria-pressed="false">未开始 <span id="count-unread"></span></button>
            </div>
            <button class="pill-button favorites-filter" data-action="favorites" aria-pressed="false" title="只看收藏">${glyph('heart')}<span>收藏</span><span id="count-favorites"></span></button>
          </div>
          <div class="view-tools"><select id="sort" aria-label="书籍排序"><option value="recent">最近入藏</option><option value="title">书名顺序</option><option value="author">作者顺序</option><option value="pages">页数最多</option><option value="rating">评分最高</option></select><div class="view-toggle"><button data-view="grid" title="平铺封面" aria-label="平铺封面">${icon('grid')}</button><button data-view="table" title="表格视图" aria-label="表格视图">${icon('table')}</button></div></div>
        </div>
        <div class="shelf-tools" aria-label="书架与合集">
          <button class="pill-button filter-trigger" data-action="catalog-filter" aria-haspopup="dialog">${glyph('filter')}<span>目录与组合筛选</span></button>
          <div class="tool-group">
            <label class="shelf-control"><span>智能书架</span><select id="smart-shelf" aria-label="智能书架"><option value="">当前筛选</option></select></label>
            <button class="pill-button" data-action="save-shelf" title="把当前搜索和筛选保存为智能书架">保存筛选</button>
            <button class="pill-button" data-action="manage-shelves">管理书架</button>
          </div>
          <button class="pill-button featured-toggle" data-action="featured" aria-pressed="false">${glyph('spark')}<span>精选陈列</span></button>
          <button class="pill-button" id="reset-filters" data-action="reset" hidden>清除筛选</button>
          <div class="tool-group collection-control">
            <label class="shelf-control"><span>合集</span><select id="collection-select" aria-label="按合集浏览"><option value="">全部合集与单本</option></select></label>
            <button class="pill-button" data-action="collections">管理合集</button>
          </div>
          <label class="shelf-control density-control" id="density-control" hidden><span>平铺密度</span><select id="grid-density" aria-label="平铺密度"><option value="comfortable">舒展 · 12 本</option><option value="standard">适中 · 24 本</option><option value="compact">紧凑 · 48 本</option></select></label>
        </div>
        <div id="active-tags" class="active-tags" aria-label="已选择的标签" hidden></div>
        <p id="workspace-search-status" class="path" role="status" hidden></p>
        <div id="filtered-book-notice" class="filtered-book-notice" hidden><span role="status">这本书已移出当前筛选。</span><button class="pill-button" data-show-filtered-book="">查看此书</button></div>
        <div id="table-selection" hidden>
          <span id="table-selected-count" role="status"></span>
          <button class="pill-button" data-action="edit-checked-books">批量编辑所选书籍</button>
          <button class="pill-button" data-action="collect-checked-books">加入合集</button>
          <button class="pill-button" data-action="import-checked-books">导入所选元数据</button>
          <button class="pill-button" data-action="compare-books">对照所选书籍</button>
          <button class="pill-button" data-action="clear-table-selection">清空选择</button>
          <button class="pill-button" data-action="organizer-history">整理历史</button>
        </div>
        <div class="shelf-heading"><strong id="shelf-title">COLLECTION / 01</strong><span>你的故事，井然有序</span></div>
        <div id="room" class="room"><div class="empty">${icon('shelf')}<h2>正在整理你的书架</h2><p>即将展示已保存漫画的封面</p></div></div>
        <footer class="shelf-footer"><span id="results"></span><span class="quiet-note">${icon('leaf')}点击详情 · 双击阅读</span><div class="pagination"><button data-action="prev" aria-label="上一组书架">${icon('left')}</button><span id="pagination">01 / 01</span><button data-action="next" aria-label="下一组书架">${icon('right')}</button><form id="shelf-jump" class="shelf-jump"><input id="shelf-page" type="number" min="1" max="1" value="1" aria-label="书架页码"><button type="submit" aria-label="跳转书架页码">前往</button></form></div></footer>
        </div>
      </div>
    </main>
  </div><div id="modal-root"></div><div id="reader-root"></div><div id="toast" class="toast" role="status" hidden></div>`;
}
