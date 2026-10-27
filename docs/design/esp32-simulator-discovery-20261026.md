# ESP32 本地模拟器发现与验证

日期：2026-10-26。范围：只读调查既有环境、短时模拟测试、Nodu Arduino 生成工程的临时目录验证；没有访问真实串口或烧写硬件。

## 结论

本机已有 **Espressif ESP-EMU 0.46.0**，不是 Espressif QEMU。它能直接运行 Arduino 编译出的完整 Flash 合并镜像；无需在 Nodu 产品中引入 ESP-IDF 工程流程。本轮已实际运行一个既有 C3 Arduino 固件，通过 C3、S3 模拟 ROM 下载口的 `esptool flash-id` 读取，并完成 **Nodu 生成器 → Arduino CLI 真实编译 → ESP-EMU 输出 `Hello, ESP32!`** 的两芯片基础链路。

这些结果证明现有工具可复用，不能当作 Nodu 界面、真实 USB 烧录或全部外围库已经验收。

## 本地路径与版本

| 内容 | 实际路径 / 结果 |
| --- | --- |
| 模拟器 | `/Users/wangwei/.local/share/bysj-common-app/esp-emulator-0.46.0/esp-emu-0.46.0-aarch64-apple-darwin/esp-emu` |
| 可执行类型 | Mach-O ARM64；`--version` 输出 `esp-emu 0.46.0` |
| 二进制 SHA256 | `9067b5a1400d53108d07c0bff1a43561576a877dfd18f94b93186004e979330a` |
| 原始发行压缩包 | `/Users/wangwei/.local/share/bysj-common-app/downloads/esp-emu-0.46.0-aarch64-apple-darwin.tar.gz` |
| 压缩包 SHA256 | `f15205619fcbf0bcc514ef5619b32ca7c97d292259acac01e940b867d1830d5e`，与同目录既有 `SHA256SUMS` 相符 |
| 环境使用方 | `/Users/wangwei/Project/FC/bysj-common-app` |
| 本地环境说明 | `/Users/wangwei/Project/FC/bysj-common-app/docs/development/既有ESP与RN环境记录.md` |
| 既有 Arduino 示例 | `/Users/wangwei/Project/FC/bysj-common-app/firmware/examples/greenhouse-arduino/greenhouse-arduino.ino` |
| 示例完整镜像 | `/Users/wangwei/Project/FC/bysj-common-app/firmware/.build/arduino/greenhouse-arduino.ino.merged.bin` |
| 示例 ELF | `/Users/wangwei/Project/FC/bysj-common-app/firmware/.build/arduino/greenhouse-arduino.ino.elf` |
| 烧录工具 | `/Users/wangwei/.local/share/bysj-common-app/arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool` |

