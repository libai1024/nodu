---
name: "Nodu · 见微"
description: "面向 STM32、K210、ESP32 等主流 MCU 的嵌入式入门学习 IDE：点亮标志、电路板配色、芯片墨与丝印白工作台。"
version: "brand v2 · 2026-10-21"
source: "brand/src/tokens.cjs（色值）· brand/src/geometry.cjs（标志）· brand/README.md（规则）"
colors:
  nodu-blue: "#2F5BFF"
  blink-yellow: "#FFC23D"
  chip-ink: "#14171C"
  silk-white: "#F6F5F0"
  on-primary: "#FFFFFF"
  dark-editor: "#14171C"
  dark-panel: "#181B21"
  dark-surface: "#1D2027"
  dark-raised: "#23272F"
  dark-border: "#343A45"
  dark-text: "#E7EAEF"
  dark-muted: "#949CAA"
  dark-accent: "#8FA8FF"
  dark-primary-hover: "#3F68FF"
  light-editor: "#F6F5F0"
  light-panel: "#EFEDE6"
  light-surface: "#E7E4DB"
  light-border: "#D8D4C8"
  light-text: "#1D2129"
  light-muted: "#5B616C"
  light-accent: "#2449DB"
  light-primary-hover: "#2449DB"
  status-busy: "#5F82FF"
  status-ok: "#45C486"
  status-warn: "#F0A43A"
  status-error: "#F2706A"
typography:
  body:
    fontFamily: "-apple-system, 'PingFang SC', 'Microsoft YaHei', 'Source Han Sans SC', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  workbench:
    fontFamily: "'Scope Plex', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "var(--theia-ui-font-size1, 13px)"
  code:
    fontFamily: "'Scope Plex Mono', 'SF Mono', Menlo, Consolas, monospace"
    fontSize: "13px"
rounded:
  widget-control: "3px"
  toolbar-control: "4px"
  brand-button: "5px"
spacing:
  space-4: "4px"
  space-8: "8px"
  space-12: "12px"
  space-16: "16px"
  space-20: "20px"
components:
  button-primary:
    backgroundColor: "{colors.nodu-blue}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.toolbar-control}"
    padding: "3px 10px"
  button-primary-hover:
    backgroundColor: "{colors.dark-primary-hover}"
  status-dot-connecting:
    backgroundColor: "{colors.status-busy}"
  status-dot-connected:
    backgroundColor: "{colors.status-ok}"
  milestone:
    backgroundColor: "{colors.chip-ink}"
    accentColor: "{colors.blink-yellow}"
---

# Design System: Nodu · 见微（品牌 v2）

本文件是设计系统入口。色值与标志几何的唯一来源是 [brand/src](brand/src/)，完整规则见 [brand/README.md](brand/README.md)，规范页见 [brand/index.html](brand/index.html)（`python3 -m http.server 4190 --bind 127.0.0.1` 后打开 `/brand/`）。上方 frontmatter 是摘要，与来源冲突时以 `brand/src/tokens.cjs` 为准。桌面布局与交互见 [0.1.4 交接](docs/0.1.4/HANDOFF.md)。

`.impeccable/design.json` 与 `docs/0.1.1/DESIGN.md` 记录的是 v1 蓝色方案（2026-10-19），重新生成之前不作为当前规范。

## Creative North Star

**从第一行代码，到第一次点亮。** 标志是一颗被点亮的 LED：点亮黄灯罩、长短不同的两条引脚（长脚为正）、芯片墨板体。品牌只表达入门与第一次成功，不绑定芯片厂商。

## Colors

- **Nodu 蓝 `#2F5BFF`**：主要动作、焦点、选中、进度、活动标记。白字 5.2:1，深浅主题共用同一个主按钮。
- **点亮黄 `#FFC23D`**：标志灯罩与学习里程碑，只放在芯片墨上。
- **芯片墨 `#14171C` / 丝印白 `#F6F5F0`**：深色与浅色工作台的基准面。
- **状态**：未连接灰、连接中 / 进行中用主色族加脉冲、已连接绿、风险琥珀、错误红。每个颜色只说一件事，状态永远配文字。
- **语义独立**：代码语法、终端 ANSI、直方图通道色与样例画面不随品牌色替换。
- **对比度**：文字 ≥ 4.5:1，图标、边框、焦点环与大字 ≥ 3:1，由 `brand/scripts/build.cjs` 与 `desktop/scripts/check-brand.cjs` 自动校验。

## Logo

彩色标志自带芯片墨板体；横向组合必须带板体；深色工具栏用不带板体的小灯，浅色工具栏用小板体；16–32 px 用小尺寸母版。不改灯罩颜色，不加发光、阴影或渐变。

## Typography

品牌页与文档用系统中文字体；工作台沿用本地 `Scope Plex` / `Scope Plex Mono`。nodu 字标是原创单线圆端路径，不依赖字体；“见微”用思源黑体 SC 设置，印刷前转曲。

## Components

主按钮为 Nodu 蓝底白字、4 px 圆角，悬停深色主题 `#3F68FF`、浅色主题 `#2449DB`；焦点为 2 px 轮廓。次要按钮用抬升表面。设备 chip 用 6 px 状态点：未连接为灰点加虚线边框，连接中为主色脉冲，已连接为绿，出错为红。学习里程碑在芯片墨圆点上显示点亮黄。

## Do's and Don'ts

- **Do** 在 `brand/src` 改色，重新生成并一起提交；界面里用 `NODU_COLORS` 或 `--theia-*` / `--theia-scope-*` 变量。
- **Do** 保留主题 ID `scope-dark` / `scope-light` 和 `scope.*` 颜色 ID 的兼容性。
- **Don't** 在 `desktop/scope-extension/src`、`style` 中写品牌色值或 v1 旧色（`#4F7CFF`、`#64C5AC` 等）。
- **Don't** 用点亮黄做按钮或警告，不把它放在浅色背景上。
- **Don't** 把 K210 以外的芯片写成已支持；STM32、ESP32 仍是规划范围。
