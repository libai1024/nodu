# Nodu · 见微 0.1.1

当前精简布局与硬件阶段以 [交接](HANDOFF.md)和[桌面 UI](desktop-ui.md)为准。

<!-- impeccable:product-schema 1 -->

## Platform

desktop

目标平台为 Windows / macOS。当前已交付 `desktop/` 中可运行的 Theia / Electron 开发版本，并提供共享扩展的浏览器开发入口。macOS 原生 App 已完成本阶段 K210 与图像工具验收；Windows 仅有配置和启动脚本，尚未实机验证。安装包、签名和自动更新未交付。

`brand/` 是当前 Nodu 蓝色品牌页；`preview/dist/` 保留 SCOPE / 矿物青绿的历史设计快照，未迁移为蓝色。[DESIGN.md](DESIGN.md) 与 [.impeccable/design.json](../../.impeccable/design.json) 记录当前规范并保留历史记录；桌面行为见 [docs/desktop-ui.md](desktop-ui.md)。

## Stack

桌面版本：Eclipse Theia 1.76.0、Electron 42.8.1、React 19、TypeScript 5.9、Node.js 24 与 npm workspaces。Theia 编译期扩展承载 Nodu 主题、工具栏、命令和 ReactWidget 视觉 / 设备面板；编辑器、文件系统、终端和布局复用框架能力。

设计网站：无构建步骤的 HTML、CSS 和 ES modules，字体资源本地提供。当前品牌页与历史设计网站分别提供独立入口，历史网站保留原品牌与配色。

## Users

面向学习编程与硬件的学生、创客和嵌入式初学者，提供类似 Arduino 入门工具的清楚路径。K210 是首个硬件接入目标；STM32F103C8T6、ESP32-C3 / S3 为后续计划。该用户范围来自产品讨论，尚未经过独立用户研究。

## Product Purpose

构建面向 Windows / macOS 的独立开源嵌入式 IDE，使代码、板卡选择、构建、下载与视觉调试共享清楚的工作流程。各芯片使用实际编译工具链，产品不自研编译器。本阶段已有真实 IDE 基座与 K210 设备服务，通过 Theia RPC 连接同一持久 Python worker；简洁与专业布局共享编辑缓冲区和设备会话。工具链编译、库包管理与跨芯片下载尚未纳入通过项。

## Capabilities and Constraints

- 已实现：本机文件树、Monaco 编辑与保存 / 撤销、文件搜索、命令面板、本机终端、可停靠布局、石墨 / 品牌蓝主题和简洁 / 专业布局切换。Python / JSON 支持基础语法高亮与括号规则，尚未配置完整 Python 语言服务器或插件市场。
- 本地演示已实现：90 帧合成序列的播放 / 暂停与逐帧查看、检测叠加、LAB 六个边界调整、三种测试样本、零目标状态及输出日志。过滤依据是预设几何物体的 LAB 元数据，未执行 MaixPy 视觉算法；演示入口与“运行到设备”分开。
- 参数复制：合成演示和真实图像工具均复制当前 LAB 元组到剪贴板，由用户决定粘贴位置；不改写编辑器或磁盘文件。
- K210 原生 App 真板通过：野火 CAM K210 / GC2145、MaixPy 0.6.3 组合的扫描、连接 / 断开、固件身份与物理 profile 分离、REPL、RAM 脚本运行 / 停止和文件上传 / 下载。当前编辑缓冲区（含未保存修改）可经“运行到设备”发送，临时运行不保存为启动程序；运行中切换简洁 / 专业布局保留设备状态与未保存文本，断开重连后 REPL 恢复。UI 文件往返的 4,124 字节与 SHA-256 完全一致。
- 真实相机与图像工具原生验收通过：320 × 240 JPEG 显示正常纸箱场景，提供 ROI、RGB / 灰度直方图、PC LAB 像素值、阈值掩码、元组复制、适应 / 100% / 200% 缩放及 PNG / JPEG 原图导出。导出 JPEG 与板端最后一帧 SHA-256 一致。PC 端基于解码 JPEG 和 sRGB / D65 浮点 LAB，不承诺与板端 RGB565 / LAB 查表逐值一致；未测持续帧率，普通脚本运行时暂停低速快照。
- 固件准备、备份和烧写的 UI / 代码入口已有；当前会话尚无实际 Flash 容量认证，门禁禁止烧写，完整当前设备备份尚未完成，本轮没有真机烧写。历史启动日志的 `EF/17` 与旧 CLI / CanMV 备份不替代当前容量认证或 App 验收，见[容量证据边界](device-capacity-status.md)。
- 待独立实现或验收：STM32F103C8T6、ESP32-C3 / S3，工具链编译、板卡 / 库包管理、持久应用部署、串口绘图器、KPU 推理、K210 仿真和搭芯 / DACIR 集成。Windows 尚未实机验收。前期 MaixPy 菜单盘点不等于当前 Nodu 完整覆盖，缺项见 [功能基线](feature-baseline.md)。

