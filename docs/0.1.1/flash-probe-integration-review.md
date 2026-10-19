# RAM Flash ID 候选的独立集成审查

日期：2026-10-19。审查范围为 Python 候选加载器、纯协议编解码、worker 状态保全与容量认证流程。本任务仅读取源码、运行 synthetic / mock 测试；未打开真实串口、未复位板子、未加载 RAM 程序、未烧写 Flash。

结论：已按下表冻结指纹完成离线集成审查，未发现 P1/P2。仅使用现有普通 REPL 调用 `_preserve_before_probe` 保存本地原件的读取路径，没有发现阻止本阶段保全的代码问题。此记录不表示候选已经真机运行，不批准加载 RAM 候选，不解除容量或完整备份门槛。

后续备份传输修复采用不同的 worker / firmware 指纹，当前保全读取应同时按末节“传输修复的限定复审”核对。原审查指纹和原测试记录保留，不将它们外推为新版本或完整保全的真机成功证据。

## 已固定的候选

| 文件 | SHA-256 |
| --- | --- |
| `resources/nodu_flash_probe_candidate.py` | `1e7ee3cc4d2f59baf64ec58a6def84172397b85c317252ae141b47f0de5d7e93` |
| `resources/nodu_flash_protocol.py` | `ae8e4920b722dfef82407a443a3ec97efa631bc195411d90250d813687b44f00` |
| `resources/nodu_device_worker.py`，73,190 字节 | `31eeb04c24416cbb9fd841dc56726527a9e847126a8fba2a18b0fd1bf1d2c58a` |
| `tools/flash-probe/build/probe.bin`，8,672 字节 | `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d` |
| `resources/nodu_firmware.py` | `cdc992b3393b80670841c3477243a861f416ddcf0f744bff419802b90496546b` |
| `test/worker_flash_probe_test.py` | `1716a83fd26eecaaf35ff16fd8eb5e5d1e1fe9ee039e49a21ea6a822a07fa332` |
| `test/worker_firmware_test.py` | `8c5cbb0cce92901ab250b029b3903f9c2c9945f2e4467c038d1ceaead558a95e` |

除 `tools/` 项外，上表路径均相对于 `desktop/scope-extension/`。目标 BIN 的来源、逐文件许可和运行库闭包另见 [runtime audit](flash-probe-runtime-audit.md)。加载器不把官方原有 ISP blob 当作本程序；其 `source-built-kendryte-sdk-v0.5.6` 字段描述当前自行构建的窄化候选，不宣称是未修改的官方工具。

## 加载器与协议检查

- `validate_build()` 先检查固定长度 / SHA-256、拒绝目标文件符号链接，并要求 `pyserial==3.5`，其后才创建 / 打开串口。候选只使用 worker 已持有的 PortLock，不另释放或替换该锁。
- ROM 操作只有 C2 握手、C3 固定 `0x80000000` 起的有界 SRAM 上传、C5 固定入口执行。每个 C3 必须写满并收到有效 ACK，失败路径不继续 C5；不能提供任意地址、一般写入命令或通用执行入口。
- ROM ACK 严格限定 opcode 和既有 DEFAULT / OK 状态；stub ACK 必须 E0。stub 仅发 D2、D7、DE；两个 DE 响应都需固定 27 字节、固定头字段、覆盖 UID 在内的 CRC、白名单 JEDEC，并且解析后的身份结果一致。
- UID 只留在短暂接收字节中参与 CRC，不进入返回字典、日志或持久证明。host 也没有把内部 90h 原始字节说成已收到的串口证据。
- `requestNonce`、`sessionBeforeProbe`、`probePort` 是 worker / host 本次调用的关联字段，**不是板端回显或加密挑战**。当前协议的板端证据是本次独占串口交易的受限读命令和 CRC 响应，不能给这些字段附加超出实现的认证含义。
- 取消、超时、错误 ACK、部分上传和错误 / 不一致 ID 都经过 `finally`；已打开串口会尝试既有 dan boot-pin 恢复并关闭。退出恢复不受用户取消中断；若恢复引脚失败，则报错而不返回成功容量证明。恢复启动仍可能执行板端已有启动代码，不能把整个往返过程描述为 Flash 无副作用。

