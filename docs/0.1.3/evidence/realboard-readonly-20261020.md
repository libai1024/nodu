# 真板只读验证：E7 定位、白名单修复、完整备份（2026-10-20）

硬件：野火 CAM K210 / GC2145，`/dev/cu.usbserial-3120`（CH340 1A86:7523），MaixPy 0.6.3 `d8901fd22`，flash Winbond W25Q128JW。驱动方式：直接驱动 release `nodu-device` JSON-lines（无 Node 超时层），脚本与完整转录在 `artifacts/flash-probe/20261020/`。

## 结论

- **E7 根因确定**：板上 flash 是 Winbond **W25Q128JW 1.8V 变体**，JEDEC `EF 60 18`、legacy `EF 17`。容量 128 Mbit = 16 MiB 正确，但类型字节 `0x60` 不在白名单（原仅收 `0x40`/`0x70`）。E7 是 stub 在 9F/90 联合白名单失败后的自身响应，不是 ROM/链路错误。
- **修复生效**：`probe_identity_allowed` 增加 `jedec[1] == 0x60`，stub 重建为 **8,688 B / SHA-256 `6e9843b2…29833a2`**；Python/Rust 主机 `SUPPORTED_IDS` 同步加 `EF6018`；全部钉死点与 fixture 更新。
- **完整只读备份真板通过**：探针 → 容量证明 → 16 MiB 验证快照（SHA-256 `ec7378fb…`）→ 21 用户文件哈希核验 → boot/full-flash 恢复包 → manifest `verified:true`。全程约 23 分钟，零 flash 写入。
- **门禁负路径真板确认**：无容量证明时 `flashFirmware` 正确拒绝（"Flashing is blocked until the actual flash JEDEC capacity is verified"）。
- **未做**：真机烧写（`flashFirmware` 未提交执行）；IDE 模式备份；Windows。

## 过程记录

### 第一轮（旧 stub，run1.log）

12:40 连接 raw/115200 → execute 正常 → flashFirmware 负门禁拒绝 → 保全阶段 21 文件 + 16 MiB 候选快照（0x160000 段一次校验失败、重试恢复——重试路径实战通过）→ 波特率恢复 → RAM stub 加载、ROM 握手成功 → DE 返回 2 字节 `[DE, E7]`，容量未验证 → 备份按门禁中止 → finally 重连固件成功。元数据：`decodedFrames:1, slipErrors:0, stage:"DE-identity"`。

### 诊断候选上板（e7_diag.py 转录）

用运行时参数化把 `nodu_flash_probe` 的 STUB 切到 e7-diagnostic-candidate BIN（8,792 B / `f9dbf4…`，与冻结清单一致），并把 DE 解析换成 11 B 诊断帧。结果：两次读取一致 `jedecId=ef6018, legacy90=ef17`，帧 `dee7 ef6018 ef17 7db373b4` CRC 通过。E7 物理原因由此确定。

### 修复

- `tools/flash-probe/src/protocol.c` 白名单加 `0x60`；`test_protocol.c` 类型字节改 256 值扫描（C 测试 ASan+UBSan 通过）。
- 用冻结 SDK/工具链 rebuild → `probe.bin` 8,688 B `6e9843b2…`；`build-report.json`/`source-manifest.json` 由构建脚本重新生成。
- 同步：`resources/flash-probe/probe.bin`、`nodu-kflash/src/assets/probe.bin`、Python `STUB_*`、`probe.rs` `STUB_*`、两侧 `SUPPORTED_IDS`、`build-identity.json`、两个 README、差分/会话 fixture 重生成（cargo test 全绿）。

### 第二轮（新 stub，run2.log）

12:56–13:19 完整跑通：保全 → 探针（`two CRC-checked, allowlisted current JEDEC responses agree`）→ `Physical JEDEC "EF6018" verified: 16777216 bytes` → 探针后 21 文件复查未变 → `Full flash SHA256 and original K210 boot header verified` → 恢复包 + manifest，`verified:true, flashCapacityVerified:true`。备份存于 `~/.nodu/backups/20261020-131953-realboard`（含用户数据，未入库）。

## 相机冷启动（run-camera*.log）

- IDE 连接正常；`sensor.get_id()` 预热前为 `0x0`。第一次 `startCamera` 成功（running，init i2c 正常）。
- 第二次（连接后 ~1 s）`startCamera` 板端报 `[MAIXPY]: no sensor` → `OSError: Reset Failed`（`init_camera` 内 `sensor.reset()`）。
- 判定：GC2145 SCCB 复位时序临界，与本板开机 `main.py` 相机演示争抢传感器；发生在固件 reset 内部，非主机协议问题。与 2026-10-19 诊断结论一致（helper 可用、810 帧实拍）。缓解建议：helper 内加有界重试（板上文件，未改）。

## 审查修复（本轮一并落地）

1. `flash.rs` 分段备份空文件死循环：`size=0` 时 `offset+=0` 永不推进，改为与 Python `range(0,max(size,1),64KiB)` 等价的 `for … step_by`。
2. `lib.rs` `session()`/`ide_session()` 检查闭包尊重 `restoring_io`，与 `check()` 一致——取消不再中断波特率/REPL 恢复（真板日志中恢复路径已验证）。
3. `flash.rs` IDE 备份 exec 错误保留 protocol/cancel 类别，非协议错误仍映射为 firmware 错误，IDE 失步拆链分支可正常触发。

## 遗留

- 900 s Node 层超时杀进程（P1，UI 路径）在此只读验证时尚未修复；后续安全修正见 [phase-6-flash-migration.md](phase-6-flash-migration.md)。`line_timeout` 死代码、Windows `std::os::unix` 编译缺口及媒体打包问题仍待处理。
- 真机 `flashFirmware` 已于当日执行并通过回读验证，见 [realboard-flash-20261020.md](realboard-flash-20261020.md)。该运行另发现 IDE 模式备份通道损坏（fail-closed，无写入）。
