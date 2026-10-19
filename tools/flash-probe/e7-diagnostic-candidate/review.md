# E7 诊断候选独立复审

2026-10-19。结论：本轮限定审查未发现 P1/P2。候选仍只用于离线诊断审查；未激活、未连接串口或 GUI，未执行 RISC-V 产物。

本记录在 owner 冻结后按根任务要求新增，不修改冻结产物或现役文件。本文件不属于下列既有 53 项清单；原 `artifact-manifest.json` 保持不变。

## 冻结输入

- `artifact-manifest.json`：SHA-256 `8b379d06a0e2900b6ff313203a245e1ec2df52f5b6cbbaced52d9a134b3f8db8`。独立逐项复算 53 项大小与 SHA，全部匹配。
- 候选 BIN：8,792 B，SHA-256 `f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874`。
- `baseline-manifest.json` 所列 16 项现役输入大小与 SHA 全部保持一致。

## 协议与数据边界

- 仅 E7 失败响应扩为精确 11 B：`DE E7 JEDEC[3] legacy90[2] CRC32-LE(first 7 bytes)`。候选 `src/protocol.c:93` 分支复制五个既有 ID 字节，清空其余响应空间，再写 CRC；返回长度固定为 11。
- `src/platform.c` 相对基线只将原局部 `legacy[2]` 改为回调输出参数。9F、90 读取各执行原有一次；E7 在组合白名单失败时立即返回，先于 4B UID 读取。控制器初始化、MMIO、引脚、时钟、SPI 命令、顺序、限时及清理没有变化。
- 成功路径仍为原 27 B、原 CRC 范围及原白名单；其他错误仍返回 2 B。E7 不包含 UID 或未初始化尾部数据。
- `host_diagnostic.py` 只接受已解 SLIP 的精确 `bytes`，严格验证 11 B、DE/E7、CRC32 小端。它仅导入标准库，不导入现役 host，不连接设备，不映射容量或修改会话认证状态。
- 所有诊断结果均为 `authenticated=false`、`capacityVerified=false`；即使五个 ID 字节恰好匹配成功白名单，也不会生成 `verified` 或 `capacityBytes` 授权字段。

## 独立离线测试

- 使用 `/usr/bin/clang -std=c11 -O1 -g -Wall -Wextra -Werror -fsanitize=address,undefined -fno-omit-frame-pointer`，在临时目录编译并运行 `test_protocol.c`、`src/protocol.c`、`src/slip.c`。编译和执行均 exit 0，无 sanitizer 报告；未链接 platform/MMIO。测试输入运行前后 SHA 未变，并与冻结清单一致。
- C 测试覆盖禁用操作码、错误请求长度/字段/CRC、初始化门禁、未变更的成功 27 B 和其他 2 B 错误、E7 独立 CRC 向量、精确五字节来源、UID 尾部清零、分配边界哨兵、特殊字节 SLIP 及发送失败。
- 独立运行 `python3 -B -m unittest discover -s . -p test_host_diagnostic.py -v`：10/10 通过。
- 另用五种合成 ID 组合（包括两个成功白名单组合、全零、全 FF、SLIP 特殊字节）做 765 个拒绝检查：逐一扰动 11 B 帧的 88 个 bit、错误长度、现役认证 parser 反向拒绝候选帧，全部通过。五种有效诊断帧仍始终返回两个 false 标记。
- 本机 C 测试详细命令、输入指纹和输出保存在 `/var/folders/b0/df_pc2213nj1ld31vtwzl5cm0000gn/T/nodu-e7-independent-review-20261019-_d02mhvh/report.json`。未重复执行目标构建，也未执行硬件测试。

## 现役隔离复核

- 现役 BIN 仍为 8,672 B，SHA-256 `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`；`nodu_flash_probe.py` 的 `STUB_SHA256`、`STUB_SIZE`、`STUB_PATH` 保持原值。
- 现役 host SHA-256：`2dfdacb7648efacaac1ba47d465ea06d498c809de5a9dc68e9cb787364133c9a`；现役 codec SHA-256：`caa90b2e1192c5ac30191435898643394fb20b4d22f1ad306af9943f6289c929`。末次复算均一致。
- 候选目录无 symlink，与核查的 50 个现役文件及现役资源无 hardlink 别名。构建脚本和构建报告的输出均在候选自身目录，没有复制到 App resources 或改写 pins 的路径；现役资源没有引用候选诊断 parser。

本结论不认定第五次 E7 的物理原因，不提供实测 ID 或容量，不改变现役容量、备份或烧写门禁。其硬件运行效果尚无本候选的实测证据。
