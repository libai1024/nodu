# Flash ID RAM 候选：工具链与运行库审计

审计日期：2026-10-19。范围为官方宿主机工具链、对应源码指针和候选 RAM 程序的链接运行库；本审计未打开串口、未执行 RISC-V 程序、未改动板端状态。这里记录可核对的工程事实与 notices 清单，不作法律结论。`tools/flash-probe/` 由另一个构建任务维护。

**当前结论：**已用原生 arm64 GNU GCC 16.2.0 / binutils 2.47 成功从候选源码构建 ELF/BIN；显式链接旧官方 8.2.0 `libgcc.a`，最终保留 6 个运行库成员。没有链接 libc；本审计未执行板端产物。旧 macOS 8.2 编译器的宿主依赖失败保留为历史，已经不阻塞离线候选构建。

后续 IN0 / 接收完成条件 / 分阶段诊断的目标 delta 已在末节重新核对；下文 `314f29f2…` 的地址和产物表保留为前一候选记录。

## 固定工具链来源

官方 [Kendryte 发布页][assets] 包含 `kendryte-toolchain-osx-mojave-8.2.0-20190213.tar.gz`，页面显示发布时间为 2019-03-25；tag 名称中的日期不等于此 macOS asset 的上传日期。当前使用的本地归档是该官方 asset，未使用 ktool 目录附带的工具链副本。

| 项目 | 实际核验值 |
| --- | --- |
| Release tag | `v8.2.0-20190213` |
| 工具链仓库 tag 对应提交 | `fbf55383711b68c00ecf67e23959822180010398` |
| macOS asset 长度 | `50,919,270` 字节 |
| macOS asset SHA-256 | `f3cc7dc8c5fa8928aa804cc305f91935957ef81c41829064d8ee8da8d5aa8ec4` |
| `riscv-gcc` gitlink | `bce905d919791374b0dbeb2d02ece8fae98ece5e`，仓库 `kendryte/kendryte-gcc` |
| `riscv-newlib` gitlink | `01de41f55e386c935b593402855622fb7aba25c8`，仓库 `kendryte/kendryte-newlib` |
| `riscv-binutils-gdb` gitlink | `00f223631fa9803b783515a2f667f86997e2cdbe`，仓库 `bminor/binutils-gdb` |

tag 以 `git ls-remote` 固定，随后浅克隆该 tag，以 `git ls-tree HEAD` 核对三个 gitlink；[该提交的 `.gitmodules`][modules] 核对仓库归属。GCC [BASE-VER][gcc-version] 是 `8.2.0`；newlib [README][newlib-readme]、生成的 configure 以及 asset 内 `_newlib_version.h` 都是 `3.0.0`。工具链仓库顶层的旧版组合 LICENSE 不能覆盖子模块逐文件许可。

本机仅执行宿主机编译器 `-v` 核验标识：Mach-O x86_64、target `riscv64-unknown-elf`、GCC `8.2.0`；嵌入的配置为 `--with-arch=rv64imafc --with-abi=lp64f --disable-multilib`，目标 CFLAGS 包含 `-Os -ffunction-sections -fdata-sections -mcmodel=medany`。编译器配置字符串不是源码来源的密码学证明。

首轮使用此旧工具链构建时，在 `cc1` 启动前被 dyld 拒绝，缺 `/usr/local/opt/isl/lib/libisl.19.dylib`。独立 `otool -L` 核验 `cc1` / `cc1plus` 还要求 `/usr/local/opt/libmpc/lib/libmpc.3.dylib`、`/usr/local/opt/mpfr/lib/libmpfr.6.dylib` 和 `/usr/local/opt/gmp/lib/libgmp.10.dylib`，以及 macOS 系统库。这些是 x86_64 宿主子进程依赖；现有 arm64 库不能据文件名直接替换。install name 的数字不能证明对应上游源码版本。本次没有下载替代 dylib、改写 install name、修改系统库路径或绕过签名，随后改用下节原生编译器；旧工具链仅保留为目标 headers / libgcc 输入。

