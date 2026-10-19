# Nodu · 见微 0.1.1

面向嵌入式初学者的独立 IDE 开发版本，目标平台为 Windows / macOS，采用 Eclipse Theia 1.76.0、Electron 42.8.1、React 19 和 TypeScript 5.9。桌面应用和浏览器开发入口共享同一个 `scope-extension`。

K210 已接入第一阶段设备服务：端口扫描、连接、REPL、RAM 脚本运行 / 停止、文件传输与真实 JPEG 采集。野火 CAM K210 / GC2145、MaixPy 0.6.3 组合已通过 macOS 原生 App 验收，包含运行中切换布局、断开重连、文件字节校验与正常相机预览；共享浏览器入口另有 REPL 与设备帧接收记录。STM32F103C8T6、ESP32-C3 / S3、工具链编译与库包管理不在当前通过项中。

正式品牌为 Nodu：小写 n 与独立圆点主标、蓝色强调和石墨工作台。蓝色已由用户选定；[品牌预览](http://127.0.0.1:4190/brand/)、[品牌规范](../../brand/README.md)与[品牌资产包](../../brand/assets/brand-kit.zip)提供 SVG、PNG、ICNS、ICO。平台图标尚未接入安装器。

当前已提供真正的 Theia 文件树、Monaco 编辑器、文件保存、搜索、命令面板、终端和可调整的工作区布局。视觉面板分别显示设备 JPEG 与本地合成演示；合成序列、预设 LAB 筛选和示例检测叠加仍须按演示理解。真实 JPEG 的 ROI、直方图、PC LAB 阈值、复制与原图导出已完成原生验收，算法边界见下文。

## 环境与安装

使用 **Node.js 24** 与随附 npm。macOS 需要 Python 3 和 Xcode Command Line Tools；Windows 本地编译依赖需要 Python 3、Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”组件。

在 `desktop/` 中执行：

```sh
node --version
npm ci
npm exec -- install-electron
```

第一条命令应输出 `v24.x.x`。Electron 42 的 npm 包提供独立的 `install-electron` 命令；安装依赖后需要显式执行它来取得当前平台的 Electron 可执行文件。也可以运行等价命令 `node node_modules/electron/install.js`。

项目本机使用的 `.tools/` Node 24 为开发辅助环境，不是发行包要求；新的机器可以使用官方 Node 24 安装器或自己的版本管理器。启动器不修改系统 Node、不自动安装依赖、不自动重新打包应用。

接入设备前运行一次：

```sh
npm run setup:device
```

这会在用户目录 `~/.nodu/python` 创建供所有项目共享的 Python 环境，并固定安装 `mpremote==1.25.0`、`pyserial==3.5`、`kflash==1.1.6`。可用 `NODU_PYTHON` 指定已有解释器；开发机还保留 `/opt/homebrew/share/maixpy-k210/venv` 回退，该环境的 mpremote 为 1.29.0，不应视为固定依赖环境。版本与许可依据见[设备复用说明](device-reuse.md)。

## 构建与启动

桌面入口：

```sh
npm run build:electron
npm run start:electron
```

构建完成后，macOS 可以双击 `Start SCOPE.command`；Windows 可以运行 `Start SCOPE.cmd`。现有启动脚本、`scope-*` 包与配置目录名称保留兼容。macOS 启动器依次检查 Homebrew 的 Node 24、项目 `.tools/` 中的 Node 24，以及当前 PATH 中的 Node 24。

浏览器开发入口：

```sh
npm run build:browser
npm run start:browser
```

浏览器访问 <http://127.0.0.1:4188>。Electron 后端使用 `127.0.0.1:4189`。两种入口都只监听本机。

默认打开 `examples/green-tracker`。需要自己的工作区时，在启动命令后传入文件夹绝对路径：

```sh
npm run start:electron -- "/absolute/path/to/project"
```

相对路径按照发起 npm 命令时的目录解释。启动器将设置放在 `~/.scope-studio/config`，Electron 用户数据放在 `~/.scope-studio/electron`，不会使用其他 Theia 应用的默认配置目录。

**切换入口前先退出正在运行的另一入口。** 两者共享 `node_modules` 中的原生依赖，Electron 与 Node 的 ABI 不同。构建命令以及启动器会按需调用 Theia 的原生依赖切换机制；如果目标未变化，不会重复执行原生模块重建。手动恢复可运行 `npm run rebuild:browser` 或 `npm run rebuild:electron`。

修改扩展后，重新运行目标的 `build` 命令，再重启应用。

## 使用基础工作区

- 右上角模式图标切换简洁 / 专业。默认只有编辑器；文件按钮开关左树，控制台按钮开关底部，最右相机按钮开关视觉。各模式保留自己的面板状态，切换保留未保存文本、光标与设备会话。
- 从文件树打开 Python 或 JSON 文件。`Cmd/Ctrl+S` 保存到当前工作区，`Cmd/Ctrl+Z` 撤销编辑。
- `Cmd/Ctrl+Shift+P` 打开 Theia 命令面板，搜索“见微 Nodu”；`Cmd/Ctrl+Enter` 将当前 Python 编辑缓冲区运行到已连接设备的 RAM。本地合成演示使用独立菜单 / 播放控件。
- 拖动分隔条调整编辑器和视觉面板的宽度；专业布局提供更多项目和输出区域。
- 调整 LAB 阈值可观察示例目标数量变化。“复制演示参数”将当前元组复制到剪贴板，由用户决定粘贴位置；不改写编辑器或磁盘文件。
- 从终端菜单新建终端可以运行本机命令。终端具有本机文件访问能力，行为与普通开发终端一致。

本地演示按合成物体的预设 LAB 元数据筛选并绘制动画帧，不等于执行 MaixPy 图像识别算法或模型。“运行到设备”则会执行当前编辑器中的真实 Python 代码；两种操作不要混用其结果。

布局图标有动态无障碍名称和提示文字；当前模式的名称不占用常驻工具栏空间。完整的状态、布局和源码入口说明见[桌面 UI 文档](desktop-ui.md)。

## 使用 K210 设备服务

- 点击顶部设备 chip，扫描 USB 串口并按实际硬件选择“野火 K210 CAM · GC2145”或通用 K210，再连接。固件返回的 `Sipeed_M1` 架构标识不改变物理板型。
- 在控制台执行 REPL 并查看输出；工具栏“运行到设备”发送当前编辑缓冲区，包含未保存修改。“停止”中断脚本 / 取消当前操作；RAM 运行不会自动写入 `boot.py` 或 `main.py`。
- 板端文件区可列目录、读取到本地及显式上传，单文件上限 2 MiB。覆盖需显式选择，启动文件受保护；原生 UI 上传 / 下载的 4,124 字节与 SHA-256 完全一致。
- GC2145 相机使用板上已有 `/flash/gc2145_board.py` 辅助初始化代码，在 RAM 中执行后接收标准 JPEG；缺少 helper 会报错，不会自动安装。服务六帧复核及原生 App 均显示正常 320 × 240 纸箱场景；普通脚本运行期间暂停低速快照，未测持续 FPS。

设备由同一 Node 后端和持久 Python worker 管理串口所有权，简洁 / 专业布局共享会话。普通连接使用 raw REPL，不自动切换旧 IDE 模式；同时开启旧 MaixPy IDE 或其他串口程序会争用端口。

固件准备、备份、烧写入口及校验代码已经存在，但 **当前 Flash 身份读取返回 DE/E7，容量未认证，门禁禁止烧写**。历史启动日志的 `EF/17` 是容量相关证据，未绑定为当前会话认证；完整当前设备备份未完成，本轮没有真机烧写 / 恢复验收。详见[烧写计划](device-flash-plan.md)、[容量证据边界](device-capacity-status.md)与[暂停的探针分发路线](device-flash-probe-license.md)。

## 使用真实图像工具

设备画面提供拖拽 ROI、RGB / 灰度直方图、像素 RGB 与 PC LAB 值、LAB 阈值掩码和命中计数。点击“复制 LAB 元组”后可粘贴到自己的代码；合成演示参数也只复制，不改写编辑器。视图支持适应窗口、100% 与 200%，ROI 与阈值状态在新帧和简洁 / 专业切换时保留。

PC LAB 使用解码 JPEG 的 sRGB / D65 浮点计算，会受到 JPEG 压缩影响，不承诺与 MaixPy 的 RGB565 / LAB 查表逐值一致。这里没有运行板端目标检测或 KPU 推理，也未补齐旧 IDE 的 LAB / YUV 直方图、关键点、标记生成及视频工具。

PNG / JPEG 导出保留原始画面尺寸，不导出缩放后的界面或阈值掩码。JPEG 直接保存接收字节；本轮原生导出的 3,397 字节 JPEG 与板端最后一帧 SHA-256 一致，PNG 原图导出也已检查。

## 工程边界与后续扩展

```text
scope-extension/   主题、布局、命令、语言高亮、视觉/设备 UI、RPC 与 Python worker
browser-app/       Theia 浏览器入口，含本地 Node 后端
electron-app/      Theia Electron 桌面入口
examples/          可直接编辑和保存的 MaixPy 示例工作区
scripts/launch.cjs 本地工作区、独立配置和原生依赖切换
```

本轮以 Theia 编译期扩展构成产品，复用框架的编辑器、文件系统、布局和菜单。尚未加入 VS Code 插件市场或完整 Python 语言服务器；现有 Python/JSON 支持为基础语法高亮与括号规则。

端口扫描、连接、REPL、运行 / 停止、文件与相机已通过本地 RPC 接入共享设备服务，真实图像工具在前端处理收到的 JPEG。KPU 推理、板级仿真、搭芯联动仍未纳入当前交付；STM32 / ESP32、工具链编译、板卡 / 库包、持久应用部署及串口绘图器等待独立实现与验收，不能据入口或演示宣称通过。

## 验证与许可证

当前[原生设备与图像工具验收](../../.impeccable/review/device-service/verification.md)在隔离工作区完成扫描 / 连接、REPL 输出 `42`、含未保存 marker 的循环脚本运行 / STOP、运行中双布局切换及 dirty 状态保留、重连后执行 `42`、文件上传 / 下载和正常相机预览。文件证据见[字节与 SHA-256](../../.impeccable/review/device-service/native-file-roundtrip.json)，画面见[原生相机](../../.impeccable/review/device-service/native-camera-simple.jpg)。

真实图像工具已检查 ROI `(54, 45, 195, 119)` 的 23,205 像素、RGB / 灰度直方图、PC LAB 像素、L 下界 50 时命中 10,711 像素、元组复制后实际粘贴、三种缩放、新帧 33 → 43 与模式切换保留状态，以及 PNG / JPEG 原图导出。[导出校验](../../.impeccable/review/device-service/native-export-verification.json)记录 JPEG 与板端最后一帧 SHA-256 一致。14 项 Node 测试（6 项后端、8 项图像）、100 项 Python 测试通过，browser / Electron 构建均为 0 errors。

[原基座验收](../../.impeccable/review/desktop-app/verification.md)中的设备未接入描述属于历史范围；`.impeccable/review/device-service/hardware-smoke.jsonl`（仅本地保留）与[六帧相机复核](../../.impeccable/review/device-service/camera-recheck.md)分别保留。共享浏览器前端另有 REPL 与帧接收检查；历史 `app-camera.jpg` 为暗帧，不代表当前正常原生预览。

Windows 的启动脚本和项目配置已经提供，尚未在 Windows 机器上验证。这里是开发运行版本，尚未制作签名安装包或自动更新通道。

Nodu 新增源码采用仓库的 [MIT 许可证](../../LICENSE)。Theia、mpremote、pySerial、kflash 等依赖保留各自许可证，见[第三方组件说明](../../desktop/THIRD-PARTY-NOTICES.md)与[设备来源核查](device-reuse.md)。受非商业限制的 OpenMV Qt 协议文件没有复制进入项目；ktool 混合许可探针分发路线本轮暂停。相关官方资料：[Theia 开发要求](https://github.com/eclipse-theia/theia/blob/v1.76.0/doc/Developing.md)、[Theia CLI](https://github.com/eclipse-theia/theia/blob/v1.76.0/dev-packages/cli/README.md)、[Electron npm 包](https://github.com/electron/electron/tree/main/npm)。
