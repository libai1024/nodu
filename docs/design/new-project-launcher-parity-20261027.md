# IDE 新建项目与启动台样式统一

日期：2026-10-27

## 本轮实现

IDE 的新建项目窗口与启动台继续使用同一个 `NewProjectForm`，现在也共用 `desktop/scope-extension/style/new-project.css`。`embedded.css` 中旧的固定 232px 表单布局以及 `launcher.css` 中重复覆盖表单的规则已移除。IDE 的业务入口和启动台路由没有调整。

对照依据是已保存的真实启动台截图 `arduino-electron-acceptance-20261027/01-new-project.png`，以及旧表单视觉记录 `esp32-framework-acceptance-20261026/arduino-light.jpg`。后者是已有独立表单检查截图，不作为本轮真实 IDE 验收证据。

| 部位 | 原先差异 | 已实现的共用设计 |
| --- | --- | --- |
| 字体与标题 | IDE 继承设备面板字体和独立 16px 标题，启动台另有规则 | 共用 Scope Plex 与中文回退字体；IDE 标题与启动台采用 21px、600 字重，矮窗口为 18px |
| 内容边框 | IDE 只有顶部线，启动台为独立边框 | 表单内容区统一细边框、8px 圆角与编辑器背景 |
| 芯片树 | IDE 固定 232px、全宽选中底色；启动台圆角浅强调 | 共用 30px 行高、6px 圆角、浅强调选中底色；树列表独立滚动 |
| 标签和控件 | IDE 与启动台分别设定间距、输入样式 | 标签在上，统一 11px 标签、12px 控件文本、34px 控件高和 6px 圆角 |
| 型号与模板 | 依赖两组布局与下拉覆盖 | 继续使用自绘 `NoduSelect`；两列布局按表单宽度转为一列，标签省略与箭头预留空间一致 |
| 项目位置 | 目录按钮的有效高度只有 18–20px | 目录按钮在 34px 控件内拥有 34×32px 点击区，保留分隔线 |
| 开发框架 | ESP32 框架规则与其他布局分散 | Arduino / ESP-IDF 的 logo、选中状态、键盘焦点在共享表单内统一 |
| 底部按钮 | IDE 独立分隔线、32px 按钮，启动台 30px | 共用右对齐的 30px 按钮与主题状态；footer 不参与表单内容滚动 |
| 窗口适应 | IDE 内容宽度和高度靠旧布局限制 | IDE 居中，最大 760×600px，正常视窗保留 48px 边距；高度 ≤540px 时保留 32px。表单自身在 560px、400px 宽度处调整芯片列和字段布局 |

框架、控件、选中与禁用状态全部使用已有 `--theia-*` 主题变量，没有增加独立颜色或解释性文案。表单采用有界 flex/grid 布局，未使用 `height: 0` 再以最小高度补偿的布局方式。

## 样式隔离检查

- `desktop/scope-extension/style` 中的 `.nodu-np-*` 和 `.nodu-new-project*` 样式只存在于 `new-project.css`，其他文件不再覆盖表单。
- IDE dialog 的内容节点由通用 `scope-widget` 改为专用 `nodu-new-project-content`，因此不会再继承设备面板的 280px 最小宽度、侧栏背景、外层滚动、3px 输入圆角及 `5px 7px` 内边距。
- 原先由 `scope-widget` 提供的字体、box sizing、选中文本颜色、按钮禁用、输入焦点和输入尺寸已在共享表单中明确设置。表单没有 checkbox、原生 radio、range 或 textarea，不依赖这些设备面板规则。
- `NoduSelect` 的菜单仍使用现有全局弹出层实现。表单只覆盖触发按钮；箭头改为正常 flex 布局，避免原来的绝对定位与文字末尾重叠。
- Theia dialog 默认的 `pre-line` / `pre-wrap`、内容 padding 和外层滚动已在专用窗口内明确复位。标题和关闭按钮保留 Theia dialog 的操作机制。
- 旧的未使用 `.nodu-np-field` 规则已随旧表单块删除。新 CSS 中的 23 个表单 class 均能在当前组件中找到对应项。

## 保留的行为

K210、STM32 与 ESP32 全部芯片、各入口原有默认系列、Arduino 默认选择、Arduino / ESP-IDF logo、框架键盘切换、芯片切换保留已编辑内容、名称与路径验证、目录选择、模板筛选、忙碌状态、防止重复提交、取消与创建后的项目打开逻辑均保留。

## 创建后自动打开 Arduino 主文件

真实窗口检查发现，新建 C3 串口示例后项目已打开，中央编辑区仍为空；从文件树打开 `.ino` 后才显示源码。原因是共用的 `ScopeWorkbenchContribution.initializeLayout` 只列出了 Python 与 C 的启动文件，没有 Arduino 主文件。

该入口现在优先检查并打开实际存在的 `<项目目录名>.ino`，因此 IDE 与启动台创建后的工作区采用同一条正常编辑器打开流程。主 sketch 存在时不再继续激活无关的备用文件；不存在时保留原来的 `thresholds.py → camera.py → main.py → main/main.c` 顺序。STM32 的 `projectOpened` / `Core/Src/main.c` 处理未改动。

Theia 恢复已有布局时原本就会跳过默认布局初始化。此外，首次打开流程在异步文件检查前后核对当前工作区和编辑器集合：已有恢复编辑器、检查期间用户手动打开了文件，或工作区已切换时，不再自动抢占焦点。实现没有增加延时重试、模拟文本或文件创建。

新增的 6 项生命周期用例覆盖：

1. C3、S3、中文目录的同名 sketch 自动打开，且优先于其他备用源码。
2. K210 与 ESP-IDF 保持原有启动文件顺序。
3. 缺少同名 sketch 时不猜测其他 `.ino`，不创建入口文件。
4. 已存在恢复编辑器时跳过默认文件发现。
5. 异步文件检查期间用户打开编辑器时保留其选择。
6. 异步文件检查期间切换工作区时不打开旧 sketch。

## 已完成自动验证与 GUI 结果来源

- `npm run compile --workspace @scope/studio-extension`：通过。
- 样式统一后的 launcher / launcher-view 检查：42/42 通过。其中覆盖默认 Arduino、两种框架标识、IDF 请求参数、键盘切换、目录选择异常、卸载后异步回调、创建防重和入口路由。
- 自动打开修复后的 minimal-workbench、launcher、launcher-view 与 STM32 flash command 回归：96/96 通过，包含上述 6 项新增生命周期用例。
- 修改文件的 `git diff --check`：通过。
- 已执行命令记录见 [regression-commands.txt](new-project-electron-acceptance-20261027/regression-commands.txt)，结果见 [regression-results.txt](new-project-electron-acceptance-20261027/regression-results.txt)。原运行未重定向完整 stdout；结果文件明确标注为已完成工具输出的精简转录，整理期间未重复运行测试。
- **本轮真实 Electron GUI 验收通过。** 统一构建后的定点复验确认：同一 profile 的最近项目恢复 `.ino`；从 IDE 新建 `ui_esp32_c3_fixed` 后，无需点击文件树即可自动显示真实同名 `.ino`，编辑器焦点正确、运行入口启用，编辑保存成功。布局、主题、窗口缩放、滚动、菜单及表单行为的完整结果与截图以独立验收 [README](new-project-electron-acceptance-20261027/README.md) 为准。

实现与文档整理期间没有启动、重启或替换用户正在使用的预览。
