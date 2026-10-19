# RAM Flash ID 候选：板端独立审查

日期：2026-10-19。范围为 `tools/flash-probe/src/{boot,protocol,slip,platform}.c`、`probe.h`、`ram.ld`、`build.py`、构建报告 / 输入清单、ELF / BIN、map 与反汇编；对照官方 SDK V0.5.6 `45642af98f15c24d64703ff57c97360794ca6f55`。审查方只读核查并计算哈希，未修改实现、打开串口、装载或执行目标代码。libgcc 组成与分发许可由另一审计单独处理，不在此给出批准。

**最终候选未发现尚未解决的 P1 / P2；两处已报告问题已修正并复核。** 这是源码与目标产物的静态一致性结论，不能作为硬件执行、退出恢复或当前 Flash 容量认证的通过记录。

## 审查产物

| 材料 | 当前值 |
| --- | --- |
| [probe.bin](../../tools/flash-probe/build/probe.bin) | 8,672 B；SHA-256 `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d` |
| [probe.elf](../../tools/flash-probe/build/probe.elf) | 148,432 B；SHA-256 `8ceb8eef08b9c1da94bd52135a2620ce7cf4cdb1737654c8086841f7a810fc8f` |
| [构建报告](../../tools/flash-probe/build-report.json) | 明确 offline only；GCC 16.2.0；`rv64imafc` / `lp64f`、ISA spec 2.2；无 libc，显式链接指定 libgcc；无未解析符号 |
| [输入清单](../../tools/flash-probe/source-manifest.json) | 69 项；已核对所用源码、SDK 输入及记录产物的哈希；没有把编译器成功等同于目标执行成功 |
| [map](../../tools/flash-probe/build/probe.map)、[反汇编](../../tools/flash-probe/build/probe.disassembly.txt)、[ELF 段](../../tools/flash-probe/build/probe.sections.txt) | 唯一 LOAD 段与 BIN 逐字节一致，映射与源码调用路径相符 |

最初 8,480 B / `152bf31a…` 候选仅作问题发现时的历史版本，不是本表最终产物；其审查结果不能代替对新哈希的复核。

## 已解决的发现

1. **UART TX 存取宽度偏差。** 初稿 `uarths->txdata.data = byte` 在 `0x8000100C` 编译成 `sb`，而官方 SDK 使用 32 位寄存器结构并配置 `-fstrict-volatile-bitfields`。当时没有证明该字节写与目标寄存器访问等价。现 [platform.c L127–135](../../tools/flash-probe/src/platform.c) 明确以 `volatile uint32_t` 写 TXDATA，[build.py](../../tools/flash-probe/build.py) 加入官方 strict flag；新反汇编 `uart_put_byte` 的 `0x800010C6` 为 `sw a0,0(a5)`，UART 初始化寄存器仍为 word 访问。此发现关闭。
2. **空 payload 的 escape 半帧未参与超时清理。** 初稿只检查 `parser.size`，`C0 DB` 会留下 `size=0, escaped=1`，直至下个 delimiter 才拒绝。现 [platform.c L154–158](../../tools/flash-probe/src/platform.c) 对 `size || escaped || rejected` 均按期限清理；源码与新反汇编一致。此发现关闭；它不是容量认证绕过。

## SPI3 与 Flash 命令闭包

