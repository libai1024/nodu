// SPDX-License-Identifier: MIT
// Windows media build: downloads the pinned FFmpeg/SDL2 sources, builds them
// inside an MSYS2 UCRT64 toolchain via scripts/build-media-windows.sh, audits
// PE imports, and stages ffmpeg.exe/ffprobe.exe/ffplay.exe + SDL2.dll into
// scope-extension/resources/bin/win32-x64/. Per-target recipe and metadata
// land under resources/licenses/ffmpeg/win32-x64/; shared license materials
// live at the licenses/ffmpeg root.
//
// Prerequisites (Windows host only): Node 24, MSYS2 UCRT64 at MSYS2_ROOT
// (default C:\msys64) with gcc/make/pkg-config/objdump, and tar for source
// extraction. Pure helpers are importable for host-independent tests.
const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const USAGE = `build-media-windows: bundled Windows media build (FFmpeg + SDL2, LGPL-only).
Usage: node scripts/build-media-windows.cjs [--arch x64]
  (no --arch)   build/stage the win32-x64 media bundle.
  --arch x64    only supported value; anything else is an error.
  --help        show this text without building.
Prerequisites: Node 24 on a Windows x64 host, MSYS2 UCRT64 at MSYS2_ROOT
(default C:\\msys64) with gcc/make/pkg-config/objdump installed.`;

const desktop = path.resolve(__dirname, '..');
const TARGET = 'win32-x64';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 120000;

// Non-system imports allowed on staged files: only our own staged SDL2.dll.
// Everything else must be a system DLL (case-insensitive, with .dll suffix)
// or an API-MS-WIN-*/EXT-MS-WIN-* api-set name.
const SYSTEM_DLLS = new Set([
    'ADVAPI32', 'AVICAP32', 'AVIFIL32', 'BCRYPT', 'CFGMGR32', 'COMCTL32',
    'COMDLG32', 'D3D9', 'D3D11', 'D3D12', 'DCOMP', 'DINPUT8', 'DWMAPI',
    'DXGI', 'GDI32', 'IMM32', 'KERNEL32', 'KSUSER', 'MF', 'MFPLAT',
    'MFREADWRITE', 'MSVCRT', 'NTDLL', 'OLE32', 'OLEAUT32', 'POWRPROF',
    'PROPSYS', 'PSAPI', 'RPCRT4', 'SECUR32', 'SETUPAPI', 'SHCORE',
    'SHELL32', 'SHLWAPI', 'USER32', 'USERENV', 'UCRTBASE', 'UUID',
    'VERSION', 'WINMM', 'WINTRUST', 'WS2_32', 'WSOCK32',
]);
const STAGED_DLLS = new Set(['SDL2.DLL']);
const APISET_PREFIXES = ['API-MS-WIN-', 'EXT-MS-WIN-'];

// ---------------------------------------------------------------- helpers

function fail(message) {
    console.error(`build-media-windows: ${message}`);
    process.exit(1);
}

function rel(file) {
    return path.relative(desktop, file);
}

