# 阶段 3 证据 — 文件 / 编辑菜单逐项补齐（I1.1、I1.2）

参考：`docs/0.1.3/evidence/maixpy-ide-0.2.5-menus.txt`（MaixPy IDE 0.2.5 原版菜单）、
`docs/0.1.4/PLAN.md` 阶段 3 表格与 §3 有意偏离。

实现位置：

- `desktop/scope-extension/src/browser/nodu-editor-menus.tsx`（新贡献，在
  `scope-frontend-module.ts` 中绑定 `CommandContribution`/`MenuContribution`/
  `KeybindingContribution`/`FrontendApplicationContribution`）
- `desktop/scope-extension/src/browser/nodu-file-docs.tsx`（文档文件夹、最近的文件、
  新建文件排序、打印归属组的旁挂实现）
- `desktop/scope-extension/src/common/nodu-editor-menu.ts`（纯逻辑 + 静态表：
  剪贴板环形、最近文件、打印 HTML、字号钳制、`ADVANCED_MENU`/`FIND_REPLACE_MENU`）
- 测试：`desktop/scope-extension/test/backend-validation.cjs`（34 例全过）

## 逐项映射

### 文件

| 原版项 | 原版键 | Nodu 命令 / 位置 | 键 | 状态 |
| --- | --- | --- | --- | --- |
| 新建文件... | ⌘N | `scope.new-script`（File→New 组首项，order `0`） | `ctrlcmd+n` | 已实现 |
| 打开文件... | ⌘O | Theia `Open...` | ⌘O | 已有 |
| 文档文件夹 | — | 子菜单：递归列出 `~/Documents/Nodu` 的 `.py`（`buildExampleTree`），点击打开真实文件；空目录显示禁用项 `将一些代码添加到“<绝对路径>”`；末项 `在访达中打开`（非 macOS 显示 `在文件管理器中打开`）= `scope.documents-folder` | — | 已实现；`FileService.watch`+`onDidFilesChange` 时重建 |
| 示例 | — | 子菜单（阶段 2） | — | 已有 |
| 更多示例 | — | `scope.more-examples` | — | 已有 |
| 最近的文件 | — | 子菜单 `scope.recent-file.<n>`（最近 10 个 `file://` 编辑器，全局 `LocalStorageService` 键 `nodu.recent-files`，最新在前，去重）+ 分隔 + `scope.recent-files.clear`（`清除菜单`）；文件不存在时提示 `文件不存在：<path>` 并移除 | — | 已实现 |
| 保存 / 另存为 / 关闭 | ⌘S / ⇧⌘S / ⌘W | Theia `core.save` / `core.saveAs` / `core.close` | 同原版 | 已有 |
| 打印... | ⌘P | `scope.print`，File 菜单末尾；隐藏 iframe + 等宽 10pt `<pre>`，标题=文件名，打印后移除；无文本编辑器时禁用 | 无 | 已实现（⌘P 偏离见 §3） |

### 编辑

