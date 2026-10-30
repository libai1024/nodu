// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CORE_VERSION = '3.3.12';
const CLI_VERSION = '1.5.1';
const INDEX_URL = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
const PROFILE_ID = `esp32_esp32_${CORE_VERSION}_${crypto.createHash('sha256').update(`esp32:esp32@${CORE_VERSION} (${INDEX_URL})`).digest('hex').slice(0, 16)}`;
const NATIVE_CTAGS_OVERRIDE = '# Nodu: use the bundled native Apple Silicon Arduino ctags.\ntools.ctags.path={runtime.platform.path}/../../../tools/ctags/darwin-arm64\n';
const BUILTINS = { ctags: '5.8-arduino11', 'dfu-discovery': '0.1.2', 'mdns-discovery': '1.1.0', 'serial-discovery': '1.5.2', 'serial-monitor': '0.15.0' };
const HOSTS = {
    // Match pinned CLI 1.5.1: aarch64-apple-darwin is NOT recognized by its
    // host matcher, so mklittlefs currently selects the official x64 archive.
    'darwin-arm64': ['arm64-apple-darwin', 'x86_64-apple-darwin', 'i386-apple-darwin11'],
    'darwin-x64': ['x86_64-apple-darwin', 'i386-apple-darwin11'],
    'win32-x64': ['x86_64-mingw32', 'i686-mingw32'],
    'linux-x64': ['x86_64-pc-linux-gnu', 'x86_64-linux-gnu'],
    'linux-arm64': ['aarch64-linux-gnu', 'arm64-linux-gnueabihf'],
};
function sha256File(file) {
    const hash = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(1024 * 1024);
    try { let n; while ((n = fs.readSync(fd, buffer, 0, buffer.length, null))) { hash.update(buffer.subarray(0, n)); } }
    finally { fs.closeSync(fd); }
    return hash.digest('hex');
}
function relativePath(value) {
    return typeof value === 'string' && !!value && !value.includes('\\') && !value.includes(':') && !value.includes('\0')
        && !path.posix.isAbsolute(value) && !value.split('/').some(part => !part || part === '.' || part === '..');
}
function verifyFile(root, record) {
    if (!relativePath(record.path) || !/^[a-f0-9]{64}$/.test(record.sha256) || !Number.isSafeInteger(record.size) || record.size < 0) {
        throw new Error('Arduino 离线资源清单无效');
    }
    const file = path.join(root, record.path), realRoot = fs.realpathSync(root);
    for (let next = file; next !== root && next.length >= root.length; next = path.dirname(next)) {
        if (fs.lstatSync(next).isSymbolicLink()) { throw new Error(`Arduino 资源不能为符号链接：${record.path}`); }
    }
    const stat = fs.statSync(file);
    if (!fs.realpathSync(file).startsWith(realRoot + path.sep) || !stat.isFile() || stat.size !== record.size || sha256File(file) !== record.sha256) {
        throw new Error(`Arduino 离线资源损坏：${record.path}`);
    }
    return file;
}
function planPackages(indices, host) {
    const preference = HOSTS[host]; if (!preference) { throw new Error(`不支持 Arduino 发布目标 ${host}`); }
    const packages = [...indices.esp32.packages, ...indices.arduino.packages];
    const esp = indices.esp32.packages.find(pkg => pkg.name === 'esp32');
    const platform = esp?.platforms.find(item => item.architecture === 'esp32' && item.version === CORE_VERSION);
    if (!platform) { throw new Error(`索引缺少 ESP32 Core ${CORE_VERSION}`); }
    const records = [{ id: `esp32:esp32@${CORE_VERSION}`, ...platform }];
    for (const dependency of [...platform.toolsDependencies, ...Object.entries(BUILTINS).map(([name, version]) => ({ packager: 'builtin', name, version }))]) {
        const tool = packages.filter(pkg => pkg.name === dependency.packager).flatMap(pkg => pkg.tools || [])
            .find(item => item.name === dependency.name && item.version === dependency.version);
        const asset = preference.map(candidate => tool?.systems.find(system => system.host === candidate)).find(Boolean);
        if (!asset) { throw new Error(`索引缺少 ${dependency.packager}:${dependency.name}@${dependency.version} 的 ${host} 归档`); }
        records.push({ id: `${dependency.packager}:${dependency.name}@${dependency.version}`, ...asset });
    }
    return { platform, packager: esp, records };
}
function verifyPlan(plan, host) {
    const locked = require('./arduino-release.lock.json').hosts[host];
    if (!locked || Object.keys(locked).length !== plan.records.length) { throw new Error('Arduino 官方资源锁与依赖闭包不一致'); }
    for (const asset of plan.records) {
        const record = locked[asset.id];
        if (!record || record.file !== asset.archiveFileName || record.url !== asset.url || record.size !== Number(asset.size)
            || record.sha256 !== asset.checksum.replace(/^SHA-256:/, '').toLowerCase()) {
            throw new Error(`Arduino 官方资源锁不匹配：${asset.id}`);
        }
    }
}
function validateBundle(root, expectedHost, { allowUnreleased = false } = {}) {
    root = path.resolve(root);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    if (manifest.schemaVersion !== 1 || manifest.host !== expectedHost || !HOSTS[manifest.host] || manifest.cliVersion !== CLI_VERSION
        || manifest.coreVersion !== CORE_VERSION || !Array.isArray(manifest.files) || !manifest.files.length || typeof manifest.id !== 'string') {
        throw new Error('Arduino 离线资源版本或主机不匹配');
    }
    const paths = new Set(), targets = new Set();
    for (const record of manifest.files) {
        const key = record.path?.toLowerCase(); if (paths.has(key)) { throw new Error(`Arduino 资源路径重复：${record.path}`); } paths.add(key);
        if (!['index', 'package', 'cli', 'profile', 'native', 'source', 'license'].includes(record.kind)) { throw new Error('Arduino 资源类型无效'); }
        if (['source', 'license'].includes(record.kind)) { if (record.target !== undefined) { throw new Error('源码与许可不得写入运行目录'); } }
        else {
            if (!relativePath(record.target) || targets.has(record.target.toLowerCase())) { throw new Error('Arduino 资源目标无效或重复'); }
            targets.add(record.target.toLowerCase());
            const valid = record.kind === 'index' ? /^data\/(?:package_index\.json(?:\.sig)?|package_esp32_index\.json|library_index\.json(?:\.sig)?)$/.test(record.target)
                : record.kind === 'package' ? /^downloads\/packages\/[^/]+$/.test(record.target)
                    : record.kind === 'cli' ? /^downloads\/arduino-cli_[^/]+\.(?:tar\.gz|zip)$/.test(record.target)
                        : record.kind === 'native' ? record.target === `tools/ctags/${manifest.host}/ctags` && manifest.host === 'darwin-arm64'
                            : record.target.startsWith(`data/internal/${PROFILE_ID}/`);
            if (!valid) { throw new Error(`Arduino 资源目标不在约定目录：${record.target}`); }
        }
        if (record.mode !== undefined && ![0o644, 0o755].includes(record.mode)) { throw new Error('Arduino 资源权限无效'); }
        verifyFile(root, record);
    }
    const byTarget = target => manifest.files.find(file => file.target === target);
    const readIndex = name => {
        const record = byTarget(`data/${name}`); if (!record) { throw new Error(`Arduino 离线资源缺少索引 ${name}`); }
        return JSON.parse(fs.readFileSync(path.join(root, record.path), 'utf8'));
    };
    const plan = planPackages({ esp32: readIndex('package_esp32_index.json'), arduino: readIndex('package_index.json') }, expectedHost);
    verifyPlan(plan, expectedHost);
    readIndex('library_index.json');
    for (const asset of plan.records) {
        const record = byTarget(`downloads/packages/${asset.archiveFileName}`);
        if (!record || record.sha256 !== asset.checksum.replace(/^SHA-256:/, '').toLowerCase() || record.size !== Number(asset.size)) {
            throw new Error(`Arduino 离线资源缺少或不匹配 ${asset.id}`);
        }
    }
    const cliManifest = JSON.parse(fs.readFileSync(path.join(__dirname, '../scope-extension/resources/arduino/cli-manifest.json'), 'utf8'));
    const cliAsset = cliManifest.assets[expectedHost], cli = byTarget(`downloads/${cliAsset.file}`);
    if (!cli || cli.kind !== 'cli' || cli.sha256 !== cliAsset.sha256) { throw new Error('Arduino 离线资源缺少固定版本 CLI'); }
    for (const file of ['boards.txt', 'platform.txt', 'installed.json']) {
        if (!byTarget(`data/internal/${PROFILE_ID}/${file}`)) { throw new Error(`Arduino 离线资源缺少 profile Core ${file}`); }
    }
    const required = ['arduino-cli@1.5.1', ...plan.records.map(record => record.id)];
    const missingSources = required.filter(component => !manifest.sourceCoverage?.some(item => item.component === component && item.complete === true
        && (item.hosts === undefined || (Array.isArray(item.hosts) && item.hosts.includes(expectedHost)))
        && Array.isArray(item.files) && item.files.length && item.files.every(file => manifest.files.some(record => record.path === file && ['source', 'license'].includes(record.kind)))
        && item.files.some(file => manifest.files.some(record => record.path === file && record.kind === 'source'))));
    if (!allowUnreleased && (manifest.releaseReady !== true || missingSources.length)) {
        throw new Error(`Arduino 离线包缺少对应源码交付：${missingSources.join(', ') || '未完成发布材料审查'}`);
    }
    if (!allowUnreleased && expectedHost === 'darwin-arm64') {
        const native = byTarget('tools/ctags/darwin-arm64/ctags');
        if (!native || native.kind !== 'native' || native.mode !== 0o755 || native.version !== '5.8-arduino11'
            || !manifest.sourceCoverage?.some(coverage => coverage.component === 'builtin:ctags@5.8-arduino11'
                && coverage.files.some(file => manifest.files.some(record => record.path === file && record.kind === 'source' && record.sha256 === native.sourceSha256)))) {
            throw new Error('Arduino arm64 发行包缺少对应源码可追溯的原生 ctags');
        }
        const header = Buffer.alloc(12), fd = fs.openSync(path.join(root, native.path), 'r');
        try { fs.readSync(fd, header, 0, 12, 0); } finally { fs.closeSync(fd); }
        if (header.readUInt32LE(0) !== 0xfeedfacf || header.readUInt32LE(4) !== 0x0100000c) { throw new Error('Arduino ctags 不是原生 arm64 Mach-O'); }
        const override = byTarget(`data/internal/${PROFILE_ID}/platform.local.txt`);
        if (!override || fs.readFileSync(path.join(root, override.path), 'utf8') !== NATIVE_CTAGS_OVERRIDE) { throw new Error('Arduino 原生 ctags 缺少可迁移的平台配置'); }
    }
    return manifest;
}
function bundleSource(desktop, host) {
    return path.join(process.env.NODU_ARDUINO_RELEASE_BUNDLES || path.join(desktop, '.tools/arduino-release'), host);
}
function copyBundle(source, resources, host, hosts = [host], options = {}) {
    const manifest = validateBundle(source, host, options), root = path.join(resources, 'arduino/offline'), destination = path.join(root, host);
    fs.mkdirSync(destination, { recursive: true });
    for (const record of manifest.files) {
        const file = path.join(destination, record.path); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.copyFileSync(path.join(source, record.path), file, fs.constants.COPYFILE_FICLONE); if (record.mode) { fs.chmodSync(file, record.mode); }
    }
    fs.copyFileSync(path.join(source, 'manifest.json'), path.join(destination, 'manifest.json'));
    fs.writeFileSync(path.join(root, 'required.json'), JSON.stringify({ schemaVersion: 1, hosts: [...hosts].sort() }, null, 2) + '\n');
    return manifest;
}
function refreshManifests(appPath) {
    function visit(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) { visit(file); }
            else if (entry.name === 'manifest.json' && path.basename(path.dirname(directory)) === 'offline' && HOSTS[path.basename(directory)]) {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) { throw new Error('Arduino 签名后资源清单无效'); }
                for (const record of manifest.files.filter(item => item.kind === 'native')) {
                    if (!relativePath(record.path)) { throw new Error('Arduino 原生工具路径无效'); }
                    const full = path.join(directory, record.path);
                    record.buildBinarySha256 ||= record.sha256;
                    record.sha256 = sha256File(full); record.size = fs.statSync(full).size;
                }
                manifest.totalBytes = manifest.files.reduce((total, record) => total + record.size, 0);
                fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
            }
        }
    }
    visit(appPath);
}
module.exports = { CORE_VERSION, CLI_VERSION, INDEX_URL, PROFILE_ID, NATIVE_CTAGS_OVERRIDE, BUILTINS, HOSTS, sha256File, relativePath, verifyFile, planPackages, verifyPlan, validateBundle, bundleSource, copyBundle, refreshManifests };
