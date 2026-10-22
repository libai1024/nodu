# STM32 HAL P0 验证

此目录是固定工具与两颗 MCU 的可复现验证工程，尚未接入 Nodu UI。应用使用官方 HAL、官方 CMSIS startup/system 与内部 HSI；RAM 中 `nodu_p0_status` 用于验证下载后的实际运行。它不依赖板载 LED、外部晶振或屏幕。

本次范围为 macOS arm64。工具与 SDK commit 记录在 `toolchain.lock.json`，实际工具版本/二进制摘要在 `evidence/environment.json`，Homebrew 构建和依赖版本在 `evidence/homebrew-packages.json`。OpenOCD 和 stm32flash 是 Homebrew 构建，不称为上游官方 macOS 二进制。

## 当前证据

| 项目 | 结果 |
|---|---|
| Arm GNU 14.2.Rel1 / GCC 14.2.1 | 实际执行通过，官方 archive SHA256 一致 |
| CMake 4.4.3 / Ninja 1.13.2 | 实际构建通过 |
| OpenOCD 0.12.0（Homebrew 0.12.0_1） | CLI 和 F407 SWD 识别/Flash 读取通过 |
| stm32flash 0.7 | 可执行程序版本已核实；未连接 UART，未证明实际下载 |
| F103C8 HAL 构建 | 通过，BIN 2624 B；64 KB Flash / 20 KB SRAM |
| F407ZG HAL 构建 | 通过，BIN 3592 B；1 MB Flash / 128 KB SRAM；CCM 独立且未使用 |
| F407 ST-LINK | 已读取 ID `0x101f6413`、1024 KiB 容量并备份完整 Flash；写入尝试前探针断开，未完成写入验证 |
| F103 ST-LINK | 多次检查未枚举到下载器，未读取 MCU，未写入 |
| F103 / F407 UART ROM | 未检测到 STM32 UART 端口，均未实测 |

构建日志和 artifact JSON 包含真实命令、ELF 属性、向量表、源码/SDK 身份及固件摘要。`selftest.json` 记录实际编译器负样本：源码变化、ELF 被改动、同 BIN 不同调试信息、编译失败失效和并发占用。所有 `*-plan.json` 都标记 `executed:false`，不是烧写通过证明。

## 准备工具与 SDK

以下命令在仓库根目录执行。此 P0 复用主机 CMake/Ninja/Homebrew 工具，校验器会拒绝与 lock 不符的版本；它不是完整的跨平台工具包安装器。

```sh
HOMEBREW_NO_AUTO_UPDATE=1 brew install open-ocd stm32flash
mkdir -p .local/stm32-p0/downloads .local/stm32-p0/tools .local/stm32-p0/sdk
```

从 lock 中的 Arm 官方 URL 下载 archive，SHA256 必须为 `c7c78ffab9bebfce91d99d3c24da6bf4b81c01e16cf551eb2ff9f25b9e0a3818`，校验后解压到 `.local/stm32-p0/tools/`。对应 GCC/GDB/binutils 不加入全局 PATH。

```sh
git clone --depth 1 --branch v1.8.7 --filter=blob:none --sparse https://github.com/STMicroelectronics/STM32CubeF1.git .local/stm32-p0/sdk/cube-f1
git -C .local/stm32-p0/sdk/cube-f1 sparse-checkout set Drivers/CMSIS/Include
git -C .local/stm32-p0/sdk/cube-f1 submodule update --init --depth 1 Drivers/STM32F1xx_HAL_Driver Drivers/CMSIS/Device/ST/STM32F1xx

git clone --depth 1 --branch v1.28.3 --filter=blob:none --sparse https://github.com/STMicroelectronics/STM32CubeF4.git .local/stm32-p0/sdk/cube-f4
git -C .local/stm32-p0/sdk/cube-f4 sparse-checkout set Drivers/CMSIS/Include
git -C .local/stm32-p0/sdk/cube-f4 submodule update --init --depth 1 Drivers/STM32F4xx_HAL_Driver Drivers/CMSIS/Device/ST/STM32F4xx
```

校验器不仅检查 tag，还检查 lock 中的 Cube/HAL/Device 三组 commit 和源码树未修改。CMSIS Core 来自对应 Cube commit 的 `Drivers/CMSIS/Include`，不混用 F1/F4 的 Core 文件。

