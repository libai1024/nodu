// SPDX-License-Identifier: MIT
// Host-independent tests for build-media-windows.cjs pure helpers: CLI arg
// validation, PE machine checks, DLL import allowlist, and tar-member safety.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const w = require('./build-media-windows.cjs');

// --- CLI args ------------------------------------------------------------

test('CLI accepts no args and --arch x64', () => {
    assert.deepEqual(w.parseCliArgs([]), { arch: 'x64', help: false });
    assert.deepEqual(w.parseCliArgs(['--arch', 'x64']), { arch: 'x64', help: false });
    assert.equal(w.parseCliArgs(['--help']).help, true);
});

test('CLI rejects unsupported arch and malformed args', () => {
    assert.throws(() => w.parseCliArgs(['--arch', 'arm64']), /unsupported media target/);
    assert.throws(() => w.parseCliArgs(['--bogus']), /./);
    assert.throws(() => w.parseCliArgs(['stray-positional']), /./);
});

// --- import-table allowlist ----------------------------------------------

test('system DLLs, SDL2.dll, and api-set names are allowed; anything else is unexpected', () => {
    assert.equal(w.classifyImport('KERNEL32.dll'), 'system');
    assert.equal(w.classifyImport('kernel32.DLL'), 'system');
    assert.equal(w.classifyImport('ucrtbase.dll'), 'system');
    assert.equal(w.classifyImport('SDL2.dll'), 'staged');
    assert.equal(w.classifyImport('API-MS-WIN-CORE-FOO-L1-1-0.dll'), 'apiset');
    assert.equal(w.classifyImport('EXT-MS-WIN-NTUSER-BAR.dll'), 'apiset');
    assert.equal(w.classifyImport('libgcc_s_seh-1.dll'), 'unexpected');
    assert.equal(w.classifyImport('avcodec-62.dll'), 'unexpected');
    assert.equal(w.classifyImport('SDL3.dll'), 'unexpected');
});

test('objdump output parsing and unexpected-import detection', () => {
    const clean = `
        DLL Name: KERNEL32.dll
        DLL Name: msvcrt.dll
        DLL Name: SDL2.dll
        DLL Name: API-MS-WIN-CORE-SYNCH-L1-2-0.dll
`;
    assert.deepEqual(w.unexpectedImports(clean), []);
    const dirty = clean + '        DLL Name: libstdc++-6.dll\n';
    assert.deepEqual(w.unexpectedImports(dirty), ['libstdc++-6.dll']);
});

// --- tar member safety ----------------------------------------------------

test('tar member safety rejects traversal, absolute, and foreign-top entries', () => {
    const ok = 'ffmpeg-9.0.2/\nffmpeg-9.0.2/configure\nffmpeg-9.0.2/libavcodec/x.c\n';
    assert.deepEqual(w.unsafeTarMembers(ok, 'ffmpeg-9.0.2'), []);
    for (const bad of [
        'ffmpeg-9.0.2/../escape.c',
        '/etc/passwd',
        'C:\\windows\\system32\\x.dll',
        'other-tree/file.c',
        'ffmpeg-9.0.2/../../evil',
    ]) {
        assert.deepEqual(w.unsafeTarMembers(bad + '\n', 'ffmpeg-9.0.2'), [bad]);
    }
});

// --- tar invocation: drive-letter paths must not reach the -f argument -----
// GNU tar reads `host:file` in the archive operand as remote-tape syntax; a
// real Windows run failed with "Cannot connect to D: resolve failed".
test('tarInvocation keeps the drive-letter path out of the archive operand', () => {
    const win = 'D:\\nodu-build\\repo\\desktop\\.tools\\media\\ffmpeg-9.0.2.tar.xz';
    for (const extra of [[], ['-C', 'D:\\dest']]) {
        const { args, options } = w.tarInvocation(win, extra);
        assert.equal(args[0], path.win32.basename(win));
        assert.ok(!args[0].includes(':'));
        assert.equal(options.cwd, path.win32.dirname(win));
        assert.deepEqual(args.slice(1), extra);
    }
    // POSIX paths are unaffected too.
    const posix = w.tarInvocation('/home/u/a.tar.xz', ['-C', '/tmp']);
    assert.equal(posix.args[0], 'a.tar.xz');
    assert.equal(posix.options.cwd, '/home/u');
});

test('toMsysPath maps drive letters to /x/ POSIX form for MSYS tools', () => {
    assert.equal(w.toMsysPath('D:\\nodu-build\\x'), '/d/nodu-build/x');
    assert.equal(w.toMsysPath('C:/msys64/usr'), '/c/msys64/usr');
    assert.equal(w.toMsysPath('E:\\'), '/e/');
    assert.equal(w.toMsysPath('/already/posix'), '/already/posix');
    assert.equal(w.toMsysPath('relative\\dir'), 'relative/dir');
});

// --- PE machine check ------------------------------------------------------

function makePe(machine) {
    const buf = Buffer.alloc(512);
    buf.writeUInt16LE(0x5a4d, 0);
    buf.writeUInt32LE(0x80, 0x3c);
    buf.writeUInt32LE(0x00004550, 0x80);
    buf.writeUInt16LE(machine, 0x84);
    return buf;
}

test('isPeX64 verifies MZ + PE signature + machine 0x8664', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-test-'));
    const x64 = path.join(dir, 'a.exe');
    const arm = path.join(dir, 'b.exe');
    const txt = path.join(dir, 'c.txt');
    fs.writeFileSync(x64, makePe(0x8664));
    fs.writeFileSync(arm, makePe(0xaa64));
    fs.writeFileSync(txt, 'not a PE');
    assert.equal(w.isPeX64(x64), true);
    assert.equal(w.isPeX64(arm), false);
    assert.equal(w.isPeX64(txt), false);
    assert.equal(w.isPeX64(path.join(dir, 'missing.exe')), false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// --- MSYS2 resolution + pin agreement --------------------------------------

test('resolveMsys2Root prefers MSYS2_ROOT and falls back to C:\\msys64', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'msys2-'));
    fs.mkdirSync(path.join(dir, 'usr', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'usr', 'bin', 'bash.exe'), '');
    assert.equal(w.resolveMsys2Root({ MSYS2_ROOT: dir }), dir);
    // Neither candidate exists -> null (caller reports a build error).
    assert.equal(w.resolveMsys2Root({ MSYS2_ROOT: path.join(dir, 'nope') }),
        fs.existsSync('C:\\msys64\\usr\\bin\\bash.exe') ? 'C:\\msys64' : null);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('media-sources.json agrees with the macOS build pins', () => {
    const sources = w.loadSources();
    assert.equal(sources.ffmpeg.version, '9.0.2');
    assert.equal(sources.sdl2.version, '2.32.10');
    const drifted = JSON.parse(JSON.stringify(sources));
    drifted.sdl2.version = '9.9.9';
    const darwinText = fs.readFileSync(
        path.join(__dirname, 'build-media.cjs'), 'utf8');
    assert.throws(
        () => w.checkPinAgreement(drifted, darwinText), /disagrees/);
});
