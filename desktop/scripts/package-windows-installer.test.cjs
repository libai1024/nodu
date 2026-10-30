// SPDX-License-Identifier: MIT
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { splitArchive, assemblyScriptFor, verifyIdentity, sha256, scriptFor } = require('./package-windows-installer.cjs');

test('offline volumes reconstruct exactly and record every part digest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-volumes-'));
    try {
        const input = path.join(dir, 'Nodu.zip');
        const original = Buffer.from(Array.from({ length: 10003 }, (_, i) => i % 251));
        fs.writeFileSync(input, original);
        const parts = splitArchive(input, dir, 3000);
        assert.deepEqual(parts.map(p => p.size), [3000, 3000, 3000, 1003]);
        for (const p of parts) assert.equal(sha256(path.join(dir, p.name)), p.sha256);
        assert.deepEqual(Buffer.concat(parts.map(p => fs.readFileSync(path.join(dir, p.name)))), original);
        assert.throws(() => assemblyScriptFor([{ ...parts[0], name: '../escape' }], sha256(input)), /Invalid/);
        assert.throws(() => splitArchive(input, dir, 2 ** 31), /Invalid part size/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('installer refuses validation builds, dirty builds and mixed source identities', () => {
    const marker = { profile: 'full', dataDirectory: 'Data' };
    const info = { profile: 'full', sourceDirty: false, sourceCommit: 'a'.repeat(40), version: '0.2.3' };
    assert.doesNotThrow(() => verifyIdentity(marker, info, info));
    for (const change of [{ validationOnly: true }, { sourceDirty: true }, { sourceDirty: undefined }, { sourceCommit: 'b'.repeat(40) }, { version: '0.2.2' }, { profile: 'esp32-validation' }]) {
        assert.throws(() => verifyIdentity(marker, info, { ...info, ...change }));
    }
    const script = scriptFor({ archive: 'D:\\Nodu.zip', output: 'D:\\setup.exe', version: '0.2.3', profile: 'full', assemblyScript: 'D:\\assemble.ps1' });
    assert.ok(script.includes('InstallDir "D:\\Nodu"'));
    assert.ok(script.includes('CH343\\*.inf'));
    assert.ok(!script.includes('RMDir /r "$INSTDIR\\Data"'));
});

test('Windows assembly rejects missing/corrupt parts and preserves existing files', { skip: process.platform !== 'win32' }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-assembly-'));
    try {
        const archive = path.join(dir, 'Nodu.zip'), output = path.join(dir, 'assembled.zip'), script = path.join(dir, 'assemble.ps1');
        fs.writeFileSync(archive, Buffer.alloc(10003, 37));
        const parts = splitArchive(archive, dir, 3000);
        fs.writeFileSync(script, '\ufeff' + assemblyScriptFor(parts, sha256(archive)));
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-SourceDirectory', dir, '-Destination', output];
        execFileSync('powershell.exe', args, { stdio: 'pipe' });
        assert.equal(sha256(output), sha256(archive));
        assert.equal(spawnSync('powershell.exe', args).status, 1);
        assert.equal(sha256(output), sha256(archive), 'Existing destination must survive rejected assembly');
        fs.unlinkSync(output);
        const first = path.join(dir, parts[0].name), bytes = fs.readFileSync(first);
        fs.writeFileSync(first, Buffer.alloc(bytes.length, 0));
        assert.equal(spawnSync('powershell.exe', args).status, 1);
        assert.ok(!fs.existsSync(output));
        fs.unlinkSync(first);
        assert.equal(spawnSync('powershell.exe', args).status, 1);
        assert.ok(!fs.existsSync(output));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
