# Phase 2 证据：MaixPy IDE 二进制协议（ide_dbg）

## 追加判别：关闭帧缓冲并先停止采集

在同一串口 `/dev/cu.usbserial-3120` 上做了一次有界诊断：
`connect`（IDE / boardId=2 / embedfire-cam-gc2145）成功后发送
`setPreview(false)`，再用 `runScript` 执行 `sensor.run(0)`、有界读取已有
`/flash/gc2145_board.py`、`init_camera()`、`skip_frames(time=1000)`，
然后计划打印 `NODU_DIAG_READY` 并进入 snapshot 循环。仅在收到 READY 后
才重新开启预览；本次没有收到该标记。

实际输出为 `init i2c:2 freq:100000`、`[MAIXPY]: no sensor`，
随后在 helper 第 77 行抛出 `OSError: Reset Failed`。25 秒观察窗口内
帧事件为 0。最后 `stop` 和 `disconnect` 均成功，诊断进程已退出。
没有改写 helper、启动脚本、配置或固件。

这次结果说明“初始化期间禁用帧缓冲，并在 reset 前停止采集”这一组合
在当前状态下没有恢复相机。不能据此认定硬件损坏，也不能将帧缓冲开关
视为已证实的唯一原因；同一次冷启动下与原版 IDE 的对照仍未完成。

日期：2026-10-19。硬件：`/dev/cu.usbserial-3120`（VID 6790 / PID 29987），MaixPy 0.6.3（v0.6.2-89-gd8901fd22），Sipeed_M1。本记录只包含实际执行过的命令与观察到的输出；未执行的项目明确标注。

## 实现范围

- 新 crate `nodu-maix-ide`：`IdeSession` 封装 ide_dbg 6 字节头 `[0x30, cmd, len:u32 LE]`；query(0x8d)/version(0x80)/arch(0x83)/exec(0x05)/stop(0x06)/running(0x87)/TX len(0x8e)+data(0x8f)/frame size(0x81)+dump(0x82)/FB enable(0x0d, len0 + i16 尾)/SYS_RESET(0x0c)/FILE_SAVE(0x07 → 状态 0x88)。
- 新 crate `nodu-maix-connect`：9 板型 reset 序列（按 `evidence/original-private-params.md` 的映射）、115200 raw-REPL 同步（复用 `Session::enter_raw_repl`）、`repl.init(1500000,...,ide=True)`、切 1.5 M、query 握手（仅在零字节响应时重试，最多 31 次；部分响应即失败）。
- `nodu-protocol`：`ConnectArgs.boardId?` / `ConnectArgs.protocol?`（`'ide'|'raw'`，默认 ide；raw 仅作差分/test oracle），`DeviceState.boardId/protocol/fps`，ts-rs 类型已重新生成。
- `nodu-device`：`ConnMode::{Raw,Ide}`；IDE 下 `connect/execute/runScript/stop/listFiles/readFile/writeFile/setPreview/startCamera/saveFile/resetDevice/disconnect` 全部走二进制协议；增量 UTF-8 解码、Traceback 行分类 stderr；`Exception: IDE interrupt` 与 `raw REPL; CTRL-B to exit` 两条固件自身行精确匹配过滤；帧事件 base64 `onFrame`；断开时 stop + FB 关 + SYS_RESET（FW_VERSION 查询已删除 `ide_mode.conf`，重启后回正常 REPL）。
- `nodu-mockboard`：独立固件命令派发（非复用主机编码器），含 split 读、TX 缓冲、running 生命周期、固定 JPEG fixture、FILE_SAVE 独立 SHA-256 校验、reset 回 normal、baud 切换记录。仍是命令形态模拟器，不声称固件行为保真。
- Node：`saveFile`/`resetDevice` 加入 facade 白名单（`nodu-backend-module.ts`）与 server；前端：板型档案 + 9 项 `连接板型` 下拉（localStorage `nodu.board-id`，默认 2），`ctrlcmd+r`/`ctrlcmd+e` 命令，预览暂停/继续不再被 `state.running` 门（startCamera 仍限 idle）。

## 验证命令与结果

