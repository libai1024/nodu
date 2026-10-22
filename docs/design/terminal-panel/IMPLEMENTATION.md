# K210 / STM32 底部面板实现记录

日期：2026-10-22。状态：**首轮实现、构建、界面验证及本轮独立复核已完成。** 实板验收未执行。

本轮依据已确认的 [底部面板方案](PROPOSAL.md) 和 [STM32 手动串口方案](STM32-SERIAL.md) 实现。设计稿描述目标，本文记录当前代码与已取得的证据；两者有差异时，不将设计目标当作完成事实。

**最新用户要求优先：移除非必要的常驻解释文案，采用主流 IDE 的图标操作，并提供 tooltip 与无障碍名称；重要错误和需要行动的信息保留。** 本轮据此收敛连接、发送、执行、查找与终端工具，移除常驻的 ST-LINK/SWD 说明、等待任务说明和教学式空态；连接状态使用带名称与提示的状态图标。BOOT 恢复、真实错误和发送失败等必要信息仍简明显示。最新实际界面截图见下方验证证据。

## 工作范围与基线

实现位于 `codex/terminal-panel-ui` 的独立工作树。原工作区已有的 STM32 集成先单独保存为 `c04a21d`（`chore: snapshot existing local STM32 integration for panel work`），包括编译、下载、板卡模板、原生服务和基础界面；这些既有能力不算本轮从零实现。原有含未提交修改的工作区保持未改动。

本轮改动集中于底部公共容器、K210 日志与 Python 交互、STM32 串口监视及其会话边界、真正的本机终端。没有替换品牌或全局设计系统，也没有完成发行打包、签名或安装器验证。

## 当前实现

| 页面 | 实际行为 |
| --- | --- |
| K210：运行输出 | 显示设备共享日志，来源说明位于 tooltip 与无障碍名称；有查找、跟随、新输出提示、清空和复制，保留缓冲截断提示。共享事件缺少完整命令/运行归属，不能声称每行只来自当前脚本。 |
| K210：Python 交互 | 空草稿，可编辑多行；命令回显与真实 `execute` RPC 响应组成往返。空响应不伪造结果，失败保留草稿，完成旧命令不清掉新草稿。未连接、运行中、忙碌或不支持时显示具体原因。 |
| STM32：构建与下载 | 接入既有构建/下载输出、诊断与容量视图；UART 监视与下载器状态分开，普通 C 工程不出现 Python 交互。 |
| STM32：串口监视 | 手动选端口、波特率并连接；刷新不自动选端口或连接。真实原始字节支持 TEXT/HEX 接收与发送，RX/TX 分列；有查找、跟随、复制和清空。 |
| 两平台：终端 | 复用 Theia `TerminalWidget` 与真正的 PTY；提供工程上下文、新建、分屏、会话选择、查找、重命名和显式结束。切页或收起保留进程。 |

公共容器按工程平台显示三标签：K210 为“运行输出 / Python 交互 / 终端”，STM32 为“构建与下载 / 串口监视 / 终端”。简洁与专业布局使用同一容器，提供更多、最大化/恢复、收起与高度调整；当前页和高度按工作区及平台保存。恢复页面不创建终端、不连接设备；首次主动进入“终端”可创建该工程的 Shell 会话。默认高度使用窗口高度约 28%，初值限制在 220–320 px，最小高度为 180 px。

K210 的草稿和阅读状态按当前窗口中的工作区保留，Python 历史按连接会话隔离，最多 50 项。单行 Enter 执行，Shift+Enter 换行，多行用 Ctrl/⌘+Enter 执行；输入法组字不提交。K210 输出缓冲最多 300 条/200,000 字符，单条最多保留末尾 32,000 字符，并显示移除或截断事实；搜索与复制只覆盖当前保留内容。

STM32 TEXT 发送固定 UTF-8，行尾明确选择“无 / LF / CR / CRLF”，默认无行尾；HEX 校验完整字节对，不追加文本行尾。接收使用流式解码，保留跨数据块的 UTF-8 残余字节；沿用既有的 UTF-8/GBK 接收选择。收发格式分别设置，HEX 展示原始字节。主机确认完整写入后才记录 TX，TX 不代表固件执行成功；错误保留草稿并说明可能已部分写入，不自动重试。串口缓冲保留最近 1 MiB/10,000 条并提示截断。

串口连接带窗口 owner 与 session 标识；写入、关闭和 ISP 让出均检查归属，过期结果不会切换到另一工程或借用另一窗口的会话。窗口连接结束会释放它拥有的监视会话，拔线后释放端口锁；相同路径重新出现也须手动连接。SWD 下载独立于 UART，未选 UART 不阻止 SWD 下载；同串口 ISP 需明确“断开监视并继续下载”，完成后等待 BOOT 配置恢复及复位，再由用户手动连接。没有自动关联 ST-LINK、自动重连、自动恢复监视或重放旧草稿。

主要实现入口：[公共容器](../../../desktop/scope-extension/src/browser/nodu-bottom-panel.tsx)、[K210 控制台](../../../desktop/scope-extension/src/browser/nodu-console-widget.tsx)、[STM32 面板](../../../desktop/scope-extension/src/browser/nodu-embedded-panel.tsx)、[STM32 状态模型](../../../desktop/scope-extension/src/browser/nodu-embedded-model.ts)、[Shell](../../../desktop/scope-extension/src/browser/nodu-shell-panel.tsx)、[原生串口监视](../../../desktop/native/crates/nodu-embedded/src/monitor.rs)。

