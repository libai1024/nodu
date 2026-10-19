---
name: "Nodu · 见微"
description: "多芯片入门嵌入式 IDE 的蓝色品牌、石墨工作台与暖白阅读表面。"
colors:
  brand-blue: "#4F7CFF"
  brand-on-dark: "#8EACFF"
  brand-on-light: "#244BB0"
  brand-soft: "#E8EEFF"
  graphite: "#181D20"
  paper: "#F3F3EE"
  paper-surface: "#FCFCF8"
  panel: "#1C2226"
  surface: "#20272B"
  raised: "#293338"
  hover: "#303C41"
  border: "#344047"
  input-border: "#526068"
  text: "#E8ECE9"
  muted: "#A9B7B9"
  disabled: "#85969B"
  button-ink: "#101827"
typography:
  body:
    fontFamily: "Plex, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
  workbench:
    fontFamily: "'Scope Plex', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "var(--theia-ui-font-size1, 13px)"
  label:
    fontFamily: "'Scope Plex', 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "11px"
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
    backgroundColor: "{colors.brand-blue}"
    textColor: "{colors.button-ink}"
    rounded: "{rounded.toolbar-control}"
    padding: "3px 10px"
  button-primary-hover:
    backgroundColor: "{colors.brand-on-dark}"
  button-secondary:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.toolbar-control}"
    padding: "3px 10px"
  layout-toggle:
    textColor: "{colors.muted}"
    rounded: "{rounded.toolbar-control}"
    padding: "5px"
    width: "30px"
    height: "28px"
  brand-button:
    backgroundColor: "{colors.brand-on-light}"
    textColor: "{colors.paper-surface}"
    rounded: "{rounded.brand-button}"
    padding: "11px 18px"
---

# Design System: Nodu · 见微

品牌规范 v1.0 · 2026-10-19。本规范记录 `brand/` 与 `desktop/` 当前实现；产品能力见 [PRODUCT.md](PRODUCT.md)，桌面行为见 [docs/desktop-ui.md](desktop-ui.md)。`preview/dist/` 保留 SCOPE / 矿物青绿原貌，完整历史规范附于文末，不能作为当前蓝色主题的实现说明。

## Overview

**Creative North Star: "从第一行代码，开始做硬件。"**

Nodu · 见微是面向嵌入式初学者的独立 IDE 品牌。主标以小写 n 与独立圆点表达起点，原创路径字标固定为小写 nodu。蓝色是用户已确认的正式主色，暖橙与紫色仅保留在品牌页作为对照。

暖白承载品牌阅读，石墨承载长时间开发操作；蓝色集中表达品牌、主要动作、活动标记和焦点。面板通过表面明度、细分隔线与稳定对齐建立层级。界面继续使用紧凑工具栏与可调整的工作区。

**Key Characteristics:** 正式蓝色；暖白阅读与石墨操作；紧凑工具栏；明度与细分隔线。

## Colors

YAML 中的 `brand-*` 为当前蓝色角色：标准蓝用于主要动作与活动标记，深底适配用于主标、文字链接、光标与焦点，浅底适配用于品牌页文字和按钮，柔和蓝用于浅色选择表面。深色选择底使用标准蓝的透明变体（`#4F7CFF26` / `#4F7CFF40`）。中性色对应当前 Theia 工作区与品牌阅读表面。

**The Semantic Color Rule.** 品牌强调与代码、终端及样本语义分开：语法字符串、ANSI 绿色和合成绿色物体保留其含义，不随品牌蓝替换。

主题源为 [scope-theme.ts](../../desktop/scope-extension/src/browser/scope-theme.ts) 与 [brand/site.css](../../brand/site.css)。内部主题 ID `scope-dark` 和现有 CSS 变量名保留兼容；可见主题名为“见微 Nodu · 石墨”。浅色 / 高对比回退不是一套已经验收的独立完整浅色主题。

## Typography

品牌页使用本地 IBM Plex Sans 与 Plex Mono；工具栏使用本地 `Scope Plex`。字体文件声明常规 400 字重，其余权重是 CSS 请求。Theia 主界面继续使用框架及平台 UI 字体；代码和数据使用 Theia 等宽字体设置。原创 nodu 字标为 SVG 路径，不依赖安装字体。

## Layout

