// SPDX-License-Identifier: MIT
// Build ffmpeg/ffprobe/ffplay from the pinned official FFmpeg source with an
// LGPL-only configuration and stage them, plus their non-system dylibs, into
// scope-extension/resources/bin/darwin-<arch>/ (generated output, gitignored).
// Licenses, the exact source tarball and the build recipe are staged under
// scope-extension/resources/licenses/ffmpeg/ so the binaries can be rebuilt.
// macOS host only: no arguments builds both thin slices (arm64 + x64) and
// merges them into universal Mach-O files staged under both lookup dirs;
// `--arch arm64|x64` builds a single thin slice. Windows/Linux bundling is a
// subsequent step and is not silently omitted.
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

// Windows delegates to the dedicated MSYS2 recipe before this file parses
// its own arguments: --arch/--help and every other flag are forwarded
// verbatim and the child exit status becomes ours — media is never
// silently skipped on win32.
if (require.main === module && process.platform === 'win32') {
    const child = spawnSync(process.execPath,
        [path.join(__dirname, 'build-media-windows.cjs'),
            ...process.argv.slice(2)],
        { stdio: 'inherit' });
    if (child.error) {
        console.error(`build-media: cannot start Windows build: ${child.error.message}`);
        process.exit(1);
    }
    process.exit(child.status === null ? 1 : child.status);
}

const USAGE = `build-media: bundled media tool build (FFmpeg + SDL2, LGPL-only).
Usage: node scripts/build-media.cjs [--arch arm64|x64]
  (no --arch)   macOS only: build both slices, lipo them into universal
                binaries, stage under resources/bin/darwin-arm64 AND darwin-x64.
  --arch arm64  build only the arm64 (aarch64) slice.
  --arch x64    build only the x64 (x86_64) slice.
  --help        show this text without building.`;

let parsed;
try {
    parsed = parseArgs({
        options: {
            arch: { type: 'string' },
            help: { type: 'boolean' },
        },
        allowPositionals: false,
        strict: true,
    });
} catch (error) {
    console.error(`build-media: ${error.message}\n${USAGE}`);
    process.exit(1);
}
if (parsed.values.help) {
    console.log(USAGE);
    process.exit(0);
}

if (process.platform !== 'darwin') {
    console.error(
        `build-media: this build recipe is not available on ${process.platform}; ` +
        'supported hosts are macOS (darwin) and Windows (win32, delegated to scripts/build-media-windows.cjs).');
    process.exit(1);
}

const FFMPEG_VERSION = '9.0.2';
const SOURCE_URL = `https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz`;
const SOURCE_SHA256 = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e';
// Real SDL2 from the pinned upstream release; the previous Homebrew
// sdl2-compat/SDL3 bottles targeted macOS 26 and blocked any minOS claim.
const SDL2_VERSION = '2.32.10';
const SDL2_URL = `https://github.com/libsdl-org/SDL/releases/download/release-${SDL2_VERSION}/SDL2-${SDL2_VERSION}.tar.gz`;
const SDL2_SHA256 = '5f5993c530f084535c65a6879e9b26ad441169b3e25d789d83287040a9ca5165';
const SDL2_CONFIGURE_FLAGS = [
    '--enable-shared',
    '--disable-static',
    '--disable-video-x11',
    '--disable-video-wayland',
    '--disable-pulseaudio',
    '--disable-alsa',
    '--disable-jack',
    '--disable-libsamplerate',
];
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const CONFIGURE_FLAGS = [
    '--disable-autodetect',
    '--disable-gpl',
    '--disable-nonfree',
    '--disable-version3',
    '--disable-doc',
    '--disable-debug',
    '--disable-network',
    '--enable-ffplay',
    '--enable-sdl2',
    '--enable-pthreads',
    '--enable-small',
    '--enable-static',
    '--disable-shared',
    '--cc=clang',
];

const desktop = path.resolve(__dirname, '..');

const targetArch = parsed.values.arch || process.arch;
// Universal mode: no --arch on Darwin builds both slices then merges.
const universal = !parsed.values.arch;
if (!['arm64', 'x64'].includes(targetArch)) {
    failEarly(`unsupported media architecture: ${parsed.values.arch}`);
}
const machArch = targetArch === 'arm64' ? 'arm64' : 'x86_64';
const ffmpegArch = targetArch === 'arm64' ? 'aarch64' : 'x86_64';
const hostTriple = targetArch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';

// Per-architecture source/build/install trees: an x64 object must never be
// confused with an arm64 one because they shared a cache directory.
const mediaRoot = path.join(desktop, '.tools', 'media');
const cacheDir = path.join(mediaRoot, targetArch);
const sourceDir = path.join(cacheDir, `ffmpeg-${FFMPEG_VERSION}`);
const sdl2SourceDir = path.join(cacheDir, `SDL2-${SDL2_VERSION}`);
const sdl2InstallDir = path.join(cacheDir, 'sdl2-install');
const sdl2LibDir = path.join(sdl2InstallDir, 'lib');
const stageDir = path.join(
    desktop, 'scope-extension', 'resources', 'bin', `darwin-${targetArch}`);
const licenseRoot = path.join(
    desktop, 'scope-extension', 'resources', 'licenses', 'ffmpeg');
