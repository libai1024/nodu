# Standalone Electron application packaging specification

Goal: build an actual standalone universal macOS `.app` and zip, not merely
universal sidecars. Also add a Windows x64 portable-package path that runs on
a Windows host once its media and native artifacts are ready.

## Fixed tool/input configuration

Add exact dev dependencies to desktop/package.json and update its lockfile:

```json
"@electron/packager": "20.3.0",
"@electron/universal": "3.0.6"
```

Node for isolated architecture builds is 24.21.0. These hashes were read by
the lead from official `https://nodejs.org/dist/v24.21.0/SHASUMS256.txt`:

```js
const NODE_VERSION = '24.21.0';
const NODE_DARWIN_SHA = {
  arm64: '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
  x64: '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299',
};
// URL: https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-<arch>.tar.xz
```

Use existing HTTPS/SHA/size-bound download patterns. Stage toolchains under
`.tools/package/node-<arch>`, verify SHA before extraction. Before extracting,
check tar entries stay within expected top-level folder; refuse links escaping
it. Do not change system Node. Run x64 Node on this Apple Silicon machine under
Rosetta; prepend its bin directory to child PATH so lifecycle scripts also
observe `process.arch === 'x64'`.

## Entry point

Create `desktop/scripts/packaged-entry.cjs`, copied to package root as
`main.cjs`. It starts the bundled `lib/backend/electron-main.js` directly,
without Theia CLI, npm, Cargo or a system Node installation.

Reuse `extractLauncherFlags` by copying the existing `launch.cjs` next to the
entry under `scripts/launch.cjs`; requiring it does not call its main().
Preserve original `-open_*_terminal`, timeout and `-update_resources` behavior:
extract from argv, set the same environment variables, then forward only the
remaining arguments.

Exact startup policy:

- Profile root defaults to `~/.scope-studio`; optional `NODU_PROFILE_DIR`
  must be absolute and is for isolated package testing.
- Set `THEIA_CONFIG_DIR=<profile>/config` and create it.
- Call Electron `app.setPath('userData', <profile>/electron)` BEFORE requiring
  generated electron-main, so its single-instance lock uses the right profile.
- Keep backend on `--hostname=127.0.0.1`, choose `--port=0` for packaged apps
  to avoid colliding with developer backends.
- Reject forwarded `--hostname`, `--port` or `--electronUserData` overrides,
  just as the developer launcher does.
- If no workspace argument is supplied, create/open `app.getPath('documents')/
  Nodu`; don't copy the current user's workspace or settings into the package.
- Support packaged argv offset (`app.isPackaged ? 1 : 2`).
- Set `process.argv` to executable/(dev app argument if applicable), workspace,
  remaining args and managed backend options, then require bundled main.
- Do not assign `ELECTRON_RUN_AS_NODE` in the GUI process. The outer packaging
  smoke launcher removes inherited ELECTRON_RUN_AS_NODE before launching.

## Build command and isolated architecture stages

Add `package:electron = node scripts/package-electron.cjs`.

CLI accepts `--arch universal|arm64|x64` and `--help`. Default on macOS is
universal, on Windows x64. Reject unsupported host/target combinations.
Do not attempt to package a Windows app out of macOS native addons.
No silent host-only fallback for a requested universal package.

Root normal `npm run build:electron` is already verified. Reuse populated
media/Cargo caches. Packaging must check sidecar/media/source-license inputs,
but must not run FFmpeg source builds again if they are current.

For macOS arm64 and x64, use independent source/build workspaces under
`.tools/package/work-<arch>/desktop`:

1. Copy current desktop sources/lockfile, including uncommitted intended
   changes. Exclude node_modules, .tools, native/target, transient logs,
   developer workspace `.theia` state, and application generated lib/src-gen.
   Keep already-staged `scope-extension/resources` (including WASM/media/
   licenses/sidecars) and source TS/CSS. Do not copy original user examples'
   local settings into the packaged runtime.
2. Use pinned target Node to run `npm ci` in that independent workspace.
   Its lifecycle scripts must use the target Node PATH. This prevents
   rebuilding the live development tree's native modules for the other CPU.
3. `npm run compile --workspace @scope/studio-extension` there (the WASM
   resources are copied from the already completed standard build).
4. Invoke that workspace's Theia CLI with target Node:
   `rebuild:electron --cacheRoot <work-desktop>`, then `build --mode production`
   in its electron-app directory.
5. Preserve install/build logs. Do not restart a live successful build
   merely because a handoff returns; report PID/log and reuse it.

