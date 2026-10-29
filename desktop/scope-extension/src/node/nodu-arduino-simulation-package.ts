// SPDX-License-Identifier: MIT
/** ESP simulation handoff producer. No compiler, shell, RPC, or current-build mutation. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { arduinoInputDigest, readArduinoProject } from './nodu-arduino-project';
import { readArduinoLibraryProfile } from './nodu-arduino-libraries';
import { readArduinoFlashPlan } from './nodu-arduino-upload';
import { installedArduinoCore } from './nodu-arduino-boards';

export interface ArduinoSimulationDependency {
    provider: 'core' | 'tool' | 'library' | 'local'; name: string; version: string;
    /** Trusted resolver output, never a path supplied by an imported manifest. */
    path: string; kind: 'tree' | 'file'; license: string;
    url?: string; expectedSha256?: string; relationship: string;
}
export interface ArduinoSimulationInputs {
    projectPath: string; dependencies: ArduinoSimulationDependency[];
    producerVersion: string; cliVersion: '1.5.1'; coreVersion: '3.3.12'; idfVersion: '5.5.5';
    signal?: AbortSignal;
}
export interface ArduinoSimulationSnapshot { readonly id: string; readonly inputDigest: string; readonly dependencyDigest: string }
export interface ArduinoSimulationBuild {
    /** Resolved exclusively from the service's successful-build Map, never client input. */
    token: string; path: string; directory: string; digest: string; artifacts: string; fqbn: string;
}
export interface ArduinoSimulationExport {
    snapshot: ArduinoSimulationSnapshot; build: ArduinoSimulationBuild; buildLog: Buffer;
    /** Re-resolve the live token, reject failed/stale/replaced builds and changed fingerprints. */
    verifyCurrent(): Promise<void>;
    signal?: AbortSignal;
}
export interface ArduinoSimulationPackage {
    bytes: Buffer; manifest: Record<string, unknown>; contentDigest: string; packageSha256: string;
    elfSha256: string; fullflashSha256: string;
}
type JsonRecord = Record<string, unknown>;
interface SnapshotState {
    request: ArduinoSimulationInputs; project: Awaited<ReturnType<typeof readArduinoProject>>;
    sources: Map<string, Buffer>; sourceDigest: string; locks: JsonRecord[];
}
const snapshots = new WeakMap<ArduinoSimulationSnapshot, SnapshotState>();
const publicationGuards = new WeakMap<ArduinoSimulationPackage, () => Promise<void>>();
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const stop = (signal?: AbortSignal): void => { if (signal?.aborted) { throw new Error('已停止导出仿真包。'); } };
function fail(message: string): never { throw new Error(message); }
const MAX_FILE = 32 * 1024 * 1024;
const ordered = (entries: [string, unknown][]): JsonRecord => Object.fromEntries(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
const digestFiles = (files: Map<string, Buffer>): string => sha(JSON.stringify(ordered([...files].map(([p, b]) => [p, sha(b)]))));
const excluded = /^(?:\.git|\.nodu|\.theia|\.vscode|build|node_modules)$/;

/** Resolve evidence from installed official profile packages. Never installs or downloads anything.
 * Selected compiler/SDK/image tool and all project libraries lock installed contents. Unused Core
 * tool dependencies lock the actual cached archive and are explicitly labelled as declaration only.
 */
export async function discoverArduinoSimulationDependencies(home: string, projectPath: string, cliPath: string): Promise<ArduinoSimulationDependency[]> {
    const project = await readArduinoProject(projectPath), profile = await readArduinoLibraryProfile(project.path);
    if (!['esp32c3', 'esp32s3'].includes(project.chip) || project.coreVersion !== '3.3.12') { fail('仅支持固定版本的 C3/S3 Arduino 工程。'); }
    const core = await installedArduinoCore(home, project.coreVersion); if (!core) { fail('请先准备固定版本的 Arduino 环境。'); }
    const metadata = JSON.parse((await readFile(join(core, 'installed.json'))).toString('utf8'));
    const pack = metadata.packages?.find((p: { name?: string }) => p.name === 'esp32');
    const platform = pack?.platforms?.find((p: { version?: string }) => p.version === project.coreVersion);
    if (!platform || !Array.isArray(platform.toolsDependencies) || !(await readFile(join(core, 'platform.txt'))).toString('utf8').includes('\nversion=3.3.12\n')) { fail('Core 安装记录无效。'); }
    const result: ArduinoSimulationDependency[] = [{ provider: 'core', name: 'esp32:esp32', version: project.coreVersion, path: core, kind: 'tree',
        license: 'NOASSERTION; see licenseFiles', url: platform.url, relationship: 'selected-platform-installed-content' },
    { provider: 'tool', name: 'arduino-cli', version: '1.5.1', path: await fs.realpath(cliPath), kind: 'file', license: 'NOASSERTION; installed CLI license review required', relationship: 'selected-build-executable; version must be verified by service' }];
    const internal = join(home, 'data', 'internal'), folders = await fs.readdir(internal);
    const selected = new Set([project.chip === 'esp32c3' ? 'esp-rv32' : 'esp-x32', `${project.chip}-libs`, 'esptool_py']);
    for (const dependency of platform.toolsDependencies as { packager: string; name: string; version: string }[]) {
        const tool = metadata.packages.find((p: { name?: string }) => p.name === dependency.packager)?.tools?.find((t: { name?: string; version?: string }) => t.name === dependency.name && t.version === dependency.version);
        if (!tool || !Array.isArray(tool.systems)) { fail(`缺少工具来源记录：${dependency.name}`); }
        const archives: { system: { host: string; checksum: string; url: string }; archive: string }[] = [];
        for (const system of tool.systems) {
            if (typeof system.archiveFileName !== 'string' || basename(system.archiveFileName) !== system.archiveFileName) { continue; }
            const archive = join(home, 'downloads', 'packages', system.archiveFileName);
            if ((await fs.stat(archive).catch(() => undefined))?.isFile()) { archives.push({ system, archive }); }
        }
        const rank = (host: string): number => {
            const arm = /^(?:arm64|aarch64)-/.test(host), x64 = /^x86_64-/.test(host);
            if (process.platform === 'darwin' && /-apple-darwin\d*$/.test(host)) { return process.arch === 'arm64' ? arm ? 0 : x64 ? 1 : 2 : x64 ? 0 : 2; }
            if (process.platform === 'linux' && host.includes('linux')) { return (process.arch === 'arm64' && arm) || (process.arch === 'x64' && x64) ? 0 : 100; }
            if (process.platform === 'win32' && host.includes('mingw32')) { return (process.arch === 'x64' && x64) ? 0 : 1; }
            return 100;
        };
        const best = [...new Map(archives.filter(a => rank(a.system.host) === Math.min(...archives.map(b => rank(b.system.host))))
            .map(a => [a.archive + ':' + a.system.checksum, a])).values()];
        if (best.length !== 1 || rank(best[0].system.host) >= 100) { fail(`工具归档来源缺失或不唯一：${dependency.name}`); }
        const { system, archive } = best[0];
        if (!/^SHA-256:[a-f0-9]{64}$/i.test(system.checksum)) { fail('工具归档摘要无效。'); }
        if (selected.has(dependency.name)) {
            const matches = folders.filter(p => p.startsWith(`${dependency.packager}_${dependency.name}_${dependency.version}_`));
            if (matches.length !== 1) { fail(`实际工具安装目录缺失或不唯一：${dependency.name}`); }
            result.push({ provider: 'tool', name: dependency.name, version: dependency.version, path: join(internal, matches[0]), kind: 'tree',
                license: 'NOASSERTION; see licenseFiles', url: system.url, relationship: 'selected-target-recipe-installed-content' });
        } else {
            result.push({ provider: 'tool', name: dependency.name, version: dependency.version, path: archive, kind: 'file',
                expectedSha256: system.checksum.slice(8).toLowerCase(), license: 'NOASSERTION; archive license review required', url: system.url,
                relationship: 'platform-declared-tool-dependency-archive; not claimed as used by this build' });
        }
    }
    for (const library of profile.libraries) {
        const matches: { path: string; url?: string }[] = [];
        for (const folder of folders.filter(p => !p.startsWith('esp32_') && !p.startsWith('arduino_'))) {
            const container = join(internal, folder), directories = [container, ...(await fs.readdir(container, { withFileTypes: true })).filter(e => e.isDirectory()).map(e => join(container, e.name))];
            for (const directory of directories) {
                const properties = await fs.readFile(join(directory, 'library.properties'), 'utf8').catch(() => '');
                const values = Object.fromEntries(properties.split(/\r?\n/).map(line => /^([^=#]+)=(.*)$/.exec(line)).filter(Boolean).map(m => [m![1].trim(), m![2].trim()]));
                if (values.name === library.name && values.version === library.version) { matches.push({ path: directory, url: values.url }); }
            }
        }
        if (matches.length !== 1) { fail(`实际项目库安装内容缺失或不唯一：${library.name}`); }
        result.push({ provider: 'library', name: library.name, version: library.version, path: matches[0].path, url: matches[0].url, kind: 'tree', license: 'NOASSERTION; see licenseFiles',
            relationship: library.direct ? 'profile-direct-library-installed-content' : 'profile-transitive-library-installed-content' });
    }
    for (const local of profile.local) {
        const root = await fs.realpath(resolve(project.path, local.dir)), properties = (await readFile(join(root, 'library.properties'), 256 * 1024)).toString('utf8');
        const name = /^name=(.+)$/m.exec(properties)?.[1].trim(), version = /^version=(.+)$/m.exec(properties)?.[1].trim();
        if (!name || !version) { fail('本地库缺少名称或版本。'); }
        result.push({ provider: 'local', name, version, path: root, kind: 'tree', license: 'NOASSERTION; see licenseFiles', relationship: 'profile-local-library-installed-content' });
    }
    return result;
}

function portable(path: string): void {
    if (path.length > 240 || !/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(path)
        || path.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
            || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(p))) {
        fail(`文件名无法用于可移交仿真包：${path}`);
    }
}
async function readFile(path: string, limit = MAX_FILE): Promise<Buffer> {
    const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.size > limit) { fail(`文件无效或过大：${basename(path)}`); }
        const bytes = await handle.readFile(), after = await handle.stat();
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== before.size) { fail('读取时文件已变化，请重新编译。'); }
        return bytes;
    } finally { await handle.close(); }
}
async function sourceFiles(root: string, signal?: AbortSignal): Promise<Map<string, Buffer>> {
    const files = new Map<string, Buffer>(), folded = new Set<string>(); let size = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 32) { fail('工程目录层级过深。'); }
        for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : 1)) {
            stop(signal); if (excluded.test(entry.name)) { continue; }
            const file = join(directory, entry.name);
            if (entry.isSymbolicLink()) { fail('源码不能包含符号链接。'); }
            if (entry.isDirectory()) { await walk(file, depth + 1); }
            else if (entry.isFile()) {
                const name = 'source/' + relative(root, file).split(sep).join('/'); portable(name);
                if (folded.has(name.toLowerCase())) { fail('源码存在大小写冲突。'); } folded.add(name.toLowerCase());
                const bytes = await readFile(file); size += bytes.length;
                if (files.size >= 116 || size > 48 * 1024 * 1024) { fail('源码快照超过仿真包容量限制。'); }
                files.set(name, bytes);
            } else { fail('源码包含非普通文件。'); }
        }
    };
    await walk(root, 0); if (!files.size) { fail('缺少源码快照。'); } return files;
}

