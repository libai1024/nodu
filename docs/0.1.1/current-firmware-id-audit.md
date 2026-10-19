# 当前 MaixPy 固件的 Flash ID 接口审查

审查日期：2026-10-19。此项仅下载、读取固定版本的公开源码，未打开串口、未调用板端 Python、未加载 RAM 程序、未构建或执行下载的二进制，未修改 App、固件、板端文件或容量门禁。

**结论：在与当前固件版本对应的固定源码中，没有找到能由已有 Python 导出直接读取外部启动 Flash 的 JEDEC ID、SFDP 或实际芯片容量的接口。`uctypes` 存在，但它提供原始内存访问，不能据此把任意地址读取或外设寄存器操作称作已有 Flash ID API。没有发现不重启、不重新配置外设、无需新增原生代码的现成 ID 路径。** 该结论是源码接口审查，不是对设备执行了新探测，也不解除完整备份和烧写门禁。

## 固定来源和审查范围

| 来源 | 固定版本与核验 |
| --- | --- |
| [sipeed/MaixPy-v1][maix-tree] | `d8901fd2272f000226f1c1037c1eb7c412b88e66`。codeload tar.gz 长度 2,823,128 字节；SHA-256 `6ae38798a4f4c2058039e1ad303209ccf9f5c0926141ee993fa7db3fe656d7f2`，与既有审查记录一致。 |
| [micropython/micropython][core-tree] | MaixPy Git 树中的 `components/micropython/core` gitlink 精确指向 `ced340d739e84737dd5c8e6b4ab9af2ea44e29e7`，不是当前 MicroPython 主分支。下载归档 SHA-256 `681e09b71f957598dd3d010a31d490035fd0f4e14189e90a8d8de38936678000`。 |
| [sipeed/kendryte-standalone-sdk][sdk-tree] | 同一 MaixPy Git 树的 SDK gitlink 为 `7fdb511fe61026eec5874885de5981c4f60f664d`。下载归档 SHA-256 `10aac95088e23f26199d8aff42b95c6e6b2cd7b41efcf272a1e4e9150158c624`。只补核 UID 实现是否在该 SDK 公开源码中，不采用该 SDK 初始化或二进制。 |

通过对固定提交做浅层 Git fetch 后的 `git ls-tree -r FETCH_HEAD` 核对子模块 SHA；GitHub API 本轮返回 403，因此没有使用 API 响应作依据。归档和 Git 元数据存于 `/tmp/nodu-current-firmware-audit/`，没有 vendor 到工程。

检索 MaixPy `components/micropython/port/` 与 `projects/` 下全部 **449 个 C/H/Python 文件**，关键词覆盖 `w25qxx`、JEDEC、SFDP、Flash ID/size/capacity、read_id；再逐项阅读模块导出表、构建源列表、MicroPython 子模块的 `uctypes` 和 FFI 实现。相机的 `cambus_read_id` / `mt9d111_read_id` 是传感器身份，未当作 Flash 命中。此项不声称审完固件全部依赖或证明现有官方 BIN 可重现构建；未读取板上用户模块，亦不假定用户另有自定义探测代码。

## 导出能力逐项核查

