# Phase 5 — native recording / conversion media tranche

Scope: `nodu-media` Rust crate (recorder, stream reader, FFmpeg/ffplay
transcoder), worker recording/conversion/playback RPC, Node service + facade +
browser model, `视频工具` menu + camera-toolbar record button.

## Format support (honest limits)

- `.bin` recording/reading is limited to the **K210/OpenMV JPEG recording
  stream** (`OMV IMG STR V1.0` magic; per-frame
  `u32le delta_ms, u32le width, u32le height, u32le jpeg_len`, payload padded
  to 16 bytes). Raw-pixel stream variants (bpp 0–3) are **rejected explicitly**,
  never silently misdecoded.
- `.bin` → video conversion is a **smoothed constant-frame-rate** conversion:
  frame rate derives from the averaged delta (`first delta, then
  (prev + delta) / 2` per frame, matching the original IDE). Variable frame
  intervals are **not** preserved in the output.
- General `.mp4`/`.avi`/`.mjpeg` inputs are delegated verbatim to the bundled
  FFmpeg; whatever codecs the bundled (autodetect-disabled) build supports is
  what works.

## Host limits

- Bundled tools exist only for `darwin-arm64` (`resources/bin/darwin-arm64/`).
  On hosts without the staged bundle, convert/play fail fast with
  "Bundled ffmpeg is unavailable"; recording itself still works.
  All staged binaries/dylibs pass a `minos <= 15.0` build gate (recorded in
  `media-bundle.md`); an actual macOS 15 machine run remains unverified.
- Media ops refuse only an active recorder or a running script (`mediaIdle =
  !busy && !recording && !running`); a connected but idle board does **not**
  block convert/play. If 转为MP4 is chosen while the camera script still runs,
  a `停止相机脚本并转换录像？` confirmation gates `device.stop()` first; cancel
  keeps the raw `.bin`.
- Output never overwrites: `.bin` targets use `create_new`, video outputs are
  persisted via `persist_noclobber` after child success; `-y` applies only to
  the owned temp file. Partial `.bin` files are kept for recovery on failure.
- Deadlines: media ops 900 s (worker check loop), record start/stop 20 s.
- No production-device testing was performed; all board-side paths used the
  mock transport.

## Verified

- `cargo test -p nodu-media`: 8/8 — recorder byte format + 16-byte padding,
  stream round-trip, JPEG/dimension validated before callbacks (bad magic /
  truncated header / payload / padding / oversize / raw-bpp / malformed JPEG),
  empty stream ok, overwrite refusal, `MAX_FRAMES` (10 000) cap in
  `Recorder.append`, live bundled-tools `.bin → .mp4` conversion.
- Review-fix pass: `read_stream` enforces `MAX_DIM`/`MAX_AREA` before
  allocating, validates the decoded JPEG (`validate_frame`) before invoking the
  callback, and bounds total stream ≤ 2 GiB including padding.
  `run_tool` calls `check()` at entry *and* before `persist_noclobber`;
  `do_stop_recording` clears `state.recording` before `finish()` so a flush
  failure can never leave a stale active flag (raw partial file kept).
- `cargo test -p nodu-device --test mock_integration recording`: 2/2 —
  mock framebuffer frames → `.bin` magic + frame count > 0 + counters;
  disconnect finalizes (flush + sync) instead of truncating.
- `cargo clippy -p nodu-media -p nodu-device --all-targets`: clean.
- `node --test scope-extension/test/backend-validation.cjs`: 18/18, including
  media URI validation (strict `file://` scheme, non-local/UNC authority,
  query/fragment, NUL, >4096 decoded bytes, non-`.bin`/`.mp4|.avi|.mjpeg`;
  encoded space/`#` and `localhost` round-trip) plus the bounded
  `fetch-models` streaming-reader test, and a full mock e2e: record → magic
  verified → `convertVideo` to real MP4 with bundled FFmpeg → overwrite
  refusal → `playVideo` under SDL dummy drivers.
- `npm run compile` (extension): clean; `npm run build:native`: staged.
- Live UI on runtime 4195 (`NODU_DEVICE_MOCK=1`, no hardware): command palette
  shows `转换视频…`/`播放视频…` (record commands correctly hidden while
  disconnected) and `CNN 模型库`. Mock `generic-k210` connect → `startCamera`
  (frames flowing, seq>0, ~22 fps) → `startRecording` produced live counters
  (frames 20→41→62, bytes 116 KB→362 KB, elapsed tracking) → `stopRecording`
  finalized a 62-frame `.bin` (magic + valid frame records verified). After
  disconnect, `convertVideo` produced a real `mpeg4 320x240` MP4 using the
  staged sidecar's sibling FFmpeg (no `NODU_MEDIA_DIR` needed). The camera
  toolbar record button (`codicon-record`/`stop`, labels 录制/结束录制, tooltip
  states the 10 000-frame/2 GiB cap) is present in the `ScopeVisionWidget`
  render tree; the preview label is `预览中`/`预览暂停` (IDE frames keep
  streaming while a script runs) and a `连接设备` button renders in both
  compact and professional modes when disconnected. Note: the default
  `embedfire-cam-gc2145` profile correctly refused `startCamera` without
  `/flash/gc2145_board.py` — an expected, well-surfaced error, not a defect.
- Review-fix live pass: stop-recording → `转为MP4` action →
  `停止相机脚本并转换录像？` confirm → `device.stop()` → convert **while still
  connected** → toast names the real output (`已转换到 nodu-ui-conv-out.mp4；
  原始录像已保留。`); extensionless save paths get the chosen format appended
  (`nodu-huge-shot` → `nodu-huge-shot.avi`); conversion runs under a cancellable
  `正在转换视频…` progress notification whose Cancel killed the ffmpeg child —
  no output file persisted, worker left `busy:false` and still connected.
  Screenshots: `artifacts/ui-minimal/20261020-media/recording-counter.png`,
  `convert-progress.png`.
- CNN library live flow: quick pick lists all five models with
  size/license/repo metadata; selecting one → `保存到本地…` /
  `复制到设备默认存储…` → the `不能在 K210 上执行` warning appears before the
  action proceeds.

## Not verified in this pass

- Native save/open dialogs (OS dialogs cannot be driven via CDP — all live
  flows above used stubbed dialog services); live `playVideo` window (covered
  headless in backend-validation under SDL dummy drivers).
- macOS 15 machine run (binaries pass the `minos <= 15.0` build gate, runtime
  behaviour on a real macOS 15 host unverified), Windows/Linux bundles,
  variable-frame-rate output, raw-pixel `.bin` variants (rejected explicitly).