/** Streaming content identity. Tool-package symlinks are recorded and must resolve within that package. */
async function dependencyIdentity(input: ArduinoSimulationDependency, signal?: AbortSignal): Promise<JsonRecord> {
    stop(signal);
    if (!['core', 'tool', 'library', 'local'].includes(input.provider) || !input.name || !input.version || !input.license
        || !input.relationship || !isAbsolute(input.path) || !['tree', 'file'].includes(input.kind)) { fail('依赖证据不完整。'); }
    const root = await fs.realpath(input.path), entries: [string, unknown][] = [], licenses: JsonRecord[] = [];
    let count = 0, total = 0;
    const hashFile = async (file: string): Promise<{ sha256: string; size: number }> => {
        stop(signal); const before = await fs.stat(file);
        if (!before.isFile() || before.size > 4 * 1024 ** 3 || ++count > 150_000 || (total += before.size) > 32 * 1024 ** 3) { fail('依赖超出内容校验范围。'); }
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file)) { stop(signal); hash.update(chunk); }
        const after = await fs.stat(file);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) { fail('校验时依赖已修改。'); }
        return { sha256: hash.digest('hex'), size: before.size };
    };
    const walk = async (directory: string, depth: number): Promise<void> => {
        if (depth > 40) { fail('依赖目录层级过深。'); }
        for (const name of (await fs.readdir(directory)).sort()) {
            const path = join(directory, name), stat = await fs.lstat(path), key = relative(root, path).split(sep).join('/');
            if (stat.isSymbolicLink()) {
                const target = await fs.realpath(path), local = relative(root, target);
                if (local === '..' || local.startsWith('..' + sep) || isAbsolute(local) || !(await fs.stat(target)).isFile()) { fail('依赖符号链接必须指向包内普通文件。'); }
                const identity = await hashFile(target);
                entries.push([key, { type: 'symlink', target: await fs.readlink(path), ...identity }]);
            } else if (stat.isDirectory()) { await walk(path, depth + 1); }
            else if (stat.isFile()) {
                const identity = await hashFile(path); entries.push([key, { type: 'file', ...identity }]);
                if (licenses.length < 32 && /^(?:LICENSE|LICENCE|COPYING|NOTICE)(?:[.-]|$)/i.test(name)) { licenses.push({ path: key, ...identity }); }
            } else { fail('依赖包含非普通文件。'); }
        }
    };
    let identity: string;
    if (input.kind === 'tree') { if (!(await fs.stat(root)).isDirectory()) { fail('依赖目录无效。'); } await walk(root, 0); identity = sha(JSON.stringify(ordered(entries))); }
    else { identity = (await hashFile(root)).sha256; }
    if (input.expectedSha256 && input.expectedSha256 !== identity) { fail(`依赖校验和不匹配：${input.name}`); }
    return { provider: input.provider, name: input.name, version: input.version, sha256: identity,
        hashScope: input.kind === 'tree' ? 'installed-tree-v1' : 'file-bytes', files: count, sizeBytes: total,
        license: input.license, licenseFiles: licenses, relationship: input.relationship, ...(input.url ? { url: input.url } : {}) };
}