[platform.c L42–59](../../tools/flash-probe/src/platform.c) 对照官方 [spi.c L106、L136](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/spi.c#L106)：选择 SPI3 时钟源 1、开启时钟、阈值 0；禁用 CS / SSI 后设置 MODE0、STANDARD、8-bit、endian 0，关闭 DMA / IRQ，使用偶数分频 512。初始化没有写 SPI data register，没有发送 `FF`、WREN、QE、状态寄存器写或阵列写 / 擦除命令，也没有调用整套 W25Qxx / ktool Flash 初始化。

[receive_identity_command L62–112](../../tools/flash-probe/src/platform.c) 只允许三个固定组合，命令后的字节必须全为零：

| 外发命令 | 接收长度 | 调用条件 |
| --- | ---: | --- |
| `9F` | 3 B | 取得完整 JEDEC ID |
| `90 00 00 00` | 2 B | 与 JEDEC 交叉检查厂商 / 器件 ID |
| `4B 00 00 00 00` | 8 B | 前两项成功且白名单匹配后读取 UID，保留既有 DE 格式 |

SPI3 基址为官方 `platform.h` 的 `0x54000000`，CS0 对应 `SER=1`。传输沿用官方 [spi_receive_data_standard L563](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/spi.c#L563) 的 EEPROM 模式：`CTRLR0=0xC07`、`CTRLR1=rx_size-1`，先填命令，再选择 CS。结果最大 8 B，写入和接收计数均受固定长度约束；没有 host 自定 SPI 命令、地址、返回长度或任意 MMIO 接口。

TX FIFO、RX FIFO 和 busy / TX-empty 等待均检查同一 26,000,000 cycle 预算；成功与超时共用 cleanup，将 `SER=0`、`SSIENR=0`。这些是周期预算，不是已测毫秒保证。反汇编 `receive_identity_command=0x80000F3C` 保留命令 / 长度检查、SPI data register 的 word 写、时限分支及清理；`probe_flash_identity=0x8000112A` 的三个调用顺序与源码一致。调用此私有 helper 的地址均来自固定常量数组；map / 符号表中未保留通用 Flash program / erase / reset 例程。

[protocol.c L46–50](../../tools/flash-probe/src/protocol.c) 只接受 `EF4018` 或 `EF7018`，且 `90h` 返回必须为 `EF17`；其他值或任何 SPI 超时拒绝输出完整 ID。UID 只占既有 `[19:27]`，没有用它夹带 `90h` 数据。host 仍须按[独立 host 审查](flash-probe-host-review.md)丢弃 UID，且不能把返回 CRC 当成硬件身份认证本身。

## UART、启动与内存边界

[platform.c L138–146](../../tools/flash-probe/src/platform.c) 仅将 IO4 / IO5 映射为 UARTHS RX / TX，没有调用重设全表的 `fpioa_init()`。沿用官方 [uarths.c L150](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/uarths.c#L150) 的 `CPU频率 / 115200 - 1` 分频，并关闭 TX / RX 中断、选择一个 stop bit；操作为 8N1 轮询。每个 TX byte 等待 FIFO 的过程有 cycle deadline，失败后停驻，不跳转或主动复位。

[boot.c](../../tools/flash-probe/src/boot.c) 接官方未修改 `crt.S`：CRT 设置 FP 状态 / 寄存器、gp / tp / 栈及 trap 地址，然后进入 `_init_bsp`。hart1 关闭中断后 park；hart0 只清自身链接 BSS，执行 fence 后进入 `probe_main`。没有原 ktool 的大范围 SRAM 清空、应用执行入口、任意 SRAM 写 / 跳转或 Flash 启动链。

| 边界 | 新 ELF / 反汇编核对值 |
| --- | --- |
| 入口 / 唯一 LOAD | `_start=0x80000000`；`[0x80000000, 0x800021E0)`，与固定 ROM 上传地址一致 |
| BSS | 空区间 `[0x800021E0, 0x800021E0)`；清零循环不会写代码 / 常量 |
| 全局 / 线程指针 | `gp=0x800029E0`；`tp=align64(_end)=0x80002200` |
| hart0 栈 | 顶部 `0x8000A200`，32 KiB 向下，底部为 `_end` |
| hart1 栈 | 顶部 `0x80012200`，32 KiB 向下，不与 hart0 栈重叠 |
| 链接分配 | `[0x80000000, 0x80020000)`，两栈对齐且在 128 KiB 内；`ram.ld` 有末端 ASSERT |
| ABI | ELF flags 为 RVC / single-float ABI，与 `rv64imafc/lp64f` 一致；静态反汇编未见超出目标的 D 扩展指令 |

当前调用路径的局部 frame 为数百字节量级，未见动态分配、递归或 libc 入口；这不是实际硬件栈高水位测试。ROM 是否确按本入口装载、当前 hart / 外设时钟状态和实际波特率仍需后续受控设备验收。

## 请求拒绝与失败清理

[protocol.c L53–103](../../tools/flash-probe/src/protocol.c) 先核对实际接收长度必须为 16，再核对保留字节、address=0、data_len=0 及 CRC（偏移 8 后八字节），之后才分派 D2 / D7 / DE；default 明确返回 BAD_COMMAND。D7 只执行控制器初始化，DE 必须在成功初始化后。DE 回包先清零全部 27 B；读取失败时清除全部 ID / UID 残留并只返回两字节错误，成功时保留原 `data_len=0`，CRC 覆盖偏移 8 后的 19 B。

[slip.c](../../tools/flash-probe/src/slip.c) 限定 16 B 接收缓冲，转义字节只追加一次；超长、非法 / 截断 escape 在 delimiter 处拒绝，主循环清 size 后重新接收。部分帧超时清空全部解析状态。响应发送上限为 27 B，callback 失败停止发送并使主循环停驻；没有错误后回落到写入 / 擦除功能的路径。

## 仍未证实的事项

- 本文没有真板 SPI 波形、ID 返回、UART ACK、cycle deadline 实时长度或重复读取稳定性结果；仅编译和查看寄存器访问不能替代这些证据。
- 未验证从当前 MaixPy 进入 ROM、SRAM 装载、D2 → D7 → DE、取消 / 超时及最终复位回现有固件的完整流程。候选本身没有自动退出 / 复位命令；host 必须负责最终硬件恢复，复位后用户启动程序的行为独立于探针。
- 当前镜像 / map / manifest 的一致性不是签名或当前会话证明。尚未审查实际集成代码是否固定镜像哈希、持有 PortLock、关联当前连接并在失败时保持容量门禁关闭；不得由 synthetic 回包或历史 ID 自动设置 verified。
- libgcc 的准确成员、ABI / 指令闭包、源码与许可证例外保留单独审计；本文没有据 `-nostdlib` 或“无未解析符号”宣称整个 runtime 已获发布许可。

本审查仅新增此记录。当前 Flash 容量认证与烧写门禁状态不因本文件改变。