当前 `resources/nodu_flash_probe.py` 和候选实际期望的 `resources/flash-probe/probe.bin` 均不存在。worker 入口因此在保存 / 关串口之前报 unavailable，自动加载门仍闭合；`tools/` 下离线 BIN 的存在不启用该入口。

## Worker 审查边界

已读版本采用 `validate_build → 保存 / 验证当前文件与 boot → check → 关闭原 transport → probe → finally 恢复普通 REPL → 校验本次 proof → 校验文件 / inventory / boot → 认证容量` 顺序。原串口 PortLock 在临时串口与重连之间保持占有；普通 REPL 恢复用 `soft_reset=False`，创建新 session。取消后的恢复临时忽略取消代次，恢复完成后再保留取消结果，不把取消转成容量成功。

proof 必须 `verified is True`，并且 port、旧 session、本次 nonce、stub SHA 与调用值逐项一致；支持容量只允许 16 MiB。文件或启动 boot 校验失败时保留本地原件，容量认证保持 false；不会自动把旧文件覆盖回板端。

最终 worker 的保全函数通过既有 `Maix.utils.flash_read` 复制固定 16 MiB 前缀，并标记 `completeFlashBackup=False` / `flashCapacityVerified=False`。文件名、manifest scope 和日志均明确它只是未认证前缀候选；不由读取长度、历史 ID 或回绕推定容量。其传输使用有界 offset / chunk / SHA 协议，文件 fsync 后读取本地副本重算 SHA；从该候选提取当前 boot 并核对嵌入 SHA、先前 boot header，再次核对设备前缀 SHA、boot SHA、所有文件 hash 和目录 shape。保全结果与后续独立 `backupDevice` 完整备份分开记录。

`_ensure_flash_capacity` 在本次 JEDEC 证明成功且容量确认为 16 MiB 后，仍要求当下同范围 Flash SHA 与保全前缀相同；任何启动导致的变化都会阻止认证和继续烧写。先前前缀的长度与哈希只用来比较 / 恢复原件，不承担证明物理容量的作用。当前 boot 长度限制为 8 MiB 是保全范围限制，也不作为容量证据。

仅调用保全函数的路径没有 `_reset_isp`、`_reset_boot`、串口 loader 或硬件复位；临时提速及恢复只走既有普通 raw REPL，恢复使用 Ctrl-C 与 `soft_reset=False`。因此该阶段应记为服务层本地状态保全，不能标为 App 完整备份、Flash ID 真机验收或 RAM reader 真机运行。

## 独立验证

在上述最终 worker 指纹上独立运行 `~/.nodu/python/bin/python -m unittest discover -s desktop/scope-extension/test -p 'worker*_test.py' -q`，50/50 通过。另直接通过 mock 验证 9 个负例：

1. port、旧 session、nonce、stub SHA 分别不匹配时逐一拒绝，不进入后续文件校验。
2. probe 中取消仍保留 PortLock、恢复普通 REPL / 新 session，保持未认证。
3. 返回固件后发现启动文件变化时阻止认证，不创建完整备份记录。
4. build 认证失败时不开始保全、不关闭原 transport、不调用 probe。
5. 当前整个 Flash 范围 hash 与保全前缀不同，即使当前 ID、boot 与文件检查通过，仍拒绝认证。
6. 真正加载模块尚未安装时，在保全 / 串口关闭之前拒绝入口。

这些验证使用纯模拟 transport / module；它们证明错误路径的代码行为，不是 ROM、芯片容量、实际复位线或恢复启动行为的真机证据。

## 传输修复的限定复审

2026-10-19 追加。第一次服务层状态保全在原 1.5 Mbaud 第六个文件超时；后续单文件诊断复现严格 Base64 excess-padding 错误。原失败 manifest、局部文件与恢复日志保留，不能记为完整保全。主任务在 115200 下对同文件六次读取获得一致摘要，并已记录 921600 诊断失败及重新独占 115200 普通 REPL 恢复，详见[状态保全记录](flash-probe-state-preservation.md)。这些是主任务执行记录，本审查未另开串口。