/** Must be called BEFORE compile, once preparation has installed the exact selected dependencies. */
export async function captureArduinoSimulationInputs(input: ArduinoSimulationInputs): Promise<ArduinoSimulationSnapshot> {
    stop(input.signal);
    const request: ArduinoSimulationInputs = { ...input, dependencies: input.dependencies.map(p => ({ ...p })) };
    if (!request.producerVersion || request.cliVersion !== '1.5.1' || request.coreVersion !== '3.3.12' || request.idfVersion !== '5.5.5') { fail('当前仿真包仅支持固定 Arduino 工具版本。'); }
    const project = await readArduinoProject(request.projectPath), profile = await readArduinoLibraryProfile(project.path);
    if (!['esp32c3', 'esp32s3'].includes(project.chip) || project.coreVersion !== request.coreVersion) { fail('当前目标不在仿真包支持范围内。'); }
    const has = (provider: string, name: string, version: string): boolean => request.dependencies.some(d => d.provider === provider && d.name === name && d.version === version);
    if (!has('core', 'esp32:esp32', request.coreVersion) || !has('tool', 'arduino-cli', request.cliVersion)) { fail('缺少 Core 或 Arduino CLI 的真实依赖内容证据。'); }
    for (const lib of profile.libraries) { if (!has('library', lib.name, lib.version)) { fail(`缺少项目依赖证据：${lib.name}`); } }
    for (const local of profile.local) {
        const root = await fs.realpath(resolve(project.path, local.dir));
        if (!request.dependencies.some(d => d.provider === 'local' && resolve(d.path) === root && d.kind === 'tree')) { fail('缺少本地库内容锁定。'); }
    }
    const before = await arduinoInputDigest(project.path), sources = await sourceFiles(project.path, request.signal), locks: JsonRecord[] = [], seen = new Set<string>();
    if (request.dependencies.length > 256) { fail('依赖数量超过限制。'); }
    for (const dependency of request.dependencies) {
        const key = `${dependency.provider}:${dependency.name}@${dependency.version}`;
        if (seen.has(key)) { fail('依赖证据重复。'); } seen.add(key);
        locks.push(await dependencyIdentity(dependency, request.signal));
    }
    locks.sort((a, b) => String(a.provider + ':' + a.name).localeCompare(String(b.provider + ':' + b.name)));
    if (before !== await arduinoInputDigest(project.path)) { fail('准备导出快照期间源码已修改。'); }
    const snapshot = Object.freeze({ id: randomUUID(), inputDigest: before, dependencyDigest: sha(JSON.stringify(locks)) });
    snapshots.set(snapshot, { request, project, sources, sourceDigest: digestFiles(sources), locks }); return snapshot;
}

