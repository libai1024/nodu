# 真板烧写验证：flashFirmware 同版本回写通过（2026-10-20）

硬件：野火 CAM K210 / GC2145，`/dev/cu.usbserial-3120`，flash Winbond W25Q128JW（JEDEC `EF6018`）。
驱动：`artifacts/flash-write/20261020/flash_run.py` 直接驱动 release `nodu-device` JSON-lines（`protocol:"raw"` 连接）；完整转录 `artifacts/flash-write/20261020/run.txt`（未入库）。

## 结果

- `connect` → raw REPL @115200，识别 MaixPy 0.6.3 `d8901fd22`。
- `prepareFirmware` 命中本地钉死缓存（SHA-256 `6dde2d59…f15fa`，2,116,288 B）。
- `backupDevice`：保全 33.6 MB → RAM 探针（`EF6018`，两次 CRC 校验一致）→ 16 MiB 正式备份 + 21 文件 → 恢复包（`boot-restore.kfpkg`/`full-flash-restore.kfpkg`），manifest verified。备份目录 `~/.nodu/backups/20261020-142547-prewrite`（私有，不入库）。
- `flashFirmware`：ISP 烧录器 16,512 B @115200 加载 → `change_baudrate(1500000)` → 2,116,325 B 数据帧 ~29 s，**全程 0 警告/重试/校验错误** → ISP 重启板子 → 重连 → `utils.flash_read` 回读 boot header + 写区 SHA-256 与钉死镜像一致 → 21 个用户文件复查未变。
- 最终状态：`verified:true`，固件身份 `MaixPy 0.6.3 (v0.6.2-89-gd8901fd22)`，`protocol:"raw"`、`framebuffer:false`（修复后状态如实上报），`flashCapacityVerified:true`。干净断开。

## 新发现（独立问题，非阻塞）

**IDE 模式备份通道损坏**（fail-closed 已正确拦截，无任何写入）：IDE 连接（1.5 MBaud、帧缓冲预览开着）下 `backupDevice` 在 `transfer-preflight` 即失败——exec 返回的 stdout 中 `NODU_DATA` 行被合并成 12,756 B（每 ~2,048 B 丢 `\n` 等字节，25 个非 base64 字节）。诊断件在 `*.pre-probe/transfer-preflight.raw.bin.diagnostics.json`。初步判断是固件 IDE stdout 缓冲通道在持续大输出下的固有限制（raw REPL@115200 同脚本 23 分钟零错误）。Python 参考实现备份仅支持 raw——建议将 IDE 模式备份改为先切 raw REPL 再传输，或维持 raw-only 约束。

## 结论

K1.1 真板烧写闭环通过：门禁→备份→写→回读验证全链路在真实硬件验证。写入路径的 SLIP+CRC32 每块校验在 1.5 MBaud 下表现可靠。
