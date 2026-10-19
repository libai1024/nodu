# Desktop UI verification

Date: 2026-10-19, macOS arm64. Scope: first working Theia/Electron UI and the requested upper-right layout icon.

## Build and launch

- Node 24.21.0; pinned Theia 1.76.0 and Electron 42.8.1.
- Extension TypeScript compilation passed. Browser and Electron development bundles completed with zero build errors after the final toolbar and playback-control changes.
- Browser frontend served from loopback port 4188. Electron development window launched successfully on macOS with its backend on loopback port 4189.
- Launch scripts provide separate SCOPE configuration/user-data directories and target-specific native-module switching. Windows scripts/configuration are present but were not run on Windows. Installers, signing, and auto-update were not produced.

## Observed behavior

- The real Monaco editor opens the sample's Python files; Theia provides the file tree, filesystem, output panel, search, commands, and terminal.
- Changing L lower bound from 25 to 26 and selecting parameter preview modified the `GREEN` tuple in the editor buffer. The disk remained at 25 until Save; Save wrote 26, then Undo and Save restored 25. Switching layouts retained the dirty editor content.
- The final single gray icon sits at the far right of the workspace toolbar after Run. Clicking it toggles both directions. Accessible names indicate the destination; tooltips indicate the current mode. The old visible segmented control is removed.
- Simple layout collapses the left and bottom panels; professional layout restores them. Both retain the visual panel and share editor buffers.
- Synthetic playback run/pause, seek, LAB filtering, sample selection, and the zero-target state were exercised. Session-level checks covered bounds, reset, snapshot isolation, playback wrap, and disposal.
- The real terminal executed `pwd` and returned the sample workspace path.
- Python sample files passed syntax parsing and sample JSON was validated. Board execution was not performed.

## Finish corrections and capture limits

- The playback button now explicitly uses a 28px minimum width, preventing Theia's generic button minimum from overlapping the adjacent slider.
- A tiny-terminal capture was traced to changing the live browser device-pixel ratio while xterm's WebGL atlas was active. Fresh loading at the final viewport produced readable terminal text; no application font-size workaround was added.
- `simple-1440.jpg` and `pro-1440.jpg` show the final icon and playback geometry. `devices-1280.jpg` and `terminal-check.jpg` preserve historical filenames, but their final dimensions follow the current in-app browser panel; filenames are not viewport assertions.
- `native-macos.png` records the successfully running native window before the final icon change. That window contains user-owned unsaved edits and was deliberately left open and unrefreshed. The final Electron bundle is built, but its updated toolbar was visually verified in the shared browser frontend, not by discarding/reloading those native buffers.
- Static detector output is recorded once in `detector.json`. Independent finish-review disposition is recorded in `finish-review.md`.

## Capability boundary

Visual frames are synthetic geometry and LAB filtering uses preset sample metadata. Run does not execute project Python. Serial scanning, REPL, flashing, real camera frames, KPU inference, actual K210 simulation, and DACIR integration remain unimplemented. No board was connected or flashed during this UI work.
