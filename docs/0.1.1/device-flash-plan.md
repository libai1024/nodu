# K210 固定固件烧写与恢复计划

核对日期：2026-10-19。本文件来自本地材料、安装包源码与官方来源的只读核查。用户已授权真机烧写测试；本文不新增授权门槛。**编写本文的研究过程没有打开串口、读取板上数据或烧写固件**；执行结果应另记日志，不能把以下计划标为已验收。

## 固定镜像与工具

| 项目 | 核对结果 |
| --- | --- |
| 本地镜像 | `/opt/homebrew/share/maixpy-k210/firmware/maixpy_v0.6.3_2_gd8901fd22.bin` |
| 长度 | **2,116,288 字节** |
| SHA-256 | `6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa` |
| 来源记录 | 同目录 `maixpy_v0.6.3_2_gd8901fd22.source.txt`，记载官方 URL 与上述 SHA-256 |
| 官方原文件 | [Sipeed 固定版本 BIN][image]；本次重新从该地址读取，长度与 SHA-256 均与本地一致；这是来源与字节一致性核对，不是签名验证 |
| 固件源码 | [MaixPy-v1 d8901fd2272f000226f1c1037c1eb7c412b88e66][maix-source] |
| 已安装烧录器 | `/opt/homebrew/share/maixpy-k210/venv/bin/kflash`，包版本 **1.1.6**，MIT |
| 烧录器源码 | [kflash.py 550828c768b16ef329695d3f5eace3f6bcf14af2][kflash-source]；本地 `site-packages/kflash.py` 与该提交逐字节相同，SHA-256 `26e13e5f753b86f59c0b6da561871f2b732e36453723ed9b8176f851b7af8367` |

App 应把这份镜像的文件名、长度、SHA-256、固定来源和目标地址作为一条受控记录展示。开始前重新计算本地哈希，避免在用户审阅后换入别的文件；子进程使用固定解释器和参数数组，记录工具版本、参数与退出码。端口由当前设备身份确定，不能把历史 `/dev/cu.usbserial-3120` 当成永远正确的目标。

## 写地址与影响范围

[kflash 固定源码][kflash-source] 的普通 BIN 路径调用 `flash_firmware()`，默认 `address_offset=0`、`sha256Prefix=True`。工具为 BIN 加 1 字节标志、4 字节小端长度和末尾 32 字节 SHA-256，因此本镜像逻辑写入范围为 **`[0x000000, 0x204AE5)`，2,116,325 字节**。默认 DIO 模式会设置标志位 `0x02`；这不是加密标志。按 4 KiB 对齐的末尾为 `0x205000`，实际擦写粒度仍取决于 ISP stub，不据此承诺末尾扇区中的其他字节不变。

`-A/--addr` 与 `-L/--length` 是擦除参数，不能用来改变普通 BIN 的烧写地址。`.kfpkg` 则从 `flash-list.json` 读取每项 address 与 sha256Prefix；任意包可能写多个区域，App 本轮只允许上述固定 BIN 到地址 0。不要传 `-e/--erase`，不要传 `erase` 子命令，也不执行全片擦除。[官方用法][kflash-readme]。

该提交的 [默认配置][maix-config] 为 SPIFFS 起点 `0xD00000`、大小 `0x300000`；它与上述固件字节区间不重叠，但默认配置不能证明运行中二进制的实际分区。即便只写启动固件，首次启动的固件也可能执行用户程序、改动文件或因格式不兼容初始化文件系统，所以仍须先保存当前文件与需要保护的原始区域。SD 卡不是此 BIN 的烧写目标，但 SD 上的启动程序和模型同样必须核对前后哈希。

## 当前快照：先备份再进入 ISP

新快照必须带本次时间戳、设备身份、固件信息及清单；不得以 2026-10-18 的 CanMV 备份替代当前 MaixPy 状态。

**烧写门禁：实际 JEDEC ID 与容量未核实时禁止烧写。** 板卡 profile、文件系统大小及旧 16 MiB 记录均不能代替芯片容量实测；先取得的 16 MiB raw 文件只能标为候选快照，容量、完整覆盖及哈希全部核实后才可标 verified。现成工具的只读探针与混合许可边界见 [容量探针研究](device-flash-probe-license.md)；本轮已暂停该增强 stub 的产品分发。

1. 暂停相机和运行脚本，串口只交给一个后端任务。用不自动软复位的 raw REPL 读取身份、挂载点和文件清单；记录中断发生，不触发 IDE 模式配置文件操作。
2. 递归备份 `/flash` 和 `/sd` 中的用户脚本、配置、库、模型及隐藏文件，保留路径；对每个文件记录长度和 SHA-256，并在电脑验证。明确包含 `boot.py`、`main.py`、`config.json`、`freq.conf`，以及存在时的 `ide_mode.conf`；目录不存在与读取失败要分开记录，不能静默跳过失败。
3. 保存足以恢复当前状态的 raw flash 快照，至少覆盖将被写入的区域及文件系统；若容量和读接口允许，优先取得完整 flash。先确认实际容量，不能仅沿用旧记录中的 16 MiB。保存原始字节，不改写启动头；电脑端核对长度与板端/分块哈希后才将备份标为有效。
4. raw flash 中可能含凭据，脚本和配置也可能包含密钥。备份只放本地受限目录；日志只记状态、长度和校验摘要，禁止输出文件内容、明文凭据、完整内存块或密钥参数。失败日志亦需如此。
5. 保存 App 将使用的恢复描述：镜像/原始区域、原地址、原始长度、SHA-256、是否已有启动头、工具版本及参数；再释放 raw REPL 串口并交给烧录器。

