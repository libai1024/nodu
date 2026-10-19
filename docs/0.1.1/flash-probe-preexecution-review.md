# RAM Flash ID 读取：执行前窄复审

日期：2026-10-19。此记录只核源码、文件指纹和离线测试；审查者未打开串口、执行 RISC-V BIN、操作原生 App/IAB 或改写实现。**不表示已经取得当前 JEDEC、完成硬件加载/退出、认证容量或通过烧写。** 原生 App 与 IAB 的未保存缓冲区不属于本次操作范围。

## 1. 本次核对的指纹

入口集合与主线程指定值全部一致：

| 文件（仓库相对路径） | 字节数 | SHA-256 |
| --- | ---: | --- |
| `tools/flash-probe/build/probe.bin` | 8672 | `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d` |
| `desktop/scope-extension/resources/nodu_device_worker.py` | 73292 | `cace45735290a50737d1f2fb3281a2484ebcb8ab674567c78409c8c6ad281372` |
| `desktop/scope-extension/resources/nodu_firmware.py`（入口版本） | 16729 | `2cb23b6b67ca3d32d48728fe3ee7278433bf17a5e4b3126ffd8ff53f14aca6e0` |
| `desktop/scope-extension/resources/nodu_flash_protocol.py` | 6989 | `ae8e4920b722dfef82407a443a3ec97efa631bc195411d90250d813687b44f00` |
| `desktop/scope-extension/resources/nodu_flash_probe_candidate.py` | 7723 | `1e7ee3cc4d2f59baf64ec58a6def84172397b85c317252ae141b47f0de5d7e93` |

本次不重建、不修改冻结 BIN。[板端审查](flash-probe-target-review.md)、[host codec 审查](flash-probe-host-review.md)和[运行库审计](flash-probe-runtime-audit.md)分别记录其适用范围。8 项纯 codec unittest 本次独立重跑，全部通过（exit 0，0.003 s），包括 ROM ACK、连续 SRAM 分块/CRC、严格 DE 长度/头/CRC/完整 ID、SLIP 转义与错误后恢复；测试没有串口 I/O。

另一审查 lane 增加恢复包验证后，`nodu_firmware.py` 收尾指纹为 **25285 B / `083165dcf328c3846d160d7718c935c05ae71479c9ecf774788092032df53920`**；期间观察到的中间版本为 `1a8f8de19f09749b564d95c3863554a65111f9f6bac3c07dde4e139ec80a8805`（24814 B）。入口版本审查不自动覆盖这些 delta；恢复包验证由运行库/恢复包审查 lane 另行记录。最终启用前仍需核对该 lane 的最终指纹集合，不能混用旧集合与新实现。

主线程随后完成完整备份和临写前核对的两个窄 delta，本次均已独立复读。**最终 worker 为 74376 B / `20b3442d564f22a47d328fa9709dadf0ad03618a4cf6f5acc8b1d66844754681`**；BIN、codec、candidate 指纹仍与上表一致。最终 worker 取代入口 worker；中间版本 `2c42a15b583216c7c4f68dfa9d0acfd3567e2406f56e1b769dc0c41bb79d5002`（74037 B）只用于定位前一项 delta，不是本次最终指纹。

计划中的安装是将 candidate **逐字节复制**为 `desktop/scope-extension/resources/nodu_flash_probe.py`，将冻结 BIN 逐字节复制为 `desktop/scope-extension/resources/flash-probe/probe.bin`；两份目的文件必须分别保持上表 candidate/BIN 的长度与 SHA。本记录初稿读取时，目的文件尚未存在；文件名变化本身不构成新硬件证据。

## 2. 再读的固定来源与复用边界

本次重新阅读了下列固定原实现关键片段，而非只依赖先前结论：

