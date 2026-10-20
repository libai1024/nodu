# Windows x64 source build and package path

Parallels cannot resume the existing Windows11 ARM64 guest because its
product license expired. Do not bypass that restriction. Author/build what
the current host supports and distinguish cross compilation from execution.

## Native sidecars

Use the already repaired cargo-xwin environment to build real PE artifacts:

```sh
CARGO_TARGET_X86_64_PC_WINDOWS_MSVC_RUSTFLAGS="-C target-feature=+crt-static" \
cargo xwin build --release --locked --target x86_64-pc-windows-msvc \
  -p nodu-device -p nodu-resources --features nodu-device/mock --bins
```

Use static CRT for the release binaries so an unbundled VC runtime does not
become an implicit prerequisite of the portable sidecars. Keep this flag
target-scoped with an explicit --target; do not apply it to host proc macros.
Record PE imports and fail/report any unexpected non-system DLL dependency.
Stage nodu-device.exe, nodu-terminal.exe, nodu-resources.exe under
`resources/bin/win32-x64` via fresh temporary file + rename. Verify PE
machine0x8664 and record hashes; do not claim they executed on Windows.
Keep C zlib and all firmware integrity gates unchanged.

In build-native.cjs add explicit Windows target mapping
`win32-x64 -> x86_64-pc-windows-msvc` for the cargo invocation and builtPath,
so a Windows ARM host running x64 Node cannot silently mislabel an ARM
sidecar as x64. Set the same target-specific static-CRT rustflags in that
Windows release build's environment. Windows desktop build requires x64 Node.

## Windows media sources and dispatcher

Use lead-authored `scripts/media-sources.json`. Its values are the SAME pins
as the existing macOS build. Add a check that the manifests/pins agree rather
than silently updating either version.

Add `scripts/build-media-windows.cjs`, exposed via build-media.cjs on win32.
Windows dispatcher passes --arch/--help to this script, propagates exit
status, and never silently skips media. Accept only win32+x64; clearly
reject unsupported targets. Default standard desktop build calls it.

Require a working MSYS2 UCRT64 toolchain. Find MSYS2 at `MSYS2_ROOT`, falling
back to `C:\msys64`; validate `usr\bin\bash.exe` before work. Don't install
system packages from the product build script. Document prerequisites.
Guest/native Windows CI supplies them; a missing toolchain is a build error.

Node owns HTTPS-only bounded downloads, pinned SHA checks and safe tar
extraction. Retain the existing bounds (64 MiB source archives, 5 redirects,
120 s request timeout). Reject absolute/traversing archive members and links
outside the expected root. No unsigned third-party FFmpeg binary download.

Cache: `desktop/.tools/media/win32-x64`. Per-target sources, SDL install,
markers and build log live there. Keep the archive/source copyright/license
materials under shared licenses/ffmpeg; Windows-specific metadata and recipe
under `licenses/ffmpeg/win32-x64`.

## Exact MSYS2 build commands

Launch `<MSYS2_ROOT>\usr\bin\bash.exe --login -s -- <cacheDir> <jobs>
<ffmpegVersion> <sdl2Version>`, passing the tracked lead-authored
`scripts/build-media-windows.sh` as stdin (source versions are validated
numeric versions from media-sources.json). Environment:

```js
{ ...process.env, MSYSTEM: 'UCRT64', CHERE_INVOKING: '1', MSYS2_PATH_TYPE: 'inherit' }
```

The tracked script uses quoted positional arguments/cygpath and cleans
existing source objects on a cache miss. Its fixed configure recipe below
is authoritative; never interpolate a Windows path into shell source:

