// SPDX-License-Identifier: MIT
'use strict';

// Narrow packaging regression tests: the canonical JS comparator, the
// packaged bootstrap argv contract, and the npm-cli path resolver.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const {
    canonicalJs, normalizeNativeModuleKeys, resolveNpmCli, prepareUniversalLicenses,
} = require('./package-electron.cjs');

test('universal merge retains both exact architecture license inventories in both apps', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-license-merge-'));
    try {
        for (const arch of ['arm64', 'x64']) {
            fs.mkdirSync(path.join(root, arch, 'licenses', 'npm'), { recursive: true });
            fs.writeFileSync(path.join(root, arch, 'licenses', 'INDEX.json'), JSON.stringify({ arch }));
            fs.writeFileSync(path.join(root, arch, 'licenses', 'npm', 'NOTICE'), arch + ' original notice');
        }
        prepareUniversalLicenses(path.join(root, 'arm64'), path.join(root, 'x64'));
        for (const app of ['arm64', 'x64']) {
            for (const arch of ['arm64', 'x64']) {
                const base = path.join(root, app, 'licenses', arch);
                assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'INDEX.json'))), { arch });
                assert.equal(fs.readFileSync(path.join(base, 'npm', 'NOTICE'), 'utf8'), arch + ' original notice');
            }
        }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function tmpJs(text) {
    const file = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-pkg-js-')), 'bundle.js');
    fs.writeFileSync(file, text);
    return file;
}

test('canonical JS accepts comment and whitespace-only differences', () => {
    const a = tmpJs('function f(){ return 1; /* note */ }\n');
    const b = tmpJs('function f(){\n    return   1;\n}\n');
    assert.equal(canonicalJs(a), canonicalJs(b));
});

test('canonical JS rejects literal and keyword differences', () => {
    for (const [a, b] of [
        ['const v = true;', 'const v = null;'],
        ['const c = "red";', 'const c = "tan";'],
    ]) {
        assert.notEqual(canonicalJs(tmpJs(`${a}\n`)),
            canonicalJs(tmpJs(`${b}\n`)), `${a} vs ${b}`);
    }
});

test('canonical JS rejects an ASI semantic split', () => {
    // return\n1; returns undefined; return 1; returns 1.
    assert.notEqual(
        canonicalJs(tmpJs('function f(){return\n1;}\n')),
        canonicalJs(tmpJs('function f(){return 1;}\n')));
});

test('canonical JS preserves loop slots and literal whitespace', () => {
    for (const [a, b] of [
        ['for (ready;;) tick();', 'for (;ready;) tick();'],
        ['const s = `a\\nb`;', 'const s = `a b`;'],
    ]) {
        assert.notEqual(canonicalJs(tmpJs(a)), canonicalJs(tmpJs(b)));
    }
});

test('native module normalization touches generated metadata keys only', () => {
    const work = path.resolve(__dirname, '..', '.tools', 'package', 'work-arm64', 'desktop');
    const label = `node-file:${work}/node_modules/@parcel/watcher-darwin-arm64/watcher.node`;
    const runtime = `${work}/runtime-path`;
    const source = `var require_watcher = __commonJS({
        ${JSON.stringify(label)}(exports2, module2) {
            const path = ${JSON.stringify(runtime)};
            module2.exports = require("./native/watcher.node");
        }
    });
    const unrelated = ${JSON.stringify(label)};
    const packageName = "@parcel/watcher-darwin-arm64";
    function userCode() {
        var require_nested = __commonJS({
            ${JSON.stringify(label)}() { return 1; }
        });
    }`;
    const normalized = normalizeNativeModuleKeys(source, 'arm64');
    assert.ok(normalized.includes('"node-file:PACKAGE_DESKTOP/node_modules/@parcel/watcher-darwin-arch/watcher.node"(exports2, module2)'));
    assert.ok(normalized.includes(`const path = ${JSON.stringify(runtime)}`));
    assert.ok(normalized.includes(`const unrelated = ${JSON.stringify(label)}`));
    assert.ok(normalized.includes('const packageName = "@parcel/watcher-darwin-arm64"'));
    assert.ok(normalized.includes(`${JSON.stringify(label)}() { return 1; }`));
});

test('generated native labels normalize identically for both architectures', () => {
    const source = arch => {
        const work = path.resolve(__dirname, '..', '.tools', 'package', `work-${arch}`, 'desktop');
        return `var require_watcher = __commonJS({
            ${JSON.stringify(`node-file:${work}/node_modules/@parcel/watcher-darwin-${arch}/watcher.node`)}(exports2, module2) {
                module2.exports = require("./native/watcher.node");
            }
        });
        var init_watcher = __esm({
            "../node_modules/@parcel/watcher-darwin-${arch}/watcher.node"() {
                watcher_default = "./native/watcher.node";
            }
        });`;
    };
    assert.equal(normalizeNativeModuleKeys(source('arm64'), 'arm64'),
        normalizeNativeModuleKeys(source('x64'), 'x64'));
});