本次仅复核备份帧编码 / 解码和同波特率恢复，未重做目标 BIN、codec 或 RAM 加载器审查；它们的固定指纹仍与原表一致。

| 受影响文件 | 当前字节数 | SHA-256 |
| --- | --- | --- |
| `resources/nodu_device_worker.py` | 73,292 | `cace45735290a50737d1f2fb3281a2484ebcb8ab674567c78409c8c6ad281372` |
| `resources/nodu_firmware.py` | 16,729 | `2cb23b6b67ca3d32d48728fe3ee7278433bf17a5e4b3126ffd8ff53f14aca6e0` |
| `test/worker_firmware_test.py` | — | `893da3e241c014b53f9e9b797c92bc6b7d97f04021101f922b52b3dae97ac4fa` |

`_fast_backup_serial` 现在保持已建立的 `self.baud`（当前连接为 115200）；没有调用 `_change_baud`，没有重新初始化板上 UART。finally 在同一 baud 最多尝试 3 次清输入缓冲 / Ctrl-C / 普通 REPL 重同步，每次 `soft_reset=False`、5 秒上限，仍受 20 秒恢复 deadline 限制。三次均失败时标 phase=error 并报错；不放弃 PortLock、不软复位、不触发 ISP 或 Flash 写入。方法名虽保留，当前行为已不提速。

`dump_script` 对每一块仍先实际读取最多 3,072 个原始字节并计入设备 SHA。仅当本次整块逐字节相同，才发送 `NODU_FILL offset:byte:count`；其余仍发送严格 Base64。host 限定 8 位小写十六进制 offset、2 位 byte、1–4 位十进制 count，count 必须正好等于当前应收块长度；展开后与普通数据经过同一个 `_chunk` 验证连续 offset / 长度 / 剩余范围。最终设备 SHA、主机 SHA、fsync 后本地重读 SHA 全部保留，哈希后数据拒绝。该编码没有跳过物理读取、推测空白区域、宽松修复坏 padding 或认证容量。

在上述新指纹独立运行 Python suite，**52/52 通过**；另独立验证 3 项受影响错误路径：FILL 的 byte 被改动而设备 SHA 不变时拒绝认证；前两次重同步失败、第三次成功时仍同 baud / 非软复位且保留锁；三次均失败时有界退出并标 error。未复跑无关 UI 或目标构建。

限定结论：未发现 P1/P2 阻止使用新指纹重试**服务层普通 REPL 保全读取**。完整当前保全仍须记录其实际逐项结果；六次单文件读取与这些离线检查不代替完整保全、当前 JEDEC、RAM reader 或 App 烧写验收。真正加载入口和 App resource BIN 仍未安装，容量门禁保持关闭。

## 恢复包与完整快照验证补强

后续授权阶段追加。此小节仅记录本地恢复材料和 worker 校验的代码 / 测试，不代表本审查执行了串口、RAM 加载或烧写。之前各阶段的指纹、门禁状态和实测结论按当时记录保留。

实现前已直接读取本机固定 `kflash.py` **1.1.6**，源码 SHA-256 `26e13e5f753b86f59c0b6da561871f2b732e36453723ed9b8176f851b7af8367`，对应 [Sipeed 固定提交 550828c768b16ef329695d3f5eace3f6bcf14af2](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py)。KFPKG 分支在 ISP 初始化后使用 `ZipFile.extractall`，再预处理 `flash-list.json`，按 `int(address, 0)` / `bin` / `sha256Prefix` 烧写。其既有 MIT / Copyright 2019 Vowstar 声明保留在项目第三方 notices / 原文中。本次使用相同包格式与字段语义，自行实现范围更窄的校验，不调用或复制该 `extractall` 路径。

