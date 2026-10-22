// SPDX-License-Identifier: MIT
// Assemble the STM32 toolkit (docs/0.2.1/TOOLKIT-DISTRIBUTION.md) into
// desktop/.tools/stm32/<platform>/ (generated output, gitignored).
//
// This is the development profile: components come from files already on
// this machine (the P0 Arm GNU archive and SDK checkouts, Homebrew's CMake,
// Ninja, OpenOCD and stm32flash, and Xcode's clangd). The result carries
// "profile": "dev" in toolkit.json; package-electron must not ship it.
// The release pipeline (pinned downloads, own OpenOCD/stm32flash builds,
// upstream clangd, license bundle) replaces the sources, not the layout.
//
// Usage: node scripts/build-toolkit.cjs [--p0-local DIR] [--homebrew DIR]
//        [--clangd FILE] [--out DIR] [--no-smoke]
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseArgs } = require('node:util');

const desktop = path.resolve(__dirname, '..');
const repo = path.resolve(desktop, '..');
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'tools/stm32-p0/toolchain.lock.json'), 'utf8'));
const XCODE_CLANGD = '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd';
const TOOLKIT_VERSION = '2026.11.0-dev';
// P0 recorded these BIN digests; the trimmed toolchain must reproduce them.
const SMOKE = {
    f103c8: 'fa7b5878122e240ac4d058b93f94a6df554cec7c72ba090371a6672069b03f95',
    f407zg: '8b97e496963ed1ae55a34a1ed78daafd0fbf5c910f84f2e7d4ff628c9fe79515',
};

const { values: opts } = parseArgs({
    options: {
        'p0-local': { type: 'string', default: process.env.NODU_STM32_P0_LOCAL || path.join(repo, '.local/stm32-p0') },
        homebrew: { type: 'string', default: '/opt/homebrew' },
        clangd: { type: 'string', default: XCODE_CLANGD },
        out: { type: 'string' },
        'no-smoke': { type: 'boolean', default: false },
    },
    strict: true,
});

function fail(message) {
    console.error(`build-toolkit: ${message}`);
    process.exit(1);
}

if (process.platform !== 'darwin') {
    fail(`the development toolkit is only assembled on macOS for now (host: ${process.platform}).`);
}
const platform = 'darwin';
const out = path.resolve(opts.out || path.join(desktop, '.tools/stm32', platform));
const p0 = path.resolve(opts['p0-local']);
const armSrc = path.join(p0, 'tools', `arm-gnu-toolchain-${lock.tools.armGnu.version}-darwin-${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-arm-none-eabi`);
const brew = (name, version) => path.join(opts.homebrew, 'Cellar', name, version);
const sources = {
    armGnu: armSrc,
    cmake: brew('cmake', lock.tools.cmake),
    ninja: brew('ninja', lock.tools.ninja),
    openocd: brew('open-ocd', lock.tools.openocd.homebrewVersion),
    stm32flash: brew('stm32flash', lock.tools.stm32flash.version),
    clangd: opts.clangd,
    'cube-f1': path.join(p0, 'sdk/cube-f1'),
    'cube-f4': path.join(p0, 'sdk/cube-f4'),
};
for (const [name, source] of Object.entries(sources)) {
    if (!fs.existsSync(source)) {
        fail(`${name} not found at ${source}. Pass --p0-local (the P0 .local/stm32-p0 directory), --homebrew or --clangd.`);
    }
}

function gitHead(dir) {
    return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}
// SDK checkouts must be exactly the commits P0 validated.
for (const [family, dir] of [['f1', sources['cube-f1']], ['f4', sources['cube-f4']]]) {
    const pin = lock.sdk[family];
    const series = family === 'f1' ? 'STM32F1xx' : 'STM32F4xx';
    const checks = [[dir, pin.commit], [path.join(dir, `Drivers/${series}_HAL_Driver`), pin.halCommit],
        [path.join(dir, `Drivers/CMSIS/Device/ST/${series}`), pin.deviceCommit]];
    for (const [checkout, commit] of checks) {
        const head = gitHead(checkout);
        if (head !== commit) fail(`${checkout} is at ${head}, lock requires ${commit}`);
    }
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// Copy one file, following symlinks so the toolkit holds no links.
function copyFile(from, to) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(fs.realpathSync(from), to);
    fs.chmodSync(to, fs.statSync(from).mode & 0o777 | 0o200);
}
// Copy a tree; `skip(rel)` returns true for paths (relative to `from`) to drop.
function copyTree(from, to, skip = () => false, rel = '') {
    for (const entry of fs.readdirSync(path.join(from, rel), { withFileTypes: true })) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.name === '.git' || entry.name === '.DS_Store' || skip(child)) continue;
        const source = path.join(from, child);
        if (fs.statSync(source).isDirectory()) copyTree(from, to, skip, child);
        else copyFile(source, path.join(to, child));
    }
}
function copyList(from, to, list) {
    for (const rel of list) {
        const source = path.join(from, rel);
        if (!fs.existsSync(source)) fail(`missing ${source}`);
        if (fs.statSync(source).isDirectory()) copyTree(source, path.join(to, rel));
        else copyFile(source, path.join(to, rel));
    }
}

