# 阶段 4 证据 — 专业模式布局逐项验收（U1.1）

参考：`docs/0.1.3/evidence/maixpy-ide-0.2.5-main-window.txt`（原版主窗口 AX）、
原版源码 `openmv-qt-creator/src/plugins/openmv/`（af179e4，仅作行为参考）、
`docs/0.1.4/PLAN.md` 阶段 4。

验证环境：浏览器端 `127.0.0.1:4188`（headless Chromium + puppeteer），
专业模式当时通过工具栏“专”切换（现经 ⋯ 或“查看”菜单）。截图在 `artifacts/layout-0.1.4/`。

## 逐项结果

### 1. 工具栏 — 有意保留现代 IDE 形态

| 原版动作 | Nodu 等价 | 键 | 状态 |
| --- | --- | --- | --- |
| 新建文件 ⌘N | `scope.new-script`（File→New 首项） | `ctrlcmd+n` | 可达 |
| 打开文件 ⌘O | Theia `Open...` | ⌘O | 可达 |
| 保存 ⌘S | `core.save` | ⌘S | 可达 |
| 撤销/重做/剪切/复制/粘贴 | `core.undo`/`redo`/`cut`/`copy`/`paste`，编辑菜单中文标签 | ⌘Z ⇧⌘Z ⌘X ⌘C ⌘V | 可达 |
| 连接 | `scope.toggle-connect` + 工具栏设备 chip | ⌘E（`!terminalFocus`） | 可达 |
| 开始(运行脚本) ⌘R | `scope.toggle-run`（运行/停止切换）+ `scope.run-current` 工具栏按钮 | ⌘R（`!terminalFocus`）、⌘↵（编辑器内） | 可达 |

工具栏本身（写作时为 文件/运行/停止/设备/控制台/视觉/主题/简专；2026-10-21 起已重构，见 [ui-layout-20261021.md](ui-layout-20261021.md)）为刻意保留的现代
形态，不再逐项模仿原版图标排布。

### 2. 帧缓冲区 — 已修正

`scope-widgets.tsx` `renderDevicePreview` + `nodu-image-tools.tsx` 工具行：

| 原版 | Nodu | 处理 |
| --- | --- | --- |
| 录制（tooltip 录制帧缓冲区） | 录制图标按钮 | tooltip 改为 `录制帧缓冲区`（原 tooltip 含 .bin 上限说明） |
| 缩放 复选框（tooltip 缩放到合适大小） | 缩放下拉（适配/100%/200%） | aria-label→`缩放`，title→`缩放到合适大小`；控件形态为下拉（能力超集），记为已接受差异 |
| 禁用 复选框（tooltip 禁用帧缓冲区以获得最佳性能） | 原“冻结/继续”按钮（`setPreview` 停流/恢复，语义同原版禁用） | 标签改为 `禁用`/`启用`，tooltip `禁用帧缓冲区以获得最佳性能` |

### 3. 直方图 — 已修正（`nodu-image-tools.tsx`）

- 色彩空间下拉四项逐字对齐：`RGB色彩空间` / `灰度色彩空间` /
  `LAB色彩空间` / `YUV色彩空间`，tooltip `使用灰度/LAB进行颜色跟踪`
  （原为 RGB/灰度 Y/LAB/YUV）。
- 统计列按原版 `.ui` 网格列序（openmvpluginhistogram.ui：上行
  Mean/Median/Mode/StDev，下行 Min/Max/LQ/UQ）：`平均数 中位数 众数 StDev
  最小 最大 LQ UQ`（原为 均值/标准差 且顺序不同）。
- 分辨率行（`histogramResolutionText`，`src/common/nodu-status.ts`，对
  openmvplugin.cpp:1596-1618 逐分支对齐）：无图 `Res - 没有图像`；
  有图 `Res (w:W, h:H)`；ROI>1px² 追加 `- ROI (x,y,w,h) - Pixels (N)`；
  退化 ROI 为 `- Point (x,y)`；0 尺寸 ROI 按 Qt `isValid()==false` 回落
  普通行。单元测试覆盖全部分支。

### 4. 编辑器 — 有意保留现代 IDE 形态

