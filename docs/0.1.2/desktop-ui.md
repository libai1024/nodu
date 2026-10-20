# Nodu 桌面 UI

记录日期：2026-10-19（0.1.2 修订）。当前交付基于 Eclipse Theia 1.76.0、Electron 42.8.1、React 19 与 TypeScript 5.9。安装和启动见 [0.1.1 GETTING_STARTED](../0.1.1/GETTING_STARTED.md)；设备与图像工具的历史验收见[设备与图像工具记录](../../.impeccable/review/device-service/verification.md)。

Nodu 面向 Windows / macOS 多芯片入门开发，采用已确认的蓝色与石墨工作台。本阶段已在 macOS 原生 App 与野火 K210 CAM / GC2145、MaixPy 0.6.3 组合上验收连接、REPL、RAM 运行 / 停止、文件传输与真实 JPEG 工具。STM32F103C8T6、ESP32-C3 / S3、各芯片编译工具链与完整下载管理仍为后续工作；Windows 尚未实机验证。

## 组成与入口

`browser-app` 和 `electron-app` 都依赖 `@scope/studio-extension`。Theia 提供 Monaco 编辑器、文件系统、文件树、搜索、输出、命令、终端和停靠布局；Nodu 编译期扩展注入主题、工具栏及视觉 / 设备面板。工具栏与设备面板共用一个 `NoduDeviceModel`，经 Theia RPC 使用后端持久 Python worker 的设备会话。

| 源码 | 责任 |
| --- | --- |
| [scope-frontend-module.ts](../../desktop/scope-extension/src/browser/scope-frontend-module.ts) | 绑定主题、命令、布局和 Widget |
| [scope-workbench.tsx](../../desktop/scope-extension/src/browser/scope-workbench.tsx) / [scope-layout-state.ts](../../desktop/scope-extension/src/browser/scope-layout-state.ts) | 单排工具栏、RAM 运行 / 停止、错误警告、分段模式开关、面板开关与模式布局状态、`refitMainTabBars` |
| [scope-theme.ts](../../desktop/scope-extension/src/browser/scope-theme.ts) / [scope-languages.ts](../../desktop/scope-extension/src/browser/scope-languages.ts) | 石墨主题、Python / JSON 基础语法与括号规则 |
| [scope-session.ts](../../desktop/scope-extension/src/browser/scope-session.ts) | 合成样本、阈值、帧、播放状态及日志 |
| [scope-widgets.tsx](../../desktop/scope-extension/src/browser/scope-widgets.tsx) | 设备 / 示例来源、视觉工具状态及旧设备 Widget 的兼容入口 |
| [nodu-console-widget.tsx](../../desktop/scope-extension/src/browser/nodu-console-widget.tsx) | 简洁模式的设备输出与 REPL |
| [nodu-device-client.ts](../../desktop/scope-extension/src/browser/nodu-device-client.ts) / [nodu-device-server.ts](../../desktop/scope-extension/src/node/nodu-device-server.ts) | 共用设备模型（含 `errorOperation` 错误归因）、RPC 与后端设备操作 |
| [nodu-device-panel.tsx](../../desktop/scope-extension/src/browser/nodu-device-panel.tsx) / [nodu-firmware-panel.tsx](../../desktop/scope-extension/src/browser/nodu-firmware-panel.tsx) | 常驻设备浮层：串口、板型、文件及固件准备 / 恢复；专业模式另保留 REPL 和日志入口 |
| [nodu-image-tools.tsx](../../desktop/scope-extension/src/browser/nodu-image-tools.tsx) / [nodu-image-analysis.ts](../../desktop/scope-extension/src/browser/nodu-image-analysis.ts) | 真实 JPEG 的 ROI、像素、直方图、PC LAB、复制和原图导出 |
| [nodu-image-state.ts](../../desktop/scope-extension/src/browser/nodu-image-state.ts) / [nodu-image-clipboard.ts](../../desktop/scope-extension/src/browser/nodu-image-clipboard.ts) | Widget 持有的工具状态与剪贴板写入确认 |
| [style/](../../desktop/scope-extension/style) / [launch.cjs](../../desktop/scripts/launch.cjs) | 控件样式、本地字体及本机启动 / 原生依赖切换 |

浏览器开发入口默认端口为 4188，Electron 后端为 4189，均仅监听 `127.0.0.1`。默认工作区是 `desktop/examples/green-tracker`，设置保存在 `~/.scope-studio/config`，Electron 用户数据保存在 `~/.scope-studio/electron`。两种目标共享原生依赖，切换需按启动文档完成 ABI 切换。本版 UI 验收在 4195 隔离实例完成（独立工作区 `/tmp/nodu-refine-ws`、用户数据 `/tmp/nodu-refine-user`）。

