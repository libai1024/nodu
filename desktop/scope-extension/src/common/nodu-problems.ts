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

/** Keep copied diagnostics useful outside the Problems view, including in chat. */
export function formatProblem(problem: NoduProblem, path = problem.uri): string {
    const { diagnostic } = problem;
    const start = diagnostic.range.start;
    const severity = diagnostic.severity === 1 ? '错误' : diagnostic.severity === 2 ? '警告' : '提示';
    const details = [problem.sources.length ? `来源：${problem.sources.join('、')}` : '',
        diagnostic.code !== undefined ? `代码：${diagnostic.code}` : ''].filter(Boolean);
    return `${path}:${start.line + 1}:${start.character + 1} [${severity}] ${diagnostic.message}${details.length ? `\n${details.join(' · ')}` : ''}`;
}

export function formatProblems(problems: readonly NoduProblem[], path: (problem: NoduProblem) => string = problem => problem.uri): string {
    return problems.map(problem => formatProblem(problem, path(problem))).join('\n\n');
}
