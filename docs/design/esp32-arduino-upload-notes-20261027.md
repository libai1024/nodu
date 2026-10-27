# ESP32 Arduino 上传执行器与模拟烧录验收

日期：2026-10-27。目标仅为 Arduino，芯片为 ESP32-C3 / ESP32-S3。

## 本轮结果

新增上传 helper、当前 13 项专属单元测试和可独立运行的模拟验收脚本。**C3、S3 都完成真实模拟 ROM 写入 → 官方摘要校验 → 独立整片读回 → 保存 Flash → 常规启动输出 `Hello, ESP32!`。** 两款芯片均重复写入两次，未以直接加载原始成品镜像代替烧录测试。

本轮没有连接真实串口硬件。实体 USB-UART / Hardware CDC 的代码采用 Arduino CLI 官方上传 recipe；驱动、自动复位、USB 枚举、端口切换及硬件电气仍需真实板验收。S3 TinyUSB 的自动切口流程明确不在本轮支持范围，本轮也未开发 DFU、OTA 或 ESP-IDF 全流程；产品保留 ESP-IDF 新建入口。

## 文件与集成接口

- `desktop/scope-extension/src/node/nodu-arduino-upload.ts`
- `desktop/scope-extension/test/arduino-upload.cjs`
- `desktop/scripts/arduino-upload-emulator.cjs`

本轮没有修改 server、protocol 或 browser；由主集成调用以下接口：

```ts
executeArduinoUpload({
  project: { path, profile, fqbn, chip: 'esp32c3' /* 或 esp32s3 */ },
  buildPath, cliPath, configPath,
  target: { kind: 'serial', port, transport: 'uart' /* 或 hardware-cdc */ },
  run: async (executable, args, cwd) => ({ code, output }),
  isCancelled: () => operation.cancelled,
  onStage: stage => emitPhase(stage),
});
```

模拟目标为 `{ kind: 'emulator', port: 'socket://127.0.0.1:端口', esptoolPath }`。阶段为 `validate / upload / verify / complete`；返回 `{ ok, stage, cancelled?, error? }`。执行器不自行创建进程或占用串口，所有命令均传参数数组给 `run`。调用者负责：

1. 成功构建与指纹绑定；上传前再次验证工程、profile、依赖与产物仍对应本次构建。
2. 统一进程组取消、日志转发与操作所有权。
3. 串口独占、暂停监视器、失败/取消后的释放，以及端口可用时恢复监视器。

helper 额外验证 `build.options.json` 的 FQBN 与工程真实路径；从编译产生的 `flash_args` 读取 Flash 参数、地址和文件。地址不能重叠或越界，文件必须在构建目录中，禁止符号链接和额外响应文件。应用与 bootloader 都检查 ESP 镜像头、芯片编号、数据 XOR 校验与附加 SHA256。损坏的镜像不会启动烧录子进程。

实体上传执行：

```text
arduino-cli --config-file <隔离配置> upload
  --profile <本次profile> --input-dir <本次build目录>
  --port <实体串口> --protocol serial --verify <工程目录>
```

显式 `transport: tinyusb` 或 FQBN `UploadMode=cdc` 会在执行前失败。用户需要进入 ROM 下载模式、选择对应下载串口并使用 `UART0 / Hardware CDC` 上传配置。这里不会擅自改写项目的 USB/CDC 设置。

模拟器上传使用 esptool 的 `write-flash` 和 `verify-flash`，两者均携带同一组 `flash_args` 参数；不是只检查写进程的退出码。esptool 会按烧录参数处理 bootloader 的 Flash 头和摘要，所以不能遗漏 verify 阶段的参数。地址完全来自本次编译产物，没有在执行器里硬编码通用 `0x10000` 等布局。

## 真实工具和测试输入

| 工具 / 输入 | 实际版本或位置 |
| --- | --- |
| Arduino CLI | 1.5.1，`/opt/homebrew/bin/arduino-cli` |
| ESP32 Arduino Core | 3.3.12；C3 / S3 均为 Nodu 生成器产出的 hello 工程 |
| 隔离环境 | `/tmp/nodu-arduino-e2e-20261026`，复用前轮已验证 profile 缓存 |
| C3 构建 | `/tmp/nodu-arduino-e2e-20261026/build-esp32c3` |
| S3 构建 | `/tmp/nodu-arduino-e2e-20261026/build-esp32s3` |
| esptool | `/Users/wangwei/.local/share/bysj-common-app/arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool` |
| ESP-EMU | `/Users/wangwei/.local/share/bysj-common-app/esp-emulator-0.46.0/esp-emu-0.46.0-aarch64-apple-darwin/esp-emu` |

每个模拟 Flash 都是新建、全 `0xFF` 的 4 MB 临时文件。模拟器以 `--strap-mode 0x02` 启动 ROM 下载模式，串口仅绑定动态空闲的 `127.0.0.1` 端口。写入和校验均使用真实 esptool `--no-stub` ROM 协议；独立整片 `read-flash` 使用 esptool 自带 stub 加速读取。

测试脚本完成后向本轮模拟器发 SIGINT，让 `--save-state` 保存虚拟 Flash，再启动一个正常 Flash 启动实例。所有进程都有时间上限，并由 `finally` 回收；取消用例终止实际 esptool 进程组。没有执行任何实体擦除、真实烧录或 eFuse 写入。

## 验收结果

