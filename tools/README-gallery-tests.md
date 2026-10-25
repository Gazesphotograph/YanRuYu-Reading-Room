# 三维图库回归检查

2026-09-14 跨电脑迁移与重复记录修复：

```powershell
node --test tools/test-reading-relocation.cjs tools/test-reading-merge-scan.cjs tools/test-reading-identity.cjs tools/test-library-organizer.cjs
node tools/test-reading-relocation-desktop.cjs
node tools/test-library-organizer-ui.cjs
node tools/test-startup-tray.cjs
```

覆盖整个书库根目录移动、完整指纹匹配、原 ID 与进度/偏好保留、不同内容和真实副本隔离、提交期间路径恢复、断开目录链接、离线旧来源的可撤销合并、同路径重复与链式合并后的再次扫描、隐藏来源改名、真实 3D 进度与重启续读。整理界面验证默认进度来源、书名与文件夹名区分；列表和托盘验证不再猜测漫画路径。全部使用中性内容及独立临时数据，不连接私人书库。

2026-09-13 第二阶段：统一 `npm test` 包含新增增量扫描/任务中心（单元、面板、真实桌面）、阅读工具、智能书架、缓存预算和场景复用回归。新测试均使用中性图片与独立数据；真实桌面和备份桌面回归完成后自动清理本次创建的临时书库。测试报告、截图和模拟页面集中到 `tools/.artifacts/`，验收摘要保存后可整目录清理。维护测试脚本继续保留。

第二阶段的筛选会跨重启保留：主题与阅读回归已相应改为断言原筛选仍有效。快速切书回归验证旧读档和缓存释放完成后只打开最后请求的书，不再依赖重复关闭旧阅读器的竞态。

主题一致性与短窗口布局回归已加入 `npm test`，也可单独运行：

```powershell
node tools/test-ui-theme-consistency.cjs --screenshots
```

覆盖 8 套主题下的任务中心、书库整理、本地发现、私人阅览室与设置；以像素对比验证整个玻璃面板确实模糊背景；检查内容滚动后的固定顶栏、弹窗关闭入口、图标居中，以及完整管理页三个快捷按钮与分页的对齐和避让。全部使用中性封面与内存模拟数据。报告和截图位于 `tools/.artifacts/ui-theme-consistency`；可用 `--case=themes,glass-panels,room-layout,dialog-layout,manager-layout` 选择检查组。

2026-09-13 封面比例、主题房间与颜如玉品牌更新：

```powershell
node tools/test-room-covers.cjs
node tools/test-room-aspects.cjs
node tools/test-room-environment.cjs
```

分别覆盖旧 500×707 缩略图留边识别和新封面生成；横、竖、方、超宽封面的同层布局、点击投影、缺失封面、八主题与显存回收；主题物件、窗光、小动物、单柜/双柜/窄窗口及极限视角。全部使用中性几何封面与隔离环境。前两份报告位于 `tools/.artifacts/cover-normalization` 和 `tools/.artifacts/room-aspects`，环境报告默认写入系统临时目录。比例检查同时生成完整界面的纯白玻璃与林间月光预览。

2026-09-12 安全与性能补充检查：`node tools/test-security-performance.cjs`。
使用隔离数据验证页数与进度注入防护、快速切书、局域网关闭生命周期、图片删除类型限制、封面加载并发与过期任务取消、WebGL 上下文释放，并记录 30,000 本模拟书库的筛选与计数基准。结果在 `tools/.artifacts/security-performance/checks.json`。

`test-desktop-gallery.cjs` 会启动实际桌面程序。若数据库中的源书籍均不可访问，则只读验证桌面 `Comic` 内图片文件夹，也可用 `GALLERY_REAL_LIBRARY` 指定测试目录；不会把这些目录导入书库。测试结束恢复阅读偏好及其修改的阅读次数。

在程序根目录运行：

```powershell
node tools/test-gallery.cjs
```

测试会启动独立的无头 Edge，生成中性几何书封，并通过模拟 IPC 提供书库与阅读页面。收藏、阅读次数和阅读器程序设置只写入内存中的模拟数据；进度和外观只写入独立测试浏览器。外部阅读器只检查派发的路径，不启动任何外部程序。测试不连接正在运行的桌面程序。