- Theia 标签页取代原版“文档”下拉 — 差异已接受。
- Theia Ln/Col 状态项取代 `Line: x, Col: y` — 差异已接受。
- ⌘W 关闭文档：Theia `core.close` 已绑 `ctrlcmd+w`（Electron）/
  `alt+w`（浏览器端），无需新绑 — 已核对。

### 5. 底部面板 — 已对齐（形态差异已接受）

- 搜索结果 → Theia `Search` 视图（左侧标签 + `打开高级查找...` ⇧⌘F），
  实测标签存在且可打开。
- 串行终端 → 专业模式：工具栏“控制台”开关（现名“串行终端”）打开底部 Output 视图
  `Nodu · 设备` 通道（实测点开出现 Output 标签）；REPL 输入经设备弹层
  `nodu-repl-code`。简洁模式用 `NoduConsoleWidget`（含输入框）。
  原版底部复选框式面板开关 → Nodu 面板切换命令，差异已接受。

### 6. 状态栏 — 已实现（`scope-workbench.tsx` `updateStatus`）

右对齐三个原版项，断开时保留标签与空值（DOM 实测：`固件版本：`、
`串行端口：`、`FPS：` 均在，order 固件版本→串行端口→FPS 同原版）：

- `固件版本：<ver>`，点击 → `scope.firmware-releases` 打开
  `MAIXPY_RELEASES_URL`（复用 nodu-file-docs 常量），tooltip
  `点击查看最新的固件版本及说明`。
- `串行端口：<port>`，tooltip `开发板串口`。
- `FPS：<n>`（原 `$(icon) x fps` 改为原版格式），tooltip
  `可能与摄像头帧率(FPS)不同`。
- 简洁模式：沿用既有约定 —— `scope:device`/`scope:demo` 隐藏，新增
  固件/串口两项同样隐藏，`FPS` 保持显示（与改动前一致）。
- 现代 `scope:device` 状态 chip（左侧，点击管理设备）保留。

tooltip 走 Theia HoverService（悬停浮层而非 `title` 属性），元素带
`hasCommand`/`aria-label` 已实测。

## B. 小修正

1. `editor.renderWhitespace: "none"` 已加入 electron-app 与
   browser-app 的 `theia.frontend.config.preferences` —
   使空格可见默认不勾选，与原版一致。
2. 中文界面：试了 `theia.frontend.config.defaultLocale: "zh-cn"`（
   1.76 支持该键），重建后实测菜单仍英文，已**还原**。原因（已核对
   源码）：`i18n-preload-contribution` 只在 `localization.languagePack`
   为真时才装载翻译；`@theia/core/i18n/nls.zh-cn.json` 经
   `registerLocalizationFromRequire` 注册时不带该标志且只含 26 个
   Theia 自有键（无 `vs/` 键域），locale 被重置为默认 → 无效果。
   界面翻译需要 VS Code 语言包（`@theia/plugin-ext` + .vsix），按要求
   未引入。仍为英文的部分：顶层菜单根（File/Edit/Selection/View/Go/
   Terminal/Help）与 Theia 原生项（New Text File、Open...、Save、
   Preferences、Copy Path、Replace in Files 等）；Nodu 自有项全部为
   中文（截图见 artifacts）。

## 验证

- `npx tsc -p scope-extension --noEmit`：0 错；`npm run compile`：通过。
- browser-app + electron-app `npm run build`：`Finished with 0 errors`。
- `node scope-extension/test/backend-validation.cjs`：**35/35**
  （新增 `status-bar and Res strings match the original labels`）。
- `node scripts/check-licenses.cjs`：395 文件干净；`git diff --check` 干净。
- 实测（4188，专业模式）：状态栏三项、File/Edit 菜单项、底部 Output
  打开、Search/视觉调试 标签存在；截图 `pro-window.png`、`file-menu.png`、
  `edit-menu.png`、`status-bar.png`、`vision-panel.png`、`pro-console-open.png`。

未验证：连接真机时的录制/禁用/缩放交互与状态栏数值、直方图在有帧时的
`Res (w,h) - ROI...` 文本（纯函数已测，渲染路径未截图 —— 需设备帧或注入
假帧）、Electron 原生端新项（代码与浏览器端共用，Electron 构建通过；
点击行为待人工验收）。N1.6 并排截图属阶段 5。
