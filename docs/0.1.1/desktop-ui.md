# Nodu 桌面 UI

记录日期：2026-10-19。当前交付基于 Eclipse Theia 1.76.0、Electron 42.8.1、React 19 与 TypeScript 5.9。安装和启动见 [desktop/README.md](GETTING_STARTED.md)，当前行为与原生验收见[设备与图像工具记录](../../.impeccable/review/device-service/verification.md)。

Nodu 面向 Windows / macOS 多芯片入门开发，采用已确认的蓝色与石墨工作台。本阶段已在 macOS 原生 App 与野火 K210 CAM / GC2145、MaixPy 0.6.3 组合上验收连接、REPL、RAM 运行 / 停止、文件传输与真实 JPEG 工具。STM32F103C8T6、ESP32-C3 / S3、各芯片编译工具链与完整下载管理仍为后续工作；Windows 尚未实机验证。

## 组成与入口

`browser-app` 和 `electron-app` 都依赖 `@scope/studio-extension`。Theia 提供 Monaco 编辑器、文件系统、文件树、搜索、输出、命令、终端和停靠布局；Nodu 编译期扩展注入主题、工具栏及视觉 / 设备面板。工具栏与设备面板共用一个 `NoduDeviceModel`，经 Theia RPC 使用后端持久 Python worker 的设备会话。

| 源码 | 责任 |
| --- | --- |
| [scope-frontend-module.ts](../../desktop/scope-extension/src/browser/scope-frontend-module.ts) | 绑定主题、命令、布局和 Widget |
| [scope-workbench.tsx](../../desktop/scope-extension/src/browser/scope-workbench.tsx) / [scope-layout-state.ts](../../desktop/scope-extension/src/browser/scope-layout-state.ts) | 单排工具栏、RAM 运行 / 停止、面板开关与模式布局状态 |
| [scope-theme.ts](../../desktop/scope-extension/src/browser/scope-theme.ts) / [scope-languages.ts](../../desktop/scope-extension/src/browser/scope-languages.ts) | 石墨主题、Python / JSON 基础语法与括号规则 |
| [scope-session.ts](../../desktop/scope-extension/src/browser/scope-session.ts) | 合成样本、阈值、帧、播放状态及日志 |
| [scope-widgets.tsx](../../desktop/scope-extension/src/browser/scope-widgets.tsx) | 设备 / 示例来源、视觉工具状态及旧设备 Widget 的兼容入口 |
| [nodu-console-widget.tsx](../../desktop/scope-extension/src/browser/nodu-console-widget.tsx) | 简洁模式的设备输出与 REPL |
| [nodu-device-client.ts](../../desktop/scope-extension/src/browser/nodu-device-client.ts) / [nodu-device-server.ts](../../desktop/scope-extension/src/node/nodu-device-server.ts) | 共用设备模型、RPC 与后端设备操作 |
| [nodu-device-panel.tsx](../../desktop/scope-extension/src/browser/nodu-device-panel.tsx) / [nodu-firmware-panel.tsx](../../desktop/scope-extension/src/browser/nodu-firmware-panel.tsx) | 常驻设备浮层：串口、板型、文件及固件准备 / 恢复；专业模式另保留 REPL 和日志入口 |
| [nodu-image-tools.tsx](../../desktop/scope-extension/src/browser/nodu-image-tools.tsx) / [nodu-image-analysis.ts](../../desktop/scope-extension/src/browser/nodu-image-analysis.ts) | 真实 JPEG 的 ROI、像素、直方图、PC LAB、复制和原图导出 |
| [nodu-image-state.ts](../../desktop/scope-extension/src/browser/nodu-image-state.ts) / [nodu-image-clipboard.ts](../../desktop/scope-extension/src/browser/nodu-image-clipboard.ts) | Widget 持有的工具状态与剪贴板写入确认 |
| [style/](../../desktop/scope-extension/style) / [launch.cjs](../../desktop/scripts/launch.cjs) | 控件样式、本地字体及本机启动 / 原生依赖切换 |