/** Exactly the service's artifact fingerprint, independently recomputed for this resolved directory. */
export async function arduinoSimulationArtifactDigest(root: string): Promise<string> {
    const hash = createHash('sha256');
    const names = (await fs.readdir(root)).filter(n => /\.(?:bin|elf)$/.test(n) || ['flash_args', 'build.options.json'].includes(n)).sort();
    if (!names.some(n => n.endsWith('.bin'))) { fail('缺少编译产物。'); }
    for (const name of names) { hash.update(name); hash.update(await readFile(join(root, name))); } return hash.digest('hex');
}

function target(fqbn: string, chip: string): JsonRecord {
    const parts = fqbn.split(':'), options: Record<string, string> = {};
    if (parts.length !== 4 || parts.slice(0, 3).join(':') !== `esp32:esp32:${chip}`) { fail('仿真包需要完整的开发板选项。'); }
    for (const pair of parts[3].split(',')) {
        const match = /^([A-Za-z0-9_]+)=([A-Za-z0-9_.-]+)$/.exec(pair);
        if (!match || Object.hasOwn(options, match[1])) { fail('开发板选项重复或无效。'); } options[match[1]] = match[2];
    }
    const required: Record<string, string> = { CPUFreq: chip === 'esp32c3' ? '160' : '240', FlashMode: 'qio', FlashSize: chip === 'esp32c3' ? '4M' : '8M',
        CDCOnBoot: 'default', PartitionScheme: chip === 'esp32c3' ? 'default' : 'default_8MB',
        ...(chip === 'esp32c3' ? { FlashFreq: '80' } : { PSRAM: 'disabled', LoopCore: '1', EventsCore: '1', USBMode: 'hwcdc', MSCOnBoot: 'default', DFUOnBoot: 'default', UploadMode: 'default' }) };
    for (const [key, value] of Object.entries(required)) { if (options[key] !== value) { fail(`仿真配置不支持 ${key}=${options[key] ?? '(缺失)'}。`); } }
    return { chip, fqbn, options, clockHz: Number(options.CPUFreq) * 1_000_000,
        flash: { sizeBytes: Number.parseInt(options.FlashSize) * 1024 * 1024, mode: 'dio', frequencyHz: 80_000_000 },
        psram: { mode: 'disabled' }, console: { kind: 'uart', port: 0, usbCdcOnBoot: false } };
}
function validateArtifactIdentity(elf: Buffer, application: Buffer, chip: string): void {
    if (elf.length < 52 || !elf.subarray(0, 7).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]))
        || elf.readUInt16LE(18) !== (chip === 'esp32c3' ? 243 : 94)) { fail('ELF 架构与芯片不一致。'); }
    if (application.length < 288 || application.readUInt32LE(32) !== 0xabcd5432
        || !application.subarray(176, 208).equals(Buffer.from(sha(elf), 'hex'))
        || application.subarray(144, 176).toString('utf8').split('\0')[0] !== 'v5.5.5') { fail('应用镜像与 ELF 或 IDF 版本不一致。'); }
}

