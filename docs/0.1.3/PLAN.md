# Nodu 0.1.3 实施计划 — MaixPy IDE 0.2.5 功能 1:1 复刻

日期：2026-10-19。状态：**实施中**：阶段 0 证据与阶段 1 Rust 开发检查点已落地，阶段门禁尚未全部通过。功能对照见 [maixpy-ide-parity.md](maixpy-ide-parity.md)，阶段 1 验证见 [evidence/phase-1-validation.md](evidence/phase-1-validation.md)。

## 0. 已确认的决定

| 决定 | 内容 |
| --- | --- |
| 复刻原则 | 功能与原版 MaixPy IDE 0.2.5 一致，**参考原版源码重写**，不照抄 Qt 代码 |
| 源码基线 | `openmv/qt-creator@af179e44`（MIT，2020-07-29，MaixPy IDE 的最近公开祖先）+ `MaixPy-v1@d8901fd`（MIT / Apache-2.0）+ `kflash.py@550828c`（MIT）+ `MaixPy-v1_scripts`（MIT）。Sipeed 没有公开的改动部分，以本机 0.2.5 二进制的字符串和实测行为为准 |
| 禁用来源 | `openmv-qtc-14.0.2` / `20.0.2` 等 2023 年后的分支（非商用条款）；`qcustomplot`（GPL-3.0，不移植） |
| 底层语言 | **能用 Rust 的都用 Rust**：设备 I/O、协议、REPL、文件、烧写、图像计算、媒体编排。TypeScript 只负责界面 |
| 原版行为照做 | 连接时进入 IDE 模式（会写 `/flash/ide_mode.conf`）；阈值编辑器关闭时写回编辑器；保存 boot.py（执行前确认）；内置 ffmpeg 的视频工具；CNN 网络库照搬原版；QR / DataMatrix / 条码生成器按原版打开搜索网页 |
| 不复刻 | 原版菜单里看不到的 OpenMV 残留：注册、Board Key、DFU / bootloader、OpenMV 相机设置 / WiFi、数据集编辑器、Edge Impulse |
| 平台 | macOS 15+（arm64、x64），Windows 10（x64） |
| 兼容 | 最终不保留旧兼容架构；迁移期间暂存 Python 对照实现，删除门禁见阶段 1 与阶段 6。 |

参考仓库已克隆到 `/Users/wangwei/Model/nodu-refs/`（仓库外，只读）：`openmv-qt-creator`（af179e4，只取插件目录）、`MaixPy-v1`（d8901fd，稀疏路径见 [references.md](references.md)）、`MaixPy-v1_scripts`、`MaixPy_Doc_Zh_Cn_Backup`、`kflash.py`（550828c）。原版的菜单和主窗口控件已导出到 [evidence/](evidence/)。

## 1. 目标架构

```
Theia 前端 (TS/React)  ──RPC──  Node 后端 (TS, 只做进程管理)  ──stdio JSON-lines──  nodu-device (Rust)
     │                                                                                 ├─ 串口 / IDE 协议 / REPL / 文件
     └─ nodu-imaging.wasm (Rust→WASM：LAB/YUV 表、直方图统计、阈值二值、AprilTag)           ├─ kflash 烧写与 Flash 探针
                                                                                        └─ 拉起 ffmpeg / ffplay（内置）
```

`desktop/native/` 下建 Cargo workspace：

