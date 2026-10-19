# Nodu K210 只读 Flash ID RAM 程序（源码构建）

**状态：第一候选已由新 App 真机加载，因 ID 响应格式校验失败而拒绝认证；当前为第二候选，尚待独立复审和硬件复测。** 第一候选及审查输入完整保留在 `history/314f29f2-before-clock-diagnostics-delta/`。当前产物在 `build/`，同一指纹将复制进 App resources；worker 始终先保存本次会话状态，再执行读取。此目录不含串口加载器。RAM 装载会结束当前板端程序并覆盖程序 RAM；加载在 RAM 不自动证明 Flash 无副作用。硬件执行和退出恢复由主线程另行审查。

## 构建前固定输入

- 官方 Kendryte standalone SDK V0.5.6：提交 `45642af98f15c24d64703ff57c97360794ca6f55`，codeload 归档 SHA-256 `18281ca5d8da535d8815a906f0d3f31d047b99cbd0d29f8dc98fb77c9be45a44`。官方 `lib/bsp/crt.S` 原样使用；仅编译明确列出的驱动文件，不执行 SDK 的完整 BSP 初始化、不使用 whole-archive 或 nncase。
- LoBo `ktool` 提交 `0345aa90d9b3830641373fb4e3ce4edf45d0a46f`：仅复用带 Apache-2.0 文件头的 `src/isp/main.c` 的 CRC32、D2/D7/DE 操作码、返回码及固定 DE 响应语义。**不包含、不翻译、不链接 GPL 的 slip.c/slip.h**，也不使用现成 isp.bin。
- Sipeed `kflash.py` 1.1.6 / `550828c768b16ef329695d3f5eace3f6bcf14af2`：MIT；SLIP 的 END=C0、ESC=DB、转义 DC/DD 格式按其公开 host 格式独立适配，保留 notice。新实现采用固定缓冲区并拒绝非法转义、超长帧和不完整帧。
- 官方 GNU toolchain v8.2.0-20190213 的 osx-mojave 发布归档 SHA-256 `f3cc7dc8c5fa8928aa804cc305f91935957ef81c41829064d8ee8da8d5aa8ec4`。其 gcc 本体可启动，但 cc1 缺旧版 x86_64 ISL/MPC/MPFR/GMP 宿主库，未改系统 dylib 或绕过签名。实际改用 Homebrew 官方 ARM 原生 GNU GCC **16.2.0** / binutils **2.47**，固定 `-march=rv64imafc -mabi=lp64f -misa-spec=2.2`；编译读取官方旧工具链的 newlib **3.0** 头文件，且显式链接其单浮点 ABI **libgcc.a**（SHA-256 `966235fc4bd270d2a5abcd0f42886549ad02a54cf21c785a99e1ae60608ade66`）。没有调用旧 cc1，没有增加 D 扩展，没有使用新编译器默认运行库或 libc。工具链固定来源、bottle 核验及许可证由[独立运行库审计](../../docs/flash-probe-runtime-audit.md)记录。

来源：

- https://github.com/kendryte/kendryte-standalone-sdk/tree/45642af98f15c24d64703ff57c97360794ca6f55
- https://github.com/loboris/ktool/tree/0345aa90d9b3830641373fb4e3ce4edf45d0a46f
- https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py

## 精确协议与动作边界

请求仅接收完整 **16 字节**小端 `<HHIII>`：op、reserved、CRC32、address、data_len。reserved/address/data_len 必须全零；CRC32 为 bytes[8:16] 的标准 CRC32。接受 D2 NOP、D7 SPI3 控制器初始化、DE Flash 身份；其他 opcode 在访问 SPI 前返回 E3。请求长度错误返回 E1，CRC 错误返回 E2，未初始化/未映射内部错误返回 E4；只读失败分为 E5=9F 收发、E6=90 收发、E7=身份交叉检查不支持、E8=UID 收发，均仍只回两个状态字节，不返回部分身份或 UID。无写入、任意地址执行、任意 SRAM/Flash 读写或通用 SPI 命令入口。

DE 成功保持上游固定 **27 字节**：16 字节头 + JEDEC 3 字节 + UID 8 字节；data_len 保留 **0**，CRC32 覆盖 bytes[8:27]。UID 不写文件、不打印，仅作为既有响应字段。内部额外读取 0x90 两字节并交叉核验：仅允许 `EF 40 18` 或 `EF 70 18`，同时 0x90=`EF 17`。未知身份失败；不采用 `2 ** density`、地址回绕或历史 ID 猜容量。0x90 原始值不增加到响应字段，host 不应声称采集到了它。

SPI 只发送固定读取命令 **9F、90 00 00 00、4B 00 00 00 00**。D7 只配置 SoC SPI3 的固定 IN0 时钟、8 位单线 mode0 控制器和保守分频，不发 Flash 指令。DE 使用由官方 `spi_receive_data_standard` 窄化的单线 EEPROM 接收流程，加周期超时，所有出口释放 CS 并禁用 SSI。没有 WREN、QE/SR 写、Flash reset、program、erase、双/四线读取，也不调用 w25qxx_init 或 ktool flash_init。

启动使用官方 CRT 的 0x80000000 入口、gp、每 hart 32 KiB 栈和 trap 保存逻辑；自有最小 `_init_bsp` 仅让 hart0 清理本程序 BSS、停驻其他 hart、关闭中断、进入协议循环。只配置引脚 4/5 为 UARTHS，115200 8N1；不调用 fpioa_init，不清除低区 SRAM，不跑用户脚本或文件系统。异常处理直接停驻，不尝试恢复执行旧程序。返回现有固件需要受控复位，会经过该固件自身启动路径，不能把退出过程称为无写。