const licenseDir = path.join(licenseRoot, `darwin-${targetArch}`);
const archivePath = path.join(cacheDir, `ffmpeg-${FFMPEG_VERSION}.tar.xz`);
const sdl2ArchivePath = path.join(cacheDir, `SDL2-${SDL2_VERSION}.tar.gz`);
const universalDir = path.join(mediaRoot, 'universal');
// Archives already verified in the legacy shared cache are reusable: the
// pinned SHA is re-checked and the bytes copied into the arch cache.
const legacyArchives = [
    [SOURCE_URL, SOURCE_SHA256, path.join(mediaRoot, `ffmpeg-${FFMPEG_VERSION}.tar.xz`), archivePath],
    [SDL2_URL, SDL2_SHA256, path.join(mediaRoot, `SDL2-${SDL2_VERSION}.tar.gz`), sdl2ArchivePath],
];

const MIN_OS_TARGET = '15.0';

// Target-selection flags appended to the FFmpeg configure line; the exact
// values land in the configure marker so a different arch never reuses a tree.
const FFMPEG_TARGET_FLAGS = [
    '--enable-cross-compile',
    '--target-os=darwin',
    `--arch=${ffmpegArch}`,
    `--extra-cflags=-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    `--extra-ldflags=-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    // No NASM on this host; x86 assembly is optional anyway.
    ...(targetArch === 'x64' ? ['--disable-x86asm'] : []),
];
const EFFECTIVE_CONFIGURE_FLAGS = [...CONFIGURE_FLAGS, ...FFMPEG_TARGET_FLAGS];
const EFFECTIVE_SDL2_FLAGS = [...SDL2_CONFIGURE_FLAGS, `--host=${hostTriple}`];

const pathKey =
    Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
// FFmpeg configure picks up SDL2 via sdl2-config on PATH / SDL2_CONFIG.
const buildEnv = {
    ...process.env,
    [pathKey]: [path.join(sdl2InstallDir, 'bin'), process.env[pathKey] || '']
        .join(path.delimiter),
    SDL2_CONFIG: path.join(sdl2InstallDir, 'bin', 'sdl2-config'),
    // Without this the executables target the host OS (minos 26.0 here).
    MACOSX_DEPLOYMENT_TARGET: MIN_OS_TARGET,
};
// SDL2 is configured separately and needs the deployment target and target
// architecture in both the driver env var and explicit compile/link flags;
// no inherited CFLAGS/LDFLAGS may select a different architecture.
const sdl2BuildEnv = {
    ...buildEnv,
    CC: 'clang',
    CFLAGS: `-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
    LDFLAGS: `-arch ${machArch} -mmacosx-version-min=${MIN_OS_TARGET}`,
};

// Paths written into staged license/metadata files stay relative to the
// desktop tree so committed descriptions carry no build-machine prefix.
function rel(file) {
    return path.relative(desktop, file);
}

// LC_BUILD_VERSION `minos` values of a Mach-O file via vtool (otool -l
// fallback). A fat file reports one record per slice — return them all.
function readMinOsAll(file) {
    let out;
    try {
        out = execFileSync('xcrun', ['vtool', '-show-build', file],
            { encoding: 'utf8' });
    } catch {
        out = execFileSync('otool', ['-l', file], { encoding: 'utf8' });
    }
    const found = [...out.matchAll(/minos\s+([0-9.]+)/g)].map(m => m[1]);
    if (found.length > 0) {
        return found;
    }
    // Older binaries carry LC_VERSION_MIN_MACOSX ("version X.Y") instead.
    const legacy = [...out.matchAll(/LC_VERSION_MIN_MACOSX[\s\S]*?version\s+([0-9.]+)/g)]
        .map(m => m[1]);
    return legacy.length > 0 ? legacy : ['unknown'];
}
function readMinOs(file) {
    return readMinOsAll(file)[0];
}

// `lipo -archs` output as a normalized set of architecture names.
function lipoArchs(file) {
    const out = execFileSync('lipo', ['-archs', file], { encoding: 'utf8' });
    return out.trim().split(/\s+/).filter(Boolean).sort();
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function failEarly(message) {
    console.error(`build-media: ${message}`);
    process.exit(1);
}
const fail = failEarly;

async function download(url, destination) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const response = await fetch(current, {
            redirect: 'manual',
            signal: AbortSignal.timeout(120000),
        });
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            response.body?.cancel().catch(() => {});
            if (!location) {
                fail(`download redirect from ${current} has no Location header`);
            }
            const next = new URL(location, current);
            if (next.protocol !== 'https:') {
                fail(`download redirect to non-HTTPS URL refused: ${next}`);
            }
            current = next.toString();
            continue;
        }
        if (!response.ok) {
            fail(`download failed: HTTP ${response.status} from ${current}`);
        }
        const chunks = [];
        let total = 0;
        for await (const chunk of response.body) {
            total += chunk.length;
            if (total > MAX_DOWNLOAD_BYTES) {
                fail(`download exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
            }
            chunks.push(chunk);
        }
        fs.writeFileSync(destination, Buffer.concat(chunks));
        console.log(`build-media: downloaded ${total} bytes from ${current}`);
        return;
    }
    fail(`download exceeded ${MAX_REDIRECTS} redirects`);
}

