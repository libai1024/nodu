// SPDX-License-Identifier: MIT
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const crypto = require('node:crypto');
const packaging = require('./package-arduino.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-arduino-package-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cli = Buffer.from('fixture CLI'), filename = 'arduino-cli_1.5.1_macOS_ARM64.tar.gz';
    // Use the production validator with a fixture of the official asset table.
    // Real CLI archives are checked by the cold-start integration test.
    const code = fs.readFileSync(path.join(__dirname, 'package-arduino.cjs'), 'utf8');
    const module = { exports: {} }, assetLock = { hosts: {} };
    const wrappedFs = { ...fs, readFileSync(file, ...args) {
        if (file.endsWith('/resources/arduino/cli-manifest.json')) { return JSON.stringify({ assets: { 'darwin-arm64': { file: filename, sha256: hash(cli) } } }); }
        return fs.readFileSync(file, ...args);
    } };
    vm.runInNewContext(code, { module, exports: module.exports, __dirname, process, Buffer, require: id => id === 'node:fs' ? wrappedFs : id === './arduino-release.lock.json' ? assetLock : require(id) });
    const api = module.exports, records = [];
    const add = (name, bytes, metadata) => {
        const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
        const record = { path: name, size: Buffer.byteLength(bytes), sha256: hash(bytes), ...metadata }; records.push(record); return record;
    };
    const asset = (name, bytes) => ({ archiveFileName: `${name}.zip`, checksum: `SHA-256:${hash(bytes)}`, size: String(bytes.length), url: `https://example.invalid/${name}.zip` });
    const core = { name: 'esp32', architecture: 'esp32', version: '3.3.12', ...asset('core', 'core'), toolsDependencies: [{ packager: 'esp32', name: 'compiler', version: '1' }] };
    const tool = (name, version) => ({ name, version, systems: [{ host: 'arm64-apple-darwin', ...asset(name, name) }] });
    const indices = { esp32: { packages: [{ name: 'esp32', platforms: [core], tools: [tool('compiler', '1')] }] },
        arduino: { packages: [{ name: 'builtin', tools: Object.entries(packaging.BUILTINS).map(([name, version]) => tool(name, version)) }] } };
    const plan = api.planPackages(indices, 'darwin-arm64');
    assetLock.hosts['darwin-arm64'] = Object.fromEntries(plan.records.map(record => [record.id, { file: record.archiveFileName, sha256: record.checksum.slice(8), size: Number(record.size), url: record.url }]));
    add('data/package_esp32_index.json', JSON.stringify(indices.esp32), { kind: 'index', target: 'data/package_esp32_index.json' });
    add('data/package_index.json', JSON.stringify(indices.arduino), { kind: 'index', target: 'data/package_index.json' });
    add('data/library_index.json', '{"libraries":[]}', { kind: 'index', target: 'data/library_index.json' });
    for (const item of plan.records) {
        const name = item.archiveFileName.slice(0, -4), target = `downloads/packages/${item.archiveFileName}`;
        add(target, name, { kind: 'package', target });
    }
    add(`cli/${filename}`, cli, { kind: 'cli', target: `downloads/${filename}` });
    for (const file of ['boards.txt', 'platform.txt', 'installed.json']) {
        const target = `data/internal/${packaging.PROFILE_ID}/${file}`; add(target, 'fixture', { kind: 'profile', target, mode: 0o644 });
    }
    add('sources/source.tar.gz', 'fixture sources', { kind: 'source' });
    add('sources/LICENSE.txt', 'fixture license', { kind: 'license' });
    const native = Buffer.alloc(32); native.writeUInt32LE(0xfeedfacf); native.writeUInt32LE(0x0100000c, 4);
    add('native/ctags', native, { kind: 'native', target: 'tools/ctags/darwin-arm64/ctags', mode: 0o755, version: '5.8-arduino11', sourceSha256: hash('fixture sources') });
    const override = `data/internal/${packaging.PROFILE_ID}/platform.local.txt`;
    add(override, packaging.NATIVE_CTAGS_OVERRIDE, { kind: 'profile', target: override, mode: 0o644 });
    const manifest = { schemaVersion: 1, id: 'test', host: 'darwin-arm64', cliVersion: '1.5.1', coreVersion: '3.3.12', releaseReady: true, files: records,
        sourceCoverage: ['arduino-cli@1.5.1', ...plan.records.map(record => record.id)].map(component => ({ component, complete: true, files: ['sources/source.tar.gz', 'sources/LICENSE.txt'] })) };
    const save = () => fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest)); save();
    return { root, api, manifest, save, add, plan, indices };
}