| crate | 职责 | 主要参考 |
| --- | --- | --- |
| `nodu-protocol` | JSON-RPC 请求、事件、错误类型；用 `ts-rs` 生成 TS 类型，替代手写的 `nodu-device-protocol.ts` | 现有协议 |
| `nodu-serial` | 枚举端口（含 USB VID/PID）、独占打开、波特率、按板型执行 DTR / RTS 复位时序 | `kflash.py` 板型复位、`serialport` crate |
| `nodu-maix-ide` | IDE 二进制协议主机端：版本、架构串、帧尺寸 / 帧数据、脚本执行 / 停止 / 状态、TX 缓冲、保存文件、复位、帧缓冲开关、传感器属性；定时轮询调度 | `ide_dbg.c/h`，`openmvpluginio.cpp`，`openmvpluginserialport.cpp` |
| `nodu-maix-connect` | 连接握手：等待 `[MaixPy] init end` / `>>>` → 发送 `repl.init(%d, 8, None, 1, read_buf_len=%d, ide=True)` → 等待 IDE 模式稳定 → 读版本；处理取消、30 s 超时、无应答和校验失败重试 | 0.2.5 二进制字符串，`machine_uart.c`，`openmvplugin.cpp` 连接流程 |
| `nodu-repl` | raw REPL、板端文件管理（Nodu 增强）。原版的“发送文件到开发板”和“保存 boot.py”都走 `nodu-maix-ide` 的 FILE_SAVE | `ide_dbg.c` |
| `nodu-imaging` | RGB565→LAB / YUV 查表（`lab_tab.c` / `yuv_tab.c`，和固件同一张表，终结“PC LAB 近似”）、四种色彩空间直方图与 8 项统计、阈值二值预览、`OMV IMG STR V1.0` 录像格式、AprilTag 码族渲染；同时编译为原生库和 WASM | `histogram/*`，`tools/thresholdeditor.cpp`，`tools/tag*.c`，`openmvpluginfb.cpp` |
| `nodu-kflash` | K210 ISP（SLIP、ROM、stub、dan 等复位），镜像校验，备份、身份读取、容量门禁、烧写、回读；现有安全门禁一条不少 | `kflash.py`，现有 Python `nodu_firmware.py` / `nodu_flash_protocol.py` / `nodu_flash_probe.py` |
| `nodu-media` | 编排 ffmpeg / ffplay：转换视频、播放视频、录像转码；查询输入格式 | `tools/videotools.cpp` |
| `nodu-device` (bin) | stdio 服务进程：单一串口所有者，请求串行化，事件推送 | 现有 worker 语义 |
| `nodu-mockboard` (dev) | 按 `ide_dbg.c` 状态机模拟固件，支持 raw REPL、IDE 模式、录制的 JPEG 帧，供集成测试 | 固件源码 |

Rust 工程规范：`rust-toolchain.toml` 固定稳定版；`#![forbid(unsafe_code)]`（只有 FFI 边界例外，要有审查记录）；`clippy -D warnings`、`rustfmt`；`cargo-deny`（许可白名单 MIT / Apache-2.0 / BSD / MPL-2.0 / ISC / Zlib，外加漏洞公告检查）；所有协议解析器都做 `proptest` 和 `cargo-fuzz` 测试；长度、超时、取消用类型约束；不用 `unwrap` 处理设备输入。

## 2. 分阶段任务

每个阶段结束都要过 §4 的门禁。阶段 2 之后可以并行。

### 阶段 0 — 证据与合规（先做，不写产品代码）

1. **参考源清单**：`docs/0.1.3/references.md` 记录每个参考仓库的固定提交、许可、取用范围；新增 `tools/refs/fetch-refs.sh`，可以重新拉取并校验 SHA。
2. **许可落地**：`THIRD-PARTY-NOTICES` 加入 OpenMV 插件 MIT 原文（“(C) 2016 OpenMV, LLC”）、AprilTag BSD-2、kflash MIT、MaixPy-v1 MIT / Apache-2.0、MaixPy-v1_scripts MIT。每个从参考源移植来的 Rust / TS 文件，文件头写明来源路径和提交。CI 加一步扫描：出现“personal benefit / monetary gain”就失败。
3. **补齐原版私有参数**（Sipeed 改动、源码里没有的部分），对本机 0.2.5 做静态和动态观察，结果写入 `evidence/`。**已完成主体**：见 [original-private-params.md](evidence/original-private-params.md)（1.5 Mbps / `read_buf_len=2048`、9 板型 ID 与复位时序、FILE_SAVE 格式与状态码、URL）。剩余项在阶段 2 补齐：
   - `repl.init` 的两个 `%d`（波特率、`read_buf_len`）：用 `otool` 反汇编找格式串的调用点；连接期间用 `stty -f` / `ioreg` 读实际速率交叉验证。
   - 9 个板型各自对应的 DTR / RTS 复位时序，和 `kflash.py` 的 dan / bit / bit_mic / goE / goD / kd233 / trainer 逐个对表（Maixduino 按官方说明走 goE；M5StickV、T-Watch 要单独确认）。
   - “发送文件到开发板”的传输协议和 boot.py 保存流程（含“去注释、空格转 Tab”）。FILE_SAVE 的分块、状态码和 boot.py 格式化流程需真板对照；不把 `hash:`/`cancel:` 字符串当作已验证的独立协议。
   - 帧缓冲轮询节奏、TX 缓冲轮询节奏、30 s / 5 s 两种超时出现的场景。
   - 资源更新、版本检查的 URL（已取得：`dl.sipeed.com/MAIX/MaixPy/ide/...`），对话框文字和按钮。
   - 原版每个对话框的截图：阈值编辑器、关键点编辑器、AprilTag 生成器、视频工具、终端、保存 boot.py、关于。
