// SPDX-License-Identifier: MIT
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { parseDocument } from 'yaml';
import { Diagnostic } from '../common/nodu-embedded-protocol';
import { ESP32_ARDUINO_INDEX_URL } from '../common/nodu-project-catalog';

/** Read the standard Arduino profile. Never infer a board from the chip name. */
export async function readArduinoProject(path: string): Promise<{ path: string; profile: string; fqbn: string; chip: string; coreVersion: string }> {
    if (typeof path !== 'string' || !isAbsolute(path) || path.includes('\0')) { throw new Error('请选择有效的 Arduino 工程。'); }
    const root = await fs.realpath(path);
    const read = async (name: string): Promise<string> => {
        const file = join(root, name), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.size > 256 * 1024) { throw new Error(`无效的 ${name}。`); }
        return fs.readFile(file, 'utf8');
    };
    const metadata = JSON.parse(await read('nodu.json')) as { kind?: string; target?: { mcu?: string } };
    if (metadata.kind !== 'esp32-arduino') { throw new Error('当前工程不是 ESP32 Arduino 工程。'); }
    const doc = parseDocument(await read('sketch.yaml'), { uniqueKeys: true });
    if (doc.errors.length) { throw new Error('sketch.yaml 格式错误。'); }
    const data = doc.toJS({ maxAliasCount: 20 }) as { default_profile?: string; profiles?: Record<string, { fqbn?: string; platforms?: { platform?: string; platform_index_url?: string }[] }> };
    const profile = data?.default_profile;
    const selected = typeof profile === 'string' ? data?.profiles?.[profile] : undefined;
    if (!profile || !/^[\w-]{1,64}$/.test(profile) || !selected || typeof selected.fqbn !== 'string'
        || !/^esp32:esp32:[a-z0-9_]+(?::[A-Za-z0-9_=,.-]+)?$/.test(selected.fqbn)
        || !Array.isArray(selected.platforms) || selected.platforms.length !== 1
        || !/^esp32:esp32 \(\d+\.\d+\.\d+\)$/.test(selected.platforms[0]?.platform ?? '')
        || selected.platforms[0]?.platform_index_url !== ESP32_ARDUINO_INDEX_URL) {
        throw new Error('sketch.yaml 需要有效的默认配置、ESP32 开发板和固定 Core 版本。');
    }
    if (!(await fs.lstat(join(root, `${basename(root)}.ino`))).isFile()) { throw new Error('工程缺少同名 .ino 文件。'); }
    const chip = metadata.target?.mcu;
    if (!chip || !/^esp32(?:s2|s3|c2|c3|c6|h2|p4)?$/.test(chip)) { throw new Error('工程芯片配置无效。'); }
    return { path: root, profile, fqbn: selected.fqbn, chip, coreVersion: /\(([^)]+)\)/.exec(selected.platforms[0].platform!)![1] };
}

/** Detect source/profile changes during a build. Output and IDE state are not inputs. */
export async function arduinoInputDigest(root: string): Promise<string> {
    const hash = createHash('sha256'); let total = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > 32) { throw new Error('工程目录层级过深。'); }
        for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
            if (/^(?:\.git|\.nodu|\.theia|\.vscode|build|node_modules)$/.test(entry.name)) { continue; }
            const path = join(dir, entry.name);
            if (entry.isSymbolicLink()) { throw new Error('Arduino 编译输入不能包含符号链接。'); }
            if (entry.isDirectory()) { await walk(path, depth + 1); }
            else if (entry.isFile()) {
                if (++total > 10_000 || (await fs.stat(path)).size > 32 * 1024 * 1024) { throw new Error('工程文件超过编译检查范围。'); }
                hash.update(path.slice(root.length)); hash.update('\0'); hash.update(await fs.readFile(path)); hash.update('\0');
            }
        }
    };
    await walk(root, 0); return hash.digest('hex');
}

/** Pinned CLI 1.5.1 Sketch.Hash(): uppercase MD5 of its canonical absolute path.
 * Use its default sketch directory: passing --build-path disables the shared core cache.
 * This MD5 is only a cache directory key, never an artifact integrity check.
 */
export function arduinoBuildPath(home: string, project: string): string {
    return join(home, 'cache', 'sketches', createHash('md5').update(project).digest('hex').toUpperCase());
}

/** GCC emits original .ino positions after Arduino preprocessing. */
export function arduinoDiagnostics(output: string, root: string): Diagnostic[] {
    const diagnostics: Diagnostic[] = [], seen = new Set<string>();
    for (const line of output.split(/\r?\n/)) {
        const match = /^(.*?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning):\s*(.+)$/.exec(line.replace(/\u001b\[[0-9;]*m/g, ''));
        if (!match) { continue; }
        const [, file, row, col, severity, message] = match;
        const absolute = isAbsolute(file) ? file : join(root, file);
        const key = `${absolute}:${row}:${col}:${severity}:${message}`;
        if (seen.has(key)) { continue; } seen.add(key);
        diagnostics.push({ source: 'compiler', severity: severity === 'warning' ? 'warning' : 'error', file, absolute, line: Number(row), column: Number(col || 1), message });
    }
    return diagnostics;
}
