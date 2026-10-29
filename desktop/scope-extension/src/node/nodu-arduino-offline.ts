// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { arduinoResources } from './nodu-arduino-paths';

export interface ArduinoOfflineFile {
    path: string; target?: string; kind: 'index' | 'package' | 'cli' | 'profile' | 'native' | 'source' | 'license';
    sha256: string; size: number; mode?: number;
}
export interface ArduinoOfflineManifest {
    schemaVersion: 1; id: string; host: string; cliVersion: string; coreVersion: string; files: ArduinoOfflineFile[];
}
interface Receipt { sha256: string; size: number; mtimeMs: number; ctimeMs: number; ino: number }
const pending = new Map<string, Promise<ArduinoOfflineManifest | undefined>>();
const repair = (detail: string): Error => new Error(`Arduino 内置环境不完整，请修复 Nodu 安装（${detail}）。`);
const relative = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length < 2048
    && !/[\\\0\r\n:]/.test(value) && value.split('/').every(part => part && part !== '.' && part !== '..');

/** Publishing validates licenses/source too. Runtime only reads the explicitly allowed application payload. */
export function validateArduinoOfflineManifest(value: unknown, host: string): ArduinoOfflineManifest {
    const manifest = value as ArduinoOfflineManifest;
    if (!/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(host) || !manifest || manifest.schemaVersion !== 1 || manifest.host !== host || manifest.cliVersion !== '1.5.1'
        || manifest.coreVersion !== '3.3.12' || typeof manifest.id !== 'string' || !/^[\w.-]{1,160}$/.test(manifest.id)
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 50_000) { throw repair('资源清单'); }
    const paths = new Set<string>(), targets = new Set<string>();
    for (const file of manifest.files) {
        if (!file || !relative(file.path) || paths.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
            || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 16 * 1024 ** 3
            || (file.mode !== undefined && ![0o644, 0o755].includes(file.mode))) { throw repair('资源条目'); }
        paths.add(file.path);
        if (file.kind === 'source' || file.kind === 'license') {
            if (file.target !== undefined) { throw repair('源码与许可位置'); }
            continue;
        }
        if (!relative(file.target) || targets.has(file.target)) { throw repair('资源目标'); }
        targets.add(file.target);
        const valid = file.kind === 'index' ? /^data\/(?:package_index\.json(?:\.sig)?|package_esp32_index\.json|library_index\.json(?:\.sig)?)$/.test(file.target)
            : file.kind === 'package' ? /^downloads\/packages\/[^/]+$/.test(file.target)
            : file.kind === 'cli' ? /^downloads\/arduino-cli_1\.5\.1_[^/]+\.(?:tar\.gz|zip)$/.test(file.target)
            : file.kind === 'native' ? file.target === `tools/ctags/${host}/ctags` && file.mode === 0o755
            : file.kind === 'profile' && /^data\/internal\/esp32_esp32_3\.3\.12_feadd113249efafd\/.+/.test(file.target);
        if (!valid) { throw repair('资源目标范围'); }
    }
    if (!manifest.files.some(file => file.kind === 'cli') || !manifest.files.some(file => file.kind === 'profile' && file.target?.endsWith('/boards.txt'))
        || !manifest.files.some(file => file.target === 'data/package_index.json')) { throw repair('基础资源'); }
    return manifest;
}

/** CLI can return zero for --only-compilation-database even when a profile dependency failed. */
export function arduinoInitializationErrors(output: string): string[] {
    return output.split(/\r?\n/).filter(line => /^(?:Error (?:initializing|downloading|installing)|Library .+ not found)|Download failed:/.test(line));
}

export function arduinoOfflineRoot(): string { return process.env.NODU_ARDUINO_OFFLINE_BUNDLES || join(arduinoResources(), 'offline'); }

async function digest(file: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file, { signal })) { hash.update(chunk); }
    return hash.digest('hex');
}

/** The chosen root may be canonicalized; no child directory/file may redirect a bundled write. */
async function checkedPath(root: string, name: string, create: boolean, directories = new Map<string, Promise<void>>()): Promise<string> {
    const parts = name.split('/'); let directory = root;
    for (const part of parts.slice(0, -1)) {
        directory = join(directory, part);
        let checked = directories.get(directory);
        if (!checked) {
            const current = directory;
            checked = (async () => {
                let stat = await fs.lstat(current).catch(error => { if (error.code === 'ENOENT' && create) { return undefined; } throw error; });
                if (!stat) {
                    await fs.mkdir(current).catch(error => { if (error.code !== 'EEXIST') { throw error; } });
                    stat = await fs.lstat(current);
                }
                if (!stat.isDirectory() || stat.isSymbolicLink()) { throw repair('资源目录'); }
            })();
            directories.set(current, checked);
        }
        await checked;
    }
    const file = join(directory, parts.at(-1)!);
    const stat = await fs.lstat(file).catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) { throw repair('资源文件'); }
    return file;
}

/** Copies only verified, relocatable distribution inputs; never borrows Arduino IDE/Homebrew state. */
export async function seedArduinoOfflineBundle(home: string, signal: AbortSignal, progress: (text: string) => void,
    root = arduinoOfflineRoot(), host = `${process.platform}-${process.arch}`): Promise<ArduinoOfflineManifest | undefined> {
    const key = `${resolve(home)}\0${resolve(root)}\0${host}`;
    const existing = pending.get(key);
    if (existing) { const result = await existing; signal.throwIfAborted(); return result; }
    const operation = seed(home, signal, progress, root, host); pending.set(key, operation);
    try { return await operation; } finally { if (pending.get(key) === operation) { pending.delete(key); } }
}

