# Nodu device workflow and real-frame tools — verification

Date: 2026-10-19, Asia/Shanghai. This records a bounded implementation stage, not complete Arduino/MaixPy parity or a release qualification.

## Environment and isolation

- macOS arm64, Theia 1.76.0, Electron 42.8.1, Node 24. Native test window used a separate user-data/config directory, backend port 4192, and `/tmp/nodu-native-validation` workspace. Captures are actual native screenshots, 3040 × 1920 pixels (1520 × 960 CSS points).
- Original user windows on 4188/4189 and their unsaved editor buffers were not refreshed, saved, closed, or edited. The `preview/` Git repository was not edited. No installer was published.
- Serial ownership was checked before connecting. Only the integrating agent operated `/dev/cu.usbserial-3120`; no sidecar opened it. Selected physical profile: Embedfire K210 CAM / GC2145. Firmware reports MaixPy 0.6.3, `v0.6.2-89-gd8901fd22 on 2024-06-17`; `Sipeed_M1` is firmware architecture, not a physical-manufacturer identification.
- The earliest `hardware-smoke.jsonl` incorrectly labeled `sys.version` (`3.4.0`) as firmware identity. That field was corrected to `os.uname()` before the native App acceptance above; the historical log was retained rather than rewritten. It is not evidence of a MaixPy 3.4.0 release.
- External pre-device-service source snapshot SHA-256 was rechecked: `76d95e46470fafbf628912514ea61f0617edf7d61ae465eeb168ff7af10fffd6` at `/Users/wangwei/Model/k210-studio-snapshots/20261019-014417-before-device-service/source.tar.gz`.

## Native App hardware acceptance

| Check | Observed result / evidence |
| --- | --- |
| Scan/connect/identity | App scanned and selected the USB serial port, connected, and displayed the actual firmware and separately selected physical profile. `native-reconnect.jpg` shows these fields. |
| REPL and logs | App printed `NODU_NATIVE_REPL_OK 42`. After disconnect/reconnect it printed `NODU_NATIVE_RECONNECT_OK 42`; visible in the native output panel in `native-reconnect.jpg`. |
| Current dirty buffer → RAM → STOP | Replaced only the isolated workspace buffer with a unique marker and loop. App logs printed `NODU_NATIVE_DIRTY_20261019` and incrementing ticks. Run was disabled while active; STOP returned to connected. `native-running-pro.jpg` shows dirty dot, loop, running state and real output. No startup program was written. |
| Mode/state preservation | Switched simple → pro while running, then stopped and returned to simple. Same serial/session and dirty buffer remained. A second dirty marker `NODU_NATIVE_DIRTY_IMAGE_TOOLS` remained through image tools, dialogs, copy, exports and further layout switches; see `native-image-roi-simple.jpg`, `native-image-mask-pro.jpg` and `native-file-fixed.jpg`. |
| Native upload/download | Uploaded a unique `/flash/nodu-ui-roundtrip-20261019.bin` from the native file chooser, then downloaded to a new local file via native save dialog. Source and downloaded bytes: 4,124; SHA-256 `f019cbe2e09ff7d9fa2f4f4cfedb129bbd67cf1a26c8dd870dbeea3eb1571002`, byte-equal. `native-file-roundtrip.json`. |
| Binary-download feedback correction | Initial download succeeded but automatic text-open produced a misleading failure. Kept historical `native-reconnect.jpg`; fixed by screening strict UTF-8/control characters before optional text-open. Native repeat to a new file completed without the modal/error and kept the dirty editor: `native-file-fixed.jpg`, `native-file-roundtrip-fixed.json`, same bytes/SHA. |
| Cancel | Canceled a native download dialog, returned to the connected device with unchanged editor, then downloaded successfully. |
| Actual camera | Native App received and visibly displayed a normal 320 × 240 scene. `native-camera-simple.jpg` and `native-image-roi-simple.jpg`. Historical black frame was retained separately; user confirmed the board had been face down. No sensor/driver/register fix was applied for it. |

Uploads created only uniquely named acceptance files. Existing boot/main/config/helper files were not overwritten or deleted. This is not a physical unplug/power-failure test. Ordinary raw-REPL snapshots are low-speed and pause while a user script owns the serial parser; no sustained FPS guarantee is made.

## Real device frame tools

