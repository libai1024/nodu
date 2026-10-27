# Arduino language evidence, 2026-10-27

Root `result.json` and per-chip files are the final patched 0.7.7-nodu.1 C3/S3 protocol run. `middleware/` runs the product adapter itself against real ALS, replaying GUI Enter/paste and a running rebuild overlapped with full replacement/undo/redo. `edges/` verifies no final newline, emoji columns, current hover/diagnostic and undo. `gui-mapper-replay/` is the independent pure Go source-map replay when present.

`unicode-before-fix/` preserves the original official-server corruption; `prototype-alias-before-conservative-boundary/` preserves the remaining upstream structural alias limitation. `official-baseline/` holds earlier unmodified-tool metadata and tests, not the current shipped tools. Current metadata is `tools-darwin-*.json` and `tool-catalog.json`.

The actual Electron failure and final screenshots/output are in sibling `arduino-electron-acceptance-20261027/`. Protocol timings do not substitute for GUI verification. All original project paths appear only as test evidence; no physical serial device is opened by these tests.
