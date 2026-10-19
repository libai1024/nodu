# SCOPE 的 Electron IDE 底座调研

核验日期：2026-10-19。结论：独立 Windows/macOS 桌面版采用 Eclipse Theia；OpenSumi 是 React 界面定制方向的备选。原交互网站继续作为设计规范和交互验收样例。

落地状态：调研后已在 `desktop/` 组合 Theia 1.76.0 官方模块、自有 `scope-extension` 和 Electron 42.8.1，完成基本工作区。macOS 原生窗口与浏览器入口已运行；Windows 尚未实机验证。启动和功能边界见 [桌面说明](GETTING_STARTED.md)。下文设备服务与搭芯联动仍为后续方案。

## 候选比较

| 项目 | 复用范围 | 与 SCOPE 的关系 | 核心许可 |
| --- | --- | --- | --- |
| Eclipse Theia | 完整模块化 IDE 工作台，可构建 Electron 桌面应用，提供编辑、文件树、终端、命令、布局与扩展能力 | 首选；用 Theia extension 与 ReactWidget 增加图像、设备、参数和回放面板 | EPL-2.0；有 GPLv2 + Classpath Exception 次级许可，第三方部分另列 |
| OpenSumi | 可组合 IDE 框架，有 Electron 模板、React Slot、内置组件与主题机制 | 备选；React 布局定制直接，但桌面模板需要升级验证 | MIT，第三方部分见 NOTICE |
| Code-OSS | 完整编辑器产品源码、工作台、命令、快捷键与扩展机制 | 可以 fork；深度改造和持续合并上游的维护成本预计高于使用产品框架 | 源码 MIT；微软发行产品采用不同许可 |
| Molecule | React Web IDE UI，Monaco、Workbench、命令面板、资源树、主题 | 轻量界面方案；需要自行组合 Electron 和设备后端，不等同完整桌面平台 | MIT |
| Electron Forge | Electron 脚手架、构建、签名、安装包与发布流水线 | 可辅助桌面工程，但不提供 IDE 工作台或统一控件间距 | 以其项目许可为准；本次未逐依赖审计 |

来源：[Theia 项目](https://github.com/eclipse-theia/theia)、[Theia Widgets](https://theia-ide.org/docs/widgets/)、[Theia 桌面打包](https://theia-ide.org/docs/blueprint_documentation/)、[OpenSumi](https://github.com/opensumi/core)、[OpenSumi Electron](https://opensumi.com/en/docs/integrate/quick-start/electron/)、[Code-OSS](https://github.com/microsoft/vscode)、[Molecule](https://github.com/DTStack/molecule)、[Electron Forge](https://www.electronforge.io/)。表中维护成本与适配优先级是基于这些架构的工程判断。

## 为什么优先 Theia

Theia 为构建自有产品提供扩展与替换工作台的机制。ReactWidget 支持在可停靠区域承载自定义 UI；成熟布局可以复用面板拖拽、标签、缩放、布局恢复等操作。其 UI shell 和 K210 设备通信的职责能够分别实现。

最贴近 SCOPE 的实际案例是 Arduino IDE 2.x：官方明确说明使用 Theia + Electron，编译、上传等后台工作交给独立 Arduino CLI daemon。这证明嵌入式 IDE 可以沿用该分层架构。Arduino 自身是 AGPLv3，不能与 Theia 的平台许可证混同，也不能将参考架构等同于已获其全部代码的其他许可。[Arduino 官方仓库](https://github.com/arduino/arduino-ide)。

## 间距与交互能复用什么

复用框架的收益包括文件树行高、选中态、标签栏、面板分隔、拖拽与缩放、焦点处理、命令及键盘交互。自定义视觉面板仍须统一自己的 toolbar、参数行、表单、按钮及空态组件。颜色主题、密度和结构布局应分别管理，不能期待替换一个主题文件就自动调整所有尺寸。

Theia 的自定义 Widget 使用框架布局与主题上下文；OpenSumi 提供 Button、Input、Dialog、Select、Tabs 等内置组件和主题变量。两者均优于为每个业务面板重新实现通用控件的状态和交互。[Theia Widgets](https://theia-ide.org/docs/widgets/)、[Theia TreeWidget](https://theia-ide.org/docs/tree_widget/)、[OpenSumi 组件](https://opensumi.com/en/docs/extension/develop/built-in-component/)、[OpenSumi Slot 布局](https://opensumi.com/en/docs/integrate/universal-integrate-case/custom-view/)。

建议保留 SCOPE 的色彩、功能结构和工作流；文件树、编辑器标签、终端、设置等使用框架组件。图像预览、LAB 调参、设备部署与回放采用同一组自有业务组件，并从 DESIGN.md 与设计 JSON 提取实际工程 tokens，集中处理密度。

## 维护与兼容核验

- Theia 的官方 Releases 在本次核验时标记 v1.76.0 为最新稳定版，发布时间 2026-09-24。[Releases](https://github.com/eclipse-theia/theia/releases)。
- OpenSumi core 最新标记 Release 为 v3.9.0（2025-05-20），主分支在 2026-10-15 仍有功能提交。不能据发布日期称其停更。[Release](https://github.com/opensumi/core/releases/tag/v3.9.0)、[近期提交](https://github.com/opensumi/core/commit/9da5ceb24364ccf3230b0844502d95fd80e0d6c9)。
- OpenSumi 官方 ide-electron 示例的 main 最近提交为 2024-08-02，其依赖仍包含 OpenSumi 3.2.1 与 Electron 22.3.25。选用前需验证升级后的桌面打包与原生依赖，不能把示例模板直接当成当前发行底座。[模板依赖](https://github.com/opensumi/ide-electron/blob/main/package.json)、[模板提交](https://github.com/opensumi/ide-electron/commit/730511070ce4e7beecd503e1ea991795666a6f8b)。
- Theia 与 OpenSumi 都按版本支持 VS Code API。应针对必需插件做兼容清单，不宣称所有 VS Code 扩展通用。Theia 定制工作台宜使用 Theia extensions，并区别于其旧的 Theia plugins 概念。[扩展机制](https://theia-ide.org/docs/extensions/)、[兼容说明](https://theia-ide.org/docs/user_install_vscode_extensions/)、[OpenSumi 插件概览](https://opensumi.com/en/docs/extension/overview/)。

## 面向设备与搭芯的分层建议

以下是工程方案，未在本次调研中完成实机验证：

1. Theia/Electron 承担独立桌面壳、编辑器、文件、快捷键与标准工作台。
2. SCOPE 扩展承担摄像头帧、LAB 参数、模型资源、部署和回放面板。
3. 独立 device-service 负责串口所有权、REPL、文件传输、烧录工具进程与帧数据，经本地 RPC/IPC 与 UI 通信。
4. 搭芯复用设备协议和项目格式，通过自己的适配层连接同一服务；这样可避免为两个产品各维护一套烧写逻辑。

这与 Theia 的本地 Node 后端及 OpenSumi Electron 的前后端通信结构相容，但原生串口库、Windows/macOS 安装包、驱动和断连行为仍须实际验证。[Theia 架构](https://theia-ide.org/docs/architecture/)、[OpenSumi 集成架构](https://opensumi.com/en/docs/integrate/overview/)。