- `cargo fmt --all -- --check`：通过。
- `cargo clippy -p nodu-device -p nodu-repl -p nodu-serial -p nodu-protocol -p nodu-mockboard -p nodu-maix-ide -p nodu-maix-connect --all-targets --all-features -- -D warnings`：通过。`nodu-imaging`（lead 维护）有 `many_single_char_names`、`chunks_exact` 等 clippy 报错，按要求未改算法，已上报。
- `cargo test --workspace --all-features`：全部通过（device 集成 19、maix-ide 单元 16、repl 10、imaging 4 等，无失败）。
- `npm run check:licenses`：141 files clean；`npm run compile`：0 errors；`node --test scope-extension/test/backend-validation.cjs`：8/8；`npm run build:native`、`npm run build:electron`：0 errors。

## 2026-10-19 复测（本轮修复后，同板同 helper）

- 板文件逐字节比对：`readFile /flash/config.json`（766 B）与 `/flash/gc2145_board.py`（7338 B）SHA-256 与 `/opt/homebrew/share/maixpy-k210/firmware/embedfire-config.json`、`demos/gc2145_board.py` **完全一致**。存档：`artifacts/ide-diag/config.json`、`gc2145_board.py`。
- `runScript` 逐字跑 `desktop/examples/gc2145-camera/camera_preview.py`：`GC2145_INIT {freq:24000000, registers:646}` → `CAMERA_OK frames=10/20/30` → "Camera check finished; no startup file was written."；帧事件 320×240 JPEG（`ffd8…ffd9`，`artifacts/ide-diag/camera-frame.jpg` 3672 B 经 `file` 鉴定为 baseline JPEG），fps 约 12.8–13.7，结束后 `fps:null`。
- 无限 `sensor.snapshot()` 脚本：运行中流式帧 48+（preview 保持 enable）；`setPreview false` → 0 帧；`setPreview true` → 14+ 帧恢复——**运行中暂停/继续预览已验证**。
- `stop`（相机循环）→ `running:false`；立即 `execute print(6*7)` → `42`（已修"相机脚本 stop 后固件 ~1–2 s 内 `ide_dbg_init` 会清空 RX、吞掉新 EXEC"问题：`do_stop`/`exec_ide`/`runScript` 发送前先等 `>` 提示符或 ~300 ms 静默，上限 3 s）。
- `execute` 结果与控制台均不再含 `raw REPL; CTRL-B to exit` 与 `>`（holdback 保留末两行，终末块才做 `ide_strip_tail`；非固件尾的用户行即时放行）。
- `writeFile` 3 KiB → `readFile` SHA 一致 → 删除；`saveFile` 随机名 1500 B → 落 `/sd` SHA 一致 → 删除；`saveFile boot.py` 无 `confirmedStartup` 被拒。
- `resetDevice` → `connect` 重连 → `print(7*6)`→42。
- 固件忙时（`sensor.snapshot` 阻塞 VM）单条 IDE 命令 5 s 无响应不再致命：`ReplError::Timeout` 区分"零字节超时（忙）"与"部分字节（desync）"；poll 遇 Timeout 跳过本轮并先清 RX 陈旧字节，desync 仍然 phase=error+关 transport。
- `execute` 的 `running` 标志存在固件滞后：`false` 只有在见过 `true`、看到 `>`、或输出来过且静默后才采信（宽限 3 s），修复快速脚本偶发返回 `""`。
- **Python worker 对照（同板、原始 raw 协议、`~/.nodu/python` venv）**：`connect` OK，`5*8`→40，`startCamera`（同一 helper）→ 12 s 内 23 帧，末帧 320×240 3575 B `ffd8…ffd9`。原 MaixPy IDE.app 已安装（/Applications），GUI 对照未在本轮执行。
- **传感器间歇性**：`startCamera`（脚本与 camera_preview.py 等价：namespace exec helper → `init_camera()` → skip_frames(1000) → snapshot 循环）本轮两次（含 fresh SYS_RESET 后）报 `[MAIXPY]: no sensor` / `OSError: Reset Failed`（helper 第 77 行），而 verbatim 脚本与 Python worker 在同日同板成功——同一 helper 字节既成功也失败，原因未定（见下方"后续判别实验"，raw 成功而 IDE 失败的同次对照已观察到，不能排除协议路径相关因素）；如需定论建议断电重启后重测。