async function fetchArchive(url, sha, destination, legacySource) {
    // Reuse the already-verified archive bytes from the legacy shared cache:
    // check the pinned SHA of the legacy file, then copy it into the arch
    // cache. A legacy marker or a host-era build tree is never trusted.
    if (!fs.existsSync(destination) && legacySource && fs.existsSync(legacySource)) {
        if (sha256File(legacySource) === sha) {
            fs.copyFileSync(legacySource, destination);
            console.log(`build-media: reused verified archive ${path.basename(legacySource)} from shared cache`);
        }
    }
    if (fs.existsSync(destination)) {
        if (sha256File(destination) === sha) {
            console.log(`build-media: reusing verified archive ${path.basename(destination)}`);
            return;
        }
        console.log(`build-media: cached archive checksum mismatch, re-downloading ${path.basename(destination)}`);
        fs.rmSync(destination);
    }
    await download(url, destination);
    const actual = sha256File(destination);
    if (actual !== sha) {
        fs.rmSync(destination);
        fail(`archive SHA256 ${actual} does not match pinned ${sha} for ${url}`);
    }
    console.log(`build-media: archive SHA256 verified ${actual}`);
}

const tarFlag = archive =>
    archive.endsWith('.tar.xz') || archive.endsWith('.txz') ? 'J'
        : archive.endsWith('.tar.gz') || archive.endsWith('.tgz') ? 'z' : null;

