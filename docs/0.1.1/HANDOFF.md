# Nodu 0.1.1 交接

日期：2026-10-19。产品 **Nodu · 见微**，主色 `#4F7CFF`，面向嵌入式初学者。当前是 Theia / Electron 开发基线；K210 为首个设备目标，Windows + macOS 为目标平台。

## 当前状态

| 项目 | 状态 |
| --- | --- |
| 新精简界面 | 已完成，macOS 原生与共享浏览器前端验收 |
| K210 REPL、RAM 运行 / 停止、文件、真实相机 | 野火 CAM K210 / GC2145 + MaixPy 0.6.3 验收通过 |
| 图像工具 | ROI、像素、RGB / 灰度直方图、PC LAB、复制、缩放、导出已验收 |
| 身份、完整备份、烧写 | 当前 `DE/E7` 拒绝；容量未认证，未完整备份，未烧写 |
| Windows、其他芯片 | 未实机验收；STM32F103C8T6、ESP32-C3 / S3 为后续范围 |
| 安装器、搭芯联动 | 未交付 |

本版不代表全部 MaixPy / Arduino 功能已完成。实施记录的固件实写任务继续保持未勾选。

## 环境与启动

Node.js 24、npm workspaces、Theia 1.76.0、Electron 42.8.1、React 19、TypeScript 5.9。macOS 需要 Python 3 与 Xcode Command Line Tools；Windows 本机编译需 Python 3 与 Visual Studio C++ Build Tools。

新检出项目，在 `desktop/` 执行：

```sh
npm ci
npm exec -- install-electron
npm run setup:device
npm run build:electron
npm run start:electron
```

设备共享环境为 `~/.nodu/python`，固定 `mpremote==1.25.0`、`pyserial==3.5`、`kflash==1.1.6`，可用 `NODU_PYTHON` 指定解释器。开发机另有 Homebrew 旧回退环境，版本不同，测试须记录实际解释器。

浏览器使用 `build:browser` / `start:browser`，默认 4188；Electron 默认后端 4189。两个目标共享原生依赖，切换涉及 ABI 重建。保留现有未保存编辑窗口，勿直接重建、重启或刷新现场。4193 / 4194 是隔离验收实例，临时路径与端口不是新机器固定入口。详见[开发说明](GETTING_STARTED.md)。

## 界面约定

- 默认只有编辑器；44 px 顶部工具栏统一常用操作。
- 文件按钮控制左树，控制台按钮控制底部输出 / REPL，最右相机按钮控制右侧视觉。
- 设备 chip 统一承载串口、板型、文件与固件；精简模式不重复显示 REPL、日志和停止。
- 模式图标保留在右上角，切换保留编辑器、设备会话、浮层草稿和视觉状态。
- 日志不自动展开控制台；设计理由与过程说明写注释，不铺在 UI。
- 编辑器内 `Cmd/Ctrl+Enter` 运行当前缓冲区，REPL 内只执行 REPL 输入。

细节见[桌面 UI](desktop-ui.md)。实际截图：[编辑器](../../artifacts/ui-minimal/20261019/simple-default.jpg)、[视觉](../../artifacts/ui-minimal/20261019/simple-vision.jpg)、[设备浮层](../../artifacts/ui-minimal/20261019/device-popover.jpg)。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `desktop/scope-extension/src/browser/scope-workbench.tsx` | 工具栏、模式和面板 |
| `src/browser/scope-layout-state.ts`、`nodu-console-widget.tsx` | 模式状态与控制台 |
| `src/browser/nodu-device-client.ts`、`nodu-device-panel.tsx` | 前端设备模型、常驻浮层 |
| `src/browser/nodu-image-*`、`scope-widgets.tsx` | 真实图像工具与视觉面板 |
| `src/common/nodu-device-protocol.ts` | 共享 RPC 协议 |
| `src/node/nodu-device-server.ts` | RPC、worker 生命周期、串行请求 |
| `resources/nodu_device_worker.py` | 持久 worker、串口、保全与校验 |
| `resources/nodu_firmware.py`、`nodu_flash_protocol.py`、`nodu_flash_probe.py` | 固件、协议、固定 RAM reader 加载 |
| `desktop/scripts/` | 启动、设备环境与原生资源复制 |
| `desktop/examples/gc2145-camera/` | 单文件相机示例；当前板 RAM 运行 30 帧通过 |
| `tools/flash-probe/` | 固定源码、构建、许可、map / 反汇编及审查 |

`src/`、`resources/` 简写均相对 `desktop/scope-extension/`。内部 `scope-*` 与旧启动脚本名保留兼容。

## 硬件现场与接续

物理板为野火 CAM K210 / GC2145，CH340 USB 桥，当前端口曾为 `/dev/cu.usbserial-3120`，接手时重新枚举。`Sipeed_M1` 是固件架构字段，不是实体板卡厂家。普通通道为 115200 raw REPL，`soft_reset=False`、`ide=False`，同一串口只允许一个 owner。

