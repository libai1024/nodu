# 当前 K210：Flash 身份读取执行计划

日期：2026-10-19。前一阶段已冻结源码候选、离线审查和状态保全；当时未加载 RAM 或烧写。用户继续开发后，现接续本计划的实际 App 执行。激活安装只复制同一指纹候选；当前真实 JEDEC 尚未采集，容量门禁仍关闭。相机默认初始化与板级适配的独立诊断见 [MaixPy IDE 对照](camera-ide-diagnosis.md)，不将此前板子倒放暗帧与默认初始化超时混为一谈。

## 1. 自主构建部分与复用来源

候选是本项目从源码构建的独立 RAM 程序，不是执行下载的 ktool `isp.bin`，也不使用 kflash 内嵌 ISP。当前 MaixPy 没有公开 ID 接口，固定官方 ISP 候选也没有可核实的现成 ID 查询，分别见[固件接口审计](current-firmware-id-audit.md)和[官方工具审计](automatic-flash-source-audit.md)。

| 固定来源 | 实际复用与必要适配 | 许可证边界 |
| --- | --- | --- |
| [Kendryte SDK V0.5.6 / 45642af98f15c24d64703ff57c97360794ca6f55](https://github.com/kendryte/kendryte-standalone-sdk/tree/45642af98f15c24d64703ff57c97360794ca6f55) | 原样编译 `lib/bsp/crt.S`、`lib/drivers/{sysctl,fpioa,uarths}.c`；`spi.c` 的初始化/标准接收窄化为 SPI3/CS0/单线、固定命令，加周期超时与统一清理；最小 `_init_bsp` 只初始化本程序，不运行完整 BSP/文件系统 | 保留各 Apache-2.0 原头、修改说明与根许可；全部实际头文件另列，不把整包仅按顶层许可归类 |
| [ktool / 0345aa90d9b3830641373fb4e3ce4edf45d0a46f](https://github.com/loboris/ktool/tree/0345aa90d9b3830641373fb4e3ce4edf45d0a46f) | `main.c` 的 CRC 与 D2/D7/DE 包语义、`isp.h` 常量、`flash.c` 的 9F/90/4B 固定指令布局；删除全部写入、擦除、复位、任意 SRAM 写/执行功能；严格长度/CRC/白名单 | 上述文件有 Apache-2.0 头；**不复制、翻译或链接 GPL 的 `slip.c/.h`，不采用原 blob** |
| [Sipeed kflash 1.1.6 / 550828c768b16ef329695d3f5eace3f6bcf14af2](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py) | 既有 SLIP 线上格式、ROM C2/C3/C5、已成功使用的 dan 复位策略；独立有界接收器修正原接收函数解码后重复追加问题。ROM C2/C3 保留 DEFAULT=0/E0 两种已知成功状态，stub 只收 E0 | MIT 原文与归属保留；不调用其通用烧录器来加载本候选 |

持久源码/构建入口：[tools/flash-probe](../../tools/flash-probe/README.md)。逐项输入为 [source-manifest.json](../../tools/flash-probe/source-manifest.json)，复用差异为 [reuse-manifest.json](../../tools/flash-probe/reuse-manifest.json)，许可证为 [THIRD-PARTY-NOTICES](../../tools/flash-probe/licenses/THIRD-PARTY-NOTICES.md)。SDK 归档 SHA `18281ca5d8da535d8815a906f0d3f31d047b99cbd0d29f8dc98fb77c9be45a44`。

两份固定原始归档已额外保存在本机 `/Users/wangwei/.nodu/source-cache/flash-probe-20261019/`，含独立 SHA 清单，避免仅依赖 `/tmp` 缓存；没有从该缓存执行旧工具链或第三方 loader。

目标 runtime 实际保留 6 个旧官方 libgcc 成员：4 个 double soft-fp 辅助、clz 函数及表；没有 libc、libm、GNU16 libgcc、nncase 或 C++ runtime。分别保留 GPL3/GCC exception、LGPL2.1/额外链接许可、实际 newlib 头声明，不称整个 BIN 为纯 Apache。来源、文件和闭包细节见[运行库审计](flash-probe-runtime-audit.md)。工具链官方发布来源已固定；没有声称本机从源码自举重建了编译器本身。

## 2. 冻结构建和内存布局

原生 Homebrew 官方 GCC **16.2.0**、binutils **2.47**，公式提交 `a65d62841d62086e7f85f8a600f12e1f72feea91`；编译保持 `rv64imafc/lp64f`、ISA spec 2.2，显式链接官方 Kendryte GNU 8.2 的目标 `libgcc.a`。旧 macOS 编译器缺依赖，仅取其已核目标头/静态库，不修补系统 dylib。具体命令、宿主来源和每个输入哈希在[构建报告](../../tools/flash-probe/build-report.json)与运行库审计中。

| 项目 | 冻结值 |
| --- | --- |
| 最终 BIN | **8,672 字节** |
| BIN SHA-256 | **`314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d`** |
| ELF SHA-256 | `8ceb8eef08b9c1da94bd52135a2620ce7cf4cdb1737654c8086841f7a810fc8f` |
| entry / ROM 上传 | `0x80000000`；实际 BIN 区间 `[0x80000000,0x800021E0)` |
| BSS | 空区间 `[0x800021E0,0x800021E0)`；不清空其他应用 RAM |
| `_end` / hart0 栈顶 / hart1 栈顶 | `0x80002200` / `0x8000A200` / `0x80012200`；每 hart 32 KiB，均在 `[0x80000000,0x80020000)` 分配内 |
| 重复构建 | BIN/ELF 一致；无未解析符号；不是硬件运行证明 |

旧 **8,480 字节**候选的审查不能覆盖新产物。当前[板端审查](flash-probe-target-review.md)和[运行库审计](flash-probe-runtime-audit.md)均重新核对上述 8,672 字节指纹；UART TX 的 word 存取与半帧超时修正也已复核。[host 审查](flash-probe-host-review.md)单独核对当前 codec 与 ACK 规则。

## 3. 加载前先保全

由同一设备 worker 持有 PortLock，仅一个串口 owner；当前端口 `/dev/cu.usbserial-3120`、CH340 `1A86:7523`，执行时须重新枚举确认，不能把历史路径当永久设备身份。物理野火 CAM/GC2145 profile 与固件 `Sipeed_M1` 架构字段分开。

1. 保留原 Electron/IAB 中未保存的编辑内容，不刷新、保存、丢弃或改写这些缓冲区。板端运行中的程序须先停止；RAM 变量不能假装能完整序列化保存。
2. 用已有普通 raw REPL，`soft_reset=False`、`ide=False`，递归读取 `/flash`、`/sd` 中全部普通文件，含启动脚本、隐藏文件、库、模型和旧备份。每项限制 128 MiB、合计限制 256 MiB；任何读取/校验失败均阻止加载，不静默跳过。
3. 读取当前启动头并限定长度，保存原启动区和内嵌 SHA；另保存 **前 16 MiB 原始读取候选**，仅标为 prefix candidate。其长度、连续读取或可能的地址环回都**不认证容量或完整覆盖**；该读取只用于尽量保全现状。未知容量仍禁止烧写。
4. 每份本地副本核对接收长度、设备 SHA 与本地主机 SHA/重读 SHA；再次核对前缀摘要、启动区、每项文件及目录清单稳定。保全保持当前已验证的普通 REPL 波特率；整块重复字节使用有界 fill 编码，先读原字节并计入设备 SHA，主机逐字节还原且仍核连续 offset/精确长度；非重复块仍严格 Base64，不跳过或猜测内容。只放本机私有目录（目录 0700、文件 0600），不输出文件内容/UID/凭据。
5. 当前状态保全独立标 `stateSaved`，始终保持 `completeFlashBackup:false`、`flashCapacityVerified:false`。本轮保全不是新的 App 完整备份通过；未来实际加载前仍由 App 本次操作重新保全，不能借历史副本跳过。

保全实测记录见[当前状态保全](flash-probe-state-preservation.md)。该记录只陈述实际执行层和结果，不冒充 App 烧写或当前 ID 证据。

## 4. 拟执行的精确串口动作

**以下是已审查的实际执行顺序。** 当前已将 `resources/nodu_flash_probe_candidate.py` 逐字节复制为 worker 查找的 `nodu_flash_probe.py`，将同一 8,672 字节 BIN 安装至 `resources/flash-probe/probe.bin`，同时带入完整第三方许可证。激活前五项源码指纹与复审集合一致；`validate_build()` 无串口 I/O 核验通过，54 项 Python 测试和 TypeScript 编译通过。这些离线结果不是当前 ID 或硬件通过证据；实际结果另记新执行记录，失败仍保持门禁关闭。

1. `validate_build` 在任何新串口对象创建前核 BIN 长度/SHA、pyserial 3.5。保存并核实现有状态后，保留 PortLock，关闭 REPL transport，再以 115200/8N1、50 ms read timeout、1 s write timeout、exclusive 打开同一端口。
2. 按固定 kflash `reset_to_isp_dan` 的 **pyserial 逻辑属性**操作，每步约 100 ms：`DTR=False,RTS=False` → `DTR=False,RTS=True` → `RTS=False,DTR=True`。这是复用已使用的复位策略，不据逻辑属性臆断板上电压波形，不尝试其他板型组合。
3. ROM 发已有 14 B C2 NOP。只接受匹配 C2 的两字节 DEFAULT=0/E0；握手最多三次。之后 C3 分块只写固定 RAM：8 块 1,024 B + 最后 480 B，CRC 覆盖 address+count+data，每块成功 ACK 后才前进。任一失败都不能发 C5。
4. 仅在全体 C3 成功后发 C5，入口固定 `0x80000000`、count=0、CRC 覆盖两字段。没有用户指定地址、任意 SRAM 执行、C6 改波特率或 Flash 写入命令。
5. D2 NOP → D7 SPI3 控制器初始化 → DE 读取身份两次。请求均为完整 16 B 小端 `<HHIII>`，reserved/address/data_len=0、CRC 覆盖最后八字节；只接受明确成功。DE 固定 27 B、data_len 保留 0，CRC 覆盖偏移 8 后全部 19 B。27 B 中的 UID 8 B 随即丢弃，不记录。
6. 目标只外发 `9F`、`90 00 00 00`、`4B 00 00 00 00`。D7 仅配控制器，没有 Flash 指令；没有 FF/reset、WREN、QE/SR 写、program、erase 或通用 SPI passthrough。
7. 仅支持当前明确表：JEDEC `EF4018` / `EF7018` 且目标内部 `90h=EF17`，映射 16,777,216 B；两次 DE 必须相同。没有实现 SFDP，也不宣称支持任意厂商/任意容量。host 不声称收到了未返回的 raw 90h 字节。
8. 回应须与本次 nonce、原 session、当前 port 和固定 stub SHA 匹配。nonce/session 是主机对本次装载的关联字段，不是板端回显或密码学身份认证。CRC、长度、状态、白名单、交叉检查、重复结果或上下文任一异常都拒绝认证。每个接收最多 1.5 s、整体 45 s；目标周期预算尚无真机毫秒保证，host 超时仍负责退出。

## 5. 退出、核对和失败边界

主机 `finally` 按固定 `reset_to_boot_dan`：`DTR=False,RTS=False` → `DTR=False,RTS=True` → `RTS=False,DTR=False`，约 100 ms/步；即使取消也必须完成释放 BOOT/reset、关闭临时串口。worker 保留 PortLock，重新以普通 raw REPL/115200、非软复位接入并新建 session；失败保持容量关闭，保存日志和所有已取得副本，不强行执行后续烧写。

RAM 覆盖会终止原程序并丢失原运行态；回到现有固件要经过复位，其启动程序可能写文件，固件初始化也有已知 QE/格式化路径。**只读边界属于候选程序及其外发 Flash 命令，不属于整个复位返回过程。** 不能宣传 RAM 装载等于 Flash 全程无副作用。

返回后先核启动区、所有文件/目录，以及 ID 确认容量范围的原始 SHA 与探测前 prefix 相同。任何变化都停止自动继续，保留前后状态供核查，绝不静默覆盖或删除新数据。只有当前真实 ID 与这些核对通过后，才可将当前容量标 verified；随后仍须由新 App 重新读取完整 Flash 和所有文件、生成可解析恢复包并重验。此前候选读取不自动变成已验证完整备份。

固件实写另按[烧写/恢复计划](device-flash-plan.md)执行：固定官方镜像、无全片擦除、App 进度/成功或失败、读回 SHA 与用户文件/相机/运行回归分别留证。当前无新 App 实写记录。恢复只使用新快照的原始头/原地址和 `sha256Prefix:false`；不得把旧 CanMV 启动区恢复包当成当前完整状态。

## 6. 阶段结果

目标源码构建/重复构建、逐文件来源与运行库、板端静态审查、当前主机 codec/加载候选与保全逻辑的离线测试分别留档。Python 52 项、Node 14 项通过，TypeScript 编译通过；这些结果不等于当前 JEDEC、RAM 真机加载、完整容量认证或 App 烧写通过。最新集成源码指纹和独立负例见[集成审查](flash-probe-integration-review.md)。

## 7. 继续执行的集成增量

当前 worker SHA-256 `20b3442d564f22a47d328fa9709dadf0ad03618a4cf6f5acc8b1d66844754681`，firmware helper SHA-256 `083165dcf328c3846d160d7718c935c05ae71479c9ecf774788092032df53920`；codec/candidate/BIN 保持第 2 节与独立审查值。完整备份在复制所有文件后再次核全 Flash SHA、boot SHA、每文件 SHA 与 inventory；临写前再次核相同完整范围和文件。恢复 ZIP 在生成后及烧写前校验结构、CRC、精确长度/SHA、address0/prefixFalse，并保持固定 kflash 可解析的 compact JSON。详见 [执行前复审](flash-probe-preexecution-review.md)和[集成审查](flash-probe-integration-review.md)。

真实操作仅由主线程在隔离原生 App 4192 执行；原编辑窗口和未保存缓冲区保留。历史状态副本不复用为本次 stateSaved。本次 App 必须在自己的 current port/session/PortLock 下重新完成保全。

## 8. 首次真实加载与第二候选

新App首次fresh保全目录为 `/Users/wangwei/.nodu/backups/2026-10-19T02-22-49-845Z-3b33adf6.pre-probe`：21文件、本次启动区和16MiB未认证prefix均逐项设备/主机摘要核对，stateSaved=true；主线程另独立复查全部本地副本。随后实际执行旧314f指纹的ROM上传/启动及D2/D7确认，DE返回不是严格27字节，App拒绝容量认证并恢复普通REPL，没有烧写。原始长度/状态此前未输出，不推断其等于E4。实际记录见 `artifacts/flash-probe/20261019/app-execution/first-id-attempt.json` 与UI证据。

第二候选仍8672字节，BIN SHA `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`，ELF `bba12baa71f0fc030b0a73ebc5bb52734c4f470c798dc843f10f5e32d999881f`。SPI3固定IN0(source0)，不依赖未保证的PLL0；接收指定字节后即按官方SDK结束，去掉上游没有的SR附加等待；FIFO/TX期限、CS/SSI清理不变。失败增加E5=9F收发、E6=90收发、E7=白名单交叉检查、E8=UID收发，仍只返回两个状态字节；成功27字节/CRC/白名单和三条Flash读取命令不变，无reset/FF/QE/写入/擦除。两个差异各有可靠性依据，不声称已证实首次异常原因。

宿主仅将BIN pin改为新值，candidate与active均SHA `6445757f6c9b9fdcc76da8ee0a4240b8c137726679d58da8a670864050dab5b4`；codec SHA `caa90b2e1192c5ac30191435898643394fb20b4d22f1ad306af9943f6289c929`，仅非27B错误报告长度/首两个协议状态元数据，不输出payload/UID。55项Python、C ASan/UBSan、重复构建/ISA/word-MMIO与独立增量复审通过，实际部署逐字节匹配。这些仍不认证第二次硬件结果；需在新App会话重新保全后再读。旧完整产物保存在 `tools/flash-probe/history/314f29f2-before-clock-diagnostics-delta/`。

## 9. 启动中断与取消修正

第二次 App 操作仍在 fresh 保全期间，经 Stop 安全取消，未加载第二候选；部分副本与取消日志保留。固定 MaixPy `machine_uart.c:167–173` 在第二个Ctrl+C到达时可能清除尚未处理的异常；`maixpy_main.c:589` 到默认 `_boot.py:16–20` 有启用中断后的约200ms等待窗口。新worker SHA `6088862b3028997247fed3fd54731232ed32c79cd0050cf83749d6f3a3b20ced` 改为每轮单Ctrl+C且间隔重试，移除Stop和备份恢复外层紧接的重复发送；依旧不soft-reset、不调用FW_VERSION、不改启动文件或配置。59项Python通过，fake还执行真实mpremote父握手并核无CtrlD/双C、取消连接关闭/PortLock释放及三次恢复失败上界。

这提高覆盖启动窗口的机会，不保证在所有Flash初始化或不可中断C操作前抢占成功。第二次保全清单与第一次相比仅发现SD相机输出JPEG变化（4125→4161B），只记录发生在两次清单之间，未证明具体写入原因；不以该差异自动豁免任何返回后的原件检查。第三次操作仍需fresh保全和严格原件一致，再决定是否认证容量。

## 10. 大文件保全分段重传

第三次操作在复制第19个普通文件期间被严格Base64校验拒绝，错误为 `Malformed backup chunk.`；18份已验证副本及失败部分保留在 `2026-10-19T02-54-16-404Z-fa205bb4.pre-probe`。App恢复115200普通REPL，stateSaved=false，尚未装载dcc候选，未认证容量、未烧写。

后续保全/完整备份按64KiB区间读取：Flash使用绝对base+相对offset，文件仅rb/seek；线上每段offset从0开始，原BackupReceiver的精确长度、FILL/Base64、设备SHA和本地重读SHA规则保持不变。只有通过校验的段才能拼入目标副本，失败段最多重试两次，每份快照累计12次失败即停止。重试保持同一PortLock/transport，仅单Ctrl+C回到raw REPL，无soft-reset、波特率变更或板端写入。取消/截止时间继续生效，不把任意本地I/O故障当成可重试串口错误。

拼接文件fsync后重新读取整份本地SHA，再与新读取的完整远端文件大小/SHA或Flash范围SHA比较。文件和Flash仍须经过原有后续稳定性检查，分段成功不代替整份快照校验。失败段保留在本机私有目录供诊断；尚待新的测试、审查和App实机执行结果，不据此宣称硬件通过。

分段实现已限定复审，Python全套70/70通过。当前worker为78048B/SHA `b55d1ecb52a9efad1d2bbced4809444eb31c48f079d0101ab3970d8bd3c3deaa`，firmware helper为26213B/SHA `0baf7ca66256792423f36e66896d32924effe3f6b1ea1703163f19a252aaf736`。SHA行非ASCII污染仅规范化为FirmwareError，仍拒绝该帧并纳入相同有限重试；不是宽松解码。负例涵盖每段/累计失败上限、取消不重试、整体源摘要/大小变化和本地part篡改，文件早EOF/seek失败关闭也核对。等待本次新App实机执行，不把测试替代容量/烧写验收。

## 11. 脱敏分帧证据与定向预检

旧第三次坏帧没有保留原始帧或其元数据，不能倒推是offset解析还是Base64出错。源码限定：该错误仅在DATA前缀/冒号头已通过后，由16进制offset或严格Base64解码失败产生；独立日志行通常会在前一层以Unexpected response拒绝，合法CRLF与串口read任意分片均不应改变Base64。新接收器仅在失败时写私有诊断sidecar：异常类型、已收offset、预期长度、行长度、Base64长度/非法位置类别、首尾分隔符计数和最近32条读取/行边界；不记录载荷、Base64、stderr原文或实际非法字符。诊断存储失败保留原异常，取消不重试、不写此sidecar。

同一App备份动作先从最近32个保全目录候选的失败manifest与partial文件大小选定位提示；旧bytes/认证标志均不复用。当前提示为第19文件下一帧offset2030592（0x1efc00），fresh inventory大小匹配后，以当前同一worker/PortLock读取最多64KiB，一次严格接收，无retry；再独立读取同范围SHA及前后源文件大小。仅标transferPreflight通过，不标完整备份或容量通过。预检成功才继续本次完整保全，任一失败仍有界恢复并阻止RAM加载。87项Python测试通过，另有独立限定审查；新代码仍待本次App实际验证。

## 12. 第四次保全结果与阶段诊断增量

4193原生App的 `2026-10-19T03-53-18-323Z-7f8fd806.pre-probe` 已完成定向64KiB一次读取、21份文件（16,812,796B）、boot和16MiB未认证prefix保全，双侧SHA及最终目录/文件稳定性核验通过，`stateSaved=true`。prefix SHA为 `c2945a0e2a3e1f26a2e31ed3c55202d88a0c07b8d010e392a78818bbc5b53d11`。本次未出现坏帧，不代表旧坏帧原因已确定。

随后RAM身份传输超时；当时host没有阶段元数据，因此目标是否执行、具体失败命令仍未知。已恢复普通REPL并实测输出 `NODU_REPL_OK`，之后断开。没有接受当前JEDEC、容量或烧写结果。执行证据在 `artifacts/flash-probe/20261019/app-execution/`。

新host仅添加C2/C3/C5/D2/D7/DE阶段及有界接收统计，保留异常对象、取消、协议和时限；不记录payload/UID。worker新增保全副本缓存：只从匹配端口/固件且stateSaved的未认证保全中选择字节来源，逐级拒绝symlink和逃逸，核对本地SHA与当前远端完整SHA，再创建新私有副本并记录当前session。末尾prefix/boot/文件/目录稳定性门禁不变；完整备份仍重新读取全部范围。它不继承旧容量或完整备份标志。

当前worker SHA `69a37c3508caaf7746e35d8bc4dd68d9fe4e7199aaaf205aabdce4ce0bc52ec4`，两份host均 `2dfdacb7648efacaac1ba47d465ea06d498c809de5a9dc68e9cb787364133c9a`，DCC BIN未变。独立缓存测试9项通过，固定MaixPy venv完整相关suite **100项通过、无跳过**；这些新增路径尚未替代一次带阶段记录的硬件身份验收。

## 13. 第五次：DE / E7 拒绝及返回后核验

4193 原生 App 沿用既有后端和唯一串口 owner，加载上述 worker/host 与未变的 DCC BIN；未刷新人正在使用的编辑器。新保全目录 `2026-10-19T05-50-25-349Z-52b946ca.pre-probe`：21 个文件、两个目录、boot 和未认证 16 MiB prefix 均通过最后稳定性核验，`stateSaved=true`。其中 20 个文件和 prefix 来自第四次副本，但均重新核对当前远端完整 SHA、本地原件 SHA 和新副本 SHA，并绑定当前 session；另一个文件重新读取。旧 manifest 字节未改，缓存没有继承容量或完整备份认证。

本次首个失败明确为 **`DE-identity`，第 1 次读取收到 2 B `DE E7`**。统计为 4 个线上字节、一个解码帧、两个 SLIP 边界、零 SLIP 错误；不是接收超时。根据严格控制流，可以推知 C2、全部九个 C3 分块、D2、D7 已成功，C5 请求完整写出；这不是每阶段完整抓包，C2 实际尝试次数未知。短错误帧没有 CRC，不能由 SLIP 合法性推断这些状态字节已通过 CRC 校验。

当前目标中，E7 只发生在 9F 和 90 接收函数均返回 0、但联合白名单未通过时；返回 0 仅表示控制器 RX FIFO 提供了请求数量的字节，SPI 没有芯片级 ACK。允许条件仍为 `(EF4018 或 EF7018) 且 legacy90=EF17`。E7 在 4B 之前返回，本次未执行 UID 读取。实际五个 ID 字节被现役错误分支丢弃，因此**尚不能区分不支持的芯片型号与不正确的读回值**，也不能认证容量。

已恢复普通 115200 REPL，并在同一 App 用只读 RAM 脚本逐一核对 21/21 文件、前后目录清单、boot 和 prefix。最终结果全部一致，耗时 13,127 ms；随后断开，系统串口 owner 为空。原 `test.py` 内容和 Ln 1 / Col 11 恢复，自己的两个核验脚本标签关闭。证据见 `artifacts/flash-probe/20261019/app-execution/fifth-attempt.json`、`fifth-repl-recovered.jpg`、`fifth-postcheck-serial-result.jpg`。容量、完整备份和固件烧写仍未通过，未烧写任何固件。

首版手工核验脚本错误地交错更新两个 `uhashlib.sha256` 对象。固定 MaixPy / SDK 的 SHA 实现共用一个硬件引擎、不保存完整链状态，导致 prefix 与 boot 返回相同的无效摘要；该次摘要不能解释为设备内容变化。已保留失败脚本及截图，并改为完成 prefix 摘要后再创建 boot SHA、分别重读。串行脚本及其期望值经独立核对，实际截图确认全部匹配。此前 worker 的各项 SHA 原已顺序执行，不受此手工脚本错误影响。

现役 worker 在 `module.probe()` 抛错后会恢复 REPL，但会跳过成功分支的自动原件复核；本次通过上述手工只读检查补全。后续任何新探测仍须保留这个返回后检查，不能将“REPL 已恢复”等同于“原件已验证”。本阶段不盲重试、不改 SPI 时钟或白名单；下一候选只在隔离目录准备 E7 已读字节的固定长度、带 CRC 诊断，不部署到现役资源，也不运行硬件。

### 隔离 E7 诊断候选

离线候选位于 [e7-diagnostic-candidate](../../tools/flash-probe/e7-diagnostic-candidate/README.md)，BIN 为 **8,792 B / SHA `f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874`**。只将 E7 失败响应扩展为 `[DE,E7,JEDEC3,legacy90x2,CRC32-LE(first7)]` 共 11 B，取自本次已完成的两次读取，不增加 SPI 传输、UID、时钟变更或重试。成功 27 B、其他错误 2 B、白名单与现役认证路径不变；离线 host 解析器只返回两个固定 false，不提供容量或认证字段。CRC 仅校验诊断帧完整性。

本机纯 C ASan/UBSan 和 Python 10 项诊断测试通过；源码、逐文件许可、构建输入与目标产物指纹、diff 和测试命令保存在同目录。此候选未激活、未加载 RAM、未执行硬件；现役仍为 8,672 B DCC reader。本次不据候选构建通过推定 E7 物理根因。
