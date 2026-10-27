# Arduino 常用库与管理后端验收

日期：2026-10-26。只记录本子项，不代替上传、语言服务或界面整体验收。

## 已实现

- 官方 Library Manager 本地索引搜索、分页、已安装 / 可更新 / 预装筛选；显式刷新才联网。搜索缓存解析结果，避免每次输入重复解析约 56 MB 的索引。
- 当前项目 profile 为安装状态的依据；Core 自带库与预装资源包分开。不会把全局缓存里的库当作当前项目依赖。
- 固定版本添加、升级、移除；传递依赖约束求解，优先保留兼容的已有版本。不兼容、下载失败、取消或配置被外部修改时保留原 profile。
- YAML AST 保留注释与其他配置，使用同目录临时文件和原子替换。Core 库不能单独移除；仍被其他库需要的依赖不能移除。
- 11 个官方 archive 已下载、逐个按官方索引 SHA-256 校验、随资源分发并保留许可证，总大小 1,229,699 字节。
- S3/C3 新项目写入验收后的固定依赖；其他芯片继续最小 profile，已有项目不被自动改写。

库包包含 ArduinoJson 7.4.3、ArduinoMqttClient 0.1.8、Adafruit SSD1306 2.5.17、GFX 1.13.0、BusIO 1.17.4、NeoPixel 1.15.5、DHT 1.4.7、Unified Sensor 1.1.15、OneWire 2.3.8、DallasTemperature 4.0.6、ESP32Servo 3.2.1。对应原始下载地址、校验值和许可证见资源包 `manifest.json`。

## 实测结果

| 检查 | 结果 |
|---|---|
| ESP32-C3，全部 11 库的 API 调用复合程序 | 编译 / 链接通过；Flash 497,652 B，RAM 22,924 B |
| ESP32-S3，同一程序 | 编译 / 链接通过；Flash 472,633 B，RAM 31,704 B |
| C3 缓存离线重编 | 新构建目录，HTTP / HTTPS / ALL_PROXY 指向无监听的 127.0.0.1:9；通过 |
| 库事务与工程生成测试 | 15 / 15 通过 |
| 真实传感器 / OLED / 舵机 | 未连接，未声称验证 |

Core 为 3.3.12，CLI 为 1.5.1，主机为 darwin-arm64。离线测试验证已准备 Core 与 profile 资源后的重编；不声称空白机器无需 Core 资源即可离线编译。

OneWire 上游两条 `#undef` 警告、ESP32Servo 在 S3 的 legacy MCPWM 弃用警告均保留；未改上游代码或隐藏警告。

## 真实编译发现的问题

macOS 上把 CLI 数据目录设为 `/tmp/...`、编译器返回路径却是 `/private/tmp/...` 时，CLI 1.5.1 会把 profile 库加到头文件搜索路径，却漏掉其源文件编译，最终大量 undefined reference。仅 Core 的串口示例不能暴露这一问题。

将 CLI 配置中的 data / downloads / user / cache，以及项目、构建路径统一为 realpath 后，11 库全部被实际编译，C3/S3 均通过。服务端必须保留该路径规范化，不能把此错误误诊为某个库不兼容。

证据目录为 [esp32-library-acceptance-20261026](esp32-library-acceptance-20261026/)，含编译源文件、双芯片日志、离线日志、测试输出与 SHA-256 清单。库管理后端文件为 `desktop/scope-extension/src/node/nodu-arduino-libraries.ts`；前端侧栏与主服务由集成项单独验证。
