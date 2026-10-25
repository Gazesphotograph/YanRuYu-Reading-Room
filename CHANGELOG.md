# 更新日志 / Changelog

# 1.6.16 — 2026-10-25

## 中文

这是颜如玉定制版首次独立发布，版本 **1.6.16**，基于 exhentai-manga-manager **1.6.15**。

### 包含内容

- 3D 书架、8 套主题、液态玻璃界面、完整书库管理与内置阅读器。
- 阅读进度与偏好、智能书架、受容量限制的解压缓存。
- 可撤销的批量整理、重复合并、缺失文件检查、书库重新定位。
- 本地别名与文本检索、Windows OCR、相似书推荐。
- 房间布置、精选陈列、阅读统计、可选环境音。
- 备份与恢复、损坏恢复入口，以及独立的开发与测试数据目录。

### 本次工程整理

- 中文默认 README 与独立英文 README、21:9 全屏实测截图、文档索引和版本记录。
- 保留上游来源、MIT 署名及第三方许可证。
- 修复 npm 12 安装策略下 SQLite 原生模块未安装的问题；构建在打包前验证 SQLite 和图片依赖可以加载。
- 只提交源码、工具、依赖锁和文档；发布包不含书库、封面、设置、阅读状态或浏览器资料。

### 下载与升级

下载附件中的 Windows x64 ZIP，解压后运行程序。普通使用不需要 Node.js。SHA256SUMS.txt 提供 ZIP 的 SHA-256 校验值。

升级前在应用中创建并验证备份，退出旧版，再把新版本解压到新目录，并按 README 中的升级文档指定原数据目录。

### 已知边界

- 目前仅提供 Windows x64 发布包。
- Windows OCR 依赖系统安装的相应语言识别组件。
- 当前管理界面的定制产物完整保留，但全部对应 Vue 修改与原 sourcemap 尚未恢复；上游 Vue 源码仅作为参考工程。
- 未提供安卓导出、跨设备续读或局域网共享。

---

## English

This is the first standalone release of the 颜如玉 Custom Edition, version **1.6.16**, based on exhentai-manga-manager **1.6.15**.

### What's Included

- 3D bookshelf, 8 themes, liquid glass interface, comprehensive library management, and built-in reader.
- Reading progress and preferences, smart bookshelf, and decompression cache with capacity limits.
- Undoable batch organization, duplicate merging, missing file checks, and library relocation.
- Local aliases and text search, Windows OCR, and recommendations for similar books.
- Room layout, curated displays, reading statistics, and optional ambient sounds.
- Backup and restore, a recovery portal for corrupted data, and separate development and test data directories.

### Organization of This Project

- Default Chinese README and separate English README, 21:9 full-screen screenshots, documentation index, and changelog.
- Retained upstream sources, MIT attribution, and third-party licenses.
- Fixed an issue where the native SQLite module was not installed under the npm 12 installation policy; the build now verifies that SQLite and image dependencies can be loaded before packaging.
- Only source code, tools, dependency locks, and documentation are committed; the release package does not include the book library, covers, settings, reading status, or browser data.

### Download and Upgrade

Download the Windows x64 ZIP file from the attachments, unzip it, and run the program. Node.js is not required for normal use. SHA256SUMS.txt provides the SHA-256 checksums for the ZIP file.

Before upgrading, create and verify a backup within the application, exit the old version, then unzip the new version into a new directory, and specify the original data directory as outlined in the upgrade instructions in the README.

### Known Limitations

- Currently, only a Windows x64 release package is available.
- Windows OCR relies on the corresponding language recognition components installed on the system.
- Customizations made to the current management interface are fully preserved, but all corresponding Vue modifications and the original sourcemap have not yet been restored; the upstream Vue source code is provided for reference only.
- Android export, cross-device resume, and LAN sharing are not supported.
