# 自动 Flash 识别：官方来源与只读适配审计

日期：2026-10-19。本文件为只读源码审计和未实现方案，未连接串口、未运行 host、loader、工具链或固件二进制，未新增分发包。网络源码仅在 `/tmp` 缓存用于阅读与哈希计算。**当前会话容量未认证，烧写门禁保持关闭。** 既有历史 ID、备份与当前会话的区别见[容量状态](device-capacity-status.md)。

## 结论

在下列固定官方候选中，未找到同时满足“现成 Flash ID 查询、明确无 Flash 写副作用、对应 C 源码与构建链可追溯”的未修改 RAM ISP。固定 kflash 1.1.6 可以复用 ROM 握手、SRAM 上传与启动的 host 流程，但它没有 Flash ID / JEDEC / SFDP 查询 API；D7 初始化成功不证明容量，也不证明初始化无写。不能把 `ISP_MEMORY_READ` 枚举当成 Flash 读取实现。

可继续评估的最小基线是：官方 SDK 的单线 SPI 驱动和 `0x80000000` RAM 布局，加明确限于 D2 / D7 / DE 的源码构建适配。此方案尚未实现、构建或真板验收；不使用原版 ktool 预编译 blob，也不采用“只 NOP 掉 QE”的补丁。此前混合许可路线仍见[原审计](device-flash-probe-license.md)，不能将其当作本方案的成品依据。

## 固定官方候选

以下 SHA 为本次读取时解析并固定的提交；后续复用应按 SHA 获取，而非跟随分支。

