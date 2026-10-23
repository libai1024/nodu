// SPDX-License-Identifier: MIT
// Pure helpers for the desktop launcher. No Theia or Electron imports, so the renderer,
// the Electron main process, the backend and plain node tests can all use them.
import { PROJECT_CHIPS, PROJECT_FAMILIES } from './nodu-project-catalog';

/** Parses JSON with comments and trailing commas, as found in settings.json. */
export function parseJsonc(text: string): unknown {
    const source = text.replace(/^\uFEFF/, '');
    let out = '';
    for (let i = 0; i < source.length; i++) {
        const c = source[i];
        if (c === '"') {
            const start = i;
            for (i++; i < source.length && source[i] !== '"'; i++) { if (source[i] === '\\') { i++; } }
            out += source.slice(start, i + 1);
        } else if (c === '/' && source[i + 1] === '/') {
            while (i < source.length && source[i] !== '\n') { i++; }
            out += '\n';
        } else if (c === '/' && source[i + 1] === '*') {
            const end = source.indexOf('*/', i + 2);
            i = end < 0 ? source.length : end + 1;
            out += ' ';
        } else if (c === '}' || c === ']') {
            // Structural close: a trailing comma before it can only be outside a string.
            out = out.replace(/,(\s*)$/, '$1') + c;
        } else {
            out += c;
        }
    }
    return JSON.parse(out);
}

/** Short chip label for a project folder (K210, STM32F407, ESP32-S3) from nodu.json or a legacy board.json. */
export function projectTag(manifests: { nodu?: unknown; board?: unknown }): string | undefined {
    const nodu = manifests.nodu as { kind?: unknown; target?: { mcu?: unknown } } | undefined;
    const mcu = typeof nodu?.target?.mcu === 'string' ? nodu.target.mcu.trim() : '';
    if (mcu) {
        const chip = PROJECT_CHIPS.find(c => c.id.toLowerCase() === mcu.toLowerCase());
        if (chip) { return chip.family.startsWith('stm32') ? PROJECT_FAMILIES.find(f => f.id === chip.family)?.name ?? chip.name : chip.name; }
        return (/^STM32[A-Z]\d{3}/i.exec(mcu)?.[0] ?? mcu).toUpperCase().slice(0, 16);
    }
    const kind = typeof nodu?.kind === 'string' ? nodu.kind : '';
    if (kind === 'k210-maixpy') { return 'K210'; }
    if (kind === 'esp-idf') { return 'ESP32'; }
    if (kind.startsWith('stm32')) { return 'STM32'; }
    const chip = (manifests.board as { chip?: unknown } | undefined)?.chip;
    return typeof chip === 'string' && chip.trim() ? chip.trim().toUpperCase().slice(0, 16) : undefined;
}

/**
 * The project folder a Theia window URL carries in its fragment (`index.html?port=1#/path`),
 * or undefined for the launcher, an empty window (`#!empty`) or no fragment.
 */
export function projectFromWindowUrl(url: string, launcherQuery: string): string | undefined {
    let parsed: URL;
    try { parsed = new URL(url); } catch { return undefined; }
    if (parsed.searchParams.has(launcherQuery)) { return undefined; }
    const raw = parsed.hash.slice(1);
    if (!raw || raw.startsWith('!')) { return undefined; }
    let value: string;
    try { value = decodeURI(raw); } catch { return undefined; }
    if (value.startsWith('file://')) {
        try { value = decodeURIComponent(new URL(value).pathname); } catch { return undefined; }
    }
    // Theia writes URI paths ("/c:/Users/..."); give Windows its drive-letter form back.
    return /^\/[A-Za-z]:\//.test(value) ? value.slice(1) : value;
}

/** Comparison key for folder paths: no trailing separator, Windows paths case-folded. */
export function pathKey(fsPath: string): string {
    const trimmed = fsPath.length > 1 ? fsPath.replace(/[\\/]+$/, '') : fsPath;
    return /^[A-Za-z]:/.test(trimmed) ? trimmed.replace(/\\/g, '/').toLowerCase() : trimmed;
}

export interface StoredProject { path: string; lastOpened?: number }
export const RECENT_LIMIT = 50;

/** Moves (or adds) a folder to the front of the recent list with the given time. */
export function touchRecent(stored: StoredProject[], fsPath: string, now: number, limit = RECENT_LIMIT): StoredProject[] {
    const key = pathKey(fsPath);
    return [{ path: fsPath, lastOpened: now }, ...stored.filter(p => pathKey(p.path) !== key)].slice(0, limit);
}

/** Launcher order: Nodu's own list (it keeps missing folders and times) first, then Theia's recent roots it lacks. */
export function mergeRecent(stored: StoredProject[], theiaRoots: string[], limit = RECENT_LIMIT): StoredProject[] {
    const seen = new Set<string>();
    const out: StoredProject[] = [];
    for (const item of [...stored, ...theiaRoots.map(path => ({ path }))]) {
        const key = item.path ? pathKey(item.path) : '';
        if (!key || seen.has(key)) { continue; }
        seen.add(key);
        out.push(item);
        if (out.length >= limit) { break; }
    }
    return out;
}

/** `name`, then `name-2`, `name-3`, ... until `taken` says the name is free. */
export function uniqueName(name: string, taken: (candidate: string) => boolean): string {
    if (!taken(name)) { return name; }
    for (let n = 2; n < 1000; n++) { if (!taken(`${name}-${n}`)) { return `${name}-${n}`; } }
    return `${name}-${Date.now()}`;
}

/** Title (first `# ` heading) and first prose line of a README. */
export function readmeSummary(text: string): { title?: string; summary?: string } {
    const lines = text.split(/\r?\n/).map(line => line.trim());
    const title = lines.find(line => /^#\s+\S/.test(line))?.replace(/^#\s+/, '');
    const summary = lines.find(line => line && !/^(#|[-*>|`!<[]|\d+\.)/.test(line));
    return { title, summary: summary && summary.length > 120 ? `${summary.slice(0, 117)}…` : summary };
}

/** "刚刚", "5 分钟前", "3 小时前", "昨天", "3 天前", then the date. */
export function relativeTime(then: number | undefined, now = Date.now()): string {
    if (!then) { return ''; }
    const minutes = Math.floor((now - then) / 60000);
    if (minutes < 1) { return '刚刚'; }
    if (minutes < 60) { return `${minutes} 分钟前`; }
    const hours = Math.floor(minutes / 60);
    if (hours < 24) { return `${hours} 小时前`; }
    const days = Math.floor(hours / 24);
    if (days === 1) { return '昨天'; }
    if (days < 7) { return `${days} 天前`; }
    const d = new Date(then);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