function extractArchive(archive, topLevel) {
    const flag = tarFlag(archive);
    if (!flag) {
        fail(`unsupported archive format: ${archive}`);
    }
    const listing = execFileSync('tar', [`-t${flag}f`, archive], { encoding: 'utf8' });
    const entries = listing.split('\n').filter(Boolean);
    for (const entry of entries) {
        const normalized = entry.replace(/^\.\//, '');
        if (path.isAbsolute(normalized) || normalized.startsWith('/')) {
            fail(`archive entry is an absolute path: ${entry}`);
        }
        if (normalized.split('/').includes('..')) {
            fail(`archive entry escapes the cache directory: ${entry}`);
        }
        if (normalized !== topLevel.slice(0, -1)
            && !normalized.startsWith(topLevel)) {
            fail(`archive entry outside expected ${topLevel}: ${entry}`);
        }
    }
    const into = path.join(cacheDir, topLevel.slice(0, -1));
    if (fs.existsSync(into)) {
        console.log(`build-media: reusing extracted source tree ${topLevel}`);
        return;
    }
    execFileSync('tar', [`-x${flag}f`, archive, '-C', cacheDir], { stdio: 'inherit' });
    if (!fs.existsSync(path.join(into, 'configure'))) {
        fail(`expected ${into}/configure after extraction`);
    }
    console.log(`build-media: extracted ${entries.length} entries into ${topLevel}`);
}

// SDL2 is built once per architecture into a private prefix inside that
// arch's media cache; FFmpeg's configure then uses that install's
// sdl2-config via PATH/SDL2_CONFIG.
function buildSdl2() {
    const markerPath = path.join(sdl2InstallDir, '.nodu-sdl2-marker');
    const marker = [
        SDL2_SHA256, targetArch, machArch, MIN_OS_TARGET,
        EFFECTIVE_SDL2_FLAGS.join(' '),
        `CFLAGS=${sdl2BuildEnv.CFLAGS}`,
        `LDFLAGS=${sdl2BuildEnv.LDFLAGS}`,
    ].join('\n');
    const installed = path.join(sdl2InstallDir, 'bin', 'sdl2-config');
    if (fs.existsSync(installed) && fs.existsSync(markerPath)
        && fs.readFileSync(markerPath, 'utf8') === marker) {
        console.log('build-media: reusing SDL2 install');
        return;
    }
    const jobs = Math.max(1, Math.min(os.cpus().length, 8));
    console.log(`build-media: SDL2 configure --prefix=${sdl2InstallDir} ${EFFECTIVE_SDL2_FLAGS.join(' ')}`);
    execFileSync(path.join(sdl2SourceDir, 'configure'),
        [`--prefix=${sdl2InstallDir}`, ...EFFECTIVE_SDL2_FLAGS], {
            cwd: sdl2SourceDir, stdio: 'inherit', env: sdl2BuildEnv,
        });
    console.log(`build-media: SDL2 make -j${jobs}`);
    execFileSync('make', [`-j${jobs}`], {
        cwd: sdl2SourceDir, stdio: 'inherit', env: sdl2BuildEnv,
    });
    execFileSync('make', ['install'], {
        cwd: sdl2SourceDir, stdio: 'inherit', env: sdl2BuildEnv,
    });
    fs.writeFileSync(markerPath, marker);
}

function runConfigure() {
    const markerPath = path.join(sourceDir, '.nodu-configure-marker');
    const marker = [
        SOURCE_SHA256,
        SDL2_SHA256,
        targetArch,
        `MACOSX_DEPLOYMENT_TARGET=${buildEnv.MACOSX_DEPLOYMENT_TARGET}`,
        EFFECTIVE_SDL2_FLAGS.join(' '),
        EFFECTIVE_CONFIGURE_FLAGS.join(' '),
    ].join('\n');
    const builtBinary = path.join(sourceDir, 'ffmpeg');
    if (fs.existsSync(builtBinary) && fs.existsSync(markerPath)
        && fs.readFileSync(markerPath, 'utf8') === marker) {
        console.log('build-media: reusing existing build tree');
        return false;
    }
    // The marker pins build inputs (source/target arch/target/SDL versions);
    // when it differs the existing objects may embed a different deployment
    // target, so clean before reconfiguring rather than relinking stale bits.
    try {
        execFileSync('make', ['clean'], { cwd: sourceDir, env: buildEnv });
    } catch { /* no Makefile yet */ }
    console.log('build-media: configure ' + EFFECTIVE_CONFIGURE_FLAGS.join(' '));
    execFileSync(path.join(sourceDir, 'configure'), EFFECTIVE_CONFIGURE_FLAGS, {
        cwd: sourceDir, stdio: 'inherit', env: buildEnv,
    });
    fs.writeFileSync(markerPath, marker);
    return true;
}

function runMake() {
    const jobs = Math.max(1, Math.min(os.cpus().length, 8));
    console.log(`build-media: make -j${jobs}`);
    execFileSync('make', [`-j${jobs}`], {
        cwd: sourceDir, stdio: 'inherit', env: buildEnv,
    });
}

function otoolDeps(file) {
    const output = execFileSync('otool', ['-L', file], { encoding: 'utf8' });
    const deps = [];
    for (const line of output.split('\n').slice(1)) {
        const match = line.trim().match(/^(\S+)\s+\(/);
        if (match) {
            deps.push(match[1]);
        }
    }
    return deps;
}

function isSystemDep(dep) {
    return dep.startsWith('/usr/lib/') || dep.startsWith('/System/');
}

// A recorded dependency resolves to a candidate path: absolute deps directly,
// @rpath deps against the SDL2 install lib dir. Anything else is refused.
function depCandidate(dep) {
    if (dep.startsWith('@rpath/')) {
        return path.join(sdl2LibDir, dep.slice('@rpath/'.length));
    }
    if (dep.startsWith('@')) {
        fail(`dependency ${dep} uses an unsupported @-prefix`);
    }
    return dep;
}

function isAllowedDep(candidate) {
    if (!fs.existsSync(candidate)) {
        return false;
    }
    const resolved = fs.realpathSync(candidate);
    return resolved === path.join(sdl2LibDir, path.basename(candidate))
        || resolved.startsWith(fs.realpathSync(sdl2LibDir) + path.sep);
}

// Collect the transitive closure of non-system dylibs across the staged
// files. Only dylibs from the verified SDL2 install are bundled; any other
// absolute dependency aborts the build. Returns staged base -> {source, resolved}.
function collectDylibs(binaries, collected = new Map()) {
    const queue = [...binaries];
    const seen = new Set();
    while (queue.length > 0) {
        const file = queue.shift();
        if (seen.has(file)) {
            continue;
        }
        seen.add(file);
        for (const dep of otoolDeps(file)) {
            if (isSystemDep(dep) || dep === file) {
                continue;
            }
            const candidate = depCandidate(dep);
            // A dylib's own install name shows up as its first entry.
            if (fs.existsSync(candidate) && fs.realpathSync(candidate) === file) {
                continue;
            }
            if (!isAllowedDep(candidate)) {
                fail(`dependency ${dep} of ${file} is outside the SDL2 install prefix; refusing to bundle`);
            }
            const resolved = fs.realpathSync(candidate);
            const base = path.basename(resolved);
            const existing = collected.get(base);
            if (existing && existing.resolved !== resolved) {
                fail(`dylib basename collision: ${dep} vs ${existing.source}`);
            }
            if (!existing) {
                collected.set(base, { source: dep, resolved });
                queue.push(resolved);
            }
        }
    }
    return collected;
}

// Overwriting a code-signed binary in place keeps a stale provenance record
// and the kernel kills the next exec/mmap; stage via temp + rename instead.
function stageCopy(source, target) {
    const tmp = `${target}.tmp-${process.pid}`;
    fs.copyFileSync(source, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, target);
}

function stage() {
    fs.mkdirSync(stageDir, { recursive: true });
    // Leftover artifacts from the old sdl2-compat/SDL3 bundle must not ship.
    for (const stale of ['libSDL3.dylib']) {
        fs.rmSync(path.join(stageDir, stale), { force: true });
    }
    const binaries = ['ffmpeg', 'ffprobe', 'ffplay'].map(name => {
        const built = path.join(sourceDir, name);
        if (!fs.existsSync(built)) {
            fail(`expected ${built} after make`);
        }
        const target = path.join(stageDir, name);
        stageCopy(built, target);
        return target;
    });

    const dylibs = collectDylibs(binaries);
    const stagedLibs = new Map();
    for (const [base, info] of dylibs) {
        stageCopy(info.resolved, path.join(stageDir, base));
        stagedLibs.set(info.source, base);
        if (info.resolved !== info.source) {
            stagedLibs.set(info.resolved, base);
        }
        const installId = otoolDeps(info.resolved)[0];
        if (installId && (installId.startsWith('/') || installId.startsWith('@rpath/'))) {
            stagedLibs.set(installId, base);
        }
    }

    const staged = [...new Set([...binaries, ...[...stagedLibs.values()]
        .map(base => path.join(stageDir, base))])];
    for (const file of staged) {
        for (const dep of otoolDeps(file)) {
            if (isSystemDep(dep)) {
                continue;
            }
            if (dep.startsWith('@rpath/')) {
                const base = stagedLibs.get(dep);
                if (!base) {
                    fail(`unbundled @rpath dependency ${dep} in ${file}`);
                }
                execFileSync('install_name_tool', [
                    '-change', dep, `@loader_path/${base}`, file]);
            } else if (!dep.startsWith('@')) {
                const base = stagedLibs.get(dep)
                    || (fs.existsSync(dep) && stagedLibs.get(fs.realpathSync(dep)));
                if (!base) {
                    fail(`unexpected unbundled dependency ${dep} in ${file}`);
                }
                execFileSync('install_name_tool', [
                    '-change', dep, `@loader_path/${base}`, file]);
            }
        }
        // Fix the install name of staged dylibs so they resolve in place.
        if (file.endsWith('.dylib')) {
            execFileSync('install_name_tool', [
                '-id', `@loader_path/${path.basename(file)}`, file]);
        }
    }
    // install_name_tool invalidates the copied signatures; re-sign ad hoc.
    for (const file of staged) {
        execFileSync('codesign', ['-s', '-', '-f', file]);
    }
    // Every staged Mach-O must carry exactly the requested target slice —
    // a wrong-arch thin file would silently corrupt a later universal merge.
    for (const file of staged) {
        const archs = lipoArchs(file);
        if (archs.length !== 1 || archs[0] !== machArch) {
            fail(`${path.basename(file)} has slices [${archs.join(' ')}], expected exactly ${machArch}`);
        }
    }
    return { binaries, dylibs: stagedLibs };
}

// `arch -<slice>` prefixes non-native executions so a foreign-arch slice is
// exercised under Rosetta where available instead of merely claimed passed.
function archRunner() {
    return process.arch === targetArch ? [] : [`-${machArch}`];
}

function runBinary(binary, args, options = {}) {
    if (process.arch === targetArch) {
        return execFileSync(binary, args, options);
    }
    return execFileSync('arch', [...archRunner(), binary, ...args], options);
}

function validateBinaries(binaries) {
    for (const binary of binaries) {
        for (const flag of ['-version', '-buildconf', '-L']) {
            let output;
            try {
                output = runBinary(binary, [flag], {
                    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
                    // A broken SDL dylib pops a modal dialog instead of
                    // exiting; the timeout turns that into a failure.
                    timeout: 30000,
                });
            } catch (error) {
                fail(`${path.basename(binary)} ${flag} failed: ${error.message}`);
            }
            const forbidden = ['--enable-gpl', '--enable-nonfree', '--enable-version3'];
            for (const bad of forbidden) {
                if (output.includes(bad)) {
                    fail(`${path.basename(binary)} ${flag} reports forbidden flag ${bad}`);
                }
            }
            // -L wraps "GNU Lesser General Public\nLicense" across lines.
            if (flag === '-L'
                && !/GNU\s+Lesser\s+General\s+Public\s+License|LGPL/i.test(output)) {
                fail(`${path.basename(binary)} -L does not report an LGPL license`);
            }
        }
    }
    console.log('build-media: -version/-buildconf/-L checks passed on all executables');
}

function validateDependencies(stagedFiles) {
    // An @loader_path reference must resolve to a real sibling whose
    // basename is part of the recorded staged closure; subdirs and
    // traversal do not count as siblings.
    const stagedBasenames = new Set(stagedFiles.map(file => path.basename(file)));
    for (const file of stagedFiles) {
        for (const dep of otoolDeps(file)) {
            if (isSystemDep(dep) || dep === file) {
                continue;
            }
            const ok = dep.startsWith('@loader_path/')
                && path.basename(dep.slice('@loader_path/'.length))
                    === dep.slice('@loader_path/'.length)
                && stagedBasenames.has(dep.slice('@loader_path/'.length))
                && fs.existsSync(path.join(
                    path.dirname(file), dep.slice('@loader_path/'.length)));
            if (!ok) {
                fail(`${path.basename(file)} has unexpected dependency ${dep}`);
            }
        }
    }
    console.log('build-media: dependency check passed (only system and recorded @loader_path siblings remain)');
}

function stageLicenses() {
    fs.mkdirSync(licenseRoot, { recursive: true });
    fs.mkdirSync(licenseDir, { recursive: true });
    // The compat/SDL3 inventory is gone with the toolchain that needed it.
    for (const stale of ['sdl2-compat-LICENSE.txt', 'sdl3-LICENSE.txt']) {
        fs.rmSync(path.join(licenseRoot, stale), { force: true });
    }
    // License text and source archives are shared across slices; they live
    // at the license root while per-target recipe/metadata stay in the
    // darwin-<arch> subdirectory.
    const copies = [
        [path.join(sdl2SourceDir, 'LICENSE.txt'), 'sdl2-LICENSE.txt'],
        [path.join(sourceDir, 'COPYING.LGPLv2.1'), 'ffmpeg-COPYING.LGPLv2.1.txt'],
        [archivePath, path.basename(archivePath)],
        [sdl2ArchivePath, path.basename(sdl2ArchivePath)],
    ];
    for (const [from, to] of copies) {
        if (!fs.existsSync(from)) {
            fail(`license/source file missing: ${from}`);
        }
        fs.copyFileSync(from, path.join(licenseRoot, to));
    }
    fs.copyFileSync(__filename,
        path.join(licenseRoot, 'build-media.cjs'));
    fs.writeFileSync(path.join(licenseDir, 'BUILD-RECIPE.txt'), [
        `FFmpeg bundled build recipe (macOS host, target darwin-${targetArch})`,
        `ffmpeg source: ${SOURCE_URL}`,
        `ffmpeg sha256: ${SOURCE_SHA256}`,
        `sdl2 source: ${SDL2_URL}`,
        `sdl2 sha256: ${SDL2_SHA256}`,
        `sdl2 configure: --prefix=${rel(sdl2InstallDir)} ${EFFECTIVE_SDL2_FLAGS.join(' ')}`,
        `sdl2 env: MACOSX_DEPLOYMENT_TARGET=${MIN_OS_TARGET} `
            + `CFLAGS=${sdl2BuildEnv.CFLAGS} `
            + `LDFLAGS=${sdl2BuildEnv.LDFLAGS}`,
        'sdl2 make -j<N> (bounded host CPUs, max 8) && make install',
        `SDL2_CONFIG: ${rel(buildEnv.SDL2_CONFIG)}`,
        `PATH prepend: ${rel(path.join(sdl2InstallDir, 'bin'))}`,
        `MACOSX_DEPLOYMENT_TARGET: ${buildEnv.MACOSX_DEPLOYMENT_TARGET}`,
        'ffmpeg configure flags:',
        ...EFFECTIVE_CONFIGURE_FLAGS.map(flag => `  ${flag}`),
        'make -j<N> (bounded host CPUs, max 8)',
        'dylibs discovered with otool -L (absolute or @rpath refs resolved',
        'against the SDL2 install), copied beside the executables via',
        'temp+rename (fresh inode) and rewritten to @loader_path/<basename>',
        'with install_name_tool, then ad-hoc re-signed `codesign -s - -f`.',
        'The complete procedure is scripted in build-media.cjs alongside this',
        'file; run `npm run build:media` from desktop/.',
        '',
    ].join('\n'));
}

function writeMetadata(binaries, stagedLibs, smoke, stagedFiles) {
    const minOs = {};
    for (const file of stagedFiles) {
        minOs[path.basename(file)] = readMinOs(file);
    }
    const metadata = {
        version: FFMPEG_VERSION,
        targetPlatform: `darwin-${targetArch}`,
        source: {
            url: SOURCE_URL,
            sha256: SOURCE_SHA256,
            archive: `ffmpeg-${FFMPEG_VERSION}.tar.xz`,
        },
        sdl2: {
            version: SDL2_VERSION,
            url: SDL2_URL,
            sha256: SDL2_SHA256,
            archive: `SDL2-${SDL2_VERSION}.tar.gz`,
            configureFlags: EFFECTIVE_SDL2_FLAGS,
        },
        configureFlags: EFFECTIVE_CONFIGURE_FLAGS,
        buildPlatform: `${process.platform}-${process.arch}`,
        deploymentTarget: MIN_OS_TARGET,
        stagedMinOs: minOs,
        stagedSlices: Object.fromEntries(stagedFiles.map(file => [
            path.basename(file), lipoArchs(file)])),
        buildHost: {
            osRelease: os.release(),
        },
        staged: {
            executables: Object.fromEntries(binaries.map(binary => [
                path.basename(binary), sha256File(binary)])),
            dylibs: [...stagedLibs.entries()].map(([source, base]) => ({
                // `source` is the recorded dependency reference — either an
                // @rpath name (kept verbatim) or an absolute build path that
                // is normalized relative to the desktop tree.
                source: path.isAbsolute(source) ? rel(source) : source,
                file: base, sha256: sha256File(path.join(stageDir, base)),
            })).filter((entry, index, list) =>
                list.findIndex(other => other.file === entry.file) === index),
        },
        signing: 'ad-hoc (codesign -s -); no release signing or notarization',
        smoke,
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
        path.join(licenseDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2) + '\n');
}

function smokeTest(ffmpeg, ffprobe, ffplay) {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), `nodu-media-smoke-${targetArch}-`));
    const mp4 = path.join(work, 'smoke.mp4');
    const result = {
        target: `darwin-${targetArch}`,
        executed: false,
        encode: null,
        probe: null,
        ffplay: null,
    };
    // A foreign-arch slice only runs under Rosetta; record "not executed"
    // rather than pretending a spawn failure was a passed playback test.
    if (!targetRunnable()) {
        result.reason = 'not executed: target slice is not runnable on this host without Rosetta';
        return result;
    }
    try {
        // Once the target is runnable an encoder failure is a build
        // failure, not a skipped test.
        result.executed = true;
        runBinary(ffmpeg, [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10',
            '-t', '1', '-c:v', 'mpeg4', mp4,
        ]);
        result.encode = `ok: ${fs.statSync(mp4).size} bytes`;
        const probe = JSON.parse(runBinary(ffprobe, [
            '-hide_banner', '-loglevel', 'error',
            '-print_format', 'json', '-show_streams', mp4,
        ], { encoding: 'utf8' }));
        const video = (probe.streams || []).find(stream => stream.codec_type === 'video');
        if (!video || video.codec_name !== 'mpeg4') {
            fail(`ffprobe found no mpeg4 video stream: ${JSON.stringify(video)}`);
        }
        result.probe = `ok: ${video.codec_name} ${video.width}x${video.height}`;
        try {
            runBinary(ffplay, [
                '-hide_banner', '-loglevel', 'error', '-autoexit', mp4,
            ], {
                env: {
                    ...process.env,
                    SDL_VIDEODRIVER: 'dummy',
                    SDL_AUDIODRIVER: 'dummy',
                },
                timeout: 30000,
            });
            result.ffplay = 'ok: dummy drivers, -autoexit';
        } catch (error) {
            result.ffplay = `unsupported: dummy-driver playback failed (${error.message.split('\n')[0]}); version/dependency validation only`;
        }
    } finally {
        console.log(`build-media: smoke artifacts in ${work}`);
    }
    return result;
}

