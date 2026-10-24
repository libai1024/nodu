// SPDX-License-Identifier: MIT
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { collectPackageLicenses } = require('./package-licenses.cjs');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-package-licenses-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const desktop = path.join(root, 'desktop'), appInput = path.join(root, 'app');
    const write = (rel, data) => { const p = path.join(desktop, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, typeof data === 'string' ? data : JSON.stringify(data)); };
    const lock = { packages: {} };
    write('electron-app/package.json', { name: '@test/app', version: '0.2.2', dependencies: {} });
    write('scope-extension/style/fonts/FONT-LICENSE.txt', 'Original font copyright and license');
    const add = (rel, name, version, fields = {}, license = `Copyright ${name}\nPermission is hereby granted...`) => {
        write(`${rel}/package.json`, { name, version, license: 'MIT', ...fields });
        if (license !== null) write(`${rel}/LICENSE`, license);
        lock.packages[rel] = { version, integrity: `sha512-${name}-${version}` };
    };
    const collect = extra => { write('package-lock.json', lock); return collectPackageLicenses({ desktop, workDesktop: desktop, appInput, workspaceNames: ['electron-app'], includeCargo: false, ...extra }); };
    const read = () => JSON.parse(fs.readFileSync(path.join(appInput, 'licenses/INDEX.json')));
    return { root, desktop, appInput, write, add, lock, collect, read };
}
test('collects production transitive and peer licenses, excludes development roots and records optional absence', t => {
    const f = fixture(t);
    f.write('electron-app/package.json', { name: '@test/app', version: '0.2.2', dependencies: { a: '1' }, devDependencies: { dev: '1' } });
    f.add('node_modules/a', 'a', '1.0.0', { dependencies: { b: '1' }, peerDependencies: { peer: '1' }, optionalDependencies: { absent: '1' } });
    f.add('node_modules/b', 'b', '1.0.0'); f.add('node_modules/peer', 'peer', '1.0.0'); f.add('node_modules/dev', 'dev', '1.0.0');
    const result = f.collect();
    assert.equal(result.missing.length, 0); assert.equal(result.absentOptional.length, 1);
    assert.deepEqual(f.read().packages.filter(p => p.kind === 'npm').map(p => p.name), ['a', 'b', 'peer']);
    const text = fs.readFileSync(result.index, 'utf8'); assert.ok(!text.includes(f.root));
    assert.equal(f.read().packages.find(p => p.kind === 'font').materials.length, 1);
});
test('keeps nested versions and scoped package material paths distinct', t => {
    const f = fixture(t);
    f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1', '@scope/a': '1' } });
    f.add('node_modules/a', 'a', '1.0.0', { dependencies: { b: '2' } }); f.add('node_modules/a/node_modules/b', 'b', '2.0.0');
    f.add('node_modules/@scope/a', '@scope/a', '1.0.0', { dependencies: { b: '1' } }); f.add('node_modules/b', 'b', '1.0.0');
    f.collect(); const all = f.read().packages.flatMap(p => p.materials.map(m => m.file));
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual(f.read().packages.filter(p => p.name === 'b').map(p => p.version).sort(), ['1.0.0', '2.0.0']);
});
test('writes missing inventory then blocks publication instead of accepting a license identifier alone', t => {
    const f = fixture(t); f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1' } });
    f.add('node_modules/a', 'a', '1.0.0', {}, null);
    assert.throws(() => f.collect(), /unresolved entries/);
    assert.equal(f.read().missing[0].name, 'a'); assert.equal(f.read().packages.find(p => p.name === 'a').materials.length, 0);
});
test('requires a lockfile version match', t => {
    const f = fixture(t); f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1' } });
    f.add('node_modules/a', 'a', '2.0.0'); f.lock.packages['node_modules/a'].version = '1.0.0';
    assert.throws(() => f.collect(), /differs from lockfile/);
});
test('copies complete embedded README license and rejects link-only README as missing', t => {
    const f = fixture(t); f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1', b: '1' } });
    f.add('node_modules/a', 'a', '1.0.0', {}, null); f.write('node_modules/a/README.md', 'Author\nPermission is hereby granted, free of charge...\nTHE SOFTWARE IS PROVIDED AS IS.');
    f.add('node_modules/b', 'b', '1.0.0', {}, null); f.write('node_modules/b/README.md', 'License: MIT, see external link.');
    f.collect({ allowMissing: true });
    assert.equal(f.read().packages.find(p => p.name === 'a').materials.length, 1); assert.equal(f.read().missing[0].name, 'b');
});
test('fixed-source supplements require exact package version, HTTPS provenance and unchanged bytes', t => {
    const f = fixture(t); f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1' } }); f.add('node_modules/a', 'a', '1.0.0', {}, null);
    const data = 'Original upstream license'; f.write('fallback/a-LICENSE', data);
    f.write('fallback/manifest.json', { packages: [{ kind: 'npm', name: 'a', version: '1.0.0', materials: [{ path: 'a-LICENSE', sha256: crypto.createHash('sha256').update(data).digest('hex'), source: 'https://example.test/repo/0123456789/LICENSE' }] }] });
    f.collect({ fallbackRoot: path.join(f.desktop, 'fallback') }); assert.equal(f.read().missing.length, 0);
    f.write('fallback/a-LICENSE', 'Changed'); assert.throws(() => f.collect({ fallbackRoot: path.join(f.desktop, 'fallback') }), /Invalid fixed-source/);
});
test('rejects license symlinks that escape their source package', t => {
    const f = fixture(t); f.write('electron-app/package.json', { name: 'app', version: '0.2.2', dependencies: { a: '1' } }); f.add('node_modules/a', 'a', '1.0.0', {}, null);
    f.write('outside.txt', 'Not a package license'); fs.symlinkSync(path.join(f.desktop, 'outside.txt'), path.join(f.desktop, 'node_modules/a/LICENSE'));
    assert.throws(() => f.collect(), /escapes its package/);
});
function portableFixture(t) {
    const f = fixture(t);
    f.write('native/Cargo.lock', 'version = 4\n\n[[package]]\nname = "test-crate"\nversion = "1.2.3"\nsource = "registry+https://github.com/rust-lang/crates.io-index"\nchecksum = "fixed-archive-sha"\n');
    f.write('native/rust-toolchain.toml', '[toolchain]\nchannel = "1.98.1"\n');
    const hash = x => crypto.createHash('sha256').update(x).digest('hex');
    const material = { file: 'cargo/test-crate/LICENSE', size: 8, sha256: hash('Original') };
    f.write('audit/cargo/test-crate/LICENSE', 'Original');
    const records = [
        { kind: 'cargo', name: 'test-crate', version: '1.2.3', source: 'registry+https://github.com/rust-lang/crates.io-index', checksum: 'fixed-archive-sha', materials: [material] },
        { kind: 'runtime', name: 'Rust standard library', version: '1.98.1', materials: [material] },
    ];
    f.write('audit/INDEX.json', { packages: records, missing: [] });
    const { writeNativeLicenseBundle } = require('./package-licenses.cjs');
    f.bundle = () => writeNativeLicenseBundle({ desktop: f.desktop, inventoryPath: path.join(f.desktop, 'audit/INDEX.json') });
    f.bundleRoot = path.join(f.desktop, 'scope-extension/resources/licenses/native-dependencies');
    return f;
}
test('portable native materials package offline with no Rust compiler or registry', t => {
    const f = portableFixture(t); const exported = f.bundle(); assert.equal(exported.packages, 2);
    const result = f.collect({ includeCargo: true, cargoHome: '/unavailable/cargo', rustc: '/unavailable/rustc' });
    assert.equal(result.missing.length, 0);
    assert.equal(f.read().packages.filter(p => p.kind === 'cargo' || p.kind === 'runtime').length, 2);
    assert.ok(!fs.readFileSync(exported.manifest, 'utf8').includes(f.root));
});
test('portable native materials reject a changed lock or missing package instead of falling back silently', t => {
    const f = portableFixture(t); f.bundle();
    f.write('native/Cargo.lock', fs.readFileSync(path.join(f.desktop, 'native/Cargo.lock'), 'utf8') + '\n# changed\n');
    assert.throws(() => f.collect({ includeCargo: true }), /lock\/toolchain mismatch/);
    const file = path.join(f.bundleRoot, 'manifest.json'), m = JSON.parse(fs.readFileSync(file));
    m.cargoLockSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(f.desktop, 'native/Cargo.lock'))).digest('hex');
    m.packages = m.packages.filter(p => p.kind !== 'cargo'); fs.writeFileSync(file, JSON.stringify(m));
    assert.throws(() => f.collect({ includeCargo: true }), /Incomplete portable/);
});
test('portable native material tampering rejects packaging and incomplete inventory cannot overwrite a bundle', t => {
    const f = portableFixture(t); const exported = f.bundle(); const before = fs.readFileSync(exported.manifest);
    fs.writeFileSync(path.join(f.bundleRoot, 'cargo/test-crate/LICENSE'), 'Tampered');
    assert.throws(() => f.collect({ includeCargo: true }), /checksum mismatch/);
    f.write('audit/INDEX.json', { packages: [], missing: [] });
    assert.throws(() => f.bundle(), /Incomplete portable/);
    assert.deepEqual(fs.readFileSync(exported.manifest), before);
});