源码核对发现原默认单行 `json.dumps` 输出会被 kflash 1.1.6 的贪婪 address 预处理破坏：地址已经是 JSON 字符串，又会被正则包装。新包使用无冒号空格的 compact JSON，仍保持字符串 `"0x00000000"` 和真正的布尔 `false`；原预处理不会匹配此格式。正例直接运行该固定预处理表达式后再解析，确认兼容，不执行 loader。

`validate_restore_packages` 对 boot / full 两份 KFPKG 分别要求恰好已知 raw 文件与 `flash-list.json`；拒绝重复、额外成员、路径变化、symlink、加密 / 不支持的压缩方式、注释、额外本地记录、前导 / 尾随数据与不一致 ZIP 目录。结构读取有固定边界，JSON 限 4 KiB、payload 每次最多读取 64 KiB，无文件解压到目录。读取至 EOF 核 ZIP CRC、展开大小和 SHA，并与当前私有 raw 文件 / manifest 同时匹配。schema / 版本 / 文件名 / 规范 address=0 / `sha256Prefix is False` / compact 格式和重复 JSON 键都严格检查。

创建原 boot 副本和 ZIP 后先 flush / fsync，再调用该 helper 验证；`validate_backup` 在调用 loader、设备 hash 或释放串口之前再次检查全部恢复包。原始 boot flag / 长度 / SHA 都保留在 raw 内容中，不重新添加 K210 前缀。

| 本次集成输入 | SHA-256 |
| --- | --- |
| `resources/nodu_firmware.py`，25,285 字节 | `083165dcf328c3846d160d7718c935c05ae71479c9ecf774788092032df53920` |
| `test/worker_firmware_test.py`，36,510 字节 | `c6289e7343c6b90ff6cd16289ded6c6ad22985ade2249952645bb6cd11a7ee9d` |
| 主任务独立修改的 `resources/nodu_device_worker.py` | `20b3442d564f22a47d328fa9709dadf0ad03618a4cf6f5acc8b1d66844754681` |

主任务的 worker 变更在全部文件接收之后重算当前完整已认证 Flash 范围摘要，再核 boot、所有文件与 inventory，记录 `snapshotVerification`；烧写前又核当前完整 Flash 与文件 / inventory，写后再核 inventory。本任务未修改 worker，仅适配与补充对应 synthetic fixture。

该组合 Python suite **54/54 通过**。恢复包负例包含 12 类子案例：缺 boot / full 包、损坏 ZIP、错误 address、错误 prefix、有效 ZIP 内 payload 改动、重复成员、路径逃逸、额外 payload、重复 JSON 键、CRC 损坏及旧版不兼容 JSON 格式。每例都证明异常发生在设备 hash / 串口关闭 / loader 之前。另有完整 Flash、文件内容、inventory 三类备份漂移负例，均保留失败 manifest、阻止生成恢复包并保持无认证 backup record。正例先生成两份恢复包后才允许 `validate_backup` 通过。

目标 BIN、RAM loader 和 codec 未修改，不因这次本地材料校验而重新构建或扩大目标执行审查范围。代码已交回主任务用于最后的 App 集成复核；真实完整备份、ID、恢复执行与烧写结果须另留实际证据。

## 启用前最终复核与部署快照

用户要求继续开发、从新 App 完成真实流程后，本任务再次执行限定的只读源码审核及离线验证；没有串口、UI 或板端操作。worker `20b3442d…54681`、firmware `083165dc…53920`、codec `ae8e4920…4f00`、candidate `1e7ee3cc…7e93` 和 8,672 B BIN `314f29f2…b113d` 均逐字节复算匹配上文完整指纹；Python suite 再次 **54/54 通过**。

重新核对 ROM 发送面仍只有 C2 / 固定 SRAM 范围 C3 / 固定入口 C5，各上传块先收到有效 ACK 才允许 C5；stub 仅 D2 / D7 / DE。目标硬件面仍只有固定 9F / 90 / 4B，SPI 接收的成功与超时出口均释放 CS、禁用 SSI；UART 失败或异常停驻，不跳转其他代码。目标周期预算尚未取得真机时间保证，host 每次接收 1.5 秒、整体 45 秒和 finally 退出仍负责失败恢复。返回固件的启动代码副作用与 RAM reader 自身命令边界继续分别描述。

