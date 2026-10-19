# Nodu · 见微 — 功能基线与验收边界

核对日期：2026-10-19。Nodu 已有可运行的 Theia / Electron IDE 基座、共享浏览器前端与 K210 设备服务。**macOS 原生 App 的设备闭环与真实图像工具已在指定真板组合验收**，包括 REPL、RAM 运行 / 停止、双布局、重连、文件往返、正常相机画面及原图导出。工具入口、离线测试、服务真板结果、原生 App 与历史 CLI / MaixPy IDE 结果分别记录。

当前硬件回归组合为野火 CAM K210 / GC2145、MaixPy 0.6.3（`d8901fd2272f000226f1c1037c1eb7c412b88e66`）。历史对照为本机官方 MaixPy IDE 0.2.5 与独立 CLI 工作流，不扩大为所有 MaixPy、OpenMV、CanMV 或其他板卡的兼容承诺。`preview/` 和生成界面图仍是历史设计演示，不能用其中的数据证明硬件能力。

## 证据与状态

| 标记 | 含义 |
| --- | --- |
| 服务真板通过 | 当前 Nodu 后端 / Python worker 通过真实设备操作；不自动等同于完整原生 UI 验收 |
| App 入口检查 | 共享前端或原生 App 的指定流程已操作；必须注明入口和已覆盖范围 |
| 原环境实测 | 历史 MaixPy IDE、独立 CLI 或板端固件操作；不代表 Nodu App 已覆盖 |
| 官方文档 / 源码证实 | 官方说明或指定固件源码存在相应实现；未必在当前板子完成专项验收 |
| 菜单存在，待验收 | 0.2.5 实际菜单或程序资源可见入口；不能宣称端到端可用 |
| 入口 / 代码已有，未验收 | 已有实现或界面，尚无完整通过证据，或被安全门禁阻止 |
| 部分实现 | 已完成指定子流程，剩余子流程明确保留；例如镜像准备通过不等于完整备份或烧写通过 |
| 固定固件命令未实现 | 固定提交的对应命令 handler 仍为 TODO；仅指该命令，不代表整个主机工具无法开发 |
| 新增规划 / 待实现 | 尚未纳入当前交付的能力；设计预览只展示使用方式 |

## 第一阶段当前状态

| 能力 | Nodu 设备服务 | App / 其他入口与限制 |
| --- | --- | --- |
| USB 端口、连接 / 断开、身份 | 真板通过；物理板型独立保存 | 原生 App 扫描 / 连接 / 重连通过，固件身份与物理 profile 分开显示；共享浏览器另有检查 |
| REPL、RAM 运行 / 停止、输出 | 真板通过，含持续输出脚本停止恢复 | 原生 REPL 输出 `42`；当前缓冲区含未保存 marker 的循环脚本运行 / STOP 通过，重连后再次执行 `42` |
| 板端目录与文件 | 隔离临时文件写入 / 读回字节一致 | 原生 UI 上传 / 下载 4,124 字节与 SHA-256 一致；覆盖选择、2 MiB 上限和启动文件保护已实现 |
| 相机 JPEG | 已接收六张正常 320 × 240 场景帧 | 原生 App 正常显示纸箱场景；倒放暗帧保留为历史记录。低速快照在普通脚本运行时暂停，持续 FPS 未测 |
| 真实图像工具 | 标准 JPEG 送达前端，PC 端分析 | 原生 ROI、RGB / 灰度直方图、PC LAB 像素 / 阈值、复制元组、缩放、PNG / JPEG 原图导出通过；不承诺板端 LAB 逐值一致 |
| 固件准备、备份、烧写 | 部分实现；官方镜像准备/校验通过，当前完整备份未完成 | 原生 App 已核镜像 SHA/计划范围，并验证容量缺失时拒绝备份认证、禁用实际烧写；没有本轮 App / 服务真机烧写成功记录 |
| 简洁 / 专业模式 | 同一设备模型与后端服务 | 原生运行中互切保留会话、运行状态与 dirty 文本；真实图像 ROI / 阈值状态跨布局与新帧保留 |
| 本地合成演示 | 独立演示状态与日志 | 预设 LAB 元数据筛选，不是板端视觉算法或 K210 仿真 |
| STM32 / ESP32、编译 / 库包 | 未纳入当前通过项 | 等待各自实现与验收，不据菜单或在开发代码预填通过 |
| 持久应用部署、串口绘图器、完整语言服务 | 未纳入当前通过项 | RAM 运行与文件传输不等于已验收启动部署；设备文本日志不等于串口绘图器，基础高亮不等于补全 / 调试服务 |
| Windows | 有配置和启动脚本 | 尚未实机验收；签名安装包与自动更新未交付 |