// Can this host execute the target slice at all? Native targets are always
// runnable; foreign slices need `arch -<slice> /usr/bin/true` to succeed
// (Rosetta x86_64 on arm64, or an arm64-capable host when Node itself runs
// translated).
function targetRunnable() {
    if (process.arch === targetArch) {
        return true;
    }
    try {
        execFileSync('arch', [`-${machArch}`, '/usr/bin/true'], { timeout: 15000 });
        return true;
    } catch {
        return false;
    }
}

async function buildSlice() {
    fs.mkdirSync(cacheDir, { recursive: true });
    for (const [url, sha, legacy, destination] of legacyArchives) {
        await fetchArchive(url, sha, destination, legacy);
    }
    extractArchive(archivePath, `ffmpeg-${FFMPEG_VERSION}/`);
    extractArchive(sdl2ArchivePath, `SDL2-${SDL2_VERSION}/`);
    buildSdl2();
    const configured = runConfigure();
    if (configured || !fs.existsSync(path.join(sourceDir, 'ffplay'))) {
        runMake();
    }
    const { binaries, dylibs } = stage();
    const runnable = targetRunnable();
    if (!runnable) {
        console.log(`build-media: darwin-${targetArch} slice is not runnable on this host; `
            + 'skipping binary execution checks (recorded as not-executed)');
    }
    if (runnable) {
        validateBinaries(binaries);
    }
    const stagedFiles = [...new Set([...binaries,
        ...[...new Set(dylibs.values())].map(base => path.join(stageDir, base))])];
    validateDependencies(stagedFiles);
    stageLicenses();
    const smoke = smokeTest(
        path.join(stageDir, 'ffmpeg'),
        path.join(stageDir, 'ffprobe'),
        path.join(stageDir, 'ffplay'));
    writeMetadata(binaries, dylibs, smoke, stagedFiles);
    // Every staged file must honour the declared deployment target; all deps
    // are built from pinned source so >target is a build defect, not a warning.
    for (const file of stagedFiles) {
        const minOs = readMinOs(file);
        console.log(`build-media: ${path.basename(file)} minos=${minOs}`);
        if (minOs === 'unknown' || parseFloat(minOs) > parseFloat(MIN_OS_TARGET)) {
            fail(`${path.basename(file)} minos ${minOs} does not satisfy <= ${MIN_OS_TARGET}`);
        }
    }
    console.log(`build-media: staged ${binaries.length} executables and `
        + `${new Set(dylibs.values()).size} dylibs into `
        + rel(stageDir));
    console.log(`build-media: smoke encode=${smoke.encode} probe=${smoke.probe} ffplay=${smoke.ffplay}`);
}