本次复核后，主任务将候选逐字节复制到真实加载路径；再次只读核验得到：

| 部署文件 | 字节数 | SHA-256 |
| --- | --- | --- |
| `resources/nodu_flash_probe.py` | 7,723 | `1e7ee3cc4d2f59baf64ec58a6def84172397b85c317252ae141b47f0de5d7e93` |
| `resources/flash-probe/probe.bin` | 8,672 | `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d` |

部署目录同时具有 `build-identity.json`、说明和 SDK / kflash / GPL3 / GCC runtime exception / LGPL / newlib notices。这里的“已安装”仅代表资源入口已启用，不继承前面历史阶段“入口缺失”的状态，也不等于已经通过当前硬件 ID 或恢复测试。

没有发现新的 P1/P2 阻塞项。真实操作仍必须由同一独占 owner 在本次请求先完成 fresh preservation，随后才加载固定程序；当次 ID、proof 上下文、返回普通 REPL、文件 / inventory / 完整范围摘要、独立完整备份与恢复 ZIP 校验必须分别成功，才能进入实际写入。未知社区 blob、历史 ID 和 synthetic fixture 都不能替代其中任何证据。本审查没有取得新的硬件成功证据，真机结果由主任务另行记录。

## 第一次响应异常后的限定复审

主任务记录第一次 App fresh preservation 成功并运行过旧 `314f29f2…` reader，D2 / D7 获得 ACK，但 DE 解析仅确认“不是 27 B”；当时未采集实际长度 / opcode / status，因此不能把该异常写成已观察的 2 B / E4、特定 SPI 超时或任何 JEDEC 值。已返回普通 REPL，容量未认证、未烧写。D7 函数只配置控制器并返回成功，也不能单凭它证明 Flash 通信正常。

新候选只做两处可靠性调整与无 payload 诊断：SPI3 source 改为固定 IN0=0，避免最小 BSP 未保证的 PLL0 依赖；读满 NDF 后按固定 SDK 接收实现直接清 SER / SSI，移除额外的接收后 SR 等待。FIFO / transfer 周期期限和失败 cleanup 保持。源码 / 反汇编已核 IN0 选择，固定 SDK `sysctl.c` 的 SPI3 分支确认 0=IN0、1=PLL0。两处调整各有独立依据，**没有证明其中哪项是首次异常根因**。

9F transfer / 90 transfer / 白名单交叉检查 / UID transfer 失败分别只发 2 B 的 E5 / E6 / E7 / E8；其他结果归 E4，身份缓冲清零，不回 raw ID 或 UID。成功仍严格 27 B、原 CRC / 白名单，无新增 Flash 命令。host codec 的非 27 B 错误仅增加长度和首两字节的定长 opcode / status 元数据，不打印完整 payload，成功校验未放宽。另一独立只读 codec 审核结论一致。

| 新冻结部署项 | SHA-256 |
| --- | --- |
| BIN，8,672 B，源码产物与实际 App resource 相同 | `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05` |
| ELF | `bba12baa71f0fc030b0a73ebc5bb52734c4f470c798dc843f10f5e32d999881f` |
| map | `9ad5a0d89c0961f45c220486a6dd8dc28f9ea508c2bbda02bec05af35171cfb4` |
| candidate / 实际 `nodu_flash_probe.py`，逐字节相同 | `6445757f6c9b9fdcc76da8ee0a4240b8c137726679d58da8a670864050dab5b4` |
| codec | `caa90b2e1192c5ac30191435898643394fb20b4d22f1ad306af9943f6289c929` |

独立确认 host 文件仅更换目标 SHA pin；map 仍仅保留原 6 个旧官方 libgcc 成员，无新 archive / libc，`nm -u` 空，entry / 单浮点 ABI 保持，UART TX 仍为 word store。旧产物在 `tools/flash-probe/history/314f29f2-before-clock-diagnostics-delta/` 保留且旧 BIN 哈希匹配。新 metadata 负例覆盖短帧、附带私有内容、空值和非 bytes；本次独立 Python suite **55/55 通过**。

