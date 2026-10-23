// SPDX-License-Identifier: MIT
import type { TutorCourseAnchor } from './tutor-course';
/** Marker resolution is deliberately exact; missing or duplicated anchors are never guessed. */
export function tutorMarkerLine(lines: readonly string[], anchor: TutorCourseAnchor): number | undefined {
    if (!anchor.marker) { return undefined; }
    const found: number[] = [];
    lines.forEach((line, index) => { if (line.includes(anchor.marker!)) { found.push(index + 1); } });
    return found.length === 1 ? found[0] : undefined;
}
export function ghostSuffix(typed: string, candidate: string): string | undefined {
    if (!candidate || /[\r\n]/.test(candidate)) { return undefined; }
    const expected = candidate.trimStart(), actual = typed.trimStart();
    return expected.startsWith(actual) ? expected.slice(actual.length) || undefined : undefined;
}
export function reviewableLine(line: string): boolean { return !!line.trim() && !/^\s*(\/\/|\/\*|\*|#)/.test(line); }
/** Completion events only; an ordinary character edit never creates an AI request. */
export function completedLines(before: readonly string[], after: readonly string[], startLine: number, endLine: number, inserted: string): number[] {
    if (!inserted.includes('\n')) { return []; }
    const count = inserted.split('\n').length - 1;
    const result: number[] = [];
    for (let line = startLine; line < startLine + count; line++) {
        if (after[line - 1] !== undefined && reviewableLine(after[line - 1]) && (before[line - 1] !== after[line - 1] || startLine === endLine)) { result.push(line); }
    }
    return result;
}

/** A code exercise survives edits inside its insertion region, but never follows unrelated file edits. */
export function guidanceEditMatches(source: { path: string; text: string }, next: { path: string; text: string }, anchorLine: number, lineCount: number): boolean {
    if (source.path !== next.path || anchorLine < 1 || lineCount < 1) { return false; }
    const before = source.text.split('\n'), after = next.text.split('\n');
    if (anchorLine > before.length) { return false; }
    const head = before.slice(0, anchorLine - 1), tail = before.slice(anchorLine);
    const regionEnd = after.length - tail.length;
    return regionEnd >= head.length && regionEnd - head.length <= lineCount + 1
        && head.every((text, index) => after[index] === text)
        && tail.every((text, index) => after[regionEnd + index] === text);
}

export function pendingReviewCount(tasks: Iterable<{ status: string }>): number {
    return [...tasks].filter(task => task.status === 'pending').length;
}