Use a compiler-input+lockfile+target stamp to reuse a successful isolated build
on later invocations. Never reuse a failed/partial stage. A changed input
must invalidate the stage, not merely check that lib/frontend/index.html exists.
Compute the stamp as SHA-256 over sorted compiler-input relative paths plus
NUL, their exact bytes plus NUL, then JSON of targetArch, Node24.21.0,
Electron42.8.1 and the two pinned packager versions. Compiler inputs include
package manifests/lock, TS/JS/CSS sources, build scripts/config and
resources/imaging (embedded WASM). Exclude native Rust source/target,
resources/bin, resources/licenses and resources/nodu-resources: these are
runtime inputs, not inputs to the Theia JS build. Store the compiler stamp
only after a successful build; exclude stamps/outputs themselves.

Always assemble runtime resources from the CURRENT root resource tree at
packaging time and record their hashes separately. A sidecar or example
change refreshes the package resources without needlessly recompiling the
unchanged JS/frontend. The complete package manifest must include both the
compiler-input stamp and final runtime-resource hashes.

## Minimal packaged app input

Create app input per architecture under `.tools/package/app-<arch>` containing:

- compiled electron-app/lib (exclude source maps);
- `main.cjs` and `scripts/launch.cjs`;
- root MIT LICENSE and desktop/THIRD-PARTY-NOTICES.md;
- package.json with name `nodu-ide`, productName `见微 Nodu`, current application
  version, license MIT, main `main.cjs`, no runtime npm dependencies (Theia
  JS is bundled);
- `node_modules/@scope/studio-extension/package.json` and full resources
  needed by Nodu: examples, manifests/notices, WASM, applicable sidecar/media
  dirs and corresponding-source/license materials.

`createRequire(__filename).resolve('@scope/studio-extension/package.json')`
is the existing runtime seam; preserve it. Use `asar:false` so executable
paths remain real. Native Theia addons and rg/pty/shell integrations stay in
their compiled lib/backend locations.

If a standalone launch exposes a missing dynamic resource, report its exact
path before widening inclusion; do not copy the entire development
node_modules tree as a shortcut.

Packager options:

```js
{
  dir: appInput,
  name: 'Nodu',
  appBundleId: 'org.scope.studio',
  appVersion: applicationVersion,
  electronVersion: '42.8.1',
  platform: process.platform,
  arch: targetArch,
  asar: false,
  prune: false,
  overwrite: true,
  appCategoryType: 'public.app-category.developer-tools',
  darwinDarkModeSupport: true,
  extendInfo: process.platform === 'darwin' ? { LSMinimumSystemVersion: '15.0' } : undefined,
  out: path.join(desktop, '.tools', 'package', 'thin'),
  icon: process.platform === 'darwin'
      ? path.join(repo, 'brand', 'assets', 'Nodu.icns')
      : path.join(repo, 'brand', 'assets', 'Nodu.ico'),
}
```

Use @electron/universal.makeUniversalApp to merge the two `.app` outputs
with `mergeASARs:false`, output `desktop/dist/Nodu.app`. If ordinary bundled
JS differs between architectures, inspect the difference and report it;
do not blanket-ignore differences or copy one architecture's native addons
into both. Architecture-specific Mach-O files must merge or remain in
correct architecture lookup paths.

For Windows x64 (on a Windows host), package its own native app inputs into
`desktop/dist/Nodu-win32-x64` and make a portable zip. Missing `.exe` media/
native tools must fail validation. No installer/signing claims.

## Signing/output

macOS local artifact uses ad-hoc signing, with a committed packaging
entitlements plist containing only:

```xml
<dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
</dict>
```

Sign merged nested executable/addon/framework code and the app (preserve
needed Electron helper entitlements); verify `codesign --verify --deep
--strict`. Do not publish/notarize or request credentials for this local
artifact. Clearly record ad-hoc vs Developer ID/notarization in build metadata.

Create `desktop/dist/Nodu-<version>-mac-universal.zip` using ditto and record
SHA-256 and source version in a local manifest. Add dist/ to desktop/.gitignore.
No need for a DMG or NSIS in this step; a standalone app/portable zip is the
concrete deliverable.

## Required package verification

Launch the STANDALONE app under an isolated NODU_PROFILE_DIR, with no repo
cwd or PATH dependency. Keep the existing developer apps untouched. Capture:

- application window/frontend ready;
- actual package architecture (native arm64 and Rosetta x64 launch);
- device list (read-only; no board connection until lead allows);
- examples available from packaged resources;
- packaged nodu-resources executable and media conversion accessible;
- `-update_resources` accepted without dev CLI dependencies;
- no load failure for lib/backend native modules.

Stop only the isolated test app afterward; leave main developer runtime up.
Never label media/sidecar architecture checks as whole-app verification.
Return complete diff and concrete artifact path before any commit.
