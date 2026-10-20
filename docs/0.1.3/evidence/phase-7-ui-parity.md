# Phase 7 证据：文件/帮助菜单与状态栏 UI 补齐（I3.1 / I4.x / I5.x / A1.1 / A4.x）

日期：2026-10-20。范围：MaixPy IDE 0.2.5 对照表里剩余的 8 个小项（文档文件夹、新建脚本模板、帮助链接、关于对话框、状态栏 FPS、固件说明链接、开发板选择持久化、示例菜单）。不改 `acceptance.csv`、`PLAN.md`、任何 `native/`/`src/node/nodu-device-server.ts`。所有新代码集中在 `nodu-file-docs.tsx`（新 contribution）+ 三处小改动；无硬件测试。

## 逐项状态

| 项 | 状态 | 实现 |
|----|------|------|
| I4.1 文档文件夹 | done（路径有意分叉） | `scope.documents-folder`，文件菜单 `2z_nodu` 组第 0 位。`EnvVariablesServer.getHomeDirUri` → `resolve('Documents/Nodu')`，不存在时 `FileService.createFolder`（递归建父目录）。Electron 经 `open(opener, uri, {openExternalApp:true})` 走 `ExternalAppOpenHandler` → `shell.openExternal(file://…)`（Finder 打开该目录）；浏览器端无法唤起系统程序，降级为 `messages.info` 提示目录已就绪并给出路径。原版目录为 `~/Documents/MaixPy`，Nodu 版按需求固定为 `~/Documents/Nodu`。 |
| I4.2 新建文件模板 | done | `scope.new-script`「新建脚本」，挂 `FILE_NEW_TEXT`（File → New 组，`order:'a2'`，不占用全局 ⌘N，可在键盘映射里自行绑定）。`UntitledResourceResolver.createUntitledResource` 打开未保存的 `Untitled-N.py`，正文与 libOpenMV.dylib @ af179e44 逐字节一致（`# Untitled - By: <USER> - <YYYY-MM-DD>` 头 + `import sensor, image, time` 相机循环），随后 `setModelLanguage('python')` 保证高亮。用户名取 `$USER`/`$USERNAME`，缺省 `user`；日期 `YYYY-MM-DD`（原版用 `QDate::currentDate().toString()` 本地化格式，按需求固定 ISO）。 |
| I5.1 帮助菜单 | done | `scope.help-docs`「MaixPy文档」→ `https://maixpy.sipeed.com/`，`scope.help-forum`「MaixPy论坛」→ `https://bbs.sipeed.com/`（original-private-params §6 的 pin 定 URL），均经 `OpenerService`；挂在 `CommonMenus.HELP` 第 0/1 位，标签与原版逐字一致。 |
| I5.2 关于 | done | `scope.about`「关于 Nodu」→ `NoduAboutDialog`（`ReactDialog` + `scope-widget`，单「关闭」按钮）。内容：产品名、`ApplicationServer.getApplicationInfo().version`（回退常量 0.1.2）、K210/Theia 一行说明、OpenMV MIT 署名行（`© 2016 OpenMV, LLC`，指向 THIRD-PARTY-NOTICES）。`onStart` 里 `unregisterMenuAction('core.about', HELP)` 移除 Theia 原生 About 槽位，避免 Help 里出现两个「关于」。 |
| A4.3 状态栏 FPS | done | `scope:fps` 右对齐元素（`priority:100`），`$(device-camera) X.X fps`，`tabular-nums`，`accessibilityInformation` 带「帧缓冲帧率」aria 标签与「可能与相机实际帧率不同」tooltip。数据源仍是 `DeviceState.fps`（后端停流/断链时清空）；`onDidChange` 的脏串已含 fps，只有数值变化才 `setElement`。无 fps → `removeElement`；simple 模式经 `nodu-simple` CSS 一并隐藏；`onDidCloseConnection` 兜底把 `fps` 置 `undefined`（旧 spread 会残留旧值）。设备状态元素里原有的内联 ` · X.X fps` 同时移除，避免两处重复。 |
| A4.1 固件说明链接 | done | `nodu-device-panel.tsx` 设备详情「固件」值渲染为 `<a href=https://github.com/sipeed/MaixPy/releases target=_blank rel="noopener noreferrer">`（原版「点击打开最新固件说明」对应 release 页）。Electron 下 Theia `setWindowOpenHandler` 把 target=_blank 转交 `shell.openExternal`；键盘可达，`device.css` 补 `textLink-foreground` 色与 `:focus-visible` 描边。URL 常量 `MAIXPY_RELEASES_URL` 自 `nodu-file-docs` 导出复用。 |
| A1.1 开发板选择持久化 | done | `NoduDeviceModel` 注入 `LocalStorageService`（**不是** `StorageService`——后者被 workspace 模块 rebind 为按工作区前缀的 `WorkspaceStorageService`，而开发板选择要求「per user 跨重启」）。键 `theia:nodu.board-id` / `theia:nodu.board-profile`；`@postConstruct` 里 `restoreSelection()` 与 `init()` 并行，读完后校验 0–8 整数与两个合法 profile 才回填并 `changed.fire()`；旧裸 `localStorage['nodu.board-id']` 做一次只读迁移（不删除，下次 persist 自然覆盖到新键）。`selectBoardId`/`selectProfile`/`onState` 回填设备返回值时 `persistSelection()` 双键齐写。 |
| I3.1 示例菜单 | partial | `onStart` 枚举 `getApplicationRoot().parent/examples`（即 `desktop/examples`：app 目录为 `desktop/electron-app`，与 launcher 默认工作区 `examples/green-tracker` 同源）。递归只收 `.py`，跳过 `.*`/`__pycache__`，目录深度 ≤2、总数 ≤48；目录建成嵌套子菜单（排序后先父后子），文件按名称序挂「示例」子菜单。每项生成 `scope.example.N` 命令，经 `readFile` 读入后以 **untitled 新文档** 打开（原版「打开为新文件」语义），不污染源文件。`scope.more-examples`「更多示例」→ `https://github.com/sipeed/MaixPy_scripts`（原版托管仓库 URL）。partial 原因：本仓库 `desktop/examples` 只有 4 个目录 7 个 `.py`（board-api/gc2145-camera/green-tracker），并非原版完整 MaixPy-v1_scripts 分类目录；若示例目录不存在/为空，子菜单被 dispose 不残留空项。 |

