# ESP32 Arduino 实施决策与测试边界

日期：2026-10-27。首批目标：ESP32-C3、ESP32-S3。用户要求：Arduino 优先；教程不在本次范围；与 K210 / STM32 保持同一套交互。

**本日补充约束：**下载 Nodu 后即带基本 Arduino 环境；固定稳定版本，不联网更新开发板索引。随包资源、首次本地初始化和干净离线验收要求以 [固定版随包环境](esp32-arduino-bundled-environment-20261027.md) 为准。下文 CLI 缺失时联网下载仅保留为开发源码运行的准备方式，不作为正式发行版的首次使用流程。

## 交互约定

- 新建沿用同一个窗口，在 ESP32 下显示 Arduino / ESP-IDF 的 Logo 与名称，默认 Arduino。已有 IDF 工程不转换。
- 极简模式沿用三种主操作手势；专业模式沿用编译、烧录、运行、停止。编译只生成产物；烧录使用有效构建；运行保存当前项目、编译并烧录。烧录成功不等于已观察到程序运行。
- 设备和高级板卡选项使用原有设备弹层；所有选择器使用 Nodu 组件。选项来自锁定 Core 的 boards.txt，离线目录作为首次准备前的依据。
- 左侧“库”与文件、搜索共用侧栏区域。库按当前项目管理，聊天位置保持一致。没有另起 Arduino 专用工作台。
- 输出、串口、常驻“问题”继续使用底部面板。问题支持定位、单条复制、复制全部。串口 TX 回显、行尾 `\n` / `\r\n` 等显示沿用之前的串口修复。
- 板卡参数会使构建失效；本机端口、波特率和编码不会改变 sketch.yaml，也不会要求无理由重新编译。
- `.ino` 文件与代码片段接入现有提问上下文、复制/拖入、引用行号与历史记录；不进入 C 教学检查器。

## 工程与依赖

标准同名 `.ino` + `sketch.yaml`，另用 nodu.json 记录 `esp32-arduino` 与目标芯片。profile 是 FQBN、Core、库版本的唯一来源。新工程固定 Arduino CLI 1.5.1 / Arduino-ESP32 3.3.12。

CLI 缺失时下载官方固定版本并核对 SHA-256；完成校验后才原子发布到隔离目录。默认目录 `~/.nodu/arduino`，测试可指定 NODU_ARDUINO_HOME。环境配置和构建路径统一为真实路径，避免 macOS `/tmp` 与 `/private/tmp` 混用导致 CLI profile 的第三方库只找到头文件、链接失败。

11 个常用库归档已随资源交付，约 1.23 MB：ArduinoJson、ArduinoMqttClient、Adafruit SSD1306 / GFX / BusIO / NeoPixel、DHT / Unified Sensor、OneWire、DallasTemperature、ESP32Servo。新 S3/C3 工程直接锁定 8 个主库与 3 个依赖；已有工程不被静默改写。Core 的 WiFi / Wire / SPI 等单独标记内置。预装表示资源随应用交付，项目使用表示 profile 引用，两个状态分开。

库版本变更先解析兼容依赖、准备资源，成功后原子修改 profile；失败保留原内容。保留已有条目的顺序、注释、引号与本地库属性；跨配置共享的 YAML 引用若会被连带修改或失去目标，拒绝写入并保持原文件。被其他库依赖的库不能直接移除。C3 不显示仅支持带 SDMMC 控制器芯片的 SD_MMC，仍提供 SPI SD。上游原始许可、来源和归档校验值随资源保留。完整验证见 [库验收](esp32-library-verification-20261026.md)。

## 上传方式与范围