**证明边界：**已固定官方发布来源、当前 asset 内容和 tag 的源码依赖；尚未从这些源码自举重建整个 macOS 工具链，也未发现本次审计可用的上游签名或可重现构建证明。不能把 asset 哈希或版本字符串描述成“工具链二进制已由固定源码逐字节复现”。归档内搜索 `COPYING` / `LICENSE` / `COPYRIGHT` / `NOTICE` 路径无匹配，需从固定源码另外保留相应文本；这不代表这些许可证不适用。

## 当前原生编译链：GNU 16.2.0 / binutils 2.47

使用 Homebrew 官方 `homebrew/core`，固定 [GCC formula][gcc16-formula] 和 [binutils formula][binutils247-formula] 提交 `a65d62841d62086e7f85f8a600f12e1f72feea91`。本机安装的是官方 arm64 Tahoe bottle；**候选程序从源码编译，不表示本机重建了 GCC 编译器本身**。

| 输入 | 固定来源 / 实测 |
| --- | --- |
| GCC 源码发布物 | GNU `gcc-16.2.0.tar.xz`；formula 声明 SHA-256 `e6738e29597f733270731aa90600f37ffdc045079dfc27ec7e8192cc81085c3e`；本审计未另外下载整个源码 tar 复算 |
| GCC bottle | `riscv64-elf-gcc-16.2.0.arm64_tahoe.bottle.tar.gz`；本地复算 `8f7e26c7acdfe47af2a57220b8ad9e2cb220e1056f79523b6c4a3c223bf81c28`，96,997,627 字节；匹配 formula 和 OCI manifest 的 arm64_tahoe 项 |
| binutils 源码发布物 | GNU `binutils-2.47.tar.bz2`；formula 声明 SHA-256 `3068128c75cda9f898ccb4211d360246e8e195ffcc9dfb655b23ae23a54800e8`；本审计未另外下载整个源码 tar 复算 |
| binutils bottle | `riscv64-elf-binutils-2.47.arm64_tahoe.bottle.tar.gz`；本地复算 `aea21c1219539fcea27983817f48cbcbb654b87c1c212504d61fb04725a08615`，7,640,302 字节；匹配 formula 和 OCI manifest |
| GNU GCC 16.2 源码 tag | `releases/gcc-16.2.0` tag object `1831ac03fd08e3400c16b29f21762e6b326a618d`，peeled commit `78d4ac73dd391005b895a6148cd9831e28e1208b` |
| 本机 compiler | `/opt/homebrew/Cellar/riscv64-elf-gcc/16.2.0/bin/riscv64-elf-gcc`，Mach-O arm64，`riscv64-elf-gcc (GCC) 16.2.0`；构建报告中二进制 SHA `38435e3c6da930b24b014c763e904839bc4069aaa14773cbe9bf57dd741ba792` |
| 本机 linker | `/opt/homebrew/Cellar/riscv64-elf-binutils/2.47/bin/riscv64-elf-ld`，版本输出 `GNU ld (GNU Binutils) 2.47.20260726` |

Cellar `INSTALL_RECEIPT.json` 确认两个包均为 `homebrew/core`、`poured_from_bottle=true`、`arch=arm64`；receipt 中 `tap_git_head` 为 null，因而固定 formula 提交另从官方仓库读取，不能声称由 receipt 给出该提交。GCC 的 receipt 运行依赖记录 GMP 6.3.0、MPFR 4.2.2、MPC 1.4.1、zstd 1.5.7_1、binutils 2.47，以及传递项 lz4 1.10.0 和 xz 5.8.4。OCI bottle manifest 记录的原构建 xz 是 5.8.3，与本机 receipt 的已解析依赖版本分开保留。

原生 `cc1` 的 `otool -L` 指向 `/opt/homebrew/opt/{libmpc,mpfr,gmp,zstd}` 与 macOS 系统库，没有旧 `libisl.19.dylib`。它们是构建机器的动态依赖，不进入 RISC-V BIN。没有随候选程序打包这些 Homebrew 工具或宿主动态库。

