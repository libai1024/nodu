// SPDX-License-Identifier: MIT
/** Small, DOM-independent rules shared by the console views and their tests. */
export interface ConsoleRecord {
    sequence: number;
    text: string;
    stream: 'stdout' | 'stderr' | 'system' | 'command';
    clippedCharacters: number;
}

export class ConsoleBuffer {
    readonly records: ConsoleRecord[] = [];
    sequence = 0;
    private length = 0;

    constructor(initial: readonly ConsoleRecord[] = [], sequence = 0) {
        this.records.push(...initial);
        this.sequence = sequence;
        this.length = initial.reduce((sum, record) => sum + record.text.length, 0);
    }

    append(text: string, stream: ConsoleRecord['stream'], alreadyClipped = 0): void {
        if (!text) { return; }
        let start = Math.max(0, text.length - 32000);
        // Never start the retained tail at the second half of a surrogate pair.
        if (start && text.charCodeAt(start) >= 0xdc00 && text.charCodeAt(start) <= 0xdfff) { start++; }
        const retained = text.slice(start);
        this.records.push({ sequence: ++this.sequence, text: retained, stream, clippedCharacters: start + alreadyClipped });
        this.length += retained.length;
        while (this.records.length > 300 || this.length > 200000) {
            this.length -= this.records.shift()!.text.length;
        }
    }
}

export interface ConsoleMatch { start: number; end: number; }
export function findConsoleMatches(text: string, query: string, limit = 1000): { matches: ConsoleMatch[]; hasMore: boolean } {
    if (!query) { return { matches: [], hasMore: false }; }
    const expression = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
    const matches: ConsoleMatch[] = [];
    let match: RegExpExecArray | null;
    while ((match = expression.exec(text))) {
        if (matches.length === limit) { return { matches, hasMore: true }; }
        matches.push({ start: match.index, end: match.index + match[0].length });
    }
    return { matches, hasMore: false };
}

export function canBrowsePythonHistory(code: string, selectionStart: number, selectionEnd: number, direction: 'previous' | 'next'): boolean {
    if (selectionStart !== selectionEnd) { return false; }
    return direction === 'previous' ? !code.slice(0, selectionStart).includes('\n') : !code.slice(selectionEnd).includes('\n');
}

export function shouldExecutePython(code: string, key: {
    key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; isComposing?: boolean; keyCode?: number;
}): boolean {
    if (key.key !== 'Enter' || key.isComposing || key.keyCode === 229) { return false; }
    if (key.ctrlKey || key.metaKey) { return true; }
    return !key.shiftKey && !code.includes('\n');
}
