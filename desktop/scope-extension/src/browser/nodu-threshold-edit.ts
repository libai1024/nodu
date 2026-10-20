// SPDX-License-Identifier: MIT
// Pure helpers for the threshold editor's selection parsing and writeback
// guard, kept DI-free so node:test can exercise them directly.

/** Strict `(a, b)` gray or `(lMin, lMax, aMin, aMax, bMin, bMax)` LAB tuple. */
export function parseThresholdTuple(text: string): number[] | undefined {
    const trimmed = text.trim();
    if (trimmed.length < 3 || !trimmed.startsWith('(') || !trimmed.endsWith(')')) { return undefined; }
    const parts = trimmed.slice(1, -1).split(',');
    if (parts.length !== 2 && parts.length !== 6) { return undefined; }
    const values: number[] = [];
    for (const part of parts) {
        const token = part.trim();
        if (!/^-?\d+$/.test(token)) { return undefined; }
        values.push(Number(token));
    }
    const domains: [number, number][] = values.length === 2
        ? [[0, 255], [0, 255]]
        : [[0, 100], [0, 100], [-128, 127], [-128, 127], [-128, 127], [-128, 127]];
    return values.every((value, index) => value >= domains[index][0] && value <= domains[index][1]) ? values : undefined;
}

/** Immutable snapshot of the selection captured before the dialog opens. */
export interface ThresholdEditCapture {
    readonly version: number;
    readonly rangeText: string;
}

/**
 * True when the captured editor target is gone or its document was swapped:
 * callers must not touch `model`/`control` afterwards. Kept flag-based so the
 * check itself can be exercised without a disposed monaco model.
 */
export function thresholdTargetDead(flags: { widgetDisposed: boolean; modelDisposed: boolean; modelChanged: boolean }): boolean {
    return flags.widgetDisposed || flags.modelDisposed || flags.modelChanged;
}

/**
 * Writeback is allowed only when nothing about the captured target changed:
 * the editor is alive and writable, the document version is identical, the
 * text still sitting at the captured range is the captured tuple text, and
 * that text is itself a strictly valid threshold tuple.
 */
export function thresholdWritebackAllowed(
    captured: ThresholdEditCapture,
    current: { version: number; rangeText: string; disposed: boolean; readOnly: boolean },
): boolean {
    return !current.disposed
        && !current.readOnly
        && captured.version === current.version
        && captured.rangeText === current.rangeText
        && parseThresholdTuple(captured.rangeText) !== undefined;
}