对当前 Cellar 原有 notices / formula 的只读检查记录：GMP 6.3.0 为 LGPL-3.0-or-later 或 GPL-2.0-or-later（保留 `COPYING.LESSERv3` / `COPYING`）；MPFR 4.2.2、MPC 1.4.1 为 LGPL-3.0-or-later（`COPYING.LESSER`）；lz4 1.10.0 为 BSD-2-Clause（`LICENSE`）。zstd 与 xz 的 formula 使用多项许可组合，Cellar 分别保留 `LICENSE` / `COPYING` 和 `COPYING.0BSD` / `COPYING.GPLv2` / `COPYING.GPLv3` / `COPYING.LGPLv2.1`，不将整套宿主依赖概括为单一 GPL 或 BSD。这里只记录构建机依赖及现存 notices；若以后分发工具链，应另按实际打包文件核对对应依赖源码和条款，当前 BIN 闭包不因此扩展为这些宿主库。

实际依赖清单中，GCC 16 提供 `stdarg.h`、`stdbool.h`、`stddef.h`；这三个 Cellar 文件已分别与上述 GCC 16 peeled commit 的 `gcc/ginclude/` 原文逐字节核对相同。它们的头部为 GPL-3.0-or-later + GCC Runtime Library Exception 3.1。`stdint.h` 等目标 headers 实际来自旧官方 newlib，而非推测采用 GCC 16 的 wrapper。GCC 16 Cellar 顶层 `COPYING` 是 GPLv2 文本，**不能把它改名后当作 GPLv3**；已从固定 GCC 16 源码另取 `COPYING3`，同时保留 `COPYING.RUNTIME` / `COPYING.LIB`。

## 逐文件运行库许可

| 来源文件 | 文件头实际内容与影响 |
| --- | --- |
| GCC [`libgcc/libgcc2.c`][libgcc2]、[`libgcc/config/riscv/div.S`][div] | FSF；GPL-3.0-or-later，并明确附加 GCC Runtime Library Exception 3.1。保留 [COPYING3][gpl3]、[COPYING.RUNTIME][runtime] 和文件归属；不能仅记 Apache-2.0。 |
| GCC [`libgcc/soft-fp/muldf3.c`][muldf3]、[`libgcc/soft-fp/soft-fp.h`][softfp]，以及该目录 `divdf3.c`、`fixunsdfsi.c`、`floatunsidf.c`、`double.h`、`op-common.h`、`op-1.h` / `op-2.h` / `op-4.h` / `op-8.h` | FSF，来自 GNU C Library；LGPL-2.1-or-later，文件头另附无限制链接已编译文件并分发组合的额外许可。该文字不同于 GCC Runtime Library Exception。保留 [COPYING.LIB][lgpl] 与实际被使用 soft-fp 文件的完整头部。 |
| GCC [`include/longlong.h`][longlong] | FSF；LGPL-2.1-or-later + 相同的额外链接许可；为 `libgcc2.c` 等包含的混合精度运算头，不能仅看调用方文件头而略过。 |
| GCC [`libgcc/config/riscv/sfp-machine.h`][sfp-machine] | FSF；GPL-3.0-or-later + GCC Runtime Library Exception 3.1。即使 soft-fp 算法主文件使用上一行许可，仍应分别记录其包含的架构头。 |
| newlib [`newlib/libc/machine/riscv/memset.S`][memset] | SiFive 2017，文件头说明 FreeBSD License；[COPYING.NEWLIB][newlib-license] 第 49 项保留相同来源。若最终无 libc 抽取，不把此例函数记作实际进入候选程序。 |
| newlib 其余文件、头文件 | [COPYING.NEWLIB][newlib-license] 开头明确逐文件许可优先；这是多来源集合。不能笼统把整个 newlib 称为 BSD、MIT 或 Apache；分发具体头或源码时保留其原有头部并核对 aggregate notices。 |

GCC exception 的文字只适用于带相应声明的文件；其条款包含 Independent Modules、Eligible Compilation Process 等条件，不是所有第三方代码的统一豁免。soft-fp 的额外链接许可也明确区分已编译组合与原文件修改/单独分发。应原样保存文本，不用摘要替代许可条件。

## 实际候选链接闭包