4. **验收矩阵**：把对照表转成 `docs/0.1.3/acceptance.csv`，每行一项功能，列出原版步骤、预期结果、Nodu 证据、状态，作为后续所有阶段的验收依据。

### 阶段 1 — Rust 侧车与工程骨架

1. 建 `desktop/native` workspace 和上表的 crate 空壳；`nodu-protocol` 生成 TS 类型并接入扩展。
2. `nodu-device` 实现现有全部 RPC（端口、连接、REPL、运行 / 停止、文件、状态事件）。Node 端 `nodu-device-server.ts` 改为拉起 Rust 二进制。Python worker、`setup:device` 和现有 Python 测试暂时保留为迁移对照；当前 Node 后端默认使用 Rust。相机在阶段 3、固件操作在阶段 6 接入 Rust；阶段 1 两项能力均关闭。非烧写路径完成差分与真板验收、烧写路径完成阶段 6 差分与复核后，才删除对应 Python 实现。保留源码并不代表运行时自动回退。
3. 构建与打包：`scripts/build-native.cjs` 产出 `aarch64-apple-darwin`、`x86_64-apple-darwin`（合成 universal）、`x86_64-pc-windows-msvc`；electron-app 把它们打进 `resources/bin/<platform>/`；browser 开发目标用本机构建。当前仅实现宿主平台构建；universal、Windows 及安装器分发仍待验收。
4. `nodu-mockboard` 和集成测试：Node 后端 ↔ 侧车 ↔ 模拟板端到端跑通。
5. 文件传输和运行 / 停止回归，结果要和 0.1.2 真板行为一致后再进入阶段 2。

### 阶段 2 — 连接与运行（对照表 A1–A6、B1–B5）

1. `nodu-serial` 的 9 板型复位时序 + 野火 CAM / 通用 K210 物理板型（板型和固件身份分开保存）。
2. `nodu-maix-connect` 握手、调速、IDE 模式。错误提示文字和原版一致：“No Maix Board found!”、“Connect fail, board ide mode no ack”、超时、取消。
3. `nodu-maix-ide`：运行（⌘R / Ctrl+R，原版快捷键）、停止（同一个键切换）、连接 / 断开（⌘E / Ctrl+E）、脚本状态、TX 缓冲输出到串行终端。“IDE interrupt”异常不显示为错误。
4. 报错时解析 `File "...", line N`，跳到编辑器对应行并高亮（原版的错误过滤正则行为）。
5. 状态栏：固件版本按钮（点开查看最新固件说明）、`串行端口：`、`FPS：`（提示“可能与摄像头帧率不同”）；软复位。
6. 版本检查和资源更新：按原版 URL 的格式实现。资源包落到用户数据目录，校验 SHA 后再解压。

### 阶段 3 — 帧缓冲与直方图（C1–C9、D1–D3）

1. 帧缓冲面板：自动显示任意脚本的 `sensor.snapshot()` 帧；“录制”“缩放（到合适大小）”“禁用（以获得最佳性能）”三项和原版一致；分辨率 / ROI / 像素数标签；拖拽 ROI。
2. 右键菜单：保存图像到电脑（整张 / 选区）、保存模板 / 描述子到板子（按原版发送命令；固件 d8901fd 里这两条是 TODO，界面照原版保留，验收记“固件未实现”）。
3. 录像：`OMV IMG STR V1.0` 格式写盘，停止后用内置 ffmpeg 转码；计时、大小、FPS 显示。
4. 直方图面板：RGB / 灰度 / LAB / YUV 四种色彩空间；每个通道显示平均数、中位数、众数、StDev、最小、最大、LQ、UQ；统计范围随 ROI。计算放在 `nodu-imaging.wasm`，LAB / YUV 用固件同源查表。
5. 现有的图像工具（PC LAB 蒙版、复制参数、原图导出）并入上面的面板。不重复的功能保留为 Nodu 增强；重复的以原版行为为准。

