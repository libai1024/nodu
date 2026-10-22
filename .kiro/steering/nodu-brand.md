---
inclusion: always
---

# Nodu 前端品牌约束（品牌 v2 · 2026-10-21）

改动任何界面、样式、图标、品牌页或对外文案前遵守本文件。完整规则在 `brand/README.md`，设计入口在 `DESIGN.md`。

## 单一来源

- 颜色只在 `brand/src/tokens.cjs` 定义，标志与字标几何只在 `brand/src/geometry.cjs` 定义。
- 改完运行 `node brand/scripts/build.cjs`。它会重新生成 `brand/assets/*.svg`、`brand/tokens.{css,json,js}` 和 `desktop/scope-extension/src/browser/nodu-brand.ts`，并在对比度不达标时失败。标志或图标变化后，还要运行 `desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron brand/scripts/rasterize.cjs`。
- 生成的文件不要手改，把来源和生成物一起提交。
- 提交前运行 `cd desktop && npm run check:brand` 和 `node --test scope-extension/test/brand-theme.cjs`（需要先编译）。CI 的 `brand-check.yml` 在每次 push 和 PR 时运行同一个 `check-brand.cjs`；`brand-theme` 测试依赖编译产物，只在本地运行。

## 代码规则

- `desktop/scope-extension/src` 和 `style` 里不写品牌色值，也不写 v1 旧色（`#4F7CFF`、`#8EACFF`、`#244BB0`、`#64C5AC`、`#181D20` 等）。
- TS 里需要颜色时引用 `NODU_COLORS` / `NODU_LOGO`（来自 `./nodu-brand`）。
- CSS 里用 Theia 变量，例如 `--theia-button-background`、`--theia-focusBorder`、`--theia-errorForeground`，以及品牌扩展的 `--theia-scope-accent`、`accentBackground`、`mutedForeground`、`canvasBackground`、`idle`、`busy`、`ok`、`warn`、`signal`。
- 不借用含义无关的颜色 ID：已连接用 `--theia-scope-ok`，不用 `terminal.ansiBrightGreen`；连接中用 `--theia-scope-busy`，不用 `editorWarning`。
- 主题颜色映射集中在 `nodu-theme-colors.ts`，深浅两套主题必须定义相同的颜色 ID。主题 ID `scope-dark` / `scope-light` 和 `scope.*` 颜色 ID 保持兼容，不改名。
- 代码语法色、终端 ANSI、RGB 直方图通道色和样例画面颜色保持各自的含义，不随品牌色替换。

## 颜色语义（每个颜色只说一件事）

- Nodu 蓝 `#2F5BFF`：只表示“可以操作”，用于主按钮、焦点、选中、进度和活动标记。按钮一律白字，两套主题共用。
- 点亮黄 `#FFC23D`：只用于标志灯罩和学习里程碑，并且只放在芯片墨 `#14171C` 上。不做按钮，不表示警告，不放在浅色背景上。
- 琥珀只表示风险，例如写入 Flash 勿断电。绿色只表示成功或已连接，红色只表示错误或停止。
- “连接中 / 进行中”用主色族加脉冲，不用琥珀。“镜像校验通过”还没有写入，用主色不用绿色。
- 状态必须同时有文字或图标，不能只靠颜色区分。
- 对比度：文字 ≥ 4.5:1，图标、边框、焦点环和大字 ≥ 3:1。新增的颜色组合要加进 `tokens.cjs` 的 `checks()`。

## 标志规则

- 灯罩永远是点亮黄，并且在芯片墨上。横向组合必须带板体。
- 深色工具栏用不带板体的小灯，浅色工具栏用小板体，见 `scope-brand.tsx`。
- 16–32 px 用小尺寸母版（`mark-small.svg` / `app-icon-small.svg`）。
- 不改色（尤其不能用绿色灯罩），不加发光、阴影、渐变或描边，不拉伸，不旋转，不手绘近似版。
- 应用图标只来自 `brand/assets/Nodu.icns` / `Nodu.ico`。Electron 窗口底色必须等于深色编辑区色 `#14171C`。

## 文案

- 品牌写作 Nodu · 见微，字标固定小写 nodu。主张是“从第一行代码，到第一次点亮。”
- 产品定位是面向 STM32、K210、ESP32 等主流 MCU 的嵌入式入门学习 IDE。
- 目前只有 K210（野火 CAM · GC2145）完成真板验证，STM32 / ESP32 写作“规划中”。不要写“已支持”或“100% 支持”。