完整入口见[原生设备与图像工具验收](../../.impeccable/review/device-service/verification.md)，直接证据包括[文件往返](../../.impeccable/review/device-service/native-file-roundtrip.json)、[正常相机](../../.impeccable/review/device-service/native-camera-simple.jpg)、[ROI](../../.impeccable/review/device-service/native-image-roi-simple.jpg)、[阈值与复制](../../.impeccable/review/device-service/native-image-threshold-copy.jpg)和[原图导出校验](../../.impeccable/review/device-service/native-export-verification.json)。服务与六帧相机证据见`.impeccable/review/device-service/hardware-smoke.jsonl`（仅本地保留）、[相机复核](../../.impeccable/review/device-service/camera-recheck.md)。`camera-real.jpg`、`app-camera.jpg` 与 `camera-diagnosis.txt` 保留的是历史暗帧，不是当前正常相机结论。

原生图像验收包含 ROI `(54, 45, 195, 119)` 的 23,205 像素，L 下界 50 时命中 10,711 像素，元组复制后实际粘贴，适应 / 100% / 200% 缩放，以及新帧 33 → 43 与布局切换后的状态保留。导出 JPEG 为 3,397 字节，SHA-256 `57f63451654ebc4d5a32758089744dae78b68f160559f213d1105d7975d12db4` 与 App REPL 算得的板端最后 JPEG 一致；PNG 也导出真实原图。PC LAB 基于 JPEG 的 sRGB / D65 浮点计算，不等于板端 RGB565 / LAB 查表。

14 项 Node 测试（6 项后端、8 项图像）与 33 项 Python 测试通过，browser / Electron 构建均为 0 errors。静态审查、模拟测试及历史 CLI 烧录均不能替代完整当前备份和当前容量认证。历史启动日志 `EF/17` 的含义与限制见[容量证据边界](device-capacity-status.md)，当前烧写门禁保持关闭。

## 旧功能到新界面的映射

下表保留旧 IDE 的对照菜单和缺项。Nodu 当前通过状态以上表为准，不能把旧菜单存在或历史 CLI 成功直接转写为 App 已实现。

