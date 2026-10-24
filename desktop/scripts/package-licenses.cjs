// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const safeName = value => value.replace(/[^a-zA-Z0-9._-]/g, '_');
const LICENSE_NAME = /^(?:licen[cs]e|copying|copyright|notice|unlicense|third[-_ ]?party[-_ ]?notices?)(?:[._ -]|$)/i;
const MAX_FILE = 20 * 1024 * 1024;

function regularRead(file, root) {
    const realRoot = fs.realpathSync(root), real = fs.realpathSync(file);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) throw new Error('License material escapes its package');
    const st = fs.statSync(real);
    if (!st.isFile() || st.size > MAX_FILE) throw new Error(`Invalid license material: ${path.basename(file)}`);
    return fs.readFileSync(real);
}

function licenseFiles(root) {
    const result = [];
    // Root notices plus named license folders; do not traverse node_modules or
    // mistake a dependency's license for its parent package's license.
    const walk = (dir, inside, depth) => {
        if (depth > 5) throw new Error('License folder exceeds depth limit');
        for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            if (item.name.startsWith('.') || item.name === 'node_modules') continue;
            const file = path.join(dir, item.name);
            const selected = inside || LICENSE_NAME.test(item.name) || /^licen[cs]es$/i.test(item.name);
            if (item.isDirectory()) { if (selected) walk(file, true, depth + 1); }
            else if (selected) result.push(path.relative(root, file));
        }
    };
    walk(root, false, 0);
    if (!result.length) {
        for (const name of fs.readdirSync(root).filter(n => /^readme(?:\.|$)/i.test(n))) {
            const bytes = regularRead(path.join(root, name), root);
            const text = bytes.toString('utf8');
            if ((/Permission is hereby granted/i.test(text) && /THE SOFTWARE IS PROVIDED/i.test(text))
                || (/Redistribution and use in source and binary forms/i.test(text) && /THIS SOFTWARE IS PROVIDED/i.test(text))) result.push(name);
        }
    }
    return result;
}

