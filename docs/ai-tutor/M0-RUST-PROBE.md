# M0 Rust 与 WASI 探针

验证日期：2026-10-23。对应 M0-02、M0-03。

tree-sitter C 与 ts-rs 的隔离探针通过；真实 WASI SDK、Unity 和 Wasmtime 的 CRC 正反例在本机 macOS arm64 跑通。三平台发布资产已核对，Windows 和 macOS x64 尚未运行。结果支持继续实现 M2、M4，不代表生产规则检查器、受控测试执行器或三平台安装包已完成。

所有实验位于 `artifacts/ai-tutor-m0/rust/` 和 `artifacts/ai-tutor-m0/wasi/`。没有改动现有 Rust workspace 或 lockfile，没有访问硬件，没有向外部模型发送工程内容。

## 1. 实际环境与版本

| 项目 | 核对结果 |
| --- | --- |
| 主机 | macOS arm64 |
| Rust | `rustc 1.98.1 (48a229cea 2026-09-01)` |
| Cargo | `1.98.1 (797e8a9bc 2026-08-05)` |
| 工具链 | `stable-aarch64-apple-darwin` |
| 应用 workspace | edition 2024、rust-version 1.98、禁止 unsafe；未修改 |
| tree-sitter | 固定 0.27.1；发布元数据 rust-version 1.90；MIT |
| tree-sitter-c | 固定 0.24.2；发布元数据未声明 rust-version；MIT；实际 grammar ABI 15 |
| ts-rs | 固定 11.1.0，与应用使用的 11 主版本一致 |
| WASI SDK | 34；clang `23.1.0-wasi-sdk` |
| Wasmtime CLI | `50.0.0 (ebe5e8df1 2026-10-20)` |
| Wasmtime Rust crate | 50.0.0 元数据要求 Rust 1.97，当前 1.98.1 满足；未在应用中编译该 crate |
| Unity | v2.7.0，固定提交 `b6763fbd9cedfacaa89e2ad9fd00d615a234e355`；MIT |

