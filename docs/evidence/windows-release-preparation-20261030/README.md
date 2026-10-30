# Windows 完整版发布准备（2026-10-30）

当前状态：源码与本地 ESP32-S3 验收已完成过提交；完整 Windows 安装包尚未发布。不能把此前的本地验证目录、STM32 专用安装器或本次安装器机制测试说成已经交付的 ESP32 正式安装包。

## 已完成

- 完整 Windows 便携包现在与 STM32 专用包一样写入 `NoduPortable.json`，配置、工程、环境解包和缓存留在安装目录的 `Data`。
- 完整包要求同时提供 ST-LINK 和 CH343 驱动文件，并生成两份逐文件摘要清单。安装器支持这两个离线驱动，`/NO_DRIVERS` 可跳过驱动安装。
- 超过 1900 MiB 的 ZIP 拆成每卷最多 1536 MiB 的本地文件，安装器逐卷验证大小与 SHA-256，合并后再校验整个 ZIP，然后用 Windows 系统 tar 解压。没有下载安装阶段，也不需要额外 Python/Node。
- 安装器拒绝本地验证版、脏提交、提交身份不一致、源码材料未通过的完整包。禁止 C 盘安装，卸载保留 `Data`。
- 为 Windows 建立独立的 `arduino-release-sources.win32-x64.lock.json`；原先 Darwin 审查结果不能跨主机授权。Go 模块 ZIP 与根目录许可证现在也可原样收集。

## 实测

在局域网 Windows 10 x64 的 `D:\nodu-release-20261030\installer-test` 运行，临时目录也在 D 盘；构建器为此前已存在的 NSIS 3.12。

- Windows Node 测试：3/3 通过，实际执行 PowerShell 合并，覆盖完整分卷、同长度损坏、缺卷和已有目标文件保护。
- NSIS 机制验收：编译 EXE、静默离线安装、损坏分卷拒绝、卸载保留 Data 成功。另测 `/D=C:\Nodu-Installer-Rejection-Test-20261030`，返回 1，未创建该目录。
- 此次使用小型测试载荷、独立卸载登记和 `/NO_DRIVERS`。这是安装器机制测试，**没有安装完整应用，也没有替代实际 ESP32 离线编译/烧写验收**。
- Mac 打包回归及源码收集器测试结果随本目录保存。Windows 生产应用原来的用户窗口和工程未改动。

## 第三方材料

Windows 锁文件保留 230 个原始归档，约 1217.9 MiB。包括：

- 五个 Go 可执行文件的原始上游 tag；二进制 Go build-info 的提交逐一与 tag 对照。
- 92 份实际链接模块归档，使用 Go 的校验机制下载，并与二进制嵌入的 h1 摘要一致；五个准确 Go 运行时源码版本。
- Windows OpenOCD 额外使用的 zlib 1.2.11、dfu-discovery 使用的 libusb 1.0.26，以及 Windows GDB 的 libiconv 1.19、Python 3.8–3.14 头文件对应源码。
- 固定 ESP-IDF 提交、23 个直接 gitlink、固定摄像头源码和 57 个原始托管组件包。组件注册表的 `component_hash` 与 SDK 依赖锁一致。

目前 **12/25 项覆盖完成，13 项仍未完成**；`releaseReady` 保持 false。剩余项：

1. 两套 GCC 工具链的 Rust 包装器依赖与构建来源核对。
2. esptool 冻结 Python 的精确依赖清单与材料。原始 Windows 构建 run `28231666482` / job `83636648774` 日志已过期，GitHub 返回 HTTP 410；不能用当前 pip 依赖版本代替当时版本。
3. dfu-util `0.11.0-arduino5` 的 Arduino 补丁与构建依赖来源。基础 dfu-util 0.11 源码不等于该定制二进制的完整对应源码。
4. 九个 SoC SDK：虽已保留上述大量原始材料，仍需补查 IDF 嵌套 gitlink、SDK 构建来源，以及只提供二进制的组件许可/声明。SDK ZIP 使用范围读取并逐项 CRC 核验，未完成整个原始 ZIP 的 SHA-256 核验。

完整包发布仍需：完成剩余材料、从干净提交在 Windows 构建、对实际最终安装包做空 Data/离线 C3/S3 编译和 S3 COM 验收，然后上传最终安装器、全部分卷及摘要。此次没有发布新的 Release，没有把验证目录改名为正式包。

此前有效的产品验收见 [S3 真板记录](../windows-esp32-s3-com-20261029/README.md) 和 [桌面修复记录](../windows-desktop-fixes-20261029/README.md)。S3 的编译、烧写、运行与串口验证结论不因分发材料未齐而失效；C3 仍只有软件编译证据。
