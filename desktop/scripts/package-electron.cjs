// SPDX-License-Identifier: MIT
'use strict';

// Standalone .app packaging per artifacts/delivery-0.1.4/app-package-design.md.
// macOS: per-arch isolated workspaces (own npm ci + Theia production build
// under the pinned Node toolchain), @electron/packager thin apps,
// @electron/universal merge, ad-hoc codesign, ditto zip + manifest.
// Windows x64: same isolated pipeline on a Windows host, portable zip;
// missing media/sidecar .exe inputs fail validation. macOS also produces a
// drag-to-Applications DMG. No Developer ID or notarization claims.

const { execFileSync, execSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { parseArgs } = require('node:util');
const tutorTools = require('./package-tutor-tools.cjs');
const { courseExamplesStamp, copyCourseExamples } = require('./course-examples.cjs');

const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '..');
const packageRoot = path.join(desktop, '.tools', 'package');
const distDir = path.join(desktop, 'dist');

const NODE_VERSION = '24.21.0';
const NODE_DARWIN_SHA = {
    arm64: '6239d4cf92d864487ec8cd3615038f7b67e7f58b77b21cd2f09ea9fbd68065fe',
    x64: '0ae5a24c24bb7d015cd816c5036b3f90f2945aa872fcf54e58da054753b3a299',
};
const ELECTRON_VERSION = '42.8.1';
// Official release SHASUMS256.txt retained with the verified download cache.
// Pin the digest so cached archives can be verified without fetching this
// small metadata file on every packaging run. New versions need new digests.
const ELECTRON_SHA256 = {
    'electron-v42.8.1-darwin-arm64.zip': 'f03df963463d120a35a194e0c172f15c611ea81dceda09a6ea275843611231fd',
    'electron-v42.8.1-darwin-x64.zip': 'a9cb0bc4e7e41e047798c5366a2136ece4949fb9092c59d54597d6ce09bb2e09',
    'electron-v42.8.1-win32-x64.zip': '7a1aff619f94ead8a377d82e1f59bfd9a31a17db5b948f82fc5e60d576fe9304',
};
const PACKAGER_VERSION = '20.3.0';
const UNIVERSAL_VERSION = '3.0.6';
const MIN_OS = '15.0';
const MAX_DOWNLOAD = 80 * 1024 * 1024;

const appPkg = JSON.parse(
    fs.readFileSync(path.join(desktop, 'electron-app', 'package.json'), 'utf8'));
const applicationVersion = appPkg.version;
const ENTITLEMENTS = path.join(__dirname, 'package-entitlements.plist');

function fail(message) {
    console.error(`package-electron: ${message}`);
    process.exit(1);
}

function rel(file) {
    return path.relative(desktop, file) || '.';
}

