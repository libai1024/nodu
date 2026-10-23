# 下载帮助与动态状态栏

2026-10-22。沿用项目组件和颜色令牌，检查现有运行下拉菜单、Theia 对话框/状态栏、SWD 与 UART 下载及监视器交接实现后开发。

## 修改

- 运行按钮右侧的下载菜单底部新增“下载帮助”，独立菜单组产生分隔线。
- 帮助为只读弹窗，明确限定已实测 STM32F103C8T6；对比 SWD/ISP 接线、BOOT、操作步骤、运行通信与校验参数，集中回答复位、双 0 下载、复用串口三个问题。
- 文案按当前代码描述：SWD 写入校验后执行 `reset run`；ISP 需手动恢复 BOOT0 并复位；监视器自动借出/恢复，成功后尝试打开所选端口；当前运行监视器固定 8N1，波特率与程序匹配。
- 底部左侧显示当前方式和真实阶段，例如 `串口 ISP  写入 42%`、`ST-LINK  校验`。无百分比事件时仅显示阶段；不制造模拟进度。原 Flash 百分比仍表示容量，占用和下载进度分开。
- 信息图标悬浮显示同一份帮助内容，点击或 Enter/空格打开弹窗。帮助没有模型/RPC 依赖，不更改下载方式。
- 使用原生 Theia 对话框；保留标题关闭与底部关闭，支持 Esc、Tab 循环、可聚焦滚动区，关闭后焦点回到菜单按钮或信息图标。小窗口内正文滚动，关闭按钮固定可见。
- 修复验证发现的悬浮内容超宽，以及状态栏服务实例与实际组件实例不同导致的按键未触发问题，使用实际 StatusBarImpl。

## 验证

| 检查 | 结果 |
| --- | --- |
| 菜单位置与分隔线 | 底部独立组；鼠标及方向键选择、Enter 打开均通过 |
| 关闭与键盘 | Esc、底部关闭、标题关闭、Enter/空格入口、Tab 循环通过；焦点恢复通过 |
| 小窗口 | 634×876；弹窗 602 px 宽；正文 clientWidth/scrollWidth 均 592，无横向溢出，End 可读到末尾问答 |
| 悬浮帮助 | 480×520，实际内容 clientWidth/scrollWidth 均 470；未越过窗口，正文可滚动 |
| 下载方式 | 打开和关闭帮助后保持串口 ISP |
| 不触发硬件 | 帮助命令在禁止任何模型访问的测试中通过；本次未点击运行、复位、串口连接；最后硬件下载仍为 23:06:57 的 r-20261022-150657-0f4cba |
| 动态进度 | 软件事件测试通过：真实模型接收写入 42.2%、回读 17.76%；状态栏分别显示 42%、18%；阶段切换清除旧百分比，过滤其他窗口事件 |
| 其他状态 | 方式切换、编译、等待芯片、等待复位、取消、失败、退出 C 项目时移除条目通过软件测试 |
| 构建 | TypeScript、浏览器、Electron 构建通过；3 项 Node 测试通过；品牌检查与 git diff --check 通过 |

帮助功能验证未额外烧录、复位或发送串口数据。动态百分比使用隔离的软件事件验证，不冒充本次新增硬件实测。此前三次真实 ISP 写入和复位验证见 [ISP-TEST-2026-10-22.md](ISP-TEST-2026-10-22.md)。本次未重新覆盖 Windows、Electron 原生窗口键盘或更小于 634 px 的应用视口。

## 代码与证据

主要改动：`nodu-download-help.ts`、`nodu-download-status.ts`、`nodu-embedded-contribution.ts`、`nodu-embedded-commands.ts`、`embedded.css`，回归测试 `desktop/scripts/download-help.test.cjs`。

- [菜单截图](evidence/2026-10-22-download-help-menu.png)
- [帮助弹窗](evidence/2026-10-22-download-help-dialog.png)、[末尾问答](evidence/2026-10-22-download-help-bottom.png)
- [状态栏悬浮帮助](evidence/2026-10-22-download-help-hover.png)
- [界面检查结果](evidence/2026-10-22-download-help-ui.json)、[软件测试](evidence/2026-10-22-download-help-tests.tap)

内容依据：[ST AN2606 芯片 Bootloader 与引脚说明](https://www.st.com/resource/en/application_note/an2606-stm32microcontroller-system-memory-boot-mode-stmicroelectronics.pdf)、[ST AN3155 USART 下载协议](https://www.st.com/resource/en/application_note/an3155-usart-protocol-used-in-the-stm32-bootloader-stmicroelectronics.pdf)，并与本项目 `stlink.rs`、`uart.rs`、`service.rs`、`monitor.rs`、`nodu-embedded-model.ts` 实际行为交叉核对。
