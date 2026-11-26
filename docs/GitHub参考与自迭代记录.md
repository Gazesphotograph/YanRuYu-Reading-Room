# GitHub 参考与自迭代记录

2026-11-26。先完成 2.0 管理能力接入并通过完整测试，再阅读以下公开源码和文档，落实一轮改进。参考版本与 URL 同时保存在 `tools/.artifacts/github-reference/references.json`。

| 参考 | 已核对的行为 | 本项目的改进 |
| --- | --- | --- |
| [Playnite 筛选与预设](https://github.com/Playnite/Docs/blob/41d6529c7b96335211777031e5a7b36b86cd982a/docs/manual/features/filtersAndFiltersPresets.md) | 筛选组合可保存、重新选择和修改，桌面及全屏入口共用预设 | 同一页内文本查询刷新书目时，先保留上次确认的结果与勾选；新结果到达后再更新成员。查询、房间往返与返回焦点使用原状态 |
| [Komga 图像阅读器](https://github.com/gotson/komga/blob/19cb01b005af7f8299bc08adc2f09c339cbeb924/komga-webui/src/views/DivinaReader.vue) | 第 459–468 行恢复阅读器偏好；第 711–725 行分别恢复页码，并将系列方向作为本次覆写应用 | 原内置阅读器和 2.0 共用每本书的单页、双页、连续模式。切换入口读回统一偏好，页码仍按同一本书保存；保留旧像素宽度等兼容选项 |
| [calibre HTML 元数据解析](https://github.com/kovidgoyal/calibre/blob/297790066652cbef004680f00614d3ea3baf359b/src/calibre/ebooks/metadata/html.py) | 导入元数据时先对字符引用进行解码，再提取字段 | 标题和标签使用完整标准实体解码，覆盖 `&eacute;`、复合命名字符与数字字符引用。使用固定版本的 he 1.2.0，并保留 MIT 许可和 SHA-256 |

这些行为通过现有服务和适配器实现。新增解码器来源与许可见 [HE-NOTICE](../resources/app/modules/vendor/HE-NOTICE.md)。

## 同轮复核

来源以 HTTP 200 返回登录拦截图片时，拉取入口现在提示更新 Cookie，避免显示成空搜索。窄窗截图复核发现按钮样式会覆盖原生 `hidden`，已在管理面板中明确隐藏无后续内容的「显示更多」。

专项测试覆盖完整实体解码、图片响应、只含打开时间的记录、低记录量的更多按钮、等待新文本结果期间的勾选保留，以及原阅读器改为双页后从 2.0 恢复同一本书的模式和第 10 页。阅读器补丁工具连续执行两次，均通过匹配验证。

```powershell
node tools/test-metadata-sources.cjs
node tools/test-metadata-history-ui.cjs
node tools/test-workspace-management-ui.cjs
node tools/test-reading-bridge.cjs
```

完整工程及桌面回归结果记录在[产品迭代计划](颜如玉2.0产品标准与迭代计划.md)，入口与数据契约见[功能验收矩阵](颜如玉2.0功能验收矩阵.md)。