固定 MaixPy 的 [Maix_utils.c][maix-utils] 提供 `from Maix import utils; utils.flash_read(address, length)`，实现为 W25Qxx DMA 读取，`flash_write` 则被注释。应通过分块、有界读取和受控编码取回数据，避免一次分配整片 flash。已核对的 kflash 1.1.6 没有 `--read`、`flash_read` 或 `ISP_FLASH_READ` 入口，不能把它当作现成 flash 读回工具。

## 现有 backup_flash.py 的适用范围

本地 `/opt/homebrew/share/maixpy-k210/tools/backup_flash.py` 是此前 **CanMV 迁移工具**。只读代码核查发现以下边界，执行当前备份应修正或采用独立实现：

| 现有行为 | 当前备份需调整之处 |
| --- | --- |
| 导入 `from maix import utils` | 固定 MaixPy 为大小写敏感的 `from Maix import utils`；先探测实际 API |
| `/flash`、`/sd` 只复制顶层普通文件，跳过目录 | 递归覆盖用户库、模型、素材及隐藏文件，列出所有失败 |
| 假定 flash 为 16 MiB | 读取实际身份/容量，记录依据 |
| 完整 raw flash 只写到板端 SD，电脑只取回启动区 | 整体快照必须另存电脑并校验，不能把同板 SD 单份副本当作完整恢复保障 |
| 只接受启动头 flag 为 0 | kflash 默认 DIO 可产生 `0x02`；应按标志定义检查，不破坏原始字节 |
| 输出异常串口行全文 | 改为不含内容的错误类型与计数，保护可能含凭据的启动输出 |

该脚本有 offset 连续性、总长度、传输 SHA-256 及固件头校验，可保留这些思路；它不证明当前 MaixPy 已被备份。已有 SD dump 也可能是在更新前生成，必须记录时间与固件状态。

## 已存在的 CanMV 恢复材料

本地目录：`/opt/homebrew/share/maixpy-k210/backups/20261018-224235`。本次对文件直接计算的哈希与旧 manifest 对应字段一致：

| 文件 | 长度 / SHA-256 |
| --- | --- |
| `canmv-boot-region.raw.bin` | 2,057,701；`b3626b5c0e8f0fce43a461da4528f878404a22c0dc8575bdaa51f271c62b3ce4` |
| `canmv-embedfire-firmware.bin` | 2,057,664；`6be3fae449a0ed687b0d015565d8e83bce0c31be3e4c45ad2bcd5e0bd43bbcbd` |
| `canmv-boot-restore.kfpkg` | 1,141,412；`cc4c230b2c2d31655618f4b9ede291614bffa6059d7616f8600f5a03d99a71e7` |

已打开 ZIP 清单核对：恢复包仅含启动区 raw 文件与 `flash-list.json`，address 为 0，`sha256Prefix:false`，不会重复添加启动头。它恢复的是旧 CanMV 启动区，**不恢复本轮 MaixPy、当前用户程序、模型或全部文件系统**。旧 `flash/`、`sd/` 子目录亦仅有当时的顶层文件。

旧 manifest 记录板端 `/sd/canmv-full-backup-20261018-224235.bin` 为 16,777,216 字节、SHA-256 `9e4a4658aaa3ff33718583102d24dddb37f70e259273c97d50ae79bc941663a6`；该完整文件本次未从设备读取或在电脑重新核实，不能标为当前可用的新快照。

## 执行与结果验收

App 的具体烧写任务应串行完成：校验固定镜像与新快照 → 释放设备连接 → 调用固定 kflash → 等待退出并重连 → 验证。普通 BIN 的参数应显式保留 DIO 模式和实际端口、波特率，不使用擦除选项、不自动开启 miniterm。工具输出成功只证明上传流程完成；随后须验证：

Python API 可固定为 `KFlash().process(terminal=False, dev=port, baudrate=1500000, board="bit_mic", sram=False, file=image, noansi=True, io_mode="dio", callback=progress)`；该 API 分支将 erase 设为 false。`bit_mic` 是 ISP 复位策略，不改变物理野火板身份。进度回调为 `(fileType, iteration, total, suffix)`；上游 `KFlash.log()` 读取类变量 `KFlash.print_callback`，仅在构造器传实例回调不能拦截日志。worker 应隔离这类输出并在 finally 恢复回调，避免污染 JSON 通道。

- 重连后的固件身份与启动输出符合固定版本，端口恢复且无隐藏的第二个持有者。
- 读回地址 0 的启动头、固件长度和实际 payload SHA-256，与官方 BIN 一致；再核对启动区尾部 SHA-256。只看到版本字符串不等于完整内容校验。
- 所有应保留的 `/flash`、`/sd` 用户文件和模型与新快照的路径、长度、哈希一致；若有预期变化，单独记录原因和恢复状态。
- 完成用户要求的 RAM 脚本、stdout、停止、相机及断开重连测试，记录实际结果与失败，不能使用演示数据补齐。

若写入失败或新固件无法启动，先保留日志和未损坏的新快照；使用新快照的 raw 区域封装为明确地址、`sha256Prefix:false` 的恢复包，仅恢复必要区域，再验证文件与模型。不要把已有 raw.bin 当普通固件 BIN 直接烧写。旧 CanMV 恢复包仅作为明确选择的旧环境退路，不能静默替代当前环境。恢复路径不要求全片擦除。

[image]: https://dl.sipeed.com/fileList/MAIX/MaixPy/release/master/maixpy_v0.6.3_2_gd8901fd22/maixpy_v0.6.3_2_gd8901fd22.bin
[maix-source]: https://github.com/sipeed/MaixPy-v1/tree/d8901fd2272f000226f1c1037c1eb7c412b88e66
[kflash-source]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py
[kflash-readme]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/README.rst
[maix-config]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/projects/maixpy_k210/config_defaults.mk
[maix-utils]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/Maix/Maix_utils.c