| 原版项 | 原版键 | Nodu 命令 | 键（when） | 状态 |
| --- | --- | --- | --- | --- |
| 撤销 / 重做 | ⌘Z / ⇧⌘Z | `core.undo` / `core.redo`（已重挂中文标签） | 同原版 | 已有 |
| 剪切 / 复制 / 粘贴 | ⌘X/C/V | `core.cut` / `core.copy` / `core.paste`（中文标签） | 同原版 | 已有 |
| 从剪贴板历史记录粘贴 | ⇧⌘V | `scope.clipboard-history-paste` | `ctrlcmd+shift+v`（`editorTextFocus`） | 已实现：窗口内 10 条去重环形，空选复制取整行+换行，QuickPick 首行≤80 字+行数，`executeEdits` 覆盖全部选区，空环形提示 `剪贴板历史记录为空` |
| 全选 | ⌘A | `core.selectAll`（中文标签） | 同原版 | 已有 |
| 高级→使空格可见 | ⌃E,⌃V | `editor.action.toggleRenderWhitespace` | 无（偏离：Theia 无组合键序列；原版为组合键） | 已实现 |
| 高级→清除空格 | — | `editor.action.trimTrailingWhitespace` | — | 已实现 |
| 高级→启用文本环绕 | ⌃E,⌃W | `editor.action.toggleWordWrap` | 无（同上偏离） | 已实现 |
| 高级→切换注释选择 | ⌘/ | `editor.action.commentLine` | `ctrlcmd+/`（`editorTextFocus`） | 已实现 |
| 高级→剪切行 | ⇧Del | `scope.edit.cut-line`（整行含换行，写入剪贴板+环形） | `shift+delete`（`editorTextFocus`） | 已实现 |
| 高级→复制行 | — | `scope.edit.copy-line` | — | 已实现 |
| 高级→大写选择 | ⌃⇧U | `editor.action.transformToUppercase` | `ctrl+shift+u`（`editorTextFocus`） | 已实现 |
| 高级→小写选择 | ⌃U | `editor.action.transformToLowercase` | `ctrl+u`（`editorTextFocus`） | 已实现 |
| 高级→折叠 / 展开 | ⌘< / ⌘> | `editor.fold` / `editor.unfold` | `ctrlcmd+shift+,` / `ctrlcmd+shift+.`（`editorTextFocus`） | 已实现（Theia 原有折叠键保留） |
| 高级→切换折叠全部 | — | `scope.edit.toggle-fold-all`（任一区域未折叠→全折叠，否则全展开） | — | 已实现 |
| 高级→增加字体大小 | ⌘+ | `scope.edit.increase-font` | `ctrlcmd+=`（`editorTextFocus && !findWidgetVisible`） | 已实现；`editor.fontSize` ±1，钳制 [6,72] |
| 高级→减小字体大小 | ⌘- | `scope.edit.decrease-font` | `ctrlcmd+-`（`editorTextFocus`） | 已实现 |
| 高级→重置字体大小 | ⌃0 | `scope.edit.reset-font` | `ctrl+0`（`editorTextFocus`） | 已实现；重置为 13 |
| 查找/替换→查找/替换 | ⌘F | `actions.find` | `ctrlcmd+f` | 已有 |
| 查找/替换→高级查找→打开高级查找... | ⇧⌘F | `search-in-workspace.open`（平铺在 `查找/替换` 子菜单内） | `ctrlcmd+shift+f` | 已实现（原版的二级嵌套拍平，见偏离） |
| 查找下一个 / 上一个 | ⌘G / ⇧⌘G | `editor.action.nextMatchFindAction` / `previousMatchFindAction` | `ctrlcmd+g` / `ctrlcmd+shift+g`（`editorTextFocus`） | 已实现 |
| 替换并查找 | ⌘= | `editor.action.replaceOne` | `ctrlcmd+=`（`findWidgetVisible`） | 已实现（与增加字体大小按 when 互斥） |
| 全部替换 | — | `editor.action.replaceAll` | — | 已实现 |
| 转到行... | ⌘L | `editor.action.gotoLine` | `ctrlcmd+l`（`editorTextFocus`；Theia 原有 `ctrl+g` 保留） | 已实现 |

### 原版项中未实现（均记录在案）

- 高级查找下级的 当前文件 / 打开文档 / 文件系统中的文件：原版即禁用占位，
  Nodu 无对应后端动作。
- 区分大小写 / 仅整个词 / 正则 / 替换时保留大小写：原版即禁用；Nodu 使用
  Monaco 查找控件自带开关。
- 输入查找字符串 ⌘E：§3 有意偏离（⌘E 保留为连接）。
- 查找下一个(所选) / 查找上一个(所选)、替换、替换并查找上一个：原版均禁用，
  Monaco 对应动作存在但未列菜单（未在阶段 3 表内）。
- 自动填充 / 开始听写：macOS 系统注入项，非应用功能。

## 快捷键冲突处理

`registerKeybindings` 先 `unregisterKeybinding` 再重绑：

