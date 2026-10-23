// SPDX-License-Identifier: MIT
export interface TutorLineHistory {
    line: number;
    text: string;
    status: 'pending' | 'ok' | 'needs-work' | 'context' | 'stale' | 'unavailable';
    note: string;
    guided?: boolean;
}
export interface TutorHistoryStorage {
    readonly length: number;
    key(index: number): string | null;
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}
interface SavedHistory { schema: 1; key: string; source: string; lines: TutorLineHistory[]; savedAt: number; }
const PREFIX = 'nodu.tutor.line-history.v1.';
/** Bounded local history, never a fresh semantic/build result after an application restart. */
export class TutorLineHistoryCache {
    private readonly files = new Map<string, SavedHistory>();
    constructor(private readonly storage?: TutorHistoryStorage) { }
    private slot(key: string): string {
        // Index only. The full identity is compared on read, so a collision can only lose a cache entry.
        let hash = 2166136261;
        for (let i = 0; i < key.length; i++) { hash = Math.imul(hash ^ key.charCodeAt(i), 16777619); }
        return PREFIX + (hash >>> 0).toString(16);
    }
    private valid(value: unknown): value is SavedHistory {
        const h = value as SavedHistory;
        if (!h || h.schema !== 1 || typeof h.key !== 'string' || h.key.length > 64000 || typeof h.source !== 'string'
            || h.source.length > 32000 || !Number.isFinite(h.savedAt) || !Array.isArray(h.lines) || h.lines.length > 256) { return false; }
        const source = h.source.split('\n'), seen = new Set<number>();
        return h.lines.every(line => {
            if (!line || !Number.isInteger(line.line) || line.line < 1 || line.line > source.length || seen.has(line.line)
                || typeof line.text !== 'string' || line.text.length > 2000 || line.text !== source[line.line - 1]
                || !['pending','ok','needs-work','context','stale','unavailable'].includes(line.status)
                || typeof line.note !== 'string' || line.note.length > 1200 || (line.guided !== undefined && typeof line.guided !== 'boolean')) { return false; }
            seen.add(line.line); return true;
        });
    }
    save(key: string, source: string, lines: TutorLineHistory[]): void {
        this.files.delete(key);
        const saved: SavedHistory = { schema: 1, key, source, savedAt: Date.now(), lines: lines.slice(-256).map(line => ({ ...line,
            ...(line.status === 'pending' ? { status: 'stale' as const, note: '检查已中断', guided: false } : {}),
        })) };
        const body = JSON.stringify(saved);
        if (!saved.lines.length || !this.valid(saved) || body.length > 180000) { this.remove(key); return; }
        this.files.set(key, saved);
        while (this.files.size > 16) { this.files.delete(this.files.keys().next().value!); }
        try {
            this.storage?.setItem(this.slot(key), body);
            const entries: {key:string; time:number}[] = [];
            for (let i = 0; i < (this.storage?.length ?? 0); i++) {
                const name = this.storage!.key(i);
                if (name?.startsWith(PREFIX)) {
                    let time = 0;
                    try { const raw = this.storage!.getItem(name); if (raw && raw.length <= 180000) { time = Number(JSON.parse(raw).savedAt) || 0; } } catch { /* corrupt cache */ }
                    entries.push({key:name,time});
                }
            }
            entries.sort((a,b) => b.time - a.time).slice(16).forEach(e => this.storage!.removeItem(e.key));
        } catch { /* Quota/private mode never blocks teaching or editor input. */ }
    }
    private remove(key: string): void {
        this.files.delete(key);
        try { this.storage?.removeItem(this.slot(key)); } catch { /* optional cache */ }
    }
    restore(key: string, source: string): TutorLineHistory[] {
        let saved = this.files.get(key);
        if (!saved) {
            try {
                const raw = this.storage?.getItem(this.slot(key));
                if (raw && raw.length <= 180000) {
                    const parsed: unknown = JSON.parse(raw);
                    if (this.valid(parsed) && parsed.key === key) {
                        saved = { ...parsed, lines: parsed.lines.map(line => ({ ...line, status: 'stale', note: '历史检查，待重新验证' })) };
                    }
                }
            } catch { /* malformed or unavailable storage is not evidence */ }
        }
        if (!saved || saved.source !== source) { this.remove(key); return []; }
        this.files.set(key, saved);
        while (this.files.size > 16) { this.files.delete(this.files.keys().next().value!); }
        return saved.lines.map(line => ({ ...line }));
    }
    clear(): void {
        this.files.clear();
        try {
            const keys = Array.from({length:this.storage?.length ?? 0}, (_,i) => this.storage!.key(i));
            keys.filter((key): key is string => !!key?.startsWith(PREFIX)).forEach(key => this.storage!.removeItem(key));
        } catch { /* optional cache */ }
    }
}
