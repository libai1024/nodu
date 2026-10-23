// SPDX-License-Identifier: MIT
export interface TutorLineHistory {
    line: number;
    text: string;
    status: 'pending' | 'ok' | 'needs-work' | 'context' | 'stale' | 'unavailable';
    note: string;
    guided?: boolean;
}
/** Window-local, bounded history. Never reuse model version numbers across editor instances. */
export class TutorLineHistoryCache {
    private readonly files = new Map<string, { source: string; lines: TutorLineHistory[] }>();
    save(key: string, source: string, lines: TutorLineHistory[]): void {
        this.files.delete(key);
        if (source.length > 32000 || !lines.length) { return; }
        this.files.set(key, { source, lines: lines.slice(-256).map(line => ({ ...line,
            ...(line.status === 'pending' ? { status: 'stale' as const, note: '检查已中断', guided: false } : {}),
        })) });
        while (this.files.size > 16) { this.files.delete(this.files.keys().next().value!); }
    }
    restore(key: string, source: string): TutorLineHistory[] {
        const saved = this.files.get(key);
        if (!saved || saved.source !== source) { this.files.delete(key); return []; }
        return saved.lines.map(line => ({ ...line }));
    }
    clear(): void { this.files.clear(); }
}