// --- Arm GNU: C front end, binutils, GDB, and the M3 / M4F multilibs only.
const MULTILIBS = ['thumb/v7-m/nofp', 'thumb/v7e-m+fp/hard'];
const NOT_C = /^(libstdc\+\+|libsupc\+\+|libgfortran)/;
{
    const dest = path.join(out, 'arm-gnu');
    const tools = ['addr2line', 'ar', 'as', 'c++filt', 'cpp', 'gcc', 'gcc-ar', 'gcc-nm', 'gcc-ranlib', 'gdb',
        'ld', 'nm', 'objcopy', 'objdump', 'ranlib', 'readelf', 'size', 'strings', 'strip'];
    copyList(armSrc, dest, tools.map((tool) => `bin/arm-none-eabi-${tool}`));
    copyList(armSrc, dest, ['arm-none-eabi/bin', 'lib/bfd-plugins', `${lock.tools.armGnu.version}-darwin-${os.arch() === 'arm64' ? 'arm64' : 'x86_64'}-arm-none-eabi-manifest.txt`]);
    fs.rmSync(path.join(dest, 'arm-none-eabi/bin/ld.bfd'), { force: true });
    const gccVersion = lock.tools.armGnu.gccVersion;
    const libexec = `libexec/gcc/arm-none-eabi/${gccVersion}`;
    copyList(armSrc, dest, ['cc1', 'collect2', 'lto-wrapper', 'liblto_plugin.so'].map((f) => `${libexec}/${f}`));
    const gccLib = `lib/gcc/arm-none-eabi/${gccVersion}`;
    copyTree(path.join(armSrc, gccLib), path.join(dest, gccLib), (rel) =>
        /^(finclude|plugin|install-tools|libcaf_single\.a|sync-.*\.specs)$/.test(rel)
        || (rel.startsWith('thumb/') && !MULTILIBS.some((m) => rel === m || rel.startsWith(`${m}/`) || m.startsWith(`${rel}/`)))
        || (rel.startsWith('arm/')) || rel === 'arm');
    copyTree(path.join(armSrc, 'arm-none-eabi/include'), path.join(dest, 'arm-none-eabi/include'),
        (rel) => rel === 'c++');
    const sysLib = 'arm-none-eabi/lib';
    copyTree(path.join(armSrc, sysLib), path.join(dest, sysLib), (rel) => {
        const base = path.basename(rel);
        if (NOT_C.test(base)) return true;
        if (rel === 'arm' || rel.startsWith('arm/')) return true;
        if (rel.startsWith('thumb')) {
            return rel !== 'thumb' && !MULTILIBS.some((m) => rel === m || rel.startsWith(`${m}/`) || m.startsWith(`${rel}/`));
        }
        return false;
    });
    // The top-level (A-profile Arm) libraries are never selected for Cortex-M.
    for (const name of fs.readdirSync(path.join(dest, sysLib))) {
        if (/\.(a|o)$/.test(name)) fs.rmSync(path.join(dest, sysLib, name));
    }
    copyList(armSrc, dest, ['share/doc/arm-none-eabi/readme.txt']);
}

// --- CMake without docs and GUI; Ninja; stm32flash.
copyList(sources.cmake, path.join(out, 'cmake'), ['bin/cmake', 'bin/ctest', 'LICENSE.rst']);
copyTree(path.join(sources.cmake, 'share/cmake'), path.join(out, 'cmake/share/cmake'), (rel) => rel === 'Help');
copyList(sources.ninja, path.join(out, 'ninja'), ['bin/ninja', 'COPYING']);
copyList(sources.stm32flash, path.join(out, 'stm32flash'), ['bin/stm32flash']);