// The packaged entry is the app root main.cjs; its ./scripts/launch.cjs
// and ./lib/backend/electron-main.js resolves are stubbed by module
// interception so the real launcher flag parser runs for real.
function requirePackagedEntry({ argv, packaged, documents, profile }) {
    const entry = path.join(__dirname, 'packaged-entry.cjs');
    delete require.cache[require.resolve(entry)];
    const launchPath = path.join(__dirname, 'launch.cjs');
    const captured = {};
    const fakeApp = {
        isPackaged: packaged,
        getPath: () => documents,
        setPath(name, value) { captured.userData = value; },
    };
    const originalArgv = process.argv;
    const originalLoad = Module._load;
    Module._load = function load(request, parent, isMain) {
        if (request === 'electron') { return { app: fakeApp }; }
        if (request === './scripts/launch.cjs') {
            return originalLoad.call(this, launchPath, parent, isMain);
        }
        if (request === './lib/backend/electron-main.js') {
            captured.argv = process.argv.slice();
            captured.updateResources = process.env.NODU_UPDATE_RESOURCES;
            return {};
        }
        return originalLoad.call(this, request, parent, isMain);
    };
    const environmentKeys = ['NODU_PROFILE_DIR', 'THEIA_CONFIG_DIR',
        'NODU_UPDATE_RESOURCES', 'NODU_STARTUP_TERMINALS',
        'NODU_READ_TIMEOUT_MS', 'NODU_READ_STALL_TIMEOUT_MS', 'ELECTRON_RUN_AS_NODE'];
    const originalEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
    if (profile === undefined) { delete process.env.NODU_PROFILE_DIR; }
    else { process.env.NODU_PROFILE_DIR = profile; }
    process.argv = argv;
    try {
        require(entry);
    } finally {
        Module._load = originalLoad;
        process.argv = originalArgv;
        for (const [key, value] of originalEnvironment) {
            if (value === undefined) { delete process.env[key]; }
            else { process.env[key] = value; }
        }
    }
    return captured;
}

test('packaged bootstrap keeps one binary prefix and sets the profile', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-ws-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-prof-'));
    const captured = requirePackagedEntry({
        argv: ['/Applications/Nodu.app/Contents/MacOS/Nodu',
            workspace, '-update_resources'],
        packaged: true,
        documents: '/tmp/docs',
        profile,
    });
    assert.equal(captured.argv[0], '/Applications/Nodu.app/Contents/MacOS/Nodu');
    assert.equal(captured.argv[1], workspace);
    assert.equal(captured.argv.length, 6,
        'bin + workspace + 4 managed args only — executable must not '
        + 'appear as an extra argument');
    assert.ok(captured.argv.includes('--hostname=127.0.0.1'));
    assert.ok(captured.argv.includes('--port=0'));
    assert.ok(captured.argv.some(arg => arg.startsWith('--electronUserData=')));
    assert.ok(captured.argv.some(arg => arg.startsWith('--plugins=local-dir:')));
    assert.equal(captured.updateResources, '1');
    assert.equal(captured.userData, path.join(profile, 'electron'));
});

test('packaged app without a project opens the launcher without creating a Documents workspace', () => {
    const documents = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-documents-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-prof-'));
    const captured = requirePackagedEntry({
        argv: ['/Applications/Nodu.app/Contents/MacOS/Nodu'],
        packaged: true, documents, profile,
    });
    assert.equal(captured.argv.length, 5);
    assert.ok(captured.argv.slice(1).every(value => value.startsWith('--')));
    assert.equal(fs.existsSync(path.join(documents, 'Nodu')), false);
});

test('dev (unpackaged) bootstrap keeps two binary prefix entries', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-ws-'));
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-prof-'));
    const captured = requirePackagedEntry({
        argv: ['/usr/bin/node', '/app/main.cjs', workspace],
        packaged: false,
        documents: '/tmp/docs',
        profile,
    });
    assert.equal(captured.argv[0], '/usr/bin/node');
    assert.ok(captured.argv[1].endsWith('packaged-entry.cjs'));
    assert.equal(captured.argv[2], workspace);
});

test('npm-cli resolves under the POSIX and Windows Node layouts', () => {
    const posix = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-node-posix-'));
    fs.mkdirSync(path.join(posix, 'bin'), { recursive: true });
    const posixCli = path.join(posix, 'lib', 'node_modules', 'npm',
        'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(posixCli), { recursive: true });
    fs.writeFileSync(posixCli, '// npm\n');
    assert.equal(resolveNpmCli(path.join(posix, 'bin', 'node')), posixCli);

    const windows = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-node-win-'));
    const winCli = path.join(windows, 'node_modules', 'npm',
        'bin', 'npm-cli.js');
    fs.mkdirSync(path.dirname(winCli), { recursive: true });
    fs.writeFileSync(winCli, '// npm\n');
    assert.equal(resolveNpmCli(path.join(windows, 'node.exe')), winCli);
});
