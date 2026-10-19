# Device service and real-frame tools — design consistency

Date: 2026-10-19, Asia/Shanghai. Documentation review of an ordinary extension of the existing desktop Operate surface. This report does not define a new visual system or replace the independent finish review.

## Sources read and scope checked

Read the Impeccable [document reference](/Users/wangwei/.agents/skills/impeccable/reference/document.md), [PRODUCT.md](../../../PRODUCT.md), the current sections and historical boundary of [DESIGN.md](../../../DESIGN.md), and [.impeccable/design.json](../../design.json), including tokens, component examples, capability / review records and historical snapshot separation.

Read `nodu-image-analysis.ts`, `nodu-image-state.ts`, `nodu-image-clipboard.ts`, `nodu-image-tools.tsx`, `scope-widgets.tsx`, `scope-workbench.tsx`, `nodu-device-client.ts`, `nodu-device-panel.tsx`, `nodu-firmware-panel.tsx`, `image-tools.css` and `device.css`. Checked existing widget, toolbar and layout CSS for inherited type, control geometry, focus and panel rhythm. Read [verification.md](verification.md), [image-tools-code-review.md](image-tools-code-review.md) and [finish-review.md](finish-review.md). Inspected the existing [detector.json](detector.json), which is `[]`; no detector was rerun.

Visually inspected the actual native-window captures [ROI / simple](native-image-roi-simple.jpg), [threshold / copy](native-image-threshold-copy.jpg), [mask / pro](native-image-mask-pro.jpg), [file feedback](native-file-fixed.jpg) and [prepared firmware](native-firmware-prepared-fixed.jpg). These establish visible states in the tested macOS 1520 × 960 CSS-point window, captured at 3040 × 1920 pixels. This documentation lane did not launch the app, operate serial hardware, modify UI code, build, test, change branding or operate user editor buffers.

## Retained system

The established Nodu blue / graphite Theia system remains the authority: `#4F7CFF` primary with recorded dark / light adaptations, graphite work surfaces, compact platform UI type and Theia code typography. The lowercase n-and-dot mark and nodu wordmark are retained. The SCOPE / mineral-teal snapshot remains historical.

| Area | Observed continuity |
| --- | --- |
| Shell and navigation | Existing editor, file tree, output region and right sidebar remain. The gray layout icon follows run / STOP at the upper right. Simple / pro changes panel exposure and shares the same model, buffer and tools. |
| Color and material | Tools use Theia foreground, input, editor-background and panel-border variables. Source selection and ranges use blue actions; graphite fields and fine dividers preserve hierarchy. |
| Type and density | Headings use 12 px type and compact labels retain the incumbent 10–12 px range. Pixel values, tuples, paths and hashes use code typography and tabular numbers. Controls retain small corners and minimum 28 px action heights. |
| Grouping and layout | Device sections keep 16 px horizontal inset; image sections use 12 px vertical groups with 7–8 px local gaps. The viewport scrolls at large zoom and the sidebar exposes lower tools by scrolling. |
| States and controls | Real / synthetic sources, frame identity, ROI, hit count, copy / export feedback, labels, disabled states and focus are explicit. Numeric ROI fields provide an alternative to pointer drag. |
| Semantic graphics | RGB curves carry R / G / B labels and distinct channel colors; grayscale uses Y′. Green connection / capability states and syntax colors retain semantic roles. These observed colors are not new brand tokens. |

The firmware-preparation capture visibly shows “镜像校验 / 校验通过” and “计划写入”, alongside capacity / backup restrictions and disabled flashing. The copy separates image verification from permission to flash or a completed operation. The final [finish review](finish-review.md) accepts the correction and marks this bounded increment **ship**.

No new global palette, typography, spacing scale, motion rule, component philosophy or brand choice was approved. `DESIGN.md` and `.impeccable/design.json` were retained without modification. No tokens, tonal ramps or component examples were invented or regenerated.

