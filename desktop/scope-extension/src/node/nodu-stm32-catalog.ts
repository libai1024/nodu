// SPDX-License-Identifier: MIT
// Selection metadata is local and read-only; browsing chips must not start a device service.
import { promises as fs } from 'fs';
import { join } from 'path';
import type { CatalogBoard, CatalogTemplate } from '../common/nodu-embedded-protocol';

export async function readProjectCatalog(resources: string): Promise<{ boards: CatalogBoard[] }> {
    const read = async (path: string) => JSON.parse(await fs.readFile(path, 'utf8'));
    const index = await read(join(resources, 'templates/templates.json')) as { templates: (CatalogTemplate & { needs?: string[] })[] };
    const boards: CatalogBoard[] = [];
    const entries = await fs.readdir(join(resources, 'boards'), { withFileTypes: true });
    for (const entry of entries.filter(e => e.isDirectory() && !e.isSymbolicLink() && !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))) {
        const parent = join(resources, 'boards', entry.name);
        const versions = (await fs.readdir(parent)).filter(v => /^\d+$/.test(v)).sort((a, b) => Number(b) - Number(a));
        if (!versions.length) continue;
        const board = await read(join(parent, versions[0], 'board.json'));
        if (!/^[A-Za-z0-9_-]+$/.test(board.mcu)) throw new Error(`板卡 ${entry.name} 的芯片标识无效。`);
        const chip = await read(join(resources, 'chips', board.mcu + '.json'));
        const led = (board.leds ?? []).find((l: { pin?: unknown; verified?: unknown }) => typeof l.pin === 'string' && typeof l.verified === 'string') ?? null;
        const templates = index.templates.filter(t => (board.templates ?? []).includes(t.id)
            && (!(t.needs ?? []).includes('debugUart') || typeof board.debugUart?.instance === 'string')
            && (!(t.needs ?? []).includes('led') || !!led)).map(t => ({ id: t.id, name: t.name, description: t.description, available: true, needsInput: [], reason: null }));
        boards.push({ id: board.id, version: board.version, reference: `${board.id}@${board.version}`, name: board.name,
            description: board.description, mcu: chip.id, chipName: chip.name, core: chip.core,
            flashKiB: chip.flash.size / 1024, ramKiB: chip.ram.size / 1024, gpioPorts: chip.gpioPorts,
            debugUart: board.debugUart ?? null, led, templates });
    }
    return { boards };
}
