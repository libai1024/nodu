<p align="center">
  <img src="brand/assets/app-icon-128.png" alt="Nodu" width="80" height="80">
</p>

# Nodu · 见微

**从第一行代码，到第一次点亮。**

Nodu 是面向嵌入式学习与开发的桌面 IDE。它把代码编辑、芯片工程、编译与烧录、串口观察放在同一个工作空间，提供 K210 的 MicroPython 工作流、STM32 的 HAL C 工作流，以及由学习者亲自输入代码的 AI 教学模式。

日常编程可以使用不含 AI 入口的极简模式；需要完整工具视图和教学辅助时，再切换到专业模式。两种模式共享工程和编辑状态。

[下载](https://github.com/libai1024/nodu/releases) · [0.2.2 发布说明](docs/releases/0.2.2.md) · [源码开发](desktop/README.md) · [文档](docs/README.md) · [许可证](LICENSE)

## 安装

从 [v0.2.2 Release](https://github.com/libai1024/nodu/releases/tag/v0.2.2) 下载对应平台附件。当前仓库为私有仓库，下载需要具有仓库访问权限的 GitHub 账号。

| 平台 | 下载 | 安装方式 |
| --- | --- | --- |
| macOS 15+ / Apple Silicon | [DMG](https://github.com/libai1024/nodu/releases/download/v0.2.2/Nodu-0.2.2-mac-arm64.dmg) · [ZIP](https://github.com/libai1024/nodu/releases/download/v0.2.2/Nodu-0.2.2-mac-arm64.zip) | 打开 DMG，或完整解压 ZIP，将 `Nodu.app` 移入“应用程序” |
| Windows x64 | [便携 ZIP](https://github.com/libai1024/nodu/releases/download/v0.2.2/Nodu-0.2.2-win32-x64.zip) | 完整解压后运行 `Nodu.exe`，保留同目录工具与运行库 |

macOS 包采用 ad-hoc 签名，未经 Apple Developer ID 签名或公证；Windows 包未经 Authenticode 签名，已在 Windows 10 19045 x64 验证启动和课程编译。Intel Mac 与 Linux 本版未提供安装包。

安装包使用者无需安装 Node.js 或 Rust。附件的 SHA-256、构建提交、实测范围及签名状态见 [发布说明](docs/releases/0.2.2.md#安装包与校验)。系统提示开发者身份无法验证时，请先核对来源与摘要，不要关闭全局系统保护。

## 两种芯片工作流

| | K210 / MaixPy v1 | STM32 / HAL C |
| --- | --- | --- |
| 编写内容 | MicroPython `.py` 脚本 | C 源码、头文件与 CMake 工程 |
| 板端前提 | 已安装兼容的 MaixPy 固件 | 芯片、SDK、启动文件与链接脚本匹配 |
| 执行方式 | 通过串口将脚本发送到板端 RAM 运行 | 在电脑编译，再将固件烧录到芯片 Flash |
| 常用操作 | 运行、停止、REPL、板端文件、相机帧缓冲 | 编译、烧录、编译并烧录、串口监视 |
| 产物 | Python 文件；可显式保存为板端文件或开机脚本 | ELF、BIN、HEX、MAP 与构建记录 |
| 持久化 | RAM 运行不会自动成为开机程序 | 成功烧录会改变芯片中的程序 |

K210 的脚本运行不需要每次重新烧写 MaixPy 固件。STM32 的“运行”指编译并烧录；电脑上的编译成功不代表目标芯片已经运行。

### STM32：第一个工程

1. 从独立工作台新建项目，选择目标芯片与模板，或从示例项目创建自己的副本。
2. 打开源文件并编写代码。clangd 提供 C 语言补全、定义跳转、悬停和诊断。
3. 在极简模式左下角长按动作按钮，选择 **编译、烧录、运行（编译并烧录）**；短按执行当前动作。没有硬件时也可以编译。
4. 在目标设备设置中选择 ST-LINK 或串口 ISP。多个下载器同时连接时，核对所选探针及芯片身份；串口 ISP 按界面提示操作 BOOT 和复位。
5. 保存并编译后查看输出，打开固件所在目录，或连接设备烧录。源码或下载配置变化后，过期构建不能直接用于烧录。
6. 在串口监视器中选择实际连接的端口和波特率，检查本次运行的新输出。

工程以 `nodu.json` 描述目标，使用锁文件记录 SDK 版本。构建产物关联源码、工具链与目标信息；编译失败不会把旧固件标为本次成功产物。

推荐从 [STM32F103 串口课程](desktop/examples/stm32f103-uart-tutor/README.md)开始。[STM32F407 与 SHT30 课程](desktop/examples/stm32-sht30-tutor/README.md)提供多文件练习；其源码构建和纯函数测试已有记录，传感器接线与真实 I²C 通信需要单独验证。

### K210：第一个脚本

1. 打开或创建 Python 项目，连接装有兼容 MaixPy v1 固件的 K210。
2. 在设备入口选择串口并连接，点击运行执行脚本。
3. 在 REPL 或串口输出中查看结果；使用相机时打开帧缓冲视图。
4. 需要断电后继续运行时，再显式保存到开发板或设为开机脚本。

示例：[相机采集](desktop/examples/gc2145-camera/README.md)、[颜色跟踪](desktop/examples/green-tracker/README.md)。不同开发板的引脚、传感器和固件可能不同，请使用与实际硬件一致的配置。

## 界面与 AI 教学

**极简模式**保留常驻左侧功能栏、代码编辑区和底部动作按钮，侧面板可收起。编辑区右上角的设置提供主题、模式、字号、自动保存、换行与缩进；顶部项目搜索用于快速打开文件。

**专业模式**提供完整工具视图及 AI 侧栏。AI 有“提问”和“教学”两种模式：提问用于解释与答疑；教学从用户想实现的功能出发，结合当前芯片、SDK 和源码生成计划，确认后逐步引导。

- **固定位置的参考代码**：单行或多行范字显示在源码输入区域下方，以灰色、上下分界线和 AI 图标区分。它不写入源文件，也不会随光标移动或编辑器失焦而漂移、消失。
- **逐行与片段反馈**：用户亲自输入，完成行或片段后检查。支持等价写法和“缺少上下文”结果，不在每次按键时请求模型。
- **任务浮窗**：跨多个文件编辑器显示步骤与进度，支持暂停、继续、增加步骤、删除未完成步骤和跳转对应文件，由 AI 教学总开关统一管理。
- **代码定位与批注**：从消息打开经工程路径校验的文件。高光与浮动批注只显示在编辑器中，不改写源码。
- **进度恢复**：保存目标、步骤和部分检查状态；恢复时重新核对源码，过期结果不会继续作为已验证结论。

模型设置支持自定义服务地址、模型和 API Key，适配 Chat Completions、Responses 与 Anthropic Messages 协议。不同服务商的兼容程度可能不同，请使用与账户套餐对应的地址。应用不内置公共密钥或免费额度。

启用模型辅助后，所需的工程上下文、代码片段和对话内容会发送给你选择的服务商。模型不直接执行任意终端命令或硬件操作。模型评价、C 语法检查、受控纯函数测试、固件编译和真机输出分别记录：**教学步骤完成不等于固件通过真机验证。**

账号登录、云端计费、并发限制与绑定电脑的一次性授权码属于 [0.3 设计](docs/0.3/README.md)，尚未作为当前版本的可用服务交付。

## 支持与验证范围

| 范围 | 当前记录 |
| --- | --- |
| macOS Apple Silicon | 已验证桌面工作台、极简界面、真实模型教学及部分设备流程 |
| K210 | 有野火 K210 / GC2145 的真实设备运行、文件与图像流程记录，不代表所有 MaixPy 板卡兼容 |
| STM32F103C8T6 | 已验证 HAL 编译、ST-LINK 写入与读回、目标运行和新的串口输出；串口 ISP 另有实测记录 |
| STM32F407 | 有 ST-LINK 写入、读回与运行记录；SHT30 课程的真实传感器通信未完成验收 |
| macOS Intel | 部分 x64 工具在 Rosetta 下验证，完整 Intel 真机应用仍待验收 |
| Windows | 有历史构建及部分设备冒烟记录，本次版本以 Release 的构建与测试结果为准 |
| 受控纯函数检查 | 当前用于 SHT30 CRC 与数据换算，macOS arm64 产品链路已验证；Windows 暂不可用 |

详细记录：[界面实现与验收](docs/design/minimal-ide/IMPLEMENTATION-2026-10-24.md)、[教学集成及设备记录](docs/ai-tutor/NIGHTLY-2026-10-24.md)、[工作台验收](docs/ai-tutor/WORKBENCH-ACCEPTANCE-2026-10-24.md)、[任务浮窗](docs/ai-tutor/TASK-OVERLAY-IMPLEMENTATION-2026-10-24.md)、[纯函数检查](docs/ai-tutor/PURE-FUNCTION-CHECKS.md)。历史设计稿保留当时状态，最新发行范围以 Release 为准。

## 从源码开发

主要技术栈：**Eclipse Theia 1.76、Electron 42、React 19、TypeScript 5.9 与 Rust**。依赖分别由 `desktop/package-lock.json` 和 `desktop/native/Cargo.lock` 锁定。

macOS 开发需要 Node.js **24.x**、Python 3、Git、Xcode Command Line Tools，以及仓库指定的 Rust。先按[开发入口](desktop/README.md)准备 Rust 目标、WASM 工具和芯片工具包，再执行：

```sh
cd desktop
npm ci
npm exec -- install-electron
npm run build:electron
npm run start:electron
```

不指定工程时会打开独立工作台。首次完整构建会下载固定版本依赖并编译原生组件。应用构建、STM32 工具包准备和发布打包是不同步骤；具体环境与命令见开发入口。

常用检查：

```sh
cd desktop
npm run compile --workspace @scope/studio-extension
npm run check:brand
npm run test:launcher --workspace @scope/studio-extension
npm run test:tutor --workspace @scope/studio-extension
node --test scope-extension/test/brand-theme.cjs
```

当前采用本地构建与人工发布流程，暂不启用 CI/CD。

## 代码结构

```text
desktop/
  electron-app/        Electron 应用入口
  browser-app/         开发用浏览器目标
  scope-extension/     UI、工程服务、模型网关、教学与设备集成
  native/              Rust 设备、构建、串口、图像与教学检查服务
  examples/            K210 示例及 STM32 教学工程
  scripts/             本地构建、工具包准备、打包与回归检查
brand/                 品牌资产、设计令牌及生成脚本
docs/                  设计、开发记录与验收证据
tools/                 硬件探针、工具链锁定与验证材料
```

`scope` 是部分内部包与兼容标识的历史名称，产品名称为 Nodu。DACIR / 搭芯模板位于新建项目的模板选项中；模板资源不代表本仓库包含 DACIR 仿真应用。

## 参与贡献

提交问题时，请附上应用版本、操作系统与 CPU 架构、工程类型、芯片和连接方式、复现步骤，以及去除敏感信息后的日志。不要上传 API Key、个人资料、原始设备 Flash 备份或不允许公开的源码。

提交代码时请保持 UI、模型网关、教学状态、本地检查和设备执行之间的职责边界；功能修改附相关回归验证，UI 修改核对深浅主题、窄窗口与键盘操作。品牌颜色和标志由 [brand/](brand/README.md) 的单一来源生成。

## 许可证

Nodu 自行编写的代码使用 [MIT License](LICENSE)。第三方框架、SDK、工具链、字体、模板及移植代码保留各自许可与署名；本仓库的 MIT 许可证不覆盖它们的原有许可。

例如，Theia 使用 EPL-2.0，STM32 HAL / CMSIS 按各自文件许可分发，部分 DACIR 模板驱动为 AGPL-3.0-only。复用模板或重新分发安装包前，请阅读对应目录的许可证及 [第三方组件说明](desktop/THIRD-PARTY-NOTICES.md)，保留适用的许可、修改记录和对应源码材料。