桌面工具栏高 44 px、左右内边距 12 px、默认项目间距 12 px，两侧按钮组内间距 6 px；较窄窗口按现有断点压缩间距和补充文字。模式切换图标位于右上角控制台与最右相机按钮之间。简洁 / 专业布局共享编辑缓冲区与视觉会话，尺寸和停靠由 Theia 管理。

品牌页采用独立阅读排版；桌面工作台不沿用品牌页布局。具体响应式规则见 sidecar，行为见桌面 UI 文档。

## Elevation & Depth

常驻工作区以石墨表面、面板明度和细边界建立层级。Theia 浮层沿用框架阴影，主题 shadow 色为 `#00000040`。主标保持平面 SVG 几何。

## Shapes

主标保持小写 n 的开口与独立圆点，单标最小显示 16 px，工具栏显示 24 px；四周至少保留一个圆点直径的留白。工具栏控件采用小圆角，布局图标为 30 × 30 px、内部 SVG 18 px。原创 SVG 是生产母版，PNG、ICNS、ICO 为导出资产；平台安装器尚未接入。

## Components

- **主要动作**：工具栏按钮高 30 px，使用标准蓝与深色文字；悬停变为深底适配蓝，焦点为 2 px 轮廓并外偏移 2 px。
- **次要动作**：使用抬高表面与明亮文字，悬停增加表面明度；禁用使用真实 `disabled` 和弱化文字。
- **布局图标**：灰色线形按钮，动态无障碍名称与 `aria-pressed` 表达模式，焦点轮廓外偏移 1 px。
- **输入与结果**：LAB 使用有名称的原生 range，蓝色表示操作，结果另有文字和空态。设备控件显示真实连接状态。
- **品牌页按钮**：暖白表面上的深蓝按钮，另有独立可见焦点；对照配色只改变品牌页展示，不修改 IDE 设置。