async function seed(home: string, signal: AbortSignal, progress: (text: string) => void, root: string, host: string): Promise<ArduinoOfflineManifest | undefined> {
    signal.throwIfAborted();
    if (!/^(?:darwin|linux|win32)-(?:arm64|x64)$/.test(host)) { throw repair('系统类型'); }
    const directory = join(root, host), manifestFile = join(directory, 'manifest.json');
    const stat = await fs.lstat(manifestFile).catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
    if (!stat) {
        if (process.env.NODU_ARDUINO_OFFLINE_BUNDLES || await fs.access(join(root, 'required.json')).then(() => true, () => false)) { throw repair('缺少当前系统工具包'); }
        return undefined; // Source checkouts may intentionally use the existing development/download flow.
    }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) { throw repair('资源清单'); }
    const contents = await fs.readFile(manifestFile, 'utf8');
    const manifest = validateArduinoOfflineManifest(JSON.parse(contents), host);
    await fs.mkdir(home, { recursive: true }); home = await fs.realpath(home);
    const source = await fs.realpath(directory), manifestHash = createHash('sha256').update(contents).digest('hex');
    // Cache directory checks only for this scan: later calls still detect a replaced symlink.
    const directories = new Map<string, Promise<void>>();
    const receiptFile = await checkedPath(home, `.offline-receipts/${manifestHash}.json`, true, directories);
    let receipts: Record<string, Receipt> = Object.create(null);
    try { const value = JSON.parse(await fs.readFile(receiptFile, 'utf8')); if (value && typeof value === 'object' && !Array.isArray(value)) { receipts = value; } } catch { /* A receipt is only an optimization. */ }
    const next: Record<string, Receipt> = Object.create(null);
    const files = manifest.files.filter(file => file.target); let completed = 0, repaired = 0;
    // Bound IO concurrency for thousands of small Core source files and large compiler archives.
    let cursor = 0;
    const workers = await Promise.allSettled(Array.from({ length: Math.min(4, files.length) }, async () => {
        for (;;) {
            const file = files[cursor++]; if (!file) { return; } signal.throwIfAborted();
            const target = await checkedPath(home, file.target!, true, directories);
            if (file.target === 'data/library_index.json.sig') {
                const paired = files.find(item => item.target === file.target!.slice(0, -4));
                const indexFile = target.slice(0, -4), indexStat = await fs.lstat(indexFile).catch(() => undefined);
                if (indexStat) {
                    if (!indexStat.isFile() || indexStat.isSymbolicLink()) { throw repair('索引文件'); }
                    // Never attach an old signature to an index merged with bundled or user-requested library records.
                    if (!paired || await digest(indexFile, signal) !== paired.sha256) { ++completed; continue; }
                }
            }
            let actual = await fs.lstat(target).catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
            if (process.platform !== 'win32' && actual && file.mode !== undefined && (actual.mode & 0o777) !== file.mode) {
                await fs.chmod(target, file.mode); actual = await fs.lstat(target);
            }
            const saved = receipts[file.target!];
            // Libraries may grow through explicit user actions. Board/builtin indexes stay at the release snapshot:
            // CLI chooses its builtin tool versions from package_index, so preserving a newer copy would download.
            const preserveIndex = file.target!.startsWith('data/library_index.json') && actual && (file.target!.endsWith('.sig')
                || await fs.readFile(target, 'utf8').then(text => { try { return !!JSON.parse(text); } catch { return false; } }));
            const known = actual && actual.size === file.size && saved?.sha256 === file.sha256 && saved.size === actual.size
                && saved.mtimeMs === actual.mtimeMs && saved.ctimeMs === actual.ctimeMs && saved.ino === actual.ino;
            if (!preserveIndex && !known && !(actual?.size === file.size && await digest(target, signal) === file.sha256)) {
                if (repaired++ === 0) { progress('正在初始化 Arduino 环境'); }
                const input = await checkedPath(source, file.path, false, directories), inputStat = await fs.lstat(input);
                if (inputStat.size !== file.size) { throw repair(file.path); }
                const temporary = join(dirname(target), `.nodu-${randomUUID()}.tmp`);
                try {
                    await fs.copyFile(input, temporary, 1);
                    if (await digest(temporary, signal) !== file.sha256) { throw repair(file.path); }
                    if (process.platform !== 'win32') { await fs.chmod(temporary, file.mode ?? 0o644); }
                    signal.throwIfAborted(); await fs.rename(temporary, target);
                } finally { await fs.rm(temporary, { force: true }); }
                actual = await fs.lstat(target);
            }
            if (!preserveIndex && actual) { next[file.target!] = { sha256: file.sha256, size: actual.size, mtimeMs: actual.mtimeMs, ctimeMs: actual.ctimeMs, ino: actual.ino }; }
            if (++completed % 400 === 0 && repaired) { progress(`初始化 Arduino 环境 ${completed} / ${files.length}`); }
        }
    }));
    const failure = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected');
    if (failure) { throw failure.reason; }
    signal.throwIfAborted();
    const temporary = `${receiptFile}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(next) + '\n', { flag: 'wx' }); signal.throwIfAborted(); await fs.rename(temporary, receiptFile); }
    finally { await fs.rm(temporary, { force: true }); }
    return manifest;
}