## 改动文件

- `scope-extension/src/browser/nodu-file-docs.tsx`（新，209 行）：`NoduFileDocsContribution`（CommandContribution + MenuContribution + FrontendApplicationContribution）+ `NoduAboutDialog` + `MAIXPY_RELEASES_URL` 导出。
- `scope-extension/src/browser/scope-frontend-module.ts`：绑定 `NoduFileDocsContribution` 到三个 contribution 符号。
- `scope-extension/src/browser/scope-workbench.tsx`：`updateStatus()` 拆分出 `scope:fps` 右对齐元素；设备元素去掉内联 fps；simple 分支维持移除 `scope:device`/`scope:demo`。
- `scope-extension/style/layout.css`：`.nodu-statusbar-fps` tabular-nums；simple 隐藏列表加入 `scope:fps`。
- `scope-extension/src/browser/nodu-device-panel.tsx`：固件值 → 链接（上表 A4.1）。
- `scope-extension/style/device.css`：`.nodu-firmware-link` 颜色/下划线偏移/focus-visible 描边。
- `scope-extension/src/browser/nodu-device-client.ts`：`LocalStorageService` 注入 + `restoreSelection`/`persistSelection`；断链状态清理加 `fps: undefined`。

未改动：`examples/green-tracker/.theia/settings.json`（diff 中的 `light` 主题是用户侧既有改动，保持原样）、`acceptance.csv`、`PLAN.md`、native、`nodu-device-server.ts`。

## 验证

- `npm run compile`（desktop，含 `build:imaging` cargo+wasm 暂存）：0 errors。
- `node --test test/backend-validation.cjs test/board-info.cjs`：32/32 通过（含 mock board e2e 17.9s）。
- `node --test test/image-analysis.cjs`：12/12 通过。
- `impeccable detect --json`（6 个改动文件）：输出 `[]`。
- API 级核对（node_modules 1.76 源）：`createUntitledResource(content, extension, uri)` 签名、`{openExternalApp:true}` 为 `ExternalAppOpenHandler` 选项（canHandle 优先级高于 HttpOpenHandler，Electron 经 `CHANNEL_OPEN_WITH_SYSTEM_APP → shell.openExternal`）、`registerSubmenu` 对既有 Group 转 Submenu 保留子项、状态栏 DOM id 为 `status-bar-<id>`（CSS 选择器匹配确认）、`CommonCommands.ABOUT_COMMAND.id === 'core.about'`、`getApplicationRoot() === applicationPackage.projectPath`（launcher cwd = app 目录 → `.parent/examples` 命中 `desktop/examples`）、`LocalStorageService` 前缀 `theia:`（Electron）为全局键。

## 已知限制 / 未验证项

1. 未做真机/实例 UI 点击验证（4195 实例未动）：菜单渲染层级、Electron 原生菜单转换、untitled 编辑器语言着色、Finder 弹出为静态检查与 Theia API 推断，非端到端。
2. 浏览器模式下「文档文件夹」只提示路径，无法唤起系统文件管理器（无对应 API），符合降级设计。
3. 示例打开为 untitled 副本而非原版「在源文件位置直接打开」——选择不修改打包源文件的语义；原版行为本身是打开后另存，等价。
4. `scope.new-script` 无默认快捷键（原版 ⌘N 按需求避让）；命令面板可搜「新建脚本」，可经 Theia 键盘映射绑定。
5. 打包包发场景下 `desktop/examples` 相对 app 目录的相对路径依赖 launcher 布局（`theia start` cwd=app 目录）；若有打包需求需另行 extraResources 拷贝。