## 布局与操作

项目工具栏位于 Theia 菜单 / 原生窗口控制区下方，高 44 px。左侧依次是小尺寸 Nodu 标志、“文件”、“运行”、停止图标和设备 / 端口 chip。中部不显示项目名，仅在设备级错误时出现红色警告按钮（单行省略、悬停显示完整文本、点击打开设备日志、窗口窄于 760 px 隐藏）。右侧依次为控制台图标、视觉图标、1 px 分隔线、深浅主题切换图标与最右“简 / 专”分段模式控件。没有独立的设备、日志文字按钮或重复连接状态。

运行按钮在脚本运行中显示旋转图标与“运行中”，保留主色并降低不透明度，`aria-busy` 表达忙态；停止图标在运行或设备忙时使用错误色，不可停止时降为 0.35 不透明度且不显示边框底纹。设备 chip 以 6 px 状态点表达连接状态：灰 = 未连接（chip 为虚线边框）、琥珀 = 连接中、绿 = 已连接 / 运行、红 = 设备级错误。

“简 / 专”分段控件 `role="group"`、`aria-label="布局模式"`，两段各自带 `aria-pressed`；点击未激活段执行对应布局命令，点击已激活段无操作。文件、控制台与视觉按钮的 `aria-pressed` 跟随对应面板实际可见状态；面板开关串行执行，等待 Theia 布局更新。

| 布局 | 行为 |
| --- | --- |
| 简洁 | 首次进入只显示编辑器；隐藏面包屑行，编辑器标签条为 30 px；文件按钮开关左文件树，控制台按钮开关底部控制台，视觉按钮开关右视觉面板。隐藏左右活动栏及状态栏中的设备、示例、底部开关、Problems 和通知入口，保留文件元数据 |
| 专业 | 保留 Theia 导航、面包屑与完整面板操作；首次进入展开文件树、输出和视觉面板 |

每种模式在当前前端会话中保留自己的实际面板开关状态。切换展开 / 收起面板，必要时将同一文件树、视觉或控制台实例归回其侧栏；不重建设备会话、编辑缓冲区或视觉工具状态。模式切换时 `refitMainTabBars` 按当前 CSS 实测重设主区各标签区在 Lumino 中的尺寸提示（简洁 30 px / 专业 57 px），对不可见标签条跳过不写；该实现依赖 DockLayout 私有结构，Theia 升级需重检。设备输出只追加日志，不强制打开底部区域。设备 chip 打开常驻浮层，收起或切模式不卸载表单，串口选择、文件路径和确认输入得以保留。简洁模式浮层只有单一连接控件（未连接“连接”、连接中“取消”、其余“断开”）与文件管理；固件区隐藏但保持挂载，烧写进行中仍显示；专业模式另保留 REPL、设备日志与停止入口。右侧只承载视觉面板。初建布局的左、右、底部尺寸为 220、420、160 px，均可拖动调整。Electron 初始窗口为 1520 × 960，最小为 980 × 680。

`Cmd/Ctrl+Shift+P` 打开命令面板，搜索“见微 Nodu”可找到设备、布局和输出命令。`Cmd/Ctrl+Enter` 在编辑器有文本焦点时将当前 Python 缓冲区（含未保存修改）运行到设备 RAM；在控制台输入框内，Enter 执行该框内容、Shift+Enter 换行、Ctrl/Cmd+Enter 同样执行、IME 合成中 Enter 被忽略，均不触发编辑器运行。`Cmd/Ctrl+S` 保存本机文件，`Cmd/Ctrl+Z` 撤销编辑。示例播放与参数复制保留在专业模式的视觉面板和“见微 → 示例”菜单。终端可执行本机命令。

## 错误归因

`NoduDeviceModel.errorOperation` 记录产生当前错误的操作标签；后端 `lastError` 仅在工作进程级故障时作为设备级错误应用，复述操作失败消息时保留既有归因。用户代码异常（“执行 REPL”“发送脚本”“运行脚本”）只在控制台显示 stderr 与操作失败日志，不使 chip 变红、不占工具栏中部警告；设备级错误（连接、文件、固件、工作进程等）照常触发 chip 红点与中部警告。视觉面板的错误段只显示相机 / 预览操作（“启动相机”“开启预览”“暂停预览”）的失败。

## K210 连接、运行与文件

点击设备 chip，在浮层中扫描串口，选择实际 USB 串口和物理板型后连接。当前提供“野火 K210 CAM · GC2145”与“通用 K210”配置。设备详情显示固件版本、架构及 REPL / 文件 / RAM 脚本 / 图像能力。固件返回的 `Sipeed_M1` 是架构信息，不用于识别实体板卡厂家。

