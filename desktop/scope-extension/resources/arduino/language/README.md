# Arduino language tooling

Nodu runs Arduino Language Server **0.7.7-nodu.1** as a separate process. This is
Arduino's 0.7.7 source with two narrowly scoped fixes dated 2026-10-27:

1. `go.bug.st/lsp v0.1.3/textedits.GetOffset` counts LSP UTF-16 code units while
   returning UTF-8 byte offsets; columns clamp to their own LF/CRLF line and split
   surrogate pairs are rejected.
2. `sourcemapper.ApplyTextChange` always executes each line-map update after the
   map becomes dirty, rather than short-circuiting those updates.

`nodu-utf16-mapper.patch` is the exact source diff. The modified corresponding
source, including fixed vendored dependencies, original licenses, Go regression
tests and `NODU-MODIFICATIONS.md`, is supplied in
`ARDUINO-LANGUAGE-SERVER-NODU-SOURCE.tar.gz`. The unmodified upstream tag archive
is retained as `ARDUINO-LANGUAGE-SERVER-SOURCE.tar.gz`:
https://api.github.com/repos/arduino/arduino-language-server/tarball/0.7.7

Both archives and the patch have fixed SHA-256 values in `tools.json`.
The original source root is `arduino-arduino-language-server-481a5ca`; the modified
source root is `arduino-language-server-nodu.1`. ALS retains AGPL-3.0 and the
vendored dependencies retain their original licenses. Nodu's MIT license does
not replace these licenses.

## Reproduce the build

`desktop/scripts/build-arduino-language-tools.cjs` calls
`build-arduino-language-server.cjs`. It verifies the committed modified source
and patch hashes, obtains the pinned official Go **1.24.1** build toolchain,
executes all ALS tests and the explicit vendored regression package, then builds
without module downloads. Official prebuilt ALS archives are retained in the
catalog only as provenance; they cannot overwrite the modified runtime.

A manual build from the extracted modified source with Go 1.24.1 is:

```
go test -mod=vendor ./... ./vendor/go.bug.st/lsp/textedits
CGO_ENABLED=0 GOTOOLCHAIN=local GOPROXY=off go build -trimpath -buildvcs=false -mod=vendor -ldflags '-X github.com/arduino/arduino-language-server/version.versionString=0.7.7-nodu.1 -X github.com/arduino/arduino-language-server/version.commit=481a5ca-nodu.1 -X github.com/arduino/arduino-language-server/version.date=2026-10-27T00:00:00Z' -o arduino-language-server .
```

For cross compilation set `GOOS` and `GOARCH`. Go is needed by the package builder,
not the end user. Two independent ARM64 builds produced the same binary SHA-256:
`2fa517a13d97da0f3ed5656bb92da367cc7c3b90a2217749970181498595a0ec`.
The complete host source/tool/binary hashes are recorded in
`resources/bin/<host>/ARDUINO-LANGUAGE-TOOLS.json`. Native executable updates use
new inodes and atomic renames, including clangd, to avoid macOS stale-code caches.
During macOS application packaging, `package-arduino-language.cjs` refreshes
installed-byte hashes after inner Mach-O signing and before signing the enclosing
application. `buildBinarySha256` preserves the original reproducible build hash;
source and patch hashes are never replaced. A real temporary signing test passed;
this does not mean a full release installer was built or validated.

## Other components

- ALS upstream: https://github.com/arduino/arduino-language-server/releases/tag/0.7.7
- LLVM clangd **21.1.8**, https://github.com/clangd/clangd/releases/tag/21.1.8,
  Apache-2.0 WITH LLVM-exception; the full distribution and builtin headers are retained.
- Client **vscode-languageclient 9.0.1**; exact transitive versions and license
  texts ship with `plugins/nodu-arduino-language`.
- C++ syntax: official Microsoft VS Code **1.105.1** grammar/configuration,
  better-cpp-syntax commit `f1d127a8af2b184db570345f0bb179503c47fdf6`, MIT;
  original notices and per-file URLs/SHA-256 ship in `grammar/manifest.json`.

The clangd launcher permits compiler queries only under Nodu's `data/packages/**`
and `data/internal/**`. On macOS it clears SDKROOT to prevent host SDK injection
into Xtensa analysis. It does not alter user source, `.clangd`, or profiles.

Verified modified binaries enable fast incremental editing inside recognized
simple function bodies. Top-level changes, complex macros, raw strings and other
uncertain preprocessing boundaries use an exact whole-document resynchronization.
The two source fixes do not claim to repair every upstream prototype-alias case.
Unrecognized/custom ALS binaries retain the conservative compatibility path.

macOS ARM64 is exercised with ESP32-C3/S3. macOS x64 is built from the same source
and checksum-recorded, but has not been exercised on Intel hardware. Linux x64
and Windows x64 build inputs are pinned; their native workflows remain unverified.
The Windows clangd launcher requires a Windows C compiler on the package builder.
Linux/Windows ARM64 is not advertised. See the repository's
`docs/design/esp32-language-verification-20261027.md` for evidence and boundaries.