/** Small deterministic ZIP implementation: UTF-8 portable names, regular files, no ZIP64/extraction. */
function zip(files: Map<string, Buffer>): Buffer {
    const local: Buffer[] = [], central: Buffer[] = []; let offset = 0, expanded = 0;
    if (files.size > 128) { fail('仿真包文件数超过限制。'); }
    const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) { c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return c >>> 0; });
    for (const [path, data] of [...files].sort(([a], [b]) => a < b ? -1 : 1)) {
        portable(path); expanded += data.length;
        if (data.length > MAX_FILE || expanded > 96 * 1024 * 1024) { fail('仿真包内容过大。'); }
        const name = Buffer.from(path), compressed = deflateRawSync(data, { level: 6 });
        let crc = 0xffffffff; for (const byte of data) { crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); } crc = (crc ^ 0xffffffff) >>> 0;
        const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8);
        header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
        const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x314, 4); header.copy(record, 6, 4, 30);
        record.writeUInt32LE((0o100644 << 16) >>> 0, 38); record.writeUInt32LE(offset, 42);
        local.push(header, name, compressed); central.push(record, name); offset += header.length + name.length + compressed.length;
    }
    const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    const bytes = Buffer.concat([...local, directory, end]); if (bytes.length > 64 * 1024 * 1024) { fail('仿真包压缩后过大。'); } return bytes;
}