// --- OpenOCD with its scripts and non-system dylibs, rewired to @loader_path.
{
    const dest = path.join(out, 'openocd');
    copyList(sources.openocd, dest, ['bin/openocd', 'COPYING']);
    copyTree(path.join(sources.openocd, 'share/openocd/scripts'), path.join(dest, 'share/openocd/scripts'));
    const pending = [path.join(dest, 'bin/openocd')];
    const seen = new Set();
    while (pending.length) {
        const file = pending.pop();
        const deps = execFileSync('otool', ['-L', file], { encoding: 'utf8' }).split('\n').slice(1)
            .map((line) => line.trim().split(' ')[0]).filter((dep) => dep.startsWith(opts.homebrew));
        for (const dep of deps) {
            const name = path.basename(dep);
            const local = path.join(dest, 'lib', name);
            const prefix = file.includes(`${path.sep}bin${path.sep}`) ? '@loader_path/../lib' : '@loader_path';
            execFileSync('install_name_tool', ['-change', dep, `${prefix}/${name}`, file], { stdio: 'ignore' });
            if (!seen.has(name)) {
                seen.add(name);
                copyFile(dep, local);
                execFileSync('install_name_tool', ['-id', `@rpath/${name}`, local], { stdio: 'ignore' });
                pending.push(local);
            }
        }
    }
}

// --- clangd and its built-in headers (resource dir is found relative to the binary).
{
    const dest = path.join(out, 'clangd');
    copyFile(sources.clangd, path.join(dest, 'bin/clangd'));
    const clangLib = path.join(path.dirname(fs.realpathSync(sources.clangd)), '../lib/clang');
    const major = fs.readdirSync(clangLib).find((name) => /^\d+$/.test(name));
    if (!major) fail(`no clang resource dir under ${clangLib}`);
    copyTree(path.join(clangLib, major, 'include'), path.join(dest, 'lib/clang', major, 'include'));
}

// --- SDK subsets: HAL, CMSIS Core, the device headers and templates we use.
const SDK = {
    'cube-f1': { series: 'STM32F1xx', devices: ['stm32f103xb'] },
    'cube-f4': { series: 'STM32F4xx', devices: ['stm32f405xx', 'stm32f407xx'] },
};
for (const [id, { series, devices }] of Object.entries(SDK)) {
    const src = sources[id];
    const dest = path.join(out, 'sdk', id);
    const lower = series.toLowerCase();
    const device = `Drivers/CMSIS/Device/ST/${series}`;
    const hal = `Drivers/${series}_HAL_Driver`;
    copyList(src, dest, ['LICENSE.md', 'Drivers/CMSIS/Include', 'Drivers/CMSIS/LICENSE.txt',
        `${device}/LICENSE.md`, `${device}/Include/${lower}.h`, `${device}/Include/system_${lower}.h`,
        `${device}/Source/Templates/system_${lower}.c`, `${hal}/Inc`, `${hal}/Src`, `${hal}/LICENSE.md`,
        ...devices.flatMap((d) => [`${device}/Include/${d}.h`, `${device}/Source/Templates/gcc/startup_${d}.s`])]);
}

// --- Ad-hoc sign every Mach-O file (Apple Silicon refuses unsigned arm64 code).
function isMachO(file) {
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(4);
    fs.readSync(fd, head, 0, 4, 0);
    fs.closeSync(fd);
    return ['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(head.toString('hex'));
}
function walk(dir, rel = '') {
    return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        return entry.isDirectory() ? walk(dir, child) : [child];
    }).sort();
}
const files = walk(out);
let signed = 0;
for (const rel of files) {
    const file = path.join(out, rel);
    if (fs.statSync(file).size >= 4 && isMachO(file)) {
        execFileSync('codesign', ['--force', '--sign', '-', file], { stdio: 'ignore' });
        signed += 1;
    }
}

