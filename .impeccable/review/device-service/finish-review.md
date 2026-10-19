disposition: ship

# Evidence validity

Independent finish review, 2026-10-19 (Asia/Shanghai). Reviewed the supplied native captures and current source only. This reviewer did not edit application source, run the app/browser, operate serial hardware, build, run tests, or run a detector. The existing `detector.json` contains an empty findings array; it was not rerun.

All six required captures exist and are valid native-window evidence at 3040 × 1920 pixels, consistent with the reported 1520 × 960 CSS-point macOS window. At initial review their JPEG payloads had `.png` path suffixes; the displayed content and dimensions were intact. The integrating agent subsequently normalized those suffixes to `.jpg` without changing image bytes. The graphite editor's empty working space and the threshold preview's deliberately black nonmatching pixels are expected content, not failed captures.

| Capture | What is visibly established |
| --- | --- |
| `native-image-roi-simple.jpg` | Real 320 × 240 scene, device/synthetic source distinction, frame #43, ROI `(54, 45, 195, 119)`, original-pixel RGB/approximate LAB sample, RGB histogram and 23,205 selected pixels. The main buffer has its dirty marker and test text. |
| `native-image-threshold-copy.jpg` | Same ROI, gray Y′ histogram, enabled mask, L range 50–100, 10,711 / 23,205 matching pixels (46.2%), and the tuple `(50, 100, -128, 127, -128, 127)` visibly pasted into a scratch editor. The main buffer's dirty dot remains. The lower tool section is intentionally scrolled into view. |
| `native-image-mask-pro.jpg` | Professional layout with the same frame, ROI, gray distribution, pixel sample and PC threshold preview. Main editor text and dirty state remain visible. |
| `native-file-fixed.jpg` | A binary file read reports 4,124 bytes saved to a new local path; no failure dialog is present. The dirty main buffer remains visible. |
| `native-running-pro.jpg` | Earlier device-service state: actual loop ticks, dirty buffer, running status, disabled run action, visible STOP, and explicit snapshot pause. This supports the execution workflow, not the later image-tool arrangement. |
| `native-camera-simple.jpg` | Earlier native device-camera state with a normal scene and frame #37. This supports real camera display, not the later image-tool arrangement. |

The copy-only verdict pass also inspected `native-firmware-prepared-fixed.jpg` and `native-firmware-blocked.jpg`. Both are valid 3040 × 1920 native captures. The prepared-state capture shows the corrected image-validation and planned-byte labels, disabled flash acknowledgement/button, capacity restriction and backup error in the same window. The blocked-state capture provides the associated gate/log detail. No original image/file state was rereviewed and no detector was rerun for this pass.

Read `PRODUCT.md`, `DESIGN.md`, `docs/surface-brief.md`, the craft floor, the current image/tool integration and CSS, the supplied static code reviews, and `verification.md`. This is an ordinary extension of the existing Operate surface: no new visual world, comp approval or redesign is required. The historical SCOPE/teal surface brief is not authority to replace the current Nodu blue/graphite desktop.

# Disposition

**ship** for the single scored firmware-preparation wording fix. It is resolved in the native confirmation; no further fix is ordered from this verdict pass. The original review's scoped image/file/layout assessment and retained limitations stand. This follow-up is not a new full-surface audit.

The incumbent visual system holds: compact platform UI type, native Theia/Electron controls, graphite field, blue `#4F7CFF` primary/selection treatment, and the gray layout icon after STOP at the upper right. The new tools use the existing sidebar rhythm, labeled native controls, clear groups and a scrolling image viewport. No contradictory physical styling, decorative layout or new navigation was introduced. Type, material and ground match the preservation brief.

# Material findings and exact targets

1. **Resolved — firmware image validation must not imply write permission or completed writing.** In `desktop/scope-extension/src/browser/nodu-firmware-panel.tsx`, the former `plan.ready` wording “已校验，可写入” conflated image verification with permission to flash, while “实际写入” described `plan.writeBytes` as an operation already performed. This was one material truth/copy batch. Current source uses “镜像校验 / 校验通过” at line 32 and “计划写入” at line 35; the flash button at line 62 remains gated by `model.canFlash`, acknowledgement and blocking state. `native-firmware-prepared-fixed.jpg` visibly confirms “镜像校验 / 校验通过”, “计划写入 2,116,325 字节”, disabled flash acknowledgement/button and the actual capacity-probe error blocking complete backup/flashing. The separate blocked-state capture confirms the same restriction in the device logs. The rendered correction resolves the finding; no regression attributable to this wording batch is visible. **Remaining from the scored fix: clear.**

No additional image/file/layout fixes are ordered. The current real-frame copy path (`nodu-image-tools.tsx:139–142`) and synthetic action (`scope-workbench.tsx:238–240`) only copy parameters. The earlier static review's synthetic `executeEdits` concern is resolved in current source. File download creates a new file before optional text opening (`nodu-device-panel.tsx:34–47`); image export captures the displayed frame, retains JPEG bytes, and refuses overwrite (`nodu-image-tools.tsx:143–166`).

# Retained limitations

- Acceptance covers the tested macOS native window and board/firmware combination. Windows, installation/signing/update flows, other window sizes and a complete accessibility qualification are not established here.
- Camera snapshots use low-speed raw REPL and pause during ordinary script execution. No sustained frame-rate, recognition, KPU or full MaixPy parity claim is accepted.
- LAB is an explicitly labeled PC sRGB/D65 approximation over decoded JPEG. JPEG/RGB565, board lookup-table differences and bounded/downsampled large-image analysis remain disclosed limitations, not board-side inference.
- Complete current-device backup, actual Flash capacity certification, real App flashing/readback/recovery remain unaccepted. The capacity guard stays in force; image preparation does not satisfy those gates.
- The original six still captures directly establish the visible states described above. RAM→STOP, new-frame retention, 100%/200% interaction, native dialog cancellation and the file transfer sequence additionally rely on the integrating agent's bounded `verification.md` record and source review; this reviewer did not replay them.
- `PRODUCT.md` and `docs/desktop-ui.md` were being reconciled by the documentation lane during this review. Earlier wording about automatic `thresholds.py` buffer edits, pending real-image tools and pending native-camera acceptance is drift to remove in that handoff; it is not current UI behavior. Historical evidence should remain labeled as historical.

# Acceptance scope

The original review plus the resolved firmware-copy confirmation accepts this narrow Operate increment: the existing native shell and layout affordance; real connection/REPL/RAM run–stop/file workflow; real JPEG display; ROI and original-pixel inspection; RGB/gray distributions; approximate PC LAB mask/count and clipboard-only parameter transfer; fit/100%/200% controls; and original-frame export with explicit provenance and limitations. The final verdict pass scored the one listed wording fix only.

The local exported JPEG hash was independently read as `57f63451654ebc4d5a32758089744dae78b68f160559f213d1105d7975d12db4`, matching the board hash visible in `native-file-fixed.jpg` and recorded in `native-export-hash.txt`. The 4,124-byte file round-trip record reports byte equality and SHA-256 `f019cbe2e09ff7d9fa2f4f4cfedb129bbd67cf1a26c8dd870dbeea3eb1571002`. These support the specific accepted transfers, not arbitrary hardware/data certification.

This is not full-product completion, an installer release qualification, firmware-write approval, or complete MaixPy/Arduino feature coverage. Preserve the real/synthetic distinction, user-controlled editor contents, blue/graphite identity and upper-right layout icon.
