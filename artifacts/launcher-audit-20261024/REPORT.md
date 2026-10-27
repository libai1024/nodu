# 启动窗口样式核查（2026-10-24）

核查工作区：`/Users/wangwei/Model/k210-studio/.claude/worktrees/start-window`。
实测窗口：Electron 调试端口 9333，880 × 548 CSS px，深色和浅色主题。

## 结论

- `launcher.css` 已将无效的 `--theia-widget-border` 改为 `--theia-editorWidget-border`。本轮再修正 `embedded.css` 的 13 处无效引用，并让项目图标边框直接使用 `--theia-panel-border`。
- `widget.border` 没有注册，因此旧变量仍为空；修复方式是使用已注册的颜色 ID，而非补一个虚构变量。
- `editorWidget.border` 在 Monaco 的 `colors/editorColors.js:22` 注册，`MonacoColorRegistry` 读取 Monaco 颜色注册表；Theia 的 `ColorApplicationContribution.updateWindow()` 将变量写入 documentElement。Nodu 主题用 `nodu-theme-colors.ts` 设置具体颜色。
- `toolbar.hoverBackground` 由 Theia 的 `CommonFrontendContribution.registerColors()` 注册，实测深色 rgba(90,93,94,0.31)、浅色 rgba(184,184,184,0.31)，悬停背景生效。
- `scope.mutedForeground` 由 Nodu 的 `ScopeColorContribution` 注册；`descriptionForeground` 来自 Monaco。两者实测深色 #949caa、浅色 #5b616c。启动窗口 stylesheet 引用的全部主题变量均有值。

## 级联与宽度

使用 Chrome DevTools Protocol `CSS.getMatchedStylesForNode` 查询浏览器解析后的匹配规则，未依赖 bundle 文本搜索。

- 卡片：`.nodu-launcher-card` 的 border 生效。没有匹配到清零该卡片边框的全局规则。
- 输入框：`#nodu-launcher .nodu-launcher-new .nodu-np-fields input` 的 width:100% 和 border 生效。没有匹配到清零该输入框边框的作者样式。
- 深色卡片和输入框：1px solid rgb(52,58,69)；浅色：1px solid rgb(224,227,232)。
- 字段容器同时匹配 `.nodu-np-fields`（grid / align-items:start）和 `.nodu-launcher-new .nodu-np-fields`（flex column / align-items:stretch），后者生效。
- 实测宽度链：表单 608 → 两列网格 608（160 + 446，外框2px）→ 字段容器446 → 控件398 → 输入框398。字段两侧 padding 各24px。不是 flex:1 限制到149px。

## 两个 TypeScript 文件

核查到的变动对应本聊天上一轮的芯片图标功能：

- `nodu-launcher-util.ts`：StoredProject 增加可选 tag；touchRecent 保留已有 tag。
- `nodu-projects-server.ts`：记录/加载芯片 tag；文件夹存在时更新身份，缺失时返回历史 tag。
- 可见效果是缺失项目保留厂商 Logo 和型号。它们不控制 CSS、边框或宽度。
- 后端仍返回示例 summary，但前端不再渲染它。删除显示不要求删除服务端字段。
- `node --test desktop/scope-extension/test/project-icons.cjs`：2 项通过，覆盖型号识别及文件移动/恢复后历史身份。

## 构建和截图

本轮完成 TypeScript 编译、browser/node/electron bundle 重建，再 reload Electron 窗口。

- 删除示例摘要的源码时间：13:19:12。
- 本轮扩展 JS 编译产物：13:32:54。
- 本轮 bundle.js / bundle.css：13:33:02。
- 重载后实测：4 个示例，摘要节点 0；深浅主题一致。

详见 `audit-after.json`：包含匹配选择器、声明、主题变量和宽度链。
截图：`new-dark.png`、`new-light.png`、`settings-dark.png`、`settings-light.png`、`examples-dark.png`、`examples-light.png`。