| 候选与固定提交 | 具体依据与发现 | 结论 |
| --- | --- | --- |
| Sipeed kflash.py 1.1.6，`550828c768b16ef329695d3f5eace3f6bcf14af2` | [kflash.py L384–386](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L384) 内嵌压缩 ISP；L451–456 为 ROM 枚举；L493–503 的 Flash 命令没有 ID / SFDP / 读回；L1018–1058 发送 D7 并等待状态 | host 可作传输来源；没有容量查询接口；blob 对应 C 源码、逐文件许可和构建输入未闭合 |
| Kendryte kflash.py，`5783d8d85e7397007a3ba1394a93d3f9f8ad982f` | [固定 host](https://github.com/kendryte/kflash.py/blob/5783d8d85e7397007a3ba1394a93d3f9f8ad982f/kflash.py) 同类命令集，内嵌另一份 ISP；[树](https://github.com/kendryte/kflash.py/tree/5783d8d85e7397007a3ba1394a93d3f9f8ad982f) 无对应 ISP C / 构建工程 | 不能用官方归属代替逐文件来源证明 |
| Sipeed kflash.py_deprecated，`ba6410e18612f863c7ec9add825015fee19a2b37` | [固定树](https://github.com/sipeed/kflash.py_deprecated/tree/ba6410e18612f863c7ec9add825015fee19a2b37) 只有 host / 说明 / 配置六文件；[host L407–415](https://github.com/sipeed/kflash.py_deprecated/blob/ba6410e18612f863c7ec9add825015fee19a2b37/kflash.py#L407) 亦无 ID 查询 | 不补足缺口 |
| Kendryte flash-windows，`4d5d11b236646b9eea4805c33241873c17463039` | [FlashModeResponse.cs L25–33](https://github.com/kendryte/kendryte-flash-windows/blob/4d5d11b236646b9eea4805c33241873c17463039/src/Canaan.Kendryte.Flash/FlashModeResponse.cs#L25) 只有 D1–D7；[KendryteLoader.cs L252–305](https://github.com/kendryte/kendryte-flash-windows/blob/4d5d11b236646b9eea4805c33241873c17463039/src/Canaan.Kendryte.Flash/KendryteLoader.cs#L252) 上传内嵌 `Resources/isp_flash.bin` 至 `0x80000000` 并启动 | C# host 与 BIN 可定位，未找到此 BIN 的 C 源 / 构建链或 ID API |
| Kendryte BurningTool，`a2b9b3c6a30afb21a490b61588722b1a8167e7bf` | [公共 serial.isp.h L19–29](https://github.com/kendryte/BurningTool/blob/a2b9b3c6a30afb21a490b61588722b1a8167e7bf/library/include/canaan-burn/exported/serial.isp.h#L19) 仅握手、波特率、内存上传 / 启动及 USB 切换；[private-types.h L11–30](https://github.com/kendryte/BurningTool/blob/a2b9b3c6a30afb21a490b61588722b1a8167e7bf/library/src/serial/private-types.h#L11) 虽列 D8 / F0，但实现使用 K510 波特率和 USBISP 路径 | 不把私有枚举或其他芯片协议认定为 K210 Flash ID 功能；未纳入复用 |
| Kendryte standalone-demo，`e89c35465fadb5524c892d2a1c7a76dc76e219ed` | [flash_w25qxx/w25qxx.c L52–61](https://github.com/kendryte/kendryte-standalone-demo/blob/e89c35465fadb5524c892d2a1c7a76dc76e219ed/flash_w25qxx/w25qxx.c#L52) 实现 `0x90` 两字节 ID；[main.c L34–50](https://github.com/kendryte/kendryte-standalone-demo/blob/e89c35465fadb5524c892d2a1c7a76dc76e219ed/flash_w25qxx/main.c#L34) 初始化后向 `0xB00000` 写入 40 KiB + 5 字节测试数据 | 是驱动例程，不是可直接运行的只读探针 |

BurningTool 的串口代码无独立文件许可头，仓库 [Licenses/LICENSE](https://github.com/kendryte/BurningTool/blob/a2b9b3c6a30afb21a490b61588722b1a8167e7bf/Licenses/LICENSE) 为 Qt 许可材料，[README](https://github.com/kendryte/BurningTool/blob/a2b9b3c6a30afb21a490b61588722b1a8167e7bf/README.md) 列举多种依赖许可；不能据此给其所有 host / USB blob 统一标 MIT。它不进入本轮复用范围，不继续扩展其许可审计。

## 预编译 ISP 的可追溯程度

下表只证明官方固定仓库中的字节身份，不证明相应源码、构建可复现性或初始化副作用。Python blob 仅用 AST 字面量、hex / zlib 解码并计算 SHA-256，没有导入或执行 host；C# 资源仅按字节读取。

| 来源 | 解压 / 资源大小 | ISP SHA-256 |
| --- | ---: | --- |
| Sipeed 固定 1.1.6 `ISP_PROG` | 16,512 B | `757776d0055048262ef92bd04a9f8cbad13647ec4f5c1f59494489a88d571129` |
| Kendryte `5783d8d…` `ISP_PROG` | 66,304 B | `302db794751a88ec0385d929188717dfb721a45614b17cf7030d4363295c98e4` |
| Sipeed deprecated `ba6410e…` `ISP_PROG` | 29,824 B | `03837e34ba96e603011ab741844b5f8d2e44c6bdf58ae643c9e1fd15efafccea` |
| Kendryte C# `Resources/isp_flash.bin` | 34,112 B | `ce34de96e117efe95edb17132788489767e10d560db1cd12e8073423351f617a` |

四份 ISP 不同，不能共用一个源码来源或副作用结论。Python host 的 [MIT 根许可](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/LICENSE) 不足以补出内嵌 blob 的 C 文件清单。C# 的 `KendryteLoader.cs`、`FlashModeResponse.cs`、`ISPResponse.cs` 各有 Canaan 2018 / Apache-2.0 文件头，但它们仍不解释 BIN 内部实现。

## 可审计的官方源码基线

建议后续固定 **Kendryte standalone SDK V0.5.6，`45642af98f15c24d64703ff57c97360794ca6f55`**。该版[根 CMakeLists.txt](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/CMakeLists.txt) 与 [lib/CMakeLists.txt](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/CMakeLists.txt) 没有当前 develop `02576ba67e8797444f3ee3f34c625b5ed048e707` 的 nncase 依赖；它仍需要明确实际链接闭包，不能将整个 SDK 默认构建称为最小探针。

| 文件 | 已核实许可与用途 |
| --- | --- |
| `lib/drivers/spi.c`、`lib/drivers/include/spi.h` | 各 L1–14 明确 Canaan 2018 / Apache-2.0。[spi.c L136](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/spi.c#L136) 初始化控制器，L224 设置时钟，L563 的 `spi_receive_data_standard` 发送指定命令后接收指定长度；这些函数不自动调用 W25Qxx QE / 写状态逻辑 |
| `lib/drivers/{sysctl,uarths,fpioa}.c` 与 `lib/drivers/include/{sysctl,uarths,fpioa}.h` | 六文件各 L1–14 明确 Canaan 2018 / Apache-2.0；用于控制器时钟、串口与引脚。该清单不是最终完整依赖闭包 |
| `lib/bsp/crt.S`、`lib/bsp/entry_user.c` | 分别 L1–13 / L1–14 明确 Apache-2.0；[crt.S](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/bsp/crt.S) 提供 `_start`，[entry_user.c L65](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/bsp/entry_user.c#L65) 初始化 BSS、UART、FPIOA 等再进入 main；仍须审查实际 hook / 构造器和链接代码 |
| `lds/kendryte.ld`、`cmake/{toolchain,compile-flags,executable}.cmake`、根与 `lib/CMakeLists.txt` | 无独立版权 / 许可文件头，依据仓库[根 LICENSE](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/LICENSE) 和 README 的 Apache-2.0 项目声明处理，保留根许可与修改记录；不能写成“每文件头均明确 Apache” |

实际构建链由源码证实：CMake ≥ 3.0；[toolchain.cmake L21–25](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/cmake/toolchain.cmake#L21) 指向 `riscv64-unknown-elf-*`；[compile-flags.cmake L12–19](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/cmake/compile-flags.cmake#L12) 使用 RAM 链接脚本、`medany` / `lp64f` / `rv64imafc`；[executable.cmake L21–40](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/cmake/executable.cmake#L21) 链接 `gcc m c` 与 `--whole-archive kendryte`，最后 objcopy 生成 BIN。GCC / libgcc、libc / libm 的实际版本、源码、例外条款和 notices 须按工具链档案及 link map 核实，不能只附 Apache 许可。应保存完整构建输入、源码差异、编译器 / 链接器版本与参数、ELF / map / dump / BIN 哈希；本审计没有执行构建或证明位级复现。

## 最小只读适配的边界（未实现）

- **装载布局**：官方 [ld L12 / L39](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lds/kendryte.ld#L12) 为 RAM `0x80000000`、入口 `_start`；与固定 kflash [SRAM 上传地址 L1376–1378](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py#L1376) 配套。原 ktool blob 入口 `0x805E0000` 不能交给固定 `--sram` 路径混用。只初始化自身 BSS，不能照搬 ktool 清空 `0x80000000` 起 0x5E0000 字节的逻辑，否则在新布局会抹掉自身。
- **SPI 初始化**：仅初始化 SPI3 / CS0 / MODE0 / STANDARD / 8-bit / endian 0，并设置保守时钟；发送 `9F` 获取三字节 JEDEC，再以 `90 00 00 00` 获取两字节厂商 / 器件 ID作内部交叉检查。候选白名单限 `EF 40 18` / `EF 70 18` 与 `EF 17` 相符的已核器件家族；映射依据见[容量状态](device-capacity-status.md)。未知结果、全零 / 全 FF、两次不一致或超时均拒绝认证，不从未知容量字节盲算大小。本阶段不新增 SFDP 协议。
- **外发命令限定**：不调用 W25Qxx demo 的 `w25qxx_init()`，因为其 [w25qxx.c L255–262](https://github.com/kendryte/kendryte-standalone-demo/blob/e89c35465fadb5524c892d2a1c7a76dc76e219ed/flash_w25qxx/w25qxx.c#L255) 进入 QE 设置；不调用 ktool 原 `flash_init()`，其 [flash.c L185–204](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/flash.c#L185) 还发送 `FF FF` 模式复位。只跳过 QE 不能证明无其他副作用。新路径不能包含 WREN、状态寄存器写、模式复位、program / erase 或任意 SPI passthrough。
- **既有协议复用**：可按 Apache 文件 [main.c](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c) 的 D2 NOP、D7 初始化状态、DE ID packet / CRC 语义做显式适配；删除 Flash 写 / 擦除、任意 SRAM 写 / 执行和原版清空 SRAM / core1 跳转路径，未知操作必须明确拒绝。原标准阵列读分支被注释，不把“去掉 QE”当作恢复阵列读取的实现。
- **DE 格式**：既有响应为 27 B，16 B 头后是 3 B JEDEC + 8 B UID；不能把 `0x90` 结果偷偷塞进 UID 字段。如果不读取 UID，须初始化这 8 B 并显式标明不可用，不输出未初始化 RAM，也不把填充值当芯片 UID。内部交叉检查失败应返回错误；host 的证明只记录实际收到的数据与 stub 声明的检查结果。
- **校验与退出**：每个请求检查实际长度、payload 范围与 CRC；host 对 DE 的长度、opcode、状态 / 头部和 CRC 严格校验，任何错误都不能产生 verified。SDK 的标准 SPI FIFO 轮询没有自带超时，需可审查的超时和清理路径。结束后释放 BOOT 并按已验证复位策略回现有固件，再重连复核；复位会重跑用户启动程序，不能承诺其自身没有文件写入。RAM 操作会丢失原运行态，不能描述为无打扰读取。

## 当前组合的许可边界

当前拟议组合为：Apache-2.0 的 ktool `main.c` 中所需 packet / CRC 逻辑、官方 Apache-2.0 SDK 驱动与自行实现的 SLIP framing。SLIP 只根据 [RFC 1055](https://www.rfc-editor.org/rfc/rfc1055.html) 的线上格式及 MIT host 的协议事实独立编写；不复制、翻译或改编 ktool `slip.c/.h` 的 GPL 源码，不用旧 blob。本审计没有把“同一协议”视为已经完成来源审查：保留采用的原文件头、准确改动与 Apache 许可；SDK include / startup / runtime 的最终链接闭包仍需逐文件核查。该方案不能在尚未构建和审查时标为已允许分发或已验证硬件。

若日后改为复用 ktool GPL-2.0-or-later 的 SLIP，许可文本上可选择 GPLv3 与 Apache-2.0 部分组合，但独立 stub 整体须承担相应 GPLv3 义务，保留原始版权和许可；不能称为 Apache / GPL 任择双许可。需随分发提供实际完整对应源码、准确差异、构建 / 链接 / 加载脚本和必要 runtime 材料，不能只给上游 URL 或 patch。MIT 主产品与 stub 分目录、分进程、串口通信本身也不自动证明作品独立。这只是许可文本层面的候选路线评估，不是具体成品的法律或发布结论。依据：[GNU Apache 兼容说明](https://www.gnu.org/licenses/license-list.html#apache2)、[Apache 官方说明](https://www.apache.org/licenses/GPL-compatibility.html)、[GPLv3 §§1、4–6](https://www.gnu.org/licenses/gpl-3.0.txt)与[GNU 聚合说明](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。