限定结论：未发现新 P1/P2；新模块与资源 BIN 已再次复算一致。此审查未操作串口，新候选第二次硬件执行尚未作为本次复审通过证据；真实结果、退出恢复与容量门禁必须由后续本次交易决定。

## K210 单 Ctrl-C 握手的限定回归

主任务后续发现固定 MaixPy UART handler 会在 pending exception 非空时，由下一个 Ctrl-C 清空 pending；依据为固定 `d8901fd2…` 的 `machine_uart.c:162–173`。`maixpy_main.c:589` 在 `_boot.py` 前启用 interrupt char，`_boot.py:17–18` 的启动窗口按 1 ms 让出执行。本次复审仅覆盖该固件相关的单 Ctrl-C 握手修正；没有改 production worker、目标 BIN、SPI 或 codec，也未操作串口 / UI。

| 冻结项 | SHA-256 |
| --- | --- |
| production worker | `6088862b3028997247fed3fd54731232ed32c79cd0050cf83749d6f3a3b20ced` |
| `test/worker_test.py` | `63718e47aed637692e1be88c7c502e996572071542789b7b2e7ec80f74686aac` |
| `test/worker_firmware_test.py` | `ebba981014e3bcf7f8610e8911c5392eb4b9de78eb011a53993d1a2c25308b17` |

新的 fake serial 按每个接收字节模拟 pending toggle，并分别表示“UART 已接收”和“interrupt char 尚未启用”。先验证同一次 write 内双 Ctrl-C 确实抵消 pending、不产生 prompt；再通过真正的 `open_transport` 与带 side-effect spy 的真实 mpremote 父 `enter_raw_repl`，验证延迟启用中断时单 Ctrl-C 重试有间隔并最终进入 raw REPL。即使调用方传 `soft_reset=True`，父调用始终收到 False；完整写序列包含父函数自身的单 Ctrl-C / Ctrl-A，没有双 Ctrl-C 或 Ctrl-D。该 peer 只模拟相关行为，不作为完整固件仿真或实际握手成功证据。

同时覆盖：取消连接不调用父 enter，关闭 fake serial 并释放 PortLock；worker shutdown 仅发送一个 Ctrl-C；Stop 不在 transport 之外预发 Ctrl-C；backup finally 在取消期间可恢复 I/O，但返回后取消重新有效，原 deadline / `restoring_io` 恢复；三次恢复均失败时有界退出、标 error，仍不额外发送 Ctrl-C。

本次仅运行一次 Python 集合，**59/59 通过**。只读核 worker delta 后未发现 P1/P2 阻止使用该新指纹重新连接 / 保全。第二轮保全已由主任务取消且尚未运行新 `dcc96436…` RAM reader；新握手和后续保全 / ID 的真实结果仍须另记，不能由这些 fake 回归推定。

## 分段快照接收的限定静态复审

2026-10-19 追加。此项仅只读审查新 `_receive_snapshot`、其保全/完整备份调用者，以及 `dump_script` 的 offset 支持；未运行串口、UI 或板端程序，未修改 production 代码，也未重新执行测试。测试由独立任务负责，最终结果另记，不沿用上节的 59 项数量。

| 当前审查输入 | SHA-256 |
| --- | --- |
| `resources/nodu_device_worker.py`，78,048 B | `b55d1ecb52a9efad1d2bbced4809444eb31c48f079d0101ab3970d8bd3c3deaa` |
| `resources/nodu_firmware.py`，ASCII SHA 解码规范化之前 | `43e5ebe2fec8a459add3c41bc57a621ef2da82be49ab3a79ffed3b842bbd98b0` |

`_receive_snapshot` 在建立本地输出前先验证整段范围；每次最多接收 64 KiB，沿用严格的相对 offset、块长度、设备 SHA、主机 SHA 和 fsync 后本地重读 SHA。只有完整验证的 part 经长度/摘要再次复核，才追加至组装文件；成功 part 删除，失败 part 与未认证的组装文件保留在随机私有目录。组装完还核本地文件大小/整体摘要，再独立重新读取设备全源 SHA；文件同时比较实际全源长度。任一比较失败均不返回认证摘要。