| 路径 | 已核实现 | 对自动识别的含义 |
| --- | --- | --- |
| `Maix.utils` | [`modMaix.c` L22–35][modmaix] 将 `utils` 挂到 Maix；[`Maix_utils.c` L71–79][utils] 仅导出 `gc_heap_size`、`heap_free`、`flash_read`。L58–66 的 `flash_read` 调用 `w25qxx_read_data_dma(..., W25QXX_QUAD_FAST)` 并返回指定长度的数组内容。 | 没有 ID、SFDP、状态寄存器或容量返回值。任意 length 成功不证明芯片同等大小，也不排除地址回绕。 |
| RAM 大小方法 | 同一 [`Maix_utils.c` L11–30][utils]：`heap_free` 为系统 RAM 堆；`gc_heap_size()` 为配置堆大小；带参数分支调用 `save_config_to_spiffs`。 | 都不能识别 Flash 容量；不得调用 setter 作探测。 |
| `machine` | [`modmachine.c` L43–60][machine] 的完整导出表有 UART/Timer/PWM/I2C/SPI/WDT、重启/复位原因、unique_id/SDCard；没有 Flash ID 或 `mem8` / `mem16` / `mem32` 导出。 | 构建列表里有通用 `machine_mem.c`，不等于端口向 Python 暴露了其对象。 |
| `machine.unique_id` | [`modmachine.c` L31–41][machine] 分配 **32 字节**并调用 `sipeed_uid_get`；[`sipeed_uid.h` L7–11][uid] 声明芯片 UID。已检查的 MaixPy 与对应 SDK C/H 源码没有该函数定义。 | 不能把 UID 当作三字节 JEDEC 或密度编码；本轮未证明其底层调用及无写边界，不将其选为容量探测实现。 |
| `machine.SPI` | [`machine_spi.c` L329–332][spi] 拒绝 `SPI_DEVICE_3`；L690–691 不导出 SPI3 常量，明确预留启动 Flash。 | 不能通过官方 SPI3 Python 对象发 `0x9F` / `0x5A`。换 SPI/FPIOA 或直接操纵外设属于新硬件访问实现，需独立审查，未尝试。 |
| `modules` | [`py_modules.c` L13–26][modules] 导出 ultrasonic、onewire 及条件启用的 ws2812/htpa/amg88xx。 | 没有隐藏的 Flash 工具模块。 |
| `uos` / `os` | [`moduos.c` L188–218][uos] 导出文件系统操作、uname、urandom、REPL 操作以及 **flash_format**，没有 Flash ID/容量入口。 | `statvfs` 是已挂载文件系统的容量；`flash_format` 是写操作，不能作探测。 |
| `uctypes` | [`mpconfigport.h` L218][portconfig] 启用；对应核心 [`objmodule.c` L175–176][core-module] 注册；[`moductypes.c` L648–694][uctypes] 导出 struct、sizeof、addressof、bytes_at、bytearray_at。 | `bytes_at` 从调用方提供的地址直接复制内存；`bytearray_at` 提供可写的引用。没有 JEDEC/SFDP 命令、总线仲裁、Flash 句柄、已验证的 ID 缓存地址或 C 符号查找接口。不猜地址、不扫描栈，不将该通用能力视为安全现成路径。 |
| `ffi` | 对应核心有 [`ports/unix/modffi.c`][ffi]，依赖 `dlfcn.h` / `ffi.h`；MaixPy [`CMakeLists.txt` L85–242][cmake] 的核心/扩展源列表不包含它，端口 [`mpconfigport.h` L386–409][portconfig] 注册表也没有 ffi。 | 上游仓库包含 Unix FFI 源码，不等于 K210 固件能 import ffi 或调用任意 C 内部函数。没有选用此路径。 |
| 原生代码/内联汇编 | [`mpconfigport.h` L62–64][portconfig] 关闭 x64/Thumb/inline Thumb；固定核心 [`mpconfig.h` L327–330][core-config] 的原生和内联后端组合不含 RISC-V。 | 不能把现代 MicroPython 的 native/dynruntime 功能套到此旧端口，亦未发现现成可调用 Flash ID 的原生模块。 |
| IDE 调试协议 | [`ide_dbg.h` L30–50][ide-header] 是固件、帧、脚本、文件、属性和复位等命令，没有 Flash ID/SFDP；[`ide_dbg.c` L442–447][ide] 的 FW_VERSION 分支会删除 `/flash/ide_mode.conf`。 | 未转用 IDE 模式补取身份，避免把有文件副作用的版本查询称为只读识别。 |

源码中的 `machine.unique_id` 实现边界尤其需要保持明确：该 32 字节返回值不能由函数名推断为外置 Flash 身份；其 C 实现未在这次核读的公开源码中找到。本次没有运行它，也没有反汇编或执行静态库来扩大结论。

## C 内部的 ID 读取与重启边界

固定 [`w25qxx.h` L52][flash-header] 将 `READ_ID` 定为 **0x90**；[`w25qxx_read_id_dma()` L70–78][flash] 发送四字节命令，接收厂商、设备 **两字节**。这是 C 内部函数，没有在上述 Python 导出表中包装。它没有执行 0x9F 或解析 SFDP，不能把其返回值扩写为未经采集的三字节 JEDEC。

[`maixpy_main.c` L663–698][main] 中的厂商/设备值是 `maixpy_main()` 的局部变量，启动时打印，源码没有把它们保存到可由 Python 名称访问的全局对象。即使存在旧日志，也无法从该局部变量的生命周期推导出稳定、公开的当前 ID 缓存接口。

不要为补采新日志主动重启并宣称整条路径无写入：[`flash_init()` L197–202][main] 在读 ID 前调用 QE 设置；[`w25qxx_enable_quad_mode_dma()` L210–230][flash] 在位未设置时调用状态寄存器写入，相关函数还会发 WRITE_ENABLE。启动的 [`init_flash_spiffs()` L228–242][main] 在挂载失败/强制条件下可格式化。普通 read-ID 指令是读取，不代表包住它的启动序列符合无写边界。

## 逐文件许可记录与复用决定

本项只复核接口并撰写事实，不复制源码到产品、不构建、不分发新的程序。以下为实读文件的许可声明，不能由顶层一句 MIT/Apache 推断所有文件的具体许可：