## 重复构建与负样本

```sh
python3 tools/stm32-p0/validate.py env
python3 tools/stm32-p0/validate.py build --target f103c8
python3 tools/stm32-p0/validate.py build --target f407zg
python3 tools/stm32-p0/selftest.py
```

每个目标有独立构建锁。开始构建时失效旧 artifact record；构建前后比较输入摘要。产物目录按整套 ELF/BIN/HEX/MAP 的摘要寻址，文件只读。生成计划时重新检查当前源码、SDK 和实际下载文件的摘要，拒绝过期产物。

F4 官方 Flash 扩展源在这组 MCU/编译参数下有三个 unused parameter warning，未修改官方源码。当前示例均能链接，未将该 warning 当作运行结果。

## ST-LINK 实物验证

保持 BOOT0=0、BOOT1=0。下载器接 SWDIO、SWCLK、GND，开发板供电；建议同时连接 NRST。使用数据线接电脑。此验证脚本要求电脑只连接一支 ST-LINK，先以 MCU 家族、实际 Flash 容量和 UID 核对目标。

```sh
# 只读取身份，不写 Flash
python3 tools/stm32-p0/verify_swd.py --target f103c8
python3 tools/stm32-p0/verify_swd.py --target f407zg

# 显式执行：先备份，随后写入、校验、读回，并观察 HAL 心跳
python3 tools/stm32-p0/verify_swd.py --target f103c8 --execute
python3 tools/stm32-p0/verify_swd.py --target f407zg --execute
```

每次备份存放于忽略的 `.local/stm32-p0/backups/`，避免覆盖先前原固件。写前在同一 OpenOCD 会话复核 UID，写入 immutable ELF；对 BIN 地址范围独立 dump 并比较 SHA256。两次 RAM 观察需要 magic/target/HSI 频率正确、error=0，且 heartbeat/HAL tick 增加。

脚本成功后保留 P0 固件运行，结果记录于 `*-swd-result.json`。异常时查看日志与备份；USB 拔出后的写入结果不能假设成功。当前轮次尚未成功写入任何测试固件，原 F407 备份位于 `.local/stm32-p0/backups/f407-before-p0.bin`。

原始 Flash 备份可能含用户程序，因此不提交 Git。后续恢复前同样需要核对实际 MCU UID、备份来源和镜像边界，不能把某板备份写到另一块板。

## UART ROM 路线

先接 3.3 V TTL 的 TX/RX/GND，释放串口监视器。F103C8 使用 USART1 PA9/PA10；F407 按 AN2606 和板级接线选 ROM 支持的 USART。BOOT0=1、BOOT1=0 后复位进入 ROM，下载后恢复 BOOT0=0 再复位。

```sh
python3 tools/stm32-p0/validate.py plan --target f103c8 --transport uart --port /dev/cu.YOUR_STM32_PORT
python3 tools/stm32-p0/validate.py plan --target f407zg --transport uart --port /dev/cu.YOUR_STM32_PORT
```

计划生成器只输出命令和步骤，不打开串口。执行写入前需单独查询 ROM ID、核对器件/容量、备份 Flash，并确认不是 K210 端口。当前没有 STM32 UART 硬件，未执行这些步骤。

固定 stm32flash 0.7 源码已核实：`-v` 为分块读回比较，`-S` 长度必须与实际 BIN 完全一致；它可能截断过长文件而仍返回成功。因此生成器先核对 BIN 大小与摘要。`-S` 与 `-e/-s` 不能混用。当前两个 BIN 分别擦除 F103 的前三个 1 KB 页、F407 的第一个 16 KB 扇区；擦除粒度内的旧数据会被清除。

未传 `-i` 时工具不执行显式 DTR/RTS 序列，但操作系统打开/关闭串口仍可能影响控制线，不应对未知自动下载电路承诺无影响。此 P0 使用手动 BOOT/RESET 流程，不添加 GO。

参考：[AN2606](https://www.st.com/resource/en/application_note/an2606-.pdf)、[AN3155](https://www.st.com/resource/en/application_note/an3155-how-to-use-usart-protocol-in-bootloader-on-stm32-mcus-stmicroelectronics.pdf)、[stm32flash 0.7 源码](https://downloads.sourceforge.net/project/stm32flash/stm32flash-0.7.tar.gz)。