每个范围最多 3 次尝试，单次 `_receive_snapshot` 累计第 12 次失败即停止；该计数不是跨所有文件的整个 backup 请求计数。每段循环、重试与最终源 hash 前后均受取消代次和请求 deadline 检查；接收器另有 20 秒无数据上限。错误范围重试前先清串口输入并以 `soft_reset=False` 重新取得 REPL，成功后才提交后续范围，没有把旧流残留直接当作新范围，也没有释放当前 PortLock 或切换 baud。最终恢复只临时忽略取消以取得有界 I/O 恢复，退出后恢复原 deadline/取消语义。

`dump_script` 的 size/offset 严格拒绝 bool、非整数、负数和超过 Flash/用户文件固定上限的组合。Flash 源地址是绝对 offset 加本段相对位置；文件只用 `rb` 打开，在 `try/finally` 中 seek/read/close。生成的源代码没有文件写入、删除、Flash program/erase、波特率重初始化、软复位或 IDE 命令。该代码层结论不保证设备其他线程/已有启动程序不会写数据。

保全与完整备份调用者在标记 `stateSaved` / 完整 backup verified 之前，还会重新比较全 Flash、boot、所有文件 hash 和目录 shape；保全返回后、开始 RAM 加载前仍有 `self.check()`。本地未认证片段或相等的分段长度不会自行解除当前 JEDEC/完整备份门槛。

发现并已反馈一项可靠性缺口：原 `BackupReceiver.line` 的 SHA 分支对非 ASCII 字节直接抛 `UnicodeDecodeError`，不属于新分段层重试的 `FirmwareError/ProtocolError`。它会严格失败并保留局部数据，不会错误认证，但会绕过本应进行的坏帧重试。主任务已安排由 firmware owner 将该 ASCII 解码异常规范化为 `FirmwareError` 并增加负例；修复应保持原 64 位小写十六进制、重复 SHA、最终整体摘要和大小检查全部不变，不做字节修补或宽松解码。该修复及最终 firmware 指纹/独立测试仍待后续补记。

限定结论：除上述已安排修复的异常分类边界外，未发现新增 P1/P2 的认证放宽或板端写入路径。此项不表示分段保全已真机成功、不证明 RAM reader 的下一次硬件结果，也不批准跳过任何容量/恢复材料门禁。

### 分段复审收尾指纹

随后只读确认 SHA ASCII 解码已用精确 `except UnicodeDecodeError` 转为 `FirmwareError`；64 位小写十六进制、重复 SHA 与整体摘要/大小条件均未放宽。worker 指纹仍为本节的 `b55d1ecb…`；最终 `resources/nodu_firmware.py` 为 26,213 B，SHA-256 `0baf7ca66256792423f36e66896d32924effe3f6b1ea1703163f19a252aaf736`；`test/worker_firmware_test.py` 为 57,837 B，SHA-256 `2b3e954ccd7bd261ff81f7953249ca5d5bc2e67eed047ed1ee724f09b16379a8`。本审查重新计算这三项哈希，均与独立测试任务交付值一致。

独立测试任务报告 Python discover 全集一次 **70/70 通过**：覆盖实际 dump 脚本与 receiver 的假串口分段往返、非对齐/尾端/空范围、early EOF 与 seek 异常关闭、坏 Base64/非 ASCII SHA 的严格拒绝后重试、每段 3 次与单快照 12 次失败上限、取消不重试，以及最终源大小/摘要变化和本地 part 篡改拦截。以上是本机 mock 回归，不是串口或板端成功记录。

限定收尾结论：前述异常分类缺口已在最终指纹消除，本次分段接收与调用者范围内未发现新增 P1/P2；没有新增板端写入路径，没有放宽任何容量、快照或烧写认证。真实状态保全、ID 读取和恢复材料仍分别验收。

### 有界预检与脱敏诊断复审

