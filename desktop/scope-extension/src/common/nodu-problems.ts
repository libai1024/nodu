// SPDX-License-Identifier: MIT
import type { Diagnostic } from '@theia/core/shared/vscode-languageserver-protocol';
import type { Marker } from '@theia/markers/lib/common/marker';

export interface NoduProblem {
    readonly key: string;
    readonly uri: string;
    readonly diagnostic: Diagnostic;
    readonly sources: readonly string[];
}

export interface NoduProblemCounts { errors: number; warnings: number; infos: number; total: number; }

/** Keep marker owners intact; only the presentation merges duplicate reports. */
export function collectProblems(markers: readonly Marker<Diagnostic>[]): NoduProblem[] {
    const entries = new Map<string, NoduProblem>();
    for (const marker of markers) {
        const diagnostic = marker.data;
        const key = JSON.stringify([marker.uri, diagnostic.range.start.line, diagnostic.range.start.character, diagnostic.message]);
        const source = diagnostic.source || marker.owner;
        const previous = entries.get(key);
        const sources = Array.from(new Set([...(previous?.sources ?? []), source].filter(Boolean))).sort();
        const preferred = previous && (previous.diagnostic.severity ?? 3) <= (diagnostic.severity ?? 3)
            ? previous.diagnostic : diagnostic;
        entries.set(key, { key, uri: marker.uri, diagnostic: preferred, sources });
    }
    return [...entries.values()].sort((a, b) => (a.diagnostic.severity ?? 3) - (b.diagnostic.severity ?? 3)
        || a.uri.localeCompare(b.uri)
        || a.diagnostic.range.start.line - b.diagnostic.range.start.line
        || a.diagnostic.range.start.character - b.diagnostic.range.start.character
        || a.diagnostic.message.localeCompare(b.diagnostic.message));
}

export function countProblems(problems: readonly NoduProblem[]): NoduProblemCounts {
    const counts = { errors: 0, warnings: 0, infos: 0, total: problems.length };
    for (const problem of problems) {
        if (problem.diagnostic.severity === 1) { counts.errors++; }
        else if (problem.diagnostic.severity === 2) { counts.warnings++; }
        else { counts.infos++; }
    }
    return counts;
}
