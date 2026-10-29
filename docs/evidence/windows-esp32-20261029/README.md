# Windows ESP32 Arduino 实测（2026-10-29）

本页保留真板接入前的软件测试批次。同日后续已接入 S3，补齐包内 Windows 语言工具并完成 COM 真板烧写、通信验收，见[后续硬件记录](../windows-esp32-s3-com-20261029/README.md)。下文的缺板和语言工具缺项是本批次当时的状态。

结论：Windows 上 C3/S3 的随包环境、真实编译和串口基础收发可以工作；当前交付尚不能承诺“安装后完整可用、国内网络增装库正常、原项目直接交给 Arduino IDE 无痛使用”。真板烧写未执行，用户确认目前没有测试板。

## 环境与边界

- 局域网 Windows 10 专业版 x64，10.0.19045；主机 DESKTOP-F2B1361。
- 测试项目、工具、缓存及证据均在 `D:\nodu-esp32-20261029`。复用已存在的 `E:\Develop\Arduino IDE` 2.3.7，其原版 CLI 为 1.3.1。
- Nodu 测试使用本工作区编译后的真实后端服务、固定 Windows 资源包，Arduino CLI 1.5.1、ESP32 Core 3.3.12。Node 依赖复用 D 盘先前的构建目录，没有另装到 C 盘。
- 当前 Windows 已安装的 `D:\Nodu-STM32` 是 STM32 专用版，本身不包含 Arduino 全套环境。后续 Nodu 原生窗口验证通过独立 profile 和环境变量接入本次测试资源，不能当作原安装包开箱验收。
- Windows Arduino bundle 共 2395 项文件，完整性验证通过；`releaseReady=false`，正式分发材料门槛仍未通过。
- 没有物理 ESP32；只检测到已有 com0com 虚拟串口 `CNCA0 / CNCB0`，未安装或改动串口驱动。

## 预装库与离线编译

预装固定版本库：ArduinoJson 7.4.3、ArduinoMqttClient 0.1.8、Adafruit SSD1306 2.5.17、GFX 1.13.0、BusIO 1.17.4、NeoPixel 1.15.5、DHT sensor library 1.4.7、Adafruit Unified Sensor 1.1.15、OneWire 2.3.8、DallasTemperature 4.0.6、ESP32Servo 3.2.1。WiFi、Wire 等由 ESP32 Core 提供。

实际从新建项目生成 11 库 profile；保持未完成源码不变进行初始化，然后用包含全部 11 库 API 调用的程序真实编译、链接。不是只检查文件是否存在。

| 用例 | 结果 |
| --- | --- |
| 全新 Arduino home 初始化 | 通过，131.169 秒 |
| C3 全部 11 库编译 | 通过，212.317 秒；Flash 493652 B，RAM 22924 B |
| S3 全部 11 库编译 | 通过，232.153 秒；Flash 469557 B，RAM 31704 B |
| 新建服务实例，重新打开 C3 编译 | 通过，10.533 秒 |
| 故意编译错误定位 | 通过，返回 `.ino` 文件、行列及错误信息 |
| Windows Arduino 编辑器环境 | 未通过：当前资源缺少对应 ALS/clangd/启动器组合 |

初始化和上述基础编译期间使用 Windows 动态 WFP 规则禁止测试专用 Node 与受管 Arduino CLI 的非 loopback IPv4/IPv6 连接，外网探针返回 EACCES。规则在测试结束后释放；未断开 SSH，也未改动系统代理。此政策没有声明对所有其他程序或全部编译器子进程实施网络禁用。

首轮隔离账号缺少 Windows Known Folder 目录，引起 CLI 警告污染版本 JSON；补齐隔离目录后，重新建立空环境完成上述测试。此测试环境问题与实际产品缺口分开记录。核心记录为 [acceptance.json](windows-run/acceptance.json)，基础批次共 17 项：12 通过、5 未通过。后面三项失败与在线增装库失败存在关联，不能当作三个独立根因。

## 国内网络与额外库