function versionOf(args) {
    return execFileSync(path.join(out, args[0]), args.slice(1), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
// OpenOCD prints its version on stderr.
function stderrVersion(args) {
    const r = require('node:child_process').spawnSync(path.join(out, args[0]), args.slice(1), { encoding: 'utf8' });
    return `${r.stdout}${r.stderr}`;
}
const clangdVersion = versionOf(['clangd/bin/clangd', '--version']).split('\n')[0];
const openocdVersion = stderrVersion(['openocd/bin/openocd', '--version']).split('\n')[0];
if (!openocdVersion.includes(lock.tools.openocd.version)) fail(`openocd does not run: ${openocdVersion}`);
const cmakeVersion = versionOf(['cmake/bin/cmake', '--version']).split('\n')[0];
if (!cmakeVersion.includes(lock.tools.cmake)) fail(`cmake does not run: ${cmakeVersion}`);

const manifest = {
    schema: 1,
    id: 'nodu-stm32-toolkit',
    version: TOOLKIT_VERSION,
    profile: 'dev',
    platform,
    hostArch: os.arch(),
    components: {
        armGnu: { version: lock.tools.armGnu.version, path: 'arm-gnu', license: 'GPL-3.0-or-later WITH GCC-exception-3.1; newlib: BSD-like' },
        cmake: { version: lock.tools.cmake, path: 'cmake', license: 'BSD-3-Clause' },
        ninja: { version: lock.tools.ninja, path: 'ninja', license: 'Apache-2.0' },
        openocd: { version: lock.tools.openocd.version, path: 'openocd', license: 'GPL-2.0-or-later', source: 'homebrew' },
        stm32flash: { version: lock.tools.stm32flash.version, path: 'stm32flash', license: 'GPL-2.0-or-later', source: 'homebrew' },
        clangd: { version: clangdVersion, path: 'clangd', license: 'Apache-2.0 WITH LLVM-exception', source: 'xcode (dev only)' },
    },
    sdk: {
        'cube-f1': { version: lock.sdk.f1.tag.replace(/^v/, ''), path: 'sdk/cube-f1', ...lock.sdk.f1 },
        'cube-f4': { version: lock.sdk.f4.tag.replace(/^v/, ''), path: 'sdk/cube-f4', ...lock.sdk.f4 },
    },
    files: files.map((rel) => {
        const data = fs.readFileSync(path.join(out, rel));
        return { path: rel, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
    }),
};
const totalBytes = manifest.files.reduce((sum, f) => sum + f.size, 0);
manifest.totalBytes = totalBytes;
fs.writeFileSync(path.join(out, 'toolkit.json'), `${JSON.stringify(manifest, null, 2)}\n`);

// --- Smoke test: rebuild the P0 F103 image with the toolkit, same BIN digest.
if (!opts['no-smoke']) {
    const build = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-toolkit-smoke-'));
    const env = { PATH: [path.join(out, 'cmake/bin'), path.join(out, 'ninja/bin'), '/usr/bin', '/bin'].join(':'), LC_ALL: 'C', HOME: os.homedir() };
    const run = (args) => execFileSync(path.join(out, 'cmake/bin/cmake'), args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const [target, expected] of Object.entries(SMOKE)) {
        const dir = path.join(build, target);
        run(['-S', path.join(repo, 'tools/stm32-p0'), '-B', dir, '-G', 'Ninja',
            `-DCMAKE_MAKE_PROGRAM=${path.join(out, 'ninja/bin/ninja')}`,
            `-DCMAKE_TOOLCHAIN_FILE=${path.join(repo, 'tools/stm32-p0/cmake/arm-gcc.cmake')}`,
            `-DARM_TOOLCHAIN_ROOT=${path.join(out, 'arm-gnu')}`, `-DNODU_TARGET=${target}`,
            `-DSDK_ROOT=${path.join(out, 'sdk', target.startsWith('f1') ? 'cube-f1' : 'cube-f4')}`]);
        run(['--build', dir]);
        const digest = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'firmware.bin'))).digest('hex');
        if (digest !== expected) fail(`smoke ${target}: BIN ${digest} differs from P0 ${expected}`);
        console.log(`build-toolkit: smoke ${target} BIN ${digest.slice(0, 8)}… matches P0`);
    }
    fs.rmSync(build, { recursive: true, force: true });
}

const longest = files.reduce((a, b) => (b.length > a.length ? b : a), '');
console.log(`build-toolkit: ${out}`);
console.log(`  ${files.length} files, ${(totalBytes / 1e6).toFixed(1)} MB, ${signed} Mach-O signed, longest path ${longest.length}`);
console.log(`  ${cmakeVersion} · ${openocdVersion} · ${clangdVersion}`);
