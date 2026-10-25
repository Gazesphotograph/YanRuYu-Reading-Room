export function shellMarkup(icon) {
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand" aria-label="颜如玉"><div class="brand-mark">${icon('book')}</div><div><strong><span>颜如</span><b>玉</b></strong><small>YAN RU YU</small></div></div>
      <section class="tag-browser" aria-label="标签筛选">
        <div class="tag-browser-heading"><span>标签筛选</span><span id="tag-total" class="count">0</span><button class="icon-btn tag-mobile-trigger" data-action="tag-browser" title="标签筛选" aria-label="标签筛选">${icon('tag')}</button></div>
        <label class="tag-search">${icon('search')}<input id="tag-search" placeholder="查找标签…" aria-label="查找标签" autocomplete="off"></label>
        <select id="tag-group" aria-label="标签分组"><option value="">所有分组</option></select>
        <p class="tag-browser-note">点击包含 · 右侧 − 排除</p>
        <div id="tag-list" class="tag-list" role="group" aria-label="书库标签"></div>
        <button class="tag-more" data-action="more-tags" hidden>显示更多标签</button>
      </section>
      <div class="nav-label">书库管理</div>
      <button class="nav-btn" data-action="scan" title="扫描书库">${icon('refresh')}<span>扫描书库</span></button>
      <button class="nav-btn" data-action="tasks" title="任务中心">${icon('clock')}<span>任务中心</span><span id="task-count" class="count" hidden></span></button>
      <button class="nav-btn" data-action="organizer" title="批量整理与书库检查" aria-label="批量整理与书库检查">${icon('tag')}<span>整理与检查</span></button>
      <button class="nav-btn" data-action="discovery" title="本地检索与相似推荐" aria-label="本地检索与相似推荐">${icon('search')}<span>本地检索</span></button>
      <button class="nav-btn" data-action="personalization" title="布置私人阅览室" aria-label="布置私人阅览室">${icon('shelf')}<span>私人阅览室</span></button>
      <button class="nav-btn" data-action="library" title="选择书库文件夹">${icon('folder')}<span>书库文件夹</span></button>
      <div class="sidebar-bottom">
        <button class="nav-btn" data-action="classic" title="完整管理界面">${icon('grid')}<span>完整管理界面</span></button>
        <button class="nav-btn" data-action="settings" title="阅览室设置">${icon('settings')}<span>阅览室设置</span></button>
        <div class="library-note"><span class="status-dot"></span>本地私人书库<br><span id="local-count">正在整理书架…</span></div>
      </div>
    </aside>
    <main class="main">
      <header class="topbar">
        <div class="window-drag-region"><div class="breadcrumb">私人藏书 <span>/</span> <b id="breadcrumb">全部藏书</b></div></div>
        <div class="top-actions">
          <label class="search">${icon('search')}<input id="search" aria-label="搜索书名、作者或标签" placeholder="找一本书，或一个标签…" autocomplete="off"><kbd>Ctrl K</kbd></label>
          <button class="appearance-button" data-action="theme" title="外观主题" aria-label="外观主题">${icon('palette')}<span>外观</span></button>
          <div class="window-controls"><button data-action="minimize" title="最小化" aria-label="最小化">${icon('minimize')}</button><button data-action="maximize" title="最大化" aria-label="最大化">${icon('maximize')}</button><button data-action="close-window" title="关闭窗口" aria-label="关闭窗口">${icon('close')}</button></div>
        </div>
      </header>
      <div class="content">
        <section class="hero"><div><div class="eyebrow">A LITTLE SPACE, ALL YOUR STORIES.</div><h1>书中自有<em>颜如玉</em></h1><p id="hero-note">在自己的节奏里，翻开下一页。</p></div><div class="hero-aside"><div class="room-card">Quiet hours.<small>YAN RU YU</small></div><button class="pill-button" data-action="random">${icon('shuffle')}随手翻一本</button></div></section>
        <div class="toolbar">
          <div class="collection-filters">
            <div class="filters" role="group" aria-label="阅读状态">
              <button class="filter active" data-filter="all" aria-pressed="true">全部藏书 <span id="filter-count"></span></button>
              <button class="filter" data-filter="reading" aria-pressed="false">阅读中 <span id="count-reading"></span></button>
              <button class="filter" data-filter="finished" aria-pressed="false">已读完 <span id="count-finished"></span></button>
              <button class="filter" data-filter="unread" aria-pressed="false">未开始 <span id="count-unread"></span></button>
            </div>
            <button class="pill-button favorites-filter" data-action="favorites" aria-pressed="false" title="只看收藏">${icon('heart')}<span>收藏</span><span id="count-favorites"></span></button>
          </div>
          <div class="view-tools"><select id="sort" aria-label="书籍排序"><option value="recent">最近入藏</option><option value="title">书名顺序</option><option value="author">作者顺序</option><option value="pages">页数最多</option><option value="rating">评分最高</option></select><div class="view-toggle"><button data-view="shelf" title="立体书架" aria-label="立体书架">${icon('shelf')}</button><button data-view="grid" title="平铺封面" aria-label="平铺封面">${icon('grid')}</button></div></div>
        </div>
        <div class="shelf-tools" aria-label="书架与合集">
          <label class="shelf-control"><span>智能书架</span><select id="smart-shelf" aria-label="智能书架"><option value="">当前筛选</option></select></label>
          <button class="pill-button" data-action="save-shelf" title="把当前搜索和筛选保存为智能书架">保存筛选</button>
          <button class="pill-button" data-action="manage-shelves">管理书架</button>
          <button class="pill-button" data-action="featured" aria-pressed="false">精选陈列</button>
          <button class="pill-button" id="reset-filters" data-action="reset" hidden>清除筛选</button>
          <label class="shelf-control collection-control"><span>合集</span><select id="collection-select" aria-label="按合集浏览"><option value="">全部合集与单本</option></select></label>
          <label class="shelf-control density-control" id="density-control" hidden><span>平铺密度</span><select id="grid-density" aria-label="平铺密度"><option value="comfortable">舒展 · 12 本</option><option value="standard">适中 · 24 本</option><option value="compact">紧凑 · 48 本</option></select></label>
        </div>
        <div id="active-tags" class="active-tags" aria-label="已选择的标签" hidden></div>
        <div class="shelf-heading"><strong id="shelf-title">COLLECTION / 01</strong><span>你的故事，井然有序</span></div>
        <div id="room" class="room"><div class="empty">${icon('shelf')}<h2>正在整理你的书架</h2><p>即将展示已保存漫画的封面</p></div></div>
        <footer class="shelf-footer"><span id="results"></span><span class="quiet-note">${icon('leaf')}点击详情 · 双击阅读</span><div class="pagination"><button data-action="prev" aria-label="上一组书架">${icon('left')}</button><span id="pagination">01 / 01</span><button data-action="next" aria-label="下一组书架">${icon('right')}</button><form id="shelf-jump" class="shelf-jump"><input id="shelf-page" type="number" min="1" max="1" value="1" aria-label="书架页码"><button type="submit" aria-label="跳转书架页码">前往</button></form></div></footer>
      </div>
    </main>
  </div><div id="modal-root"></div><div id="reader-root"></div><div id="toast" class="toast" role="status" hidden></div>`;
}