## 离线验证计划

1. 固定 SDK 归档及每个编译输入/头文件哈希，记录实际文件头许可；没有文件头的项明确记录，不把整包简称为单一许可。
2. 构建 ELF、BIN、map、反汇编、依赖和符号表；检查入口=0x80000000，镜像/BSS/两 hart 栈不重叠，未解析符号为空，无 libc/libgcc/nncase 等未审闭包。
3. 在本机仅运行纯协议测试，验证错误帧/CRC/未知 opcode 不调用 SPI、DE 固定长度/CRC，以及允许身份白名单。不执行 RISC-V 产物。
4. 由独立审查复核所有 Flash 命令、源归属、内存布局和硬件退出风险后，才由主线程决定是否开始硬件验收。当前文档不表示该步骤已经完成。

## 本次离线结果与复现

`build-report.json` 保存精确命令及产物哈希；`source-manifest.json` 列出实际 C/汇编/头文件输入及 SHA，`reuse-manifest.json` 列出参考实现与适配差异。`licenses/THIRD-PARTY-NOTICES.md` 原样保留实际输入及运行库的文件头，完整许可文本位于同目录。此结果包含编译器运行库，不能称为纯 Apache。

首次无运行库链接实际缺少 `__floatunsidf`、`__divdf3`、`__muldf3`、`__fixunsdfsi`。显式旧版 libgcc 链接并 GC 后，最终保留 **divdf3.o、muldf3.o、fixunsdfsi.o、floatunsidf.o、_clzsi2.o、_clz.o** 六个成员，`nm -u` 为空。map 最初抽取但随后 GC 丢弃的其他成员不算进入 BIN。未链接 libc、完整 BSP、DMA、nncase 或其他 SDK 驱动实现。

当前 BIN **8,672 字节**，SHA-256 `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`；入口 `0x80000000`，`_bss=_ebss=0x800021E0`，`_end=0x80002200`，hart0/hart1 栈顶分别为 `0x8000A200`、`0x80012200`，在独立 128 KiB 链接区内。ELF、map、反汇编和依赖文件都在 `build/`。本机纯协议/SLIP 的 ASan+UBSan 测试通过，见 `host-test-report.txt`。**当前第二候选尚未执行；第一候选的失败不认证任何容量。**

独立代码审查发现旧编译选项下 TX 位域会生成字节写。已加入官方 SDK 的 `-fstrict-volatile-bitfields`，并将 TXDATA 明确写为 32 位 MMIO；最终反汇编 `uart_put_byte` 的 `0x800010B4` 为 `sw a0,0(a5)`，UARTHS 初始化也使用 32 位寄存器读写。仅有起始符加 ESC 的不完整帧现在也会超时清理，避免 size=0 的半帧残留。周期预算依赖已运行的 CPU cycle counter，尚未在硬件上标定实际时长。

```sh
python3 tools/flash-probe/build.py \
  --sdk /tmp/nodu-readonly-probe-research-20261019/kendryte-standalone-sdk-45642af98f15c24d64703ff57c97360794ca6f55 \
  --sdk-archive /tmp/nodu-readonly-probe-research-20261019/sdk-v0.5.6.tar.gz \
  --legacy-toolchain /tmp/nodu-readonly-probe-research-20261019/official-toolchain/kendryte-toolchain \
  --legacy-archive /tmp/nodu-readonly-probe-research-20261019/toolchain-osx-mojave-8.2.0-20190213.tar.gz \
  --gcc /opt/homebrew/opt/riscv64-elf-gcc/bin/riscv64-elf-gcc \
  --binutils-prefix /opt/homebrew/opt/riscv64-elf-binutils/bin/riscv64-elf- \
  --libgcc /tmp/nodu-readonly-probe-research-20261019/official-toolchain/kendryte-toolchain/lib/gcc/riscv64-unknown-elf/8.2.0/libgcc.a
```

SDK 缓存可从上方固定提交的 GitHub codeload 归档解包；build.py 在编译前核验 SDK/旧工具链归档 SHA、显式 SDK 翻译单元和指定 libgcc 哈希，在链接前逐字节核验实际消耗的 SDK/旧目标头文件及运行库都属于相应固定归档。新 GCC 的三个内建头另由独立审计与固定 GNU16.2 源码逐字节核对。缓存路径不是公开发布地址，也不表示对现成 blob 的硬件执行授权。

## 第一轮硬件结果后的可靠性增量

第一次新 App 已先保存21个文件、原始启动区和16MiB未认证prefix，主机独立复查各副本摘要一致；ROM上传/启动与D2/D7确认后，DE不是严格27字节，App拒绝认证并恢复普通REPL。未烧写。原始len/status尚未记录，不猜它等于某个阶段错误。

第二候选将SPI3 source固定为可用IN0，避免最小BSP未保证PLL0上电/输出的依赖；接收满指定字节后即按固定官方SDK结束，不附加上游没有的SR等待；所有FIFO/串口超时和CS/SSI清理保留。增加E5–E8非敏感阶段码以便后续定位。两个可靠性差异都有独立源码依据，但本轮尚未证明哪项是第一次失败原因。没有增加Flash指令、reset/FF/QE/写入/擦除操作，成功27字节、CRC及白名单保持不变。

新BIN重复构建两次相同，ELF SHA `bba12baa71f0fc030b0a73ebc5bb52734c4f470c798dc843f10f5e32d999881f`；详见 `build/reliability-delta.json`、`build/target-audit.txt` 与更新的源清单。宿主只在格式错误时输出长度/首两个协议状态元数据，不输出完整payload或UID；对应离线负例55项全部通过。