测试的是本 Windows 当前网络，不代表全国所有运营商。系统代理关闭，WinHTTP 为直连；curl 显式使用 `--noproxy *`，保留 TLS 校验。

| 实际请求 | 结果 |
| --- | --- |
| ESP32 官方索引 | HTTP 200，约 0.83 秒 |
| 乐鑫官方极狐国内镜像索引 | HTTP 200，约 0.61 秒；最高列出 3.3.10-cn，未列出项目锁定的 3.3.12 |
| Arduino 库索引 | 完整下载 5.46 MB，约 2.76 秒 |
| ArduinoJson 7.4.3 | 完整下载 517250 B，SHA-256 与官方索引一致 |
| PubSubClient 2.8.0 | 完整下载 44426 B，SHA-256 与官方索引一致 |
| ESP32 Core 3.3.12 GitHub release | 12 秒连接超时，无下载内容 |

这是系统下载工具的结果。**Nodu 实际调用 Arduino CLI 增装 PubSubClient 失败**：HEAD 请求返回 `x509: certificate signed by unknown authority`。使用 Windows 原账号环境、仍把全部包和缓存定向到 D 盘重试，分别出现 EOF 和同样的证书错误，不能仅归因于测试隔离目录。Arduino IDE 自身下载内置库/AVR 环境时也记录了证书错误。没有关闭 TLS 校验或导入新证书。

诊断性对照：将已由系统下载工具完整下载、校验通过的官方 PubSubClient 归档放入测试缓存，Nodu 库管理服务可以添加该库并编译成功。这证明该库及编译链可用，**不代表默认在线下载问题已修复**。组合程序同时包含两个 MQTT 库，出现同名宏重定义警告；仍编译成功。

证据：[网络完整结果](network-results.json)、`windows-run/command-22.log`、`windows-run/normal-profile-download-*.txt`、`windows-run/normal-profile-retry-*.txt`、`windows-run/cached-library.json`。

