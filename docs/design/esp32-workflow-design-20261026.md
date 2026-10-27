# Nodu ESP32 开发全流程设计

日期：2026-10-26。范围：ESP32-S3 / ESP32-C3 优先，Arduino 为默认框架，保留 ESP-IDF 新建入口；不包含教程系统。

本文保留完整设计与后续验收约定。实施状态更新于 **2026-10-27**；目标行为不自动等同于已在真板验证。

**最新产品要求：**基础 Arduino 环境随 Nodu 下载一起交付，固定 CLI / Core / 常用库版本，不联网更新开发板索引。首次打开只做本地初始化；完整约定和新增验收见 [固定版随包环境](esp32-arduino-bundled-environment-20261027.md)。此要求优先于本文早期“首次使用再下载工具”的设想。

### 当前实施状态

- 已实现 Arduino / ESP-IDF Logo 选择、默认 Arduino、标准 `.ino` / 固定 profile，以及左侧 Arduino 库管理。
- 11 个常用库已归档并写入新 S3/C3 工程，保留固定版本、依赖闭包、校验与许可；双芯片实际组合编译及缓存环境离线编译通过。
- 两种模式沿用 K210 / STM32 的设备入口、主工具栏和底部输出/串口/问题面板。编译、现有产物烧录、编译并烧录、停止接入真实服务。
- CLI 固定版本准备、独立环境、动态板卡选项、上传/监视串口分离、原生端口租约、取消/恢复、源与产物指纹校验已实施。
- C3/S3 已在官方 ESP-EMU 完成实际 ROM 写入、读回校验、持久化与重启运行；物理 USB 与外设行为不能由模拟器代替真板验收。
- Arduino 编辑器服务接入独立 ALS/clangd，`.ino` 文件与行号引用接入原有 AI 提问流程；教程排除。

最新决策、上传路径与边界见 [实施决策](esp32-arduino-decisions-20261027.md)；具体测试见 [库验收](esp32-library-verification-20261026.md)、[模拟上传验收](esp32-arduino-upload-notes-20261027.md) 和 `arduino-electron-acceptance-20261027/`。下文普通 sketch 导入、ZIP 库、固件导出等仍为后续扩展约定。

## 1. 产品决策

用户只需要理解“项目、开发板、端口、编译、上传”。Arduino CLI、Core、FQBN、上传配方和依赖缓存由 Nodu 管理；项目设置中允许查看其准确值，但不把这些概念变成新建流程的必填项。

- 新建 ESP32 项目时，框架使用并列的 **Arduino Logo + Arduino**、**Espressif Logo + ESP-IDF** 两项，默认 Arduino。使用官方可识别图形、保持比例；可访问名称由文字提供，Logo 不重复朗读。
- 切换框架只改变未创建项目的选项与模板，不改写任何已有项目；芯片不兼容时保留可用选择并要求重新选择不可用项。
- Arduino 的首批完整验收目标为 S3、C3；其他 ESP32 型号是否可选取决于已安装 Core 的实际支持，不把已有芯片目录等同于全部板卡验收通过。
- 保留 ESP-IDF 当前工程生成与任务路径；后续以独立 IDF 适配器管理环境，不把 Arduino 工程重命名成 IDF 工程。
- 两种工作台模式共享同一组操作、位置和状态。所有选择器使用 Nodu 自有组件，不出现系统下拉框。
- 界面仅保留名称、数值、操作和真实状态，不增加常驻教学段落。错误发生时给出具体原因与可执行操作。

## 2. 一次完整使用过程

### 新建

对话框依次为：芯片系列 → 芯片 → 框架 → 项目名 / 位置 → 模板。Arduino 默认“空白工程”，提供“串口输出”最小可运行模板；这两项是开发起点，不是教程内容。新建不能依赖联网成功，也不能因尚未安装工具链而丢失用户填写内容。