浏览器开发入口默认端口为 4188，Electron 后端为 4189，均仅监听 `127.0.0.1`。默认工作区是 `desktop/examples/green-tracker`，设置保存在 `~/.scope-studio/config`，Electron 用户数据保存在 `~/.scope-studio/electron`。两种目标共享原生依赖，切换需按启动文档完成 ABI 切换。历史设备 / 图像验收另用独立工作区、配置目录与 4192 端口；本轮新布局在 4193 原生窗口断开设备后安全重载验收。

## 布局与操作

项目工具栏位于 Theia 菜单 / 原生窗口控制区下方，高 44 px。左侧依次是小尺寸 Nodu 标志、“文件”、“运行”、停止图标和设备 / 端口 chip；项目名安静居中。右侧依次为控制台图标、模式图标，最右侧相机图标是视觉面板的唯一工具栏开关。没有独立的设备、视觉、日志文字按钮或重复连接状态。

模式图标可双向切换，无障碍名称表达“切换到专业模式”或“切换到简洁模式”，`aria-pressed` 表达专业模式是否启用。文件、控制台与相机按钮的按下状态跟随对应面板实际可见状态；面板开关串行执行，等待 Theia 布局更新。

| 布局 | 行为 |
| --- | --- |
| 简洁 | 首次进入只显示编辑器；文件按钮开关左文件树，控制台按钮开关底部控制台，相机按钮开关右视觉面板。隐藏左右活动栏及状态栏中的设备、示例、底部开关、Problems 和通知入口，保留文件元数据 |
| 专业 | 保留 Theia 导航与完整面板操作；首次进入展开文件树、输出和视觉面板 |

每种模式在当前前端会话中保留自己的实际面板开关状态。切换展开 / 收起面板，必要时将同一文件树、视觉或控制台实例归回其侧栏；不重建设备会话、编辑缓冲区或视觉工具状态。设备输出只追加日志，不强制打开底部区域。设备 chip 打开常驻浮层，收起或切模式不卸载表单，串口选择、文件路径和确认输入得以保留。简洁模式的设备浮层不显示 REPL、重复停止按钮或设备日志入口，停止统一使用工具栏；右侧只承载视觉面板。初建布局的左、右、底部尺寸为 220、420、160 px，均可拖动调整。Electron 初始窗口为 1520 × 960，最小为 980 × 680。

`Cmd/Ctrl+Shift+P` 打开命令面板，搜索“见微 Nodu”可找到设备、布局和输出命令。`Cmd/Ctrl+Enter` 在编辑器有文本焦点时将当前 Python 缓冲区（含未保存修改）运行到设备 RAM；在 REPL 输入框内只执行该框内容，不触发编辑器运行。`Cmd/Ctrl+S` 保存本机文件，`Cmd/Ctrl+Z` 撤销编辑。示例播放与参数复制保留在专业模式的视觉面板和“见微 → 示例”菜单。终端可执行本机命令。

## K210 连接、运行与文件

点击设备 chip，在浮层中扫描串口，选择实际 USB 串口和物理板型后连接。当前提供“野火 K210 CAM · GC2145”与“通用 K210”配置。设备详情显示固件版本、架构及 REPL / 文件 / RAM 脚本 / 图像能力。固件返回的 `Sipeed_M1` 是架构信息，不用于识别实体板卡厂家。

“运行”读取当前 Python 编辑器内容，在 RAM 临时执行，不保存为板端启动程序。运行中禁用再次运行；“停止”中断脚本或取消可取消的操作。未连接时运行入口打开同一设备浮层。普通脚本占用串口解析器时，REPL、文件操作和相机快照暂停或禁用。简洁模式的独立控制台显示 stdout / stderr 实际输出和 REPL 输入，不铺陈 system 过程日志；工具栏控制台图标打开或收起它。专业模式保留“Nodu · 设备”完整输出通道。