### 阶段 4 — 机器视觉工具（E1–E5）

1. 阈值编辑器：源图可以选帧缓冲或图片文件；灰度 / LAB 两种模式；二值预览（白色表示被跟踪的像素）；最小 / 最大滑块。关闭时把元组写回编辑器里选中的位置（原版：“The selected threshold tuple will be updated on close”）；没有选中时提示复制。
2. 关键点编辑器：打开、编辑、合并 `.orb` 关键点文件；用鼠标框选、按 Delete 删除离群点；分 octave 显示；保存编辑结果或合并结果。
3. AprilTag 生成器：6 个码族（TAG16H5 / 25H7 / 25H9 / 36H10 / 36H11 / ARKTOOLKIT），选 ID 范围，可选在图上标注族名和 ID，批量输出图片到所选目录。码表来自 BSD-2 的 `tag*.c`。
4. 二维码、DataMatrix、条码生成器：按原版打开对应的搜索页。
5. CNN 网络库：照原版把内置的 5 个 `.network` 模型复制到板子上（这些是 OpenMV 格式，K210 跑不了；验收矩阵里如实注明）。

### 阶段 5 — 文件、终端、视频、编辑器（F、G、H、I）

1. 工具菜单：“将打开的脚本保存到开发板的 boot.py”（FILE_SAVE 协议，可选去注释 / 空格转 Tab，执行前确认）、“发送文件到开发板”（IDE 协议 FILE_SAVE，`[SHA-256][文件名\0 补齐 4][内容]`，见 [私有参数](evidence/original-private-params.md)）。Nodu 现有的板端文件管理保留为增强，但改走 Rust 实现，并解除 boot.py / main.py 的写入禁令（写前确认）。
2. 终端：“打开终端 → 新终端”，可选串口（填波特率）、TCP 客户端 / 服务端、UDP 客户端 / 服务端；独立窗口，Ctrl+R 行为照原版；命令行参数 `-open_serial_terminal`、`-open_tcp_client_terminal`、`-open_tcp_server_terminal`、`-open_udp_client_terminal`、`-open_udp_server_terminal`、`-override_read_timeout`、`-override_read_stall_timeout`、`-update_resources`。网络 I/O 也放进 Rust。
3. 视频工具：转换视频文件、播放视频文件（ffplay），支持原版的输入 / 输出扩展名（`.mjpeg`、`.bin`、`.jpg` 序列等）。ffmpeg / ffplay 选用 **LGPL 构建**（不带 `--enable-gpl` / `--enable-nonfree`），每个平台固定版本和 SHA，源码获取方式写进 NOTICE。
4. 文件菜单：新建文件（原版模板 `# Untitled - By: 用户 - 日期` 加 hello world 相机循环）、打开、文档文件夹（`~/Documents/MaixPy`）、示例（内置 `MaixPy-v1_scripts`，结构和原版菜单相同）、更多示例（GitHub 仓库）、最近文件、保存 / 另存为 / 关闭、打印。
5. 编辑菜单：撤销、重做、剪切、复制、粘贴、剪贴板历史、全选、高级（显示空白、清除空白、自动换行、切换注释、剪切行 / 复制行、大小写转换、折叠 / 展开、字体缩放）、查找 / 替换（含高级查找）、转到行。逐项对照原版快捷键（[evidence 菜单表](evidence/maixpy-ide-0.2.5-menus.txt)）；Theia 已有的能力只做映射和对齐。
6. 补全与悬停文档：从 MaixPy API 文档构建离线索引（来源和许可在阶段 0 确认），由 Monaco 补全提供器加载。
7. 帮助菜单：MaixPy 文档、MaixPy 论坛（原版 URL），关于对话框（加上 OpenMV MIT 署名）。

### 阶段 6 — 烧写与 Flash 路径迁到 Rust

1. 以现有 Python 实现和 `tools/flash-probe` 冻结材料为**对照样本**，录制输入输出 fixture；`nodu-kflash` 必须逐字节通过差分测试。
2. 安全门禁原样移植：当前身份 / 容量认证、完整备份、恢复包校验、确认勾选、单一串口所有者、超时和取消。DE/E7 状态下仍然拒绝烧写。
3. 重做一次审查（host / 协议 / 状态保全），记录到 `docs/0.1.3/`。通过后删除 Python 版本。
4. 在 E7 诊断恢复之前，不做真机烧写，只做只读路径的真板回归。

