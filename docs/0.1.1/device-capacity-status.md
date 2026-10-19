# K210 Flash 容量核验状态

接续状态（2026-10-19）：现有固件接口和官方未改 ISP 的复核均已完成；新的本项目源码构建候选已离线构建、冻结并独立审查，见[具体执行计划](flash-probe-execution-plan.md)。它尚未在设备运行，没有当前 JEDEC；本文件下述历史证据仍不能放行。状态保全的实测与失败/修复另见[保全记录](flash-probe-state-preservation.md)，不等同已认证完整 Flash。

核查日期：2026-10-19。范围为已安装工具、固定官方固件源码、官方手册与现存日志的只读复核。本次没有打开串口、复位或重启设备，没有运行或制作探针，没有修改 worker、启动文件、用户文件或 Flash。原生 App 验收期间，设备继续由主线程独占。

**当前结论：找到了一条既有官方启动日志中的有效厂商/设备 ID 证据，但尚未形成当前连接的完整容量认证链；容量门禁保持关闭。未找到可直接用于当前 MaixPy 固件、公开且调用链严格不写 Flash 的现成 JEDEC/容量查询接口。** 不把“读到了 16 MiB”、板型 profile、默认分区、旧备份长度或 `Sipeed_M1` 固件字符串当作当前芯片容量证明。

## 1. 官方公开接口和工具

| 对象 | 已核依据 | 能力与限制 |
| --- | --- | --- |
| 当前 MaixPy-v1 `Maix.utils` | [官方 API 文档][utils-doc]；[固定 `Maix_utils.c` 导出表][utils-source] | 导出 `flash_read`、`gc_heap_size`、`heap_free`，没有公开的 Flash ID、JEDEC 或芯片容量方法。`flash_read(address, length)` 读取指定地址的数据，不返回实际芯片大小，也不能据任意给定的 length 排除地址环回。 |
| `gc_heap_size` / `heap_free` | 同上 | 表示 RAM 堆，不能证明 Flash 容量。尤其不要为了探测容量传入 `gc_heap_size(size)`：该 setter 会保存配置；官方文档也注明可能重启。 |
| `machine.SPI` | [官方 SPI 文档][spi-doc]；[固定构造器与导出表][spi-source] | 连接 boot Flash 的 SPI3 是保留资源；构造器明确拒绝 id 3。没有通过公开 SPI3 对象直接发送只读 ID 指令的入口。重映射其他 SPI/FPIOA、直接改外设寄存器或从运行中固件抢占 Flash 总线均不是本轮允许的现成官方查询方式，未尝试。 |
| 已安装 `kflash==1.1.6` | 本地包与[固定官方源码][kflash-source]一致，文件 SHA-256 为 `26e13e5f753b86f59c0b6da561871f2b732e36453723ed9b8176f851b7af8367` | 增强 ISP 枚举为 debug、NOP、擦除、写入、复位、波特率、初始化和状态；没有 Flash ID/JEDEC/读回容量命令。其串口 `read` 函数和 ROM 的 memory-read 常量不能当作芯片 ID 接口。烧录成功或 D7 初始化成功均不能证明容量。 |
| 原版 `ktool` | [固定 host][ktool-host]、[stub 主循环][ktool-main]、[Flash 驱动][ktool-flash] | DE 支持三字节 JEDEC 读取，但原版必须先 D7；D7 会调用 QE 设置路径，QE 尚未置位时可能写状态寄存器。因此不能把原版 D7→DE 称为严格无写查询。混合许可与暂停分发的审计见[探针许可记录](device-flash-probe-license.md)。本轮不引入它、不修改它、不执行自制探针。 |
| 野火官方使用手册 | [资料目录][board-download]、[烧录说明][board-flash] | 公开目录列出硬件规格书/原理图所在资料包；本次可读页面没有提供当前芯片 ID 查询 API。烧录教程包括全片擦除步骤，不是只读身份查询或本项目恢复方案，未执行。此处不推断厂方未公开工具是否另有隐藏功能。 |

核对固件为 `sipeed/MaixPy-v1` 提交 `d8901fd2272f000226f1c1037c1eb7c412b88e66`。对该提交的 `components/micropython/port/` C/H/Python 源码只读检索，Flash ID 读取命中启动初始化路径，未找到额外 Python 导出。源码归档仅在内存核读，没有 vendor 到工程；归档 2,823,128 字节，SHA-256 为 `6ae38798a4f4c2058039e1ad303209ccf9f5c0926141ee993fa7db3fe656d7f2`。

## 2. 现存启动日志：`0xEF / 0x17`

本次只读搜索现有工程与 `/opt/homebrew/share/maixpy-k210/` 日志，找到以下精确记录：

| 项目 | 值 |
| --- | --- |
| 文件 | `/opt/homebrew/share/maixpy-k210/logs/startup-after-reset.log` |
| 行号与相关行 | 第 7 行：`[MAIXPY] Flash:0xef:0x17` |
| 长度 | 997 字节 |
| 文件修改时间 | `2026-10-18T23:17:15.223639+08:00`，是文件系统元数据，不是受认证的设备采集时间 |
| 文件 SHA-256 | `6ae49744fb1a13ea8f0df9a8a3fea176b79c63bf2d3c2248394ec9d371821628` |

ID 的含义由固定源码明确限定：

1. [`w25qxx.h`][flash-header] 的 `READ_ID` 为 **`0x90`**。
2. [`w25qxx_read_id_dma()`][flash-source] 发送 `90 00 00 00`，接收 **2 字节**，依次赋给 `manuf_id` 与 `device_id`。
3. [`maixpy_main.c`][main-source] 启动时调用该函数，并按上述日志格式打印两个值。

