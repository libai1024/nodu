# 02 方案实现与 STM32F103 实测

时间：2026-10-22（北京时间）。用户确认仅连接 ST-LINK，本轮验证下载与运行。

## 实现

- 新建窗口采用 02 紧凑双栏：708 px 宽，160 px 系列栏，34 px 输入框，32 px 按钮。子项左边距 54 px，保留 Nodu 主题变量。
- K210 直接选择；STM32 分组收纳 F103/F407；ESP32 分组收纳各芯片型号。当前系列默认展开，列表溢出时滚动。
- 模板显示“默认项目”，去除框架前缀及“·”拼接说明；保留必要错误反馈。
- 浏览按钮合并到位置输入框内，修复通用 CSS 覆盖导致的文字遮挡。
- 开始页采用左侧导航、顶部新建/打开与搜索、真实最近项目列表。
- C 工程运行后，有串口连接时显示监视器，无串口时显示编译/下载输出。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| TypeScript 编译 | 通过 |
| 浏览器前端与后端构建 | 0 errors |
| Electron 前端、后端和主进程构建 | 0 errors；本轮交互验收在浏览器版完成 |
| Rust nodu-embedded | 30 项通过 |
| Node 回归 | 15 项通过，0 失败，0 跳过 |
| diff 空白检查 | 通过 |

Node 回归涵盖 K210/全部 ESP32 型号生成、名称/路径/模板校验、并发重名保护、UTF-8/GBK 解码、clangd 插件生命周期、发布工具包校验、F103/F407 真实工具链编译及独立导出一致性、外部工程信任、编译中源文件变更、取消 Ninja 并释放锁。

## 界面验收过程

1. 开始页点击新建项目，展开 STM32，选择 STM32F103C8T6 和默认项目，创建后自动打开 Core/Src/main.c。
2. 在 F103、F407、ESP32-S3 之间切换，型号同步，已编辑的名称与路径保留。
3. CON 名称触发校验并禁用创建。同名 f103-e2e 回车提交后被拒，原工程未覆盖。Escape 正常关闭。
4. 默认工程编译成功。通过编辑器粘贴/保存 C 代码，注入未声明符号及缺分号，面板显示 2 个编译错误，点击定位到第 12 行第 9 列；修正后错误清除。
5. 输入 HAL_GPIO_ 显示 Init、TogglePin、ReadPin、WritePin 等函数及签名。测试后恢复完整源码并核对磁盘文件，无额外 include。F12 跳到 HAL_Delay 的 SDK 定义第 371 行，标签标记只读和 HAL 版本。
6. 最终版本再次点击运行，完成后打开下载输出，没有打开未连接的串口面板。
7. 深色/浅色主题均检查新建窗口，文字、焦点、系列选中态与位置浏览按钮正常；截图见 evidence/2026-10-22-new-project-light-implemented.png。

## 真机结果

| 项目 | 实测 |
| --- | --- |
| 下载器 | ST-LINK/V2，V2J37S7 |
| 芯片标识 | 0x410，Flash 容量寄存器 64 KB |
| 读保护 | 未开启 |
| 写入前备份 | 65536 字节，备份 SHA-256 复算一致 |
| 最终固件 | 2648 字节；Flash 4.04%，RAM 2584 字节/20 KB |
| 写入 | 擦写 3 页；两次从界面下载均成功 |
| 校验 | OpenOCD verify 成功，读回 SHA-256 与固件一致 |
| 下载后心跳 | 最后一次 uwTick 从 0x131 增至 0x260 |
| 主循环 | SWD 读 RAM：nodu_loop_count 599 → 604 |
| 复位后运行 | nodu_loop_count 4 → 9；uwTick 307 → 811 |

板上保留最终测试程序：每 100 ms 增加 nodu_loop_count，不假定 LED 或其他板载外设。

项目：[f103-e2e](../../artifacts/f103-ui-20261022/projects/f103-e2e/)。
原程序备份：[flash.bin](../../artifacts/f103-ui-20261022/device-state/stm32/backups/410-0671ff373634574e431e5512/20261022-141421/flash.bin)。备份仅保存在本地，未将原程序二进制复制进文档目录。

## 证据与边界

- [验收数据](evidence/2026-10-22-f103-ui-acceptance.json)
- [Node 测试](evidence/2026-10-22-implementation-tests.tap)、[Rust 测试](evidence/2026-10-22-implementation-rust.txt)
- [芯片识别](evidence/2026-10-22-f103-ui-identify.txt)、[RAM/复位实测](evidence/2026-10-22-f103-ui-ram.txt)
- [新建窗口](evidence/2026-10-22-new-project-implemented.png)、[问题定位](evidence/2026-10-22-f103-ui-diagnostics.png)、[补全](evidence/2026-10-22-f103-ui-completion.png)、[定义跳转](evidence/2026-10-22-f103-ui-definition.png)、[下载运行](evidence/2026-10-22-f103-ui-running.png)

串口收发和串口 ISP 未实测（用户仅连接 ST-LINK）。本次不能替代 F407 真机、Windows、macOS x64、发布安装包和跨平台验收。