function run(cmd, args, options = {}) {
    console.log(`package-electron: + ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, { stdio: 'inherit', ...options });
}

// ---------------------------------------------------------------- CLI

const { values } = (() => {
    // Under `require()` (tests) argument parsing is skipped entirely.
    if (require.main !== module) { return { values: {} }; }
    try {
        return parseArgs({
            options: {
                arch: { type: 'string' },
                help: { type: 'boolean' },
                stamp: { type: 'boolean' },
                prepare: { type: 'boolean' },
            },
            allowPositionals: false,
        });
    } catch (error) {
        fail(error.message);
    }
})();

if (values.help) {
    console.log(`package-electron: standalone Electron app packaging.
Usage: node scripts/package-electron.cjs [--arch universal|arm64|x64]
  (no --arch)   macOS: universal .app merge + ad-hoc sign + zip.
                Windows: x64 portable package.
  --arch arm64|x64   single-arch signed .app + zip + DMG (macOS).
  --prepare     build isolated JS/Electron workspaces without assembling runtime assets.
  --help        show this text.`);
    process.exit(0);
}

const host = process.platform;
if (require.main === module && !['darwin', 'win32'].includes(host)) {
    fail(`unsupported package host platform ${host}`);
}
const targetArch = values.arch || (host === 'darwin' ? 'universal' : 'x64');
const thinArchs = targetArch === 'universal' ? ['arm64', 'x64'] : [targetArch];
if (host === 'darwin' && !['universal', 'arm64', 'x64'].includes(targetArch)) {
    fail(`unsupported --arch ${targetArch} on macOS (universal|arm64|x64)`);
}
if (host === 'win32' && targetArch !== 'x64') {
    fail(`unsupported --arch ${targetArch} on Windows (x64 only; no universal)`);
}

// ------------------------------------------------------ input validation

function requireInputs(arch) {
    if (host === 'darwin') { tutorTools.validate(tutorTools.rootFor(desktop, `darwin-${arch}`), `darwin-${arch}`); }
    const stm32 = require('./package-stm32.cjs');
    stm32.validateToolkit(stm32.toolkitSource(desktop, host, arch));
    const required = [];
    if (host === 'darwin') {
        for (const name of ['nodu-device', 'nodu-terminal', 'nodu-resources', 'nodu-embedded', 'nodu-tutor',
            'ffmpeg', 'ffprobe', 'ffplay', 'libSDL2-2.0.0.dylib']) {
            required.push(`scope-extension/resources/bin/darwin-${arch}/${name}`);
        }
        required.push('scope-extension/resources/imaging/nodu_imaging_bg.wasm');
        required.push('scope-extension/resources/licenses/ffmpeg/metadata.json');
        required.push('scripts/package-entitlements.plist');
    } else {
        for (const name of ['nodu-device.exe', 'nodu-terminal.exe',
            'nodu-resources.exe', 'nodu-embedded.exe', 'nodu-tutor.exe', 'ffmpeg.exe', 'ffprobe.exe', 'ffplay.exe',
            'SDL2.dll']) {
            required.push(`scope-extension/resources/bin/win32-${arch}/${name}`);
        }
        required.push('scope-extension/resources/imaging/nodu_imaging_bg.wasm');
        required.push('scope-extension/resources/licenses/ffmpeg/win32-x64/metadata.json');
    }
    required.push('scope-extension/resources/nodu-resources/examples');
    required.push('plugins/vscode-clangd/package.json');
    required.push('scripts/launch.cjs');
    required.push('scripts/packaged-entry.cjs');
    required.push('electron-app/package.json');
    const missing = required.filter(file =>
        !fs.existsSync(path.join(desktop, file)));
    if (missing.length) {
        fail(`missing packaged inputs:\n  ${missing.join('\n  ')}\n`
            + 'run npm run build:electron first (native + media).');
    }
    const electronDep = (appPkg.devDependencies || {}).electron;
    if (electronDep !== ELECTRON_VERSION) {
        fail(`electron-app pins electron ${electronDep}, expected ${ELECTRON_VERSION}`);
    }
}

// ------------------------------------------------- toolchain (darwin)

function sha256File(file) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(1024 * 1024);
    try {
        let size;
        while ((size = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) { hash.update(chunk.subarray(0, size)); }
    } finally { fs.closeSync(fd); }
    return hash.digest('hex');
}

// Bounded fetch: HTTPS only, at most 5 redirects (relative Location
// resolved against the current URL), a 120s total-budget timeout, a
// streamed 80 MiB ceiling, and the temp file is written and renamed
// exactly once after the body completes.
async function download(url, destination) {
    let current = url;
    for (let hops = 0; hops <= 5; hops += 1) {
        const parsed = new URL(current);
        if (parsed.protocol !== 'https:') {
            fail(`refusing non-HTTPS download ${current}`);
        }
        const response = await new Promise((resolve, reject) => {
            const request = http.get(parsed,
                { signal: AbortSignal.timeout(120000) }, resolve);
            request.on('error', reject);
        });
        const status = response.statusCode || 0;
        if (status >= 300 && status < 400 && response.headers.location) {
            response.resume();
            current = new URL(response.headers.location, current).href;
            continue;
        }
        if (status !== 200) {
            response.resume();
            fail(`${current} -> HTTP ${status}`);
        }
        const tmp = `${destination}.tmp-${process.pid}`;
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        try {
            let size = 0;
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_DOWNLOAD) {
                    response.destroy(new Error(
                        `${current} exceeds ${MAX_DOWNLOAD} bytes`));
                }
            });
            await pipeline(response, fs.createWriteStream(tmp));
            fs.renameSync(tmp, destination);
            return;
        } catch (error) {
            fs.rmSync(tmp, { force: true });
            throw error;
        }
    }
    fail(`too many redirects downloading ${url}`);
}

// tar -tvf line: mode owner size date name [-> target]
function assertSafeTar(archive, expectedTop) {
    const listing = execFileSync('tar', ['-tvf', archive], { encoding: 'utf8' });
    for (const line of listing.split('\n')) {
        if (!line.trim()) { continue; }
        // bsdtar -tvf columns: mode links user group size month day time name.
        const entry = line.replace(/^\S+\s+\d+\s+\S+\s+\S+\s+[\d.]+\s+\S+\s+\S+\s+\S+\s+/, '');
        const name = entry.split(' -> ')[0];
        const target = entry.includes(' -> ') ? entry.split(' -> ')[1] : null;
        if (name.split('/').includes('..') || path.isAbsolute(name)) {
            fail(`unsafe tar entry ${name} in ${rel(archive)}`);
        }
        if (name !== expectedTop && !name.startsWith(`${expectedTop}/`)) {
            fail(`tar entry ${name} escapes top folder ${expectedTop}`);
        }
        if (target !== null) {
            // Resolve relative links against the entry's directory; they
            // must land back inside the expected top folder.
            const resolved = path.posix.normalize(
                path.posix.join(path.posix.dirname(name), target));
            if (path.isAbsolute(target)
                || (resolved !== expectedTop && !resolved.startsWith(`${expectedTop}/`))) {
                fail(`tar link ${name} -> ${target} escapes ${expectedTop}`);
            }
        }
    }
}

// npm-cli.js lives in lib/node_modules under the POSIX install layout
// and in node_modules directly under the Windows layout.
function resolveNpmCli(nodeBin) {
    const dir = path.dirname(nodeBin);
    const candidates = [
        path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
        path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    ];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (!found) {
        fail(`npm-cli.js not found next to ${nodeBin}; checked:\n`
            + `  ${candidates.join('\n  ')}`);
    }
    return found;
}

async function ensureNode(arch) {
    // Windows host: the pinned-node indirection applies to the darwin
    // toolchain stage; on Windows the host Node runs npm ci directly.
    if (host !== 'darwin') {
        const version = execFileSync(process.execPath, ['--version'],
            { encoding: 'utf8' }).trim();
        if (!/^v24\./.test(version)) {
            fail(`packaging requires Node 24; host reports ${version}`);
        }
        return process.execPath;
    }
    const nodeDir = path.join(packageRoot, `node-${arch}`);
    const nodeBin = path.join(nodeDir, 'bin', 'node');
    const marker = path.join(nodeDir, '.sha256-verified');
    if (fs.existsSync(nodeBin) && fs.existsSync(marker)
        && fs.readFileSync(marker, 'utf8') === NODE_DARWIN_SHA[arch]) {
        return nodeBin;
    }
    const archive = path.join(packageRoot, `node-v${NODE_VERSION}-darwin-${arch}.tar.xz`);
    if (!fs.existsSync(archive) || sha256File(archive) !== NODE_DARWIN_SHA[arch]) {
        console.log(`package-electron: fetching Node ${NODE_VERSION} darwin-${arch}`);
        await download(
            `https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-${arch}.tar.xz`,
            archive);
        const sha = sha256File(archive);
        if (sha !== NODE_DARWIN_SHA[arch]) {
            fs.rmSync(archive, { force: true });
            fail(`Node archive sha256 ${sha} != pinned ${NODE_DARWIN_SHA[arch]}`);
        }
    }
    fs.rmSync(nodeDir, { recursive: true, force: true });
    const top = `node-v${NODE_VERSION}-darwin-${arch}`;
    assertSafeTar(archive, top);
    const extractDir = `${nodeDir}.tmp-${process.pid}`;
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xf', archive, '-C', extractDir]);
    fs.renameSync(path.join(extractDir, top), nodeDir);
    fs.rmSync(extractDir, { recursive: true, force: true });
    // Run the downloaded binary itself to prove it executes on this host.
    execFileSync(nodeBin, ['--version'], { stdio: 'pipe' });
    fs.writeFileSync(marker, NODE_DARWIN_SHA[arch]);
    return nodeBin;
}

// ------------------------------------------------- isolated workspaces

// Paths excluded from the source copy and the compiler-input stamp.
// The stamp covers JS/TS/webpack compiler inputs only: Rust native sources
// and runtime resources (sidecar/media binaries, license records, bundled
// examples) are assembled from the live root at app-input time and hashed
// separately, so a native-only or resource-only change never redoes a
// completed JS/ABI build. resources/imaging + boards + models DO stay —
// the frontend bundle imports their WASM glue and assets at compile time.
const EXCLUDE = [
    /^examples$/,
    /^node_modules$/,
    /^\.tools$/,
    /^dist$/,
    /^native$/,
    /^scope-extension\/resources\/(bin|licenses|nodu-resources)$/,
    /^\.browser_modules$/,
    /^\.electron_modules$/,
    /^\.theia$/,
    /^browser-app\/(lib|src-gen)$/,
    /^electron-app\/(lib|src-gen)$/,
    /^scope-extension\/(lib|src-gen)$/,
    // Orchestration-only files: assembled into the app input fresh on
    // every run and hashed via runtime resources, so editing them must
    // not invalidate a completed workspace JS/ABI build.
    /^scripts\/package-electron\.cjs$/,
    /^scripts\/packaged-entry\.cjs$/,
    /^scripts\/macos-trash\.swift$/,
    /\.log$/,
    /^\.DS_Store$/,
];
const EXCLUDE_NESTED = [
    /^scope-extension\/resources\/wasi(\/|$)/,
    /(^|\/)node_modules(\/|$)/,
    /(^|\/)\.theia(\/|$)/,
    /(^|\/)gen-webpack\.config\.js$/,
    /(^|\/)esbuild\.mjs$/,
    /^scope-extension\/resources\/(bin|licenses|nodu-resources)(\/|$)/,
    /^native(\/|$)/,
    /^\.DS_Store$/,
];

// Runtime resource roots assembled from the live tree at app-input time
// (excluded from the compiler stamp above, hashed here instead).
const RUNTIME_RESOURCES = [
    'scope-extension/resources/bin',
    'scope-extension/resources/licenses',
    'scope-extension/resources/nodu-resources',
];

function hashTree(root) {
    const hash = crypto.createHash('sha256');
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })
            .sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(dir, entry.name);
            const relPath = path.relative(root, full).split(path.sep).join('/');
            if (entry.isDirectory()) { walk(full); }
            else if (entry.isFile()) {
                hash.update(relPath); hash.update('\0');
                hash.update(fs.readFileSync(full)); hash.update('\0');
            }
        }
    };
    walk(root);
    return hash.digest('hex');
}

function runtimeResourcesStamp() {
    const hash = crypto.createHash('sha256');
    for (const relPath of RUNTIME_RESOURCES) {
        const full = path.join(desktop, relPath);
        if (!fs.existsSync(full)) { fail(`runtime resource missing: ${relPath}`); }
        hash.update(relPath); hash.update('\0');
        hash.update(hashTree(full)); hash.update('\0');
    }
    for (const relPath of ['scripts/package-licenses.cjs', 'THIRD-PARTY-NOTICES.md', 'scope-extension/style/fonts/FONT-LICENSE.txt']) {
        const file = path.join(desktop, relPath);
        if (fs.existsSync(file)) { hash.update(relPath); hash.update(fs.readFileSync(file)); }
    }
    hash.update(courseExamplesStamp(desktop));
    if (host === 'darwin') { hash.update(tutorTools.stamp(desktop, thinArchs.map(a => `darwin-${a}`))); }
    return hash.digest('hex');
}

function included(relPath) {
    if (EXCLUDE_NESTED.some(re => re.test(relPath))) { return false; }
    if (EXCLUDE.some(re => re.test(relPath))) { return false; }
    return true;
}

function collectInputs(dir, base = dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = path.relative(base, full).split(path.sep).join('/');
        if (!included(relPath)) { continue; }
        if (entry.isDirectory()) {
            collectInputs(full, base, out);
        } else if (entry.isFile() || entry.isSymbolicLink()) {
            out.push(relPath);
        }
    }
    return out;
}

function computeStamp(arch) {
    const hash = crypto.createHash('sha256');
    const files = collectInputs(desktop).sort();
    for (const relPath of files) {
        hash.update(relPath); hash.update('\0');
        hash.update(fs.readFileSync(path.join(desktop, relPath))); hash.update('\0');
    }
    hash.update(JSON.stringify({
        targetArch: arch,
        node: NODE_VERSION,
        electron: ELECTRON_VERSION,
        packager: PACKAGER_VERSION,
        universal: UNIVERSAL_VERSION,
    }));
    return { stamp: hash.digest('hex'), files };
}

// Dependency-install stamp: lockfile and package manifests only. A
// matching install stamp proves the workspace node_modules + rebuilt
// native ABI outputs stay reusable across compiler-input changes.
const INSTALL_INPUTS = [
    'package.json', 'package-lock.json',
    'electron-app/package.json', 'browser-app/package.json',
    'scope-extension/package.json',
];
function computeInstallStamp(arch) {
    const hash = crypto.createHash('sha256');
    for (const relPath of INSTALL_INPUTS) {
        const full = path.join(desktop, relPath);
        hash.update(relPath); hash.update('\0');
        hash.update(fs.existsSync(full) ? fs.readFileSync(full) : ''); hash.update('\0');
    }
    hash.update(JSON.stringify({
        targetArch: arch,
        node: NODE_VERSION,
        electron: ELECTRON_VERSION,
    }));
    return hash.digest('hex');
}

function copyInputs(workDesktop) {
    const files = collectInputs(desktop);
    for (const relPath of files) {
        const from = path.join(desktop, relPath);
        const to = path.join(workDesktop, relPath);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) {
            fs.symlinkSync(fs.readlinkSync(from), to);
        } else {
            fs.copyFileSync(from, to);
        }
    }
}

function nodeEnv(nodeBin, workDesktop, arch) {
    const pathKey = Object.keys(process.env)
        .find(key => key.toLowerCase() === 'path') || 'PATH';
    // Theia's ffmpeg/electron caches live under os.tmpdir() keyed by
    // version only; isolating TMPDIR per arch stops a foreign-arch cache
    // hit from contaminating this target.
    const tmpdir = path.join(packageRoot, `tmp-${arch}`);
    fs.mkdirSync(tmpdir, { recursive: true });
    return {
        ...process.env,
        TMPDIR: tmpdir,
        // Keeps node-gyp/packaged native builds pinned to the declared
        // minimum so packaged slices never demand a newer macOS.
        ...(host === 'darwin' ? { MACOSX_DEPLOYMENT_TARGET: MIN_OS } : {}),
        [pathKey]: [path.dirname(nodeBin),
            path.join(workDesktop, 'node_modules', '.bin'),
            process.env[pathKey] || ''].join(path.delimiter),
    };
}

// Every compiled addon inside the built app must match the target slice;
// a foreign `node`/`node-gyp` earlier in npm's .bin chain silently produces
// host-arch binaries otherwise.
function syncDarwinPrebuilds(workDesktop, arch) {
    // Theia emits lib/prebuilds only for the build arch; populate the
    // other macOS arch from node-pty's shipped prebuilds so both thin
    // apps carry identical paths for the universal merge.
    const shipped = path.join(workDesktop, 'node_modules',
        'node-pty', 'prebuilds');
    const libPrebuilds = path.join(workDesktop, 'electron-app',
        'lib', 'prebuilds');
    for (const entry of fs.readdirSync(shipped)) {
        if (!entry.startsWith('darwin-')) { continue; }
        fs.cpSync(path.join(shipped, entry),
            path.join(libPrebuilds, entry), { recursive: true });
    }
    const expected = arch === 'arm64' ? 'arm64' : 'x86_64';
    for (const entry of fs.readdirSync(
        path.join(libPrebuilds, `darwin-${arch}`))) {
        const archs = execFileSync('lipo', ['-archs',
            path.join(libPrebuilds, `darwin-${arch}`, entry)],
            { encoding: 'utf8' }).trim();
        if (archs !== expected) {
            fail(`prebuild ${entry} is [${archs}], expected ${expected}`);
        }
    }
}

// Windows PE: MZ header, PE\0\0 signature, IMAGE_FILE_MACHINE_AMD64.
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

function assertNativeArch(workDesktop, arch) {
    const bad = [];
    const walk = dir => {
        if (!fs.existsSync(dir)) { return; }
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (host === 'darwin'
                && (entry.name.endsWith('.node') || entry.name === 'rg')) {
                const expected = arch === 'arm64' ? 'arm64' : 'x86_64';
                const archs = execFileSync('lipo', ['-archs', full],
                    { encoding: 'utf8' }).trim();
                if (archs !== expected) { bad.push(`${rel(full)} [${archs}]`); }
            } else if (host === 'win32'
                && /\.(node|exe|dll)$/.test(entry.name)) {
                if (!isPeX64(full)) { bad.push(`${rel(full)} [not PE x64]`); }
            }
        }
    };
    walk(path.join(workDesktop, 'electron-app', 'lib', 'backend', 'native'));
    if (bad.length) {
        fail(`target arch ${arch} violated by built addons:\n  ${bad.join('\n  ')}`);
    }
}

// Incremental source sync for the install-reuse path: copy current
// inputs, then delete only paths that a previous run copied but which
// are no longer included. node_modules and native outputs survive.
function syncInputs(workDesktop, previousFiles) {
    const current = new Set(collectInputs(desktop));
    for (const relPath of previousFiles || []) {
        if (!current.has(relPath)) {
            fs.rmSync(path.join(workDesktop, relPath), { force: true });
        }
    }
    for (const relPath of current) {
        const from = path.join(desktop, relPath);
        const to = path.join(workDesktop, relPath);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        const stat = fs.lstatSync(from);
        if (stat.isSymbolicLink()) {
            fs.rmSync(to, { force: true });
            fs.symlinkSync(fs.readlinkSync(from), to);
        } else {
            fs.copyFileSync(from, to);
        }
    }
}

function writePackagingEsbuild(workDesktop) {
    fs.copyFileSync(path.join(__dirname, 'packaged-esbuild.mjs'),
        path.join(workDesktop, 'electron-app', 'esbuild.mjs'));
}

function assertWindowsBuildPrerequisites(workDesktop) {
    if (host !== 'win32') { return; }
    // npm can silently omit this optional native package after node-gyp fails,
    // while Theia's Windows backend still requires it for the production build.
    if (!fs.existsSync(path.join(workDesktop,
        'node_modules/@vscode/windows-ca-certs/build/Release/crypt32.node'))) {
        fail('Windows certificate module was not built. Install the matching '
            + 'VS 2022 C++ x64/x86 Spectre-mitigated libraries and Windows SDK, '
            + 'then rerun npm ci in the isolated packaging workspace. '
            + 'Do not disable Spectre mitigation to bypass this requirement.');
    }
}

async function buildWorkspace(arch) {
    const workDesktop = path.join(packageRoot, `work-${arch}`, 'desktop');
    const stampFile = path.join(packageRoot, `work-${arch}`, '.stamp');
    const { stamp, files } = computeStamp(arch);
    const install = computeInstallStamp(arch);
    let stored = {};
    try { stored = JSON.parse(fs.readFileSync(stampFile, 'utf8')); } catch { /* none */ }
    const built = fs.existsSync(path.join(workDesktop,
        'electron-app', 'lib', 'frontend', 'index.html'));

    const nodeBin = await ensureNode(arch);
    const env = nodeEnv(nodeBin, workDesktop, arch);
    const npmCli = resolveNpmCli(nodeBin);
    const theiaCli = path.join(workDesktop,
        'node_modules', '@theia', 'cli', 'bin', 'theia.js');
    const electronAppDir = path.join(workDesktop, 'electron-app');
    const installReusable = stored.install === install
        && fs.existsSync(path.join(workDesktop, 'node_modules'));

    if (stored.compiler === stamp && installReusable && built) {
        assertWindowsBuildPrerequisites(workDesktop);
        if (host === 'darwin') { syncDarwinPrebuilds(workDesktop, arch); }
        assertNativeArch(workDesktop, arch);
        console.log(`package-electron: work-${arch} stamps current `
            + `(${files.length} inputs), reusing build`);
        return workDesktop;
    }

    if (!installReusable) {
        fs.rmSync(path.dirname(workDesktop), { recursive: true, force: true });
        fs.mkdirSync(workDesktop, { recursive: true });
        console.log(`package-electron: staging ${files.length} source `
            + `inputs into ${rel(workDesktop)}`);
        copyInputs(workDesktop);
        // Target Node first so npm lifecycle scripts (install/rebuild
        // hooks) run under it and observe the target architecture.
        run(nodeBin, [npmCli, 'ci'], { cwd: workDesktop, env });
    } else {
        console.log(`package-electron: work-${arch} install reusable; `
            + 'syncing changed compiler inputs');
        syncInputs(workDesktop, stored.inputList);
    }
    assertWindowsBuildPrerequisites(workDesktop);
    writePackagingEsbuild(workDesktop);
    run(nodeBin, [npmCli, 'run', 'compile', '--workspace', '@scope/studio-extension'],
        { cwd: workDesktop, env });
    if (!installReusable) {
        run(nodeBin, [theiaCli, 'rebuild:electron', '--cacheRoot', workDesktop],
            { cwd: electronAppDir, env });
    }
    run(nodeBin, [theiaCli, 'build', '--mode', 'production'],
        { cwd: electronAppDir, env });
    if (host === 'darwin') { syncDarwinPrebuilds(workDesktop, arch); }
    assertNativeArch(workDesktop, arch);
    fs.writeFileSync(stampFile, JSON.stringify({
        compiler: stamp,
        install,
        inputs: files.length,
        inputList: files,
        builtAt: new Date().toISOString(),
    }));
    return workDesktop;
}

// --------------------------------------------------------- app input

function copyRuntimePackages(workDesktop, appInput) {
    // Runtime externals kept outside the webpack bundles. Optional native
    // ws accelerators (bufferutil/utf-8-validate) are try/catch-guarded and
    // intentionally omitted.
    const needed = new Set(['ajv', 'ajv-formats']);
    const queue = [...needed];
    const rootNm = path.join(workDesktop, 'node_modules');
    while (queue.length) {
        const name = queue.shift();
        const pkgJson = require.resolve(`${name}/package.json`, { paths: [rootNm] });
        const pkgDir = path.dirname(pkgJson);
        const dest = path.join(appInput, 'node_modules', name);
        if (!fs.existsSync(dest)) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.cpSync(pkgDir, dest, { recursive: true });
        }
        const pkg = JSON.parse(fs.readFileSync(pkgJson, 'utf8'));
        for (const dep of Object.keys(pkg.dependencies || {})) {
            if (!needed.has(dep)) { needed.add(dep); queue.push(dep); }
        }
    }
}

// Runtime resource bin dirs are scoped to the packaged platform:
// universal keeps both darwin slices (the merge requires identical app
// trees), a thin build keeps only its own, Windows keeps win32-x64.
function keepBinDirs(arch, universal) {
    if (host === 'win32') { return [`win32-${arch}`]; }
    return universal ? ['darwin-arm64', 'darwin-x64'] : [`darwin-${arch}`];
}

// Only esbuild's top-level, single-entry __commonJS/__esm metadata maps
// may be renamed. Their generated wrappers select the first property; the
// label is not a require path. Runtime strings and all method bodies remain
// byte-for-byte untouched, including strings containing the same paths.
function normalizeNativeModuleKeys(text, arch) {
    if (!text.includes('node-file:')
        && !text.includes(`@parcel/watcher-darwin-${arch}`)) { return text; }
    const ts = require('typescript');
    const ast = ts.createSourceFile('bundle.js', text, ts.ScriptTarget.ESNext,
        false, ts.ScriptKind.JS);
    if (ast.parseDiagnostics.length) {
        throw new Error('Cannot normalize native module keys in invalid JavaScript.');
    }
    const work = path.join(packageRoot, `work-${arch}`, 'desktop')
        .split(path.sep).join('/');
    const nativePrefix = `node-file:${work}/`;
    const parcel = `@parcel/watcher-darwin-${arch}/`;
    const edits = [];
    for (const statement of ast.statements) {
        if (!ts.isVariableStatement(statement)) { continue; }
        for (const declaration of statement.declarationList.declarations) {
            const call = declaration.initializer;
            if (!ts.isIdentifier(declaration.name) || !call
                || !ts.isCallExpression(call) || !ts.isIdentifier(call.expression)
                || call.arguments.length !== 1) { continue; }
            const helper = call.expression.text;
            const generatedName = helper === '__commonJS' ? /^require_[\w$]+$/
                : helper === '__esm' ? /^init_[\w$]+$/ : undefined;
            if (!generatedName?.test(declaration.name.text)) { continue; }
            const map = call.arguments[0];
            if (!ts.isObjectLiteralExpression(map) || map.properties.length !== 1) { continue; }
            const method = map.properties[0];
            if (!ts.isMethodDeclaration(method) || !ts.isStringLiteral(method.name)) { continue; }
            const original = method.name.text;
            const label = original.replace(/\\/g, '/');
            if (!label.endsWith('.node')) { continue; }
            let normalized = label;
            if (label.startsWith(nativePrefix)) {
                normalized = `node-file:PACKAGE_DESKTOP/${label.slice(nativePrefix.length)}`;
            } else if (!label.startsWith(`../node_modules/${parcel}`)) {
                continue;
            }
            normalized = normalized.replace(parcel, '@parcel/watcher-darwin-arch/');
            if (normalized !== original) {
                edits.push({
                    start: method.name.getStart(ast),
                    end: method.name.end,
                    value: JSON.stringify(normalized),
                });
            }
        }
    }
    for (const edit of edits.sort((a, b) => b.start - a.start)) {
        text = text.slice(0, edit.start) + edit.value + text.slice(edit.end);
    }
    return text;
}

function sanitizeNodeFileKeys(libDest, arch) {
    const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) { visit(p); continue; }
            if (!entry.name.endsWith('.js')) { continue; }
            const text = fs.readFileSync(p, 'utf8');
            const normalized = normalizeNativeModuleKeys(text, arch);
            if (normalized !== text) { fs.writeFileSync(p, normalized); }
        }
    };
    visit(libDest);
}

function buildAppInput(arch, workDesktop, universal) {
    const appInput = path.join(packageRoot, `app-${arch}`);
    fs.rmSync(appInput, { recursive: true, force: true });
    fs.mkdirSync(appInput, { recursive: true });

    // Bundled frontend+backend output; maps are excluded from the artifact.
    const libSrc = path.join(workDesktop, 'electron-app', 'lib');
    if (!fs.existsSync(path.join(libSrc, 'frontend', 'index.html'))) {
        fail(`${rel(libSrc)} incomplete (index.html missing) — build first`);
    }
    const copyLib = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (entry.name.endsWith('.map')) { continue; }
            const from = path.join(src, entry.name);
            const to = path.join(dest, entry.name);
            if (entry.isDirectory()) { copyLib(from, to); }
            else { fs.copyFileSync(from, to); }
        }
    };
    copyLib(libSrc, path.join(appInput, 'lib'));
    sanitizeNodeFileKeys(path.join(appInput, 'lib'), arch);

    fs.copyFileSync(path.join(__dirname, 'packaged-entry.cjs'),
        path.join(appInput, 'main.cjs'));
    fs.mkdirSync(path.join(appInput, 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(__dirname, 'launch.cjs'),
        path.join(appInput, 'scripts', 'launch.cjs'));
    fs.copyFileSync(path.join(desktop, 'THIRD-PARTY-NOTICES.md'),
        path.join(appInput, 'THIRD-PARTY-NOTICES.md'));
    fs.copyFileSync(path.join(repo, 'LICENSE'),
        path.join(appInput, 'LICENSE'));

    fs.writeFileSync(path.join(appInput, 'package.json'), JSON.stringify({
        name: 'nodu-ide',
        productName: '见微 Nodu',
        version: applicationVersion,
        author: 'Nodu',
        license: 'MIT',
        main: 'main.cjs',
    }, null, 2) + '\n');

    // Runtime seam: createRequire('@scope/studio-extension/package.json')
    // resolves inside the app to locate resources/bin, media, examples,
    // WASM glue and license materials.
    const extDest = path.join(appInput, 'node_modules', '@scope', 'studio-extension');
    fs.mkdirSync(extDest, { recursive: true });
    fs.copyFileSync(path.join(desktop, 'scope-extension', 'package.json'),
        path.join(extDest, 'package.json'));
    const resSrc = path.join(desktop, 'scope-extension', 'resources');
    const copyRes = (src, dest) => {
        fs.mkdirSync(dest, { recursive: true });
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
            if (entry.name === '__pycache__' || entry.name === '.DS_Store') { continue; }
            const from = path.join(src, entry.name);
            const to = path.join(dest, entry.name);
            if (entry.isDirectory()) { copyRes(from, to); }
            else { fs.copyFileSync(from, to); }
        }
    };
    const resDest = path.join(extDest, 'resources');
    // Top-level resource *files* copy straight to resDest, so it must exist
    // before the loop — NTFS returns entries alphabetically (api-index.json
    // first), while APFS happened to yield `bin` first and masked this.
    fs.mkdirSync(resDest, { recursive: true });
    for (const entry of fs.readdirSync(resSrc, { withFileTypes: true })) {
        if (['toolkits','wasi'].includes(entry.name)) { continue; }
        if (entry.name === 'bin') {
            for (const archDir of keepBinDirs(arch, universal)) {
                const dir = path.join(resSrc, 'bin', archDir);
                if (!fs.existsSync(dir)) {
                    fail(`missing scoped bin dir resources/bin/${archDir}`);
                }
                copyRes(dir, path.join(resDest, 'bin', archDir));
            }
            continue;
        }
        const from = path.join(resSrc, entry.name);
        const to = path.join(resDest, entry.name);
        if (entry.isDirectory()) { copyRes(from, to); }
        else { fs.copyFileSync(from, to); }
    }
    if (host === 'darwin') { tutorTools.copy(desktop, resDest, keepBinDirs(arch, universal)); }
    copyCourseExamples(desktop, path.join(resDest, 'project-examples'));
    // A Windows package reports its per-target media record as the top-level
    // media metadata; the darwin-universal record would describe the wrong
    // files. Shared license/source materials stay in place either way.
    if (host === 'win32') {
        fs.copyFileSync(
            path.join(resDest, 'licenses', 'ffmpeg', 'win32-x64', 'metadata.json'),
            path.join(resDest, 'licenses', 'ffmpeg', 'metadata.json'));
    }

    const stm32 = require('./package-stm32.cjs');
    stm32.copyToolkit(stm32.toolkitSource(desktop, host, arch), resDest, host, arch);
    copyRes(path.join(desktop, 'plugins'), path.join(appInput, 'plugins'));
    copyRuntimePackages(workDesktop, appInput);
    require('./package-licenses.cjs').collectPackageLicenses({ desktop, workDesktop, appInput });
    fs.writeFileSync(path.join(appInput, 'build-info.json'), JSON.stringify({
        version: applicationVersion, ...sourceIdentity(),
        compilerInputs: universal
            ? { arm64: computeStamp('arm64').stamp, x64: computeStamp('x64').stamp }
            : { [arch]: computeStamp(arch).stamp },
        runtimeResources: runtimeResourcesStamp(),
    }, null, 2) + '\n');
    return appInput;
}

// --------------------------------------------------------- packaging

// Project-owned universal macos-trash (scripts/macos-trash.swift)
// replaces the x86_64-only binary vendored by the `trash` package, so the
// arm64 slice never depends on Rosetta for a helper.
function buildMacosTrash() {
    const dir = path.join(packageRoot, 'macos-trash');
    const out = path.join(dir, 'macos-trash');
    const src = path.join(__dirname, 'macos-trash.swift');
    const srcSha = sha256File(src);
    const marker = path.join(dir, '.sha256-verified');
    if (fs.existsSync(out) && fs.existsSync(marker)
        && fs.readFileSync(marker, 'utf8') === srcSha) {
        return out;
    }
    fs.mkdirSync(dir, { recursive: true });
    const slices = [];
    for (const target of ['arm64-apple-macosx15.0',
        'x86_64-apple-macosx15.0']) {
        const slice = path.join(dir, `macos-trash-${target.split('-')[0]}`);
        run('xcrun', ['swiftc', '-O', '-target', target, '-o', slice, src]);
        slices.push(slice);
    }
    run('lipo', ['-create', '-output', out, ...slices]);
    run('codesign', ['-s', '-', '-f', out]);
    const archs = execFileSync('lipo', ['-archs', out], { encoding: 'utf8' })
        .trim().split(' ').sort();
    if (archs.join(',') !== 'arm64,x86_64') {
        fail(`macos-trash helper not universal: [${archs}]`);
    }
    fs.writeFileSync(marker, srcSha);
    return out;
}

async function packageThin(arch, appInput) {
    const { packager } = require('@electron/packager');
    // A missing icon silently falls back to the Electron default artwork;
    // fail instead of shipping an unbranded app.
    const icon = path.join(repo, 'brand', 'assets',
        host === 'darwin' ? 'Nodu.icns' : 'Nodu.ico');
    if (!fs.existsSync(icon)) {
        fail(`required app icon missing: ${rel(icon)}`);
    }
    const opts = {
        dir: appInput,
        name: 'Nodu',
        appBundleId: 'org.scope.studio',
        appVersion: applicationVersion,
        electronVersion: ELECTRON_VERSION,
        download: { checksums: ELECTRON_SHA256 },
        platform: host,
        arch,
        asar: false,
        prune: false,
        ignore: ignorePackagedPath,
        overwrite: true,
        appCategoryType: 'public.app-category.developer-tools',
        darwinDarkModeSupport: true,
        extendInfo: host === 'darwin' ? { LSMinimumSystemVersion: MIN_OS } : undefined,
        out: path.join(packageRoot, 'thin'),
        icon,
    };
    console.log(`package-electron: packager ${host}-${arch} -> ${rel(opts.out)}`);
    const [outDir] = await packager(opts);
    if (host === 'darwin') {
        const expected = arch === 'arm64' ? 'arm64' : 'x86_64';
        const exe = path.join(outDir, 'Nodu.app', 'Contents', 'MacOS', 'Nodu');
        const archs = execFileSync('lipo', ['-archs', exe], { encoding: 'utf8' }).trim();
        if (archs !== expected) {
            fail(`thin app executable arch [${archs}], expected ${expected}`);
        }
        const bundledTrash = path.join(outDir, 'Nodu.app', 'Contents',
            'Resources', 'app', 'lib', 'backend', 'macos-trash');
        if (!fs.existsSync(bundledTrash)) {
            fail(`packaged app lacks lib/backend/macos-trash at ${rel(bundledTrash)}`);
        }
        fs.copyFileSync(buildMacosTrash(), bundledTrash);
        fs.chmodSync(bundledTrash, 0o755);
    }
    return outDir;
}

function ignorePackagedPath(file) {
    const name = file.replaceAll('\\', '/');
    // Packager's default *.o exclusion removes the cross-compiler's crt and
    // support objects. These are runtime toolchain inputs, not build debris.
    if (/\.o(bj)?$/.test(name)) {
        return !/\/resources\/(?:toolkits|wasi)\//.test(name);
    }
    return /\/(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(name)
        || /\/\.git(?:$|\/)|\/node_modules\/\.bin(?:$|\/)|\/node_gyp_bins(?:$|\/)/.test(name);
}

// Thin 32/64-bit and fat 32/64-bit Mach-O magics in both byte orders.
const MACHO_MAGICS = new Set([
    0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe,
    0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
function isMachO(file) {
    let fd;
    try {
        fd = fs.openSync(file, 'r');
    } catch { return false; }
    try {
        const head = Buffer.alloc(4);
        if (fs.readSync(fd, head, 0, 4, 0) !== 4) { return false; }
        return MACHO_MAGICS.has(head.readUInt32BE(0));
    } finally { fs.closeSync(fd); }
}

function signAppDarwin(appPath) {
    const files = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory() && !entry.name.endsWith('.app')) { walk(full); }
            else if (entry.isDirectory() && entry.name.endsWith('.app')) { walk(full); }
            else if (entry.isFile() && isMachO(full)) { files.push(full); }
        }
    };
    walk(appPath);
    // Deepest first so nested code is signed before the bundles holding it.
    // --preserve-metadata keeps each binary's existing entitlements/flags
    // (not the upstream certificate requirements) across the ad-hoc
    // re-sign; only the outer app receives our declared entitlements.
    files.sort((a, b) => b.split('/').length - a.split('/').length);
    for (const file of files) {
        execFileSync('codesign', ['-s', '-', '-f',
            '--preserve-metadata=entitlements,flags', file]);
    }
    require('./package-stm32.cjs').refreshManifests(appPath);
    tutorTools.refreshManifests(appPath);
    const nestedApps = [];
    const findApps = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name.endsWith('.app') && full !== appPath) { nestedApps.push(full); }
                findApps(full);
            }
        }
    };
    findApps(path.join(appPath, 'Contents'));
    nestedApps.sort((a, b) => b.split('/').length - a.split('/').length);
    for (const nested of nestedApps) {
        execFileSync('codesign', ['-s', '-', '-f',
            '--preserve-metadata=entitlements,flags', nested]);
    }
    execFileSync('codesign',
        ['-s', '-', '-f', '--entitlements', ENTITLEMENTS, appPath]);
    execFileSync('codesign', ['--verify', '--deep', '--strict', '-v', appPath],
        { stdio: 'inherit' });
    console.log('package-electron: ad-hoc signature verified (--deep --strict)');
}

// Every Mach-O slice in the merged app must be deployable at the declared
// minimum. A missing LC_BUILD_VERSION/LC_VERSION_MIN_MACOSX or a slice
// above the target is reported, not silently accepted.
function auditMinOs(appPath) {
    const violations = [];
    const walk = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); }
            else if (entry.isFile() && isMachO(full)) {
                const out = execFileSync('vtool', ['-show-build', full],
                    { encoding: 'utf8' });
                const mins = [...out.matchAll(/minos (\d+\.\d+)/g)]
                    .map(m => m[1]);
                // Older binaries (e.g. node-pty prebuilds) declare the
                // deployment target via LC_VERSION_MIN_MACOSX instead of
                // LC_BUILD_VERSION; scope the match to that load command so
                // tool/sdk version fields are not mistaken for minOS.
                for (const m of out.matchAll(/LC_VERSION_MIN_MACOSX\s*\n\s*cmdsize\s+\d+\s*\n\s*version\s+(\d+\.\d+)/g)) {
                    mins.push(m[1]);
                }
                if (!mins.length) {
                    violations.push(`${rel(full)} [no minos record]`);
                }
                for (const min of mins) {
                    const [maj, minr] = min.split('.').map(Number);
                    const [tMaj, tMin] = MIN_OS.split('.').map(Number);
                    if (maj > tMaj || (maj === tMaj && minr > tMin)) {
                        violations.push(`${rel(full)} [minos ${min}]`);
                    }
                }
            }
        }
    };
    walk(appPath);
    if (violations.length) {
        fail(`packaged binaries exceed minimum macOS ${MIN_OS} `
            + `or lack a deployment record:\n  ${violations.join('\n  ')}`);
    }
    console.log(`package-electron: minOS <= ${MIN_OS} verified on all slices`);
}

// Per-arch backend JS is built unminified (scripts/packaged-esbuild.mjs)
// but can still differ in comments/formatting. Two bundles are the same
// program only when their parsed ASTs are identical modulo trivia; any
// identifier, literal or structural difference fails the package rather
// than being silently equated. Use the TypeScript parser/printer instead of
// projecting selected AST fields and possibly losing semantic distinctions.
function canonicalJs(file) {
    const ts = require('typescript');
    const text = fs.readFileSync(file, 'utf8');
    const ast = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext,
        true, ts.ScriptKind.JS);
    if (ast.parseDiagnostics && ast.parseDiagnostics.length) {
        fail(`unparseable bundled JS ${rel(file)}: `
            + ast.parseDiagnostics[0].messageText);
    }
    const normalizeLayout = node => {
        if (ts.isBlock(node) || ts.isObjectLiteralExpression(node)
            || ts.isArrayLiteralExpression(node)) {
            ts.setEmitFlags(node, ts.getEmitFlags(node) | ts.EmitFlags.SingleLine);
        }
        ts.forEachChild(node, normalizeLayout);
    };
    normalizeLayout(ast);
    return ts.createPrinter({
        removeComments: true,
        newLine: ts.NewLineKind.LineFeed,
    }).printFile(ast);
}

function canonizeJsForMerge(arm64Root, x64Root) {
    const queue = ['.'];
    const canonicalized = [];
    while (queue.length) {
        const relPath = queue.shift();
        const armPath = path.join(arm64Root, relPath);
        const x64Path = path.join(x64Root, relPath);
        const armStat = fs.statSync(armPath);
        const x64Stat = fs.statSync(x64Path);
        if (armStat.isDirectory() || x64Stat.isDirectory()) {
            if (!armStat.isDirectory() || !x64Stat.isDirectory()) {
                fail(`app tree mismatch at ${relPath}`);
            }
            for (const entry of fs.readdirSync(armPath)) {
                queue.push(path.join(relPath, entry));
            }
            continue;
        }
        if (!relPath.endsWith('.js') || isMachO(armPath)
            || fs.readFileSync(armPath).equals(fs.readFileSync(x64Path))) {
            continue;
        }
        if (canonicalJs(armPath) !== canonicalJs(x64Path)) {
            fail(`bundled JS diverges between architectures: ${relPath} `
                + '(AST differs beyond comments/formatting — inspect, '
                + 'do not bypass)');
        }
        fs.copyFileSync(armPath, x64Path);
        canonicalized.push(relPath);
    }
    if (canonicalized.length) {
        console.log('package-electron: canonicalized format-only JS '
            + `from arm64 for merge:\n  ${canonicalized.join('\n  ')}`);
    }
}

async function packageMacUniversal() {
    const thinApps = {};
    for (const arch of ['arm64', 'x64']) {
        const workDesktop = await buildWorkspace(arch);
        const appInput = buildAppInput(arch, workDesktop, true);
        thinApps[arch] = path.join(await packageThin(arch, appInput), 'Nodu.app');
        if (!fs.existsSync(thinApps[arch])) {
            fail(`thin ${arch} app missing at ${thinApps[arch]}`);
        }
    }
    prepareUniversalLicenses(
        path.join(thinApps.arm64, 'Contents', 'Resources', 'app'),
        path.join(thinApps.x64, 'Contents', 'Resources', 'app'));
    require('./package-stm32.cjs').prepareUniversal(thinApps.arm64, thinApps.x64);
    canonizeJsForMerge(
        path.join(thinApps.arm64, 'Contents', 'Resources', 'app'),
        path.join(thinApps.x64, 'Contents', 'Resources', 'app'));
    fs.mkdirSync(distDir, { recursive: true });
    const outApp = path.join(distDir, 'Nodu.app');
    fs.rmSync(outApp, { recursive: true, force: true });
    const { makeUniversalApp } = require('@electron/universal');
    console.log('package-electron: merging thin apps into universal');
    await makeUniversalApp({
        x64AppPath: thinApps.x64,
        arm64AppPath: thinApps.arm64,
        outAppPath: outApp,
        mergeASARs: false,
        // Same-SHA single-arch mach-o files are kept as one copy instead
        // of being lipo'd: our darwin-* sidecar/prebuild trees are
        // byte-identical across thin apps (each arch dir already holds
        // its own slice). macos-trash is a universal project-built
        // binary by the time we get here.
        x64ArchFiles: '**/darwin-*/**',
    });
    writeMacArtifacts(outApp, 'universal');
}

function prepareUniversalLicenses(arm64Root, x64Root) {
    // Optional native npm packages differ by architecture. Keep both inventories
    // verbatim in both thin apps before the universal byte comparison.
    const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-universal-licenses-'));
    try {
        for (const [arch, root] of [['arm64', arm64Root], ['x64', x64Root]]) {
            const from = path.join(root, 'licenses');
            if (!fs.existsSync(path.join(from, 'INDEX.json'))) {
                throw new Error(`Missing ${arch} package license inventory`);
            }
            fs.cpSync(from, path.join(staging, arch), { recursive: true });
        }
        for (const root of [arm64Root, x64Root]) {
            const destination = path.join(root, 'licenses');
            fs.rmSync(destination, { recursive: true });
            fs.cpSync(staging, destination, { recursive: true });
        }
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
}

function sourceIdentity() {
    try {
        return {
            sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
            sourceDirty: !!execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: repo, encoding: 'utf8' }).trim(),
        };
    } catch {
        return { sourceCommit: process.env.NODU_SOURCE_COMMIT || null, sourceDirty: null };
    }
}

function writeMacArtifacts(appPath, arch) {
    auditMinOs(appPath);
    signAppDarwin(appPath);
    fs.mkdirSync(distDir, { recursive: true });
    const stem = `Nodu-${applicationVersion}-mac-${arch}`;
    const zip = path.join(distDir, `${stem}.zip`);
    fs.rmSync(zip, { force: true });
    execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent',
        appPath, zip]);
    // A plain drag-to-install image keeps installation independent of shell
    // scripts, administrator rights and project/user configuration.
    const imageRoot = fs.mkdtempSync(path.join(packageRoot, 'dmg-'));
    const dmg = path.join(distDir, `${stem}.dmg`);
    try {
        execFileSync('ditto', [appPath, path.join(imageRoot, 'Nodu.app')]);
        fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
        fs.rmSync(dmg, { force: true });
        execFileSync('hdiutil', ['create', '-volname', `Nodu ${applicationVersion}`,
            '-srcfolder', imageRoot, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' });
        execFileSync('hdiutil', ['verify', dmg], { stdio: 'inherit' });
    } finally {
        fs.rmSync(imageRoot, { recursive: true, force: true });
    }
    const artifacts = [zip, dmg].map(file => ({
        name: path.basename(file), size: fs.statSync(file).size, sha256: sha256File(file),
    }));
    const manifest = {
        version: applicationVersion, ...sourceIdentity(),
        targetPlatform: `darwin-${arch}`,
        artifacts,
        electron: ELECTRON_VERSION,
        node: NODE_VERSION,
        packager: PACKAGER_VERSION,
        signing: 'ad-hoc (codesign -s -); NOT Developer ID signed, NOT notarized',
        minimumSystem: MIN_OS,
        runtimeResources: runtimeResourcesStamp(),
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(distDir, `${stem}.manifest.json`),
        JSON.stringify(manifest, null, 2) + '\n');
    fs.writeFileSync(path.join(distDir, `${stem}.sha256`),
        artifacts.map(item => `${item.sha256}  ${item.name}`).join('\n') + '\n');
    console.log(`package-electron: ${rel(zip)}`);
    console.log(`package-electron: ${rel(dmg)}`);
}

async function packageWindows() {
    // Runs only on a Windows host with win32 media/native inputs present.
    const workDesktop = await buildWorkspace('x64');
    const appInput = buildAppInput('x64', workDesktop, false);
    const out = await packageThin('x64', appInput);
    const portable = path.join(distDir, 'Nodu-win32-x64');
    fs.mkdirSync(distDir, { recursive: true });
    fs.rmSync(portable, { recursive: true, force: true });
    fs.cpSync(out, portable, { recursive: true });
    const zip = path.join(distDir, `Nodu-${applicationVersion}-win32-x64.zip`);
    fs.rmSync(zip, { force: true });
    // GNU tar reads `host:file` in -f as remote-tape syntax; the zip target
    // must be a basename with cwd, not a drive-letter path (same failure as
    // build-media-windows.cjs hit on the real Windows run).
    execFileSync('tar', ['-a', '-cf', path.basename(zip), 'Nodu-win32-x64'],
        { cwd: distDir });
    const manifest = {
        version: applicationVersion,
        targetPlatform: 'win32-x64',
        ...sourceIdentity(),
        artifact: path.basename(zip),
        sha256: sha256File(zip),
        electron: ELECTRON_VERSION,
        node: NODE_VERSION,
        signing: 'unsigned portable zip; no installer, no Authenticode',
        runtimeResources: runtimeResourcesStamp(),
        generatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(distDir, 'manifest.json'),
        JSON.stringify(manifest, null, 2) + '\n');
    console.log(`package-electron: ${rel(zip)}`);
}

async function main() {
    if (values.stamp) {
        // Diagnostic: print the compiler-input stamp and resource hash,
        // then exit without building.
        const { stamp, files } = computeStamp('universal');
        const out = { compiler: stamp, inputs: files.length,
            runtimeResources: runtimeResourcesStamp() };
        for (const arch of ['arm64', 'x64']) {
            out[`compiler-${arch}`] = computeStamp(arch).stamp;
            out[`install-${arch}`] = computeInstallStamp(arch);
        }
        console.log(JSON.stringify(out, null, 2));
        return;
    }
    fs.mkdirSync(packageRoot, { recursive: true });
    if (values.prepare) {
        for (const arch of thinArchs) { await buildWorkspace(arch); }
        return;
    }
    for (const arch of thinArchs) { requireInputs(arch); }
    if (host === 'darwin' && targetArch === 'universal') {
        await packageMacUniversal();
        return;
    }
    if (host === 'darwin') {
        const workDesktop = await buildWorkspace(targetArch);
        const appInput = buildAppInput(targetArch, workDesktop, false);
        const out = await packageThin(targetArch, appInput);
        writeMacArtifacts(path.join(out, 'Nodu.app'), targetArch);
        return;
    }
    await packageWindows();
}

if (require.main === module) {
    main().catch(error => fail(error.stack || String(error)));
}

module.exports = {
    canonicalJs, canonizeJsForMerge, normalizeNativeModuleKeys, computeStamp, computeInstallStamp,
    isMachO, isPeX64, keepBinDirs, resolveNpmCli, prepareUniversalLicenses, ignorePackagedPath,
};