板端文件区可列目录、选择板端绝对路径，并通过原生对话框上传 / 下载，单文件上限 2 MiB。上传默认不覆盖同名文件，启动文件受保护；下载拒绝已有本机目标，先保存原始字节，再按严格 UTF-8 和控制字符检查决定是否尝试文本打开。二进制下载不会因不能作为源码打开而误报失败，也不会覆盖当前未保存缓冲区。本次原生往返 4,124 字节，内容与 SHA-256 完全一致，并验证了取消下载对话框后继续操作。

“固件与恢复”已有官方镜像准备、完整设备备份及烧写 / 验证入口。“镜像校验 / 校验通过”和“计划写入”仅说明镜像与计划。烧写另要求当前设备完整备份通过、Flash 容量实测确认、匹配的当前连接与用户勾选确认；当前身份读取返回 DE/E7，容量未认证，完整当前设备备份与烧写被阻止，没有真实写入。历史 `0x90` 返回的 `EF/17` 和旧备份不能替代当前会话三字节 JEDEC 测量，见[容量证据边界](device-capacity-status.md)。

## 真实设备 JPEG 与图像工具

简洁模式视觉面板使用设备相机；专业模式明确区分“设备相机”和“示例”。“启动相机”在 RAM 中载入现有板级相机辅助文件，通过 raw REPL 接收低速 JPEG 快照。“冻结 / 继续”暂停或恢复接收；截图与适配 / 缩放为常用控件，ROI、直方图、LAB 在简洁模式默认折叠。普通脚本运行时暂停读取并保留帧；该路径未承诺持续视频帧率。新布局已收到真实320 × 240图像至第36帧，并验证冻结、面板快速开关及ROI折叠展开；下述分析数值来自已完成的历史原生图像工具验收。

收到有效 JPEG 后提供：

- **原图与缩放**：尺寸、帧号及原图 / LAB 状态；“适配”、100%、200% 改变显示比例，放大后可滚动。
- **ROI**：拖拽或填写 X、Y、宽、高，均使用原图像素坐标，拖拽包含两个端点。可点击“清除选区”，或在画布焦点内按 Escape；无 ROI 时统计全图。
- **像素检查**：指针位置显示原图坐标、RGB、`PC LAB ≈` 与色块。蒙版开启后仍采样原始解码图像。
- **直方图**：RGB / 灰度 Y′，显示全图或 ROI 的 0–255 分布、共用纵轴的通道曲线、图例与像素数。灰度公式为 `Y′ = 0.2126R + 0.7152G + 0.0722B`。
- **PC LAB 蒙版**：L 0–100、A / B −128–127，上下限配对约束并包含端点。默认及重置为 `(0, 100, -128, 127, -128, 127)`。ROI 内命中为白色，其余为黑色，显示命中数 / 总数与比例。
- **参数复制**：元组可选择，也可点击“复制参数”。通过 Theia `ClipboardService` 写入并确认结果，失败提示手动复制。参数动作不修改编辑器、不自动粘贴、保存或运行代码。
- **原图导出**：PNG / JPEG 经原生保存对话框写入新文件，拒绝覆盖已有目标。捕获打开对话框时已显示的有效帧，导出完整原图，不含 ROI、蒙版或缩放效果。JPEG 保留设备原始字节；PNG 由原始解码像素编码。

PC LAB 是解码 JPEG 上的 sRGB / D65 浮点近似。JPEG、RGB565 与板端 LAB 查表存在差异，需要在板端复核阈值；未执行板端识别或 KPU 推理，不保证与 MaixPy / OpenMV 逐值一致。解码上限为 1,048,576 像素、单边最多 2048；统计 / 蒙版分析最多 262,144 像素。大图会缩小分析并显示采样尺寸，像素检查与导出仍使用完整原图。解码失败会报告错误；若保留上一张有效帧，会明确说明。

本次真实 320 × 240 帧的 ROI 为 `(54, 45, 195, 119)`、23,205 像素；L 下限 50 时命中 10,711 像素（46.2%）。元组经系统剪贴板粘贴到临时编辑器核对，随后撤销并关闭临时页。PNG / JPEG 导出均为完整彩色原图，JPEG SHA-256 与板端最后一帧一致。这些是本次样本结果，不构成精度或大数据集性能认证。

