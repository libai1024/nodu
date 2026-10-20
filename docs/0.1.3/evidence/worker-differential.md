# Python ↔ Rust worker 差分验证（N1.5）

日期：2026-10-20。层级：**主机级**（模拟板，无真板）。

## 装置

- `desktop/native/crates/nodu-mockboard/src/bin/mock-bridge.rs`（新增，未提交）：stdio ↔ MockBoard 双向字节泵。stdin=主机→板，stdout=板→主机，无 unsafe、无新依赖。
- `tools/diff/worker_diff.py`（新增，未提交）：`pty.openpty()` 产生真实串口路径；`mock-bridge` 以 master fd 为 stdin/stdout 运行；Python worker（`~/.nodu/python` venv，`serial_for_url` 开 slave 路径，`exclusive` + DTR/RTS 在 macOS PTY 上实测可用）连接模拟板；Rust `nodu-device --mock` 用 `port: "mock"` 走进程内同一模拟板。
- 两侧执行同一 RPC 序列并逐步比较：结果/错误类别、日志流、状态相位。端口名、时序、固件字符串不比较。

## 结果（2026-10-20 运行，退出码 0）

| 步骤 | 双侧观察 | 判定 |
| --- | --- | --- |
| connect | ok | MATCH |
| state | connected + repl/files/script/framebuffer 全 true | MATCH |
| execute-print | ok + stdout 含 diff-ok | MATCH |
| execute-error | error + stderr 含 ZeroDivisionError | MATCH |
| run-print | ok + running 语义一致（mock 合成 tick 输出两侧一致） | MATCH |
| stop-running | 运行中停止 → running=false，无设备级错误 | MATCH |
| list-before | /flash = [main.py] | MATCH |
| write-new | ok | MATCH |
| write-noclobber | 两侧均拒绝覆盖（error） | MATCH |
| read-back | 9 字节完全一致 | MATCH |
| list-after | [diff_test.py, main.py] | MATCH |
| disconnect | ok + phase=disconnected | MATCH |

**12/12 步观测一致，0 真实差异。**

## 边界（如实记录）

- 这是**模拟板级**差分：两侧面对的是同一 Rust mock 固件模拟，而不是真板。Python 走 raw REPL、Rust 走 IDE 二进制协议，线上字节本来不同；比较的是 RPC 级可观察行为，不是线上字节。
- `stop-running` 的日志内容存在已知设计差异（raw REPL 会回显 KeyboardInterrupt traceback；IDE 抑制固件中断尾巴）——本脚本只比较 running=false 与无设备级错误，不判差异。
- 真板并排对照仍属 N1.6（todo）。
- 发现并已修正的装置问题：`--mock` 工厂仅在 `port == "mock"` 时替换传输层，任意路径会落到真实 serialport 并报 No such file or directory。

复现：`cargo build --release -p nodu-mockboard --bins && python3 tools/diff/worker_diff.py`（需 `~/.nodu/python` venv 与 release `nodu-device`）。