worker 87839B/SHA `5b98247c6c3f7bc11f832acc25c05a80a0079dfcac965f7e1f0d9ced367f2e04`。独立审查未见新增认证放宽或板端写入：旧manifest/partial只给定位提示；当前App对64KiB范围严格接收、独立SHA、源大小前后核验，只有preflight标志，不提升capacity/completeBackup。失败sidecar没有Base64、载荷、stderr正文或非法字符本身，环形trace最多32项，诊断存储异常不覆盖接收异常。新17项测试和全套87项通过。扫描数是最近32个保全目录候选；恢复失败仍可能让manifest最终error显示恢复异常，原始分帧类型留在sidecar，不据错误文案放宽门禁。新App实测预检另见fourth-preflight.json，整体保全/探针/实写尚未通过。

### 第四次结果、阶段诊断和保全副本缓存

第四次fresh保全及最终稳定性门禁已通过，后续RAM身份传输超时且旧host阶段未知；具体结果见执行计划第12节。新host只给原ProbeError/ProtocolError对象追加一条脱敏阶段JSON；取消保持原异常，finally恢复未改。两份host字节一致，SHA `2dfdacb7648efacaac1ba47d465ea06d498c809de5a9dc68e9cb787364133c9a`。

缓存增量经独立限定review及9项新测试，当前worker SHA `69a37c3508caaf7746e35d8bc4dd68d9fe4e7199aaaf205aabdce4ce0bc52ec4`。缓存只是经当前远端全SHA重新认证的字节来源；拒绝路径逃逸及逐级symlink，不修改旧manifest，副本私有且独占创建，仍执行最终prefix/boot/文件/inventory核验。复制后的目标必须精确匹配当前远端预检SHA，不宣称源文件在整个复制期间没有任何变化。完整backup继续重新获取所有范围并校验恢复包。固定依赖venv完整suite100项通过、无跳过；当前硬件容量和实写仍未通过。

### 第五次现役执行结果

第五次 App 操作完成当前 session 的 21 文件、目录、boot 和未认证 prefix 保全；20 文件与 prefix 的旧字节来源经过当前远端完整 SHA 和本地逐份 SHA 重新核验，新 manifest 记录当前 session / 来源 manifest 摘要，旧 manifest 未改。随后首个 DE 收到 2 B `DE E7`，SLIP 无结构错误；C2/C3/D2/D7 成功及 C5 完整写出只由严格控制流推知，不冒充逐包阶段证据。2 B 错误不带 CRC，也没有实际 JEDEC / legacy 字节。

固定源码确认 E7 表示两个身份读取函数已获得指定数量的 RX 字节、但联合白名单拒绝；这不证明返回的 ID 是有效芯片 ID。E7 在 UID 命令之前返回。独立 SDK 对照未发现帧长、TMOD、NDF、FIFO / CS 顺序或 endian 的直接差异；时钟来源 / 分频存在已知差异，采样和 XIP 继承状态尚无寄存器读回证据，不能把它们直接宣称为本次根因。

探针错误分支只自动恢复 REPL，原件核验由主线程随后在同一 App 手工完成：21/21 文件、两次目录清单、boot 和 prefix 全一致，串口已释放。首次手工脚本交错两个硬件 SHA 上下文产生的摘要无效，已明确保留并由串行重读结果取代；独立审查核对固定 MaixPy / SDK 共用 SHA 硬件及最终截图。此结论仅覆盖当前已保全范围，不能认证物理容量、完整 Flash 备份或固件烧写。

后续 E7 扩展仅作为独立离线候选准备；没有放宽现役成功响应、白名单、来源 pin 或容量门禁。本次详细证据及错误脚本更正见执行计划第 13 节。

隔离候选的[独立复审](../../tools/flash-probe/e7-diagnostic-candidate/review.md)未发现 P1/P2：53 项冻结产物逐项匹配，现役源码 / 资源 / pins 未改；C ASan/UBSan、Python 10/10 及额外 765 项拒绝检查通过。候选为 8,792 B / SHA `f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874`，仅 E7 诊断扩展。它尚未激活或执行硬件，不替代当前 ID 或容量认证。
