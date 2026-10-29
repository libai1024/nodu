// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { seedArduinoOfflineBundle, validateArduinoOfflineManifest, arduinoInitializationErrors } = require('../lib/node/nodu-arduino-offline');
const { installArduinoCli } = require('../lib/node/nodu-arduino-toolchain');
const host = `${process.platform}-${process.arch}`;
const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-offline-unit-'));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bundles = path.join(root, 'bundles'), directory = path.join(bundles, host), home = path.join(root, 'home');
    const records = [
        ['data/package_index.json', 'index', '{"packages":[]}'],
        ['data/package_index.json.sig', 'index', 'signature of packaged index'],
        ['data/library_index.json', 'index', '{"libraries":[]}'],
        ['data/library_index.json.sig', 'index', 'signature of packaged libraries'],
        ['data/package_esp32_index.json', 'index', '{"packages":[]}'],
        ['data/internal/esp32_esp32_3.3.12_feadd113249efafd/boards.txt', 'profile', 'esp32c3.name=ESP32C3 Dev Module\n'],
        ['downloads/arduino-cli_1.5.1_fixture.tar.gz', 'cli', 'fixture cli archive'],
        ['downloads/packages/compiler.tar.gz', 'package', 'fixture compiler archive'],
    ];
    const manifest = { schemaVersion: 1, id: 'offline-unit', host, cliVersion: '1.5.1', coreVersion: '3.3.12', files: [] };
    for (const [target, kind, text] of records) {
        const input = path.join(directory, target); await fs.mkdir(path.dirname(input), { recursive: true }); await fs.writeFile(input, text);
        manifest.files.push({ path: target, target, kind, sha256: hash(text), size: Buffer.byteLength(text) });
    }
    await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest));
    const seed = (signal = new AbortController().signal, progress = () => {}) => seedArduinoOfflineBundle(home, signal, progress, bundles, host);
    return { root, bundles, directory, home, manifest, seed };
}
test('a fresh home receives only checksum-verified portable inputs, without network access', async t => {
    const f = await fixture(t), saved = global.fetch; global.fetch = () => { throw Error('network must not be used'); }; t.after(() => global.fetch = saved);
    assert.equal((await f.seed()).id, 'offline-unit');
    for (const entry of f.manifest.files) { assert.equal(hash(await fs.readFile(path.join(f.home, entry.target))), entry.sha256); }
    const file = path.join(f.home, 'downloads/packages/compiler.tar.gz'), before = await fs.stat(file);
    const progress = []; await f.seed(undefined, text => progress.push(text)); assert.equal((await fs.stat(file)).mtimeMs, before.mtimeMs);
    assert.deepEqual(progress, [], 'a verified warm environment must not advertise another initialization');
});
test('library additions survive while board and builtin indexes remain pinned; damaged archives are repaired', async t => {
    const f = await fixture(t); await f.seed();
    const index = path.join(f.home, 'data/library_index.json'); await fs.writeFile(index, '{"libraries":[],"userAddition":true}');
    await fs.rm(index + '.sig');
    const boards = path.join(f.home, 'data/package_index.json'); await fs.writeFile(boards, '{"packages":[],"newerBuiltin":true}');
    await fs.rm(boards + '.sig');
    const archive = path.join(f.home, 'downloads/packages/compiler.tar.gz'); await fs.writeFile(archive, 'corrupt');
    await f.seed(); assert.equal(JSON.parse(await fs.readFile(index)).userAddition, true);
    assert.equal(hash(await fs.readFile(archive)), f.manifest.files.at(-1).sha256);
    await assert.rejects(fs.access(index + '.sig'));
    assert.equal(JSON.parse(await fs.readFile(boards)).newerBuiltin, undefined);
    assert.equal(await fs.readFile(boards + '.sig', 'utf8'), 'signature of packaged index');
});
test('corrupt receipts are safely rebuilt; source corruption cannot be installed or accepted as ready', async t => {
    const f = await fixture(t); await f.seed();
    for (const name of await fs.readdir(path.join(f.home, '.offline-receipts'))) { await fs.writeFile(path.join(f.home, '.offline-receipts', name), 'broken json'); }
    await f.seed();
    const entry = f.manifest.files.at(-1); await fs.rm(path.join(f.home, entry.target));
    await fs.writeFile(path.join(f.directory, entry.path), 'X'.repeat(entry.size));
    await assert.rejects(f.seed(), /修复 Nodu 安装/);
    await assert.rejects(fs.access(path.join(f.home, entry.target)));
});
test('manifest paths cannot overwrite user files or accept duplicate destinations', async t => {
    const f = await fixture(t);
    for (const changes of [{ target: '../outside' }, { path: '/absolute' }, { target: 'data/internal/other/user.txt' }, { path: 'a/../b' }, { target: 'data/package_index.json' }, { mode: 0o777 }]) {
        const manifest = structuredClone(f.manifest); Object.assign(manifest.files.at(-1), changes);
        assert.throws(() => validateArduinoOfflineManifest(manifest, host), /修复 Nodu 安装/);
    }
    assert.throws(() => validateArduinoOfflineManifest(f.manifest, '../bad'), /系统|清单/);
});
test('symbolic links in destination directories and source entries are refused', async t => {
    if (process.platform === 'win32') { t.skip('symlink creation depends on Windows privilege'); return; }
    const f = await fixture(t), outside = path.join(f.root, 'outside');
    await fs.mkdir(outside); await fs.mkdir(f.home); await fs.symlink(outside, path.join(f.home, 'data'));
    await assert.rejects(f.seed(), /资源目录/); assert.deepEqual(await fs.readdir(outside), []);
    await fs.rm(path.join(f.home, 'data')); const item = f.manifest.files[0], source = path.join(f.directory, item.path);
    await fs.rename(source, source + '.real'); await fs.symlink(source + '.real', source);
    await assert.rejects(f.seed(), /资源文件/);
});
test('concurrent initialization is serialized; cancellation leaves no success receipt or background writers', async t => {
    const f = await fixture(t); await Promise.all([f.seed(), f.seed()]);
    const g = await fixture(t), abort = new AbortController();
    await assert.rejects(g.seed(abort.signal, () => abort.abort()), /abort/i);
    const receipts = path.join(g.home, '.offline-receipts'); assert.deepEqual(await fs.readdir(receipts), []);
    await new Promise(resolve => setTimeout(resolve, 30)); assert.deepEqual(await fs.readdir(receipts), []);
    assert.equal((await g.seed()).id, 'offline-unit');
});
test('a packaged missing host fails clearly; a source checkout may opt into the legacy development flow', async t => {
    const f = await fixture(t); await fs.rm(f.directory, { recursive: true });
    assert.equal(await f.seed(), undefined);
    await fs.writeFile(path.join(f.bundles, 'required.json'), '{"schemaVersion":1}');
    await assert.rejects(f.seed(), /缺少当前系统工具包/);
});
test('release CLI installation cannot silently fall back to a network download', async t => {
    const f = await fixture(t), saved = global.fetch; let calls = 0;
    global.fetch = () => { calls++; throw Error('unexpected network'); }; t.after(() => global.fetch = saved);
    await assert.rejects(installArduinoCli(f.home, new AbortController().signal, () => {}, false), /修复 Nodu 安装/);
    assert.equal(calls, 0);
});
test('zero-exit CLI dependency errors must not advertise a ready editor environment', () => {
    const output = 'Installing tool esp32:esp-x32@2601...\nError initializing instance: Library not found\nLibrary Adafruit GFX Library@1.13.0 not found...\ntool Download failed: denied\n';
    assert.equal(arduinoInitializationErrors(output).length, 3);
    assert.deepEqual(arduinoInitializationErrors('Downloading tool esp32:esp-x32@2601...\ntool already downloaded\n'), []);
});
