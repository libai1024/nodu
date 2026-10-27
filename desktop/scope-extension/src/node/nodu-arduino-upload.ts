// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join, relative } from 'node:path';

export type ArduinoUploadChip = 'esp32c3' | 'esp32s3';
export type ArduinoUploadStage = 'validate' | 'upload' | 'verify' | 'complete';
export interface ArduinoUploadProject { path: string; profile: string; fqbn: string; chip: ArduinoUploadChip }
export type ArduinoUploadTarget =
    | { kind: 'serial'; port: string; transport: 'uart' | 'hardware-cdc' | 'tinyusb' }
    | { kind: 'emulator'; port: string; esptoolPath: string };
export interface ArduinoUploadOptions {
    /** The caller owns successful-build fingerprint validation and the serial lease. */
    project: ArduinoUploadProject; buildPath: string; cliPath: string; configPath: string; target: ArduinoUploadTarget;
    run(executable: string, args: string[], cwd: string): Promise<{ code: number; output: string }>;
    isCancelled?(): boolean;
    onStage?(stage: ArduinoUploadStage): void;
}
export interface ArduinoUploadResult { ok: boolean; stage: ArduinoUploadStage; cancelled?: boolean; error?: string }
export interface ArduinoFlashSegment { address: number; path: string; size: number }
export interface ArduinoFlashPlan { buildPath: string; flashOptions: string[]; segments: ArduinoFlashSegment[]; flashSize: number }

/** Tokenization only: never executes shell expansion, substitutions or @response files. */
function words(text: string): string[] {
    const result: string[] = []; let value = '', quote = '', started = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '\0') { throw new Error('无效的 Flash 参数。'); }
        if (c === '\\' && quote !== "'") {
            if (++i === text.length) { throw new Error('Flash 参数转义不完整。'); }
            value += text[i]; started = true;
        } else if (quote) { if (c === quote) { quote = ''; } else { value += c; } }
        else if (c === '"' || c === "'") { quote = c; started = true; }
        else if (/\s/.test(c)) { if (started) { result.push(value); value = ''; started = false; } }
        else { value += c; started = true; }
    }
    if (quote) { throw new Error('Flash 参数引号不完整。'); }
    if (started) { result.push(value); }
    return result;
}

async function boundedFile(path: string, maximum: number): Promise<Buffer> {
    const stat = await fs.lstat(path);
    if (!stat.isFile() || stat.size < 1 || stat.size > maximum) { throw new Error(`无效的构建文件：${basename(path)}`); }
    return fs.readFile(path);
}

/** ESP image header, XOR checksum and optional appended SHA256; no guessed Flash offsets. */
function validateImage(data: Buffer, chip: ArduinoUploadChip): void {
    const chipId = chip === 'esp32c3' ? 5 : 9;
    if (data.length < 24 || data[0] !== 0xe9 || data[1] < 1 || data[1] > 16 || data.readUInt16LE(12) !== chipId) {
        throw new Error('固件与目标芯片不匹配，或镜像头已损坏。');
    }
    let offset = 24, checksum = 0xef;
    for (let segment = 0; segment < data[1]; segment++) {
        if (offset + 8 > data.length) { throw new Error('固件镜像不完整。'); }
        const size = data.readUInt32LE(offset + 4); offset += 8;
        if (size > data.length - offset) { throw new Error('固件镜像不完整。'); }
        for (let i = offset; i < offset + size; i++) { checksum ^= data[i]; }
        offset += size;
    }
    const checksumOffset = Math.ceil((offset + 1) / 16) * 16 - 1;
    if (checksumOffset >= data.length || data[checksumOffset] !== checksum) { throw new Error('固件校验失败，请重新编译。'); }
    if (data[23] > 1) { throw new Error('固件摘要标记无效。'); }
    if (data[23] === 1) {
        const hashOffset = checksumOffset + 1;
        if (hashOffset + 32 > data.length || !createHash('sha256').update(data.subarray(0, hashOffset)).digest().equals(data.subarray(hashOffset, hashOffset + 32))) {
            throw new Error('固件摘要校验失败，请重新编译。');
        }
    }
}

