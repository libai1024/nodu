// SPDX-License-Identifier: MIT
'use strict';

// Build-time only. End users receive these resources inside Nodu; this script
// never borrows the producer's installed compiler, profile cache or config.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { parseArgs } = require('node:util');
const yauzl = require('yauzl');
const packaging = require('./package-arduino.cjs');
const { CORE_VERSION, CLI_VERSION, INDEX_URL, PROFILE_ID, NATIVE_CTAGS_OVERRIDE, sha256File, relativePath, planPackages, verifyPlan, validateBundle, verifyFile } = packaging;
const desktop = path.resolve(__dirname, '..');
const INDEX_FILES = ['package_index.json', 'package_index.json.sig', 'package_esp32_index.json', 'library_index.json', 'library_index.json.sig'];

function fileRecord(root, file, metadata) {
    const stat = fs.statSync(file);
    return { path: path.relative(root, file).split(path.sep).join('/'), size: stat.size, sha256: sha256File(file), ...metadata };
}
function copyFile(source, target) {
    if (!fs.lstatSync(source).isFile()) { throw new Error(`归档必须是普通文件：${source}`); }
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target, fs.constants.COPYFILE_FICLONE);
}
async function download(asset, destination) {
    if (!/^https:\/\//.test(asset.url)) { throw new Error('Arduino 发布下载只允许 HTTPS'); }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
        const response = await fetch(asset.url, { signal: AbortSignal.timeout(20 * 60_000) });
        if (!response.ok || !response.body || !response.url.startsWith('https://')) { throw new Error(`下载失败 ${asset.url} (${response.status})`); }
        let size = 0;
        const chunks = async function* () {
            for await (const chunk of response.body) {
                size += chunk.length; if (size > (asset.size || 128 * 1024 * 1024)) { throw new Error('下载大小超过清单'); } yield chunk;
            }
        };
        await pipeline(chunks(), fs.createWriteStream(temporary, { flags: 'wx' }));
        if (asset.size && size !== asset.size || sha256File(temporary) !== asset.sha256) { throw new Error(`下载校验失败 ${asset.url}`); }
        fs.renameSync(temporary, destination);
    } finally { fs.rmSync(temporary, { force: true }); }
}
async function getAsset(asset, candidates, destination, allowDownload) {
    for (const source of candidates) {
        if (fs.existsSync(source) && fs.lstatSync(source).isFile() && (!asset.size || fs.statSync(source).size === asset.size) && sha256File(source) === asset.sha256) {
            copyFile(source, destination); return;
        }
    }
    if (!allowDownload) { throw new Error(`缺少已校验归档 ${path.basename(destination)}；使用 --download 获取官方固定版本`); }
    console.log(`prepare-arduino: ${path.basename(destination)}`);
    await download(asset, destination);
}
async function extractCore(zipFile, destination) {
    const prefix = `esp32-core-${CORE_VERSION}/`, seen = new Set(); let total = 0;
    await fsp.mkdir(destination, { recursive: true });
    return new Promise((resolve, reject) => {
        yauzl.open(zipFile, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
            if (error) { reject(error); return; }
            let failed = false;
            const fail = error => { if (!failed) { failed = true; zip.close(); reject(error); } };
            zip.on('error', fail); zip.on('end', () => { if (!failed) { resolve(); } });
            zip.on('entry', entry => { void (async () => {
                if (!entry.fileName.startsWith(prefix)) { throw new Error('Core 归档根目录无效'); }
                const name = entry.fileName.slice(prefix.length), directory = name.endsWith('/');
                if (!name) { zip.readEntry(); return; }
                const clean = directory ? name.slice(0, -1) : name;
                if (!relativePath(clean) || seen.has(clean.toLowerCase())) { throw new Error('Core 归档路径无效或重复'); } seen.add(clean.toLowerCase());
                const type = (entry.externalFileAttributes >>> 16) & 0o170000;
                if (type && type !== (directory ? 0o040000 : 0o100000)) { throw new Error('Core 归档含非普通文件'); }
                total += entry.uncompressedSize; if (total > 256 * 1024 * 1024) { throw new Error('Core 归档展开超限'); }
                const output = path.join(destination, clean);
                if (directory) { await fsp.mkdir(output, { recursive: true }); }
                else {
                    await fsp.mkdir(path.dirname(output), { recursive: true });
                    const input = await new Promise((yes, no) => zip.openReadStream(entry, (error, stream) => error ? no(error) : yes(stream)));
                    await pipeline(input, fs.createWriteStream(output, { flags: 'wx', mode: ((entry.externalFileAttributes >>> 16) & 0o111) ? 0o755 : 0o644 }));
                }
                zip.readEntry();
            })().catch(fail); });
            zip.readEntry();
        });
    });
}
function walkFiles(root) {
    const result = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) { walk(full); } else if (entry.isFile()) { result.push(full); } else { throw new Error(`资源中存在非普通文件 ${full}`); }
        }
    }
    walk(root); return result;
}
async function prepareBundle({ host = `${process.platform}-${process.arch}`, cacheHomes = [], indexHome, output, download: allowDownload = false, sourcesDir, nativeDir }) {
    if (!cacheHomes.length) { throw new Error('请通过 --cache-home 提供已下载的官方索引和归档缓存'); }
    const indexDir = path.join(indexHome || cacheHomes[0], 'data');
    const indices = { arduino: JSON.parse(fs.readFileSync(path.join(indexDir, 'package_index.json'), 'utf8')),
        esp32: JSON.parse(fs.readFileSync(path.join(indexDir, 'package_esp32_index.json'), 'utf8')) };
    const plan = planPackages(indices, host);
    verifyPlan(plan, host);
    const destination = path.resolve(output || path.join(desktop, '.tools/arduino-release', host));
    const staging = `${destination}.${crypto.randomUUID()}.tmp`; fs.mkdirSync(staging, { recursive: true });
    const files = [], components = [], sourceCoverage = [];
    try {
        for (const name of INDEX_FILES) {
            const target = `data/${name}`, file = path.join(staging, target); copyFile(path.join(indexDir, name), file);
            files.push(fileRecord(staging, file, { kind: 'index', target,
                url: name.startsWith('package_esp32') ? INDEX_URL : name.startsWith('library') ? 'https://downloads.arduino.cc/libraries/library_index.tar.bz2' : 'https://downloads.arduino.cc/packages/package_index.tar.bz2' }));
        }
        const cli = JSON.parse(fs.readFileSync(path.join(desktop, 'scope-extension/resources/arduino/cli-manifest.json'), 'utf8')).assets[host];
        if (!cli) { throw new Error(`缺少 ${host} 的 CLI 发行记录`); }
        const cliFile = path.join(staging, 'cli', cli.file);
        await getAsset(cli, [path.join(destination, 'cli', cli.file), ...cacheHomes.flatMap(home => [path.join(home, 'downloads', cli.file), path.join(home, cli.file)])], cliFile, allowDownload);
        files.push(fileRecord(staging, cliFile, { kind: 'cli', target: `downloads/${cli.file}`, url: cli.url }));
        components.push({ id: `arduino-cli@${CLI_VERSION}`, archive: `cli/${cli.file}`, url: cli.url });
        for (const asset of plan.records) {
            if (!relativePath(asset.archiveFileName) || asset.archiveFileName.includes('/')) { throw new Error('索引归档文件名无效'); }
            const target = `downloads/packages/${asset.archiveFileName}`, file = path.join(staging, target);
            await getAsset({ url: asset.url, sha256: asset.checksum.replace(/^SHA-256:/, '').toLowerCase(), size: Number(asset.size) }, [path.join(destination, target), ...cacheHomes.map(home => path.join(home, target))], file, allowDownload);
            files.push(fileRecord(staging, file, { kind: 'package', target, url: asset.url })); components.push({ id: asset.id, archive: target, url: asset.url });
        }
        // Profile installation always redownloads indices in CLI 1.5.1 unless
        // this immutable Core directory exists. Its ID hashes the public
        // profile reference only; no producer paths or build caches enter it.
        const coreDir = path.join(staging, 'data/internal', PROFILE_ID);
        await extractCore(path.join(staging, 'downloads/packages', plan.platform.archiveFileName), coreDir);
        fs.writeFileSync(path.join(coreDir, 'installed.json'), JSON.stringify({ packages: [{ ...plan.packager, platforms: [plan.platform] }], IsTrusted: false, version: 2 }, null, 2) + '\n');
        for (const file of walkFiles(coreDir)) {
            files.push(fileRecord(staging, file, { kind: 'profile', target: path.relative(staging, file).split(path.sep).join('/'), mode: fs.statSync(file).mode & 0o111 ? 0o755 : 0o644 }));
        }
        if (sourcesDir) {
            sourcesDir = path.resolve(sourcesDir);
            const sources = JSON.parse(fs.readFileSync(path.join(sourcesDir, 'source-manifest.json'), 'utf8'));
            if (sources.schemaVersion !== 1 || !Array.isArray(sources.files) || !Array.isArray(sources.coverage)) { throw new Error('对应源码清单无效'); }
            if (sources.hosts !== undefined && (!Array.isArray(sources.hosts) || !sources.hosts.includes(host))) { throw new Error('对应源码审查不覆盖当前发行主机'); }
            for (const record of sources.files) {
                if (!['source', 'license'].includes(record.kind)) { throw new Error('对应源码类型无效'); }
                const source = verifyFile(sourcesDir, record), output = path.join(staging, 'sources', record.path); copyFile(source, output);
                files.push(fileRecord(staging, output, { kind: record.kind, url: record.url }));
            }
            for (const record of sources.coverage) { sourceCoverage.push({ ...record, ...((record.hosts || sources.hosts) ? { hosts: record.hosts || sources.hosts } : {}), files: record.files.map(file => `sources/${file}`) }); }
        }
        if (nativeDir) {
            nativeDir = path.resolve(nativeDir);
            const native = JSON.parse(fs.readFileSync(path.join(nativeDir, 'manifest.json'), 'utf8'));
            if (native.schemaVersion !== 1 || native.host !== host || host !== 'darwin-arm64' || !Array.isArray(native.files) || native.files.length !== 1) { throw new Error('Arduino 原生 ctags 清单无效'); }
            const record = native.files[0];
            if (record.path !== 'ctags' || record.version !== '5.8-arduino11' || !/^[a-f0-9]{64}$/.test(record.sourceSha256)) { throw new Error('Arduino 原生 ctags 来源记录无效'); }
            const source = verifyFile(nativeDir, record), file = path.join(staging, 'native/ctags'); copyFile(source, file); fs.chmodSync(file, 0o755);
            files.push(fileRecord(staging, file, { kind: 'native', target: `tools/ctags/${host}/ctags`, mode: 0o755, version: record.version, sourceSha256: record.sourceSha256, buildBinarySha256: record.sha256 }));
            for (const [name, kind] of [['CTAGS-BUILD.json', 'source'], ['CTAGS-COPYING', 'license']]) {
                const output = path.join(staging, 'native', name); copyFile(path.join(nativeDir, name), output); files.push(fileRecord(staging, output, { kind }));
            }
            const recipe = path.join(staging, 'native/build-arduino-native-ctags.cjs'); copyFile(path.join(__dirname, 'build-arduino-native-ctags.cjs'), recipe);
            files.push(fileRecord(staging, recipe, { kind: 'source' }));
            const override = path.join(coreDir, 'platform.local.txt'); fs.writeFileSync(override, NATIVE_CTAGS_OVERRIDE);
            files.push(fileRecord(staging, override, { kind: 'profile', target: `data/internal/${PROFILE_ID}/platform.local.txt`, mode: 0o644 }));
        }
        const missingSources = components.filter(component => !sourceCoverage.some(coverage => coverage.component === component.id && coverage.complete === true
            && (coverage.hosts === undefined || (Array.isArray(coverage.hosts) && coverage.hosts.includes(host))))).map(component => component.id);
        const missingNative = host === 'darwin-arm64' && !files.some(file => file.kind === 'native');
        const manifest = { schemaVersion: 1, id: `arduino-esp32-${CORE_VERSION}-cli-${CLI_VERSION}-${host}`, host, cliVersion: CLI_VERSION, coreVersion: CORE_VERSION,
            profileId: PROFILE_ID, profileIdentity: `esp32:esp32@${CORE_VERSION} (${INDEX_URL})`,
            releaseReady: missingSources.length === 0 && !missingNative, missingSources, missingNative, components, sourceCoverage,
            totalBytes: files.reduce((sum, file) => sum + file.size, 0), files: files.sort((a, b) => a.path.localeCompare(b.path)) };
        fs.writeFileSync(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
        validateBundle(staging, host, { allowUnreleased: true });
        const previous = `${destination}.${crypto.randomUUID()}.old`;
        if (fs.existsSync(destination)) { fs.renameSync(destination, previous); }
        try { fs.renameSync(staging, destination); } catch (error) { if (fs.existsSync(previous)) { fs.renameSync(previous, destination); } throw error; }
        fs.rmSync(previous, { recursive: true, force: true });
        return { destination, files: files.length, totalBytes: manifest.totalBytes, releaseReady: manifest.releaseReady, missingSources };
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
if (require.main === module) {
    const { values } = parseArgs({ options: { host: { type: 'string' }, 'cache-home': { type: 'string', multiple: true }, 'index-home': { type: 'string' }, output: { type: 'string' }, download: { type: 'boolean' }, 'sources-dir': { type: 'string' }, 'native-dir': { type: 'string' }, help: { type: 'boolean' } } });
    if (values.help) { console.log('prepare-arduino-release --cache-home <official-cache-home> [--index-home <home>] [--host darwin-arm64] [--download] [--sources-dir <dir>] [--native-dir <host-dir>] [--output <bundle>]'); }
    else { prepareBundle({ host: values.host, cacheHomes: values['cache-home'] || [], indexHome: values['index-home'], output: values.output, download: values.download, sourcesDir: values['sources-dir'], nativeDir: values['native-dir'] }).then(result => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error.message); process.exitCode = 1; }); }
}
module.exports = { prepareBundle, extractCore, fileRecord, walkFiles, getAsset };