## Existing drift recorded without automatic repair

| Location | Drift / consequence |
| --- | --- |
| `DESIGN.md` → Components → 输入与结果 | “设备控件明确显示未连接” describes the earlier disconnected-only stage. Current UI shows real connection / running / error states. Its visual guidance remains applicable. |
| `.impeccable/design.json` → `capabilityBoundary` | Still lists real hardware connection / camera flow as unimplemented and omits the new accepted tools. Current capability truth is in `PRODUCT.md`, `docs/desktop-ui.md` and verification. KPU remains unimplemented. |
| `.impeccable/design.json` → `reviewEvidence` / `platformValidation` | Still points to the earlier brand screenshot and browser-only blue check. New native captures establish this scoped macOS increment; Windows remains untested. |
| `.impeccable/design.json` → component examples | Primary sample says “运行演示”; actual toolbar says “运行到设备” and includes STOP. The static layout SVG differs from the current target-mode glyph. These old examples do not authorize restoring old actions. |
| `.impeccable/design.json` → breakpoints | Earlier toolbar thresholds omit the added device rules at 1000 / 750 px. The tested window does not establish all smaller-window behavior. |
| Current source copy | The local-demo startup line in `scope-workbench.tsx` says visual frames are synthetic without qualifying the source; the synthetic-copy error in `scope-widgets.tsx` still says “参数预览”. Current source selectors / controls are explicit; these residual phrases can be reconciled in a separately scoped copy change. |
| Canvas focus style | `image-tools.css` uses literal brand blue for canvas focus while other controls inherit the Theia focus variable. It matches the tested surface; alternate-theme and full accessibility behavior are unqualified. No automatic token / source repair is made here. |

The old `docs/desktop-ui.md` also described disconnected-only controls, synthetic Cmd/Ctrl+Enter and automatic `thresholds.py` edits. Those statements were reconciled in the allowed documentation update. Both real-frame and synthetic actions now call `copyImageParameters` through Theia `ClipboardService`; neither edits or saves a file. The earlier static review's synthetic `executeEdits` observation is historical, as noted by current verification / finish review.

## Evidence and acceptance boundaries

[Verification](verification.md) records 14 passing Node tests, 33 passing Python tests, successful TypeScript compilation and browser / Electron builds with zero errors. This lane reports those existing results without repeating them. The single empty detector result is static evidence only.

Native captures show real JPEG ROI / original-pixel inspection, RGB / gray distributions, PC LAB mask, clipboard tuple transfer, layout continuity, download feedback and firmware preparation gating. Fit / 100% / 200% interaction, RAM run / stop, reconnection, export dialogs and the transfer sequence additionally rely on the bounded integration record and source; this lane did not replay them. JPEG export preserves original bytes and PNG uses original decoded pixels, without ROI or mask. Export hashes and the 4,124-byte round trip establish those particular samples.

PC LAB is a decoded-JPEG sRGB / D65 approximation. JPEG / RGB565 / board lookup-table differences and reduced large-image analysis sampling are disclosed; no board-LAB consistency, recognition, KPU or complete MaixPy parity follows. A black nonmatching mask area is expected content.

Current complete backup, physical Flash-capacity certification, App firmware writing / readback / recovery remain blocked or unverified. Historical `0x90` EF/17 is not a current-session three-byte JEDEC measurement. No real flashing occurred. Windows, other board / camera combinations, sustained camera performance, installer / signing / update flows and complete accessibility qualification remain outside acceptance.

## Documentation result

Updated [docs/desktop-ui.md](../../../docs/desktop-ui.md) for actual native device operations, shared simple / pro model and buffer, source distinction, real-frame tools, clipboard-only parameter transfer, original-frame export and retained hardware / platform gaps. Created this report. `PRODUCT.md`, `DESIGN.md`, `.impeccable/design.json`, implementation, tests and evidence files were not modified by this lane.