## 后续判别实验（同日稍晚，同一 `/dev/cu.usbserial-3120`）

目的：区分"传感器初始化失败"与"帧投递路径"。新发现与结果：

- **`boot.py` 自启相机 demo（新发现，重要混淆因素）**：手动 pyserial 探针（115200，直接 `\x03\x03`/`\x01` 握手）捕获到每次复位后板子先跑开机 demo：`init i2c:2 freq:100000` → `[MAIXPY]: sensor id = 45` → `find gc2145` → `GC2145_INIT {freq:24000000, registers:646}` → `DEMO_OK {"task":"camera","frames":40,...}`，然后才出现 `>>>`。影响：(a) demo 期间独占 sensor；(b) `>>>` 在 demo 结束后才出现，故带 reset 的 connect 实测需 >60 s 才能同步（本轮一次 connect 超 60 s 超时窗、reply 迟到的现象即由此解释，非协议故障）。
- **raw-REPL 路径成功（同一 boot，demo 已结束后）**：`exec(gc2145_board.py 源码 + init_camera() + sensor.snapshot())` → `sensor id = 45` / `GC2145_INIT` → `PYWORKER_CAMERA_OK 320 240`。传感器可初始化、可出图。
- **IDE 路径同 boot 两次失败**：`connect(ide, boardId=2, embedfire-cam-gc2145)` → `runScript` 逐字 `camera_preview.py` → 只输出 `init i2c:2` 后退出，0 帧；`setPreview(false)` 后重跑 verbatim → 同样失败（注：setPreview 的 reply 被迟到的 connect reply 抢先匹配，FB-off 是否实际生效未能确认，该次实验证据力弱）。
- **判别结论**：同一 boot 内 raw-REPL 初始化成功而 IDE 路径初始化失败两次——纯粹"硬件随机失效"假设被削弱，IDE 路径相关因素（连接时序 vs boot demo、connect 时 `framebuffer(true)` 的通道状态、或 connect reset 序列遗留的 sensor 状态）仍是活假设；但单次 raw 成功 vs 两次 IDE 失败样本量不足，且同日早些时候 verbatim 脚本经 IDE 成功过。**原因仍未定论**。待做判别项：(a) IDE 路径下不重新 `init_camera`、直接 `sensor.snapshot()`（boot demo 已配置好 sensor）——该测试已启动但在收到回复前被终止，无结果；(b) 断电冷启动后先测 IDE 再测 raw；(c) 原 MaixPy IDE GUI 在 fresh reset 上对照。
- `mpremote` raw-REPL 在该板多次 `could not enter raw repl`（`OK\x04Traceback ... SyntaxError\x04>` 残留），与本 sidecar 的 raw 会话无关；直接 pyserial 握手可进入，说明是 mpremote 时序兼容问题。

## 真板直连 sidecar（target/release/nodu-device，stdio JSON-lines）

驱动脚本逐条发送 `{id,method,args}`，观察 `{id,result|error}` 与 `{event,data}`：

- `connect {protocol:'ide', boardId:0, boardProfile:'generic-k210'}` → 成功；state：`protocol:"ide"`、`architecture:"K210 [Maix:000000000000000000000000]"`、`firmware:"MaixPy 0.6.3"`、`capabilities.framebuffer:true, firmware:false`。
- `execute print(42)` → `"42"`（修掉固件 banner 过滤后无噪声）。
- `execute 1/0` → stderr 事件为 `Traceback ... ZeroDivisionError: divide by zero`，回复 `执行失败：脚本产生了 Traceback`，`lastError` 同步，连接保持。
- `runScript` 无限 `print('tick')` → stdout 事件持续流入；`stop` → `running:false`，固件上报 interrupt Traceback 被精确过滤；`print(6*7)` → `42`（恢复）。
- `setPreview true/false` 均成功（无 sensor 时 `FRAME_SIZE w=0` → 无帧，符合协议）。
- `writeFile` 4 KiB 随机 → `readFile` SHA-256 一致；临时文件 rename 成功。
- `saveFile` 8 KiB 随机 → 0x88 状态 success；文件落在 **`/sd/smoke_save.bin`**（固件优先写已挂载 SD），`/sd` 读回 SHA-256 一致。
- `resetDevice` → SYS_RESET，state 转 disconnected；约 6 s 后完整 IDE reconnect 成功（`print(7*6)`→42），证明 FW_VERSION 路径已移除 `ide_mode.conf`、板子回正常 REPL 可重连。
- 收尾：`os.remove` 清理全部 smoke 临时文件（含早期失败遗留的 0 字节 `.nodu-transfer-*.tmp`），断开，串口释放。

