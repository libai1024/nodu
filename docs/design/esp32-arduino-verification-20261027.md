# ESP32 Arduino 工作流验收

更新：2026-10-27。代码位于 `codex/nodu-02-integration` 工作区。本报告仅覆盖本轮 Arduino 实施；保留其他 AI 的既有修改，未创建提交或操作实体开发板。

**同日追加：固定版随包环境。** 根据用户“下载安装即带基本环境、不联网更新开发板索引”的要求，已补发布资源生成、完整性校验、本地首次初始化、原生 ARM64 ctags 和库索引兼容。Mac ARM64 全新目录在系统禁网条件下完成 C3 / S3 全部 11 库编译与 C3 复开重编；完整 Arduino 回归增至 **117/117**。首次本地初始化实测 60.102 秒；正式安装包和其他系统尚未验收，发行源码材料仍有缺口。详见 [随包方案](esp32-arduino-bundled-environment-20261027.md)、[干净离线验收](esp32-arduino-offline-acceptance-20261027/README.md)。以下 99 项测试等数字保留为早一轮工作流验收的历史结果。

## 已接通的使用流程

新建 ESP32-S3 / C3 → 默认 Arduino（保留 ESP-IDF Logo 选项）→ 标准 .ino 工程 → 左侧库管理 → 编辑器补全与问题定位 → 编译 → 使用当前产物烧录 / 编译并烧录 → 底部串口。

设备弹层、极简主操作、专业工具栏、底部输出与问题面板沿用 K210 / STM32 的界面位置和操作习惯。串口参数与板卡构建参数独立保存。设置的默认自动保存、文件/代码引用、问题复制继续使用原有入口。

Arduino CLI 1.5.1 缺失时会从固定官方归档准备并校验；Core 固定 3.3.12；新 S3/C3 工程使用已归档的 11 个常用库。上传使用 Core 官方生成的配方与 Flash 清单，校验工程、配置与固件身份，具备取消、进程回收及串口借出/恢复。

## 自动验证

各组用例有重叠，不能相加为独立测试总数。

| 测试组 | 结果 | 证据 |
|---|---:|---|
| Arduino 服务、上传、库、前端、语言配置、生成器与启动器 | 99 / 99 | `esp32-arduino-acceptance-20261027/arduino-tests.txt` |
| 工作台回归 | 126 / 126 | `esp32-arduino-acceptance-20261027/workbench-tests.txt` |
| 串口回归 | 29 / 29 | `esp32-arduino-acceptance-20261027/serial-tests.txt` |
| 本轮 UI 修复（含编译时参数锁、离线端口） | 36 / 36 | `esp32-arduino-acceptance-20261027/ui-regression.txt` |
| 对话引用相关回归 | 131 / 131 | `esp32-arduino-acceptance-20261027/context-regression.txt` |
| Arduino 结构化上下文补测所在组 | 83 / 83 | `esp32-arduino-acceptance-20261027/arduino-context-profile.txt` |
| 原生串口与已有 STM32 服务 | 45 / 45 | `esp32-arduino-acceptance-20261027/native-tests.txt` |

串口租约单独覆盖7项：独占、恢复取消竞态、USB端口名称/PID变化、身份歧义、原生服务退出及迟注册失联回调。上传 helper 单独13项覆盖完整板卡参数、产物所属工程、地址/映像校验、取消与错误端点。它们已包含在 Arduino 测试组中。

TypeScript 编译、原生 macOS ARM64/x64 构建、插件构建、语言工具校验和 Electron 前端/后端/main 构建通过。一次完整 `build:electron` 的既有媒体资源重建在下载 FFmpeg 依赖时发生网络失败，记录保留为 `full-build-media-fetch-failure.txt`；已有媒体资源未改变，之后分别完成本轮相关构建及 Electron 应用构建。此次没有生成新的正式分发安装包。

macOS 签名会改变语言工具二进制字节；打包流程已在内部程序签名之后、整个应用签名之前刷新实际摘要并保留构建与源码身份。临时真实 ALS 副本签名及清单更新测试1/1通过，原资源未改；详见 `esp32-language-acceptance-20261027/package-signing-tests.txt`，此项不替代正式安装包验收。

## 实际编译、模拟器与编辑器