| 能力 | 历史 MaixPy IDE / CLI 基线 | Nodu 界面落点 | 当前边界 |
| --- | --- | --- | --- |
| Python 编辑 | 0.2.5 有新建、打开、保存、编辑脚本及多文档切换 | 工作台 · 代码区 | 原环境实测；项目索引、补全和重构不应自动视为旧版已验收能力 |
| 连接 / 断开 | 旧 IDE 能连接当前 MaixPy 0.6.3 板子 | 工作台 · 设备状态条 | Nodu 服务与原生 App 连接 / 重连通过 |
| 运行 / 停止 | 旧 IDE 已运行并停止摄像头脚本 | 工作台 · 主操作区 | Nodu 原生 App RAM 运行 / 停止通过，包含未保存内容；保存为启动程序是独立操作 |
| 实时图像 | 旧 IDE 已显示 320 × 240 摄像头画面，观测约 9 FPS | 工作台 · 图像区 | Nodu 原生正常 JPEG 预览通过；当前为低速快照，旧 FPS 不能作为 Nodu 性能指标 |
| 帧缓冲控制 | 0.2.5 主界面可见缩放、禁用预览与录制入口 | 图像区 · 视图工具栏 | Nodu 适应 / 100% / 200% 与 PNG / JPEG 原图导出通过；录制未纳入通过项 |
| 图像统计 | 0.2.5 可见 RGB、灰度、LAB、YUV 直方图和统计量 | 视觉实验室 · 图像分析 | Nodu 原生 RGB / 灰度直方图、ROI 与 PC LAB 像素通过；未覆盖旧 LAB / YUV 直方图等全部统计项 |
| 阈值编辑 | 0.2.5 机器视觉菜单有阈值编辑器 | 视觉实验室 · 颜色阈值 | Nodu 原生真实 JPEG 阈值掩码、命中计数与元组复制通过；不改写编辑器，不承诺板端算法逐值一致 |
| 关键点编辑 | 0.2.5 机器视觉菜单有关键点编辑器 | 视觉实验室 · 特征工具 | Nodu 编辑工具未实现；固定固件保存描述子/模板的调试命令仍为 TODO，不能把菜单存在视为该命令已支持 |
| 标记生成 | 0.2.5 有 AprilTag、二维码、DataMatrix、条码生成器 | 视觉实验室 · 标记工具 | 菜单存在，待验收；不可把本次二维码自测等同于所有生成器验收 |
| 视频工具 | 0.2.5 有转换视频、播放视频菜单 | 视觉实验室 · 素材与回放 | 菜单存在，待验收；支持格式和编码能力尚未建立基线 |
| 终端与日志 | 旧 IDE 有串行终端及新终端入口；实机运行有日志输出 | 工作台 · 终端面板 | Nodu 本机终端与服务 stdout/stderr 已检查；本机终端、设备 REPL、演示日志分别标记 |
| 文件发送 | 0.2.5 有发送文件到开发板入口；固件有文件保存、SHA-256 校验及状态命令 | 项目与部署 · 设备文件 | Nodu 原生 UI 上传 / 下载与 SHA-256 校验通过；旧 GUI 完整文件管理不补记通过 |
| 开机程序 | 0.2.5 菜单为“将打开的脚本保存到开发板的 boot.py” | 项目与部署 · 启动配置 | 菜单存在；此前实际部署使用 `/flash/main.py` 和 `/sd/main.py`，须按固件和存储路径处理，不能盲目统一为一个文件名 |
| 固件 / 串口 / 帧率 | 0.2.5 主界面显示固件版本、串口及 FPS | 工作台 · 设备状态条 | 原环境实测；新版应同时展示物理板型与固件身份 |
| 多板型选择 | 0.2.5 有 9 个连接选项，部分不同产品共用连接策略 | 设备中心 · 连接配置 | 菜单和本机静态代码证实；选项存在不代表各板型已逐一实测 |
| 硬件引脚配置 | MaixPy 的 `config.json` 用于 LCD、摄像头和 SD 等资源适配 | 设备中心 · 板卡配置 | 官方文档和当前板子适配实测；与 IDE 连接选项分层 |
| 固件烧录 | 历史独立 CLI 已通过 kflash 烧录 | 项目与部署 · 固件 | Nodu UI / 代码已有，实际容量门禁阻止；完整新备份未完成，本轮未真机烧写 |
| 模型入口 | 0.2.5 菜单有“CNN 网络库” | 模型与资源 · 模型列表 | 仅确认菜单存在；未确认当前可访问内容、格式或与 K210 的兼容程度 |
| 色块 / 二维码算法 | 历史验证时板端运行绿色色块与二维码检测循环；固定图像自测检出绿色块并解码 `K210-MAIXPY-OK` | 视觉实验室 · 示例与验证 | 原环境实测；未证明摄像头现场识别到了实体二维码或绿色目标 |
| LCD / 相机 Demo | LCD、相机、绿色色块、二维码、固定图像自测均已运行；重启后 3 秒相机预览通过 | 工作台 · 示例项目 | 原环境实测；GC2145 使用已适配的初始化辅助代码，不是任意默认脚本即插即用 |

## 多板型支持的准确边界

0.2.5 的 9 个菜单名称为：

1. `Sipeed Maix Dock`
2. `Sipeed Maix Bit( with Mic )`
3. `Sipeed Maix Bit( old )`
4. `Sipeed Maixduino`
5. `Sipeed Maix Go( open-ec & new CMSIS_DAP )`
6. `Sipeed Maix Go( Old CMSIS-DAP )`
7. `M5StickV`
8. `T-Watch`
9. `Kendryte KD233`