“运行”读取当前 Python 编辑器内容，在 RAM 临时执行，不保存为板端启动程序。运行中禁用再次运行；“停止”中断脚本或取消可取消的操作。未连接时运行入口打开同一设备浮层。普通脚本占用串口解析器时，REPL、文件操作和相机快照暂停或禁用。简洁模式的独立控制台带一行面板头：左为“控制台”标题，右为跟随输出、复制、清空、关闭四个图标按钮；输出区常显为带边框的面板。面板逐条显示 stdout / stderr（stderr 标红）和 REPL 输入，不铺陈 system 过程日志；“清空”按钮只影响本视图显示，不动共享日志。主题图标在 `scope-dark`（石墨）与 `scope-light`（暖白）间切换并持久化。专业模式保留“Nodu · 设备”完整输出通道。

板端文件区可列目录、选择板端绝对路径，并通过原生对话框上传 / 下载，单文件上限 2 MiB。上传默认不覆盖同名文件，启动文件受保护；下载拒绝已有本机目标，先保存原始字节，再按严格 UTF-8 和控制字符检查决定是否尝试文本打开。二进制下载不会因不能作为源码打开而误报失败，也不会覆盖当前未保存缓冲区。0.1.1 原生往返 4,124 字节，内容与 SHA-256 完全一致，并验证了取消下载对话框后继续操作。

“固件与恢复”已有官方镜像准备、完整设备备份及烧写 / 验证入口，仅在专业模式浮层显示（烧写进行中除外）。“镜像校验 / 校验通过”和“计划写入”仅说明镜像与计划。烧写另要求当前设备完整备份通过、Flash 容量实测确认、匹配的当前连接与用户勾选确认；当前身份读取返回 DE/E7，容量未认证，完整当前设备备份与烧写被阻止，没有真实写入。历史 `0x90` 返回的 `EF/17` 和旧备份不能替代当前会话三字节 JEDEC 测量，见[容量证据边界](../0.1.1/device-capacity-status.md)。

## 真实设备 JPEG 与图像工具

简洁模式视觉面板直接使用设备相机，无重复标题；专业模式明确区分“设备相机”和“示例”。相机控制为单一开关：预览中显示“冻结”、已有帧显示“继续”、无帧显示“启动相机”；有帧时附带“重新启动相机”图标按钮。图像工具条单行承载：左为相机控制，右为缩放（适配 / 100% / 200%）、PNG / JPEG 导出格式与截图图标；原“启动相机”“冻结 / 继续”两个独立按钮与图像下方元信息行已移除，帧号、尺寸与 LAB 状态改在图面左下角的非交互徽标显示（`#序号 · 宽 × 高`，蒙版时附 `· LAB`），缩放与滚动时保持在视口内。ROI、直方图、LAB 在简洁模式默认折叠，折叠摘要为 12 px 字、34 px 最小点击高度。普通脚本运行时暂停读取并保留帧；该路径未承诺持续视频帧率。

收到有效 JPEG 后提供：

- **原图与缩放**：左下徽标显示帧号、尺寸及 LAB 状态；“适配”、100%、200% 改变显示比例，放大后可滚动。
- **ROI**：拖拽或填写 X、Y、宽、高，均使用原图像素坐标，拖拽包含两个端点。可点击“清除选区”，或在画布焦点内按 Escape；无 ROI 时统计全图。
- **像素检查**：指针位置显示原图坐标、RGB、`PC LAB ≈` 与色块。蒙版开启后仍采样原始解码图像。
- **直方图**：RGB / 灰度 Y′，显示全图或 ROI 的 0–255 分布、共用纵轴的通道曲线、图例与像素数。灰度公式为 `Y′ = 0.2126R + 0.7152G + 0.0722B`。
- **PC LAB 蒙版**：L 0–100、A / B −128–127，上下限配对约束并包含端点。默认及重置为 `(0, 100, -128, 127, -128, 127)`。ROI 内命中为白色，其余为黑色，显示命中数 / 总数与比例。
- **参数复制**：元组可选择，也可点击“复制参数”。通过 Theia `ClipboardService` 写入并确认结果，失败提示手动复制。参数动作不修改编辑器、不自动粘贴、保存或运行代码。
- **原图导出**：PNG / JPEG 经原生保存对话框写入新文件，拒绝覆盖已有目标。捕获打开对话框时已显示的有效帧，导出完整原图，不含 ROI、蒙版或缩放效果。JPEG 保留设备原始字节；PNG 由原始解码像素编码。