| 键 | 原占用 | 处理 |
| --- | --- | --- |
| `ctrlcmd+n` | Theia `core.newUntitledTextFile`（仅 Electron；浏览器端原为 `alt+n`） | 注销后绑 `scope.new-script`（阶段 3 要求取代 Theia 空白新文件） |
| `ctrlcmd+l` | Monaco `expandLineSelection` 默认键 | 注销后绑 `editor.action.gotoLine`（仅 `editorTextFocus`） |
| `shift+delete` | 无 Theia 注册占用（Windows 平台惯例为剪切） | 预防性注销后绑 `scope.edit.cut-line`（仅 `editorTextFocus`，不影响窗口级） |
| `ctrl+u` | Monaco `cursorUndo` 默认键（仅编辑器内生效） | 注销后绑 `transformToLowercase`（同样仅 `editorTextFocus`，覆盖范围一致） |

有意共享：`ctrlcmd+=` 同时绑 `scope.edit.increase-font`
（`editorTextFocus && !findWidgetVisible`）与 `editor.action.replaceOne`
（`findWidgetVisible`）— 两个 `when` 互斥，与原版一致（原版 ⌘= 同样身兼两职）。
Theia 未为窗口缩放注册 `ctrlcmd+=`/`-`/`0`，编辑器外按键不受影响。

菜单项移动而非复制：Theia 既有的 撤销/重做/剪切/复制/粘贴 通过
`unregisterMenuAction` + 重注册改为中文标签；FIND/REPLACE/SIW 从 Edit 顶层
摘除并入 `查找/替换` 子菜单。

## Electron 原生菜单栏刷新

`ElectronMainMenuFactory.postConstruct` 订阅
`menuProvider.onDidChange`（`MenuModelRegistry` 在每次 register/unregister/
dispose 时触发）→ 防抖 `setMenuBar()` → `electronTheiaCore.setMenu`。
文档文件夹 watch 回调与最近文件更新通过先 dispose 再注册的子菜单重建，会经
同一路径刷新原生菜单栏 —— 无需额外机制（代码路径已核对；原生菜单外观待人工
点验，见下）。

## §3 偏离落实

- ⌘P 仍为 Quick Open；`scope.print` 只挂菜单。
- ⌘E 仍为连接；`输入查找字符串` 未实现。
- 顶层菜单保留 Theia 的 `File`/`Edit` 英文名（阶段 3 “保留 Theia 已有项”，
  只补齐表内项；原版根名 文件/编辑 记为已接受差异）。

## 验证

- `npx tsc -p scope-extension --noEmit`：0 错。
- `npm run compile`：通过。
- `npm run build --workspace @scope/browser-app` / `@scope/electron-app`：
  `[build/*] Finished with 0 errors`。
- `node scope-extension/test/backend-validation.cjs`：**34/34**（新增 5 例：
  剪贴板环形、最近文件、打印 HTML 转义、字号钳制、原标签/键位静态表）。
- `node scripts/check-licenses.cjs`：394 文件干净。
- `git diff --check`：干净。
- Electron（Node 24，`ELECTRON_RUN_AS_NODE` 已清）启动日志无错误，
  监听 `127.0.0.1:4189`（仅有无害的 Chromium disk-cache 警告）；已关闭。
- 浏览器端（`:4188`，headless Chromium + puppeteer 实测菜单 DOM）：
  File/Edit 菜单与 文档文件夹、最近的文件、示例、高级、查找/替换 子菜单
  全部按上表渲染，`新建文件...` 位于 File→New 组首项；
  截图在 `artifacts/menus-0.1.4/*.png`。
- 实测可见：空文档目录显示禁用提示项 + `在访达中打开`；空最近列表显示
  `清除菜单`；示例含 Nodu + 8 个 MaixPy 分类；无编辑器时 打印/粘贴历史/
  行操作/折叠/转到行 正确禁用。

未验证（待人工或后续会话）：Electron 原生菜单栏的实际渲染（截图工具无屏录
权限，以 DOM 版代验，刷新路径为代码级核对）、剪贴板环形/打印/字体键在真实
编辑器中的交互、折叠切换的实际行为。
