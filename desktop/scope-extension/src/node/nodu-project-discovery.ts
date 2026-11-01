// SPDX-License-Identifier: MIT
import { promises as fs } from 'fs';
import { basename, dirname, extname, join, resolve } from 'path';
import { randomUUID } from 'crypto';
import { projectTag } from '../common/nodu-launcher-util';
import { ProjectCandidate, ProjectInspection } from '../common/nodu-launcher-protocol';
import { PROJECT_CHIPS } from '../common/nodu-project-catalog';

const excluded = new Set(['.git', '.nodu', '.cache', '.theia', '.vscode', 'node_modules', 'build', 'dist', 'target', 'Drivers', 'ThirdParty', 'Objects', 'Listings']);
async function json(file: string): Promise<unknown> {
    const stat = await fs.lstat(file).catch(() => undefined);
    if (!stat?.isFile() || stat.size > 1024 * 1024) return undefined;
    try { return JSON.parse(await fs.readFile(file, 'utf8')); } catch { return undefined; }
}
/** Read-only root resolution. Multiple projects remain choices, never a guessed target. */
export async function inspectProject(selected: string): Promise<ProjectInspection> {
    const input = await fs.realpath(selected);
    const stat = await fs.stat(input);
    let folder = stat.isDirectory() ? input : dirname(input);
    if (!stat.isDirectory() && extname(input).toLowerCase() === '.uvprojx' && basename(folder).toUpperCase() === 'MDK-ARM') folder = dirname(folder);
    const candidates: ProjectCandidate[] = [];
    let visited = 0;
    async function scan(dir: string, depth: number): Promise<void> {
        if (++visited > 200) return;
        const [nodu, board] = await Promise.all([json(join(dir, 'nodu.json')), json(join(dir, 'board.json'))]);
        if (nodu || board) { candidates.push({ path: dir, name: basename(dir), tag: projectTag({ nodu, board }) }); return; }
        if (!depth) return;
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
            if (entry.isDirectory() && !entry.isSymbolicLink() && !excluded.has(entry.name) && !entry.name.startsWith('.')) await scan(join(dir, entry.name), depth - 1);
        }
    }
    await scan(folder, 2);
    return { folder, candidates };
}

/** Explicit user selection records silicon only; it never invents wiring or executes CMake. */
export async function selectProjectChip(folder: string, chipId: string, validBoards: { reference: string; mcu: string }[] = []): Promise<void> {
    const chip = PROJECT_CHIPS.find(c => c.id === chipId && !!c.pack);
    if (!chip) throw Object.assign(new Error('请选择当前支持的 STM32 芯片型号。'), { code: 'badRequest' });
    const root = await fs.realpath(folder), file = join(root, 'nodu.json');
    const stat = await fs.lstat(file).catch(() => undefined);
    if (stat && (!stat.isFile() || stat.size > 1024 * 1024)) throw new Error('nodu.json 不是有效的项目配置文件，未修改。');
    const original = stat ? await fs.readFile(file, 'utf8') : undefined;
    const manifest = original ? JSON.parse(original) : { schema: 1, name: basename(root) };
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('nodu.json 格式无效，未修改。');
    const previousChip = PROJECT_CHIPS.find(c => c.id === manifest.target?.mcu);
    if (manifest.kind === 'stm32-hal' && manifest.build?.sourceOnly !== true && previousChip && previousChip.id !== chip.id) throw new Error('已有工程的启动、链接和引脚配置对应其他芯片。请新建匹配芯片的工程后移植源码。');
    const cmake = (await fs.lstat(join(root, 'CMakeLists.txt')).catch(() => undefined))?.isFile() === true;
    if (original) {
        const state = join(root, '.nodu');
        const existingState = await fs.realpath(state).catch(() => undefined);
        if (existingState && existingState !== state) throw new Error('工程状态目录不能通过链接指向其他目录。');
        const backups = join(state, 'project-selection');
        await fs.mkdir(backups, { recursive: true });
        if (!(await fs.realpath(backups)).startsWith(resolve(root) + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('配置备份目录不能指向工程外。');
        await fs.writeFile(join(backups, `nodu-${Date.now()}-${randomUUID()}.json.bak`), original, { flag: 'wx' });
    }
    const native = manifest.kind === 'stm32-hal' && manifest.build?.external !== true && !!original && manifest.build?.sourceOnly !== true;
    manifest.kind = 'stm32-hal';
    const keepBoard = validBoards.some(b => b.reference === manifest.target?.board && b.mcu === chip.id);
    manifest.target = { ...manifest.target, mcu: chip.id, board: keepBoard ? manifest.target.board : chip.pack };
    manifest.build = { ...manifest.build, preset: manifest.build?.preset ?? 'debug', sourceOnly: !cmake };
    if (!native) manifest.build.external = cmake;
    const temp = join(root, `.nodu-target-${randomUUID()}.tmp`);
    try { await fs.writeFile(temp, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }); await fs.rename(temp, file); }
    finally { await fs.rm(temp, { force: true }); }
}
