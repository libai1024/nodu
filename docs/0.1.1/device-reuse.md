# 第一阶段 K210 设备服务：复用来源与协议边界

核对日期：2026-10-19。本文记录官方源码研究、当前复用实现及本机依赖核查；源码审阅本身未打开串口。本轮另有独立的`.impeccable/review/device-service/hardware-smoke.jsonl`（仅本地保留）、[六帧相机复核](../../.impeccable/review/device-service/camera-recheck.md)及[原生 App 验收](../../.impeccable/review/device-service/verification.md)：扫描 / 连接、固件与物理 profile 分离、REPL、含未保存修改的 RAM 运行 / 停止、运行中布局切换、重连、文件上传 / 下载、正常 JPEG 和真实图像工具均已在指定组合验收。共享浏览器前端另有 REPL 和帧接收检查，各入口的证据分别保留。

固件准备、备份和烧写 UI / 代码已有；当前会话没有实际 Flash 容量认证，门禁禁止烧写，完整当前备份未完成，本轮未执行真机烧写。Windows、其他芯片、工具链编译 / 库包、KPU 推理及未移植的旧 IDE 工具不在当前通过项中。历史 CLI / MaixPy IDE 成功记录与本轮 App 结果分别保留，完整矩阵见[功能基线](feature-baseline.md)。

## 来源与许可

按具体文件的声明判断许可；不能把仓库顶层许可自动套用到每个文件。复用依赖或改编源码时，应在交付物中保留相应版权、许可及免责声明。

| 来源与固定版本 | 已核实的许可依据 | 第一阶段用途 |
| --- | --- | --- |
| MaixPy-v1 `d8901fd2272f000226f1c1037c1eb7c412b88e66` | [ide_dbg.c][ide-c]、[ide_dbg.h][ide-h] 文件头明确 MIT；[LICENSE.md][maix-license] 同时说明仓库含 MIT 与 Apache-2.0，须检查各文件 | 从 MIT 固件端声明独立实现兼容协议；不依赖旧 Qt 插件代码 |
| MicroPython v1.25.0，`f498a16c7db6d4b2de200b3e0856528dfe0613c3` | [transport_serial.py][transport-serial]、[transport.py][transport]、[tools/pyboard.py][pyboard] 均有 MIT 文件头；[mpremote/LICENSE][mpremote-license] 与 [包声明][mpremote-project] 亦为 MIT | 以已安装 mpremote 库复用串口传输、raw REPL、执行与文件操作；pyboard.py 仅为来源与兼容性参考，无需重复内嵌 |
| pySerial `3.5` | [v3.5 LICENSE.txt][pyserial-license] 明确 BSD-3-Clause；[serial/__init__.py][pyserial-init] 有同名 SPDX 标记 | 使用串口 API、端口枚举与超时能力；它不是 MIT 依赖 |
| kflash.py `550828c768b16ef329695d3f5eace3f6bcf14af2`，`1.1.6` | [LICENSE][kflash-license] 为 MIT；[setup.py][kflash-setup] 声明版本 1.1.6 与 MIT | 已接入固件准备 / 烧写实现；实际容量门禁未解除，未真机写入，详见[烧写计划](device-flash-plan.md) |
| OpenMV Qt Creator `openmv-qtc-14.0.2` 的 `openmvpluginprotocol.cpp` | [文件头第 3 条][openmv-restricted] 限制个人受益、非商业及非获利用途，并提供商业许可联系渠道 | **禁止复制、翻译或改编该文件进入本项目**；不能用项目自己的 MIT 或其他顶层许可覆盖其限制 |

MaixPy 的 [framebuffer.c][framebuffer]、[py_image.c][py-image]、[JPEG 编码器][jpeg]、[MAIX 板级协议常量][board-config] 也已检查文件头，均明确 MIT。[machine_uart.c][machine-uart] 与 [maixpy_main.c][maix-main] 用来研究模式切换；后者文件头为 Apache-2.0，不作为本项目复制实现的来源。

## 本机依赖核查