// lipo two thin staged files into a universal binary inside the shared
// .tools/media/universal scratch dir, verify the slice set is exactly
// {arm64, x86_64}, re-sign ad hoc and re-check the dependency closure.
function mergeUniversal(name, arm64File, x64File) {
    fs.mkdirSync(universalDir, { recursive: true });
    const merged = path.join(universalDir, name);
    const tmp = `${merged}.tmp-${process.pid}`;
    execFileSync('lipo', ['-create', '-output', tmp, arm64File, x64File]);
    const archs = lipoArchs(tmp);
    if (archs.join(' ') !== 'arm64 x86_64') {
        fs.rmSync(tmp, { force: true });
        fail(`universal ${name} slices [${archs.join(' ')}], expected arm64 x86_64`);
    }
    execFileSync('codesign', ['-s', '-', '-f', tmp]);
    for (const dep of otoolDeps(tmp)) {
        if (!isSystemDep(dep) && !dep.startsWith('@loader_path/')
            && dep !== tmp) {
            fs.rmSync(tmp, { force: true });
            fail(`universal ${name} keeps unexpected dependency ${dep}`);
        }
    }
    fs.renameSync(tmp, merged);
    // Both slices must honour the deployment target; exactly two
    // LC_BUILD_VERSION records (one per slice) must be present.
    const minOsAll = readMinOsAll(merged);
    if (minOsAll.length !== 2) {
        fail(`universal ${name} has ${minOsAll.length} build-version records, expected 2`);
    }
    for (const minOs of minOsAll) {
        if (minOs === 'unknown' || parseFloat(minOs) > parseFloat(MIN_OS_TARGET)) {
            fail(`universal ${name} slice minos ${minOs} does not satisfy <= ${MIN_OS_TARGET}`);
        }
    }
    return merged;
}