| 路径 | 本轮实现 | 需要区分的行为 |
|---|---|---|
| 外置 CH340 / CP210x / FTDI → UART | 走锁定 Core 的官方 Arduino CLI 配方 | 上传速率与串口监视波特率独立；自动复位取决于板载 DTR/RTS 电路 |
| C3 内置 USB Serial/JTAG CDC | 同一串口上传入口、官方配方 | `USB CDC On Boot` 控制 Arduino Serial 输出；首次下载/坏程序可能仍需 BOOT/RESET |
| S3 UART0 / Hardware CDC | 同一串口上传入口、官方配方 | 上传口和运行输出口可能不同，允许分别保存；不能仅按端口名称推断连接类型 |
| S3 TinyUSB 上传模式 | 当前上传明确拒绝 | 需要专门的 USB 触碰、枚举与恢复验收，不能伪装成已验证的 UART 流程 |
| USB DFU | 不提供本轮入口 | DFU 下载与 CDC 日志是不同能力；C3 无 DFU |
| OTA | 不提供本轮入口 | 需要设备发现、凭据、分区及失败恢复设计 |
| JTAG / OpenOCD | 不提供本轮入口 | 保留后续独立调试适配器方向 |
| 官方 ESP-EMU 的 ROM socket | 自动测试专用 | 仅允许本机回环端点，真正执行 ROM 写入与验证，不作为用户串口候选 |

依据：[Espressif USB CDC / DFU](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)、[CLI upload](https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_upload/)。具体芯片和板型能力以锁定 Core 为准。

## 串口交接

1. 编译不借出串口；产物与目标验证通过后才申请上传租约。
2. Nodu 原生串口服务保留跨进程端口锁，将自己打开的监视串口暂时让出。上传中拒绝其他 Nodu 窗口打开或发送到该端口。
3. 下载结束只恢复此前已经打开的监视器。用户关闭、切项目、取消或底层服务退出后不自动恢复。
4. 恢复允许端口名/PID 随 USB 模式变化，但必须能用唯一序列号与 VID 认出同一设备。无序列号或身份歧义时保留断开状态，不选其他设备。
5. Arduino 原生 Espressif VID 0x303a 的 CDC 监视连接置 DTR；外置 USB-UART 不因此增加 DTR 操作。自定义 VID 的 TinyUSB 板尚未做专门自动识别。
6. 下载口与监视口分别存于 `.nodu/arduino.local.json`。上传后自动重新发现针对被借出的监视口；另一个独立监视口被系统重新枚举时仍需手动重新选择。

原生租约与 Node 恢复逻辑已自动测试。模拟器没有真实 USB 枚举与 DTR/RTS 电路，因此这些物理行为仍需 S3/C3 真板验收。

## 任务一致性

每次编译保存源码、profile 和固件指纹。代码/库/板卡变化后旧产物不能上传；固件文件被替换也会拒绝。上传前校验官方生成的 flash_args、每段地址及映像，不硬编码一个“通用 Flash 地址”。

不同窗口的操作 ID 在服务端改为独立身份；窗口断开只取消其拥有的任务。取消终止本任务进程树，清理串口租约，不全局结束 Arduino 进程。准备、编译、写入、校验和恢复使用真实阶段，无假总进度。

开始写入后用户编辑源文件不会直接中断固件写入，完成时标记代码已改变；明确点击停止仍可取消，并且不声称板上已有可运行程序。

## 验收证据与未覆盖项

- C3/S3 使用真实 Arduino CLI 和官方 Core 编译；常用库组合双芯片编译、缓存条件下离线编译均已验证。
- 官方 ESP-EMU 0.46.0 两芯片均完成 ROM 写入、独立读回验证、保存 Flash、重启输出。还覆盖重复写入、错芯片、坏固件、端点不可达和取消。详见 [上传报告](esp32-arduino-upload-notes-20261027.md)。
- 服务指纹、任务归属、串口租约取消竞态、CLI 归档提取和 UI 状态有独立自动测试。Electron 真实操作证据见 `arduino-electron-acceptance-20261027/`。
- Arduino Language Server / clangd 单独随包提供，使用当前 profile 与隔离工具链；详情及最终验收以语言服务记录为准。
- 真实 USB 枚举、BOOT/RESET、电气时序、无线与 OLED/灯带/舵机/传感器功能没有被模拟器验证；编译通过不代表这些外设实测通过。
- 普通外部 sketch 的导入向导、项目重命名联动、完整固件导出向导、ZIP/本地库导入、OTA/DFU/JTAG、Windows 实机验收属于后续扩展；不改变本轮新建→编辑→库→编译→串口上传的主路径。
