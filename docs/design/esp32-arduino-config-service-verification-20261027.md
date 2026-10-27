# 配置板卡参数后的 Arduino 服务集成验收

验收时间：2026-10-27 00:05–00:10（Asia/Shanghai）。平台为 macOS arm64，Arduino CLI 1.5.1、Arduino ESP32 Core 3.3.12、esptool 5.3.1、ESP-EMU 0.46.0。

ESP32-C3 与 ESP32-S3 均通过真实 `NoduArduinoServer.configure → compile → upload`，随后从实际写入并保存的模拟 Flash 启动，输出 `Hello, ESP32!`。产品代码没有为通过测试而修改。

## 验证范围

使用当前工程生成器创建两个 Arduino 串口示例，保留生成器写入的固定 Core 与完整内置库依赖配置。通过服务的 `boardOptions` 读取真实菜单，再通过 `configure` 修改选项。使用实际 CLI 编译取得服务返回的 `buildToken`，随后交回同一服务上传。

测试子类只覆盖隔离目录、CLI 路径、上传目标，并记录真实进程命令；上传目标限制为模拟器本机回环端口。没有绕过源文件或构建产物指纹验证，没有伪造构建 token。模拟器每次从全 `FF` 的 4 MiB Flash 开始，使用 ROM 下载协议执行 `write-flash` 与 `verify-flash`，退出时保存 Flash。之后逐段比较保存的 Flash 与编译产物，并以正常启动模式再次运行。

| 芯片 | 通过服务修改的选项 | 完整 FQBN 选项数 | 编译 | ROM 写入/校验 | 保存后正常启动 |
| --- | --- | ---: | --- | --- | --- |
| ESP32-C3 | `FlashFreq=40`、`DebugLevel=warn` | 11 | 通过，88.783 秒 | 通过 | `Hello, ESP32!` |
| ESP32-S3 | `CPUFreq=160`、`FlashMode=dio`、`DebugLevel=warn` | 17 | 通过，95.827 秒 | 通过 | `Hello, ESP32!` |

两个编译结果均为 `ok=true`、`stale=false`、诊断为空；两个上传结果均为 `ok=true`、`stale=false`。实际 Flash 参数取自生成的 `flash_args`：C3 为 DIO / 40 MHz / 4 MiB，S3 为 DIO / 80 MHz / 4 MiB。地址、文件列表均取自官方生成结果。

## FQBN 顺序核对结论

在本次实际使用的 CLI 1.5.1 / `--profile nodu` 流程中，两芯片的 `build.options.json.fqbn` 与 `sketch.yaml` 的完整 FQBN **逐字符相同**。CLI 没有重新排列选项，因此未复现“归一化顺序导致固件被错误拒绝”的假设。`nodu-arduino-upload.ts` 的当前检查保留原样。

此结论限于已执行的固定版本与 profile 流程；不能推广到未来 CLI 版本或其他构建入口。后续升级工具链时，可直接重跑本测试。

板卡菜单本身有差异：S3 没有独立的 `FlashFreq` 菜单，频率包含在 `FlashMode` 选项里。第一轮统一传入 `FlashFreq=40` 时，服务正确拒绝了 S3 的不存在选项；原始失败记录保留。最终脚本先从板卡菜单检查每个值，再使用上表的合法参数。

## 留存证据

- 可重复执行脚本：`desktop/scripts/arduino-config-service-emulator.cjs`。
- 仓库内精简事实与输出副本：`docs/design/evidence/esp32-arduino-config-service-20261027.json`。
- 完整通过记录：`/private/tmp/nodu-arduino-config-service-20261027-KouCEv/run-FUjuie/result.json`。
- 实际服务事件：同目录 `service-output.json`；实际 CLI/esptool 参数数组见 `result.json.commands`，每次执行的原始输出独立保存。
- 首轮 S3 不支持参数的记录：同项目目录 `run-SwM9iP/result.json`；该轮 C3 全链通过。
- 独立缓存：`/private/tmp/nodu-arduino-config-service-20261027-KouCEv/home`，使用 APFS 克隆已有测试缓存，未改动原缓存或用户工程。

保存 Flash 的 SHA-256：

| 芯片 | 字节数 | SHA-256 |
| --- | ---: | --- |
| ESP32-C3 | 4194304 | `273a45d5d442f6d6d3230d0f8de50e0614a9c6c7f187a0fa7e2371c49d11534a` |
| ESP32-S3 | 4194304 | `93067b580fa4258cd99aff9b9e9a97949c7e2267ee1c74e0f36c9247647c1e52` |

从 `desktop` 目录重跑现有隔离工程：

```sh
NODU_CONFIG_E2E_DIR=/tmp/nodu-arduino-config-service-20261027-KouCEv \
  /opt/homebrew/opt/node@24/bin/node scripts/arduino-config-service-emulator.cjs
```

不设置 `NODU_CONFIG_E2E_DIR` 时，脚本创建新的临时工程和隔离缓存。可用 `NODU_ARDUINO_E2E_HOME` 指定已有种子缓存；模拟器与 esptool 路径可通过脚本列出的环境变量覆盖。

`arduino-upload.cjs` 补充了完整板卡参数的有效输入及配置差异拒绝测试，共 13/13 通过。执行后检查没有遗留本次 CLI、esptool 或模拟器进程。

本次没有访问真实串口，因此不将模拟器结果视作 USB 重枚举、硬件 CDC、TinyUSB、实际闪存电气时序或板卡外围硬件的验收。