通过各环境的 `importlib.metadata.distribution()` 读取版本、License、Classifier、安装位置，并读取已安装模块文件头；没有实例化 `SerialTransport` 或 `serial.Serial`。

| Python 环境 | mpremote | pyserial | kflash |
| --- | --- | --- | --- |
| 默认：`/Users/wangwei/.nodu/python/bin/python` | **1.25.0**；元数据 MIT；两个 transport 模块头为 MIT；dist-info 内有 LICENSE | **3.5**；元数据 BSD；模块 SPDX 为 BSD-3-Clause | **1.1.6**；默认环境现已安装，固件操作依赖 |
| 开发回退：`/opt/homebrew/share/maixpy-k210/venv/bin/python` | **1.29.0**；元数据 MIT；存在版本漂移 | **3.5**；元数据 BSD | **1.1.6**；元数据 MIT License；dist-info 内有 LICENSE |

默认依赖应固定 `mpremote==1.25.0`、`pyserial==3.5`，启动时报告实际解释器与版本。回退环境不能被描述为已经固定在 1.25.0；换环境前后须检查实际版本与 API。包的安装成功只证明依赖可导入，不证明已兼容当前 K210 固件。

## mpremote 的复用边界

使用 `SerialTransport` 的 raw REPL、执行、返回输出与错误能力，以及 `Transport` 的文件操作。上游串口模块自身说明库 API 仍可能变化，因此通过项目适配层隔离，并固定版本。[来源：transport_serial.py][transport-serial]、[transport.py][transport]。

`enter_raw_repl()` 默认会发送 Ctrl-C、Ctrl-A，并在默认 `soft_reset=True` 时发送 Ctrl-D 软复位；传 `soft_reset=False` 仍会中断正在运行的程序。raw-paste 有协商和普通 raw REPL 回退路径，不能假定旧 MaixPy 实现了现代 raw-paste。raw REPL 的 `follow()` 以两个 `0x04` 分隔 stdout 与 stderr；传输任意二进制图像前应使用明确长度的独立通道或受控文本编码。[来源：transport_serial.py][transport-serial]。

当前串口由持久 Python worker 单独持有，上层通过同一 Node RPC 服务串行调度，简洁 / 专业模式使用同一前端设备模型。连接策略、波特率、物理板型与固件身份分别记录，不直接套用其他芯片的 DTR/RTS 复位行为。文件 API 本质上在板端执行 Python 文件操作，RAM 运行、读取文件、显式写入与烧录分别处理；当前服务文件上限为 2 MiB，启动文件受保护。

## 固定 MaixPy IDE 协议

下表只描述指定提交中的固件实现，不承诺其他 MaixPy、OpenMV、CanMV 或裁剪固件兼容。命令由 [ide_dbg.h][ide-h] 定义，行为以 [ide_dbg.c][ide-c] 为准。

通用头为 `0x30 | command:u8 | length:u32-le`，共 6 字节；命令高位表示设备向主机返回数据。`0x30`、64 字节调试缓冲与 23 KiB JPEG 缓冲来自 [MAIX 板配置][board-config]。主机需严格按长度读取并设上限、超时和失败清理；不能让 REPL、输出轮询与帧读取同时消费同一串口。