所以这条记录是 **`0x90` 厂商/设备 ID**。不得把它扩展或改写为未经采集的 `EF 40 18` 三字节 JEDEC，也不能从两字节唯一确定封装、电压、具体后缀或当前连接身份。

### Winbond 官方手册的精确对应

[Winbond W25Q128JV Revision F，2018-03-27][winbond]：p21 §8.1.1 的识别表给出厂商 ID `EFh`，`90h/ABh/92h/94h` 的设备 ID `17h`；表中 `9Fh` 另列 `4018h` 或 `7018h`。p22 的指令表与 p46 §8.2.23 分别确认 `90h` 与 `9Fh` 的返回格式。p4 将该器件容量列为 128M-bit / 16M-byte，按其页组织为 **16,777,216 字节，即 16 MiB**。

因此，**既有 `EF/17` 记录与 Winbond 128Mbit 家族的容量编码相符**，这是有手册支持的历史硬件证据，不再只是由 profile 猜测。但本次没有取得三字节 JEDEC，亦未凭这条日志确定唯一器件料号；板厂具体物料/板卡版本与当前实体绑定仍需交叉核验。该文档不自动更新 `flashCapacityVerified`。

## 3. 不能为了收集日志主动重启

虽然 `0x90` 识别指令本身为读取，整个官方启动路径不符合“保证没有任何 Flash 写入”的约束：

- [`flash_init()`][main-source] 在读 ID 前先调用 `w25qxx_enable_quad_mode_dma()`；[固定驱动][flash-source] 在 QE 未置位时会写状态寄存器。
- [`init_flash_spiffs()`][main-source] 在强制格式化或挂载失败的条件下存在 `SPIFFS_format()` 分支。
- 当前用户启动程序也可能写文件；读取身份不能据此额外触发启动序列。

本轮仅使用已经存在的日志，不为补采 ID 主动断电、复位、软重启、切 IDE 模式或运行初始化探针。公开 C 内部存在 `w25qxx_read_id_dma()`，也不等于当前 Python/主机工具有可安全调用的公开包装。

## 4. 备份、恢复和解除阻塞的边界

当前 App 的备份认证与烧写要求实际容量证明；缺少证明时保持禁止。16 MiB raw 即使 offset 连续、设备/主机 SHA-256 一致，也只能证明这次读取的字节传输一致，不能单独排除较小芯片的环回读取。`statvfs('/flash')` 及默认 SPIFFS 分区也不是芯片容量测量。[官方存储分区说明][storage-doc]展示的是固件、模型与文件系统的分区关系。

可以继续、不改设备状态的工作是：保全上述历史日志及哈希；与板厂正式 BOM/原理图、实际板卡版本及芯片标识交叉核对；审查既有备份和恢复描述。若这些材料足以形成当前实体的容量认证链，应由主线程明确记录证据类型与适用范围，再单独决定实现层如何接受该证据；本次仅写文档，既不改变门禁，也不把历史日志冒充当前 session 的新测量。

已存在的 `/opt/homebrew/share/maixpy-k210/backups/20261018-224235/canmv-boot-restore.kfpkg` 可作为**旧 CanMV 启动区**的恢复材料研究。本次重算其长度 1,141,412、SHA-256 `cc4c230b2c2d31655618f4b9ede291614bffa6059d7616f8600f5a03d99a71e7`；ZIP 清单只有地址 0 的原始启动区，`sha256Prefix:false`。对应 raw 长度 2,057,701、SHA-256 `b3626b5c0e8f0fce43a461da4528f878404a22c0dc8575bdaa51f271c62b3ce4`。它不恢复当前 MaixPy、当前用户脚本、模型或全部 Flash/SD；旧板端 full dump 没有在本次重新读回，不能称为当前完整备份。恢复本身仍是写入操作，本次没有执行。

继续烧写前仍需当前设备的容量认证、足够覆盖的可信备份、原始启动头及摘要核验、全部本地恢复副本重验，以及写后固件和用户文件的大小/SHA-256 复核。具体无全片擦除的受控镜像及恢复格式见[烧写与恢复计划](device-flash-plan.md)。在此前，继续进行端口、REPL、RAM 脚本、文件和相机验收，不将容量研究的阻塞扩大到这些现有功能。

[utils-doc]: https://wiki.sipeed.com/soft/maixpy/en/api_reference/Maix/utils.html
[utils-source]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/Maix/Maix_utils.c
[spi-doc]: https://wiki.sipeed.com/soft/maixpy/en/api_reference/machine/spi.html
[spi-source]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/standard_lib/machine/machine_spi.c
[kflash-source]: https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py
[ktool-host]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/ktool.py
[ktool-main]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c
[ktool-flash]: https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/flash.c
[board-download]: https://doc.embedfire.com/k210/quick_start/zh/latest/k210/environment/data_download/data_download.html
[board-flash]: https://doc.embedfire.com/k210/quick_start/zh/latest/k210/environment/img_flash/img_flash.html
[flash-header]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/drivers/flash/include/w25qxx.h
[flash-source]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/drivers/flash/src/w25qxx.c
[main-source]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/maixpy_main.c
[winbond]: https://www.winbond.com/resource-files/w25q128jv%20revf%2003272018%20plus.pdf
[storage-doc]: https://wiki.sipeed.com/soft/maixpy/en/get_started/get_started_fs.html