| 固定来源 | 关键原文位置与本次核对 |
| --- | --- |
| [Sipeed kflash 1.1.6 / `550828c768b16ef329695d3f5eace3f6bcf14af2`](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py) | MIT，Copyright 2019 Vowstar；完整许可保留于 `tools/flash-probe/licenses/kflash-MIT.txt`。`kflash.py:750–755` SLIP 发送，`841–868` dan ISP/boot 复位，`916–917` C2，`976–1002` C5 与 DEFAULT=0/E0 成功状态，`1070–1093` C3 地址/长度/CRC。安装副本 SHA 为 `26e13e5f753b86f59c0b6da561871f2b732e36453723ed9b8176f851b7af8367`。 |
| [ktool / `0345aa90d9b3830641373fb4e3ce4edf45d0a46f` 的 `src/isp/main.c`](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c) | 文件头 Apache-2.0，Copyright 2020 LoBo；`39–57` CRC32，`206–218` DE 固定 27 B、CRC 覆盖 19 B、JEDEC 3 B + UID 8 B。原 D7 `84–106` 会调用 QE 初始化，不是本候选 D7 的实现；没有加载原 isp.bin，也不复用 GPL `slip.c/.h`。 |
| [官方 SDK V0.5.6 / `45642af98f15c24d64703ff57c97360794ca6f55` 的 `spi.c`](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/spi.c) | 文件头 Apache-2.0，Copyright 2018 Canaan；`106–113` SPI3 时钟，`136–177` 初始化字段，`563–640` 单线 EEPROM 接收流程。候选只作 SPI3/CS0/固定读命令的窄化，并增加超时与统一释放 CS/SSI。 |

原 kflash `recv_one_return:794–805` 的转义后重复追加未沿用；当前 codec 解码后只追加一次。新目标还包含独立记录的 GCC runtime/头文件许可，不能称整个 BIN 为纯 Apache。逐文件 notices、源码清单和修改说明见[来源审计](automatic-flash-source-audit.md)及 `tools/flash-probe/{source-manifest,reuse-manifest}.json`，本轮没有新增第三方来源或重启旧 mixed GPL stub 路线。

## 3. 已审阅的命令与失败边界

候选 `nodu_flash_probe_candidate.py:29–39,127–149` 在创建新串口对象之前核固定 BIN 长度/SHA 和 pyserial 3.5；端口只允许本地字符串。使用当前 worker 已持有的 PortLock，115200/8N1、50 ms read timeout、1 s write timeout、exclusive；DTR/RTS 顺序与上述 dan 方法相同。Python 逻辑属性不能替代板上实测电压波形。

候选 `153–175` 的线上动作仅为：

1. C2 固定 14 B 握手，最多三次；仅接受匹配 opcode 的两字节 0/E0 成功状态。
2. C3 固定 SRAM 地址 `0x80000000`，8 × 1024 B + 480 B；CRC 覆盖地址、count、数据，每块 ACK 成功后才继续。失败不发 C5。
3. C5 只启动固定 `0x80000000`、count=0，不接收调用方地址；随后 D2 → D7 → DE → DE。D2/D7 只收匹配两字节 E0；偶发迟到 C5 两字节成功 ACK 最多忽略两次，不能充当 D2/ID 成功。
4. stub 请求均为 16 B、reserved/address/data_len=0、CRC 覆盖最后 8 B。DE 必须精确 27 B、data_len=0、CRC 覆盖 bytes[8:27]，完整 ID 仅接受 EF4018/EF7018，映射 16777216 B；两次解析结果必须相同。全 0/FF、未知 ID、坏长度/头/CRC/状态/转义都失败。UID 只纳入 CRC 后丢弃，不输出。

冻结目标 `platform.c:42–124` 的 D7 只配置控制器；DE 只外发 **9F、90 00 00 00、4B 00 00 00 00**，内部要求 JEDEC 白名单且 90h=EF17 后才读 UID。不存在 Flash reset/FF、WREN、QE/SR 写、program、erase、任意 SPI/Flash/SRAM 指令入口。host 未收到 raw 90h 数据，不将其伪装为 host 实测字段。未实现 SFDP，也不推广到其他厂商或容量。冻结目标的 CRT、hart/栈布局、32 位 UARTHS MMIO 和超时清理由既有板端审查覆盖，本次未以重新编译代替审查。