- 两芯片的 Hello 工程和包含11库的组合代码经过真实 CLI 编译。内置库缓存环境断网编译通过，详见 [库验收](esp32-library-verification-20261026.md)。
- 使用真实 Nodu 服务从新 C3 工程移除 ArduinoJson、确认列表和 profile 更新、再添加7.4.3、恢复11项依赖并编译 JsonDocument 串口示例。未修改库的注释和外围配置保持原样，见 [库服务闭环证据](evidence/esp32-arduino-library-service-20261027/)。
- 官方 ESP-EMU 0.46.0 完成两芯片重复 ROM 写入、独立4MiB读回、逐段比较、保存Flash与重启Hello；故障项包含错芯片、损坏固件、不可达端点、取消，详见 [上传验收](esp32-arduino-upload-notes-20261027.md)。
- 额外从真实 Nodu 服务执行 configure→compile→upload：C3修改 FlashFreq/DebugLevel，S3修改 CPUFreq/FlashMode/DebugLevel，全部通过。完整参数与 CLI 保存的 FQBN 一致，详见 [服务集成验收](esp32-arduino-config-service-verification-20261027.md)。
- ALS/clangd 两芯片均提供91项 Serial 补全、ArduinoJson悬停、原 .ino 定义跳转及未保存代码精确诊断。针对上游 UTF-16 与多行映射缺陷，随包提供可重现构建的 `0.7.7-nodu.1` 修补版、对应源码、补丁和许可。
- 最终真实协议验证：C3/S3 函数体多行粘贴后的悬停分别56/78ms；12次40ms间隔中文/emoji修改到正确悬停565/566ms；新错误仍定位到原 `.ino` 第11行。整文替换后新位置悬停和补全正确，但需要重新索引，暖缓存本次为13.9/17.7秒，之前一次为33.6秒。复杂宏、顶层声明和其他不确定结构采用保守重同步，不能将普通编辑速度泛化为所有编辑。详见 [语言服务验收](esp32-language-verification-20261027.md)。
- GUI 又暴露了“回车→粘贴”进入重同步后提前放行旧结果的队列竞态，已补真实中间件测试：精确重放后，插入点后方 `JsonDocument`、`serializeJson`、`loop` 的行号及内容分别在76/92ms正确；已有后台索引时整份替换→撤销→重做，32.36秒后才放行当前内容。测试直接使用产品的排队、180ms合并与同步门控逻辑，见 [中间件协议证据](esp32-language-acceptance-20261027/middleware/result.json)。首次失败截图和日志保留在 Electron 证据中。

模拟器没有连接实体串口。实际 USB 枚举、自动 BOOT/RESET、CDC 电气行为与无线/传感器等外设仍需真板确认；不能用编译或 TCP ROM 下载代替这些验收。

## 真实 Electron 验收

使用独立应用、独立配置与测试项目，端口24385；用户原有24379预览未操作。真实新建C3、默认库profile、左右面板、板卡参数保存、编译错误行列定位、ArduinoJson编译成功、单条/全部问题复制、串口参数保存与重启保留均已完成。

审查覆盖专业/极简、浅色/深色及约987×727窄窗口。独立设计审查结论为 ship。最终插件的真实窗口复验已通过：开启自动保存，精确回车→粘贴后 `JsonDocument`、`serializeJson`、`loop` 均对应新位置，悬停命令到可读结果约0.5秒（含界面操作耗时）；已有后台索引时全文粘贴→撤销→重做，22.6秒时仍等待，46.6秒观察到新第19行正确悬停，随后第22/26行符号、Serial方法补全及23:3错误定位均正确。该耗时是本机此序列的观测，整份替换尚不能视为即时响应。

最新截图、问题复制文本、最初语言故障与修复后的复验记录集中在 [Electron证据目录](arduino-electron-acceptance-20261027/)，截图29–34覆盖最后的连续编辑和整份替换场景。语言报告另记录了短暂的文档符号内部范围异常观测，没有把悬停/补全通过扩大成所有提供器完全无瞬态。

最后在真实工作台编译保留源码成功：Flash 282534字节、RAM 13208字节，0问题，截图35留证。独立24385测试应用与跟踪的10个衍生进程均已退出，成功源码保留；清理证据见该目录 `cleanup.json`。没有操作用户24379预览，也没有替换原预览或生成新安装包。

## 决策与后续范围

详细交互、UART/HardwareCDC/TinyUSB/DFU/OTA/JTAG区分、串口身份恢复及资源隔离依据见 [实施决策](esp32-arduino-decisions-20261027.md)。当前仅实施 Arduino 主路径，保留 IDF 新建入口；教程不在本轮范围。