## 本地合成演示

合成来源绘制 320 × 240 场景，提供 90 帧播放 / 暂停、帧滑块、检测叠加、结果表及双色块、单目标、空场景三种样本。样本、阈值、帧、播放状态通过同一个 `ScopeSession` 同步；拖动帧位置会暂停，空场景显示零目标与空结果。

演示 LAB 范围与真实工具相同，默认及重置为 `(25, 85, -65, -15, -10, 50)`，阈值状态与真实工具独立。筛选只依据预设几何物体的 LAB 元数据，未执行 MaixPy 视觉算法。“复制参数”及对应命令也只通过 `ClipboardService` 复制元组，不再打开 / 改写 `thresholds.py`，不调用 `editor.executeEdits`。用户决定粘贴位置，并在真机复核后自行保存。演示日志位于“Nodu · 示例”；相关入口仅在专业模式提供。

## 状态与能力边界

| 状态 | 生命周期 / 效果 |
| --- | --- |
| 简洁 / 专业选择 | `scope.layout-mode` 保存在当前前端的本地存储 |
| 各模式面板开关 | 记录实际文件树 / 控制台 / 视觉可见状态；当前前端会话中跨模式保留 |
| 设备浮层输入 | 同一 React 表单持续挂载，关闭 / 打开浮层及切模式保留草稿 |
| 文件与未保存文本 | Theia / Monaco 管理；布局切换、复制、导出及本次文件传输保留原缓冲区 |
| 设备连接、运行、日志与当前帧 | 共用 `NoduDeviceModel` 和设备服务；断开清除保留帧及目录列表，重连重新读取状态 |
| ROI、采样位置、真实阈值、蒙版、缩放、直方图模式与导出格式 | 视觉 Widget 的 `NoduImageToolState` 持有；布局 / 来源切换不重置，前端重启后初始化 |
| 合成阈值、样本、帧、播放、叠加 | 共用 `ScopeSession`；与真实工具独立，前端重启后初始化 |

Python / JSON 提供基础语法高亮，未接入完整 Python 语言服务器。工具链编译、板卡 / 库包管理、持久应用部署、串口绘图器、KPU、K210 仿真、搭芯 / DACIR 和若干旧 MaixPy 工具仍不完整或未验收，见[功能基线](feature-baseline.md)。本次结果不等于完整 Arduino / MaixPy 覆盖，也不包含拔线 / 断电恢复、完整烧写恢复或正式可访问性认证。

## 当前品牌、主题与历史范围

主题“见微 Nodu · 石墨”通过 Theia 颜色 ID 映射编辑器、面板、菜单、状态栏和终端。正式主色 `#4F7CFF` 用于主要动作与活动标记，深底强调 / 焦点为 `#8EACFF`，浅底标志为 `#244BB0`，柔和蓝底为 `#E8EEFF`；石墨为 `#181D20`，品牌阅读表面为暖白 `#F3F3EE`。代码语法、终端 ANSI、RGB 通道曲线与样本图像语义色独立保留。

[DESIGN.md](DESIGN.md) 与 [.impeccable/design.json](../../.impeccable/design.json) 是现有视觉系统记录，并保留 SCOPE / 矿物青绿历史快照。本阶段沿用该系统，没有引入新视觉方向或修改这两份规范；其中滞后的设备能力描述记录于[一致性报告](../../.impeccable/review/device-service/design-consistency.md)，当前行为以本文、源码与验收证据为准。`preview/dist/` 未迁移，其概念工作区、快捷键与部署演示属于历史网站。

