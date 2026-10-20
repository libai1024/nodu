# Phase 5 — stock UI 中文化（zh-cn），无 @theia/plugin-ext

## 机制（与最初设想不同，原因如下）

Theia 1.76 的 `Localization.localize(localization, key, defaultValue)` 先查
`localization.replacements[defaultValue]`，再查 `translations[key]`。
`I18nPreloadContribution` 在 `defaultLocale: "zh-cn"` 时，即使没有 languagePack，
也会收集 `TextReplacementContribution` 的 `getReplacement('zh-cn')` 结果并挂到
`nls.localization.replacements`。因此按**英文默认值**建表即可覆盖所有走
`nls.localize` / `nls.localizeByDefault` 的字符串（含 `toLocalizedCommand` /
`toDefaultLocalizedCommand` 的 command label，以及 Monaco 经
`monaco-nls.js` 转接到 Theia nls 的字符串），无需推导 vscode key。
缺点：`localizeByDefault` 在 `getDefaultKey` 无键时会直接回英文且不查
replacements —— 测试里强制这类键必须能解析出 `vscode/*` key。

同时注册了后端 `LocalizationContribution`（`languagePack: true`，
`nodu-localization.ts`），translations 由 `nls.getDefaultKey` 从同一张表自动
推导 vscode key；Theia 自带的 `theia-localization-contribution` 注册的
zh-cn bundled 键与之合并（`loadLocalization` 按 languageId 合并）。

## 文件

- `scope-extension/src/common/nodu-zh-cn.ts` — 唯一来源：英文默认 → 简体中文
  （约 110 条；菜单/子菜单/页签右键/编辑器右键/对话框/状态栏/快速选择占位符）。
- `scope-extension/src/browser/nodu-i18n-preload.ts` — `frontendPreload` 模块，
  `bind(TextReplacementContribution)`。
- `scope-extension/src/node/nodu-localization.ts` — `LocalizationContribution`
  （zh-cn, languagePack: true, 推导 vscode 键）。
- `scope-extension/package.json` — `theiaExtensions[].frontendPreload`。
- `browser-app/package.json` / `electron-app/package.json` —
  `frontend.config.defaultLocale: "zh-cn"`。

## 验证（`node scope-extension/test/backend-validation.cjs`，36/36）

- 新测试 `zh-cn replacement keys are real Theia/Monaco English defaults`：
  扫描编译产物中 `localizeByDefault('x')`、`localize('theia/…','x')`、
  `toLocalizedCommand/toDefaultLocalizedCommand` 的 label、monaco-editor-core
  `localize/localize2(n,"x")` 的全部英文默认值；断言表中每个键存在于该集合
  或可经 `nls.getDefaultKey` 解析；`localizeByDefault` 来源的键额外要求
  可解析（否则运行期静默回英文）；每个值含中文。

## 实测（http://127.0.0.1:4188，无头 Chromium）

- 菜单栏：`文件 | 编辑 | 选择 | 查看 | 转到 | 见微 | 终端 | 帮助`；所有一级/二级
  菜单项中文，Nodu 自有项（新建文件...、文档文件夹、最近的文件、高级、
  查找/替换、转到行...、打印...）保持不变且顺序未受影响。
- 页签右键：`关闭/关闭其他/关闭已保存/全部关闭/固定/取消固定/向上拆分/…/折叠侧面板`。
- 编辑器右键：`更改所有匹配项/撤销/重做/剪切/复制/粘贴`。
- 状态栏：`行 2，列 7`、`空格：4`（`LF`/`UTF-8`/`Python` 等技术缩写不译，
  与 VS Code 一致）；我们的 `固件版本：/串行端口：/FPS：` 不变。
- 控制台无 nls/localize 警告或错误；Monaco 正常加载。

## 仍英文（有意保留/不可译）

- 示例菜单分类 `Nodu, application, basic, board, hardware, machine_vision,
  modules, multimedia, network` —— 目录名。
- `zsh`、文件/路径名、`LF`/`UTF-8`/`Python` —— 专有名词。
- `$(bracket), [object HTMLDivElement]` —— Theia 上游损坏的 aria-label。
- “另存为”确认对话框按钮（保存/不保存/取消）已在表中并经测试，但无头
  会话里无法触发该对话框（脏编辑器关闭未弹窗），未截图验证。

## 截图

`artifacts/locale-0.1.4/`：`menubar.png`、`menu-{file,edit,selection,view,go,
nodu,terminal,help}.png`、`tab-context.png`、`editor-context.png`、`pro-window.png`、
`menu-inventory-zh.json`（全部菜单项 DOM 转储）。

## Electron

`launch.cjs electron` 启动干净（需 `env -u ELECTRON_RUN_AS_NODE`）：
backend 监听 4189，frontend `ready`，日志中 `LocalizationServerImpl.initialize`
执行，无 nls 错误；仅有无关的 disk_cache 警告。`screencapture` 本次可截屏
（3840×2160 PNG），但截的是整个显示桌面而非仅窗口，未收录。

## 其它

- 未提交；`desktop/examples/green-tracker/.theia/settings.json` 保持用户改动不动。
- 代码/测试不依赖任何英文 label。