function resolvePackage(name, from) {
    if (!/^(?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid package dependency name');
    let current = from;
    while (true) {
        const candidate = path.join(current, 'node_modules', name, 'package.json');
        if (fs.existsSync(candidate)) return path.dirname(candidate);
        const next = path.dirname(current);
        if (next === current) return undefined;
        current = next;
    }
}

function tomlField(text, key) {
    const match = text.match(new RegExp('^' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")', 'm'));
    return match ? JSON.parse(match[1]) : undefined;
}
function cargoPackages(file) {
    return fs.readFileSync(file, 'utf8').split(/^\[\[package\]\]\s*$/m).slice(1).map(block => ({
        name: tomlField(block, 'name'), version: tomlField(block, 'version'), source: tomlField(block, 'source'), checksum: tomlField(block, 'checksum'),
    }));
}

function nativeInputs(desktop) {
    const lock = path.join(desktop, 'native/Cargo.lock');
    const toolchain = path.join(desktop, 'native/rust-toolchain.toml');
    return { cargoLockSha256: sha(fs.readFileSync(lock)), rustToolchainSha256: sha(fs.readFileSync(toolchain)),
        rustVersion: fs.readFileSync(toolchain, 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1],
        crates: cargoPackages(lock).filter(p => p.source) };
}
function checkNativeRecords(records, inputs) {
    if (!Array.isArray(records)) throw new Error('Invalid portable native license package list');
    const expected = new Map(inputs.crates.map(p => [`${p.name}@${p.version}`, p]));
    const seen = new Set(); let runtime = 0;
    for (const item of records) {
        if (item.kind === 'cargo') {
            const key = `${item.name}@${item.version}`, pkg = expected.get(key);
            if (!pkg || seen.has(key) || item.checksum !== pkg.checksum || item.source !== pkg.source) throw new Error('Portable native license Cargo.lock entry mismatch');
            seen.add(key);
        } else if (item.kind === 'runtime' && item.name === 'Rust standard library' && item.version === inputs.rustVersion) runtime++;
        else throw new Error('Unexpected portable native license package');
        if (item.missing || !Array.isArray(item.materials) || !item.materials.length) throw new Error('Missing portable native license material');
    }
    if (seen.size !== expected.size || runtime !== 1) throw new Error('Incomplete portable native license package set');
}
function checkMaterial(root, material) {
    if (!material || typeof material.file !== 'string' || !material.file || material.file.includes('\\') || material.file.split('/').some(p => !p || p === '.' || p === '..') || path.isAbsolute(material.file)) throw new Error('Invalid portable license material path');
    const bytes = regularRead(path.join(root, material.file), root);
    if (bytes.length !== material.size || sha(bytes) !== material.sha256) throw new Error('Portable native license material checksum mismatch');
    return bytes;
}
function readNativeLicenseBundle(desktop, root) {
    const inputs = nativeInputs(desktop), manifest = readJson(path.join(root, 'manifest.json'));
    if (manifest.schema !== 1 || manifest.cargoLockSha256 !== inputs.cargoLockSha256 || manifest.rustToolchainSha256 !== inputs.rustToolchainSha256 || manifest.rustVersion !== inputs.rustVersion) throw new Error('Portable native license lock/toolchain mismatch; regenerate materials');
    checkNativeRecords(manifest.packages, inputs);
    for (const item of manifest.packages) for (const material of item.materials) checkMaterial(root, material);
    return manifest;
}
function writeNativeLicenseBundle({ desktop, inventoryPath, outDir = path.join(desktop, 'scope-extension/resources/licenses/native-dependencies') }) {
    const inputs = nativeInputs(desktop), inventory = readJson(inventoryPath);
    const records = inventory.packages.filter(p => p.kind === 'cargo' || p.kind === 'runtime');
    checkNativeRecords(records, inputs);
    if ((inventory.missing || []).some(p => p.kind === 'cargo' || p.kind === 'runtime')) throw new Error('Cannot export incomplete native license inventory');
    const root = path.dirname(inventoryPath), blobs = new Map();
    for (const item of records) for (const material of item.materials) blobs.set(material.file, checkMaterial(root, material));
    // Validate everything before replacing an existing portable bundle.
    fs.rmSync(outDir, { recursive: true, force: true }); fs.mkdirSync(outDir, { recursive: true });
    for (const [file, bytes] of blobs) { const dest = path.join(outDir, file); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, bytes); }
    const { crates, ...identity } = inputs;
    const manifest = { schema: 1, ...identity,
        coverage: 'Fixed Cargo.lock source superset and pinned Rust distribution notices. Portable material input; no Rust installation or network access is needed during packaging.',
        packages: records };
    fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return { packages: records.length, materials: blobs.size, manifest: path.join(outDir, 'manifest.json') };
}

function collectPackageLicenses(options) {
    const { desktop, workDesktop, appInput } = options;
    const roots = options.workspaceNames || ['scope-extension', 'browser-app', 'electron-app'];
    const out = path.join(appInput, 'licenses');
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(out, { recursive: true });
    const records = [], missing = [], absentOptional = [];
    const fallbackRoot = options.fallbackRoot || path.join(desktop, 'scope-extension/resources/licenses/package-fallbacks');
    const fallbackManifest = path.join(fallbackRoot, 'manifest.json');
    const fallbacks = fs.existsSync(fallbackManifest) ? readJson(fallbackManifest).packages : [];
    const saveMaterial = (base, relative, dest, source) => {
        const bytes = regularRead(path.resolve(base, relative), base);
        const rel = path.join(dest, relative).replaceAll(path.sep, '/');
        const target = path.join(out, rel);
        if (!path.resolve(target).startsWith(path.resolve(out) + path.sep)) throw new Error('Invalid license output path');
        fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
        return { file: rel, size: bytes.length, sha256: sha(bytes), ...(source ? { source } : {}) };
    };
    function record(kind, name, version, root, meta = {}) {
        const key = `${kind}:${name}@${version}:${meta.lockPath || meta.checksum || ""}`;
        const folder = `${kind}/${safeName(name)}@${safeName(version)}-${sha(key).slice(0, 10)}`;
        const item = { kind, name, version, ...meta, materials: [] };
        if (root) for (const relative of licenseFiles(root)) item.materials.push(saveMaterial(root, relative, folder));
        for (const fallback of fallbacks || []) {
            if (fallback.kind !== kind || fallback.name !== name || fallback.version !== version) continue;
            (item.supplements ||= []).push({ upstreamCommit: fallback.upstreamCommit || null, materialBasis: fallback.materialBasis || 'Original license material from fixed upstream revision' });
            for (const material of fallback.materials || []) {
                const bytes = regularRead(path.join(fallbackRoot, material.path), fallbackRoot);
                if (sha(bytes) !== material.sha256 || !/^https:\/\//.test(material.source || '')) throw new Error(`Invalid fixed-source license: ${name}@${version}`);
                item.materials.push(saveMaterial(fallbackRoot, material.path, `${folder}/upstream`, material.source));
            }
        }
        if (!item.materials.length) {
            const failure = { kind, name, version, reason: root ? 'No complete license/notice material in package or fixed-source supplement' : 'Dependency source unavailable' };
            missing.push(failure); item.missing = failure.reason;
        }
        records.push(item);
    }

    const lockPath = path.join(workDesktop, 'package-lock.json');
    const lock = readJson(lockPath);
    const seen = new Set();
    const localNames = new Set(roots.map(dir => readJson(path.join(workDesktop, dir, 'package.json')).name));
    const visit = (name, from, optional, via) => {
        if (localNames.has(name)) return;
        const dir = resolvePackage(name, from);
        if (!dir) {
            const failure = { kind: 'npm', name, via, reason: 'Dependency not installed' };
            if (optional) absentOptional.push(failure); else missing.push(failure);
            return;
        }
        const identity = fs.realpathSync(dir);
        if (seen.has(identity)) return;
        seen.add(identity);
        const pkg = readJson(path.join(dir, 'package.json'));
        const lockKey = path.relative(workDesktop, dir).replaceAll(path.sep, '/');
        const locked = lock.packages?.[lockKey];
        if (!locked || locked.version !== pkg.version) throw new Error(`Installed package differs from lockfile: ${name}`);
        record('npm', pkg.name || name, pkg.version, dir, {
            license: pkg.license || pkg.licenses || null,
            ...(pkg.author ? { author: pkg.author } : {}),
            ...(pkg.repository ? { repository: pkg.repository } : {}),
            ...(pkg.gitHead ? { gitHead: pkg.gitHead } : {}),
            lockPath: lockKey, integrity: locked.integrity || null,
        });
        const opt = pkg.optionalDependencies || {};
        for (const [dep] of Object.entries(pkg.dependencies || {})) visit(dep, dir, Object.hasOwn(opt, dep), `${pkg.name}@${pkg.version}`);
        for (const dep of Object.keys(opt)) if (!Object.hasOwn(pkg.dependencies || {}, dep)) visit(dep, dir, true, `${pkg.name}@${pkg.version}`);
        for (const dep of Object.keys(pkg.peerDependencies || {})) visit(dep, dir, Boolean(pkg.peerDependenciesMeta?.[dep]?.optional), `${pkg.name}@${pkg.version} (peer)`);
    };
    for (const directory of roots) {
        const location = path.join(workDesktop, directory), pkg = readJson(path.join(location, 'package.json'));
        const optional = pkg.optionalDependencies || {};
        for (const dep of Object.keys(pkg.dependencies || {})) visit(dep, location, Object.hasOwn(optional, dep), pkg.name);
        for (const dep of Object.keys(optional)) if (!Object.hasOwn(pkg.dependencies || {}, dep)) visit(dep, location, true, pkg.name);
    }

    const fontPath = path.join(desktop, 'scope-extension/style/fonts');
    record('font', 'IBM Plex', 'bundled', fontPath, { license: 'OFL-1.1' });
    // The font file has a project-specific prefix, so include it explicitly.
    const font = records.at(-1);
    if (fs.existsSync(path.join(fontPath, 'FONT-LICENSE.txt'))) {
        font.materials.push(saveMaterial(fontPath, 'FONT-LICENSE.txt', 'font/IBM-Plex'));
        delete font.missing;
        const index = missing.findIndex(x => x.kind === 'font'); if (index >= 0) missing.splice(index, 1);
    }

    if (options.includeCargo !== false) {
        const portable = options.nativeBundleRoot === null ? null : options.nativeBundleRoot || path.join(desktop, 'scope-extension/resources/licenses/native-dependencies');
        if (portable && fs.existsSync(path.join(portable, 'manifest.json'))) {
            const manifest = readNativeLicenseBundle(desktop, portable);
            for (const item of manifest.packages) {
                if (item.kind === 'runtime' && options.includeRustRuntime === false) continue;
                const materials = item.materials.map(m => {
                    const bytes = checkMaterial(portable, m), target = path.join(out, m.file);
                    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
                    return { ...m };
                });
                records.push({ ...item, materials });
            }
        } else {
            const cargoRoot = options.cargoHome || process.env.CARGO_HOME || path.join(os.homedir(), '.cargo');
            const registry = path.join(cargoRoot, 'registry/src');
            const indexes = fs.existsSync(registry) ? fs.readdirSync(registry).map(p => path.join(registry, p)) : [];
            for (const pkg of cargoPackages(path.join(desktop, 'native/Cargo.lock'))) {
                if (!pkg.source) continue; // workspace-authored crates use root MIT
                let source;
                for (const index of indexes) {
                    const candidate = path.join(index, `${pkg.name}-${pkg.version}`);
                    if (!fs.existsSync(path.join(candidate, 'Cargo.toml'))) continue;
                    const archive = path.join(cargoRoot, 'registry/cache', path.basename(index), `${pkg.name}-${pkg.version}.crate`);
                    if (!fs.existsSync(archive) || sha(fs.readFileSync(archive)) !== pkg.checksum) continue;
                    source = candidate; break;
                }
                const cargoToml = source ? fs.readFileSync(path.join(source, 'Cargo.toml'), 'utf8').split(/^\[dependencies/m)[0] : '';
                record('cargo', pkg.name, pkg.version, source, {
                    license: tomlField(cargoToml, 'license') || null, source: pkg.source, checksum: pkg.checksum || null,
                    scope: 'Cargo.lock source superset (includes build and non-host dependencies)',
                });
            }
            if (options.includeRustRuntime !== false) {
                let sysroot;
                try { sysroot = execFileSync(options.rustc || path.join(cargoRoot, 'bin', process.platform === 'win32' ? 'rustc.exe' : 'rustc'), ['--print', 'sysroot'], { cwd: path.join(desktop, 'native'), encoding: 'utf8' }).trim(); } catch {}
                record('runtime', 'Rust standard library', fs.readFileSync(path.join(desktop, 'native/rust-toolchain.toml'), 'utf8').match(/channel\s*=\s*"([^"]+)"/)?.[1] || 'pinned',
                    sysroot && fs.existsSync(path.join(sysroot, 'share/doc/rust')) ? path.join(sysroot, 'share/doc/rust') : undefined,
                    { license: 'See compiler distribution copyright and licenses' });
            }
        }
    }
    records.sort((a, b) => `${a.kind}:${a.name}@${a.version}`.localeCompare(`${b.kind}:${b.name}@${b.version}`));
    const index = { schema: 1, applicationVersion: readJson(path.join(workDesktop, 'electron-app/package.json')).version,
        npmLockSha256: sha(fs.readFileSync(lockPath)), roots,
        coverage: 'Installed production, optional and peer npm dependency closure; Cargo.lock source superset; bundled fonts and Rust runtime. Electron, plugins, STM32, WASI and media retain separate inventories and notices.',
        packages: records, missing, absentOptional };
    fs.writeFileSync(path.join(out, 'INDEX.json'), JSON.stringify(index, null, 2) + '\n');
    const summary = ['# Packaged third-party materials', '', index.coverage, '',
        `Packages: ${records.length}. Missing material or required dependency: ${missing.length}. Absent optional dependencies: ${absentOptional.length}.`, '',
        'INDEX.json records exact versions, lockfile identity, original material hashes and any fixed upstream supplement. Supplements based on a declared SPDX identifier retain the upstream declaration and attribution and label that basis explicitly. This inventory is not a legal opinion or a claim that every package listed is linked into the application.', '',
        '| Kind | Package | Version | Declared license | Materials |', '| --- | --- | --- | --- | --- |',
        ...records.map(r => `| ${r.kind} | ${r.name} | ${r.version} | ${String(typeof r.license === 'string' ? r.license : JSON.stringify(r.license)).replaceAll('|', '\\|')} | ${r.materials.length || '**MISSING**'} |`),
        '', '## Missing materials / dependencies', '', ...(missing.length ? missing.map(m => `- ${m.kind} ${m.name}@${m.version || '?'}: ${m.reason}`) : ['None.']), '',
        '## Separately retained', '', '- Electron runtime LICENSE and LICENSES.chromium.html in the application bundle.', '- Plugins keep their original license files and Nodu patch records.', '- STM32, WASI and media resources keep their own inventories, licenses and source materials.', '- Nodu-authored code is covered by the application root LICENSE.', ''];
    fs.writeFileSync(path.join(out, 'SUMMARY.md'), summary.join('\n'));
    if (missing.length && !options.allowMissing) throw new Error(`Package license inventory has ${missing.length} unresolved entries; see licenses/INDEX.json`);
    return { packages: records.length, materials: records.reduce((n, p) => n + p.materials.length, 0), missing, absentOptional, index: path.join(out, 'INDEX.json') };
}
module.exports = { collectPackageLicenses, resolvePackage, licenseFiles, cargoPackages, writeNativeLicenseBundle, readNativeLicenseBundle };