原创 SVG 主标为小写 n 与独立圆点，字标为小写 nodu；新工具栏仅显示小尺寸主标。品牌使用见[规范](../../brand/README.md)，[品牌预览](http://127.0.0.1:4190/brand/)可下载[资产包](../../brand/assets/brand-kit.zip)。PNG、ICNS、ICO 已产出，尚未接入安装器。`scope-*` 包名、命令 ID、主题 ID `scope-dark`、配置目录与 `Start SCOPE.*` 文件名保留兼容。

## 验证依据

本轮新布局在 macOS 原生 4193 窗口已验证：断开设备后安全重载；文件树打开 / 收起；设备 chip 扫描并连接 `cu.usbserial-3120`；运行相机脚本 30 帧后完成；控制台关闭 / 打开，普通日志不强制打开；设备浮层文件路径草稿跨专业 / 简洁模式保留；未保存注释及第 15 行光标跨模式保留；REPL 中 `⌘Enter` 返回 `NODU_MINIMAL_REPL_OK`，未误运行编辑器。最右相机按钮控制视觉区，真实320 × 240预览接收到第36帧，冻结和ROI展开正常；文件和相机各快速点击两次后回到原状态。测试注释已撤销，表单测试路径已恢复。证据见[验收记录](../../artifacts/ui-minimal/20261019/verification.md)、[默认布局](../../artifacts/ui-minimal/20261019/simple-default.jpg)、[设备浮层](../../artifacts/ui-minimal/20261019/device-popover.jpg)、[控制台](../../artifacts/ui-minimal/20261019/simple-console.jpg)与[真实相机](../../artifacts/ui-minimal/20261019/simple-vision.jpg)。这些结果不扩展芯片或烧写能力范围。

历史设备与图像工具的数值和交互证据见[原生验收记录](../../.impeccable/review/device-service/verification.md)。以下截图保留历史布局范围，不能作为新布局截图；3040 × 1920 像素对应 1520 × 960 CSS 点：

| 证据 | 可见内容 |
| --- | --- |
| [简洁布局 ROI](../../.impeccable/review/device-service/native-image-roi-simple.jpg) | 正常设备画面、原图像素、ROI、RGB 直方图及未保存主缓冲区 |
| [参数复制](../../.impeccable/review/device-service/native-image-threshold-copy.jpg) | 灰度分布、蒙版命中、PC LAB 限制与粘贴后的元组 |
| [专业布局蒙版](../../.impeccable/review/device-service/native-image-mask-pro.jpg) | 同一帧和 ROI、原图采样、PC 蒙版、设备输出与未保存主缓冲区 |
| [文件下载](../../.impeccable/review/device-service/native-file-fixed.jpg) | 4,124 字节保存成功及真实 REPL 输出，无误报失败对话框 |
| [固件准备文案](../../.impeccable/review/device-service/native-firmware-prepared-fixed.jpg) | 镜像校验通过、计划写入、容量 / 备份阻塞与禁用烧写动作 |

本轮新布局 TypeScript 编译、browser / Electron 构建均为零错误，并经独立源码及实际截图复审；原生交互验收范围如上。浏览器另在4194独立配置和临时工作区打开新标签，原有4188标签未重载。历史设备 / 图像工具交付时14项Node测试（6项后端、8项图像 / 剪贴板）及33项Python测试通过。历史静态设计检查只运行过一次，[detector.json](../../.impeccable/review/device-service/detector.json) 为 `[]`，不替代新布局或硬件验收。历史静态审查见 [code-review.md](../../.impeccable/review/device-service/code-review.md) 与 [image-tools-code-review.md](../../.impeccable/review/device-service/image-tools-code-review.md)，对应交付范围的界面结论见 [finish-review.md](../../.impeccable/review/device-service/finish-review.md)。

[早期基座验收](../../.impeccable/review/desktop-app/verification.md)和[蓝色品牌证据](../../.impeccable/review/brand/ide-nodu-blue.jpg)保留各自历史范围；早期“设备尚未接入”不描述当前实现。[UI v3 概念图及来源](../../artifacts/ui-v3/PROVENANCE.md)是 AI 构图参考，不能作为运行截图。Windows 未实机验证，安装器、签名与自动更新尚未交付。
