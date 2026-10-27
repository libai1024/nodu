// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { arduinoResources } from './nodu-arduino-paths';

interface Asset { file: string; url: string; sha256: string }
interface Manifest { version: string; assets: Record<string, Asset> }
const MAX = 128 * 1024 * 1024;

/** Extract just a named regular file. Archive paths never become output paths. */
export function arduinoArchiveFile(archive: Buffer, zip: boolean, filename: string): Buffer {
    if (zip) {
        let eocd = -1;
        for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65_557); i--) { if (archive.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
        if (eocd < 0) { throw new Error('工具压缩包目录无效。'); }
        let offset = archive.readUInt32LE(eocd + 16);
        const count = archive.readUInt16LE(eocd + 10);
        for (let i = 0; i < count; i++) {
            if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== 0x02014b50) { throw new Error('工具压缩包已损坏。'); }
            const nameLength = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32);
            const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
            if (name === filename) {
                const size = archive.readUInt32LE(offset + 24), packed = archive.readUInt32LE(offset + 20), local = archive.readUInt32LE(offset + 42), method = archive.readUInt16LE(offset + 10);
                if (!size || size > MAX || packed > MAX || local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50 || archive.readUInt16LE(offset + 8) & 1) { throw new Error('工具压缩包条目无效。'); }
                const start = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
                if (start + packed > archive.length) { throw new Error('工具压缩包不完整。'); }
                const input = archive.subarray(start, start + packed), output = method === 0 ? input : method === 8 ? inflateRawSync(input, { maxOutputLength: MAX }) : undefined;
                if (!output || output.length !== size) { throw new Error('工具解压失败。'); } return output;
            }
            offset += 46 + nameLength + extra + comment;
        }
    } else {
        const tar = gunzipSync(archive, { maxOutputLength: MAX });
        for (let offset = 0; offset + 512 <= tar.length;) {
            const name = tar.subarray(offset, offset + 100).toString('utf8').split('\0')[0].replace(/^\.\//, '');
            if (!name) { break; }
            const size = parseInt(tar.subarray(offset + 124, offset + 136).toString('ascii').replace(/\0/g, '').trim(), 8);
            if (!Number.isFinite(size) || size < 0 || size > MAX || offset + 512 + size > tar.length) { throw new Error('工具压缩包不完整。'); }
            if (name === filename && [0, 48].includes(tar[offset + 156])) { return tar.subarray(offset + 512, offset + 512 + size); }
            offset += 512 + Math.ceil(size / 512) * 512;
        }
    }
    throw new Error(`工具压缩包缺少 ${filename}。`);
}

export async function installArduinoCli(home: string, signal: AbortSignal, progress: (text: string) => void, allowDownload = true): Promise<string> {
    const manifest: Manifest = JSON.parse(await fs.readFile(join(arduinoResources(), 'cli-manifest.json'), 'utf8'));
    const asset = manifest.assets[`${process.platform}-${process.arch}`];
    if (!asset) { throw new Error('当前系统暂无 Arduino 工具包。'); }
    const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli', directory = join(home, 'bin', manifest.version, `${process.platform}-${process.arch}`), executable = join(directory, exe);
    const valid = async (): Promise<boolean> => {
        try { const receipt = JSON.parse(await fs.readFile(join(directory, 'receipt.json'), 'utf8')); return receipt.archive === asset.sha256 && receipt.binary === createHash('sha256').update(await fs.readFile(executable)).digest('hex'); } catch { return false; }
    };
    if (await valid()) { return executable; }
    const downloads = join(home, 'downloads'); await fs.mkdir(downloads, { recursive: true });
    const file = join(downloads, asset.file);
    let archive = await fs.readFile(file).catch(() => undefined);
    if (!archive || createHash('sha256').update(archive).digest('hex') !== asset.sha256) {
        if (!allowDownload) { throw new Error('Arduino 内置工具包缺失或损坏，请修复 Nodu 安装。'); }
        progress('下载 Arduino CLI');
        const response = await fetch(asset.url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) });
        if (!response.ok || !response.body) { throw new Error(`工具下载失败（${response.status}），请重试。`); }
        const total = Number(response.headers.get('content-length') || 0), chunks: Buffer[] = []; let size = 0, reported = 0;
        for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
            signal.throwIfAborted(); size += bytes.length;
            if (size > MAX) { throw new Error('工具下载超过允许大小。'); }
            chunks.push(Buffer.from(bytes));
            if (size - reported >= 1024 * 1024) { reported = size; progress(`下载 Arduino CLI ${Math.round(size / 1024 / 1024)}${total ? ` / ${Math.ceil(total / 1024 / 1024)}` : ''} MB`); }
        }
        archive = Buffer.concat(chunks);
        if (createHash('sha256').update(archive).digest('hex') !== asset.sha256) { throw new Error('Arduino CLI 下载校验失败，请重试。'); }
        const temporary = `${file}.${randomUUID()}.tmp`;
        try { await fs.writeFile(temporary, archive, { flag: 'wx' }); signal.throwIfAborted(); await fs.rename(temporary, file); }
        finally { await fs.rm(temporary, { force: true }); }
    }
    signal.throwIfAborted(); progress('安装 Arduino CLI');
    const binary = arduinoArchiveFile(archive, asset.file.endsWith('.zip'), exe);
    const staging = `${directory}.${randomUUID()}.tmp`;
    await fs.mkdir(staging, { recursive: true });
    try {
        await fs.writeFile(join(staging, exe), binary, { mode: 0o755 });
        const license = arduinoArchiveFile(archive, asset.file.endsWith('.zip'), 'LICENSE.txt'); await fs.writeFile(join(staging, 'LICENSE.txt'), license);
        await fs.writeFile(join(staging, 'receipt.json'), JSON.stringify({ archive: asset.sha256, binary: createHash('sha256').update(binary).digest('hex'), version: manifest.version }) + '\n');
        signal.throwIfAborted();
        if (await valid()) { return executable; }
        await fs.rm(directory, { recursive: true, force: true }); await fs.rename(staging, directory);
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
    return executable;
}