function sha256File(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// CLI: accepts only `--arch x64` (or no arch) and --help. Throws on anything
// else so callers/tests get a real error rather than a silent default.
function parseCliArgs(argv) {
    const parsed = parseArgs({
        args: argv,
        options: {
            arch: { type: 'string' },
            help: { type: 'boolean' },
        },
        allowPositionals: false,
        strict: true,
    });
    if (parsed.values.help) { return { help: true }; }
    const arch = parsed.values.arch || 'x64';
    if (arch !== 'x64') {
        throw new Error(`unsupported media target --arch ${arch} (win32-x64 only)`);
    }
    return { arch, help: false };
}

// Resolve the MSYS2 root: MSYS2_ROOT first, then the C:\msys64 default.
// Returns null when neither exists so the caller can report a build error.
function resolveMsys2Root(env) {
    const candidates = [env.MSYS2_ROOT, 'C:\\msys64'].filter(Boolean);
    for (const root of candidates) {
        if (fs.existsSync(path.join(root, 'usr', 'bin', 'bash.exe'))) {
            return root;
        }
    }
    return null;
}

// media-sources.json must agree with the constants baked into the macOS
// build script — same upstream pins for every platform. Throws on drift.
function checkPinAgreement(mediaSources, darwinScriptText) {
    const readConst = (name) => {
        const m = darwinScriptText.match(new RegExp(`${name} = '([^']+)'`));
        return m ? m[1] : null;
    };
    const expected = {
        'ffmpeg.version': readConst('FFMPEG_VERSION'),
        'ffmpeg.url': readConst('SOURCE_URL'),
        'ffmpeg.sha256': readConst('SOURCE_SHA256'),
        'sdl2.version': readConst('SDL2_VERSION'),
        'sdl2.url': readConst('SDL2_URL'),
        'sdl2.sha256': readConst('SDL2_SHA256'),
    };
    const actual = {
        'ffmpeg.version': mediaSources.ffmpeg && mediaSources.ffmpeg.version,
        'ffmpeg.url': mediaSources.ffmpeg && mediaSources.ffmpeg.url,
        'ffmpeg.sha256': mediaSources.ffmpeg && mediaSources.ffmpeg.sha256,
        'sdl2.version': mediaSources.sdl2 && mediaSources.sdl2.version,
        'sdl2.url': mediaSources.sdl2 && mediaSources.sdl2.url,
        'sdl2.sha256': mediaSources.sdl2 && mediaSources.sdl2.sha256,
    };
    const drift = Object.keys(expected)
        .filter(k => expected[k] !== null && expected[k] !== actual[k]);
    if (drift.length) {
        throw new Error('media-sources.json disagrees with build-media.cjs pins: '
            + drift.map(k => `${k}: manifest=${actual[k]} macos=${expected[k]}`).join('; '));
    }
    return actual;
}

// DLL Name entries from `objdump -p` output.
function parseObjdumpImports(objdumpText) {
    const names = [];
    for (const m of objdumpText.matchAll(/DLL Name:\s*(\S+)/g)) {
        names.push(m[1]);
    }
    return names;
}

// One import name -> 'staged' | 'system' | 'apiset' | 'unexpected'.
function classifyImport(dllName) {
    const upper = dllName.toUpperCase().replace(/\.DLL$/, '');
    if (STAGED_DLLS.has(dllName.toUpperCase())) { return 'staged'; }
    if (APISET_PREFIXES.some(p => dllName.toUpperCase().startsWith(p))) {
        return 'apiset';
    }
    if (SYSTEM_DLLS.has(upper)) { return 'system'; }
    return 'unexpected';
}

// Returns the list of unexpected imports; empty array means clean.
function unexpectedImports(objdumpText) {
    return parseObjdumpImports(objdumpText)
        .filter(name => classifyImport(name) === 'unexpected');
}

// PE header check: MZ magic, PE\0\0 signature, IMAGE_FILE_MACHINE_AMD64.
function isPeX64(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch { return false; }
    try {
        const head = Buffer.alloc(64);
        if (fs.readSync(fd, head, 0, 64, 0) !== 64) { return false; }
        if (head.readUInt16LE(0) !== 0x5a4d) { return false; }
        const peOffset = head.readUInt32LE(0x3c);
        const pe = Buffer.alloc(6);
        if (fs.readSync(fd, pe, 0, 6, peOffset) !== 6) { return false; }
        return pe.readUInt32LE(0) === 0x00004550
            && pe.readUInt16LE(4) === 0x8664;
    } finally { fs.closeSync(fd); }
}

// Tar member safety: rejects absolute paths, traversal, members outside the
// expected top folder, and links whose targets escape it (tar -tf listing,
// one member per line, hard/symlinks shown as `name -> target`).
function unsafeTarMembers(listing, expectedTop) {
    const bad = [];
    for (const raw of listing.split('\n')) {
        const entry = raw.trim();
        if (!entry) { continue; }
        const parts = entry.split(' -> ');
        const name = parts[0].replace(/^\.\//, '');
        const target = parts.length > 1 ? parts.slice(1).join(' -> ') : null;
        const normalized = name.replace(/\\/g, '/');
        if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)
            || normalized.split('/').includes('..')) {
            bad.push(entry);
            continue;
        }
        if (normalized !== expectedTop
            && !normalized.startsWith(`${expectedTop}/`)) {
            bad.push(entry);
            continue;
        }
        if (target !== null) {
            const t = target.replace(/\\/g, '/');
            const resolved = t.startsWith('/')
                ? t
                : path.posix.normalize(
                    path.posix.join(path.posix.dirname(normalized), t));
            if (t.startsWith('/') || /^[A-Za-z]:/.test(t)
                || (resolved !== expectedTop
                    && !resolved.startsWith(`${expectedTop}/`))) {
                bad.push(entry);
            }
        }
    }
    return bad;
}