- Real JPEG frame #33 was frozen, inspected, and dragged to ROI `(54,45,195,119)`, containing exactly 23,205 pixels. The original RGB/approximate LAB pixel sample, ROI overlay and RGB histogram were visible.
- Resumed frames #34–43 and switched to pro/back; ROI and dirty buffer remained. Fit, 100%, and 200% were selected in the native UI; 200% visibly enlarged the raster into the scrolling viewport.
- Switched to grayscale histogram and enabled the PC LAB mask. With L lower bound 50, the frozen ROI showed 10,711 / 23,205 pixels (46.2%) matching. This is PC sRGB/D65 LAB over decoded JPEG, not bit-for-bit board RGB565/LAB or a recognition result.
- Copied `(50, 100, -128, 127, -128, 127)` using the actual button, pasted using the native system clipboard into a new scratch editor, and visually checked it. Undid the scratch paste and closed the empty scratch page; the original dirty main buffer remained unchanged. `native-image-threshold-copy.jpg`.
- Exported PNG and JPEG through native save dialogs while mask/ROI were active. Viewed both output images: full original color scene, without mask or ROI. Preserved as `native-export-frame-43.png` and `.jpg`.
- JPEG output: 3,397 bytes, SHA-256 `57f63451654ebc4d5a32758089744dae78b68f160559f213d1105d7975d12db4`. Used the App REPL to hash `_nodu_jpeg.to_bytes()` on the board; exact matching hash appears in `native-export-hash.txt`. PNG: 39,661 bytes, SHA-256 `61727b644b92f5574dbd4438fb3f52e2562207abe17968cfbf800d2ecb68dabb`.
- Both real and synthetic parameter actions now only copy values; no parameter action calls editor edits. Source differences from the earlier static review are noted in its follow-up below.

## Build and offline verification

Commands ran with `/opt/homebrew/opt/node@24/bin` on PATH:

```text
desktop: npm run compile
  TypeScript: exit 0
desktop: node --test scope-extension/test/backend-validation.cjs scope-extension/test/image-analysis.cjs
  14 tests, 14 passed, 0 failed (6 backend + 8 image/clipboard)
desktop: ~/.nodu/python/bin/python -m unittest discover -s scope-extension/test -p 'worker*_test.py' -q
  33 tests, OK
desktop/browser-app: ../node_modules/.bin/theia build --mode development
  browser + node: 0 errors
desktop/electron-app: ../node_modules/.bin/theia build --mode development
  browser + node + electron: 0 errors
```

Native bundled artifacts were refreshed atomically on macOS after the build. Source dependency ABIs and user-running original windows were not rebuilt/restarted. One static design detector run is preserved in `detector.json` with no findings; it was not rerun. Static review is in `code-review.md` and `image-tools-code-review.md`; final visual review is recorded separately in `finish-review.md`.

## Retained gaps

- Current complete backup, actual capacity certification, App firmware write/readback/recovery remain unverified; no actual flashing was performed in this stage. Historical `0x90` EF/17 and Winbond 128 Mbit mapping are documented in `docs/device-capacity-status.md`; these are not a current-session 3-byte JEDEC measurement. The capacity guard was not bypassed, no custom ISP probe was installed, and no full erase/startup rewrite occurred.
- Windows is not physically tested. STM32F103C8T6 and ESP32-C3/S3 toolchains, board/package/library managers, persistent application deployment, serial plotter, full Python language service, KPU inference, simulator/Daxin integration and several legacy MaixPy tools remain incomplete or unverified as itemized in `docs/feature-baseline.md`.
- Image tests do not qualify large production datasets, every camera, calibration consistency with board LAB, or professional accessibility certification.

## Firmware preparation and final review follow-up

The native App's **读取官方固件** action verified the local official image/cache: 2,116,288-byte image, SHA-256 `6dde2d59adc344ee0c7f96300528b4feff5e36c160f5cc0066016389394f15fa`, planned payload 2,116,325 bytes, sector coverage `[0, 0x205000)`. No firmware bytes were written to the board. Clicking **备份当前设备并验证** refused certification immediately because the supported read-only capacity helper is unavailable; the current source checks this before closing the live transport or doing any probe. The App stayed connected, and the confirmation checkbox and flash action stayed disabled. No full backup was produced by this attempt.

Independent finish review found one wording issue in this preparation state: a verified image was labeled as writable and planned bytes were called actual writing. The single correction changed the labels to **镜像校验 / 校验通过** and **计划写入**, rebuilt both targets with zero errors, then captured `native-firmware-prepared-fixed.jpg` and `native-firmware-blocked.jpg`. The reviewer scored the correction resolved and returned **ship** for this bounded UI increment, recorded in `finish-review.md`. No second detector pass ran.

The static image review's warning about the earlier synthetic `executeEdits` path is historical: the integrating change removed that path, uses `ClipboardService` plus acknowledged tuple copying, and the final source review confirms no parameter action edits buffers. This does not retroactively change the static review's recorded source fingerprints. Only the isolated test workspace buffer was saved before refreshing that test window to validate the wording correction; original user buffers remained untouched.

Native screenshots were saved by the capture API as JPEG. Their initially incorrect `.png` suffixes were normalized to `.jpg` without changing bytes; `artifact-renames.json` records the mapping. The exported actual PNG remains `.png`. Documentation links were updated after the final documentation handoff. The final native test disconnected, and `lsof /dev/cu.usbserial-3120` showed no owner; the isolated validation window remains available without holding the board.