## UI 冒烟（隔离实例 127.0.0.1:4195，更新后端后重启；CDP 4196 驱动）

- 弹层：串口扫描→选 `/dev/cu.usbserial-3120`→连接→chip `nodu-chip-connected`，状态行 `已连接 · /dev/cu.usbserial-3120 · MaixPy 0.6.3`；`连接板型` 下拉含全部 9 项。
- REPL `print(42)` → 42；`1/0` → stderr 控制台可见且 chip 保持 connected；`print(6*7)` → 42；断开 → chip `nodu-chip-disconnected`。
- 截图：`artifacts/rust-sidecar/20261019/ide-connected.jpg`、`ide-console-stderr.jpg`。

## 已知限制与发现（需 lead 决策）

1. **EXEC_SCRIPT 作用域不持久**：实测 `import os` 后下一脚本 `NameError: 'os' isn't defined`——MaixPy-v1 每次 EXEC 都是全新 `<stdin>` 作用域（与简报中"globals persist"不一致，以实测为准）。已改为每个内部脚本自包含：`eval` 自动补 `import os`，writeFile 用 append 分块，readFile 用 open/seek/print(repr)/close 分块。若要求与原 IDE 完全一致，需复核固件 exec 上下文。
2. **传感器初始化间歇失败（原因未定论）**：同日同板同 helper 字节（SHA-256 与 homebrew 参考一致）：verbatim `camera_preview.py` 经 `runScript` 成功出 30 帧、无限 snapshot 循环成功（48 帧+暂停/继续验证）、Python worker `startCamera` 成功 23 帧；而 `startCamera`（等价脚本）两次（含 fresh SYS_RESET）与同 boot 下 IDE 路径 verbatim 脚本两次在 `init_camera` 内报 `no sensor`/`Reset Failed`；另 raw-REPL 手动 `init_camera`+snapshot 成功（`PYWORKER_CAMERA_OK 320 240`）。generic `sensor.reset()` 在该板已知超时（`docs/0.1.1/camera-ide-diagnosis.md`）。同一 boot 内 raw 成功而 IDE 失败的对照使"纯硬件随机失效"与"IDE 路径交互"均无法排除；板 `boot.py` 的开机相机 demo 为额外混淆因素（见上文"后续判别实验"）。**定论需断电冷启动后按判别项重测**。实机帧图、fps、运行中暂停/继续均已验证通过（脚本路径）。
3. **FILE_SAVE 落点在 `/sd`**：SD 卡挂载时固件写 SD 而非 `/flash`，这是固件行为；前端文件树若默认 `/flash` 需知晓。
4. **`boardId=2`（Dock）reset 映射**：本轮用 `boardId=0` 验证全链路；2 的 DTR/RTS 假设未单独对照，尚未证伪/证实。
5. IDE 模式 TX 输出无独立 stderr 通道，`ide_feed` 仅以行首 `Traceback` 起、缩进/冒号行续为分类规则——非常规输出形态可能误分类。
6. `>`/`\x04` 提示符残留：固件 TX 首字节偶发 `>` 或 `\x04\x04>` 前缀（raw REPL 交接残留）；repr/stat/read/write 计数解析点已过滤该前缀；流中残留（如 `>init i2c:2`）按原样进控制台，不影响功能。
