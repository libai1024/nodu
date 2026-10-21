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

---

# 阶段 3 续 — 工具 / 窗口 / 帮助 菜单逐项补齐（I1.3）

参考：`docs/0.1.3/evidence/maixpy-ide-0.2.5-menus.txt` `# 工具` / `# 窗口` /
`# 帮助` 节。顶层菜单 `见微` 更名为 `工具`，菜单路径仍为
`[..., MAIN_MENU_BAR, '5_scope']`，既有贡献不受影响。

实现位置：

- `desktop/scope-extension/src/common/nodu-tools-menu.ts`（纯表：
  `BOARD_MENU`、`APRILTAG_MENU`、`ORIGINAL_TOOLS_MENU`、`ORIGINAL_WINDOW_MENU`、
  `ORIGINAL_HELP_MENU`、`TOOLS_MENU_GROUPS`，由 backend-validation.cjs 与
  证据文件逐字比对）
- `scope-workbench.tsx`（顶层 `工具` 菜单、`选择开发板` 九命令、Electron `窗口`
  菜单与 ⌘M 键位、Nodu 末组与 `示例` 子菜单）
- `nodu-file-tools.tsx` / `nodu-terminal-tools.tsx` / `nodu-vision-tools.tsx` /
  `nodu-media-tools.tsx`（各子菜单分组与顺序）
- `nodu-apriltag-generator.tsx`（`NoduAprilTagDialog` 增加初始 family 参数）

## 逐项映射（工具）

| 原版项 | Nodu 命令 / 位置 | 状态 |
| --- | --- | --- |
| 选择开发板 ▸ 9 块板 | `scope.select-board.<0-8>`，`isToggled` 绑定 `NoduDeviceModel.boardId`；连接/忙时禁用（与面板一致） | 已实现，DOM 实测 9 项原文标签、`Sipeed Maix Dock` 默认勾选 |
| 将打开的脚本保存到开发板的 boot.py | `scope.save-boot-script`（`c→b_file-actions` 组） | 已实现（未连接时禁用，与原版一致） |
| 发送文件到开发板 | `scope.send-file` | 同上 |
| 打开终端 ▸ 新终端 | `terminal` 子菜单（`TOOLS_MENU_GROUPS.terminalSubmenu`） | 已实现 |
| 机器视觉 ▸ 阈值编辑器 / 关键点编辑器 | `scope.threshold-editor` / `scope.keypoints-editor` | 已实现 |
| AprilTag生成器 ▸ 六家族 | `scope.apriltag.<family>`，各打开对话框并预选 family | 已实现，标签含原版 `ARKTOOLKIT` 拼写 |
| 二维码 / DataMatrix码 / 条码生成器 | `scope.qr-generator` / `scope.datamatrix-generator` / `scope.barcode-generator` | 已实现 |
| CNN网络库 | `scope.network-library` | 已实现 |
| 视频工具 ▸ 转换视频文件 / 播放视频文件 | `scope.convert-video` / `scope.play-video`（子菜单前两项） | 已实现 |
| （Nodu 附加）开始录制… / 结束录制 / 取消视频任务 | `scope.start-recording` / `scope.stop-recording` / `scope.cancel-media`，分隔线后 | Nodu 附加项 |
| （Nodu 附加）运行/停止/复位/显示帧缓冲/设备与连接/板卡指南/设备日志/主题/简洁模式/专业模式/示例（2026-10-21 更名：原“视觉调试”“简专模式”） | `d_nodu` 末组 + `示例` 子菜单（仅专业模式可见） | Nodu 附加项，DOM 实测 |

板卡 id↔标签证据：`BOARD_MENU` 顺序为原版显示顺序，id 为原版复位序列索引
（`docs/0.1.3/evidence/original-private-params.md` §2 + `nodu-device/src/reset.rs`
0xF9/0x06 掩码序列），测试断言 id 为 0–8 置换。

## 窗口（仅 Electron）

原版 `最小化 ⌘M` / `缩放` / `进入全屏 ⌃⌘F`：Theia 1.76 无顶层 Window 菜单，
已有 `window.electronTheiaCore.{minimize,maximize,unMaximize,isMaximized,
toggleFullScreen}` API 与 `workbench.action.toggleFullScreen`（⌃⌘F，仅
Electron 注册，菜单在 查看→外观）。

- `scope.window-minimize` → `electronTheiaCore.minimize()`，⌘M，Electron-only
- `scope.window-zoom` → `isMaximized() ? unMaximize() : maximize()`
- `进入全屏` → 复用 `workbench.action.toggleFullScreen`（查看菜单中的同一项保留）

顶层 `窗口` 菜单路径 `[..., MAIN_MENU_BAR, '8_window']`（排序落在
`7_terminal` 与 `9_help` 之间）；`environment.electron.is()` 为假时
（浏览器端）整条不注册 —— 浏览器 DOM 实测无 `窗口` 项。
未发明自定义 IPC。

## 帮助

原版 `MaixPy文档` / `MaixPy论坛` 为前两项（order `0`/`1`），Nodu `关于 Nodu`
为 order `9`，Theia 原生 About 已注销。浏览器 DOM 实测顺序与全中文标签正确。

## 验证（本续节）

- `npx tsc -p scope-extension --noEmit`：0 错；`npm run compile`：通过；
  browser-app / electron-app 构建 0 errors。
- `node scope-extension/test/backend-validation.cjs`：**39/39**（新增：
  工具/窗口/帮助表逐字比对、板 id 置换、AprilTag family/count 对拍）。
- `node scripts/check-licenses.cjs`：399 文件干净；`git diff --check`：干净。
- 浏览器端（`:4188`，headless Chromium + puppeteer）：菜单栏为
  `文件|编辑|选择|查看|转到|工具|终端|帮助`（无 `窗口`）；工具菜单三层级、
  分隔线、AprilTag 级联、板勾选状态、简单/专业模式下 `示例` 子菜单显隐均实测；
  帮助菜单实测 `MaixPy文档|MaixPy论坛|关于 Nodu`。
  截图：`artifacts/menus-0.1.4/tools-*.png`、`help-menu.png`。

未验证：Electron 原生 `窗口` 菜单的实机渲染与 ⌘M/缩放/全屏交互（命令与键位已按
Electron-only 注册，浏览器端已证不泄漏）；各生成器/编辑器对话框在实机上的
打开效果（命令已注册并出现在 DOM）。