```bash
set -euo pipefail
cache="$(cygpath -u "$1")"
jobs="$2"
export PATH="/ucrt64/bin:/usr/bin:$PATH"
for tool in gcc make pkg-config objdump; do command -v "$tool" >/dev/null; done
test "$(gcc -dumpmachine)" = "x86_64-w64-mingw32"
unset MACOSX_DEPLOYMENT_TARGET SDKROOT
export CFLAGS="-O2"
export LDFLAGS="-static-libgcc"
cd "$cache/SDL2-2.32.10"
./configure --prefix="$cache/sdl2-install" \
  --host=x86_64-w64-mingw32 --enable-shared --disable-static \
  --disable-video-x11 --disable-video-wayland --disable-pulseaudio \
  --disable-alsa --disable-jack --disable-libsamplerate
make -j"$jobs"
make install
export SDL2_CONFIG="$cache/sdl2-install/bin/sdl2-config"
export PKG_CONFIG_PATH="$cache/sdl2-install/lib/pkgconfig"
export PATH="$cache/sdl2-install/bin:$PATH"
cd "$cache/ffmpeg-9.0.2"
./configure --disable-autodetect --disable-gpl --disable-nonfree \
  --disable-version3 --disable-doc --disable-debug --disable-network \
  --enable-ffplay --enable-sdl2 --enable-w32threads --disable-pthreads \
  --enable-small --enable-static --disable-shared --disable-x86asm \
  --target-os=mingw32 --arch=x86_64 --cc=gcc \
  --extra-ldflags=-static-libgcc
make -j"$jobs"
gcc --version > "$cache/toolchain.txt"
ld --version >> "$cache/toolchain.txt"
```

jobs = min(available CPUs, 8), at least1. A successful cache marker includes
source hashes, target, exact flags and compiler identity. On a marker miss,
clean affected build objects before configure. A matching successful marker
can skip rebuilding sources but must still validate staged output.
The script may be materialized as a tracked .sh for audit/reuse; keep the
source text identical to this recipe apart from conditional cache/cleaning
plumbing and logging.

## Staging and validation

- Stage ffmpeg.exe, ffprobe.exe, ffplay.exe and SDL2.dll together in
  `scope-extension/resources/bin/win32-x64`.
- Audit import tables with the selected toolchain objdump. Allowed non-system
  import is ONLY the staged SDL2.dll. Refuse unbundled compiler/codec DLLs.
- Exact system DLL allowlist (case-insensitive):
  ADVAPI32, AVICAP32, AVIFIL32, BCRYPT, CFGMGR32, COMCTL32, COMDLG32,
  D3D9, D3D11, D3D12, DCOMP, DINPUT8, DWMAPI, DXGI, GDI32, IMM32,
  KERNEL32, KSUSER, MF, MFPLAT, MFREADWRITE, MSVCRT, NTDLL, OLE32,
  OLEAUT32, POWRPROF, PROPSYS, PSAPI, RPCRT4, SECUR32, SETUPAPI,
  SHCORE, SHELL32, SHLWAPI, USER32, USERENV, UCRTBASE, UUID, VERSION,
  WINMM, WINTRUST, WS2_32, WSOCK32; also API-MS-WIN-* and EXT-MS-WIN-*.
  These are DLL names with ".dll". A surprise dependency is a reported
  blocker, not permission to widen this list silently.
- Run each exe -version/-buildconf/-L on a Windows host. Reject enable-gpl,
  enable-nonfree or enable-version3. Require LGPL text.
- Reuse the actual encode/probe smoke (64x48 MPEG4) and dummy-driver ffplay;
  report failed playback explicitly, never call an unexecuted check passed.
- Include FFmpeg LGPL, SDL2 license, pinned source tarballs, exact build
  scripts/recipe and recorded toolchain information. Include MinGW/GCC runtime
  notices/Runtime Library Exception from the installed toolchain if its
  static runtime is linked; missing notices are a release blocker. Don't
  copy unrelated SDK contents or user files.
- Windows metadata records target win32-x64, PE machine, hashes, imports,
  flags and actual runtime check outcome. Do not use the Darwin root record
  to describe Windows files.
- Package validation requires Windows metadata and all four media files.
  In a Windows package use its per-target record as the top-level media
  metadata; keep shared source/license records and Windows recipe.

## Host-independent checks and tests

Put build argument/target/import-table validation in importable pure helpers,
so malformed CLI args, traversal/unknown DLL names and arch mismatches can
be tested on this Mac without pretending Windows executed. Existing backend
validation should generate valid local file:// URLs via pathToFileURL(tmpdir
paths) rather than hardcoded file:///tmp (invalid drive form on Windows).
Its media exe existence check must use the .exe suffix on win32.
The mock-sidecar test must use the freshly staged
resources/bin/<platform>-<arch>/nodu-device[.exe], not an old host-default
native/target/release binary (explicit-target builds live elsewhere).

Do not skip the firmware crate or change compression backends merely to
obtain a green Windows check. Standard Windows build/package failure stays
visible until a licensed Windows runtime or CI can execute it.

## Real-machine execution record (2026-10-21)

