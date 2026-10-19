# 固定来源与许可

本目录从已固定 DCC 基线复制源码、链接脚本、构建脚本、协议测试和许可记录后做隔离增量。原始文件 SHA-256 在 `baseline-manifest.json`；实际编译输入在 `source-manifest.json`；差异仅为 `src/{probe.h,platform.c,protocol.c}` 与 `test_protocol.c`，另新增本目录离线 host 诊断解析 / 测试及报告。`boot.c`、`slip.c`、`ram.ld`、`build.py` 和上游许可文本保持基线字节。

| 来源 / 文件 | 固定版本与许可边界 |
| --- | --- |
| `protocol.c` | 保留 LoBo 2020 / Nodu 2026 Apache-2.0 头；CRC 和 D2/D7/DE 语义来自 [ktool main.c](https://github.com/loboris/ktool/blob/0345aa90d9b3830641373fb4e3ce4edf45d0a46f/src/isp/main.c)，提交 `0345aa90d9b3830641373fb4e3ce4edf45d0a46f`。本次 E7 11 B 是明确标出的 Nodu 诊断增量，并非上游格式 |
| `platform.c` | 保留 Canaan 2018 / Nodu 2026 Apache-2.0 头；基于 [SDK spi.c](https://github.com/kendryte/kendryte-standalone-sdk/blob/45642af98f15c24d64703ff57c97360794ca6f55/lib/drivers/spi.c)，固定提交 `45642af98f15c24d64703ff57c97360794ca6f55`；此次仅回传已读 legacy 两字节，不调整 SPI |
| `slip.c` | 保留 Vowstar / Nodu MIT 头；按 [kflash.py](https://github.com/sipeed/kflash.py/blob/550828c768b16ef329695d3f5eace3f6bcf14af2/kflash.py) `550828c768b16ef329695d3f5eace3f6bcf14af2` 的公开格式适配；未使用 ktool GPL SLIP 源码 |
| Nodu `probe.h`、`boot.c`、`ram.ld`、`build.py`、`test_protocol.c` | 各文件原有 Apache-2.0 SPDX / 头保留 |
| `host_diagnostic.py`、`test_host_diagnostic.py` | Nodu 本次独立离线实现，MIT SPDX；仅依赖 Python 标准库，无现役 host / serial 导入 |
| SDK CRT、sysctl、FPIOA、UARTHS 与实际头文件 | 与 DCC 同提交 / 同哈希；Apache-2.0 及个别头文件的实际声明详见 `licenses/THIRD-PARTY-NOTICES.md`，不将全包概括为单一许可 |
| 编译器与运行库 | GNU GCC 16.2.0 宿主编译器 SHA-256 `38435e3c6da930b24b014c763e904839bc4069aaa14773cbe9bf57dd741ba792`；旧官方 GNU8.2.0 目标头及显式 lp64f `libgcc.a`。运行库含 LGPL 附加链接许可和 GPL3 + GCC Runtime Library Exception，完整文本随 `licenses/` 保留；本候选不能称为纯 Apache |

SDK 固定归档 SHA-256：`18281ca5d8da535d8815a906f0d3f31d047b99cbd0d29f8dc98fb77c9be45a44`；官方旧工具链归档：`f3cc7dc8c5fa8928aa804cc305f91935957ef81c41829064d8ee8da8d5aa8ec4`；显式 `libgcc.a`：`966235fc4bd270d2a5abcd0f42886549ad02a54cf21c785a99e1ae60608ade66`。构建没有执行旧 cc1、没有使用新编译器默认 libc / 运行库。

本目录保留 DCC 的逐文件许可原文和[运行库审计](../../../docs/flash-probe-runtime-audit.md)所述边界。完整改动与归属可供审阅；这不是法律结论，也不是分发或硬件执行批准。