export async function createArduinoSimulationPackage(request: ArduinoSimulationExport): Promise<ArduinoSimulationPackage> {
    stop(request.signal); const state = snapshots.get(request.snapshot); if (!state) { fail('缺少本次编译前的依赖快照，请重新编译。'); }
    const { project } = state, built = { ...request.build };
    if (!built.token || built.path !== project.path || built.digest !== request.snapshot.inputDigest || built.fqbn !== project.fqbn
        || !/^[a-f0-9]{64}$/.test(built.artifacts)) { fail('成功构建身份与源码快照不一致。'); }
    const guard = async (dependencies: boolean): Promise<void> => {
        stop(request.signal); await request.verifyCurrent();
        const current = await readArduinoProject(project.path);
        if (current.fqbn !== project.fqbn || current.chip !== project.chip || await arduinoInputDigest(project.path) !== built.digest
            || digestFiles(await sourceFiles(project.path, request.signal)) !== state.sourceDigest) { fail('源码已修改，请重新编译后导出。'); }
        if (await arduinoSimulationArtifactDigest(built.directory) !== built.artifacts) { fail('编译产物已修改，请重新编译。'); }
        if (dependencies) {
            const actual: JsonRecord[] = [];
            for (const dependency of state.request.dependencies) { actual.push(await dependencyIdentity(dependency, request.signal)); }
            actual.sort((a, b) => String(a.provider + ':' + a.name).localeCompare(String(b.provider + ':' + b.name)));
            if (sha(JSON.stringify(actual)) !== request.snapshot.dependencyDigest) { fail('依赖内容已修改，请重新编译。'); }
        }
        stop(request.signal);
    };
    await guard(true);
    const buildPath = await fs.realpath(built.directory), name = basename(project.path), files = new Map<string, Buffer>(), entries: JsonRecord[] = [];
    const add = (path: string, role: string, bytes: Buffer): void => { portable(path); if (files.has(path)) { fail('仿真包文件重复。'); } files.set(path, bytes); entries.push({ path, role, size: bytes.length, sha256: sha(bytes) }); };
    const plan = await readArduinoFlashPlan(buildPath, { ...project, chip: project.chip as 'esp32c3' | 'esp32s3' });
    const selectedTarget = target(project.fqbn, project.chip), size = project.chip === 'esp32c3' ? 4 * 1024 * 1024 : 8 * 1024 * 1024;
    if (plan.flashSize !== size || plan.flashOptions.join(' ') !== `--flash-mode dio --flash-freq 80m --flash-size ${size / 1024 / 1024}MB` || plan.segments.length !== 4) { fail('当前 Flash 布局不在仿真包支持范围内。'); }
    const names: Record<string, string> = { [`${name}.ino.elf`]: 'elf', [`${name}.ino.bin`]: 'application', [`${name}.ino.bootloader.bin`]: 'bootloader',
        [`${name}.ino.partitions.bin`]: 'partition-table', 'boot_app0.bin': 'ota-data', [`${name}.ino.merged.bin`]: 'merged', 'build.options.json': 'build-options', 'flash_args': 'flash-args' };
    for (const [file, role] of Object.entries(names)) { add('firmware/' + file, role, await readFile(join(buildPath, file))); }
    const elf = files.get(`firmware/${name}.ino.elf`)!, app = files.get(`firmware/${name}.ino.bin`)!, merged = files.get(`firmware/${name}.ino.merged.bin`)!;
    validateArtifactIdentity(elf, app, project.chip);
    const expected = Buffer.alloc(size, 0xff), segments: { offset: number; path: string }[] = [];
    for (const segment of plan.segments) {
        const file = basename(segment.path), path = 'firmware/' + file, bytes = files.get(path);
        if (!bytes || !['application', 'bootloader', 'partition-table', 'ota-data'].includes(names[file]) || segment.address % 4096) { fail('Flash 分段缺失或不受支持。'); }
        bytes.copy(expected, segment.address); segments.push({ offset: segment.address, path });
    }
    if (merged.length !== size || !merged.equals(expected)) { fail('完整 Flash 与构建分段不一致。'); }
    if (!request.buildLog.length || request.buildLog.length > MAX_FILE) { fail('缺少真实编译日志。'); }
    add('metadata/build.log', 'build-log', Buffer.from(request.buildLog));
    const lock = json({ schemaVersion: 1, packages: state.locks, coverage: 'Declared project libraries and supplied resolved tool/core content; usage is not inferred from installation.',
        digestAlgorithm: 'installed-tree-v1: SHA256 of sorted path => {type,sha256,size[,target]} JSON, UTF-8; archive/file bytes otherwise' });
    if (lock.length > 1024 * 1024) { fail('依赖锁定文件过大。'); } add('metadata/dependencies.json', 'dependency-lock', lock);
    for (const [path, bytes] of state.sources) { add(path, 'source', bytes); }
    const manifest: JsonRecord = { schemaVersion: 1, producer: { name: 'Nodu', version: state.request.producerVersion }, buildId: built.token,
        target: selectedTarget, files: entries, flashSegments: segments, mergedBaseOffset: 0,
        dependencies: { framework: 'Arduino-ESP32', coreVersion: state.request.coreVersion, idfVersion: state.request.idfVersion, arduinoCliVersion: state.request.cliVersion, lockPath: 'metadata/dependencies.json' },
        provenance: { buildStatus: 'succeeded', sourceFiles: [...state.sources.keys()], sourceDigest: state.sourceDigest, noduInputDigest: built.digest,
            noduArtifactDigest: built.artifacts, dependencyDigest: request.snapshot.dependencyDigest, inputSnapshotId: request.snapshot.id,
            scope: 'Actual Nodu successful-build handoff; binary consistency is independently checked by the receiving Studio. No simulation success claim.' } };
    const manifestBytes = json(manifest); if (manifestBytes.length > 1024 * 1024) { fail('清单过大。'); } files.set('simulation-manifest.json', manifestBytes);
    const contentDigest = digestFiles(files), bytes = zip(files);
    // No externally visible file exists until all final identity/cancellation checks complete.
    await guard(true);
    const result = { bytes, manifest, contentDigest, packageSha256: sha(bytes), elfSha256: sha(elf), fullflashSha256: sha(merged) };
    publicationGuards.set(result, () => guard(true)); return result;
}

/** Publish a NEW immutable export only. Caller owns current-build state and must check its token. */
export async function publishArduinoSimulationPackage(result: ArduinoSimulationPackage, destination: string,
    verifyCurrent: () => Promise<void>, signal?: AbortSignal): Promise<void> {
    stop(signal); const guard = publicationGuards.get(result);
    if (!guard || !isAbsolute(destination) || !destination.endsWith('.esp-sim.zip') || sha(result.bytes) !== result.packageSha256) { fail('导出目标或包内容无效。'); }
    const directory = await fs.realpath(dirname(destination)), final = join(directory, basename(destination)), temporary = join(directory, `.esp-sim-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, result.bytes, { flag: 'wx', mode: 0o600 });
        stop(signal); await guard(); await verifyCurrent(); stop(signal);
        // link is atomic and fails if a destination exists; failed exports cannot replace current/history.
        await fs.link(temporary, final);
    } finally { await fs.rm(temporary, { force: true }); }
}