Parallels stayed blocked, so validation moved to a LAN Windows host:
`DESKTOP-F2B1361`, Windows 10 19045 x64, reached via OpenSSH as `libai`.
Per the owner's instruction nothing is installed on C:; the workspace is
`D:\nodu-build`, MSYS2 lives at `D:\msys64` (base tarball 2026-09-27,
sha256 verified), the repo mirror is `D:\nodu-build\repo`.

Environment found/provisioned on the host:

- Node v24.12.0 + npm 11.6.2 at `E:\SoftWare\nodejs` (satisfies the Node 24 gate).
- VS 2022 **BuildTools** with MSVC 14.44.35207 + Windows 10 SDK → `npm ci`
  completed in ~1 min (898 packages, `@lumino/widgets` patch applied).
- No Rust toolchain: the three sidecars were the cargo-xwin cross-built
  artifacts, copied to `D:\nodu-build\bin` and executed there —
  `nodu-device.exe`/`nodu-terminal.exe`/`nodu-resources.exe` all print their
  real `--help` on Windows 10, and `nodu-device.exe --mock` ran the full
  mock-board e2e (connect → REPL → file round-trip → recording → disconnect)
  inside `backend-validation.cjs`.
- Windows OpenSSH kills the whole process tree when a session ends —
  detached `nohup`/`start` launches do NOT survive; long builds run inside a
  held-open SSH session instead.

Bugs found only by real Windows execution (each fixed + covered by a
host-independent unit test):

1. GNU tar parsed `D:\…\x.tar.xz` as remote-tape `host:file` →
   "Cannot connect to D: resolve failed". Fix: `tarInvocation()` passes the
   basename with `cwd` set to the archive dir.
2. `-C D:\…` rejected by MSYS tar (backslash drive form not a valid dir).
   Fix: `toMsysPath()` maps `D:\x` → `/d/x` for the `-C` operand.
3. FFmpeg's shipped stub `Makefile` made the pre-configure `make clean`
   guard fail → `ffbuild/config.mak: No such file`. Fix: clean only when
   `ffbuild/config.mak` exists (proves a prior configure ran).
4. `ffmpeg.exe`/`ffprobe.exe`/`ffplay.exe` imported `libwinpthread-1.dll`
   (MSYS2 UCRT64 posix-thread gcc). The import audit caught it; fix:
   `--extra-ldflags='-static-libgcc -Wl,-Bstatic,--whole-archive
   -lwinpthread -Wl,-Bdynamic,--no-whole-archive'`. SDL2.dll needed nothing.
5. The build marker did not cover recipe changes → stale reuse. Fix:
   marker now records `recipe=sha256(build-media-windows.sh)` and compares
   the full field count.
6. Test-suite Windows gaps: `file://${winPath}` produced invalid URIs
   (pathToFileURL required); vscode-uri `fsPath` lowercases the drive
   letter (assertion now case-folds on win32); `nodu-resources` lookup
   lacked `.exe`.

Windows `backend-validation.cjs` after fixes: 37 pass, 0 fail, 2 skips —
both environmental (no `native/target/release` dev binary since sidecars
were cross-built; no MaixPy-v1_scripts checkout fixture).

### Outcome on the real host (continued)

- `build-media-windows.cjs` completed: staged ffmpeg/ffprobe/ffplay.exe +
  SDL2.dll, import audit clean, `-version`/`-buildconf`/`-L` pass, smoke
  `executed: true` — encode `ok: 1146 bytes`, probe `ok: mpeg4 64x48`,
  ffplay `ok: dummy drivers, -autoexit`. License/GCC-runtime-exception
  notices and `win32-x64/metadata.json` generated.
- `package-electron.cjs` on win32 produced `dist/Nodu-0.1.4-win32-x64.zip`
  (503 MB) + `manifest.json` (sha256 `ab073987…`). Real-Windows bugs fixed
  en route: NTFS-alphabetical readdir exposed a missing `mkdir(resDest)`
  for top-level resource files; @electron/packager requires `author` for
  Win32 exe metadata (added); the `tar -cf D:\…zip` remote-tape colon trap
  hit again in the zip step (basename+cwd fix).
- `Nodu.exe --version` on the host booted Electron main — modules loaded,
  container created, application resolved. In-package `nodu-device.exe`
  and `ffmpeg.exe` run from the packaged resources tree.
- Remaining honesty boundary: a full GUI session was not driven over SSH
  (session-0 windows are not interactive); device serial behaviour on
  Windows is untested (no board attached to that host); the package is an
  unsigned portable zip — no installer, no Authenticode.