| 文件 | 实际文件头/适用信息 | 本项处理 |
| --- | --- | --- |
| `modMaix.c`、`maixpy_main.c` | Sipeed 2019，文件头 Apache-2.0 | 仅审查。 |
| `machine_spi.c` | MicroPython / Eric Poulsen 2017，完整 MIT 文件头 | 仅审查。 |
| `w25qxx.c`、`w25qxx.h` | Canaan 2018，文件头 Apache-2.0 | 仅审查内部命令，不包装执行。 |
| `ide_dbg.c`、`ide_dbg.h` | OpenMV / Ibrahim Abdelkader，文件头明确 MIT | 仅审查，不包含 OpenMV IDE Qt 代码。 |
| `moduos.c` | MicroPython，Josef Gajdusek / Damien George，完整 MIT 文件头 | 仅审查。 |
| 固定 MicroPython 核心 `moductypes.c`、`objmodule.c`、`mpconfig.h`、Unix `modffi.c` | 各文件实读 MIT 文件头，作者信息各异 | 仅审查。 |
| `Maix_utils.c`、`modmachine.c`、`py_modules.c`、`mpconfigport.h`、MaixPy `CMakeLists.txt`、`sipeed_uid.h` | 这些文件自身没有许可头。MaixPy [`LICENSE.md`][license] 将仓库源码归入 MIT 或 Apache-2.0，并要求逐文件/组件核对；其通用描述没有为这些无头文件逐一消除归属歧义。 | 保留此限制，不将这些文件单独标记为已明确 Apache 或 MIT。本项不复制它们；未来若要直接复用，应补足上游归属/许可依据。 |

对应 SDK 子模块此处仅作函数定义检索，没有采用其中某个实现或声称其全体依赖许可已完成审计。此处的版本、许可和调用链结果不能代替拟采用 RAM ISP 项目的单独审查。

## 给当前实现的边界

继续采用已有普通 REPL、RAM 脚本、文件和相机路径，不为容量探测追加 `gc_heap_size(size)`、`flash_format()`、重启、IDE 模式、FPIOA 重映射或原始内存读写。自动 Flash 识别需要另行完成来源和构建可追溯的实现；应明确实际 Flash 命令、SPI 初始化行为、内存布局、超时/CRC 和退出恢复，不根据历史日志或数组读回长度放行。

现有容量门禁保持关闭。当前板子的身份、实际容量和备份覆盖范围仍应来自本次连接的有效探测；本文不给出已读到任何新 ID 的结论。

[maix-tree]: https://github.com/sipeed/MaixPy-v1/tree/d8901fd2272f000226f1c1037c1eb7c412b88e66
[core-tree]: https://github.com/micropython/micropython/tree/ced340d739e84737dd5c8e6b4ab9af2ea44e29e7
[sdk-tree]: https://github.com/sipeed/kendryte-standalone-sdk/tree/7fdb511fe61026eec5874885de5981c4f60f664d
[modmaix]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/Maix/modMaix.c#L22
[utils]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/Maix/Maix_utils.c#L58
[machine]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/standard_lib/machine/modmachine.c#L31
[uid]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/kendryte_sdk/include/sipeed_uid.h#L7
[spi]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/standard_lib/machine/machine_spi.c#L329
[modules]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/modules/py_modules.c#L13
[uos]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/standard_lib/uos/moduos.c#L188
[portconfig]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/include/mpconfigport.h#L218
[core-module]: https://github.com/micropython/micropython/blob/ced340d739e84737dd5c8e6b4ab9af2ea44e29e7/py/objmodule.c#L175
[uctypes]: https://github.com/micropython/micropython/blob/ced340d739e84737dd5c8e6b4ab9af2ea44e29e7/extmod/moductypes.c#L648
[ffi]: https://github.com/micropython/micropython/blob/ced340d739e84737dd5c8e6b4ab9af2ea44e29e7/ports/unix/modffi.c#L28
[cmake]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/CMakeLists.txt#L85
[core-config]: https://github.com/micropython/micropython/blob/ced340d739e84737dd5c8e6b4ab9af2ea44e29e7/py/mpconfig.h#L327
[ide-header]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/include/ide_dbg.h#L30
[ide]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/omv/ide_dbg.c#L442
[flash-header]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/drivers/flash/include/w25qxx.h#L52
[flash]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/drivers/flash/src/w25qxx.c#L70
[main]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/components/micropython/port/src/maixpy_main.c#L197
[license]: https://github.com/sipeed/MaixPy-v1/blob/d8901fd2272f000226f1c1037c1eb7c412b88e66/LICENSE.md
