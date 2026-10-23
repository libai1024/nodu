# Isolated WASI CRC probe

macOS arm64 only. From the repository root:

```sh
python3 artifacts/ai-tutor-m0/wasi/fetch-tools.py
python3 artifacts/ai-tutor-m0/wasi/run-crc.py
```

Python 3.12+ is required. The first command downloads the exact official WASI SDK 34 and Wasmtime 50.0.0 assets (about 181 MiB total), verifies their release SHA-256 digests, and extracts into ignored `cache/`. Unity v2.7.0 sources are pinned to a commit and verified against `unity-manifest.json`. All original licenses/headers remain in downloaded sources.

The test uses Sensirion's SHT3x datasheet vector `CRC(0xBEEF)=0x92`, rejects damaged data, then recompiles with an intentionally wrong polynomial. Correct code exits 0; the mutation must exit 1. It compiles only the included trusted probe source, never a user project, and does not open hardware.

SDK 34 requires SJLJ/EH flags plus `-lsetjmp` for Unity's default setjmp path. The compiler also needs `-wasm-use-legacy-eh=false`; Wasmtime rejects legacy EH. Exact working flags and prior integration failures are in `results/integration-findings.json`.

This is a CLI feasibility probe, not the application runner or a general untrusted-code execution service. Windows/macOS x64 assets were inventoried, not executed. Disk allocation and logical file-byte sums differ because of links; both measurements are named explicitly in `results/tools.json`.
