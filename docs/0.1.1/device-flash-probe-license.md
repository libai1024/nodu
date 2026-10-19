# Flash 容量探针：协议与许可研究结论

接续说明：本文保留对原 ktool/NOP 路线的历史审计。后续已采用单独的官方 SDK 源码构建候选，未包含 GPL SLIP、未使用旧 blob，且其运行库单独逐项审查；当前仅离线候选，未在 App 启用、未运行硬件。具体来源、差异、最终指纹和执行边界见[执行计划](flash-probe-execution-plan.md)与[运行库审计](flash-probe-runtime-audit.md)，不以本文旧候选结论替代新产物审查。

日期：2026-10-19。本文件是只读源码审计记录；未打开串口、未执行 RAM 探针、未核实当前芯片 JEDEC ID。**容量未验证时继续禁止烧写。** 本轮暂停把混合许可的 ktool host、ISP 二进制及对应源码包加入产品；没有新增探针模块或分发二进制。这是范围决定，不表示其许可绝对禁止使用。

## 现成工具的能力边界

| 工具 | 已核实行为 | 结论 |
| --- | --- | --- |
| [已安装 kflash 1.1.6 固定源码][kflash] | ISP 枚举只有 debug、NOP、擦除、写入、复位、改波特率、初始化与状态；没有 JEDEC/flash-read 命令。D7 初始化只等待成功响应 | 不能作为实际容量证明 |
| [ktool 固定提交][host] `0345aa90d9b3830641373fb4e3ce4edf45d0a46f` | 有 DE `FLASH_ID`，27 字节响应的 `[16:19]` 为 JEDEC 三字节；host 根据第 3 字节计算容量。ID 路径会读取 9F JEDEC 与 4B UID | 支持身份读取，但原版不是严格无写探针 |
| [ktool stub 主循环][main] | DE 必须先有 `FLASH_SET` 状态；启动时清零 BSS；D7 调用 `flash_init()` 后调用 `flash_enable_quad_mode()` | 不能在原版 stub 加载后跳过 D7 直接 DE |
| [ktool flash 驱动][flash] | `flash_init()` 设置 SPI3 时钟、寄存器与驱动偏移；QE 函数读取 SR2，bit 1 为 0 时写状态寄存器 | 不能假定 ROM 残留配置足够；也不能先 D7 再声称完全无写 |

原版没有独立读取 SR2 的 host 命令；该 C 读取函数是内部 static。未找到既不改 stub、又可先证明 QE 已置位的现成调用。固定 MaixPy 的 `Maix.utils` 只有 flash 数据读取、内存等接口，没有 JEDEC ID 接口；`statvfs` 只表示分区，不等于芯片总容量。本研究没有盲目创建 `machine.SPI` 或重配运行中的 boot flash 总线。

## 未采用的仅 RAM 补丁方案

[上游 build 说明][build] 提供 stub 源码、原始 BIN、ELF 与反汇编。原 host 内嵌的 ISP 与上游 `build/isp.bin` 已逐字节核对相同：

| 材料 | SHA-256 |
| --- | --- |
| `ktool.py` | `800794f7d621f44e393400d31b291c2f087d0cabf986dd35ae727eb33729dca5` |
| 原始 `build/isp.bin`，9,984 字节 | `65057a7454fde7f333f8aa5fed3105bbd39ba0ba94016a9e8291582dccf5fc79` |
| `build/isp.dump`，183,882 字节 | `51d1dd93bf00d7a0ad195c8569e099920140d5ea535cd3c9f1681724ab429739` |

可供后续评估的改动是把 BIN offset `0x1F4` 的 8 字节 `97100000e78000a5` 替换为两条 RISC-V NOP：`1300000013000000`。它跳过 D7 的 QE 函数调用，保留必要的 SPI 初始化。原反汇编中调用位于 SRAM `0x805E01F4`/`0x805E01F8`，下一条是 `0x805E01FC` 的 `lw a5,0(s2)`，不读取被跳过函数的返回值。内存中计算的补丁后 SHA-256 为 `4eb6f5620496abb1f2cddd055692a2250cd652a17484b7db969f0010ce59eda1`；未保存或执行该二进制。

若后续采用，需要先完成许可与分发评估，再做独立 probe 封装：ROM 只允许握手、固定 SRAM 区间上传与执行；增强 ISP 只允许 NOP、补丁后的 D7 与 DE；禁止 flash 写入/擦除指令。应验证原文件哈希、固定偏移的旧值、新文件哈希、响应长度与 CRC，拒绝全零/全 FF/未知容量编码，隐藏 UID，最终复位回现有固件并关闭串口。不能仅解析一行 host 显示文字就将容量标 verified。

## 逐文件许可发现

不能用顶层 Apache 声明覆盖所有来源。以下差异已由直接源码、构建文件和反汇编交叉核查：

| 部分 | 许可与证据 |
| --- | --- |
| ktool 根声明；`main.c`、`flash.c` | [根 LICENSE.md][license] 为 LoBo 2020／Apache-2.0；两个 C 文件各自亦有 Apache-2.0 头 |
| `slip.c`、`slip.h` | [slip.c][slip-c]、[slip.h][slip-h] 在 LoBo Apache 头后仍保留 Cesanta/Espressif 2016 的 GPL-2.0-or-later 头；dump 中的 SLIP 函数证明它们实际进入 stub |
| SDK 编译文件 | `crt.S`、`sleep.c`、`fpioa.c`、`gpio.c`、`sysctl.c`、`uart.c`、`utils.c` 各自为 Canaan 2018／Apache-2.0 |
| 完整 Python host | 无独立文件头；源自 kflash，AES 段注明 pyaes。应保留 [Kendryte 2019 MIT][kflash-mit] 与 [Richard Moore 2014 MIT][pyaes-mit]，不能只附根声明 |
| GCC/newlib 运行库 | 构建使用 GCC 8.2.0、newlib 3.0.0；dump 含 libgcc soft-fp 等函数和 newlib memset。需保留相应 GPL/runtime exception、LGPL/link exception 与 newlib/SiFive permissive notices，不能统一改写来源归属 |

后续可以评估以 GPLv3 兼容方式分发 stub 组合并保留 Apache 部分声明；[Apache 官方兼容说明][compatibility] 只支持兼容性判断，不代替对具体分发物的义务核对。对应源码至少涉及 `src/`、`lib/`、`cmake/`、`lds/kendryte.ld`、根 CMake 文件、构建脚本及准确补丁，并要记录工具链与运行库来源。仅放 host、BIN 和根 LICENSE 不足以清楚交代这些义务。

本轮不为了容量诊断扩大产品分发范围。已有 16 MiB 备份若尚无实际容量证明，仍是候选快照；必须核实实际容量、快照覆盖与完整性，才能解除烧写门禁。

[kflash]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py
[host]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/ktool.py
[main]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c
[flash]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/flash.c
[build]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/build/README.md
[license]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/LICENSE.md
[slip-c]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/slip.c
[slip-h]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/slip.h
[kflash-mit]: https://github.com/kendryte/kflash.py/blob/999fab6780da21c88dabd306eefe41e810f1c342/LICENSE
[pyaes-mit]: https://github.com/ricmoo/pyaes/blob/1fd2a0aee1f43b575b57529026cb3d2e7efd8dcf/LICENSE.txt
[compatibility]: https://www.apache.org/licenses/GPL-compatibility.html