第五次 App 操作完成当前 session 的 21 文件、目录、boot 和前 16 MiB 范围保全。缓存经当前远端完整 SHA、本地原件与新副本核验，不继承旧认证。首个 `DE` 收到 2 B `DE E7`：9F / 90 函数取得指定数量 RX 字节，但联合白名单拒绝。短错误帧无 CRC，实际 ID 未返回，尚不能区分芯片不匹配或读回异常。

返回后已恢复普通 REPL，手工顺序 SHA 复核 21/21 文件、目录、boot 和 prefix 全一致，串口归还。首版手工脚本交错两个硬件 SHA 上下文产生无效摘要，已用串行重读更正并保留证据。现役 worker 的 probe 异常分支仍只自动恢复 REPL，自动原件复核尚待补齐。

后续顺序：

1. 补齐 probe 错误分支的有界原件复核及负例，保留原阶段异常、取消、超时与容量门禁；取消后不强制长检查。
2. 阅读隔离 [E7 候选](../../tools/flash-probe/e7-diagnostic-candidate/README.md)及[复审](../../tools/flash-probe/e7-diagnostic-candidate/review.md)。候选仅离线构建 / 测试；11 B 帧返回已读五字节与 CRC，状态仍 E7，认证标志恒 false，**未激活或加载硬件**。
3. 重新核源码 pin、执行计划和当前原件，再做有界诊断；不盲重试、不改白名单、不增加写状态的 SPI 命令。
4. 当前 ID / 容量有效且返回后原件检查通过，才重新读取完整 Flash、核对全部文件、验证恢复包，再做官方固件烧写与回读 / 文件 / 相机回归。

16 MiB 始终只是保全范围，不能冒充完整物理备份。详见[执行计划第 13 节](flash-probe-execution-plan.md)和[第五次记录](../../artifacts/flash-probe/20261019/app-execution/fifth-attempt.json)。

| 固定项 | SHA-256 |
| --- | --- |
| 现役 worker | `69a37c3508caaf7746e35d8bc4dd68d9fe4e7199aaaf205aabdce4ce0bc52ec4` |
| 现役 host | `2dfdacb7648efacaac1ba47d465ea06d498c809de5a9dc68e9cb787364133c9a` |
| 现役 BIN，8,672 B | `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05` |
| 隔离 E7 BIN，8,792 B | `f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874` |

工具目录中“未执行”等文字属于冻结时状态，保留以维持摘要；本节与第五次记录描述当前实际状态。仓外私有备份和机器源码缓存不随 Git 分发，本机路径不能作为新机器必备路径。

## 验证与证据

在 `desktop/` 使用 Node 24 和固定 Python 环境：

```sh
npm run compile
node --test scope-extension/test/backend-validation.cjs scope-extension/test/image-analysis.cjs
~/.nodu/python/bin/python -m unittest discover -s scope-extension/test -p 'worker*_test.py'
```

已有 TypeScript、Node 14 项、worker 100 项通过；此前 browser / Electron 构建无错误。交接后再次执行版本一致性、编译与无串口回归，结果见 [validation.json](validation.json)，不替代硬件证据。

- [精简 UI](../../artifacts/ui-minimal/20261019/verification.md)：原生 macOS 与 1280 × 720 浏览器。Windows、980 px 原生窗口及专业模式拖拽恢复的实际手势未实测。
- [设备 / 图像验收](../../.impeccable/review/device-service/verification.md)：文件 4,124 B 往返、JPEG 原字节导出、ROI / LAB 与重连。
- [相机诊断](camera-ide-diagnosis.md)：明确的 GC2145 初始化适配；单文件示例已验收，绿色追踪整项目仍有板端 helper 依赖。
- [返回后复核](../../artifacts/flash-probe/20261019/app-execution/fifth-postcheck-serial-result.json)：保全范围一致，容量标志仍 false。

截图来自实际应用；`artifacts/ui-v*` 是 AI 概念图，不是功能实现证据。

## 许可与分发

新增源码 MIT。Theia、Electron、设备依赖、字体、RAM reader SDK / 运行库各有独立许可，不把整个产物统称为纯 MIT。[第三方 NOTICE](../../desktop/THIRD-PARTY-NOTICES.md)及[运行库审计](flash-probe-runtime-audit.md)保留来源与边界。kflash ISP stub 等正式分发审查项未关闭；未宣称完整 MaixPy IDE 0.2.5 源码已定位。安装器、签名、公证、更新和完整再分发验收另行完成。

## Git 管理

根目录建立本地仓库，基线分支 `main`，提交后创建注释标签 `v0.1.1`。未配置远端或推送。依赖、可再生桌面构建、运行数据、Python 缓存、日志与原始 UI 转储排除；运行资源 `resources/flash-probe/probe.bin` 和工具的冻结构建证据保留。

`preview/` 为已有独立 Git 仓库，父仓库忽略，不改其历史。旧文档路径保留兼容导航，正文归入本版本目录。后续版本新增目录，避免覆盖 0.1.1 交接事实；事实错误可正常提交修正。

```sh
git status
git log -1 --oneline
git show v0.1.1 --stat
```