已独立读取 [build-report.json](../../tools/flash-probe/build-report.json)、[source-manifest.json](../../tools/flash-probe/source-manifest.json)、map、ELF sections 与符号表，并使用原生 `nm -u` 复核为空。编译参数保持 `rv64imafc` / `lp64f` / `-misa-spec=2.2`，链接使用 `-nostdlib -nostartfiles -nodefaultlibs --gc-sections`；额外显式指定旧官方 8.2 的单浮点 ABI `libgcc.a`，其 SHA-256 为 `966235fc4bd270d2a5abcd0f42886549ad02a54cf21c785a99e1ae60608ade66`。当前 **没有链接 GCC 16 的 libgcc**。

map 最初为满足 `sysctl.o` 的符号引用抽取 12 个成员；section GC 后，实际分配到镜像地址且进入 BIN 的运行库只有以下 6 个：

| 保留成员 / 符号 | 固定源码归属 | 保留区间 |
| --- | --- | --- |
| `divdf3.o` / `__divdf3` | GCC 8.2 `libgcc/soft-fp/divdf3.c` 与 soft-fp 头；LGPL2.1 + 额外链接许可；含 `sfp-machine.h` 的单独 GPL3 + GCC exception 声明 | `.text` `0x8000125C` 长 `0x3A6`；另有 `.rodata` |
| `muldf3.o` / `__muldf3` | GCC 8.2 `libgcc/soft-fp/muldf3.c` 与同类头 | `.text` `0x80001602` 长 `0x374`；另有 `.rodata` |
| `fixunsdfsi.o` / `__fixunsdfsi` | GCC 8.2 `libgcc/soft-fp/fixunsdfsi.c` 与同类头 | `.text` `0x80001976` 长 `0x66` |
| `floatunsidf.o` / `__floatunsidf` | GCC 8.2 `libgcc/soft-fp/floatunsidf.c` 与同类头 | `.text` `0x800019DC` 长 `0x42` |
| `_clzsi2.o` / `__clzdi2` | GCC 8.2 `libgcc/libgcc2.c` 的 `L_clzsi2` 分支；GPL3 + GCC exception；其包含头另保留各自声明 | `.text` `0x80001A1E` 长 `0x30` |
| `_clz.o` / `__clz_tab` | GCC 8.2 `libgcc/libgcc2.c` 的 `L_clz` 分支；GPL3 + GCC exception | `.rodata` `0x800020E0` 长 `0x100` |

`gedf2.o`、`ledf2.o`、`subdf3.o`、`fixdfsi.o`、`floatsidf.o`、`floatdidf.o` 的相关段在 discarded 区，不计作 BIN 中的代码。map 的 LOAD 列表没有 `libc.a`、`libm.a`、GCC 16 `libgcc.a` 或 C++ runtime；符号表没有 `memset` / `memcpy` 等 libc 函数。newlib **头文件仍实际参与编译**，不能把“无 libc archive”写作“没有使用 newlib”。混合 GCC 16 编译器与 GCC 8 目标运行库已经链接成功，尚未以此证明目标硬件行为正确。

该次审计产物已同步独立审查修正后的候选（增加 `-fstrict-volatile-bitfields` / 32 位 TX 写入等）：BIN 8,672 字节，SHA-256 `314f29f2a775607e59659ddf44c50f560bb3f98d3e0df24fad393efe4ddb113d`；ELF SHA-256 `8ceb8eef08b9c1da94bd52135a2620ce7cf4cdb1737654c8086841f7a810fc8f`；map SHA-256 `88906f743600898b12a73137c2059736211625ac5537b93692a2ee70f4617afe`。ELF entry 为 `0x80000000`，flags 为 RVC / single-float ABI；分配的 `.text` 长 `0x1A4E`、`.rodata` 长 `0x790`，数据/BSS 长度均为 0；BIN 比 `size` 的 text 统计多 2 字节，来自段间对齐。此次重新读取 map、sections 与 `nm -u`，运行库闭包仍为上述 6 个成员、未解析符号为空。以上是特定构建的离线闭包记录，后续代码或链接输入变化时须重新核对，不称“仅 Apache-2.0”。

## 分发材料应保留的内容