PC LAB 是解码 JPEG 上的 sRGB / D65 浮点近似。JPEG、RGB565 与板端 LAB 查表存在差异，需要在板端复核阈值；未执行板端识别或 KPU 推理，不保证与 MaixPy / OpenMV 逐值一致。解码上限为 1,048,576 像素、单边最多 2048；统计 / 蒙版分析最多 262,144 像素。大图会缩小分析并显示采样尺寸，像素检查与导出仍使用完整原图。解码失败会报告错误；若保留上一张有效帧，会明确说明。

0.1.1 历史实测：真实 320 × 240 帧的 ROI 为 `(54, 45, 195, 119)`、23,205 像素；L 下限 50 时命中 10,711 像素（46.2%）。元组经系统剪贴板粘贴到临时编辑器核对，随后撤销并关闭临时页。PNG / JPEG 导出均为完整彩色原图，JPEG SHA-256 与板端最后一帧一致。这些是样本结果，不构成精度或大数据集性能认证。

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
| 设备连接、运行、日志、当前帧与错误归因 | 共用 `NoduDeviceModel` 和设备服务；断开清除保留帧及目录列表，重连重新读取状态 |
| ROI、采样位置、真实阈值、蒙版、缩放、直方图模式与导出格式 | 视觉 Widget 的 `NoduImageToolState` 持有；布局 / 来源切换不重置，前端重启后初始化 |
| 合成阈值、样本、帧、播放、叠加 | 共用 `ScopeSession`；与真实工具独立，前端重启后初始化 |

Python / JSON 提供基础语法高亮，未接入完整 Python 语言服务器。工具链编译、板卡 / 库包管理、持久应用部署、串口绘图器、KPU、K210 仿真、搭芯 / DACIR 和若干旧 MaixPy 工具仍不完整或未验收，见[功能基线](../0.1.1/feature-baseline.md)。本次结果不等于完整 Arduino / MaixPy 覆盖，也不包含拔线 / 断电恢复、完整烧写恢复或正式可访问性认证。

## 当前品牌、主题与历史范围

主题“见微 Nodu · 石墨”通过 Theia 颜色 ID 映射编辑器、面板、菜单、状态栏和终端。正式主色 `#4F7CFF` 用于主要动作与活动标记，深底强调 / 焦点为 `#8EACFF`，浅底标志为 `#244BB0`，柔和蓝底为 `#E8EEFF`；石墨为 `#181D20`，品牌阅读表面为暖白 `#F3F3EE`。代码语法、终端 ANSI、RGB 通道曲线与样本图像语义色独立保留。

[0.1.1 DESIGN](../0.1.1/DESIGN.md) 与 [.impeccable/design.json](../../.impeccable/design.json) 是现有视觉系统记录，并保留 SCOPE / 矿物青绿历史快照。本阶段沿用该系统，没有引入新视觉方向或修改这两份规范；其中滞后的设备能力描述记录于[一致性报告](../../.impeccable/review/device-service/design-consistency.md)，当前行为以本文、源码与验收证据为准。`preview/dist/` 未迁移，其概念工作区、快捷键与部署演示属于历史网站。

原创 SVG 主标为小写 n 与独立圆点，字标为小写 nodu；新工具栏仅显示小尺寸主标。品牌使用见[规范](../../brand/README.md)。PNG、ICNS、ICO 已产出，尚未接入安装器。`scope-*` 包名、命令 ID、主题 ID `scope-dark`、配置目录与 `Start SCOPE.*` 文件名保留兼容。

## 验证依据

本轮修订在 macOS 原生 4195 隔离实例验证：连接 `cu.usbserial-3120`，RAM 运行 `camera_preview.py` 收到真实 320 × 240 帧；运行中工具栏显示“运行中”旋转态与红色停止图标；REPL `1/0` 不再使 chip 变红或出现工具栏警告，stderr 仅在控制台标红；无效路径“读取板端目录”照常触发红点与中部警告；简洁模式编辑器标签条 30 px、无面包屑，专业模式标签条 57 px、面包屑存在；简洁 / 专业切换保留未保存文本、光标与浮层草稿；控制台 Enter 只执行 REPL、合成 `isComposing` Enter 被忽略；控制台 / 视觉按钮 `aria-pressed` 与面板可见性同步。证据见[验收记录](../../artifacts/ui-minimal/20261019-refine/verification.md)与[截图指纹](../../artifacts/ui-minimal/20261019-refine/provenance.json)。

历史设备与图像工具的数值和交互证据见[原生验收记录](../../.impeccable/review/device-service/verification.md)；0.1.1 目录截图保留当时布局，不作为本版布局证据。本轮 TypeScript 编译、Node 20 项（6 后端 + 14 图像）、Python worker 100 项、browser / Electron 构建均通过，`impeccable detect` 对改动文件返回 `[]`。真实拼音输入法、Windows 实机与最小窗口拖拽手势未实测。