## Brand Commitments

正式品牌为 **Nodu · 见微**，正文写 Nodu，原创字标写小写 nodu；主标是小写 n 与独立圆点。用户已选定蓝色主色，品牌规范 v1.0 以石墨工作台、暖白阅读表面和蓝色强调构成。中文界面保留熟悉的代码与 API 英文术语。标识以原创 SVG 为母版，已提供 PNG、ICNS、ICO；平台图标尚未接入安装器。内部 `scope-*` 标识与启动脚本名称保留兼容。规范和下载见 [品牌说明](../../brand/README.md)、[品牌预览](http://127.0.0.1:4190/brand/)及[资产包](../../brand/assets/brand-kit.zip)。

## Evidence on Hand

现有 MaixPy / IDE 调研、工程源码与锁定依赖、两目标构建结果、macOS 原生窗口及浏览器交互检查。当前[原生设备与图像工具验收](../../.impeccable/review/device-service/verification.md)覆盖隔离工作区中的运行 / 停止、重连、布局切换、[文件校验](../../.impeccable/review/device-service/native-file-roundtrip.json)、[正常相机](../../.impeccable/review/device-service/native-camera-simple.jpg)与[原图导出校验](../../.impeccable/review/device-service/native-export-verification.json)；14 项 Node 测试（6 项后端、8 项图像）和 100 项 Python 测试通过，browser / Electron 构建均为 0 errors。早期[基座验收](../../.impeccable/review/desktop-app/verification.md)中的“设备尚未接入”描述当时范围；`.impeccable/review/device-service/hardware-smoke.jsonl`（仅本地保留）、[六帧相机复核](../../.impeccable/review/device-service/camera-recheck.md)与[静态审查](../../.impeccable/review/device-service/code-review.md)分别保留。品牌证据见[真实蓝色界面](../../.impeccable/review/brand/ide-nodu-blue.jpg)与[品牌审阅](../../.impeccable/review/brand/finish-review.md)。AI 概念图在 `artifacts/ui-v3/`，不可作为运行截图。没有商业规模、性能基准或正式发行声明。

## Product Principles

- 保持设备连接状态、演示属性与文件保存状态可见。
- 临时运行、安装启动脚本与固件烧写各有独立含义。
- 视觉调参复制可检查的参数，粘贴与保存由用户和编辑器管理。
- 简洁与专业布局共享项目、编辑缓冲区、设备会话与当前演示状态。
- 将真实能力、合成结果和生成概念图分别说明。

## Accessibility & Inclusion

桌面端复用 Theia 的菜单、快捷键和焦点机制；自定义控件具有可见焦点、输入标签、图标按钮名称及禁用状态。右上角布局图标的无障碍名称表达目标模式，提示文字表达当前模式。合成画布旁提供文字结果与空态。当前验收不等于完整键盘或屏幕阅读器认证。

桌面工作区面向鼠标、键盘与可调整窗口；移动端不在本阶段交付范围。静态设计网站继续提供响应式阅读与减少动效样式。