板卡精确选择放在新建后的工具栏：初始显示与芯片相符的通用 Dev Module；用户首次选定具体商品板时保存到项目 profile。芯片名称不能推断 Flash、PSRAM、LED 引脚或 USB 接口。板载 LED 示例只对已验证型号提供，避免把 S3/C3 一律写为 GPIO 2。

框架控件建议高度 32 px，图形约 18–20 px，名称与图形间距 6 px；两项按内容分配宽度，总宽不填满整行。板卡与端口触发器限制最大宽度，长名称省略，展开后显示全名。焦点、选中和忙碌状态使用现有主题变量；深浅主题及 400 px 窄侧栏均检查。

### 编辑与准备

创建后直接打开主 `.ino`。编辑器可输入，基础环境从随包资源在本地自动初始化，随后启动补全。首次编译不要求下载开发板支持包或手动准备。任务区只显示真实阶段，支持取消和重试，不制造总进度百分比；用户主动添加额外库时才显示相应下载进度。

自动保存默认开启，用户关闭后保持其偏好。点击编译或上传时，先保存**当前项目**的已修改源文件和配置；保存失败即停止，定位失败文件，不悄悄编译磁盘旧版本，也不保存另一个工作区的文件。未命名文件必须先归入项目才能参与构建。

Arduino 使用同目录的 `.ino`、`.h`、`.cpp`；可添加文件、重命名、跨文件跳转。主 `.ino` 与项目目录同名。项目重命名作为成对操作，更新主文件与 Nodu 元数据，不留下仅目录改名的无效 sketch。[Arduino Sketch 规范](https://docs.arduino.cc/arduino-cli/sketch-specification/)

### 编译

工具栏只需 `开发板 ▾`、`端口 ▾`、`编译`、`上传`；忙碌时同位置提供停止操作。编译不会关闭串口。输出进入现有输出面板，源错误进入常驻“问题”页签，支持跳转、复制单条、复制全部与 AI 引用。环境错误单独标明来源，不伪造成源文件错误行。

编译结果保存源码、配置、工具与依赖指纹。编译中用户编辑文件时结果立即视为旧版本；不要展示当前源码已成功编译，也不要继续自动上传旧产物。再次编译只需一次点击。

### 上传

默认上传执行“保存 → 编译 → 校验目标 → 释放目标串口 → 上传 → 恢复原串口”。编译失败不会打断用户正在看的串口。串口处于发送中时等待该写操作完成或明确取消，不能一边写入用户数据一边切换到烧录器。

上传参数由锁定 Core 的官方板卡配方生成；完整写入 bootloader、分区表和应用，不自行假设通用地址。Arduino CLI 的 `upload` 本身不编译，因此串联必须由 Nodu 保证。[CLI upload](https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_upload/)

未选端口只展开端口选择，不弹出泛化报错。连接失败才显示具体 BOOT / RESET 操作与“重试”。上传前串口未打开则不自动打开；先前打开时，仅在设备身份能唯一匹配且用户未切换项目/端口时恢复。结束状态区分“上传完成”和实际运行输出，不用成功退出码宣称程序已经运行。

## 3. 开发板与端口

| 配置层 | 保存位置与行为 |
|---|---|
| 芯片与框架 | `nodu.json` 记录工程类型和芯片，框架由类型明确表达 |
| 板卡与选项 | `sketch.yaml` 的 profile 为唯一权威；工具栏、编译、上传和语言服务共同读取 |
| 本机端口 | 本机项目状态保存；默认不把 `/dev/cu.*` 或 COM 号提交进可移植项目 |
| 串口显示 | 波特率、编码、行尾、HEX、自动滚动作为监视器偏好；上传速率与监视波特率分开 |
| 实际设备身份 | 连接会话记录 VID/PID、序列号、位置等可用信息；仅端口名相同不足以确认同一块设备 |

板卡选择器先列最近使用和当前芯片板型，支持搜索；端口选择器列端口短名、设备名和连接状态。空列表可刷新，设备拔出保留选中项的离线状态，不能自动跳到另一块板。

高级板卡参数按 `board details` 动态生成，只显示该板型实际具有的枚举选项；持久化前验证值。更换板卡重新计算默认值，并清除不再适用的选项；Core 升级不沿用已经移除的菜单值。[board details](https://arduino.github.io/arduino-cli/1.5/commands/arduino-cli_board_details/)

S3/C3 的 USB-UART 与原生 CDC 分别验收。C3 的原生 USB 仅有 CDC、不提供 DFU，但仍可使用外置 USB-UART；S3 首期采用 UART0 / Hardware CDC，DFU 不作为首期串口开发路径。原生 USB 与外置 CH340 / CP210x 的选项不可互换。[Espressif USB 说明](https://docs.espressif.com/projects/arduino-esp32/en/latest/tutorials/cdc_dfu_flash.html)

## 4. 工程、工具版本和隔离目录

调研基线为 **Arduino CLI 1.5.1 + Arduino-ESP32 3.3.12**。前者为当前稳定发布，后者为当前稳定 Core；不采用 1.5.2-rc.1 或 4.0.0-RC1。这是待 Nodu 验收的固定组合，不是仅凭上游稳定标签即可承诺的 Nodu 兼容结论。[CLI 1.5.1](https://github.com/arduino/arduino-cli/releases/tag/v1.5.1)、[Core 3.3.12](https://github.com/espressif/arduino-esp32/releases/tag/3.3.12)

本机只读检查结果：`/opt/homebrew/bin/arduino-cli` 为 1.5.1；用户默认目录 `/Users/wangwei/Library/Arduino15` 只有 `arduino:avr@1.8.8`，未列出 ESP32 Core 和已安装第三方库。本次文档调研未安装或改动这些资源。

进一步发现：`/Users/wangwei/.local/share/bysj-common-app/arduino` 是另一套独立环境，其中已有 ESP32 Core 3.3.12 与编译器下载缓存；两者不可混为同一个 Arduino 安装目录。当前实现默认隔离根为 `~/.nodu/arduino`，允许 `NODU_ARDUINO_HOME` 指定测试环境；发行版迁移到下述应用数据目录时须保留已有缓存与版本。

拟采用以下分层，具体根路径由应用数据目录服务生成，不硬编码用户名：

```text
Nodu/arduino/
  bin/<cli-version>/<host>/
  config/arduino-cli.yaml
  data/                        # Core、索引、profile 隔离资源
  downloads/                   # 已校验压缩包
  user/                        # Nodu 自身的非 profile 用户资源
  cache/build/                 # 可安全重建的编译缓存
  bundles/<bundle-version>/    # 资源包清单、校验值、许可证

MyProject/
  MyProject.ino
  sketch.yaml
  nodu.json
  .gitignore
  .nodu/                       # 本机运行状态和构建产物，忽略提交
```

每次调用显式指定 Nodu 的 CLI 配置；覆盖或清理继承的 Arduino 路径环境变量，避免用户 shell 配置改变实际资源位置。使用 `directories.data/downloads/user` 和构建缓存配置隔离资源，保持用户 Arduino IDE 的安装不变。[CLI 配置](https://docs.arduino.cc/arduino-cli/configuration/)

标准 `sketch.yaml` 固定 FQBN、Core 和依赖版本；`nodu.json` 保存 `kind: esp32-arduino`、芯片与 Nodu UI 元数据，不能再复制一份 FQBN。主配置缺失或无效时明确报配置错误，不自动猜测另一芯片。

**profile 的关键约束**：CLI 使用 profile 时排除全局安装的 Core 和库；缺少资源会下载到 data 内的隔离区域。因此不能仅把常用库放进 `user/libraries` 就宣称 profile 项目可以直接引用。资源准备必须针对实际 profile 运行并在断网状态重验。[Sketch profile 规则](https://docs.arduino.cc/arduino-cli/sketch-project-file/)

后端使用参数数组启动 CLI，不拼接 shell 命令。一次编译绑定固定项目快照与任务 ID；响应同时携带项目路径、代际和任务 ID。切换项目后的迟到日志、成功结果、诊断或串口重连都不能修改新项目。

## 5. 常用库如何真正“内置”

### Core 自带，直接可用

WiFi、HTTPClient、WebServer、Network / NetworkClientSecure、Wire、SPI、Preferences、EEPROM、FS、LittleFS、SD、SD_MMC、ArduinoOTA、Update 等来自官方 Core。它们随 Core 一起锁版本，在库面板标记“内置”，不重复下载安装同名第三方库；实际展示依据当前目标能力过滤。BLE / Bluetooth 等也不能因目录存在就向所有芯片承诺支持。[Core 3.3.12 的 libraries](https://github.com/espressif/arduino-esp32/tree/3.3.12/libraries)

### 默认资源包候选

下表版本已从上游 release 与该 tag 的 `library.properties` 核对。这些固定版本已完成 Core 3.3.12 双芯片组合编译，真实外设行为仍待真板验证。`architectures=*` 只影响匹配规则，不足以证明在特定芯片上工作。[Arduino 库元数据规范](https://docs.arduino.cc/arduino-cli/library-specification/)

| 用途 | 库与固定候选版本 | 显式依赖 / 发布处理 | 上游许可证依据 |
|---|---|---|---|
| JSON | [ArduinoJson 7.4.3](https://github.com/bblanchon/ArduinoJson/releases/tag/v7.4.3) | 默认采用 7.x API；不自动把旧工程 6.x 升成 7.x | MIT |
| MQTT | [ArduinoMqttClient 0.1.8](https://github.com/arduino-libraries/ArduinoMqttClient/releases/tag/0.1.8) | 使用 Core 的网络 Client，另验 TLS 与重连 | LGPL-2.1 |
| OLED | [Adafruit SSD1306 2.5.17](https://github.com/adafruit/Adafruit_SSD1306/releases/tag/2.5.17) | GFX 1.13.0，不能仅装主库 | BSD-3-Clause，按 tag 的 `license.txt` |
| 显示依赖 | [Adafruit GFX Library 1.13.0](https://github.com/adafruit/Adafruit-GFX-Library/releases/tag/1.13.0) | BusIO 1.17.4 | BSD-2-Clause，按 tag 的 `license.txt` |
| 总线依赖 | [Adafruit BusIO 1.17.4](https://github.com/adafruit/Adafruit_BusIO/releases/tag/1.17.4) | 使用 Core Wire / SPI | MIT |
| RGB 灯 | [Adafruit NeoPixel 1.15.5](https://github.com/adafruit/Adafruit_NeoPixel/releases/tag/1.15.5) | 单独验收 S3/C3 时序与实际灯珠 | LGPL-3.0-or-later |
| 温湿度 | [DHT sensor library 1.4.7](https://github.com/adafruit/DHT-sensor-library/releases/tag/1.4.7) | Unified Sensor 1.1.15 | MIT |
| 传感器依赖 | [Adafruit Unified Sensor 1.1.15](https://github.com/adafruit/Adafruit_Sensor/releases/tag/1.1.15) | 随使用者一起锁定 | Apache-2.0 |
| 单总线 | [OneWire 2.3.8](https://github.com/PaulStoffregen/OneWire/releases/tag/v2.3.8) | 检查 Core 3.x GPIO 接口兼容 | MIT，按 `OneWire.cpp`，同时保留逐文件许可 |
| DS18B20 | [DallasTemperature 4.0.6](https://github.com/milesburton/Arduino-Temperature-Control-Library/releases/tag/v4.0.6) | 显式锁 OneWire 2.3.8；该版本 properties 未声明 depends，不能只依赖自动解析 | MIT |
| 舵机 | [ESP32Servo 3.2.1](https://github.com/madhephaestus/ESP32Servo/releases/tag/3.2.1) | 验收 S3 MCPWM / C3 LEDC 及资源冲突 | LGPL-2.1-or-later，按 `src/ESP32Servo.h` |

许可证表用于打包清单追踪，不代替每个实际分发文件的核对；依赖原始许可随包交付，不只保存 GitHub API 推测的 SPDX 值。

完整库包阶段，把通过验收的上述精简集合写入新工程 profile；依赖项标记为 dependency，版本全部固定。用户复制常见示例的 `#include` 后即可编译，不再经历“声称内置但需要手动安装”的断点。无需引用的库不主动插入源文件，也不强行参与固件逻辑。

当前**新 S3/C3 工程**使用已验证的完整 bundle；已有项目保持其 profile，用户可选择添加常用包。不能在打开旧工程时静默写入十几个依赖。

资源包保存准确包名、版本、上游下载地址、SHA-256、依赖闭包、许可文件、S3/C3 测试记录和最小编译样例。通过测试后产出内容不可变的 bundle 版本；应用更新不自动更换旧项目依赖。CLI 的 package/library index 与压缩包都应进入离线安装验收，不手动依赖未经支持的内部缓存路径。

### 按需库

FastLED、U8g2、TFT_eSPI、LVGL、大型摄像头 / 语音 / AI 库按需添加。它们通常带硬件配置、内存或构建要求，不适合无差别塞进每个新项目。需要时可内置其目录条目与已验收版本，不把“目录可搜索”描述成“离线已安装”。

PubSubClient 可保留兼容安装，但不作为新项目默认推荐：上游 README 已明确停止维护。旧工程锁定的 2.8 不被自动替换，迁移需改代码与验证。[PubSubClient 上游说明](https://github.com/knolleary/pubsubclient)

### 左侧库管理侧栏

**主入口放在左侧活动栏**，以库图标打开常驻库管理侧栏，布局参考 Arduino IDE 的 Library Manager。它与文件抽屉切换，聊天侧栏保持原位置；不用先进入设置才能找库。Arduino 工程启用此入口，ESP-IDF 工程不展示 Arduino 安装操作，避免把两套依赖系统混在一起。

面板从上到下为“库”标题与刷新按钮、搜索框、紧凑筛选 `全部 / 已安装 / 可更新 / 预装`，下方为可滚动列表。搜索同时匹配库名、作者和关键词；当前查询、筛选与滚动位置在收起后保留，切换项目后重新计算该项目已安装/使用状态。

每项显示库名、作者、已选版本、简短用途摘要和一个主要操作；摘要只表达库本身用途，不加“你可以在这里……”等提示。默认约 3 行，不采用大卡片、宽按钮或多重描边。库名长时省略并可查看全名；依赖和版本选择按需展开，用自有弹层，支持键盘操作。

`预装` 表示 Nodu 已交付并验收的资源包，`项目使用` 表示当前 profile 引用，二者分开表达：缓存里存在不等于该 profile 能使用。用户点击“安装”作用于当前项目依赖和所需缓存，安装完成显示确切版本及“移除”；Core 自带库不允许单独卸载。下载进度仅显示在对应行，失败保留原版本并提供重试。

升级和移除作用于当前项目，侧栏固定使用该项目的 Core/芯片解析兼容性。版本与依赖明细可展开，避免在每一行长期堆满技术信息。第一次搜索、无结果、离线、准备中、已取消、失败、安装成功均有确定布局；空态只保留简洁状态和可执行操作。

- 添加：选定确切版本 → 解析依赖闭包 → 准备成功 → 原子更新 profile → 刷新语言服务；失败保留原配置。
- 删除：只移除当前项目依赖；被其他库需要的依赖不删除。已共享缓存不因删一个项目库而被卸载。
- 升级：显示旧版 / 新版，单项目执行；可回退到原 profile。主版本升级不静默进行。
- 冲突：显示请求双方和版本约束；不偷偷选择“最新”。同名头文件多候选必须能追溯最终来源。
- ZIP / 本地库：可导入项目相对目录，拒绝目录穿越；显示本地来源，不冒用官方库名称与已验收标记。
- 缺头文件：问题项提供“添加库”，只在确实匹配单一已知候选时直接提供该库；不根据任意错误文本自动联网安装未知库。

## 6. 后端状态与并发

建议新增独立 Arduino 服务/模型，复用现有输出、问题、文件与串口界面；不要把 STM32 的 `stlink | uart`、备份、BOOT 字段伪装成 ESP32 协议。

```text
idle → saving → preparing → compiling → compiled
                                  ↘ failed / cancelled
compiled → checking-target → lending-port → uploading → restoring-port → done
                                               ↘ failed / cancelled → restoring-port
```

工程构建锁、资源安装锁、物理端口锁各司其职。同一工程不并行构建/修改 profile；共享工具安装串行；不同工程也不能同时持有同一个端口。用户连续点击只启动一个任务，不排队追加多次烧录。

| 场景 | 确定行为 |
|---|---|
| 取消准备 | 停止下载；不发布未校验资源；已完成缓存可复用 |
| 取消编译 | 终止该任务子进程树；不清除其他项目缓存；旧产物不变成新成功产物 |
| 取消上传 | 终止本任务写入并等待进程退出；不能承诺板上可运行；保留“重新上传”操作 |
| 拔线 | 报失联并停止该上传；不自动换一个串口重试 |
| 项目切换 | 旧任务结果归旧项目；当前 UI 不接收旧结果；禁止旧任务恢复新项目串口 |
| 配置变化 | 旧构建指纹失效；编译和上传不混用新旧选项 |
| 资源损坏 | 校验失败后仅重取对应包；不启用 CLI unsafe install 绕过校验 |
| 目标芯片不符 | 上传前阻止并显示实际 / 目标芯片，不能依赖用户读原始工具日志 |
| 端口被外部占用 | 显示具体端口与重试，Nodu 不结束不属于自己的进程 |
| 后台服务退出 | 清理自身锁，停止自动恢复动作；重新连接后重新探测状态 |

Node 服务统一把成功、失败、取消表达为有类型结果；输出有界缓存，批量发事件，避免高速日志让编辑器卡顿。取消仅关联本任务句柄，不能全局杀掉 `arduino-cli`、编译器或 QEMU。

## 7. 编辑、诊断和 AI

Arduino Language Server 基于 clangd，需要传入 CLI、CLI 配置、clangd、板卡等环境。应使用同一 profile 对应的资源；切换板卡或库后刷新语言服务。不能只把 `.ino` 标为 C++ 就宣称补全和行号映射完成。[Arduino Language Server](https://github.com/arduino/arduino-language-server)

编译器诊断优先定位原 `.ino` / `.cpp`，处理 Arduino 预处理中的 `#line` 与生成文件来源；不要把临时 `.ino.cpp` 第 N 行直接跳成用户 `.ino` 第 N 行。[Arduino 构建过程](https://docs.arduino.cc/arduino-cli/sketch-build-process/)

AI 上下文纳入 `.ino`、头文件、profile、目标芯片、依赖版本、已选问题和串口选区；复制、拖入和编辑器片段引用沿用现有准确行号机制。AI 建议新库时可提出依赖变更，但不能默默修改真实板卡、烧录端口或把未编译代码视为已运行。项目配置和日志中的 Wi-Fi 密码、令牌不得默认加入共享诊断包。

## 8. 导入、导出和 ESP-IDF 共存

- 打开标准 sketch：从同名 `.ino` 识别候选；已有 `sketch.yaml` 保持其版本。缺板卡时让用户选择板型，不仅凭 `.ino` 内容猜芯片。
- 打开现有 Nodu IDF 工程：继续显示 ESP-IDF 标记和原任务；不得因新建默认 Arduino 而重新分类。
- 同时有 IDF 与 Arduino 文件：依项目显式元数据 / profile 决定；不清理另一套文件。
- “复制为 Arduino 工程”若后续增加，应创建新目录，不能声称任意 `app_main` 自动等价转换成 `setup/loop`。
- 源工程导出包括源码、profile、必要本地库和许可证；排除构建缓存、本机端口、账号秘密和模拟器镜像。
- 固件导出包括该构建完整写入清单、目标芯片、每段文件/地址/校验值、构建指纹。界面把“导出固件”与“导出项目”明确分开。

## 9. 模拟器验收的边界

本地官方模拟器发现与命令记录见同目录的 `esp32-simulator-discovery-20261026.md`（独立调查）。在读取实际源码和 `-machine help` 之前不承诺它支持 S3/C3；仅支持经典 ESP32 的模拟器不能证明 S3/C3 固件已通过。

测试分三层：① 标准 Arduino 工程真实编译；② 将构建产物按该模拟器要求合并为独立临时 Flash 镜像并启动，验证启动串口和程序行为；③ 若模拟器具有下载 ROM 与可用串口传输，再测试真实上传协议。仅把 `.bin` 复制成模拟镜像是第二层，不冒充第三层串口烧写。

模拟镜像位于独立测试目录，修改前保留基线；不指向用户实体设备、不覆盖现有镜像。模拟器能验证什么取决于外设实现：USB 枚举、自动 BOOT、GPIO 电气时序、无线、真实 OLED/舵机/传感器、断线恢复仍需对应硬件实测。

## 10. 实施里程碑与证据

| 阶段 | 实施范围 | 必须保留的验收证据 |
|---|---|---|
| P0，本轮基础 | Arduino / ESP-IDF 选择与 Logo；S3/C3 标准模板；独立 CLI 配置；编译入口；框架正确识别 | 两框架生成内容测试；K210/STM32 回归；路径含空格；真实编译日志或明确环境阻断 |
| P1，完整编译与库包 | 左侧库管理；固定 Core；准备/取消/离线；内置常用包；依赖锁；源诊断；未保存文件 | S3/C3 串口模板及每个常用库最小程序编译；侧栏搜索/筛选/安装/升级/移除；干净目录安装；断网重编；错误行映射；重复点击/切项目 |
| P2，上传和串口 | 板卡选项；端口识别；官方上传配方；串口借出/恢复；模拟器支持的环节 | 同一产物到模拟器的记录；S3/C3 真板首次/重复上传；USB-UART/CDC；BOOT；拔线；取消；多设备 |
| P3，编辑闭环 | Language Server；新文件/重命名；导入/导出；AI `.ino` 引用；库升级回退 | 未保存内容补全；跨文件跳转；板卡/库切换；profile 外部编辑；旧项目重开；引用行号准确 |
| P4，发布资源包 | macOS/Windows；签名工具；离线资源；版本迁移和清理 | 每 host 的包校验与许可证清单；断网安装；旧项目仍使用旧工具；资源损坏恢复；卸载不删用户代码 |

### 最小测试矩阵

| 维度 | 必测组合 |
|---|---|
| 工程 | S3 / C3 × Arduino / ESP-IDF；旧 IDF；普通 sketch 导入；不支持型号 |
| 保存 | 自动保存开 / 关；保存失败；编译中修改；配置变更；项目切换 |
| 构建 | 干净安装 / 已缓存 / 离线缺包；编译错误；链接错误；取消后重编 |
| 库 | 直接 / 传递依赖；同名头文件；旧主版本；损坏包；本地库；移除仍被引用的依赖 |
| 设备 | 0 / 1 / 多块设备；同型号两块；错芯片；端口被占；上传后换端口 |
| 串口 | 原先开 / 关；有发送进行中；UTF-8 / GBK；TX 回显；HEX；上传取消/失败后的恢复 |
| UI | 深 / 浅色；极简 / 专业；键盘操作；窄窗口；长板卡名；中文/空格路径 |
| 模拟 | 支持的具体机器与固件格式；镜像写入；启动输出；超时退出；不支持外设明确记录 |

每次报告按“已实现、已自动验证、已模拟验证、已真板验证”分别记录。完整流程只有在对应阶段全部通过后才对用户宣布完成。