| 命令 | 值 / 长度 | 固件行为与边界 |
| --- | --- | --- |
| `FW_VERSION` | `0x80` / 返回 12 字节 | 三个 u32 版本字段；**同时删除 `/flash/ide_mode.conf`**，不得当作无副作用探测 |
| `ARCH_STR` | `0x83` / 请求给定长度 | 架构与板型字符串；UID 仍为零占位，不能作为唯一设备身份 |
| `QUERY_STATUS` | `0x8D` / 返回 4 字节 | 标记 `0xFFEEBBAA` |
| `SCRIPT_EXEC` | `0x05` / 脚本字节数 | 收齐代码后标记 ready/running 并触发解释器中断；不等于保存文件 |
| `SCRIPT_STOP` | `0x06` / 无负载 | 设置中断；不等于硬件复位 |
| `SCRIPT_RUNNING` | `0x87` / 返回 4 字节 | u32 的 0 或 1 |
| `TX_BUF_LEN`、`TX_BUF` | `0x8E` / 4 字节；`0x8F` / n 字节 | 先查输出环形缓冲长度，再按量取 stdout；它是轮询协议，不是普通 REPL 字节流 |
| `FRAME_SIZE` | `0x81` / 返回 12 字节 | w、h、size 三个 u32；拿不到锁或无帧时首字段为 0；成功后持有帧锁 |
| `FRAME_DUMP` | `0x82` / 返回 size 字节 | 发送帧后清空帧元数据并解锁；必须与 FRAME_SIZE 配对，不能丢弃半次传输 |
| `FB_ENABLE` | `0x0D` / 头后额外 int16 | 启用/禁用 JPEG 帧缓冲；禁用还尝试释放 IDE 持有的帧锁 |
| `FILE_SAVE`、`FILE_SAVE_STATUS` | `0x07`、`0x88` | 存在文件写入、SHA-256 核对与状态实现；属于显式部署，不列入只读探测 |
| `TEMPLATE_SAVE`、`DESCRIPTOR_SAVE` | `0x08`、`0x09` | 实现为 TODO；不能因枚举或旧菜单存在就宣称支持 |
| `SYS_RESET` | `0x0C` | 调用系统复位，不进入第一阶段自动连接流程 |

## 图像格式与模式副作用

普通帧缓冲路径由 [framebuffer.c][framebuffer] 复制既有 JPEG 或压缩原始帧，再由 FRAME_DUMP 直接发送；缓冲不足会丢帧并降低后续 JPEG 质量。它不同于 [py_image.c][py-image] 的 `compress_for_ide()` / `compressed_for_ide()`：后者为 JPEG 加 `0xFE` 首尾，把每 3 字节按小端拆为 4 个 6-bit 值并加 `0x80`，余 1/2 字节输出 2/3 字节。这是专用封装，不能直接作为浏览器 JPEG。

当前实现采用普通 raw REPL 的 `sensor.snapshot()`、JPEG `compress(quality=35).to_bytes()` 与 base64 传输，校验 JPEG 尺寸与数据边界，不使用旧 IDE 专用字节封装。初始化只在 RAM 执行板上已有 `/flash/gc2145_board.py` helper，不自动安装或改写该文件。六张正常 320 × 240 场景帧已通过服务复核，原生 App 也显示正常纸箱场景；此前倒放时的暗帧保留为历史记录。此路径为低速快照，普通脚本运行时暂停采集，未测持续 FPS，不继承旧 IDE 帧率。

真实图像工具在前端解码收到的 JPEG，提供 ROI、RGB / 灰度直方图、像素 RGB / PC LAB、阈值掩码与命中计数、元组复制、适应 / 100% / 200% 缩放以及 PNG / JPEG 原图导出，均已完成原生验收。LAB 为 sRGB / D65 浮点计算，不承诺与固件 RGB565 / LAB 查表逐值一致，不代表板端检测或 KPU 推理。参数按钮只复制，不改写编辑器。原生导出 JPEG 的 3,397 字节与板端最后 JPEG 的 SHA-256 相同，见[导出校验](../../.impeccable/review/device-service/native-export-verification.json)；这证明接收与导出的字节一致，不扩大为全部视觉算法一致。

进入 IDE 解析模式需要先通过 REPL 配置 `UART.repl_uart().init(..., ide=True, ...)`。[machine_uart.c][machine-uart] 显示：`from_ide=True` 调用 init2 创建/截断 `/flash/ide_mode.conf`；`from_ide=False` 调用 init3 删除它。[内置 _boot.py][boot] 还会消费该文件并改变启动路径。已有配置不得在连接探测中被覆盖或删除。