/** Uses the official Arduino recipe's generated flash_args and build.options.json. */
export async function readArduinoFlashPlan(buildPath: string, project: ArduinoUploadProject): Promise<ArduinoFlashPlan> {
    if (!isAbsolute(buildPath) || !isAbsolute(project.path) || !['esp32c3', 'esp32s3'].includes(project.chip)
        || !/^[\w-]{1,64}$/.test(project.profile) || !/^esp32:esp32:[a-z0-9_]+(?::[A-Za-z0-9_=,.-]+)?$/.test(project.fqbn)) {
        throw new Error('无效的 Arduino 上传工程。');
    }
    const root = await fs.realpath(buildPath), source = await fs.realpath(project.path);
    const options = JSON.parse((await boundedFile(join(root, 'build.options.json'), 256 * 1024)).toString('utf8')) as { fqbn?: string; sketchLocation?: string };
    if (options.fqbn !== project.fqbn || !options.sketchLocation || await fs.realpath(options.sketchLocation) !== source) {
        throw new Error('构建产物不属于当前工程或开发板，请重新编译。');
    }
    const tokens = words((await boundedFile(join(root, 'flash_args'), 64 * 1024)).toString('utf8'));
    const flashOptions: string[] = [], segments: ArduinoFlashSegment[] = [], seen = new Set<string>(); let flashSize = 0;
    for (let i = 0; i < tokens.length;) {
        const token = tokens[i++];
        if (token.startsWith('--')) {
            const name = token.replace(/_/g, '-'), value = tokens[i++];
            const valid = name === '--flash-mode' ? /^(qio|qout|dio|dout)$/.test(value ?? '')
                : name === '--flash-freq' ? /^(20|26|40|48|60|80|120)m$/.test(value ?? '')
                : name === '--flash-size' ? /^(1|2|4|8|16|32|64|128)MB$/.test(value ?? '') : false;
            if (!valid || seen.has(name)) { throw new Error('Flash 参数包含不支持或重复的选项。'); }
            seen.add(name); flashOptions.push(name, value);
            if (name === '--flash-size') { flashSize = parseInt(value, 10) * 1024 * 1024; }
            continue;
        }
        if (!/^0x[0-9a-f]+$/i.test(token) || !tokens[i]) { throw new Error('Flash 地址或文件无效。'); }
        const file = tokens[i++], address = parseInt(token, 16);
        const path = isAbsolute(file) ? file : join(root, file), local = relative(root, path);
        if (!local || local.startsWith('..') || isAbsolute(local) || await fs.realpath(path) !== path) { throw new Error('Flash 文件必须位于构建目录内。'); }
        const data = await boundedFile(path, 32 * 1024 * 1024);
        segments.push({ address, path, size: data.length });
    }
    if (!flashSize || segments.length < 2 || segments.length > 32) { throw new Error('Flash 布局不完整。'); }
    const sorted = [...segments].sort((a, b) => a.address - b.address);
    for (let i = 0; i < sorted.length; i++) {
        if (!Number.isSafeInteger(sorted[i].address) || sorted[i].address + sorted[i].size > flashSize
            || i > 0 && sorted[i - 1].address + sorted[i - 1].size > sorted[i].address) { throw new Error('Flash 布局越界或重叠。'); }
    }
    for (const name of [`${basename(source)}.ino.bin`, `${basename(source)}.ino.bootloader.bin`]) {
        const image = segments.find(segment => basename(segment.path) === name);
        if (!image) { throw new Error('构建缺少应用或引导镜像。'); }
        validateImage(await boundedFile(image.path, 32 * 1024 * 1024), project.chip);
    }
    return { buildPath: root, flashOptions, segments, flashSize };
}

/** The injected runner owns process lifetime, output delivery and cancellation. */
export async function executeArduinoUpload(options: ArduinoUploadOptions): Promise<ArduinoUploadResult> {
    let stage: ArduinoUploadStage = 'validate';
    const cancelled = (): void => { if (options.isCancelled?.()) { throw new Error('已取消上传。'); } };
    const next = (value: ArduinoUploadStage): void => { cancelled(); stage = value; options.onStage?.(value); };
    const run = async (exe: string, args: string[], cwd: string): Promise<void> => {
        cancelled(); const result = await options.run(exe, args, cwd); cancelled();
        if (result.code !== 0) { throw new Error(stage === 'verify' ? '固件读回校验失败，请查看上传输出。' : '上传失败，请查看上传输出。'); }
    };
    try {
        next('validate');
        const { project, target } = options;
        if (target.kind === 'serial') {
            if (!/^(?:COM[1-9]\d*|\/dev\/[A-Za-z0-9._/-]+)$/i.test(target.port) || target.port.includes('/../')) { throw new Error('请选择有效的串口。'); }
            if (!['uart', 'hardware-cdc', 'tinyusb'].includes(target.transport)) { throw new Error('不支持的上传连接。'); }
            if (target.transport === 'tinyusb' || /(?:[:,])UploadMode=cdc(?:,|$)/.test(project.fqbn)) {
                throw new Error('当前不自动切换 TinyUSB。请进入 ROM 下载模式并选择 UART0 / Hardware CDC 上传配置。');
            }
        } else if (target.kind !== 'emulator' || !/^socket:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(target.port)
            || Number(target.port.split(':').at(-1)) > 65535 || !isAbsolute(target.esptoolPath)) { throw new Error('模拟上传只支持本机回环串口。'); }
        const plan = await readArduinoFlashPlan(options.buildPath, project);
        next('upload');
        if (target.kind === 'serial') {
            await run(options.cliPath, ['--config-file', options.configPath, 'upload', '--profile', project.profile,
                '--input-dir', plan.buildPath, '--port', target.port, '--protocol', 'serial', '--verify', project.path], project.path);
        } else {
            const connection = ['--chip', project.chip, '--port', target.port, '--before', 'no-reset', '--after', 'no-reset', '--no-stub', '--connect-attempts', '2'];
            const files = plan.segments.flatMap(segment => [`0x${segment.address.toString(16)}`, segment.path]);
            await run(target.esptoolPath, [...connection, 'write-flash', ...plan.flashOptions, ...files], plan.buildPath);
            next('verify');
            await run(target.esptoolPath, [...connection, 'verify-flash', ...plan.flashOptions, ...files], plan.buildPath);
        }
        next('complete'); return { ok: true, stage };
    } catch (error) {
        return { ok: false, stage, ...(options.isCancelled?.() ? { cancelled: true } : {}), error: error instanceof Error ? error.message : String(error) };
    }
}
