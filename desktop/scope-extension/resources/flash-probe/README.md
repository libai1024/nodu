# Source-built read-only Flash identity reader

This 8,672-byte RAM image is built from the fixed source under `tools/flash-probe/` in the Nodu source repository. Its SHA-256 is `dcc964360f50c97aa21ad66c18a3f1866442cb27a552ae4245b1f9c75629ea05`. `nodu_flash_probe.py` is byte-identical to the reviewed candidate. Installation is not a successful hardware test.

The worker must preserve the current device state before loading it and must verify current JEDEC identity, session binding and post-reset contents before permitting a complete backup. The reader accepts only D2/D7/DE and emits only 9F/90/4B flash reads. Returning to installed firmware resets the board and can run user startup code. No chip erase is part of this reader.

Actual reused source files, modifications, runtime closure, source manifests and reproducible build commands are in `tools/flash-probe/`; deployment pins are in `build-identity.json`. See `licenses/THIRD-PARTY-NOTICES.md` and accompanying complete licenses. The full image is not described as pure Apache or pure MIT.