退出 IDE 也不是简单恢复 RAM REPL：[maixpy_main.c][maix-main] 在 IDE 脚本结束后检查 UART 的 `ide_debug_mode`，为 false 时进入清理、`mp_deinit()` 和 `soft_reset`，随后可能再次执行启动脚本。因此不能承诺 IDE 与 raw REPL 任意往返仍保留运行状态；第一阶段优先避免有文件副作用或隐含复位的切换。

## 兼容门槛与待验收事项

官方 [MaixPy IDE 0.2.5 readme][ide-readme] 明确要求固件至少 `0.4.0_44`。这是该安装包的版本门槛，不能代替对 `CONFIG_MAIXPY_IDE_SUPPORT`、具体命令及板卡的能力探测；也不能把其他版本 Wiki 的较早门槛混用。readme 本次取得内容的 SHA-256 为 `205d8243c487abe7a0fee27e51d2ba16e0d644fd729435c2da9878e0ea6f5776`。

服务与原生 App 的连接、RAM 脚本输出 / 停止、重连、双布局、相机 JPEG 和文件流程已在指定板型验收；[原生文件往返](../../.impeccable/review/device-service/native-file-roundtrip.json)为 4,124 字节且 SHA-256 一致。14 项 Node 测试（6 项后端、8 项图像）与 33 项 Python 测试通过，browser / Electron 构建均为 0 errors。持续帧率、完整当前备份、实际烧写 / 恢复及 Windows 仍需验收；源码存在、包可导入和模拟测试不能替代这些结果。物理野火 CAM K210 / GC2145 身份由用户选择的 profile 保存，不能仅凭 `ARCH_STR` 自动改认成 Sipeed 产品。未移植的模板 / 描述子、标记生成、视频工具等旧 IDE 菜单仍须保留缺项记录。

当前会话实际容量未认证前不允许烧写；16 MiB profile、旧备份与文件系统大小均不是芯片容量实测。历史启动日志包含 `EF/17`，但它是 `0x90` 命令的制造商 / 器件双字节结果，不是完整三字节 JEDEC ID，也未建立当前会话认证，见[容量证据边界](device-capacity-status.md)。ktool 混合许可 RAM 探针路线本轮暂停，未新增 host / stub 分发或探针模块，见[许可与能力结论](device-flash-probe-license.md)。

[ide-c]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/ide_dbg.c
[ide-h]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/include/ide_dbg.h
[maix-license]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/LICENSE.md
[board-config]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/boards/MAIX/omv_boardconfig.h
[framebuffer]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/framebuffer.c
[py-image]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/py/py_image.c
[jpeg]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/img/jpeg.c
[machine-uart]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/standard_lib/machine/machine_uart.c
[maix-main]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/maixpy_main.c
[boot]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/builtin_py/_boot.py
[transport-serial]: https://github.com/micropython/micropython/blob/f498a16c7db6d4b2de200b3e0856528dfe0613c3/tools/mpremote/mpremote/transport_serial.py
[transport]: https://github.com/micropython/micropython/blob/f498a16c7db6d4b2de200b3e0856528dfe0613c3/tools/mpremote/mpremote/transport.py
[pyboard]: https://github.com/micropython/micropython/blob/f498a16c7db6d4b2de200b3e0856528dfe0613c3/tools/pyboard.py
[mpremote-license]: https://github.com/micropython/micropython/blob/f498a16c7db6d4b2de200b3e0856528dfe0613c3/tools/mpremote/LICENSE
[mpremote-project]: https://github.com/micropython/micropython/blob/f498a16c7db6d4b2de200b3e0856528dfe0613c3/tools/mpremote/pyproject.toml
[pyserial-license]: https://github.com/pyserial/pyserial/blob/v3.5/LICENSE.txt
[pyserial-init]: https://github.com/pyserial/pyserial/blob/v3.5/serial/__init__.py
[kflash-license]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/LICENSE
[kflash-setup]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/setup.py
[openmv-restricted]: https://github.com/openmv/qt-creator/blob/openmv-qtc-14.0.2/src/plugins/openmv/openmvpluginprotocol.cpp
[ide-readme]: https://dl.sipeed.com/MAIX/MaixPy/ide/v0.2.5/readme.txt
