// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
export const TUTOR_TOOLKIT_VERSION = 'wasi34-wasmtime50';
export const TUTOR_TOOLKIT_REQUIRED = ['sdk/bin/clang','sdk/bin/wasm-ld','runtime/wasmtime','licenses/WASI-SDK-LICENSE','licenses/LLVM-LICENSE','licenses/Libedit-COPYING','licenses/Wasmtime-LICENSE','licenses/SOURCES.json'];
interface Record { path: string; size: number; sha256: string; }
/** Integrity, not a cryptographic publisher signature. The containing app supplies trust. */
export async function verifyTutorToolkit(root: string, signal?: AbortSignal): Promise<void> {
    const fail = (): never => { throw new Error('纯函数工具包缺失或校验失败'); };
    const check = (): void => { if (signal?.aborted) { throw new Error('测试已取消'); } };
    check();
    if (!(await fs.lstat(root)).isDirectory() || (await fs.lstat(root)).isSymbolicLink()) { fail(); }
    const manifestPath = join(root, 'toolkit.json'), stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128000) { fail(); }
    const manifest = JSON.parse(await fs.readFile(manifestPath,'utf8'));
    if (manifest.schema !== 1 || manifest.version !== TUTOR_TOOLKIT_VERSION || manifest.platform !== `${process.platform}-${process.arch}`
        || !Array.isArray(manifest.files) || !manifest.files.length || manifest.files.length > 200) { fail(); }
    const files: Record[] = manifest.files, paths = new Set<string>(); let total = 0;
    for (const record of files) {
        if (!record || typeof record.path !== 'string' || !/^(sdk|runtime|licenses)\/[a-zA-Z0-9_./-]+$/.test(record.path)
            || record.path.split('/').some(p => !p || p === '.' || p === '..') || paths.has(record.path)
            || !Number.isSafeInteger(record.size) || record.size < 0 || record.size > 256 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(record.sha256)) { fail(); }
        paths.add(record.path); total += record.size;
    }
    if (total > 1024 * 1024 * 1024 || total !== manifest.totalBytes || TUTOR_TOOLKIT_REQUIRED.some(p => !paths.has(p))) { fail(); }
    let entries = 0;
    const walk = async (relative: string): Promise<void> => {
        check();
        for (const e of await fs.readdir(join(root,relative),{withFileTypes:true})) {
            if (++entries > 250 || e.isSymbolicLink()) { fail(); }
            const name = relative ? `${relative}/${e.name}` : e.name;
            if (e.isDirectory()) { await walk(name); }
            else if (!e.isFile() || name !== 'toolkit.json' && !paths.has(name)) { fail(); }
        }
    };
    await walk('');
    for (const record of files) {
        check(); const file = join(root,record.path), before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.size !== record.size) { fail(); }
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(file,{highWaterMark:65536})) { check(); hash.update(chunk); }
        const after = await fs.lstat(file);
        if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || hash.digest('hex') !== record.sha256) { fail(); }
    }
}