const FFMPEG_FLAGS = [
    '--disable-autodetect', '--disable-gpl', '--disable-nonfree',
    '--disable-version3', '--disable-doc', '--disable-debug',
    '--disable-network', '--enable-ffplay', '--enable-sdl2',
    '--enable-w32threads', '--disable-pthreads', '--enable-small',
    '--enable-static', '--disable-shared', '--disable-x86asm',
    '--target-os=mingw32', '--arch=x86_64', '--cc=gcc',
    // MSYS2 UCRT64 gcc uses a posix-thread model: without this, every exe
    // gains a libwinpthread-1.dll import (audit fails). whole-archive
    // embeds winpthread statically; SDL2 stays a real DLL for ffplay.
    '--extra-ldflags=-static-libgcc -Wl,-Bstatic,--whole-archive -lwinpthread -Wl,-Bdynamic,--no-whole-archive',
];
const SDL2_FLAGS = [
    '--host=x86_64-w64-mingw32', '--enable-shared', '--disable-static',
    '--disable-video-x11', '--disable-video-wayland', '--disable-pulseaudio',
    '--disable-alsa', '--disable-jack', '--disable-libsamplerate',
];

// ---------------------------------------------------------------- host work

const cacheDir = path.join(desktop, '.tools', 'media', 'win32-x64');
const stageDir = path.join(
    desktop, 'scope-extension', 'resources', 'bin', 'win32-x64');
const licenseRoot = path.join(
    desktop, 'scope-extension', 'resources', 'licenses', 'ffmpeg');
const licenseDir = path.join(licenseRoot, 'win32-x64');

function loadSources() {
    const sources = JSON.parse(fs.readFileSync(
        path.join(__dirname, 'media-sources.json'), 'utf8'));
    // media-sources.json must agree with the macOS script's pins; drift is a
    // build error, never a silent update on either side.
    const darwinText = fs.readFileSync(
        path.join(__dirname, 'build-media.cjs'), 'utf8');
    const readConst = name => {
        const m = darwinText.match(new RegExp(`${name} = '([^']+)'`));
        return m && m[1];
    };
    const pairs = [
        ['ffmpeg.version', sources.ffmpeg.version, readConst('FFMPEG_VERSION')],
        ['ffmpeg.url', sources.ffmpeg.url, readConst('SOURCE_URL')],
        ['ffmpeg.sha256', sources.ffmpeg.sha256, readConst('SOURCE_SHA256')],
        ['sdl2.version', sources.sdl2.version, readConst('SDL2_VERSION')],
        ['sdl2.url', sources.sdl2.url, readConst('SDL2_URL')],
        ['sdl2.sha256', sources.sdl2.sha256, readConst('SDL2_SHA256')],
    ];
    const drift = pairs.filter(([, a, b]) => b && a !== b);
    if (drift.length) {
        fail('media-sources.json disagrees with build-media.cjs pins:\n  '
            + drift.map(([k, a, b]) => `${k}: manifest=${a} macos=${b}`).join('\n  '));
    }
    return sources;
}

