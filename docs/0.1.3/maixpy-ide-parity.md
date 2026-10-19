# Nodu 0.1.3 — MaixPy IDE 0.2.5 功能对照清单

日期：2026-10-19。状态：**已确认**（2026-10-19）。实施见 [PLAN.md](PLAN.md)。

## 依据与边界

项目规则（2026-10-19 更新）：Nodu 是开源项目，MaixPy IDE 相关功能**一律参考原版源码重写**，只使用许可允许的版本。

### 原版源码基线

Sipeed 没有公开 MaixPy IDE 的独立源码仓库（2026-10-19 检索 GitHub sipeed 组织与全站，均未找到）；[MaixPy-v1 v0.3.0 发布说明](https://github.com/sipeed/MaixPy-v1/releases)称它是改过的 OpenMV IDE。能公开取得的最近祖先如下：

| 基线 | 依据 | 许可 | 用法 |
| --- | --- | --- | --- |
| **[openmv/qt-creator @ af179e44](https://github.com/openmv/qt-creator/tree/af179e44cddf396a5ab618792d71e9de5cc67032/src/plugins/openmv)**（`openmv` 分支，2020-07-29） | 本机 MaixPy IDE 0.2.5 资源日期为 2020-07-30，二进制里的版权串“(C) 2016 OpenMV, LLC”与该提交的 `OpenMV.json.in` 一致；插件目录共 11,771 行 C++ | `OpenMV.json.in` 声明 **MIT**；逐文件检索没有“personal benefit / monetary gain”限制条款 | **主参考**：重写时保留 MIT 版权与许可原文，写进 THIRD-PARTY-NOTICES |
| 同提交 `tools/tag*.c` | AprilTag 码族表 | BSD-2（Univ. of Michigan，允许不受限地使用码图） | 可以按原许可移植数据表 |
| 同提交 `qcustomplot/` | 直方图绘图库 | GPL-3.0 | **不移植**，由 Nodu 自绘 |
| [MaixPy-v1 `ide_dbg.c` / `ide_dbg.h` @ d8901fd](https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/ide_dbg.c) | 固件端 IDE 协议：命令、帧格式、保存 boot.py、复位 | MIT | 协议的权威定义，以固件为准 |
| 本机 `/Applications/MaixPy IDE.app` 0.2.5 | Sipeed 的改动没有公开（选板、IDE 模式握手、调速）：靠动作 ID、界面字符串和实测行为复原 | 二进制，只观察行为 | 补出与 af179e44 的差异 |
| [MaixPy IDE 文档](https://wiki.sipeed.com/soft/maixpy/zh/get_started/env_maixpyide.html)、[0.2.5 readme](https://dl.sipeed.com/MAIX/MaixPy/ide/v0.2.5/readme.txt) | 官方流程，固件门槛 ≥ 0.4.0_44 | 公开文档 | 验收依据 |

**禁用范围**：2023 年以后的 `openmv-qtc-14.0.2` / `openmv-qtc-20.0.2` 分支，以及 openmv 主线的新文件。这些文件头加了“仅个人受益、不得商业用途”条款，0.1.1 的禁令继续对它们有效。每个移植文件都要在 NOTICE 里登记来源提交和路径，CI 增加条款扫描。

**原版证据**：辅助功能权限已开，真实菜单层级和快捷键见 [evidence/maixpy-ide-0.2.5-menus.txt](evidence/maixpy-ide-0.2.5-menus.txt)，主窗口控件见 [evidence/maixpy-ide-0.2.5-main-window.txt](evidence/maixpy-ide-0.2.5-main-window.txt)。

## 关键架构差异（先决定）

MaixPy IDE 连接后通过 `UART.repl_uart().init(..., ide=True)` 进入 **IDE 二进制协议模式**：运行 / 停止（`SCRIPT_EXEC 0x05` / `SCRIPT_STOP 0x06`）、帧缓冲（`FRAME_SIZE 0x81` / `FRAME_DUMP 0x82`，任何脚本的 `sensor.snapshot()` 都自动送帧）、标准输出（`TX_BUF_LEN 0x8E` / `TX_BUF 0x8F`）、保存 boot.py（`FILE_SAVE 0x07`）、复位（`SYS_RESET 0x0C`）、帧缓冲开关（`FB_ENABLE 0x0D`）、传感器属性（`ATTR_WRITE 0x0B`）。

Nodu 0.1.1 / 0.1.2 有意使用 **raw REPL**。原因：固件进入 IDE 模式时会写 `/flash/ide_mode.conf`（`ide_dbg_init2`，ide_dbg.c:166），退出 IDE 模式会软重启（见 `nodu_device_worker.py` 文件头）。因此相机目前要靠板端 helper 低速快照，不能自动显示用户脚本里的帧。

**要做到 1:1，帧缓冲、运行 / 停止、输出这几项都必须切到 IDE 协议**，代价是每次连接都会像原版一样写 `/flash/ide_mode.conf`。

## 对照表

图例：✅ 已有，◐ 部分，✗ 没有。建议列：**必做** = 1:1 核心；**建议** = 原版有，价值中等；**不适用** = 原版残留的 OpenMV 专属功能、固件未实现，或对 K210 无效。

### A 连接与设备

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| A1 | 选择开发板 9 种：Maix Dock / Bit(mic) / Bit(old) / Maixduino / Go(open-ec) / Go(old) / M5StickV / T-Watch / KD233，各自用不同的 DTR / RTS 复位时序 | `OpenMV.Board*`、`OnBoard*Selected`；[0.1.1 功能基线](../0.1.1/feature-baseline.md#多板型支持的准确边界) | ◐ 只有野火 GC2145 和通用 K210 两种 | 必做：9 种全列，另保留野火等物理板型；复位时序必须逐板实测 |
| A2 | 串口选择、连接（“Connecting… 30 s”）、断开；没有板子时提示“No Maix Board found!”；IDE 模式无应答时提示“board ide mode no ack” | 字符串 | ✅ 扫描、连接、断开 | 必做：补齐无板和无应答两种提示 |
| A3 | 连接后提高波特率（“change baudrate”，依据 `UART.repl_uart().init`） | 字符串、v0.3.0 发布说明 | ◐ 只在内部备份时临时调速 | 必做：实测原版实际用的速率后对齐 |
| A4 | 状态栏显示固件版本 `x.y.z`、`Serial Port - 端口 - 速率 BPS`、FPS | 字符串 | ◐ 设备详情里有固件版本，没有 FPS | 必做 |
| A5 | 软复位（Soft reset，`SYS_RESET`） | 字符串、协议 | ✗ | 必做 |
| A6 | 检查新版本、资源包更新（示例、文档、固件） | “Update Available”“Package Update” | ✗ | 建议：可以换成 Nodu 自己的更新源 |

### B 运行与调试

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| B1 | 运行当前编辑器脚本（Start，`SCRIPT_EXEC`） | 动作 `OpenMV.Start` | ✅ RAM 运行（raw REPL） | 必做：切到 IDE 协议 |
| B2 | 停止（`SCRIPT_STOP`，抛出“IDE interrupt”，这个异常不当作错误显示） | 字符串和协议 | ✅（raw REPL 中断） | 必做 |
| B3 | 报错时解析 `File "...", line N`，跳到编辑器对应行并高亮 | 原版带有这个正则 | ✗ | 必做 |
| B4 | 脚本输出进串行终端面板（`TX_BUF`） | 协议 | ✅ 控制台 | 必做：改走 IDE 协议 |
| B5 | 查询脚本是否在运行（`SCRIPT_RUNNING`），工具栏状态随之更新 | 协议 | ✅ | 必做 |

### C 帧缓冲

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| C1 | 任何正在运行的脚本，其 `sensor.snapshot()` 帧都会自动显示（旧 IDE 实测约 9 FPS） | 协议 `FRAME_SIZE` / `FRAME_DUMP` | ◐ 需要先启动板端 helper，低速快照 | **必做，依赖架构决定** |
| C2 | 关闭帧缓冲以获得最高性能（`FB_ENABLE`） | 字符串 | ✗ | 必做 |
| C3 | 用 JPEG 压缩帧缓冲以提高性能 | 字符串 | — | 待实测：这版固件只送 JPEG，这个选项可能无效 |
| C4 | 缩放 | 0.1.1 基线 | ✅ 适配 / 100% / 200% | 已有 |
| C5 | 录制帧缓冲成视频（Video Recorder，计时、大小、FPS） | 字符串 | ✗ | 建议 |
| C6 | 保存图像到电脑，可以只存选区 | 字符串 | ◐ 能存整张原图，不能只存选区 | 必做：补选区 |
| C7 | 显示分辨率、ROI 和像素数（`Res (w,h) - ROI (x,y,w,h) - Pixels`） | 字符串 | ✅ | 已有 |
| C8 | 显示 FPS（并注明可能和相机 FPS 不同） | 字符串 | ✗ | 必做 |
| C9 | 把模板 / 描述子保存到板子 | 字符串；固件 `TEMPLATE_SAVE` / `DESCRIPTOR_SAVE` 是 **TODO** | ✗ | 不适用（固件没实现） |

### D 直方图

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| D1 | 四种色彩空间：RGB、灰度、LAB、YUV | 字符串 | ◐ 只有 RGB 和灰度 | 必做：补 LAB 和 YUV |
| D2 | 每个通道的统计：Mean / Median / Mode / StDev / Min / Max / LQ / UQ | `C0MeanLabel` 等控件名 | ✗ | 必做 |
| D3 | 统计范围可以是全图或 ROI | 字符串 | ✅ | 已有 |

### E 机器视觉工具

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| E1 | 阈值编辑器：灰度和 LAB 两种；源图可以取帧缓冲或图片文件；用二值预览，白色表示命中；最小 / 最大滑块 | 字符串 | ◐ 有 LAB 蒙版；没有灰度模式，不能从文件取源图 | 必做 |
| E2 | 阈值编辑器关闭时**把元组写回编辑器里选中的位置**（“The selected threshold tuple will be updated on close”） | 字符串 | ✗ Nodu 的规则是只复制、不改编辑器 | **需要决定** |
| E3 | 关键点编辑器：打开、编辑、合并 `.orb` 关键点文件，删除离群点 | 字符串 | ✗ | 建议 |
| E4 | AprilTag 生成器：TAG16H5 / 25H7 / 25H9 / 36H10 / 36H11 / ARKTOOLKIT，批量生成，可以在图上标出族名和 ID | 字符串 | ✗ | 必做 |
| E5 | 二维码、DataMatrix、条码生成器 | 动作 ID | ✗ | 待实测：OpenMV 原版是打开网页 |

### F 板端文件与部署

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| F1 | 把当前脚本保存到板子的 `boot.py`（`FILE_SAVE`），可选“去掉注释、空格转 Tab” | 字符串、协议 | ✗ 0.1.1 起禁止写 boot.py / main.py | **需要决定**：涉及写启动文件 |
| F3 | 发送文件到开发板（工具菜单；选本地文件，用 IDE 协议 `FILE_SAVE` 发送，带 SHA-256 头） | 菜单实测、[反汇编](evidence/original-private-params.md#5-保存文件--bootpyopenmvpluginiofilesave0x5fa80) | ◐ Nodu 有自己的上传 | 必做，按原版协议 |
| F2 | 通用上传、下载、列目录 | — | ✅ Nodu 自有 | 保留（原版没有，是 Nodu 新增） |

### G 终端

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| G1 | 独立串口终端窗口（可以填波特率，Ctrl+R） | `OpenMV.OpenTermnial`、`Terminal.Ctrl.R` | ◐ 控制台加 REPL（只能用已连接的设备） | 必做：独立串口终端，可以选端口和速率 |
| G2 | TCP / UDP 客户端或服务端终端 | 字符串 | ✗ | 建议 |
| G3 | 命令行参数 `-open_serial_terminal` 等 | 字符串 | ✗ | 不适用（建议） |

### H 视频工具

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| H1 | 转换视频、播放视频，靠内置的 ffmpeg / ffplay（安装包里占 235 MB） | 字符串、资源目录 | ✗ | **需要决定**：要不要打包 ffmpeg，以及它的许可 |

### I 编辑器、示例与文档

| # | MaixPy IDE 0.2.5 | 证据 | Nodu 0.1.2 | 建议 |
| --- | --- | --- | --- | --- |
| I1 | Python 高亮、查找、最近文件、撤销 / 重做 | Qt Creator 核心 | ✅ Theia | 已有 |
| I2 | 根据内置 HTML 文档做 API 补全和悬停提示 | 原版带有解析文档 HTML 的正则 | ✗ 只有基础高亮 | 必做 |
| I3 | 示例菜单：内置示例、“Examples on github repo”、“More examples” | `OpenMV.Examples`、`OpenOnlineExamples` | ◐ 两个本地示例 | 必做：用 MaixPy-v1_scripts 做内置示例库 |
| I4 | 文档目录（`~/Documents/MaixPy`），新建文件模板（`# Untitled - By: 用户 - 日期`，内容是 hello world 相机循环） | 字符串 | ✗ | 必做 |
| I5 | 帮助菜单：MaixPy 文档、论坛、关于 | `OpenMV.Docs`、`Forums`、`About` | ✗ | 必做 |

### J 原版残留的 OpenMV 专属功能（建议不复刻）

| # | 功能 | 原因 |
| --- | --- | --- |
| J1 | 注册 OpenMV 相机、Board Key | OpenMV 商业注册，和 K210 无关 |
| J2 | DFU / bootloader 烧写、pydfu、关联驱动器、擦除内部文件系统 | 只适用于 STM32 OpenMV；K210 用 kflash（Nodu 已有，但有门禁） |
| J3 | OpenMV 相机设置、WiFi 扩展板（`openmv.config`） | OpenMV 硬件专属 |
| J4 | CNN 网络库（`.network`：chars74k / cifar10 / lenet / smile） | OpenMV 的 CNN 格式，K210 用 kmodel，没法运行 |

## Rust 底层可行性

目标平台：**macOS 15+**（Apple Silicon、Intel）和 **Windows 10**（x64）。

| 方面 | 结论 |
| --- | --- |
| 形态 | 独立的 Rust 侧车进程 `nodu-device`，通过 stdio JSON-lines 通信，沿用现有 `nodu-device-protocol.ts`，由 Node 后端拉起；**不做** napi 原生模块 |
| 为什么用侧车 | 崩溃隔离；没有 Electron / Node ABI 重建问题（现在 browser / electron 切换要重建原生依赖）；不再要求用户机器上有 `~/.nodu/python` |
| 串口 | `serialport` crate（MPL-2.0，与 MIT 项目兼容）支持 macOS `/dev/cu.*` 和 Windows `COMx`，可以控制 DTR / RTS（A1 复位时序需要）；Windows 10 需要 CH340 / CP210x 驱动 |
| 协议 | IDE 二进制协议（6 字节命令头、定长应答、FRAME_DUMP 按 `FRAME_SIZE` 给的长度读取）适合用 Rust 做有界解析：长度上限、超时、取消都放进类型里。raw REPL 和文件传输一起迁移 |
| 构建 | `aarch64-apple-darwin`、`x86_64-apple-darwin`、`x86_64-pc-windows-msvc` 三个目标；macOS 要对侧车签名并公证，Windows 要 Authenticode。这些和安装器一起列为 0.1.3 之后的分发项 |
| 安全收益（实事求是） | Python 本身也内存安全，Rust 的主要收益是：依赖更少、供应链更小、单个可签名二进制、协议解析的边界在编译期受约束、1.5 Mbps 帧流更省资源。它不能代替审查与测试 |
| 风险 | **烧写 / Flash 探针路径**带有冻结摘要和多轮审查；按已确认的决定也迁到 Rust，先用现有 Python 实现做逐字节差分测试，重新审查后再删除 Python 版本（[PLAN 阶段 6](PLAN.md)） |

分层：Rust 负责全部设备 I/O（含 kflash）和图像计算（同时编译为 WASM）；TypeScript 前端只负责界面；ffmpeg 内置，作为独立的外部进程调用。

## 确认结果（2026-10-19）

- 架构：切到 IDE 协议，照原版写 `/flash/ide_mode.conf`。
- E2 阈值写回编辑器、F1 保存 boot.py（加确认）：按原版做。
- H1：内置 ffmpeg（LGPL 构建）。
- Rust：能用 Rust 的都用 Rust，包括烧写路径（先做差分测试和重新审查）。
- 原版菜单里能看到的都做，包括 CNN 网络库，以及按原版打开网页的 QR / DataMatrix / 条码生成器；看不到的 OpenMV 残留（J1–J3、数据集编辑器、Edge Impulse）不做。建议项 G2、G3、E3、C5、A6 都按原版做。
- 不保留旧版兼容。