### 阶段 7 — 界面整合与 P2

1. 专业模式：菜单栏、工具栏（新建、打开、保存、撤销、重做、剪切、复制、粘贴、连接、运行）、主窗口布局（编辑器、帧缓冲 + 直方图、串行终端 / 搜索结果、状态栏）对齐原版。
2. 简洁模式：保留 Nodu 工具栏，所有原版功能都能从菜单和命令面板找到；顺带做 P2（精简状态栏、未连接空状态）。
3. 中英文文案：以原版中文翻译为准（`qtcreator_zh_CN.qm` 和菜单实测）。

### 阶段 8 — 平台与分发

1. macOS 15+：universal 侧车、ffmpeg、Electron 统一签名和公证；hardened runtime 和串口访问权限。
2. Windows 10 x64：侧车 + ffmpeg 做 Authenticode 签名；CH340 / CP210x 驱动说明；COM 口 DTR / RTS 时序实机验证。
3. 安装器（dmg / NSIS）在本版只做到“能装能跑”，自动更新另立版本。

## 3. 测试策略

| 层 | 内容 |
| --- | --- |
| Rust 单元 | 每条 IDE 命令的编码和解码，用 `ide_dbg.c` 的字段布局做 fixture；LAB / YUV 查表和 `lab_tab.c` 逐值一致；直方图统计和参考实现一致 |
| 属性 / 模糊测试 | 帧长度、TX 长度、REPL 输出、文件分块的解析器做 `proptest` 和 `cargo-fuzz`（超长、截断、乱序、超时） |
| 集成 | Node 后端 ↔ `nodu-device` ↔ `nodu-mockboard`：连接、运行、停止、取帧、保存 boot.py、发送文件、断线重连 |
| 前端 | 菜单项和快捷键快照测试对照 evidence；阈值写回、ROI、直方图面板的组件测试 |
| 真板 | 野火 CAM K210 / GC2145：每阶段的验收矩阵行逐条执行，并和原版 MaixPy IDE 在同一块板上并排对照（截图、FPS、输出） |
| 平台 | macOS 15 arm64 / x64、Windows 10 x64 各跑一轮冒烟测试和真板回归 |

## 4. 阶段门禁

- 编译、clippy、rustfmt、cargo-deny、TS 编译、全部测试通过；许可扫描通过。
- 该阶段验收矩阵的行全部有证据（截图 / 日志 / fixture），并和原版并排对照过。
- 不引入未声明的板端写入：只允许原版行为（`ide_mode.conf`、用户确认过的 boot.py / 文件写入）。
- 文档：版本说明、交接文档和 NOTICE 同步更新。

## 5. 风险与应对

| 风险 | 应对 |
| --- | --- |
| Sipeed 私有改动没有源码，复原有偏差 | 阶段 0 用静态加动态证据锁定参数；验收以真板并排对照为准 |
| IDE 模式写 `/flash/ide_mode.conf`，异常断开后板子停在 IDE 模式 | 照原版：读版本时固件会删除该文件（ide_dbg.c:447）；Nodu 提供“恢复普通 REPL”操作，也就是软复位加清理 |
| CH340 在高波特率下出错 | 使用原版同一速率；连续校验失败时退回较低速率，并在状态栏提示 |
| 烧写路径迁移带来回归 | 先做差分测试、重新审查，再删除 Python 版本；E7 未解决前不真机烧写 |
| ffmpeg 体积与许可 | 用 LGPL 构建、动态调用外部进程、固定版本；体积增加写进版本说明 |
| Theia 菜单与原版不完全一致 | 以功能一致为准；同一个快捷键冲突时优先原版快捷键，并记录 |
| Windows 串口差异 | 阶段 8 的实机验证列为发版阻塞项 |

## 6. 交付物

`desktop/native/`（Rust workspace），新的前端面板和对话框，`docs/0.1.3/`（references、acceptance、evidence、各阶段审查、RELEASE、HANDOFF），更新后的 NOTICE，版本号 0.1.3，标签 `v0.1.3`。