构建缓存留在 `/tmp` 不代表准备分发整个编译器。目前不把官方工具链归档加入 App。候选程序若以后进入产品，应随实际闭包携带逐项来源、版本、版权、许可证与附加许可，并保留固定源码/构建说明；开发者本机工具链与目标程序的运行库内容分开列示。若以后打包 GCC/binutils/newlib 编译器工具链，应另行核对对应工具链完整源码、组件和依赖的分发材料，不能沿用只针对 RAM 程序的结论。

已下载的固定许可文本可在 `/tmp/nodu-probe-runtime-audit-20261019/licenses/` 供构建任务原样复制；此临时目录不作为产品持久来源：

| 文件 | SHA-256 |
| --- | --- |
| GCC `COPYING3` | `8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903` |
| GCC `COPYING.RUNTIME` | `9d6b43ce4d8de0c878bf16b54d8e7a10d9bd42b75178153e3af6a815bdc90f74` |
| GCC `COPYING.LIB` | `a9bdde5616ecdd1e980b44f360600ee8783b1f99b8cc83a2beb163a0a390e861` |
| newlib `COPYING.NEWLIB` | `6df0331179a05fe96f35a2d3f46679910930fcde415c8639fcc9c508bac54aae` |

[gcc16-formula]: https://github.com/Homebrew/homebrew-core/blob/a65d62841d62086e7f85f8a600f12e1f72feea91/Formula/r/riscv64-elf-gcc.rb
[binutils247-formula]: https://github.com/Homebrew/homebrew-core/blob/a65d62841d62086e7f85f8a600f12e1f72feea91/Formula/r/riscv64-elf-binutils.rb
[assets]: https://github.com/kendryte/kendryte-gnu-toolchain/releases/expanded_assets/v8.2.0-20190213
[modules]: https://github.com/kendryte/kendryte-gnu-toolchain/blob/fbf55383711b68c00ecf67e23959822180010398/.gitmodules
[gcc-version]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/gcc/BASE-VER
[newlib-readme]: https://github.com/kendryte/kendryte-newlib/blob/01de41f55e386c935b593402855622fb7aba25c8/newlib/README
[libgcc2]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/libgcc/libgcc2.c
[div]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/libgcc/config/riscv/div.S
[gpl3]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/COPYING3
[runtime]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/COPYING.RUNTIME
[muldf3]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/libgcc/soft-fp/muldf3.c
[softfp]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/libgcc/soft-fp/soft-fp.h
[longlong]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/include/longlong.h
[lgpl]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/COPYING.LIB
[sfp-machine]: https://github.com/kendryte/kendryte-gcc/blob/bce905d919791374b0dbeb2d02ece8fae98ece5e/libgcc/config/riscv/sfp-machine.h
[memset]: https://github.com/kendryte/kendryte-newlib/blob/01de41f55e386c935b593402855622fb7aba25c8/newlib/libc/machine/riscv/memset.S
[newlib-license]: https://github.com/kendryte/kendryte-newlib/blob/01de41f55e386c935b593402855622fb7aba25c8/COPYING.NEWLIB

## 后续可靠性 delta 的闭包复核

新 BIN 8,672 B SHA `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`、ELF `bba12baa71f0fc030b0a73ebc5bb52734c4f470c798dc843f10f5e32d999881f`、map `9ad5a0d89c0961f45c220486a6dd8dc28f9ea508c2bbda02bec05af35171cfb4` 已独立复算。map 实际分配部分仍只有 `divdf3.o`、`muldf3.o`、`fixunsdfsi.o`、`floatunsidf.o`、`_clzsi2.o`、`_clz.o`；LOAD archive 仍仅固定官方 8.2 libgcc，`nm -u` 空，没有新运行库 / libc。源内固定 IN0=0、去额外接收后 SR 等待及 E5–E8 无 payload 失败码未改变此运行库许可闭包。旧候选完整保存在 `tools/flash-probe/history/314f29f2-before-clock-diagnostics-delta/`。新目标的部署和限定审核见[集成审查](flash-probe-integration-review.md)末节；本运行库审查不宣称新目标已经通过硬件测试。
