# macOS media build implementation specification

Keep FFmpeg 9.0.2 and SDL2 2.32.10 URL/SHA pins unchanged. No GPL/nonfree/v3
enablement, no Homebrew SDL or host dylibs in the shipped closure.

## Interface and architecture layout

Modify `desktop/scripts/build-media.cjs`, not its generated license copy.

- No args on Darwin: build arm64 + x64 and merge into universal executables
  and dylibs, staged under both existing `darwin-arm64` / `darwin-x64` dirs.
- `--arch arm64` or `--arch x64`: one slice only, for the parent builder and
  targeted development. Reject unknown options/architectures.
- `--help`: print interface without starting a build.
- Keep platform validation explicit. Windows implementation is a subsequent
  step; do not silently omit media on Windows.

Argument parsing shape:

```js
const { parseArgs } = require('node:util');
const { values } = parseArgs({
    options: { arch: { type: 'string' }, help: { type: 'boolean' } },
    allowPositionals: false,
});
const targetArch = values.arch || process.arch;
const universal = process.platform === 'darwin' && !values.arch;
if (!['arm64', 'x64'].includes(targetArch)) fail('unsupported media architecture');
const machArch = targetArch === 'arm64' ? 'arm64' : 'x86_64';
const ffmpegArch = targetArch === 'arm64' ? 'aarch64' : 'x86_64';
const hostTriple = targetArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
```

Use isolated source/build/install trees:

```js
const mediaRoot = path.join(desktop, '.tools', 'media');
const cacheDir = path.join(mediaRoot, targetArch);
const sourceDir = path.join(cacheDir, `ffmpeg-${FFMPEG_VERSION}`);
const sdl2SourceDir = path.join(cacheDir, `SDL2-${SDL2_VERSION}`);
const sdl2InstallDir = path.join(cacheDir, 'sdl2-install');
const stageDir = path.join(desktop, 'scope-extension', 'resources', 'bin', `darwin-${targetArch}`);
const licenseRoot = path.join(desktop, 'scope-extension', 'resources', 'licenses', 'ffmpeg');
const licenseDir = path.join(licenseRoot, `darwin-${targetArch}`);
```

Reuse the existing already-verified archive bytes from `.tools/media/` by
checking their pinned SHA then copying into the arch cache (if needed);
never trust a marker from the old in-source host build for the new target.
The current bounded download and safe extraction logic remains.

## Exact target compiler flags

Retain the existing shared SDL2 / static LGPL FFmpeg flags. Append these
FFmpeg flags and include their exact values in its configure marker:

```js
[
    '--enable-cross-compile',
    '--target-os=darwin',
    `--arch=${ffmpegArch}`,
    `--extra-cflags=-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    `--extra-ldflags=-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    ...(targetArch === 'x64' ? ['--disable-x86asm'] : []),
]
```

SDL2 flags append `--host=${hostTriple}`; environment:

```js
{
    ...buildEnv,
    CC: 'clang',
    CFLAGS: `-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    LDFLAGS: `-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
}
```

No inherited `CFLAGS`/`LDFLAGS` may select a different architecture.
`SDL2_CONFIG` and prepended PATH must refer to this architecture's install.
Markers use targetArch, deployment target, source hashes and actual flags,
never only process.arch.

## Slice staging and metadata

The existing dependency closure, `@loader_path` rewriting, fresh-inode
staging and ad-hoc signing remain. Verify every staged Mach-O has exactly
the intended target slice before merging (`lipo -archs`).

Source archives and source license text are shared at licenseRoot; per-target
BUILD-RECIPE/metadata go to licenseDir. Add `targetPlatform: darwin-${targetArch}`
while keeping buildPlatform as the actual host. Record actual flags and
per-file hashes. Metadata must distinguish a smoke test not executed on a
non-runnable architecture from a pass. Do not silently describe failed
playback as passed. The current dummy-driver limitation may be reported,
then actual GUI playback is checked separately.

Do not copy an absolute build-machine prefix into committed descriptions:
represent paths relative to desktop in recipe/metadata wherever possible.

## Universal parent flow

At entry to `main`, if universal:

1. `execFileSync(process.execPath, [__filename, '--arch', 'arm64'], ...)`.
2. Same for x64. Sequential; separate caches make resuming safe.
3. Read both per-target metadata records. Only merge the three known
   executables and the dylib basenames actually recorded by both records.
   Assert both dylib basename sets are identical; mismatch is fatal.
4. For each matching file, lipo the two thin staged files into a temporary
   file under `.tools/media/universal`. Verify architecture set is exactly
   arm64+x86_64, ad-hoc sign, and validate its dependency closure is still
   only system paths or recorded `@loader_path` siblings. Preserve thin
   input evidence before replacing destinations.
5. Stage every fat output via temp+rename into BOTH lookup directories.
   Do not touch nodu-device/nodu-terminal/nodu-resources or unrelated files.
6. Validate LC_BUILD_VERSION for BOTH slices (each <=15.0), not just the
   first `minos` match.
7. Write universal metadata at `licenses/ffmpeg/metadata.json`, recording
   per-target source metadata, architectures, final hashes, dylib closure,
   ad-hoc signing and runtime smoke outcomes.

Output must run from a copied standalone temporary directory with no
`.tools` or Homebrew files accessible through load paths.

## Standard build integration

In `desktop/package.json`:

```json
"build:electron": "npm run build:native && npm run build:media && npm run compile && npm run build --workspace @scope/electron-app"
```

Browser development keeps its existing chain. A missing media build must
fail the desktop build, not produce a supposedly complete app.

## Verification scope for this step

1. `node --check scripts/build-media.cjs`
2. `npm run build:media` on this Apple Silicon host.
3. `lipo -archs` and dependency/minOS checks for all three executables and
   every bundled dylib in both lookup dirs.
4. Explicit native/Rosetta executions (`arch -arm64` / `arch -x86_64`) of
   ffmpeg encode + ffprobe inspection using the existing smoke fixture.
5. Copy each lookup directory's media closure to a new temp directory and
   execute ffmpeg/ffprobe there; no source/cache paths in `otool -L`.
6. Run standard `npm run build:electron` ONCE after build-media succeeds;
   it should reuse cached media rather than rebuild both source trees.
7. Preserve build logs and return final diff. Don't alter acceptance
   statuses or claim a universal Electron application based solely on
   universal sidecars/media; app packaging is a distinct subsequent step.