// Universal parent flow: run each slice as a child process, then merge only
// the recorded executables + identically-named dylibs into both lookup dirs.
async function buildUniversal() {
    for (const arch of ['arm64', 'x64']) {
        console.log(`build-media: building ${arch} slice`);
        execFileSync(process.execPath, [__filename, '--arch', arch], {
            cwd: desktop, stdio: 'inherit',
        });
    }
    const records = {};
    for (const arch of ['arm64', 'x64']) {
        const metaPath = path.join(licenseRoot, `darwin-${arch}`, 'metadata.json');
        if (!fs.existsSync(metaPath)) {
            fail(`slice metadata missing after build: ${rel(metaPath)}`);
        }
        records[arch] = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    }
    const dirArm64 = path.join(
        desktop, 'scope-extension', 'resources', 'bin', 'darwin-arm64');
    const dirX64 = path.join(
        desktop, 'scope-extension', 'resources', 'bin', 'darwin-x64');
    const dylibNames = arch =>
        new Set((records[arch].staged.dylibs || []).map(entry => entry.file));
    const dylibs64 = dylibNames('arm64');
    const dylibs64x = dylibNames('x64');
    const diff = [...dylibs64].filter(n => !dylibs64x.has(n))
        .concat([...dylibs64x].filter(n => !dylibs64.has(n)));
    if (diff.length > 0) {
        fail(`dylib basename sets differ between slices: ${diff.join(', ')}`);
    }
    // Only the three known executables and the dylib basenames recorded by
    // BOTH slice records are merged; anything else is left untouched.
    const names = ['ffmpeg', 'ffprobe', 'ffplay', ...[...dylibs64].sort()];
    const mergedReport = {};
    for (const name of names) {
        const thin = [
            path.join(dirArm64, name),
            path.join(dirX64, name),
        ];
        for (const file of thin) {
            if (!fs.existsSync(file)) {
                fail(`thin input ${rel(file)} missing for universal merge`);
            }
        }
        // Thin input hashes are recorded before the destinations are
        // replaced, so the merge inputs remain auditable afterwards.
        mergedReport[name] = {
            thinSha256: thin.map(sha256File),
        };
        const merged = mergeUniversal(name, thin[0], thin[1]);
        const fat = {
            sha256: sha256File(merged),
            minOs: readMinOsAll(merged),
        };
        for (const dir of [dirArm64, dirX64]) {
            stageCopy(merged, path.join(dir, name));
        }
        mergedReport[name].universal = fat;
        console.log(`build-media: universal ${name} -> both darwin lookup dirs`);
    }
    // Re-check the complete staged closure in each lookup dir after every
    // fat output has landed: all deps must be system paths or recorded
    // @loader_path siblings that actually exist.
    for (const dir of [dirArm64, dirX64]) {
        validateDependencies(names.map(name => path.join(dir, name)));
    }
    const metadata = {
        version: FFMPEG_VERSION,
        targetPlatform: 'darwin-universal',
        architectures: ['arm64', 'x86_64'],
        perTarget: {
            'darwin-arm64': records.arm64,
            'darwin-x64': records.x64,
        },
        merged: mergedReport,
        signing: 'ad-hoc (codesign -s -) after lipo; no release signing or notarization',
        smoke: Object.fromEntries(['arm64', 'x64'].map(arch => [
            `darwin-${arch}`, records[arch].smoke])),
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(
        path.join(licenseRoot, 'metadata.json'),
        JSON.stringify(metadata, null, 2) + '\n');
    // Top-level recipe is a short universal entry point; the authoritative
    // per-slice flags/env live in darwin-<arch>/BUILD-RECIPE.txt.
    fs.writeFileSync(path.join(licenseRoot, 'BUILD-RECIPE.txt'), [
        'FFmpeg bundled build recipe (macOS universal: arm64 + x86_64)',
        '',
        'Run `npm run build:media` from desktop/. The script builds each',
        'slice in isolation (per-arch recipe: darwin-arm64/BUILD-RECIPE.txt',
        'and darwin-x64/BUILD-RECIPE.txt), then lipo-merges the recorded',
        'executables and matching dylib basenames, ad-hoc signs each output,',
        'verifies the dependency closure is system paths or recorded',
        '@loader_path siblings, and checks LC_BUILD_VERSION <= '
            + `${MIN_OS_TARGET} on both slices.`,
        '',
        `ffmpeg source: ${SOURCE_URL}`,
        `ffmpeg sha256: ${SOURCE_SHA256}`,
        `sdl2 source: ${SDL2_URL}`,
        `sdl2 sha256: ${SDL2_SHA256}`,
        `deployment target: ${MIN_OS_TARGET}`,
        '',
        'Merged outputs are staged into BOTH scope-extension/resources/bin/',
        'darwin-arm64 and darwin-x64 so each lookup dir serves a universal',
        'binary. Per-file thin and merged sha256 are in metadata.json.',
        '',
    ].join('\n'));
    console.log(`build-media: merged ${names.length} universal files into both darwin lookup dirs`);
}

async function main() {
    if (universal) {
        await buildUniversal();
        return;
    }
    await buildSlice();
}

main().catch(error => fail(error.stack || String(error)));