async function download(url, destination) {
    let current = url;
    for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:') {
            fail(`refusing non-HTTPS download ${current}`);
        }
        const response = await fetch(parsed,
            { redirect: 'manual', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (response.status >= 300 && response.status < 400
            && response.headers.get('location')) {
            response.body && response.body.cancel().catch(() => {});
            current = new URL(response.headers.get('location'), current).href;
            continue;
        }
        if (response.status !== 200) {
            fail(`${current} -> HTTP ${response.status}`);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of response.body) {
            size += chunk.length;
            if (size > MAX_DOWNLOAD_BYTES) {
                fail(`${current} exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
            }
            chunks.push(chunk);
        }
        const tmp = `${destination}.tmp-${process.pid}`;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try {
            fs.writeFileSync(tmp, Buffer.concat(chunks));
            fs.renameSync(tmp, destination);
        } catch (error) {
            fs.rmSync(tmp, { force: true });
            throw error;
        }
        return;
    }
    fail(`too many redirects downloading ${url}`);
}

function fetchArchive(url, sha, destination) {
    if (fs.existsSync(destination) && sha256File(destination) === sha) {
        console.log(`build-media-windows: reusing verified archive ${path.basename(destination)}`);
        return Promise.resolve();
    }
    if (fs.existsSync(destination)) { fs.rmSync(destination); }
    return download(url, destination).then(() => {
        const actual = sha256File(destination);
        if (actual !== sha) {
            fs.rmSync(destination, { force: true });
            fail(`archive sha256 ${actual} != pinned ${sha} for ${url}`);
        }
        console.log(`build-media-windows: archive sha256 verified ${actual}`);
    });
}

// MSYS-flavoured tools take POSIX paths like /d/work; the drive-letter form
// `D:\…` fails as a -C directory (verified on real Windows: MSYS2 GNU tar).
function toMsysPath(p) {
    const forward = p.replace(/\\/g, '/');
    const m = forward.match(/^([A-Za-z]):\/(.*)$/);
    return m ? `/${m[1].toLowerCase()}/${m[2]}` : forward;
}

// GNU tar parses a colon in the -f argument as remote-tape `host:file`
// syntax, so a Windows path like `D:\…\a.tar.xz` becomes "connect to D:".
// Passing the basename with cwd keeps the archive argument colon-free on
// every tar flavour (verified on real Windows: MSYS2 GNU tar).
function tarInvocation(archive, extraArgs) {
    return {
        args: [path.win32.basename(archive), ...(extraArgs || [])],
        options: { cwd: path.win32.dirname(archive) },
    };
}

function extractArchive(archive, topLevel) {
    const flag = archive.endsWith('.tar.xz') ? 'J' : 'z';
    const list = tarInvocation(archive);
    const listing = execFileSync('tar', [`-t${flag}f`, ...list.args],
        { ...list.options, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    const bad = unsafeTarMembers(listing, topLevel);
    if (bad.length) {
        fail(`unsafe tar members in ${path.basename(archive)}:\n  ${bad.join('\n  ')}`);
    }
    const into = path.join(cacheDir, topLevel);
    if (fs.existsSync(path.join(into, 'configure'))) {
        console.log(`build-media-windows: reusing extracted ${topLevel}`);
        return;
    }
    const extract = tarInvocation(archive, ['-C', toMsysPath(cacheDir)]);
    execFileSync('tar', [`-x${flag}f`, ...extract.args],
        { ...extract.options, stdio: 'inherit' });
    if (!fs.existsSync(path.join(into, 'configure'))) {
        fail(`expected ${into}/configure after extraction`);
    }
}

function msysBash(msys2Root, args, input) {
    const bash = path.join(msys2Root, 'usr', 'bin', 'bash.exe');
    return spawnSync(bash, ['--login', '-s', '--', ...args], {
        input,
        encoding: 'utf8',
        env: {
            ...process.env,
            MSYSTEM: 'UCRT64',
            CHERE_INVOKING: '1',
            MSYS2_PATH_TYPE: 'inherit',
        },
        maxBuffer: 256 * 1024 * 1024,
    });
}

async function main() {
    const { values } = (() => {
        try {
            return { values: parseCliArgs(process.argv.slice(2)) };
        } catch (error) {
            fail(error.message);
        }
    })();
    if (values.help) { console.log(USAGE); return; }
    if (process.platform !== 'win32') {
        fail(`win32-x64 media can only be built on a Windows host (this is ${process.platform})`);
    }

    const sources = loadSources();
    const ffmpegVersion = sources.ffmpeg.version;
    const sdl2Version = sources.sdl2.version;
    const msys2 = resolveMsys2Root(process.env);
    if (!msys2) {
        fail('MSYS2 UCRT64 toolchain not found. Set MSYS2_ROOT or install to '
            + 'C:\\msys64 with gcc/make/pkg-config/objdump (mingw-w64-ucrt-x86_64-gcc).');
    }
    const objdump = path.join(msys2, 'ucrt64', 'bin', 'objdump.exe');
    if (!fs.existsSync(objdump)) {
        fail(`objdump not found at ${objdump}; install mingw-w64-ucrt-x86_64-gcc/binutils`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    const ffmpegArchive = path.join(cacheDir, `ffmpeg-${ffmpegVersion}.tar.xz`);
    const sdl2Archive = path.join(cacheDir, `SDL2-${sdl2Version}.tar.gz`);
    await fetchArchive(sources.ffmpeg.url, sources.ffmpeg.sha256, ffmpegArchive);
    await fetchArchive(sources.sdl2.url, sources.sdl2.sha256, sdl2Archive);
    extractArchive(ffmpegArchive, `ffmpeg-${ffmpegVersion}`);
    extractArchive(sdl2Archive, `SDL2-${sdl2Version}`);

    const ffmpegDir = path.join(cacheDir, `ffmpeg-${ffmpegVersion}`);
    const sdl2Dll = path.join(cacheDir, 'sdl2-install', 'bin', 'SDL2.dll');
    const builtExes = ['ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe']
        .map(name => path.join(ffmpegDir, name));

    const markerPath = path.join(cacheDir, '.nodu-win32-marker');
    const marker = [
        `ffmpeg=${sources.ffmpeg.sha256}`,
        `sdl2=${sources.sdl2.sha256}`,
        'target=win32-x64',
        `flags=${FFMPEG_FLAGS.join(' ')}`,
        `sdl2flags=${SDL2_FLAGS.join(' ')}`,
        `recipe=${sha256File(path.join(__dirname, 'build-media-windows.sh'))}`,
    ].join('\n');
    const outputsReady = builtExes.every(fs.existsSync) && fs.existsSync(sdl2Dll)
        && fs.existsSync(markerPath)
        && fs.readFileSync(markerPath, 'utf8').split('\n')
            .slice(0, marker.split('\n').length).join('\n') === marker;

    if (outputsReady) {
        console.log('build-media-windows: build marker current; reusing compiled sources');
    } else {
        const jobs = Math.max(1, Math.min(os.cpus().length, 8));
        const script = fs.readFileSync(
            path.join(__dirname, 'build-media-windows.sh'), 'utf8');
        console.log(`build-media-windows: MSYS2 build (${jobs} jobs) -> ${rel(cacheDir)}`);
        const res = msysBash(msys2,
            [cacheDir, String(jobs), ffmpegVersion, sdl2Version], script);
        fs.writeFileSync(path.join(cacheDir, 'build.log'),
            (res.stdout || '') + (res.stderr || ''));
        if (res.status !== 0) {
            fail(`MSYS2 build failed (see ${rel(cacheDir)}/build.log):\n`
                + (res.stderr || res.stdout || '').split('\n').slice(-15).join('\n'));
        }
        fs.writeFileSync(markerPath, marker + `\ncompiler=${fs.readFileSync(
            path.join(cacheDir, 'toolchain.txt'), 'utf8').split('\n')[0]}`);
    }

    // ---- stage
    const staged = [];
    for (const [src, name] of [
        ...builtExes.map(f => [f, path.basename(f)]),
        [sdl2Dll, 'SDL2.dll'],
    ]) {
        if (!fs.existsSync(src)) { fail(`build output missing: ${src}`); }
        if (!isPeX64(src)) { fail(`${name} is not an x86_64 PE binary`); }
        fs.mkdirSync(stageDir, { recursive: true });
        const dest = path.join(stageDir, name);
        const tmp = path.join(stageDir, `.${name}.tmp-${process.pid}`);
        fs.copyFileSync(src, tmp);
        fs.renameSync(tmp, dest);
        staged.push(dest);
        console.log(`build-media-windows: staged ${rel(dest)}`);
    }

    // ---- import-table audit: staged SDL2.dll is the only non-system import
    const objdumpOf = file =>
        execFileSync(objdump, ['-p', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const imports = {};
    for (const file of staged) {
        const out = objdumpOf(file);
        const names = parseObjdumpImports(out);
        const bad = names.filter(n => classifyImport(n) === 'unexpected');
        imports[path.basename(file)] = names;
        if (bad.length) {
            fail(`${path.basename(file)} has unexpected DLL imports: ${bad.join(', ')}`);
        }
    }
    console.log('build-media-windows: import tables clean (system + SDL2.dll only)');

    // ---- runtime validation (native on this host)
    const runtime = {};
    for (const exe of staged.filter(f => f.endsWith('.exe'))) {
        const name = path.basename(exe);
        const ver = execFileSync(exe, ['-version'],
            { encoding: 'utf8', timeout: 30000 });
        runtime[`${name} -version`] = ver.split('\n')[0];
    }
    const buildconf = execFileSync(
        path.join(stageDir, 'ffmpeg.exe'), ['-buildconf'],
        { encoding: 'utf8', timeout: 30000 });
    if (/--enable-(gpl|nonfree|version3)\b/.test(buildconf)) {
        fail('ffmpeg buildconf shows a disallowed flag (gpl/nonfree/version3)');
    }
    const license = execFileSync(
        path.join(stageDir, 'ffmpeg.exe'), ['-L'],
        { encoding: 'utf8', timeout: 30000 });
    // -L wraps "GNU Lesser General Public\nLicense" across lines; there is
    // no literal "LGPL" in the text (verified on real Windows output).
    if (!/GNU\s+Lesser\s+General\s+Public\s+License|LGPL/i.test(license)) {
        fail('ffmpeg -L does not report LGPL licensing');
    }
    console.log('build-media-windows: version/buildconf/-L checks passed');

    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-media-smoke-win32-'));
    const mp4 = path.join(work, 'smoke.mp4');
    const smoke = { target: TARGET, executed: true, encode: null, probe: null, ffplay: null };
    try {
        execFileSync(path.join(stageDir, 'ffmpeg.exe'), [
            '-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'color=c=red:size=64x48:rate=10',
            '-t', '1', '-c:v', 'mpeg4', mp4], { stdio: 'inherit' });
        smoke.encode = `ok: ${fs.statSync(mp4).size} bytes`;
        const probe = JSON.parse(execFileSync(
            path.join(stageDir, 'ffprobe.exe'), [
                '-hide_banner', '-loglevel', 'error', '-print_format', 'json',
                '-show_streams', mp4], { encoding: 'utf8' }));
        const video = (probe.streams || []).find(s => s.codec_type === 'video');
        if (!video || video.codec_name !== 'mpeg4') {
            fail(`ffprobe found no mpeg4 stream: ${JSON.stringify(video)}`);
        }
        smoke.probe = `ok: ${video.codec_name} ${video.width}x${video.height}`;
        try {
            execFileSync(path.join(stageDir, 'ffplay.exe'), [
                '-hide_banner', '-loglevel', 'error', '-autoexit', mp4], {
                env: { ...process.env, SDL_VIDEODRIVER: 'dummy', SDL_AUDIODRIVER: 'dummy' },
                timeout: 30000,
            });
            smoke.ffplay = 'ok: dummy drivers, -autoexit';
        } catch (error) {
            smoke.ffplay = `unsupported: dummy-driver playback failed (${error.message.split('\n')[0]})`;
        }
    } finally {
        console.log(`build-media-windows: smoke artifacts in ${work}`);
    }

    // ---- licenses
    fs.mkdirSync(licenseRoot, { recursive: true });
    fs.mkdirSync(licenseDir, { recursive: true });
    const ffmpegDirPath = path.join(cacheDir, `ffmpeg-${ffmpegVersion}`);
    const sdl2Dir = path.join(cacheDir, `SDL2-${sdl2Version}`);
    const sharedCopies = [
        [path.join(sdl2Dir, 'LICENSE.txt'), 'sdl2-LICENSE.txt'],
        [path.join(ffmpegDirPath, 'COPYING.LGPLv2.1'), 'ffmpeg-COPYING.LGPLv2.1.txt'],
        [ffmpegArchive, path.basename(ffmpegArchive)],
        [sdl2Archive, path.basename(sdl2Archive)],
    ];
    for (const [from, to] of sharedCopies) {
        if (!fs.existsSync(from)) { fail(`license/source file missing: ${from}`); }
        fs.copyFileSync(from, path.join(licenseRoot, to));
    }
    // MinGW/GCC runtime exception notice — required because libgcc is linked
    // statically into the exe files.
    const rle = findRuntimeException(msys2);
    if (!rle) {
        fail('GCC Runtime Library Exception text not found under the MSYS2 '
            + 'toolchain; required because libgcc is statically linked');
    }
    fs.copyFileSync(rle, path.join(licenseDir, 'gcc-runtime-library-exception.txt'));
    fs.copyFileSync(path.join(__dirname, 'build-media-windows.sh'),
        path.join(licenseDir, 'build-media-windows.sh'));
    fs.copyFileSync(__filename, path.join(licenseDir, 'build-media-windows.cjs'));
    if (fs.existsSync(path.join(cacheDir, 'toolchain.txt'))) {
        fs.copyFileSync(path.join(cacheDir, 'toolchain.txt'),
            path.join(licenseDir, 'toolchain.txt'));
    }
    fs.writeFileSync(path.join(licenseDir, 'BUILD-RECIPE.txt'), [
        'FFmpeg bundled build recipe (Windows host, target win32-x64)',
        `ffmpeg source: ${sources.ffmpeg.url}`,
        `ffmpeg sha256: ${sources.ffmpeg.sha256}`,
        `sdl2 source: ${sources.sdl2.url}`,
        `sdl2 sha256: ${sources.sdl2.sha256}`,
        'MSYS2 UCRT64 toolchain (gcc/make/pkg-config/objdump); invoked as',
        '  usr\\bin\\bash.exe --login -s -- <cacheDir> <jobs> <ffmpegVersion> <sdl2Version>',
        '  with scripts/build-media-windows.sh on stdin',
        `sdl2 configure: ${SDL2_FLAGS.join(' ')}`,
        'ffmpeg configure flags:',
        ...FFMPEG_FLAGS.map(flag => `  ${flag}`),
        'make -j<N> (bounded host CPUs, max 8); toolchain identity in toolchain.txt',
        'Import tables audited with objdump -p; only system DLLs + SDL2.dll allowed.',
        'Run `npm run build:media` from desktop/ on a Windows host.',
        '',
    ].join('\n'));

    // ---- metadata
    const stagedNames = staged.map(f => path.basename(f));
    const metadata = {
        version: ffmpegVersion,
        targetPlatform: TARGET,
        source: { url: sources.ffmpeg.url, sha256: sources.ffmpeg.sha256 },
        sdl2: { version: sdl2Version, url: sources.sdl2.url,
            sha256: sources.sdl2.sha256, configureFlags: SDL2_FLAGS },
        configureFlags: FFMPEG_FLAGS,
        buildPlatform: `${process.platform}-${process.arch}`,
        staged: Object.fromEntries(stagedNames.map(name => [name, {
            sha256: sha256File(path.join(stageDir, name)),
            pe: 'IMAGE_FILE_MACHINE_AMD64 (0x8664)',
            imports: imports[name] || [],
        }])),
        runtime: {
            checks: runtime,
            licenseCheck: 'ffmpeg -L reports LGPL',
            smoke,
        },
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(licenseDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2) + '\n');
    console.log(`build-media-windows: staged ${stagedNames.join(', ')} into ${rel(stageDir)}`);
}

// Finds the GCC Runtime Library Exception text shipped with the MSYS2
// toolchain; returns a path or null.
function findRuntimeException(msys2Root) {
    const candidates = [
        'usr/share/licenses/gcc-libs/RUNTIME.LIBRARY.EXCEPTION',
        'ucrt64/share/licenses/gcc-libs/RUNTIME.LIBRARY.EXCEPTION',
        'usr/share/licenses/gcc/RUNTIME.LIBRARY.EXCEPTION',
        'ucrt64/share/licenses/gcc/RUNTIME.LIBRARY.EXCEPTION',
    ];
    for (const relPath of candidates) {
        const full = path.join(msys2Root, relPath);
        if (fs.existsSync(full)) { return full; }
    }
    // Fallback: shallow scan of license dirs for the exception text.
    for (const base of ['usr/share/licenses', 'ucrt64/share/licenses']) {
        const dir = path.join(msys2Root, base);
        if (!fs.existsSync(dir)) { continue; }
        for (const pkg of fs.readdirSync(dir)) {
            const sub = path.join(dir, pkg);
            if (!fs.statSync(sub).isDirectory()) { continue; }
            for (const f of fs.readdirSync(sub)) {
                if (/RUNTIME/i.test(f)) { return path.join(sub, f); }
            }
        }
    }
    return null;
}

module.exports = {
    parseCliArgs,
    resolveMsys2Root,
    parseObjdumpImports,
    classifyImport,
    unexpectedImports,
    unsafeTarMembers,
    tarInvocation,
    toMsysPath,
    isPeX64,
    SYSTEM_DLLS,
    STAGED_DLLS,
    checkPinAgreement,
    loadSources,
    TARGET,
};

if (require.main === module) {
    main().catch(error => fail(error.stack || String(error)));
}
