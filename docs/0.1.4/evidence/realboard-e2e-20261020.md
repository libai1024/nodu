# 真机全流程测试：历史 USB 阻塞记录 — 2026-10-20

**此阻塞已解除。** 开发板随后以 `/dev/cu.usbserial-3110` 枚举，真实测试已执行。
当前结果和遗留项统一见 [学生流程测试](student-journey-20261020.md)。
以下表格记录的是板子接入前的历史状态，不代表当前测试结果。

前置条件未满足，全部步骤未执行。阻塞原因：**K210 开发板未接入主机**。

- 指定端口 `/dev/cu.usbserial-3120` 不存在。
- `ioreg -c IOSerialBSDClient` 仅列出 `debug-console` 与
  `Bluetooth-Incoming-Port` —— 系统内没有任何 USB 串口节点。
- IOUSB 设备树仅含 Apple 集线器、Keychron 键盘、Generic USB2.1 集线器、
  Toshiba `EXTERNAL_USB` 移动硬盘 —— 无 CH34x/FTDI/CP210x/PL2303 类
  USB-串口芯片，野火 K210 CAM 未枚举。
- 持续轮询 60 s 无新设备出现；`/Applications/MaixPy IDE.app` 未运行
  （无进程）。
- 原始证据：`artifacts/e2e-0.1.4/usb-enumeration.txt`。

## 步骤表

| 步骤 | 结果 | 说明 |
| --- | --- | --- |
| A0 baseline /flash 列表+SHA | 未执行 | 板未接入 |
| A1 连接 | 未执行 | 板未接入 |
| A2 运行摄像头示例 | 未执行 | 板未接入 |
| A3 禁用/启用帧缓冲 | 未执行 | 板未接入 |
| A4 录制/结束录制 | 未执行 | 板未接入 |
| A5 停止 + REPL 回归 | 未执行 | 板未接入 |
| A6 boot.py 写入/回读/还原 | 未执行 | 板未接入 |
| A7 发送文件往返 | 未执行 | 板未接入 |
| A8 阈值编辑器 | 未执行 | 板未接入 |
| A9 设备文件只读浏览 | 未执行 | 板未接入 |
| A10 断开 + 端口释放 | 未执行 | 板未接入 |
| A11 复位/重连（含断电子步） | 未执行 | 板未接入；断电子步本来就需人工 |
| A12 终态完整性比对 | 未执行 | 板未接入 |

## 环境（已核对）

- 仓库 HEAD `1a85418`（工具/窗口/帮助菜单提交）。
- 浏览器后端 `127.0.0.1:4188` 运行中（HTTP 200，该版本代码）。
- 无产品代码改动；`artifacts/e2e-0.1.4/` 仅含上述 USB 枚举证据。

## 解锁条件

需将野火 K210 CAM 板接入本机 USB（应出现 `/dev/cu.usbserial-*` 或
`/dev/cu.wchusbserial*` 节点），然后重跑本计划 A0–A12。