本地安装目录只有发行可执行文件，未找到 ESP-EMU 的 Git 源码 checkout。官方仓库主要发布安装器、二进制、文档与测试助手，不能把本地发行文件视为完整仿真内核源码。对应发布为 [v0.46.0](https://github.com/espressif/esp-emulator/releases/tag/v0.46.0)，该版本仓库的 [LICENSE](https://github.com/espressif/esp-emulator/blob/v0.46.0/LICENSE) 标记 Apache-2.0。

在 `/Users/wangwei/Model`、`~/.espressif`、`~/.local`、常见应用与开发目录的调查中，没有发现可直接运行的 Espressif `qemu-system-xtensa` / `qemu-system-riscv32`。`~/.espressif/v6.1/esp-idf` 的 `qemu.rst`、`qemu_ext.py` 和编译器内的 `libsys_qemu.a` 是文档/集成/运行库，不能当作已安装 QEMU。其他 STM32 项目的 QEMU 记录也不是 ESP32 模拟器。

## 可复用的离线 Arduino 包

Arduino CLI 对下列独立 data 目录执行 `core list --format json`，实际确认 `installed_version: 3.3.12`：

```text
/Users/wangwei/.local/share/bysj-common-app/arduino/data
/Users/wangwei/.local/share/bysj-common-app/arduino/downloads
```

包位置：`data/packages/esp32/hardware/esp32/3.3.12`。工具包括 `esp-x32/2601`、`esp-rv32/2601`、`esp32s3-libs/3.3.12`、`esp32c3-libs/3.3.12`、`esptool_py/5.3.1`。`downloads/packages` 有 25 个既有归档，包括 Core、S3/C3 库与两种架构编译器，适合克隆到 Nodu 的隔离验证目录，避免重复大下载。

Core 自带 WiFi、HTTPClient、NetworkClientSecure、WebServer、Wire、SPI、Preferences、LittleFS、SD、BLE 等库；这些库随 Core 固定版本。该环境没有 `arduino/user/libraries`，不能据此声称 ArduinoJson、PubSubClient、Adafruit 等第三方库已经安装。Core 中存在某个库也不代表每款芯片都支持它，例如 BluetoothSerial 不能作为 S3/C3 的通用能力。

## 已完成的短时验证

### C3 既有 Arduino 应用启动

实际使用 `esp32:esp32:esp32c3:CDCOnBoot=default`、Core 3.3.12 的既有产物。命令如下（完整绝对路径可直接重跑）：

```sh
/Users/wangwei/.local/share/bysj-common-app/esp-emulator-0.46.0/esp-emu-0.46.0-aarch64-apple-darwin/esp-emu \
  --chip esp32c3 \
  --firmware /Users/wangwei/Project/FC/bysj-common-app/firmware/.build/arduino/greenhouse-arduino.ino.merged.bin \
  --elf /Users/wangwei/Project/FC/bysj-common-app/firmware/.build/arduino/greenhouse-arduino.ino.elf \
  --net user,restrict=yes --timeout 5s \
  --exit-on BYSJ_SDK_ARDUINO_READY --log-color never
```

运行退出码 **0**，实际输出包含：

```text
ESP-ROM:esp32c3-api1-20210207
rst:0x1 (POWERON),boot:0x8 (SPI_FAST_FLASH_BOOT)
entry 0x403cbf10
BYSJ_SDK_ARDUINO_READY
```

镜像运行前后 SHA256 相同：`044fbdd70d864cd58cac8f78bdb259e83bbddde98898967031c870c928c29541`。没有使用 `--save-state`、外部 eFuse 文件或真实串口；进程在出现成功标志后退出。本次只确认应用启动，不延伸为 MQTT 测试通过。

### C3 / S3 模拟 ROM 下载口识别

分别启动最多 25 秒的独立模拟器进程，使用系统分配的空闲回环端口；测试结束立即回收进程。两个目标均使用：

```text
esp-emu --chip <esp32c3 或 esp32s3> --strap-mode 0x02
        --uart-tcp 127.0.0.1:<临时端口>
        --net user,restrict=yes --timeout 25s --log-color never

esptool --chip <对应芯片> --port socket://127.0.0.1:<同一端口>
        --before no-reset --after no-reset --no-stub
        --connect-attempts 1 flash-id
```

| 目标 | 本次真实读取结果 | 退出码 |
| --- | --- | --- |
| C3 | ESP32-C3 QFN32，revision v0.3，40 MHz；Flash manufacturer `c8`、device `4015`、2 MB | 0 |
| S3 | ESP32-S3 QFN56，revision v0.0，40 MHz；Flash manufacturer `c8`、device `4015`、2 MB | 0 |

这里的 2 MB 是无镜像下载模式模拟 Flash 的默认值，不是用户板卡容量。第一次只允许 10 秒的 C3 探测超时；将工具运行上限调整为 20 秒、进程启动等待调整为 1 秒后，C3/S3 均成功。所有探测进程已经退出，没有保留监听服务。这一测试只有读取，没有执行 `write-flash`、擦除或 eFuse 写入。

## Nodu 新建项目基础链路验证

验证目录为 `/tmp/nodu-arduino-e2e-20261026`（macOS 规范路径 `/private/tmp/nodu-arduino-e2e-20261026`）。通过 Nodu 已编译的 `desktop/scope-extension/lib/node/nodu-project-generator.js` 导出函数 `parseProjectRequest`、`createSourceProject`，分别生成 `nodu_esp32c3_hello` 和 `nodu_esp32s3_hello`；参数为 `framework: arduino`、`template: hello`。没有手工替换生成出的源代码或 profile。

既有 `data` 与 `downloads` 使用 macOS `cp -cR` 克隆到该临时目录，数据克隆耗时 16.10 秒；所有 CLI 配置、解包和构建都在临时目录。CLI 为 Homebrew Arduino CLI 1.5.1。实际配置：

```yaml
directories:
  data: /tmp/nodu-arduino-e2e-20261026/data
  downloads: /tmp/nodu-arduino-e2e-20261026/downloads
  user: /tmp/nodu-arduino-e2e-20261026/user
```

Arduino profile 会忽略普通全局安装，另在 `data/internal` 准备隔离依赖。第一次编译从既有缓存解包 Core 与工具，日志中的包均为 `already downloaded`；CLI 仍刷新约 747 KiB 的索引元数据，所以这次不标记为“完全断网编译”。这也意味着 Nodu 首次准备需要显示真实阶段，不能把依赖解包当作无响应。

实际 C3 编译命令：

```sh
arduino-cli --config-file /tmp/nodu-arduino-e2e-20261026/config.yaml \
  compile --profile nodu --jobs 4 \
  --build-path /tmp/nodu-arduino-e2e-20261026/build-esp32c3 \
  /tmp/nodu-arduino-e2e-20261026/nodu_esp32c3_hello
```

S3 复用同一配置与缓存，将两个路径中的 `esp32c3` 改为 `esp32s3`。模拟运行使用对应芯片和 `build-<chip>/nodu_<chip>_hello.ino.merged.bin`，并传 `--timeout 10s --exit-on 'Hello, ESP32!' --net user,restrict=yes --log-color never`。没有 `--save-state`。

| 目标 | 实际编译 | 模拟启动 | 完整镜像 SHA256 |
| --- | --- | --- | --- |
| ESP32-C3 | 退出 0；97.24 秒（含首次 profile 准备）；Flash 276958 B、RAM 13200 B | 退出 0；0.11 秒；实际输出 `Hello, ESP32!`；镜像未改 | `d75c70ba6b4b12aaf19b3ca33ca1c821e3680bebd45cf2f5a3625ede8f07ab7f` |
| ESP32-S3 | 退出 0；54.96 秒；Flash 273317 B、RAM 21592 B | 退出 0；0.10 秒；实际输出 `Hello, ESP32!`；镜像未改 | `bcad73c7e2fa4ed325880af326c7e3da1d54a6d91236b1b82561a652420bfd18` |

S3 实际串口输出包含 `ESP-ROM:esp32s3-20210327`、`entry 0x403c88b8`、`Hello, ESP32!`；C3 包含 `ESP-ROM:esp32c3-api1-20210207`、`entry 0x403cbf10`、`Hello, ESP32!`。

原始命令、输出、生成输入哈希位于临时目录的 `compile-{c3,s3}-command.json`、`compile-{c3,s3}.log`、`emulator-{c3,s3}-command.json`、`emulator-{c3,s3}.log`、`emulator-{c3,s3}-result.json`、`inputs.json`。所有模拟进程已经正常退出。该链路调用真实 Nodu 生成器、真实编译器与官方模拟器，尚不包含工作台按钮、真实板上传或 USB 重连验收。

### 实际 Node 编译服务调用

补充调用本次已编译的 `desktop/scope-extension/lib/node/nodu-arduino-server.js`：先加载 `reflect-metadata`，实例化 `NoduArduinoServer`，仅把 `directory()` 指向上述隔离 home、`binary()` 指向 `/opt/homebrew/bin/arduino-cli`，然后执行：

```js
await server.compile({
  path: '/tmp/nodu-arduino-e2e-20261026/nodu_esp32c3_hello',
  operationId: 'e2e-service-c3'
});
```

实际耗时 **44.266 秒**，返回 `ok: true`、`stale: false`、`diagnostics: []`。输出事件准确携带 `e2e-service-c3`，包括目标 FQBN、Flash 276958 B 与 RAM 13200 B。原工程 `sketch.yaml` 哈希未变化；服务自行在隔离 home 写出 `arduino-cli.yaml`，没有修改既有 Arduino 环境。

服务构建目录为 `/tmp/nodu-arduino-e2e-20261026/builds/276645d7951c6c666103e88c`，完整镜像 SHA256 为 `2a908648d225485f98cd8e7813b348d0d4d33e52f7a6d03ec268c0a508ae9578`。证据在 `service-c3.log`、`service-c3-result.json`，并已汇入 `result.json`。本次补测仅覆盖服务编译调用，没有再次扩大模拟或烧写范围；上表的运行结果对应之前明确记录的两份镜像。

## Nodu 测试入口与真实边界

1. 基础测试使用 Nodu 生成的 C3/S3 Arduino hello 工程，以真实 CLI 编译。将产物 `.ino.merged.bin` 交给 ESP-EMU，断言 `Hello, ESP32!`，不能仅凭编译退出码判断运行成功。
2. UART 模拟应选择 `CDCOnBoot=default`（关闭 USB CDC）或明确使用 `Serial0`。产品面向真实原生 USB 的默认设置需要另做真实板验证，不能为了模拟方便统一关闭用户项目的 USB。
3. 上传协议测试可以将临时空白 Flash 镜像交给 `--strap-mode 0x02 --uart-tcp 127.0.0.1:...`，执行 esptool 写入、读回与校验；只有临时镜像可配合 `--save-state`。将写后的镜像以正常启动模式再次运行，才算验证“写入后运行”。普通 Arduino CLI 上传默认复位方式与模拟 TCP 不完全一致，适配必须明确加入 `no-reset`，不能伪造实体 `/dev/cu.*`。
4. ESP-EMU 的 UART TCP 不传输实体 DTR/RTS、USB 枚举、驱动或断开重连。上述测试不能覆盖真实板的 BOOT/RESET 自动下载、电缆、串口占用、USB CDC、DFU、电源与引脚问题。
5. ESP-EMU 与 QEMU 的支持表不同。ESP-EMU 本地帮助含 UART 注入、网络、PSRAM、ROM 下载等入口；不能把 QEMU 缺少 Wi-Fi 的结论套到它身上。ESP-EMU 是 Beta，外设寄存器模型与真实器件电气/时序仍有距离；传感器、屏幕、电机等常见库的编译通过不等于真实外设行为通过。
6. 默认验证不使用网络；现有演示用了 restrict 模式并在启动标志处退出。`user,restrict=yes` 仍允许 DNS，不能把它描述为完整网络隔离机制。后续 HTTP/MQTT 测试使用明确的本机服务与有界生命周期。

上述 ESP-EMU 入口、复位限制与芯片范围可对照 [0.46.0 官方说明](https://github.com/espressif/esp-emulator/blob/v0.46.0/README.md)。若后续选择 QEMU，另按 [官方 S3 文档](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32s3/README.md)、[C3 文档](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32c3/README.md) 与 [功能矩阵](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)验证；本轮没有安装 QEMU。
