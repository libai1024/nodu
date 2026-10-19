# E7 身份读取诊断候选

2026-10-19：**仅离线构建、测试与审查，未激活、未加载 RAM、未执行硬件读取。** 现役 DCC 程序及 App resources 保持不变；本目录没有串口加载入口。

基线为 `../build/probe.bin`，8,672 B，SHA-256 `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`。固定输入及逐文件许可见 [PROVENANCE.md](PROVENANCE.md)、[baseline-manifest.json](baseline-manifest.json) 和 [source-manifest.json](source-manifest.json)。

## 唯一行为增量

仅 DE 的 E7 失败响应从 2 B 改为固定 **11 B**：

| 字节 | 内容 |
| --- | --- |
| 0 | `DE` |
| 1 | `E7`，仍然拒绝身份认证 |
| 2–4 | 本次既有 9F 读取的 JEDEC 3 B |
| 5–6 | 本次既有 90 读取的 manufacturer/device 2 B |
| 7–10 | 前 7 B 的 CRC32，小端 |

CRC 只校验诊断帧完整性，不能证明 ID 有效、芯片受支持或容量已认证。主机诊断解析始终返回 `authenticated=false`、`capacityVerified=false`，即使收到的五字节恰好等于成功白名单。

目标端只为既有 `read_identity` 回调增加 `legacy[2]` 输出参数，将原局部数组移为调用者输出。SPI 初始化、MMIO、引脚、时钟、命令、读取顺序、超时与清理不变；没有新增传输、变速或重试。E7 仍在 9F、90 完成且联合白名单失败时返回，位于 4B UID 读取之前。响应只复制这五个 ID 字节，清除其余响应空间，再计算 CRC；无 UID 字段。成功响应仍为原 27 B、原 CRC 范围、原白名单，其他错误仍为 2 B。可逐行查看 [candidate-diff.patch](candidate-diff.patch)。

`host_diagnostic.py` 是独立离线解析器，只接收已解 SLIP 的 `bytes` 帧，严格检查 11 B、DE/E7 与 CRC。它不导入现役 host，不处理 SLIP，不连接设备，不设置任何会话或备份认证状态。

## 离线结果

- BIN：**8,792 B**，SHA-256 **`f9dbf480f1f2bca6e6fd8393306058093c377217afe2059c5874ac5f20b9d874`**。
- ELF：SHA-256 `cf4ef2afdc4309bae84f286fa7a37a10775e9ede487d38db78f6d637c93e723c`；入口 `0x80000000`，`rv64imafc/lp64f`，无未解析符号、无 libc。
- BSS 空区 `0x80002258`；`_end=0x80002280`；两 hart 栈顶为 `0x8000A280`、`0x80012280`，保留原 128 KiB 链接区及栈边界断言。
- 本机纯 C 的 ASan + UBSan 测试通过：E7 精确长度、独立 CRC 向量、五字节数据来源、UID 所在尾部清零、边界哨兵、特殊字节 SLIP 往返，以及原成功 / 其他错误、请求门禁、白名单与解析器负例。
- Python 主机诊断 **10 项测试通过**：严格长度 / 类型 / op / status / CRC、00/FF/未知 ID、成功白名单字节仍不认证、拒绝原成功帧与旧 2 B E7。见 [offline-test-report.txt](offline-test-report.txt)。

构建指令与七项目标产物指纹完整记录于 [build-report.json](build-report.json)；[validation.json](validation.json) 记录基线核对、现役文件观察值及明确未硬件执行的边界。本轮结果不认定第五次 E7 的物理原因，也不改变烧写门禁。

## 复现

在仓库根目录使用与 DCC 相同的固定 SDK / 工具链缓存；`build.py` 核对归档、实际 SDK / 旧目标头及 libgcc 摘要后仅构建本目录：

```sh
python3 tools/flash-probe/e7-diagnostic-candidate/build.py \
  --sdk /tmp/nodu-readonly-probe-research-20261019/kendryte-standalone-sdk-45642af98f15c24d64703ff57c97360794ca6f55 \
  --sdk-archive /tmp/nodu-readonly-probe-research-20261019/sdk-v0.5.6.tar.gz \
  --legacy-toolchain /tmp/nodu-readonly-probe-research-20261019/official-toolchain/kendryte-toolchain \
  --legacy-archive /tmp/nodu-readonly-probe-research-20261019/toolchain-osx-mojave-8.2.0-20190213.tar.gz \
  --gcc /opt/homebrew/opt/riscv64-elf-gcc/bin/riscv64-elf-gcc \
  --binutils-prefix /opt/homebrew/opt/riscv64-elf-binutils/bin/riscv64-elf- \
  --libgcc /tmp/nodu-readonly-probe-research-20261019/official-toolchain/kendryte-toolchain/lib/gcc/riscv64-unknown-elf/8.2.0/libgcc.a
```

在本目录运行 `offline-test-report.txt` 中的主机命令即可复核协议测试；它们只执行本机测试程序，不执行 RISC-V 产物。
