# Nodu 0.2.1：嵌入式 C 开发（STM32 HAL）

日期：2026-10-22。基线：`main` `dd8403a` / 应用 0.1.4 / Theia 1.76。

状态：**开发中（分支 `dev/0.2.1-embedded-c`，未合入、未发布）。** macOS 上 F103C8 + ST-LINK 的新建、编辑、编译、下载路径已实现，并在实物上验证（见 [acceptance.csv](acceptance.csv) 与 [evidence/](evidence/)）；串口 ISP、F407 实物、Windows、安装包内置工具包仍未完成。0.2 的方向是“嵌入式 C 开发 + AI 教学辅助”。0.2.1 是其中第一个可交付版本：在新品牌界面上，让学生完成 STM32 HAL C 工程的新建、编辑、编译、下载（烧写）和串口观察。AI 教学辅助（[0.2 设计](../0.2/AI-TUTOR-DESIGN.md)）建立在 0.2.1 的构建、下载与运行记录之上，不属于本版范围。

新品牌由另一个会话并行实施。本目录只依赖品牌产出的语义设计令牌（颜色、字体、图标），不定义品牌色值；效果图暂用 [2026-10-21 品牌提案](../../brand/proposals/2026-10-21/palette.cjs)的色值，最终以品牌会话合入主线的结果为准。

## 文档

| 文档 | 内容 |
| --- | --- |
| [PRD.md](PRD.md) | 产品需求：目标、用户与场景、功能清单与优先级、非功能需求、发布标准 |
| [FUNCTIONAL-DESIGN.md](FUNCTIONAL-DESIGN.md) | 功能与技术设计：工程模型、板卡包、工具包、编译、clangd、下载、串口监视、协议、安全 |
| [TOOLKIT-DISTRIBUTION.md](TOOLKIT-DISTRIBUTION.md) | 工具包分发：方案比较、实测体积、打包流水线、安装包托管、是否需要登录、许可与源码 |
| [UI-DESIGN.md](UI-DESIGN.md) | 界面设计：信息架构、工具栏、设备弹层、开始页与向导、问题与输出、串口监视器、下载引导、文案 |
| [mockups/](mockups/README.md) | 六张效果图（HTML 源文件；PNG 用 `render.cjs` 在本机生成） |
| [PLAN.md](PLAN.md) | 实施阶段、并行分工、关口、需要用户提供的条件 |
| [acceptance.csv](acceptance.csv) | 发布验收项与当前状态 |
| [evidence/](evidence/) | 实物记录（运行记录、备份摘要；原始 Flash 镜像不入库） |

## 方案摘要

- **工程**：普通 CMake 工程加 `nodu.json` 清单与 `nodu.lock.json` 版本锁。官方 HAL / CMSIS 放在 Nodu 自带的只读 SDK 中，启动文件、系统文件、链接脚本与板级代码进入工程。可导出为自带 Drivers 的独立工程，在终端、VS Code 或 CI 中构建。
- **工具**：Arm GNU 14.2.Rel1、CMake、Ninja、OpenOCD、stm32flash、clangd 和 HAL / CMSIS 组成“STM32 工具包”，按平台打进 Nodu 安装包：装好 Nodu 就能编译和下载，不需要再从官方站点下载。裁剪后实测每个平台安装后约 240 MB，单架构安装包增加约 74 MB。服务器只托管 Nodu 安装包与 GPL 源码，下载不需要登录。详见 [TOOLKIT-DISTRIBUTION.md](TOOLKIT-DISTRIBUTION.md)。
- **服务**：新增 Rust 侧车 `nodu-embedded`，负责工程校验、编译、产物、下载、串口监视和资源租约。它与 K210 的 `nodu-device` 共用串口锁，不扩展现有 K210 状态机。
- **编辑**：clangd 提供补全、跳转（可进入只读 HAL 源码）、悬停和实时诊断。推荐接入方式是 Theia 插件宿主加 vscode-clangd（MIT），在 M2 原型中确认；不可行时改用自写的精简 LSP 客户端。**当前实现采用后者**（`nodu-clangd-client.ts`）：本机没有 `@theia/plugin-ext`，也无法联网安装；方案 A 仍可在 M2 中评估。
- **下载**：ST-LINK（SWD，OpenOCD）与串口 ISP（stm32flash，引导 BOOT0）两条路径。每次写入前核对芯片型号与容量，首次写入某颗芯片前备份原程序。不修改选项字节与读保护。
- **界面**：同一个工作台按项目类型切换。C 工程的工具栏为：项目 ▾、编译、运行 ▾、停止、设备入口；右侧为文件列表、串口监视器和“更多”。编译错误进入“问题”，附中文解释；运行成功后自动打开串口监视器，输出按运行次数分隔。
- **调试**：断点调试放在 0.2.1 之后。本版保留产物身份与资源租约接口；适配器选型（cortex-debug、cdt-gdb-adapter 或 probe-rs）在后续阶段的原型中决定。

## 需要用户决定

| 编号 | 问题 | 建议 |
| --- | --- | --- |
| D1 | “编译”单独占一个工具栏按钮，还是收进“运行 ▾” | 单独按钮：不接板也能用，是 C 学习中最频繁的操作。C 工程没有帧缓冲开关，工具栏总数仍是 9 个，与 K210 相同 |
| D2 | HAL / CMSIS 放在 Nodu 自带的 SDK 还是复制进每个工程 | 自带只读 SDK 加“导出独立工程” |
| D3 | 工具链随安装包内置，还是按需下载 | 按平台打进安装包（实测单架构增加约 74 MB）；按需下载留到需要多版本时再做 |
| D4 | clangd 的接入方式 | 插件宿主加 vscode-clangd，M2 先测体积、启动时间与内存 |
| D5 | 断点调试是否纳入 0.2.1 | 不纳入，作为下一阶段 |
| D6 | F103C8 的具体板型、串口转换器型号 | 需要用户提供实物信息；未提供前只发布“通用 F103C8”板卡包，不含 LED 和按键模板 |
| D7 | Nodu 安装包托管在哪里 | 国内对象存储加 CDN 为主（需要已 ICP 备案的域名），GitHub Releases 为备；需用户确定账号与域名 |
| D8 | 下载是否需要登录 | 不需要；账号与 AI 教学一起设计 |

## 与既有文档的关系

- STM32 HAL 开发调研：位于分支 `spec/2026-10-20_validate-stm32-hal` 的工作树（`docs/0.2/STM32-HAL-DEVELOPMENT.md` 与 `tools/stm32-p0/`），**尚未提交**，主线没有这两份文件。本设计沿用其中的工具组合、SDK 锁定、产物身份和最佳实践；P0 尚未完成的四条实物下载路径列为 [PLAN.md](PLAN.md) 的 M0。合入主线前应先提交该分支，否则这些依据只存在于本机。
- [AI 教学设计](../0.2/AI-TUTOR-DESIGN.md)：0.2.1 为它提供 `compiles`（构建结果绑定源码版本）、`serialMatch`（运行 ID 与串口日志）和 clangd 符号锚点；主机单元测试（`hostTest`）需要主机编译器，只预留接口。
- [0.1.4 交接](../0.1.4/HANDOFF.md)：K210 MicroPython 工作流不变，作为回归项。