本机 0.2.5 的静态检查显示，选板回调保存本地板型 ID，连接阶段依据 ID 使用不同 DTR / RTS 复位策略，再进入共用 IDE 协议。共用握手包含等待 REPL，并通过 `UART.repl_uart().init(..., ide=True)` 进入 IDE 模式。官方文档还要求 Amigo、Cube 选择 Maixduino，说明菜单项和物理产品并非一一对应。

Nodu 把连接策略、固件协议、硬件配置、功能能力分别保存。当前野火板可共享某种连接策略，同时拥有独立的 GC2145、LCD 和 SD 配置。界面不得因固件返回 `Sipeed_M1` 就把物理野火板改认成 Sipeed 产品。指定固件的 `ARCH_STR` 实现中 UID 仍为占位值，不能将其作为可靠的唯一设备身份。

## 新增规划在预览中的表达

| 新能力 | 计划提供的体验 | 预览必须明确的边界 |
| --- | --- | --- |
| 设备自动发现 | 端口扫描已接入；更细的板卡候选、匹配依据仍属后续能力 | 扫描出的端口不等于自动识别物理板型；当前仍需用户选择 profile |
| 统一项目 | 将代码、模型、板卡配置、素材和依赖放入可迁移项目 | 当前仅为项目结构与交互预览 |
| 模拟运行 | 使用图片 / 视频输入、虚拟屏幕、虚拟 GPIO 和串口验证程序逻辑 | 标注“模拟演示”；不能宣称原版 MaixPy 固件或完整 K210 已被仿真 |
| 模型试验 | 检查模型格式、输入规格、预处理与设备兼容性；对照模拟与真板输出 | 属于规划；nncase 的模型级模拟不等于完整芯片模拟，版本必须与 kmodel / 固件匹配 |
| AI 辅助 | 结合当前代码、日志和板卡资料解释错误、提出修改建议 | 不展示虚构的模型调用成功；生成代码和执行部署是不同操作 |
| 部署工作流 | 固件准备、备份和烧写已有入口 / 代码 | 当前会话容量未认证，烧写被门禁阻止；完整当前备份、真机写入与恢复未验收 |
| 搭芯联动 | 共享项目、板卡描述和运行结果；在模拟设备与 USB 真板间切换 | 协议与连接界面规划，不表示已接入搭芯账户、工程或运行服务 |
| 兼容性面板 | 按板型、固件、外设、模型格式展示已验证 / 部分支持 / 未验证 | 只展示设计样例，不能使用未经实测的“100% 支持”标识 |

历史设计网站 / AI 界面图继续标明“设计预览 · 数据为演示”。运行中的 Nodu App 应显示实际连接与操作结果，并把“本地合成演示”“运行到设备”和固件准备 / 烧写状态分别标注，不能再统一写为“硬件功能尚未接入”。

受限的 OpenMV Qt `openmvpluginprotocol.cpp` 不复制、翻译或改编进入项目；MIT 固件端协议资料与依赖复用依据见[来源与许可](device-reuse.md)。ktool 的混合许可容量探针未加入产品，不能借此声称容量已实测或解除门禁。

## 完整功能覆盖的验收原则

- 冻结对照版本、固件提交、板型和外设组合，逐条登记输入、操作、预期结果与证据。
- 将“菜单可见”“协议存在”“真板通过”分开记录；未实现的旧菜单不应被算作现成功能。
- 同时验收正常路径与停止、重连、启动脚本干扰、文件校验失败和恢复路径。
- 当前优先回归组合为野火 CAM K210、MaixPy 0.6.3、GC2145；本次已遇到的 CH340 复位、串口独占、SPIFFS 目录限制和 Flash / SD 路径差异应进入测试清单。
- 模拟结果仅证明其覆盖范围内的逻辑；真实帧率、内存、摄像头驱动、引脚、电气与时序须由真板验收。

## 官方资料与本地证据

以下链接为此前已核实来源，本文件未开展新的网络研究。