国内镜像地址来自[乐鑫官方安装文档](https://docs.espressif.com/projects/arduino-esp32/en/latest/installing.html)。当前 Nodu 没有自动切换为该镜像，本次也没有擅自降级 Core。

## Arduino IDE 接续使用

原项目的 `.ino` 是标准 Arduino 源码，但原 `sketch.yaml` 使用 `dependency: Adafruit BusIO (1.17.4)` 等较新 profile 格式。Arduino IDE 2.3.7 的原版 CLI 1.3.1 对 C3/S3 均报：

```text
Can't open sketch: error loading sketch project file:
invalid library reference: map[dependency:Adafruit BusIO (1.17.4)]
```

因此，**当前生成项目不能直接在这版 Arduino IDE 中无痛接续**。界面还可能误导为文件需要移动到同名 sketch 文件夹，尽管项目本来已具有正确结构。

只在 `D:\nodu-esp32-20261029\arduino-compatible` 测试副本中，将 dependency mapping 转为普通固定版本字符串。原生产生成器和原工程格式没有修改，`.ino` 字节不变。转换后的副本能在 Arduino IDE 原生窗口正常打开。另在独立 IDE 环境中预装相同 Core 和 11 个固定库，以区分源码问题和工具环境问题。

原版 CLI 使用 profile 编译转换后的副本，仍会建立独立的 profile 环境、尝试下载索引，受到证书错误阻断；已有普通 IDE 全局 Core 不等于 profile 环境就绪。这也是接续体验需要处理的一部分。

在 Arduino IDE 原生界面选择 ESP32C3 Dev Module 并执行验证，转换后的 C3 副本编译成功：Flash 493790 B、RAM 22924 B。这个结果依赖前述显式环境准备和配置转换；不能回写为原项目直接兼容。S3 本次完成原格式失败验证和 Nodu 编译验证，没有扩大宣称 S3 的 Arduino GUI 编译也已通过。

证据：[原版 CLI 编译记录](windows-run/arduino-ide-compile.json)、[仅配置转换记录](windows-run/arduino-format-compatibility.json)、[转换后 profile CLI 记录](windows-run/arduino-compatible-compile.json)、[Arduino GUI 编译成功](arduino-compatible-verify-success.png)、[GUI 文本结果](arduino-compatible-verify-success.txt)。

## Nodu 原生窗口对照

使用现有 STM32 版外壳及独立 D 盘 profile，通过环境变量接入这次已校验的 Arduino 开发资源和缓存。原生界面打开 C3 工程，执行命令面板中的“Arduino: 编译”，含 12 个库（额外 PubSubClient）的程序编译成功：Flash 494296 B、RAM 23020 B。这个对照验证界面到编译服务的链路，**不是完整新安装包的开箱验收**。

界面同时明确提示“Arduino 编辑器服务未启动”，与语言环境资源检查失败一致。没有把成功编译扩大为补全、诊断等编辑能力验收通过。

证据：[Nodu 原生窗口编译](nodu-ui-compile-current.png)、[编译输出文本](nodu-ui-compile-current.txt)。

## 串口与烧写

使用 Nodu 真实 Node 服务及 Windows 原生 `nodu-embedded.exe`，经过现有 com0com 内核驱动，在两个虚拟 UART 端点之间实际传输数据。

修复后 12 项全部通过：枚举、打开两个端点、UTF-8 中文/emoji、GBK 中文、反向接收、NUL/FF 二进制、LF/CR/CRLF、较长 UTF-8 内容、不能用 GBK 表示的字符拒绝发送、端口独占、主动关闭后拒绝发送、切换波特率重连。

还在 Nodu 原生界面的串口监视器中选择 CNCA0、115200、UTF-8，输入 `Nodu UI 中文回环 OK` 并发送。另一个真实 Windows 原生串口进程在 CNCB0 收到后回送相同字节，界面正确显示 TX 和中文回显。这个用例覆盖了实际界面操作到驱动再返回界面的链路。[界面回环截图](nodu-serial-ui-success.png)、[界面文本](nodu-serial-ui.txt)、`windows-run/serial-ui-peer.json`。

发现并修复了原生服务的实际缺陷：串口 payload 错用通用 4096 字符参数限制，base64 后超过该长度的内容会误报“缺少参数 data”。现在单独按已约定的 64 KiB 解码数据上限检查。增加超 3072 字节、边界 64 KiB、超限和无效数据回归；本机原生 crate 测试 48/48 通过，重新编译 Windows sidecar 后真实虚拟串口测试 12/12 通过。

修改位于 `desktop/native/crates/nodu-embedded/src/service.rs`。更新的 Windows 二进制只用于本次 D 盘测试，未替换用户已安装的程序或生成新安装包。

随包 esptool 5.3.1 在 Windows 能启动。Nodu 对不存在的 COM9999 上传请求返回“所选串口已断开”，没有执行真实烧写。本次没有验证真实 USB 驱动、BOOT/RESET、Flash 写入校验、断电重启运行或实体串口电气链路。

证据：[修复前串口结果](serial-before-fix.json)、[修复后串口结果](windows-run/serial.json)、`windows-run/cached-library.json`。

## 后续交付需要完成的工作

1. 补齐 Windows Arduino 语言工具和插件，制作 full 安装包并在干净机器验收；不能沿用 STM32 专用安装包宣称支持 Arduino。
2. 处理 Arduino CLI 的真实网络/证书失败和 GitHub 下载不可达；镜像版本必须与固定工程版本一致，失败信息应能定位原因。
3. 定义兼容 Arduino IDE 2.3.x 的项目格式与依赖交接策略，避免新格式阻止打开，也避免每个 profile 重复在线准备环境。
4. 接入实体 C3/S3 后补做烧写、复位运行、真实串口和重复烧写测试。

所有测试脚本保留在 `artifacts/windows-esp32-20261029/scripts/`，原始日志与截图在本目录。测试过程未使用 TLS 绕过、未修改用户现有 Arduino IDE 环境，也未进行物理烧写。