当前组件与样式分别见 [scope.css](../../desktop/scope-extension/style/scope.css)、[layout.css](../../desktop/scope-extension/style/layout.css)、[widgets.css](../../desktop/scope-extension/style/widgets.css)。原始品牌资产、尺寸与许可见 [brand/README.md](../../brand/README.md)。[品牌预览](http://127.0.0.1:4190/brand/)与[资产包](../../brand/assets/brand-kit.zip)提供可检查交付。

## Do's and Don'ts

- **Do** 保留主标 n 的开口、独立圆点和原始纵横比。
- **Do** 根据背景选择蓝色的明暗适配，并保留文字、图标和可见焦点。
- **Do** 标明合成演示、AI 概念图、实际运行截图和历史快照的来源。
- **Don't** 把暖橙、紫色或历史青绿称为当前正式主色。
- **Don't** 将品牌页落位示意或历史部署演示描述为已实现硬件能力。
- **Don't** 把内部兼容标识或历史快照中的 SCOPE 当作当前可见品牌。

## Historical Snapshot — SCOPE / 矿物青绿

以下折叠内容完整保留原 Design Edition 0.1 的源码记录；其 token、平台描述、快捷键和能力限制只适用于未改动的 `preview/dist/` 历史网站。当前 Nodu 规范以上文为准。机器记录保存在 `.impeccable/design.json` 的 `extensions.historicalSnapshots.previewDist`。

<details>
<summary>展开历史 DESIGN.md 原文（非当前规范）</summary>

````markdown
---
name: "见微 · SCOPE"
description: "暖白阅读与石墨工作台，让代码、视觉和设备共享清楚的工作区。"
colors:
  docs-light-paper: "#F3F3EE"
  docs-light-surface: "#FCFCF8"
  docs-light-subtle: "#EAECE5"
  docs-light-ink: "#24352F"
  docs-light-muted: "#626F68"
  docs-light-line: "#D7DDD4"
  docs-light-accent: "#27634F"
  docs-light-accent-soft: "#E0EEE3"
  docs-light-focus: "#387A61"
  docs-light-warn: "#8D5B1C"
  docs-light-danger: "#A43E39"
  docs-dark-paper: "#1D2422"
  docs-dark-surface: "#242D29"
  docs-dark-subtle: "#303B35"
  docs-dark-ink: "#E5ECE4"
  docs-dark-muted: "#ADBAB1"
  docs-dark-line: "#3C4941"
  docs-dark-accent: "#9FDBBD"
  docs-dark-accent-soft: "#314C3F"
  docs-dark-focus: "#A0DFBD"
  docs-dark-warn: "#E8B86A"
  docs-dark-danger: "#E99893"
  workbench-dark-bg: "#181D20"
  workbench-dark-surface: "#20272B"
  workbench-dark-panel: "#1C2226"
  workbench-dark-raised: "#293338"
  workbench-dark-hover: "#303C41"
  workbench-dark-border: "#344047"
  workbench-dark-text: "#E8ECE9"
  workbench-dark-muted: "#A9B7B9"
  workbench-dark-subtle: "#85969B"
  workbench-dark-accent: "#64C5AC"
  workbench-dark-accent-faint: "#25483F"
  workbench-dark-code-blue: "#84B7DB"
  workbench-dark-code-orange: "#D4A47C"
  workbench-dark-code-string: "#AAC78C"
  workbench-dark-selected: "#2A383D"
  workbench-light-bg: "#F4F5EF"
  workbench-light-surface: "#E8ECE5"
  workbench-light-panel: "#EDF0E9"
  workbench-light-raised: "#DFE6DE"
  workbench-light-hover: "#D5DED5"
  workbench-light-border: "#BDC9BF"
  workbench-light-text: "#20312C"
  workbench-light-muted: "#50645C"
  workbench-light-subtle: "#5F7168"
  workbench-light-accent: "#236E58"
  workbench-light-accent-faint: "#D5E6D9"
  workbench-light-code-blue: "#245B88"
  workbench-light-code-orange: "#8E4C25"
  workbench-light-code-string: "#4C6A2D"
  workbench-light-selected: "#D9E5DC"
typography:
  display:
    fontFamily: "Plex, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "38px"
    fontWeight: 600
    lineHeight: 1.32
    letterSpacing: "-1.6px"
  headline:
    fontFamily: "Plex, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "25px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontFamily: "Plex, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: "Plex, 'PingFang SC', 'Microsoft YaHei', sans-serif"
    fontSize: "11px"
    fontWeight: 400
  workbench:
    fontFamily: "Plex, 'PingFang SC', sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  code:
    fontFamily: "PlexMono, 'SFMono-Regular', Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.85
rounded:
  tag: "4px"
  control: "5px"
  group: "6px"
  workbench: "8px"
  dialog: "9px"
  mini: "3px"
spacing:
  space-4: "4px"
  space-8: "8px"
  space-12: "12px"
  space-16: "16px"
  space-24: "24px"
  space-32: "32px"
  space-48: "48px"
components:
  button-primary:
    backgroundColor: "{colors.docs-light-accent}"
    textColor: "{colors.docs-light-surface}"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  input:
    backgroundColor: "{colors.docs-light-surface}"
    textColor: "{colors.docs-light-ink}"
    rounded: "{rounded.control}"
    padding: "9px 11px"
  navigation-active:
    backgroundColor: "{colors.docs-light-accent-soft}"
    textColor: "{colors.docs-light-accent}"
    rounded: "{rounded.control}"
    padding: "11px 13px"
  chip-success:
    backgroundColor: "{colors.docs-light-accent-soft}"
    textColor: "{colors.docs-light-accent}"
    rounded: "{rounded.tag}"
    padding: "5px 9px"
  states-panel:
    backgroundColor: "{colors.docs-light-surface}"
    textColor: "{colors.docs-light-ink}"
    rounded: "{rounded.group}"
---

# Design System: 见微 · SCOPE

Design Edition 0.1 · 2026-10-19

本文记录 `preview/dist` 已实现的网站与交互原型。产品方向是面向 Windows / macOS 的独立 MaixPy / K210 视觉 IDE；本次交付是浏览器中的设计语言网站，不是可连接硬件的桌面 IDE。产品范围以 [PRODUCT.md](PRODUCT.md) 为准，机器可读设计记录见 [.impeccable/design.json](../../.impeccable/design.json)。

## Overview

**Creative North Star: "清晰的视觉工作台"**

**Key Characteristics:** 暖白阅读与石墨操作；矿物青绿强调；明度与细分隔线；紧凑工作台与宽松文档。

品牌名为 **见微 · SCOPE**，中文界面保留 Python、LAB、RGB565、MaixPy 等熟悉的技术名称。SCOPE 是当前概念名称，不包含商标可用性声明。品牌标识采用取景框 / 视觉中心意象；工作台使用光圈线形标记。

视觉主张是“代码、视觉与设备，在一个工作区”。暖白纸面承载说明，石墨工作台承载操作，矿物青绿集中表达主要动作、当前选择和就绪状态。面板靠明度、细分隔线与稳定对齐区分，阴影只在少数浮层和选中控件上辅助层级。界面不依赖装饰性渐变。

- 让当前项目、运行目标、执行状态与演示属性保持可见。
- 代码与画面并列；视觉调参时扩大画面，应用参数后展示源码变化。
- 临时运行、文件部署、安装开机脚本、固件更新各有独立入口与影响说明。
- 将真实能力依据、合成数据和 AI 概念图清楚标注。

## Colors

阅读页面与工作台有独立主题。阅读主题以 `scope-theme` 存入本地存储；工作台主题保留在当前页面会话中。默认组合为浅色阅读页 + 石墨工作台。

四套颜色以 `docs-light`、`docs-dark`、`workbench-dark`、`workbench-light` 为前缀列在 YAML 中。背景、表面、次级表面、正文、次要文字、边界与强调色按语义复用。

阅读页的警告色取当前主题的 `warn`，错误色取 `danger`。成功状态沿用主题强调色，警告表示需要确认或能力不匹配，错误表示动作失败；三者都配合文字及图标。工作台用 `INFO / OK / NOTE` 日志类型、状态文本与颜色共同传达结果。

代码语义色与操作语义分开：关键字、数字、字符串、注释分别使用当前工作台主题的 `code-blue`、`code-orange`、`code-string`、`subtle` token。阈值所在行使用强调浅底，应用后的变化用删改标记与颜色共同表达。

## Typography

字体由站点本地提供，不依赖运行时字体 CDN。`Plex` 对应 `assets/plex-sans.woff2`，`PlexMono` 对应 `assets/plex-mono.woff2`，两者均声明 `font-display: swap`、常规 400 字重。界面中的 500 / 600 层级由 CSS 请求，当前没有独立的对应字重文件。

| 场景 | 字体 | 实际尺寸与行高 |
| --- | --- | --- |
| 阅读正文 | Plex → PingFang SC → Microsoft YaHei → sans-serif | 根字号 14 px，正文常用 13 px，基础行高 1.6；导语 1.8 |
| 页面主标题 | 同上 | 默认 38 px / 1.32；小屏 28 px、中等屏 32 px、大屏 42 px，600 字重 |
| 二级 / 三级标题 | 同上 | 25 px / 1.35、16 px；移动端二级标题 21 px |
| 工作台界面 | Plex → PingFang SC → sans-serif | 12 px / 1.5，补充信息 11 px |
| 代码、数据、时间、快捷键 | PlexMono → 平台等宽字体 → monospace | 代码 12 px / 1.85，行号与部分数据 11 px |

阅读页通过 24–48 px 的段落与区域间距维持节奏；工作台常用 8–16 px 间距和连续面板。密度示例提供“舒适 / 紧凑”切换，实际改变表格行上下内边距 15 px / 8 px；它只作用于组件示例，不是全站密度设置。工作台数字使用等宽数字布局，避免数值变化带来跳动。

## Layout

公开的间距刻度为 **4、8、12、16、24、32、48 px**。这是排版基准，实际控件包含为边框和文字对齐设置的 3、5、7、10、13、18 px 等局部值。

网站有六个主入口：设计概览、视觉语言、组件与状态、工作区布局、交互流程、核心界面；“功能依据”通过页脚进入。左侧导航固定宽 212 px，顶栏高 68 px，主内容最大宽 1800 px。默认主内容内边距为上 38、左右 36、下 56 px。

工作台宽度至少 960 px、默认高度 750 px。顶部项目栏高 56 px、工作区切换栏高 43 px、底部状态栏高 27 px。内部使用 48 px 活动栏、152 px 资源树、可伸缩主区；底部日志区高 113 px。资源树、目标选择、日志与状态栏贯穿四种模式。

| 工作区 | 布局重心 | 当前可操作的内容 |
| --- | --- | --- |
| `code` 编写与运行 / 代码 | 主区为源码预览，右侧帧与参数占 39% | 切换五个示例文件、运行 / 停止合成序列、切换检测叠加、导出合成帧 PNG、进入调参 |
| `vision` 视觉调参 / 视觉调试 | 大画面 + 290 px 阈值侧栏 | 调整 LAB 六个边界、限制下限不高于上限、重置参数、应用到网页内的 `thresholds.py` 并显示变更 |
| `deploy` 设备部署 | 文件与动作主区 + 240 px 目标能力侧栏 | 选择部署文件、演示连接检查、分别演示临时运行和文件部署、勾选后启用安装启动脚本、查看固件流程提示 |
| `replay` 仿真回放 / 帧回放 | 大画面与时间轴 + 240 px 帧结果侧栏 | 播放 / 暂停 90 帧合成序列、拖动帧位置、点击缩略图、导出当前合成帧 |

专注模式隐藏站点导航、顶栏、页脚和工作区说明，保留工作区切换与退出入口；工作台高度变为 `calc(100vh - 94px)`。它是网页内的布局切换，不调用浏览器全屏 API。

### Responsive

| 视口 | 阅读页面变化 | 工作台处理 |
| --- | --- | --- |
| ≥1600 px | 标题 42 px，内容左右内边距 52 px | 利用更宽主区 |
| 801–1200 px | 侧栏 190 px，标题 32 px，内容左右内边距 24 px；隐藏页头补充元信息 | 保持桌面结构 |
| ≤800 px | 侧栏变为可开关的 240 px 抽屉，顶栏 60 px，内容左右内边距 18 px；说明和排版示例转单列，色板三列 | 在专用容器内横向滚动，保留至少 960 px 的完整桌面布局 |

移动端用于阅读和检查设计，不将多面板桌面 IDE 压缩成手机编辑器。阅读主题与工作台主题可分别切换。

## Elevation & Depth

界面主要通过明度层级和细边界建立深度。工作台容器与对话框本身不使用阴影；选中分段按钮使用 `0 1px 3px #14251c12`，移动导航抽屉使用 `5px 0 30px #0002`，工作台通知使用 `0 6px 18px #0003`。模态遮罩使用半透明深色与 `blur(4px)`。这些是浮层与状态的辅助，常驻面板保持平静。

## Shapes

形状示例使用标签 4 px、控件 6 px、工作区 8 px。当前组件的实际实现更细：按钮 / 输入 / 导航项 5 px，分段容器与状态面板 6 px，分段内部按钮与标签 4 px，工作台 8 px，对话框 9 px，微型按钮 3 px。开关轨道和状态点保持圆形。

图标是项目内联 SVG，24 × 24 的绘制坐标、圆端点、圆转角、无填充线形。阅读页描边 1.6，通常显示 18 px；工作台描边 1.55，通常显示 17 px。小图标按位置降至 12–15 px，活动栏为 20 px。图标和文本相邻时作为装饰隐藏于辅助技术；仅图标按钮有明确中文名称。避免把单独的颜色或图形作为动作的唯一提示。

## Components

- **按钮**：主按钮使用主题强调色；次按钮以边框和表面色承载；轻量动作使用文字或透明按钮；危险动作使用错误色。默认按钮最小高 38 px，小按钮及工作台常规按钮为 32 px。部分工作台微型按钮为 23 px，属于桌面高密度布局。
- **交互反馈**：悬停改变表面或边框，阅读页按钮另有 1 px 上移；转场通常 150–160 ms。禁用状态使用真实 `disabled`，阅读页透明度 0.43，工作台 0.4。焦点使用 2 px 可见轮廓，阅读页外偏移 4 px，工作台 2 px。
- **选择与切换**：导航的当前页有 `aria-current`；分段按钮有 `aria-pressed`；工作台页签有 `aria-selected`；开关有 `role="switch"` 与 `aria-checked`。颜色配合背景、边框、下划线或侧边标记。
- **输入**：项目名称使用原生 `pattern` 检查，只接受字母、数字、连字符和下划线；非法内容显示错误边框。阈值、回放位置和示例参数采用有名称的原生 range 控件。
- **执行与反馈**：运行按钮在运行时换为停止动作；日志保留带类型的记录。部署进度展示百分比与 `progress`；部署期间冻结文件勾选，完成态只标记所选文件，所选文件和启动选项在同一工作台实例内保持。开机脚本安装需先勾选相应选择项。全站短反馈约 3 秒，工作台通知约 4.5 秒。
- **空态与恢复**：示例覆盖未连接设备、固件不支持图像传输和串口占用，并给出下一步入口。命令无匹配时提供关键词建议；图片未就绪时显示准备中占位。零目标时，检测框、数量与结果列表同步进入“未检测到目标”空态。

### Keyboard & Accessibility

| 按键 | 生效范围 | 行为 |
| --- | --- | --- |
| `⌘ K` / `Ctrl K` | 全站 | 打开或关闭命令面板 |
| `↑` / `↓` | 命令面板 | 在筛选后的命令按钮之间移动焦点 |
| `Enter` | 命令搜索输入 | 执行第一个匹配命令 |
| `⌘ Enter` / `Ctrl Enter` | 焦点在工作台内 | 切换演示运行 / 停止 |
| `Esc` | 已打开的原生对话框 | 关闭命令或图片对话框 |
| `Esc` | 工作台正在演示运行时，且焦点位于其中 | 停止演示；若同时处于专注模式，全站处理也会退出专注 |
| `Esc` | 专注模式 | 退出专注布局 |

工作台重绘后恢复触发控件焦点；原控件不再存在时回到当前工作区页签。页面语言为 `zh-CN`，提供“跳到内容”链接、控件标签、图标按钮名称、可见焦点、模态 `dialog`、`role="status"` 通知与 `role="log"` 日志。合成画布有文字名称，画布旁另有帧和目标文字结果。媒体查询 `prefers-reduced-motion` 会移除 / 缩短 CSS 动效；手动启动的合成帧播放仍需用户停止。

以上记录的是已实现的辅助功能，不等同于完整无障碍认证。工作台页签目前保留普通 Tab 顺序，未实现左右方向键切换；高密度微型按钮也没有统一扩大到触屏目标尺寸。

### Prototype Boundaries

交互原型中的源码为只读 `pre/code` 预览，没有文本编辑器或 Python 执行器。LAB 滑块会修改浏览器内存中的演示参数与源码字符串，检测数量采用简化规则，直方图为固定合成分布；它不执行真实 LAB 分割。运行与回放由 JavaScript 推进合成帧，所有坐标、置信度、文件大小和设备信息用于设计说明，不是硬件测量。

选择“软件仿真”或“野火 CAM Board”只改变演示目标。连接检查、文件部署、启动脚本安装和固件更新均不打开串口、不访问真实文件系统、不写入硬件。部署进度为定时演示。搭芯联动只有接口预留说明，没有 DACIR 集成或真实 K210 仿真后端。界面未接入云端推理，也不宣称与 MaixPy IDE 完全兼容。

同一工作台实例内切换模式会保留演示参数、所选文件和启动选项；离开页面后重新挂载工作台会恢复示例状态。阈值应用不写原工程，部署勾选也不代表持久化配置。真正产生本地文件的操作是导出当前合成帧 PNG，导出图包含设计演示标记。

### Concept Gallery & Evidence

网站先以 HTML / CSS / ES modules 实现，再以相同语言制作核心界面概念图。画廊已经提供 `assets/core-code.png`、`assets/core-vision.png`、`assets/core-deploy.png`，分别表现石墨代码工作台、明亮视觉调参、设备部署。每张都必须显示 **“AI 生成概念图 · 非运行截图”**，放大说明继续保留该属性。图片用于评审构图与层级，文字、数值和功能以可交互原型为准。三张概念图已经生成；画廊仅展示实际可访问的资产，并保留准备中占位。

本记录对照 `index.html`、`styles.css`、`app.js`、`workbench.css`、`workbench.js`，并检查了 `.impeccable/review/foundation.png` 与 `.impeccable/review/workbench-code.png`。这两张是实现界面的审阅截图，与画廊的 AI 概念图具有不同来源。

## Do's and Don'ts

### Do

- **Do** 保持项目、运行目标、演示属性与当前状态可见。
- **Do** 使用表面明度、细分隔线与稳定对齐建立层级。
- **Do** 用文字和图标补足语义色，并保留可见键盘焦点。
- **Do** 在概念图与导出合成帧中保留来源标记。

### Don’t

- **Don't** 将合成画面或 AI 概念图称为真实硬件运行截图。
- **Don't** 混用临时运行、文件部署、安装启动脚本与固件更新的入口含义。
- **Don't** 把高密度桌面工作台压缩成窄屏不可读的多栏布局。
````

</details>