- [MaixPy IDE 安装与使用](https://wiki.sipeed.com/soft/maixpy/zh/get_started/env_maixpyide.html)：编辑、执行、预览、发送文件、选板与串口占用说明。
- [MaixPy-v1 板卡配置说明](https://github.com/sipeed/MaixPy-v1/blob/master/components/boards/config/readme.md)：`config.json` 与 LCD、Sensor、SDCard 资源适配。
- [当前固件对应的 IDE 协议声明](https://github.com/sipeed/MaixPy-v1/blob/d8901fd22/components/micropython/port/src/omv/include/ide_dbg.h)：命令集与 `CONFIG_MAIXPY_IDE_SUPPORT`。
- [当前固件对应的 IDE 协议实现](https://github.com/sipeed/MaixPy-v1/blob/d8901fd22/components/micropython/port/src/omv/ide_dbg.c)：脚本、图像、文件校验、状态、软件复位；模板 / 描述子保存仍为 TODO。
- [MaixPy-v1 官方示例](https://github.com/sipeed/MaixPy-v1_scripts)：板端功能例程；示例数量不代表已完成跨板验收。
- [MaixPy-v1 发布说明](https://github.com/sipeed/MaixPy-v1/releases)：版本差异和 kmodel 支持范围。
- [kflash.py](https://github.com/vowstar/kflash.py)：当前使用的独立 K210 烧录工具。
- [nncase 0.2.0-beta4 使用说明](https://github.com/kendryte/nncase/blob/v0.2.0-beta4/docs/USAGE_ZH.md)：K210 `kmodel` 编译与 PC 模拟推理，不是板级固件仿真。
- [Renode K210 平台描述](https://github.com/renode/renode/blob/master/platforms/cpus/kendryte_k210.repl)：已有 CPU、内存、UART 和中断基础模型；不能据此声称完整 K210 视觉外设已支持。
- [MaixVision 使用文档](https://wiki.sipeed.com/maixpy/doc/zh/basic/maixvision.html)：现代 MaixCAM 生态的参考产品，不能把其功能归入旧 MaixPy IDE 0.2.5 的验收基线。

本地可复核证据包括：

- `.impeccable/review/device-service/verification.md`：本轮隔离原生 App 的设备与真实图像工具验收入口。
- `.impeccable/review/device-service/native-file-roundtrip.json`、`native-camera-simple.jpg`、`native-image-roi-simple.jpg`、`native-image-threshold-copy.jpg` 与 `native-export-verification.json`：原生文件校验、正常画面、图像工具及原图导出证据。
- `.impeccable/review/device-service/hardware-smoke.jsonl`：Nodu 服务的真实连接、REPL、RAM 运行 / 停止和临时文件操作记录。
- `.impeccable/review/device-service/camera-recheck.md` 及同目录六张 `camera-recheck-2026-10-18T18-35-09-333Z-*.jpg`：本轮正常相机复核；没有改驱动、配置或启动文件。
- `.impeccable/review/device-service/code-review.md`：静态审查结论；不代替真机烧写 / 恢复验收。
- `/Applications/MaixPy IDE.app/Contents/PlugIns/libOpenMV.dylib`：官方 0.2.5 安装包中的菜单资源、符号与连接代码；此前只读静态检查。
- `/opt/homebrew/share/maixpy-k210/README.md`：现有系统级环境、板卡适配和恢复说明。
- `/opt/homebrew/share/maixpy-k210/status.json`：此前实机部署结果汇总。
- `/opt/homebrew/share/maixpy-k210/logs/demo-results.json`：五类 Demo 的运行结果。
- `/opt/homebrew/share/maixpy-k210/logs/maixpy-ide-camera-preview.png`：旧 IDE 摄像头预览截图。
- `/opt/homebrew/share/maixpy-k210/logs/startup-after-reset.log`：硬件重启后的启动 Demo 验证。

## 网站四类能力短文案

用于设计预览的愿景文案，需与页面的预览状态提示同时出现：

- **编写与运行**：代码、画面与日志，在同一个工作台相遇。
- **观察与调试**：看见每一帧，找准颜色、区域与识别参数。
- **设备与部署**：从板卡配置到程序上板，每一步都有清楚的去向。
- **模拟与联动**：先验证想法，再连接真板，让项目延伸到搭芯。