版本依据：[tree-sitter 0.27.1](https://docs.rs/tree-sitter/0.27.1/tree_sitter/)、[C grammar 0.24.2](https://docs.rs/tree-sitter-c/0.24.2/tree_sitter_c/)、[Wasmtime 50.0.0](https://crates.io/crates/wasmtime/50.0.0)、[WASI SDK 34](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-34)、[Unity v2.7.0](https://github.com/ThrowTheSwitch/Unity/releases/tag/v2.7.0)。

## 2. C 语法与类型生成

运行 `artifacts/ai-tutor-m0/rust/run.sh`：19/19 样例通过，生成的 TypeScript 在应用已有 TypeScript 编译器下通过 strict/noEmit 检查。

| 样例组 | 数量 | 结果 |
| --- | ---: | --- |
| 直接判断、左右交换、成功分支、多行调用 | 4 | checked |
| 局部变量接收返回值后立即判断、变量改名 | 2 | checked |
| 中文和 emoji 前缀、普通缓冲区指针 | 2 | checked |
| 裸调用、两个调用中一个未判断 | 2 | unchecked |
| 注释、字符串、相似函数名 | 3 | missing |
| 宏封装、函数指针、不完整代码 | 3 | unknown |
| 返回传播、赋值后覆盖、未支持的比较 | 3 | unknown |

探针通过真实 AST 的 `call_expression` 等节点识别调用，不使用字符串搜索代替解析。支持范围刻意受限：直接与 `HAL_OK` 比较，或局部变量初始化后紧接的判断。`checked` 仅表示符合该语法形态，不是控制流正确性或错误处理充分性的证明。返回传播本身可能合法，目前返回 unknown，交给 M2 的规则扩展和测试；复杂宏、间接调用及有语法错误的输入也不作通过推定。

同时验证了 `温度😀` 出现在调用前时的 UTF-8 字节位置到 UTF-16 区间转换。ts-rs 生成 camelCase 字段、字符串枚举和可空范围，真实 JSON 样例可赋给生成的 TypeScript 类型。尚未覆盖协议迁移、所有未知字段策略或产品运行时校验。

证据：[样例](../../artifacts/ai-tutor-m0/rust/fixtures.json)、[结果](../../artifacts/ai-tutor-m0/rust/results/probe.json)、[生成类型](../../artifacts/ai-tutor-m0/rust/results/generated.ts)、[独立 Cargo.lock](../../artifacts/ai-tutor-m0/rust/Cargo.lock)。

## 3. WASI CRC 正反例

使用官方 SDK clang 编译 C + 原版 Unity，再用官方 Wasmtime CLI 执行。Unity 源文件与 LICENSE 保留原文，下载时校验固定提交与 SHA-256。CRC 测试向量来自 [Sensirion SHT3x 数据手册](https://admin.sensirion.com/media/documents/213E6A3B/63A5A569/Datasheet_SHT3x_DIS.pdf)：多项式 `0x31`、初值 `0xFF`，`BE EF` 的 CRC 为 `92`。

| 程序 | Unity 结果 | 进程退出码 | Wasm 文件 |
| --- | --- | ---: | ---: |
| 正确 CRC | 2 Tests，0 Failures | 0 | 64,849 字节 |
| 故意把多项式改成 `0x07` | 数据手册向量失败，实际 `CD`，期望 `92` | 1 | 64,858 字节 |

另一项测试检查改坏的数据 `BE EE` 不应匹配 `92`。负例确实产生 Unity 失败与非零退出码，没有把成功启动执行器当作测试通过。

本次发现并解决一项接入要求：Unity 默认使用 setjmp。WASI SDK 34 默认参数不能编译它，仅添加 SJLJ 参数仍缺少链接符号；加入 `libsetjmp` 后，默认 legacy EH 又被 Wasmtime 50 拒绝。以下组合实测可用，未使用 `UNITY_EXCLUDE_SETJMP` 绕开断言中止行为：

```text
clang --target=wasm32-wasip1
  -mexception-handling
  -mllvm -wasm-enable-sjlj
  -mllvm -wasm-use-legacy-eh=false
  ...sources... -lsetjmp -o test.wasm

wasmtime run
  -W fuel=10000000
  -W max-memory-size=67108864
  -W exceptions=y
  test.wasm
```

脚本设置编译 60 秒、执行 5 秒的进程超时。上述 fuel、内存上限能作为后续执行器参数的起点，但本次没有进行恶意程序、死循环、超量输出、取消或文件权限回归，因此不把此 CLI 探针视为产品隔离方案。

证据：[CRC 源码](../../artifacts/ai-tutor-m0/wasi/crc_test.c)、[真实 stdout/退出码/摘要](../../artifacts/ai-tutor-m0/wasi/results/crc.json)、[集成发现](../../artifacts/ai-tutor-m0/wasi/results/integration-findings.json)。

## 4. 发布资产与体积

官方 WASI SDK 34 于 2026-08-25 发布。通过 GitHub release API 核对以下资产名称、大小和摘要；存在资产不等于该平台已通过产品兼容测试。

| 目标平台 | SDK 压缩包字节数 | 本轮结果 |
| --- | ---: | --- |
| macOS arm64 | 180,322,002 | 下载、SHA-256 核验、编译、运行通过 |
| macOS x64 | 182,668,326 | 官方资产存在；未下载、未运行 |
| Windows x64 | 619,003,408 | 官方资产存在；未下载、未运行 |

本机另外下载 Wasmtime arm64 压缩包 9,452,176 字节。两包合计约 181 MiB。解包目录 `du -sk` 实测 SDK 620,348 KiB、Wasmtime 58,232 KiB，合计约 663 MiB；缓存保留压缩包时还要加上下载体积。结果是本机未经裁剪的工具目录占用，不能当作最终应用安装增量。逐文件逻辑大小及压缩包摘要保存在[体积记录](../../artifacts/ai-tutor-m0/wasi/results/tools.json)，其他平台资产在[平台清单](../../artifacts/ai-tutor-m0/wasi/results/platform-assets.json)。

下载的 Wasmtime CLI 在本机显示为 arm64 Mach-O，ad-hoc/linker-signed，未设置 TeamIdentifier，直接运行通过。这不证明 Nodu Electron hardened runtime、JIT entitlement、签名、公证或 Windows 发布链路可用。M4 必须独立验收实际 Rust runner 与安装包，不能继承本次 CLI 结论。

## 5. 复跑与下一步

```sh
artifacts/ai-tutor-m0/rust/run.sh
python3 artifacts/ai-tutor-m0/wasi/fetch-tools.py
python3 artifacts/ai-tutor-m0/wasi/run-crc.py
```

Rust 脚本使用独立 Cargo.toml/Cargo.lock 与应用现有 TypeScript 编译器。WASI 脚本当前限定 macOS arm64，需要 Python 3.12+；固定工具版本及摘要，缓存命中后不重复下载。`target/`、`cache/`、`out/` 均被局部 `.gitignore` 排除。

后续落实到 M2、M4 的工作：

1. 将 AST 原型拆成有快照、作用域、预算和取消的规则模块；未知边界保持 unknown，扩充等价写法和误判集。
2. 在独立 Rust runner 验证 Wasmtime 50 对当前工具链的实际构建兼容与所需 feature，不仅依据 MSRV 元数据。
3. 固定上述 Wasm EH 编译组合，验收 Unity 单项失败、全套失败、陷阱、死循环、内存和输出超限及取消。
4. 在 Windows x64、macOS x64 真机或 CI 上编译运行，再核对签名、公证、JIT、许可证汇总和按需工具包安装/回滚。三平台产品支持在这些验证前保持未完成。
