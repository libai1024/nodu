# Windows ESP32-S3 COM 真板验收（2026-10-29）

Windows 本地验证目录已在 `D:\Nodu-ESP32` 构建并运行。使用包内 Electron/Node、Arduino CLI、ESP32 工具链和资源，完成从空 Arduino home 首次打开工程、两轮编译、烧写、Flash 校验、复位运行、串口回显与重新连接。用户已明确允许覆盖板上固件。

本目录是 **本地验证版**。它不是新的正式安装器或云端完整发行包：`releaseReady=false` 和 20 项对应源码材料缺口仍保留，正式 `full` 打包继续拒绝这些输入。既有 Windows STM32 专用包不会因此增加 Arduino 环境。

## 环境与配置

- Windows 10 x64；应用源码提交 `7dbb6db9a6fb726b439e5f1148fae28cfd941624`，版本 0.2.3。本次后续提交只改验收脚本与记录。
- 实体 ESP32-S3 QFN56 rev v0.2，16 MB Flash、8 MB OPI PSRAM。厂商板卡型号未确认，不把容量识别结果当作具体板型。
- 板上 COM 接口 → CH343 → `COM4`；WCH 2.1.2025.7 驱动状态正常，Microsoft Windows Hardware Compatibility Publisher 签名。现有驱动未重新安装；导出的驱动文件附在应用 `drivers/CH343`，管理员可执行随包安装脚本。
- 上传为 UART0 / Hardware CDC，`USBMode=hwcdc`、`CDCOnBoot=default`（关闭 USB CDC On Boot）、`UploadMode=default`；本板测试另选 `FlashSize=16M`、`PSRAM=opi`。
- 串口 115200、UTF-8。只有一个常见 USB/UART 桥时，新工程自动选中；多个桥、原生 Espressif USB 或未知端口保留手动选择。已有端口和显式取消选择不被覆盖。
- 应用、工程、解包工具、缓存及共享服务放在 D 盘；未新增 C 盘开发工具。Windows 自身驱动目录由操作系统管理。

## 包内环境

Arduino CLI 1.5.1、ESP32 Core 3.3.12 及官方完整工具依赖归档、11 个固定版本常用库、Nodu 修订 ALS、clangd 21.1.8、Windows clangd 启动器均放在验证目录中。运行 PATH 仅保留 Windows 系统目录，没有开发者 Node、Python、GCC 或 CMake。

冷启动用动态 WFP 阻止当前 Electron/Node 和受管 Arduino CLI 的非 loopback IPv4/IPv6；外网探针立即返回 `EACCES`。测试没有声称独立阻断所有编译器子进程。CLI 输出中的 `Downloading ... already downloaded` 是从随包归档缓存安装，不代表发生网络下载。首次打开在本地解包耗时 **148.569 秒**。

测试加载器从安装目录中未修改的生产 `lib/backend/main.js` 获取真实模块工厂，抑制启动入口以便调用后端接口；没有另外提供开发者版后端依赖。生产后端 SHA-256 为 `148503def8d255cb40b80fd34772cef1a60f0c62c2e9cc27ed2d2437c47be2ce`。原生窗口另外按正常入口启动，确认便携数据目录与 COM 默认选择。

## 真板结果

测试固件只使用串口，不初始化 GPIO、Wi-Fi、传感器、屏幕或舵机。显式设置 16 KiB UART RX 缓冲，并按换行累积输入。

| 检查 | 结果 |
| --- | --- |
| 空环境首次打开工程 | 通过；包内安装，ready=true |
| 第一轮真实编译、烧写与 Flash 数据校验 | 通过 |
| 修改 APP_ID 后第二轮编译、烧写与校验 | 通过；两份固件 SHA-256 不同 |
| 烧写后监视器自动恢复 | 两轮均通过 |
| 运行程序报告 Flash / PSRAM | 两轮均为 16777216 / 8388608 字节 |
| 随机英文命令回显 | 两轮均通过 |
| 中文命令 UTF-8 回显 | 两轮均通过 |
| 4200 字符消息（4202 字节含 CRLF） | 两轮逐字匹配；发送字节数准确 |
| 关闭、重新打开串口后回显 | 通过 |

证据：[硬件完整结果](hardware-result.json)、[编译和上传输出](build-upload-records.json)、[安装身份](installation.json)。板卡唯一标识不进入选取的公开记录。

## 编辑器与前端

包内 ALS 0.7.7-nodu.1 / clangd 21.1.8 通过实际 LSP 测试，使用生产的增量同步与中间层：91 项补全、定义跳转、原 `.ino` 行列映射、未保存错误诊断、12 次快速中文/emoji 修改、整段替换及保存均通过。多行插入 hover 为 172 ms，连续 Unicode 编辑为 708 ms；整段替换及保存约 30.5 秒，仍有改善空间。[语言服务结果](language-result.json)、[工具来源与哈希](language-tools.json)。

真实交互桌面窗口中，使用 Monaco 编辑并保存测试程序，前端“运行”处理器完成编译与第三次实体烧写（约 85.6 秒），监视器自动恢复；通过前端发送接口验证英文、中文、4200 字符回显。窗口保持打开，演示工程为 `D:\Nodu-ESP32\Data\Projects\s3_com_demo`。证据：[前端运行](gui-run.json)、[前端通信](gui-communication.json)、[窗口截图](windows-gui.png)。

旧行同步直连方式不符合当前插件的增量同步路径，试验中多行修改后的立即 hover 返回空；最终按生产同步与中间层复测通过。窗口检查使用登录用户的交互桌面会话；SSH 非交互窗口的阻塞不计为应用交互结果。

## 排查记录与范围

首次使用共享服务复制、校验工具包可能超过原 30 秒上限，现将冷启动等待放宽为 180 秒，已就绪请求保持原有超时。Arduino 上传的发现等待从 1 秒调整为 10 秒。CH343 驱动不提供序列号时，只在原 COM 路径及 VID/PID 一致的情况下恢复监视器，不猜测新的端口。

早期测试固件使用 100 ms `readStringUntil` 和默认 RX 缓冲，长消息曾被拆开、截断。最后两轮使用明确容量与完整行协议，均通过。首轮安装目录冷测试直接编译且与其他初始化并行，曾报 GCC multiple-input 错误；同样的工具链单独重编译成功。该轮不计为通过，最终重新从空环境按产品首次打开流程串行验收。详见 [试验备注](trial-notes.json)，原始失败日志保留在 Windows 的 `D:\nodu-s3-20261029`。

本页只为该 S3 的 COM 路径提供实体证据；不扩大为 C3、原生 USB、所有串口桥、全部外设或跨平台真板验收。国内网络额外增装库、Arduino IDE 2.3.7 的旧 profile 格式兼容问题没有在本轮修复，继续见[先前软件测试](../windows-esp32-20261029/README.md)。

回归记录：[默认配置与前端](default-tests.txt)、[上传和串口交接](upload-tests.txt)、[打包及服务生命周期](package-tests.txt)。