覆盖 12 本一组的分页、25 本末页、0/1/3/12 本书库、搜索及排序、8 套主题、完整浏览器重启后的主题恢复、详情与收藏、滚轮翻页与进度恢复、详情侧栏中的阅读选项、外部阅读器选择和派发、64 页无缝瀑布阅读与按需加载、720/950/1280/1560 窗口、完整长书名提示、封面缺失、无 WebGL 降级、中键平移、滚轮缩放与边界、视角统一复位、静置停止渲染，以及减少动态效果的系统偏好。瀑布阅读检查包含后台图片尺寸消息，确保这些消息不会提前加载整本书或推进阅读进度。

默认报告为 `tools/.artifacts/gallery/checks.json`。失败时保存该用例截图，所有画面均来自模拟封面。需要完整截图时加 `--screenshots`；只运行部分用例时使用：

```powershell
node tools/test-gallery.cjs --case=scene-controls,reader-options,continuous,titles --screenshots
```

可选用例名：`pagination`、`themes`、`restart`、`reading`、`reader-options`、`continuous`、`densities`、`layouts`、`titles`、`scene-controls`、`covers`、`fallback`、`reduced-motion`。

`playwright-runtime.cjs` 会依次查找指定环境路径、当前工程依赖和当前用户的 Codex 内置 Playwright。可通过 `CODEX_PLAYWRIGHT_PATH` 指定模块目录，通过 `GALLERY_BROWSER_PATH` 指定 Edge 或 Chromium 可执行文件，通过 `GALLERY_TEST_OUTPUT` 指定结果目录。

`test-gallery.cjs` 还导出 `createFixtures`、`createFakeModel`、`attachFakeIpc`、`launchOptions` 和 `appURL`，供其他模拟书库截图脚本复用。

生成的测试报告、截图和模拟书页均可在完成检查后删除；后续运行会重新生成。程序运行文件和真实书库数据不属于测试输出。

纯白玻璃另有专项检查：

```powershell
node tools/test-liquid-glass.cjs --screenshots
```

使用相同的隔离模拟书库，检查背景折射像素、文字与点击区域、动态详情、窄窗口、主题切换与资源释放，以及减少动态/透明度的降级。报告和截图默认写入系统临时目录，可通过 `LIQUID_GLASS_TEST_OUTPUT` 指定位置。可用 `--case=lifecycle,optics,content,preferences` 选择检查组。

完整管理页的液态玻璃专项检查：

```powershell
node tools/test-manager-glass.cjs
```

同样使用中性书封、内存模拟数据和独立浏览器，不连接真实数据库或正在运行的程序。覆盖光学资源回收、真实控件的条纹背景折射、搜索与排序、设置与详情、文件夹及右键菜单、标签与合集操作栏、分页与滚动、两种界面往返、减少动态/透明度与高对比度降级。布局检查覆盖 720、950、1280、1560 像素宽度，验证统计条完整显示、工具栏和分页不被裁剪或遮挡；详情主按钮验证默认及悬停状态的文字对比，管理侧栏检查控件实际位于窗口内并能命中。

报告和截图位于 `tools/.artifacts/manager-glass`。截图会等字体与有限入场动画结束；示例元数据也使用有效日期和大小。Firefox 降级分支通过 Chromium 的用户代理模拟验证，不代表原生 Firefox 渲染测试。`test-manager-glass.cjs` 可作为模块导入以复用隔离页面及截图辅助函数，导入不会自动运行测试。

本次修复的补充检查：

```powershell
node tools/test-room-repair.cjs
node tools/test-scene-motion.cjs
node tools/test-manager-themes.cjs
node tools/test-startup-tray.cjs
node tools/test-room-author-sort.cjs
```

分别覆盖标签去重与交集、组合计数、顶栏拖动区域样式及事件、详情边框与主按钮、128 页往返与图片保留范围；反转拖动、场景/阴影/封面复用；管理页 8 主题、往返同步、旧偏好迁移和关于移除；主进程启动即创建托盘、退出与设置生命周期，以及新阅读器跳过整本图片处理、旧调用兼容。

作者排序检查覆盖中文与数字自然顺序、大小写、多作者、缺失作者、同作者书名排序、分页与筛选、3D 书架、刷新后的排序记忆，以及书库更新后的排序缓存重建。

上述检查使用中性书封与模拟数据。浏览器或 Electron 的自动点击不能单独证明 Windows 原生窗口拖动命中；需要时可运行 `preview-native-repair.cjs` 准备一个使用独立配置与模拟 IPC 的桌面验证窗口，再用原生鼠标检查。临时运行目录位于 `tmp/native-repair-runtime`，不连接真实数据库。
