# 当前状态保全记录

2026-10-19。执行层为已有 Python worker 的普通 raw REPL 服务 API，**不是新 App 完整备份/烧写验收**。没有安装或运行 RAM ID 候选，没有固件写入，没有容量认证。原有 Electron/IAB dirty buffers 未操作。

## 第一次尝试（失败，保留现场）

- 当前端口 `/dev/cu.usbserial-3120`；普通 raw REPL，固件实际返回 `MaixPy 0.6.3 (v0.6.2-89-gd8901fd22 on 2024-06-17)`，架构字段 `Sipeed_M1 with kendryte-k210` 与物理 profile 分开。
- 私有目录：`/Users/wangwei/.nodu/backups/state-preservation-20261019-093127.pre-probe`。
- 目录清单含 21 个普通文件、2 个目录；预计传输 33,590,112 B（用户文件 + 未认证的 16 MiB prefix）。清单仅列本机路径、大小和摘要，不输出文件内容。
- 前五个小文件已接收并核对摘要，第六个文件接收超时；所有原始字节和 manifest 保留，`stateSaved:false`、`completeFlashBackup:false`、`flashCapacityVerified:false`。
- finally 日志确认恢复 115200；disconnect 释放 PortLock，随后 `lsof` 无该端口 owner。没有加载 RAM 候选，未发出 ISP/硬件 reset 或板端文件写入命令；不能由此额外证明底层未发生任何隐式重启。

这次失败不能标为完整保全。继续诊断连续传输和恢复，不跳过失败文件，不用旧 CanMV 备份填补当前状态。

## 读取对比与传输修复

- 原 1,500,000 baud 下单独读取同一个 2,581 B 文件，再次发生严格 Base64 校验失败；没有放宽 padding/长度/摘要规则。
- 115200 下连续读取同文件六次均通过，摘要一致。921600 的临时诊断在切换 EOF 阶段失败；随后重新独占串口，普通 REPL 在 115200 成功回应，最终释放 owner。该诊断没有硬件 reset/ISP/板端文件写入。
- 当前备份实现保持已建立的普通 REPL 波特率，不再为备份重新初始化板上 UART。对整块重复字节增加有界 fill 编码，逐字节还原后继续核对 offset、长度、设备/主机/本地重读 SHA；非重复块仍用严格 Base64。它不是跳过空白区、推测内容或容量测量。
- 新增混合块往返、坏格式、超长/越界、哈希后数据拒绝等离线覆盖；Python 52/52 通过。真实状态保全重试结果另记，不以单文件诊断代替完整结果。
- 两次 inventory 的大小比较发现 `/sd/maixpy_demo_camera.jpg` 为 4,261 → 4,086 B；其余路径/大小一致。仅保全原始字节，未解码、查看或输出图片内容，也未向该文件发写入命令；本记录不推断变化原因。重试保存本次实际读取版本，结束时仍需重新核对全部摘要与目录，不能宣称它与最初失败尝试时的状态完全相同。

## 重试完成（当前状态保全通过，容量仍未认证）

- 本次私有目录：`/Users/wangwei/.nodu/backups/state-preservation-20261019-094438.pre-probe`。普通 REPL 全程保持 115200；本次没有 UART 提速、RAM ID loader 或固件烧写。
- **21 个普通文件，16,812,721 B**，另含 2 个目录。每项接收长度、设备 SHA、主机 SHA 与本地重读 SHA 一致；结束前再次核对全部板端文件大小/SHA 与完整目录形状，均未变化。
- 当前启动区 **2,116,325 B**，原 flag=`02`、payload=2,116,288 B；原头与内嵌 SHA 通过，payload SHA 与固定官方镜像一致。原始启动头保留，不重复添加启动前缀。
- 原始前缀候选 **16,777,216 B**，设备流摘要、主机接收摘要、本地重读摘要和再次板端整段摘要一致；**仍为容量未认证的 prefix，不是完整芯片覆盖证明**。

| 副本 | SHA-256 |
| --- | --- |
| 当前 Flash 前缀候选 | `a142e003b0d1fbfb62e2e11bd6702538b9502362b65e4cd512bb9dc0c019ab4f` |
| 原启动区 | `bd55469971151a2df1ae4bc262dce1305bfcafa53acb5fcd1583ab585a5f1014` |
| 固件 payload | `6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa` |

本地主线程另做一次独立校验：21 文件逐项长度/摘要、前缀长度/摘要、启动区字节与前缀起始一致、原头/内嵌 SHA、0700/0600 权限均通过；启动区已额外 fsync。`lsof /dev/cu.usbserial-3120` 无 owner，服务已断开归还端口。

结果保持 `stateSaved:true`、`completeFlashBackup:false`、`flashCapacityVerified:false`；未采集当前 JEDEC，未运行候选，未执行 App 完整备份或实写。保全的是本次读取和最后复核时的状态，下一次实际加载前必须重新保全本次会话。

证据：[最终本地复核](../../artifacts/flash-probe/20261019/state-preservation-result.json)、[逐文件副本复核](../../artifacts/flash-probe/20261019/file-copy-verification.json)、`artifacts/flash-probe/20261019/service-retry.jsonl`（仅本地保留）、`artifacts/flash-probe/20261019/service-first-attempt.log`（仅本地保留）。日志只有结构化状态/计数/摘要，无原始文件内容。