每次接收 1.5 s、整体 45 s 的 host 预算均会检查取消；目标 cycle 预算尚无真机时间标定。候选 `183–190` 无论成功、失败或取消均尝试固定 boot 复位并关闭临时串口；恢复控制线失败会报错，不返回成功结果。**只读保证限于该候选的 Flash 命令；返回固件要复位，原启动代码仍可能写文件/Flash。**

## 4. 当前会话的保全与关联

入口 worker `989–1079` 每次探测前创建全新私有 `.pre-probe` 目录，普通 raw REPL 读取文件、原启动区及未认证 16 MiB 前缀，核接收长度、设备 SHA、本地重读 SHA、启动头内嵌 SHA，再重核前缀/启动区/文件内容/目录清单。不将 prefix 长度、历史 EF17 或 profile 当成当前容量证明。任何保全异常都在关闭原 transport、加载 RAM 之前停止。

worker `1100–1168` 在保全成功后保持 PortLock、关闭 REPL FD，传入本次 nonce、原 session、当前 port；临时 probe finally 之后重新进入 115200 普通 raw REPL、`soft_reset=False` 并建立新 session。worker 接收 proof 时检查 `verified is True`、port/session/nonce/stub SHA、容量=16777216；随后重新核全部文件、目录、启动区和完整候选范围 SHA，一项不符即停止，保留原副本，不自动覆盖返回后新状态。connect/close 都清除容量 proof 与备份记录（`624–631,646–662`）。

nonce/session 是 host 对本次操作的关联值，不是目标回显或密码学设备认证；此静态审查与 synthetic codec 成功均不能生成真实容量证据。当前串口独占、物理板对应、ROM 实际 ACK、真实 DE 读数、复位后回到当前固件仍需由主线程本次硬件操作记录。

## 5. 完整备份 delta 的复审结果

当前 worker `1245–1257` 已在所有文件复制完成后增加**第二次板端全 Flash SHA、所有已备份文件 SHA 与完整 inventory 复核**。第二次全范围 SHA 必须等于接收期间记录的设备/主机摘要，启动区再读摘要也必须相同；任一不同即抛出异常。逐文件检查验证当前路径类型、size 和 SHA，inventory 对比路径、目录标志和 size 的排序集合。只有以上检查全部返回，才写 `snapshotVerification`；容量 gate 与恢复包创建随后完成，`verified=True` 在 `1268`，异常分支清空 `backup_record` 并保持 manifest 未验证。

最终 worker 烧写后 `1357–1358` 的新增 inventory 复核也在 `flashVerification.verified=True` 之前。此 delta 没有改动 probe、串口命令、冻结 BIN 或 proof 接受规则。完整备份仍需当前容量 proof，flash 仍要求同一当前 session 的已验证备份、相同容量 proof、固定官方镜像和本地恢复字节验证；普通 JSON 请求没有写入/合成内部 proof 的入口。`execute/runScript/writeFile` 会先清除已备份记录，connect/close 还会清除容量 proof。

复审曾指出中间版本临写前只核 boot SHA 的缺口，**最终 delta 已解决**：`1312–1316` 在 boot SHA 后再核完整 `FLASH_BYTES` SHA、逐文件 SHA 与 inventory，均在临时置入烧写状态和 `transport.close:1329` 之前。全范围不符还会先清除 `backup_record`；其他校验失败也不会到达关闭 transport/烧写调用。连续读取/逐项复核仍不是文件系统原子快照，外部热插拔和板端后台写入须按实际状态处理；不能据静态审查声称已经发生了稳定的硬件快照。

恢复包结构/CRC/内容验证由另一 lane 独立审阅，不能用本记录替代；这里仅核当前 worker 调用在标记完整备份成功之前的顺序，未重审该 lane 拥有的实现。

本记录只允许确认“这些固定字节与已审查边界一致”。后续 hardware、App 完整备份、恢复、烧写与 Windows 验收须分别留证；既有未验收状态没有因本记录改变。
