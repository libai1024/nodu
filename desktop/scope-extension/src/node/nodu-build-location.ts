// SPDX-License-Identifier: MIT
import { readFile, realpath, stat } from 'fs/promises';
import { join } from 'path';
import { execFile } from 'child_process';

/** Locate existing outputs without building, opening a binary, or contacting hardware. */
export async function buildLocation(project: string): Promise<string> {
    const root = await realpath(project);
    const manifest = JSON.parse(await readFile(join(root, 'nodu.json'), 'utf8'));
    if (manifest.kind !== 'stm32-hal') { throw new Error('当前工程不是 STM32 工程。'); }
    const directory = join(root, 'build', manifest.build?.preset === 'release' ? 'release' : 'debug');
    for (const name of ['firmware.bin', 'firmware.hex']) {
        if (await stat(join(directory, name)).then(s => s.isFile(), () => false)) { return directory; }
    }
    throw new Error('尚无 BIN/HEX 产物，请先编译。');
}

export async function openBuildLocation(project: string): Promise<{ path: string }> {
    const path = await buildLocation(project);
    const executable = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open';
    await new Promise<void>((resolve, reject) => execFile(executable, [path], { timeout: 10_000 }, error => error ? reject(error) : resolve()));
    return { path };
}
