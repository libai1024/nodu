# 阶段 1 验证证据 — Rust 侧车（`nodu-device`）

记录阶段 1 的实际验证命令与结果。另见 [references.md](../references.md) 与 [original-private-params.md](original-private-params.md)。

这是阶段 1 开发检查点，不代表阶段门禁全部通过。`acceptance.csv` 中 `passed_host` 只表示当前 macOS arm64 上的指定检查已通过；与 Python 的差分 fixture、原版并排对照、跨平台构建仍为 `todo`。

## 环境

- macOS arm64，`rustc 1.98.1`（`rust-toolchain.toml` 固定）。当前仅构建宿主目标 `aarch64-apple-darwin`；universal / Windows 未验证。
- 真板：`/dev/cu.usbserial-3120`，野火 K210（VID 6790 / PID 29987），固件 `MaixPy 0.6.3 (v0.6.2-89-gd8901fd22)`，`Sipeed_M1 with kendryte-k210`。

## 静态与单元验证（命令与结果）

在 `desktop/native/`：

| 命令 | 结果 |
| --- | --- |
| `cargo fmt --check` | 通过 |
| `cargo clippy --workspace --all-targets --all-features -- -D warnings` | 通过，0 警告 |
| `cargo test --workspace --all-features` | 首轮 31/31 通过（protocol 17、repl 4、device 10）；这是审查修正前的全量结果 |
| `cargo test -p nodu-repl -p nodu-device --all-features` | 审查修正后 22/22 通过（repl 10、device 12，已包含 2 个 proptest）；覆盖 stderr 首字节、畸形 banner、递归限制、超大行后恢复、非法 data 不覆盖文件、溢出 id 拒绝 |
| `cargo deny check` | 首轮 advisories / bans / licenses / sources 全部 ok（cargo-deny 0.20.2）；修正未改变依赖 |

注意：模糊测试是 proptest 属性测试，**不是** cargo-fuzz 长时活动。

在 `desktop/`：

| 命令 | 结果 |
| --- | --- |
| `npm run check:licenses` | 119 个 tracked+untracked 文件干净；负例验证：含 `personal benefit`、缺 `Source:` 头的 `Ported from` 文件均被拒绝 |
| `npm run compile` | 0 错误 |
| `node --test scope-extension/test/backend-validation.cjs` | 8/8 通过（含 Rust `--mock` 端到端与 deviceBinary 回退测试） |
| `npm run build:electron` | 0 错误，先跑 `build:native`（`cargo build --release --locked`）并暂存 `resources/bin/darwin-arm64/nodu-device` |

## 真板验证（前一轮，标签：hardware-run-1）

由发布版 `nodu-device` 直接走 stdio，全程在 `/dev/cu.usbserial-3120` 上完成：

`listPorts` → `connect`（返回固件/架构，`capabilities.firmware=false`、`framebuffer=false`）→ `execute print(42)` → `42` → `runScript` 无限打印循环（stdout 流式回传）→ `stop` → 恢复后 `execute print(6*7)` → `42` → `listFiles /flash` → 写 4 KiB 随机文件 → 读回 SHA-256 一致 → REPL `os.remove` 删除 → `prepareFirmware` 返回延期中文消息 → `disconnect`。板子事后无残留临时文件。

### 真板暴露并已修复的缺陷

- `serialport` 读超时返回 `Err(TimedOut)`，pyserial 语义是空读；首次 `writeFile` 因此超时并遗留 `.nodu-transfer-*.tmp`。`nodu-serial` 已改为 `Ok(0)`，复测全部通过，遗留文件经 REPL 清理。
- `follow()` 原先多消费了 `>` 提示符并剥掉 stderr 首字节；按 mpremote `data[:-1]` 语义修正，新增分片单测。
- `enter_raw_repl` 原先不校验 banner 结尾、等待 `>>>` 的缓冲区无界；已加 banner 校验与 2 字节尾部保留。

## 模拟板局限

`nodu-mockboard` 是命令形状模拟器：模拟 `nodu-repl` 所用的字节级会话（`>>>` 提示、raw REPL banner、`\x04…\x04>` 结果分片、Ctrl-C、伪 VFS、Traceback），**不模拟固件侧 IDE 协议**（`ide_dbg.c` 状态机）。IDE 模式验收仍需真板。

## 当前限制

- `capabilities.framebuffer=false`、`capabilities.firmware=false`：相机、帧缓冲与固件操作返回 `此功能将在后续阶段由新设备服务提供。`
- `boot.py` / `main.py` 写入保护仍生效（阶段 5 解除）。
- 仅宿主 arm64 构建；universal、Windows、安装器分发未验证。
- Python worker 与 `setup:device` 保留为差分对照，运行时不会自动回退。
- E7 / DE 未解决，未做任何烧写、备份。

## 界面冒烟（4195 隔离实例，Rust 后端，真板）

4195 实例在更新后的构建上重启（backend 为 Rust 拉起路径；注意启动环境需去掉 `ELECTRON_RUN_AS_NODE`，否则打包入口的 `require('electron')` 会以纯 Node 运行）。经 CDP 驱动界面：

- 串口扫描列出 `/dev/cu.usbserial-3120 · USB Serial`（Rust `listPorts` 经 UI 链路正常）→ 选口 + 通用 K210 → 连接成功，芯片绿点，设备详情显示 `MaixPy 0.6.3`。
- 控制台 REPL `print(42)` 返回 `42`；`1/0` 产生红色 stderr（`Traceback ... ZeroDivisionError`），芯片保持 `nodu-chip-connected`，工具栏**无**中央错误条（用户代码错误按 `errorOperation` 规则不算设备级错误）。
- 控制台执行 `while True: print('x')`（REPL `execute` 长任务，非工具栏 Run 按钮路径），运行中点工具栏 Stop（`nodu-stop-active`）取消，随后 `print(6*7)` 返回 `42` —— Ctrl-C 恢复链正常。stderr 中 Traceback 出现两次是既有已知限制（原始 stderr 流 + `执行 REPL失败：` 错误行各打一遍）；运行取消的日志行为预期输出。
- 断开连接后芯片转灰，`/dev/cu.usbserial-3120` 无占用。4188–4194 其余实例未动。

截图（`artifacts/rust-sidecar/20261019/`）：
- `console-connected-stderr.jpg`：已连接 + 控制台含红色 stderr，无弹层。
- `popover-connected-no-firmware.jpg`：设备弹层已连接状态，章节为 硬件设备 / 设备详情 / REPL / 板端文件，**无“固件与恢复”**（`capabilities.firmware=false` 生效）。

## 许可证 CI

新增 `.github/workflows/license-check.yml`（authored，远程 CI 未运行，无 push）：checkout + setup-node 24 + `node desktop/scripts/check-licenses.cjs`；本地同命令已通过（119 个 tracked+未忽略文件干净）。