| 场景 | C3 | S3 |
| --- | --- | --- |
| 空白 Flash 的完整写入与逐段 verify-flash | 通过 | 通过 |
| 对同一模拟 Flash 再次完整写入与校验 | 通过 | 通过 |
| 独立读取全部 4,194,304 字节，逐段与构建文件比较 | 通过 | 通过 |
| 保存 Flash 与独立读回文件逐字节相等 | 通过 | 通过 |
| 从保存后的 Flash 常规启动，真实输出 Hello | 通过 | 通过 |

完整读回镜像 SHA256：

- C3：`d75c70ba6b4b12aaf19b3ca33ca1c821e3680bebd45cf2f5a3625ede8f07ab7f`
- S3：`bcad73c7e2fa4ed325880af326c7e3da1d54a6d91236b1b82561a652420bfd18`

两者恰与前轮 Nodu 编译生成的合并镜像相同。常规启动后的哈希也保持不变。

故障验收：

| 场景 | 真实结果 |
| --- | --- |
| 向 S3 模拟 ROM 上传 C3 工程 | esptool 退出 2，明确报告芯片不匹配；保存 Flash 仍全部为 `0xFF` |
| 没有监听器的本机端点 | esptool 退出 2，连接拒绝；helper 返回 `ok: false / stage: upload` |
| 改坏应用镜像内容 | helper 在 `validate` 阶段拒绝；启动子进程次数为 0 |
| 写入流程开始后取消 | 实际 esptool 进程组被终止；返回 `cancelled: true`，未发送 verify 或 complete 阶段 |

当前 13 项单元测试覆盖参数数组、官方 CLI recipe、远程端点拒绝、串口参数注入、TinyUSB 限制、构建归属、错误芯片、XOR/SHA256 损坏、Flash 越界/重叠、路径逃逸、符号链接、取消及校验失败。后续补充的两项覆盖完整板卡参数可用，以及配置变更、缺失、重复或坏格式时拒绝上传；[实际运行输出](evidence/esp32-arduino-upload-20261027/unit-tests-current.log)为 13/13 通过。

首轮 C3 完整通过；S3 两次写入与摘要校验通过后，测试模拟器的 90 秒总寿命先于整片读回结束，读回因端口关闭失败。已保留该失败记录，并仅重跑 S3 与故障场景，把模拟器总寿命调整为 240 秒，操作完成仍立即退出；重跑全部通过。没有将首轮超时伪装为通过。

## 证据与复跑

12 项模拟验收已归档：[原始汇总](evidence/esp32-arduino-upload-20261027/summary-original.json)、[证据目录说明](evidence/esp32-arduino-upload-20261027/README.md)、[SHA-256 清单](evidence/esp32-arduino-upload-20261027/SHA256SUMS)。归档包括两轮原始 result、两芯片两次 verify、整片读回与启动输出，以及错误芯片、无端点、取消和首轮超时输出；不包含 4 MiB 镜像与重复写入进度日志。[来源清单](evidence/esp32-arduino-upload-20261027/source-manifest.json)记录逐文件原路径、字节数和摘要。

原始汇总中的单测数量 11 保留当时记录，未改写历史结果；当前 13 项结果单独归档。临时目录中的原始材料仍保留：

- 汇总：`/tmp/nodu-arduino-upload-20261027-result.json`。

- C3 证据副本：`/tmp/nodu-arduino-upload-20261027-c3-ERNxQJ/`。其命令记录保留第一次运行的 macOS 原生临时目录绝对路径；该目录中的首轮完整 `result.json` 同时保留 S3 寿命超时。
- S3 与故障测试：`/tmp/nodu-arduino-upload-20261027-J7XhaA/`，`result.json` 为 `ok: true`。
- 每个目录有完整参数数组、分命令日志、读回镜像、保存的虚拟 Flash 与模拟串口日志。

在 `desktop/scope-extension` 执行：

```sh
npm run compile
node --test test/arduino-upload.cjs
node ../scripts/arduino-upload-emulator.cjs
```

模拟脚本可通过 `NODU_ARDUINO_E2E_HOME`、`NODU_ESP_EMU`、`NODU_ESPTOOL` 显式指定环境。默认完整执行两芯片及故障用例；它不会自动下载工具或接触真实端口。`NODU_ESP_UPLOAD_CASES=s3-and-failures`、`failures` 仅用于有明确原因的局部重跑。本轮 helper 独立严格类型检查通过，当前 13 项专属测试通过，最终进程清理检查未发现遗留 ESP-EMU / esptool。

## 后续 ESP 思考

本轮完善 Arduino 流程：选板卡与连接 → 编译 → 上传 → 串口。用户已明确保留 ESP-IDF 新建入口；本轮不开发、也不宣称验证了 ESP-IDF 的编译、烧写和调试全流程。Arduino Core 所带的底层 ESP-IDF 依赖继续由 Arduino 工具链管理。通用芯片型号不代表具体板子的 Flash、PSRAM 和 USB 接线，板卡选项应沿用 Core 的板卡定义。

USB-UART 与芯片原生 Hardware CDC 共用官方 esptool 上传配方，但重枚举和复位行为不同，应由主服务的端口身份与串口 lease 处理。S3 TinyUSB 涉及 1200 bps touch 和应用态端口切换，后续要以实板单独设计恢复策略；不能用模拟 TCP 通过来宣称该路径已支持。

官方依据：[Arduino CLI upload](https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_upload/)；[Espressif USB CDC / DFU](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)；[ESP 镜像格式](https://docs.espressif.com/projects/esptool/en/latest/esp32/advanced-topics/firmware-image-format.html)；[ESP-EMU 0.46.0](https://github.com/espressif/esp-emulator/blob/v0.46.0/README.md)。
