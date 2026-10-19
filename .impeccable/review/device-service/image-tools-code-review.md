# Real-frame image tools: independent code review

Date: 2026-10-19 (Asia/Shanghai)

Scope: `nodu-image-analysis.ts`, `nodu-image-state.ts`, `nodu-image-clipboard.ts`, `nodu-image-tools.tsx`, their integration in `scope-widgets.tsx`, the download fix in `nodu-device-panel.tsx`, `image-analysis.cjs`, and `image-tools.css`. Related device-model, Theia clipboard implementations, dependency versions, and license notices were read to verify boundaries. No source changes, build, serial operation, or UI operation were performed by this reviewer.

## Findings

No high-confidence P1/P2 defect was found in the new real-frame tools or download fix in the reviewed version. This is a static review plus offline unit verification, not native App acceptance or a claim of complete MaixPy algorithm parity.

One existing behavior remains outside the new real-frame path: the local synthetic demo's **“预览参数变更”** invokes `ScopeWorkbenchContribution.applyThresholds`, which calls `editor.executeEdits` against the current `thresholds.py` buffer. It does not save the file, but does immediately modify its unsaved buffer. The real-frame tool never invokes this action and only copies a tuple. If the no-buffer-modification constraint applies to the whole vision panel, replace that existing demo action with clipboard-only output or an independent diff. This was reported to the integrating agent separately; it is not a regression introduced by the image-tool implementation.

## Reviewed boundaries

- **Frame freshness:** each decode has a generation/cancellation guard; canceled chunked LAB work cannot publish a stale decoded image. A retained previous valid frame is labeled explicitly on decode failure. Export captures the decoded displayed frame before awaiting its save dialog.
- **State and sources:** image-tool configuration is owned by the vision widget, rather than its conditional React component. Demo and device panels use separate threshold state and distinct source labels. Device model clears its retained frame on disconnect. Mode switches use the existing widget/service rather than creating another device owner.
- **Coordinates and pixel semantics:** pointer positions are mapped through the displayed canvas bounding rectangle to clamped original pixel indices. ROI drag includes both endpoint pixels. Pixel inspection reads the original decoded canvas even while the mask is displayed. Large-frame analysis is bounded and its reduced sampling dimensions are disclosed.
- **Threshold semantics:** bounds are inclusive and paired; PC sRGB/D65 LAB approximation and JPEG/RGB565 differences are visible. No board-side result or bit-for-bit MaixPy/OpenMV compatibility is claimed. Histogram luma formula is disclosed.
- **Export and dirty buffers:** JPEG export uses captured received base64 bytes, not a recompressed display canvas. PNG uses the original decoded canvas; neither contains ROI or mask. Export refuses an existing target and uses `createFile(..., { overwrite: false })`; it does not edit an editor model. Clipboard uses Theia's acknowledgement event to avoid falsely reporting silent browser permission denial. Theia 1.76.0 browser and Electron clipboard implementations both supply that event.
- **Device downloads:** raw bytes are created as a new local file before any optional text-editor open. Strict UTF-8 decoding and control-character screening avoid treating arbitrary binary payloads as source. Existing files and existing editor buffers are not overwritten by this download path.
- **License boundary:** `color-convert` 2.0.1 is pinned directly; its `color-name` 1.1.4 dependency and both MIT notices are present. New color conversion uses that dependency. No restricted OpenMV Qt code is imported by the reviewed files. This is a component-level review, not installer-wide distribution clearance.

## Verification

Ran the existing compiled offline suite only:

```text
/opt/homebrew/opt/node@24/bin/node --test scope-extension/test/image-analysis.cjs
8 tests, 8 passed, 0 failed
```

It verifies reference RGB/LAB values, reversed/single-pixel/clamped ROIs, analysis-size bounds and ROI mapping, histogram counts, inclusive mask boundaries and non-ROI behavior, paired threshold edits, cancellation of chunked conversion, and clipboard acknowledgement/failure handling.

The suite does **not** exercise React mount/unmount, rapid real camera updates, actual native save dialogs, platform clipboard permissions, byte hashes of App-exported files, or native mode-switch/dirty-buffer retention. Those remain integrating-agent acceptance items. There was no camera-driver reanalysis or hardware write in this review.

## Reviewed source fingerprints (SHA-256)

```text
ddc353d13e8d8d64336679122ecc9788f92f917d1938e2f5f7c8e23de4fb3d4a  nodu-image-analysis.ts
2cc3c4b42e23e1eb31d1135789f4b605cc34b92a43754652045ef2036189aeac  nodu-image-state.ts
58e22dca7f544ed61e4d2afc9ab243d1f50862e9065fb9a9a704e8ee99543e27  nodu-image-clipboard.ts
9aff6c34e4ae6527922cfe57c36cb432e9a3f2719001ac20399fe91abf25af3d  nodu-image-tools.tsx
672955d2a2d0c1627843f8e9606bf212303c61373081f83496ed8b0c43c97365  scope-widgets.tsx
29301d1fd7a993d81139af6732a6c5406f37358a92614847c021f0e1685eb167  nodu-device-panel.tsx
6a34f7895390ab2ff5a419d71916da5849a72ee750fa49c0ef4dbdffe850ed1b  image-analysis.cjs
51193291d2b8693347f8087fd460984eff81165adad3509042a2c66ee6c38925  image-tools.css
```