## 与现有设计系统的一致性

已核对 [PRODUCT.md](../../0.1.1/PRODUCT.md)、[DESIGN.md](../../0.1.1/DESIGN.md) 及本轮四份面板样式。此次属于现有工作台扩展，保留全局规范与 sidecar，未生成新的视觉系统。

- 配色：使用 Theia/Nodu 的背景、前景、边界、按钮、焦点与语义状态令牌，蓝色表达活动与操作。
- 字体：沿用工作台 UI 字体；日志使用 Theia 等宽设置，正文 13 px/20 px，辅助信息 11–12 px。
- 层级：连续正文配合细分隔线，常驻面板不加卡片式阴影；浮层沿用现有菜单表面与阴影。
- 控件：标签默认 104×32 px、活动线 80×2 px；按钮和标签通过 flex 居中，正文左对齐，小圆角保持现有密度。
- 状态规则：保留现有语义颜色规则；焦点、活动线、状态图标、tooltip 与无障碍名称共同表达状态，重要错误和行动提示保留文字，不把串口 TX 或连接状态冒充固件执行结果。

既有文档差异保留记录：0.1.1 产品文档仍把 STM32 列为后续范围，设计文档仍限定浅色主题的验收程度。本轮浅色截图验证此面板，未重新认证整个浅色主题。上述版本边界单独记录，保留既有全局规范。

## 验证证据

| 检查 | 当前结果与范围 |
| --- | --- |
| TypeScript 编译 | 最终图标与文案修订后通过。 |
| Browser 与 Electron bundle | 最终修订后均为 0 errors；不等于完整安装包或发行构建验收。 |
| Node 测试 | 18 项通过：Python 输入/历史/缓冲/搜索和真实响应处理；串口字节、行尾与跨包解码；窗口归属、项目切换和过期结果；前端连接关闭时释放对应会话。 |
| Rust `nodu-embedded` | 32 项通过，包含真实 PTY 原始 RX/TX、过期 session 拒绝、拔线释放锁及同路径手动重连。PTY 是本机伪终端证据，不替代真实 UART 或实板。 |
| 本机 Shell | 真实 PTY 执行 `pwd` 并得到工程目录；两分屏运行已验证，最终图标界面再次执行 `pwd` 通过。 |
| 原生服务 | 最新 `nodu-embedded` debug 二进制已构建。 |
| 实际 Electron | 使用独立 profile 启动，后端端口 4192，运行重建的 debug sidecar；用户当前窗口已刷新。实际构建页面已确认移除 ST-LINK/SWD 与等待任务的常驻说明。 |
| 响应式与菜单 | 浏览器实际检查 STM32 窗口宽 980/1100/1440 px，对应面板宽 340/460/800 px。标签保持 104×32 px，连接与发送控件可达；窄面板更多菜单可访问格式/阅读选项，页面菜单包含三个入口。 |
| 键盘与输入 | STM32 Ctrl/⌘+F 聚焦“查找输出”，零匹配计数及前后查找控件正常，Escape 返回串口记录；K210 查找与 Escape 已验证。草稿保留、HEX 行尾禁用和换行行为已验证。 |
| 独立复核 | 窄面板连接栏、窄面板标签、面板内查找三项修复通过，最新文案清理符合要求。本结论覆盖这三项修复及文案清理。 |
| 硬件/发行 | 本轮未执行实板连接、UART 收发、固件下载或完整打包。既往 K210 验收不替代这次面板变更的实板验收。 |

Node 测试文件：[console-state](../../../desktop/scripts/nodu-console-state.test.cjs)、[serial-data](../../../desktop/scope-extension/test/serial-data.cjs)、[embedded-model](../../../desktop/scope-extension/test/embedded-model.cjs)、[embedded-lifecycle](../../../desktop/scope-extension/test/embedded-lifecycle.cjs)。

当前实际界面截图：[STM32 Electron 构建页面](../../../.impeccable/review/stm32-electron-build.png)、[STM32 浅色专业 1440](../../../.impeccable/review/stm32-light-pro-1440.png)、[1100](../../../.impeccable/review/stm32-light-pro-1100.png)、[980](../../../.impeccable/review/stm32-light-pro-980.png)、[980 串口选项](../../../.impeccable/review/stm32-light-pro-980-options.png)、[980 页面菜单](../../../.impeccable/review/stm32-light-pro-980-pages.png)、[K210 深色简洁 1134](../../../.impeccable/review/k210-dark-simple-1134.png)、[K210 Shell](../../../.impeccable/review/k210-shell.png)。截图不包含实板收发或下载成功证据；本目录 SVG/PNG 线框仍为设计示例。

## 后续项与验收边界

统一的当前缓冲导出、时间戳开关和 STM32 新输出计数列为后续项。

K210 共享事件没有可靠的完整运行归属，当前通过 tooltip 与无障碍名称说明真实来源范围。跨刷新完整日志、长期录制、多设备并排及自动协议解析不属于本轮交付。Windows、真实 UART 参数设置、板卡运行/停止、SWD/ISP 下载与 BOOT 恢复流程仍需各自的实机验收。