test('Core profile identity is portable and matches the official CLI cache identity', () => {
    assert.equal(packaging.PROFILE_ID, 'esp32_esp32_3.3.12_feadd113249efafd');
});
test('host selection prefers native arm64 and includes every official dependency plus builtin discovery tools', t => {
    const f = fixture(t); const tool = f.indices.esp32.packages[0].tools[0];
    tool.systems.unshift({ ...tool.systems[0], host: 'x86_64-apple-darwin', archiveFileName: 'intel.zip' });
    assert.equal(packaging.planPackages(f.indices, 'darwin-arm64').records.find(item => item.id === 'esp32:compiler@1').archiveFileName, 'compiler.zip');
    assert.equal(f.plan.records.length, 7);
    assert.throws(() => packaging.planPackages(f.indices, 'win32-x64'), /索引缺少/);
    tool.systems = [{ ...tool.systems[0], host: 'aarch64-apple-darwin', archiveFileName: 'unrecognized-native.zip' }, { ...tool.systems[0], host: 'x86_64-apple-darwin', archiveFileName: 'intel.zip' }];
    assert.equal(packaging.planPackages(f.indices, 'darwin-arm64').records.find(item => item.id === 'esp32:compiler@1').archiveFileName, 'intel.zip');
});
test('complete bundle validates and copies only the immutable manifest payload with required host marker', t => {
    const f = fixture(t); assert.equal(f.api.validateBundle(f.root, 'darwin-arm64').id, 'test');
    fs.writeFileSync(path.join(f.root, 'private-unlisted.txt'), 'must not copy');
    const resources = path.join(f.root, 'app-resources'); f.api.copyBundle(f.root, resources, 'darwin-arm64', ['darwin-x64', 'darwin-arm64']);
    const output = path.join(resources, 'arduino/offline/darwin-arm64');
    assert.equal(fs.existsSync(path.join(output, 'private-unlisted.txt')), false);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(resources, 'arduino/offline/required.json'))).hosts, ['darwin-arm64', 'darwin-x64']);
    assert.equal(f.api.validateBundle(output, 'darwin-arm64').files.length, f.manifest.files.length);
});
test('release packaging fails closed when any source coverage is incomplete; development validation remains explicit', t => {
    const f = fixture(t); f.manifest.sourceCoverage[0].complete = false; f.manifest.releaseReady = false; f.save();
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /对应源码.*arduino-cli/);
    assert.equal(f.api.validateBundle(f.root, 'darwin-arm64', { allowUnreleased: true }).releaseReady, false);
    const resources = path.join(f.root, 'validation');
    assert.throws(() => f.api.copyBundle(f.root, resources, 'darwin-arm64'), /对应源码/);
    f.api.copyBundle(f.root, resources, 'darwin-arm64', ['darwin-arm64'], { allowUnreleased: true });
    const output = path.join(resources, 'arduino/offline/darwin-arm64');
    assert.equal(f.api.validateBundle(output, 'darwin-arm64', { allowUnreleased: true }).releaseReady, false);
    assert.throws(() => f.api.validateBundle(output, 'darwin-arm64'), /对应源码/);
});
test('missing official dependency cannot be hidden by deleting its manifest entry', t => {
    const f = fixture(t); f.manifest.files = f.manifest.files.filter(item => item.target !== 'downloads/packages/compiler.zip'); f.save();
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /缺少或不匹配.*compiler/);
});
test('corrupt payload, wrong host, duplicate targets and path traversal are rejected', t => {
    const f = fixture(t); assert.throws(() => f.api.validateBundle(f.root, 'darwin-x64'), /主机不匹配/);
    const core = f.manifest.files.find(item => item.target === 'downloads/packages/core.zip');
    fs.writeFileSync(path.join(f.root, core.path), 'bad!'); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /损坏/);
    fs.writeFileSync(path.join(f.root, core.path), 'core');
    const original = core.target; core.target = 'data/package_index.json'; f.save(); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /无效或重复/);
    core.target = original; core.path = '../outside'; f.save(); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /清单无效/);
});
test('symlink payloads and targets outside the intended profile Core are rejected', t => {
    const f = fixture(t), source = f.manifest.files.find(item => item.kind === 'source'), full = path.join(f.root, source.path);
    fs.renameSync(full, full + '.original'); fs.symlinkSync(full + '.original', full);
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /符号链接/);
    fs.rmSync(full); fs.renameSync(full + '.original', full);
    const profile = f.manifest.files.find(item => item.kind === 'profile'); profile.target = 'data/internal/foreign/file'; f.save();
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /不在约定目录/);
});
test('a source claim cannot reference missing source files or license-only material', t => {
    const f = fixture(t); f.manifest.sourceCoverage[0].files = ['sources/LICENSE.txt']; f.save();
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /对应源码/);
    f.manifest.sourceCoverage[0].files = ['missing.tar.gz']; f.save(); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /对应源码/);
});
test('Apple Silicon release requires native ctags and its portable platform override', t => {
    const f = fixture(t), native = f.manifest.files.find(item => item.kind === 'native');
    native.sourceSha256 = '0'.repeat(64); f.save(); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /原生 ctags/);
    native.sourceSha256 = hash('fixture sources');
    const bytes = fs.readFileSync(path.join(f.root, native.path)); bytes.writeUInt32LE(0x01000007, 4); fs.writeFileSync(path.join(f.root, native.path), bytes); native.sha256 = hash(bytes); f.save();
    assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /不是原生 arm64/);
    bytes.writeUInt32LE(0x0100000c, 4); fs.writeFileSync(path.join(f.root, native.path), bytes); native.sha256 = hash(bytes);
    f.manifest.files = f.manifest.files.filter(item => !item.target?.endsWith('/platform.local.txt')); f.save(); assert.throws(() => f.api.validateBundle(f.root, 'darwin-arm64'), /平台配置/);
});
test('post-signing refresh updates native bytes only and retains the original build identity', t => {
    const f = fixture(t), resources = path.join(f.root, 'app'); f.api.copyBundle(f.root, resources, 'darwin-arm64');
    const output = path.join(resources, 'arduino/offline/darwin-arm64'), manifestFile = path.join(output, 'manifest.json');
    const original = JSON.parse(fs.readFileSync(manifestFile)), native = original.files.find(item => item.kind === 'native');
    fs.appendFileSync(path.join(output, native.path), 'signature');
    const unrelated = path.join(output, 'other/manifest.json'); fs.mkdirSync(path.dirname(unrelated)); fs.writeFileSync(unrelated, '{"upstream":true}');
    f.api.refreshManifests(resources);
    const signed = f.api.validateBundle(output, 'darwin-arm64'), updated = signed.files.find(item => item.kind === 'native');
    assert.equal(updated.buildBinarySha256, native.sha256); assert.notEqual(updated.sha256, native.sha256);
    assert.deepEqual(JSON.parse(fs.readFileSync(unrelated)), { upstream: true });
    for (const record of signed.files.filter(item => item.kind !== 'native')) { assert.equal(record.sha256, original.files.find(item => item.path === record.path).sha256); }
});
test('packager keeps upstream files covered by the Arduino bundle manifest', () => {
    const { ignorePackagedPath } = require('./package-electron.cjs');
    for (const name of ['package-lock.json', 'source.o', 'path/.git/config']) {
        assert.equal(ignorePackagedPath(`/node_modules/@scope/studio-extension/resources/arduino/offline/darwin-arm64/${name}`), false);
    }
    assert.equal(ignorePackagedPath('/node_modules/example/package-lock.json'), true);
});
