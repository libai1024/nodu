// SPDX-License-Identifier: MIT
import type { TutorBuffer, TutorMode } from './tutor-ai-protocol';
/** For terminal snapshots path identifies the source widget, never a filesystem reference. */
export interface TutorContext { kind: 'file' | 'selection' | 'terminal'; path: string; text: string; version: number; startLine: number; endLine: number; terminalName?: string; terminalSelection?: boolean; }
export const isTerminalContextName = (name: unknown): name is string => typeof name === 'string' && name.length > 0 && name.length <= 160 && !/[\x00-\x1f\x7f]/.test(name);
export const terminalContextLabel = (context: Pick<TutorContext, 'startLine' | 'endLine' | 'terminalName' | 'terminalSelection'>): string => {
    const name = isTerminalContextName(context.terminalName) ? context.terminalName : '终端';
    return context.terminalSelection ? `${name} (${context.startLine}${context.endLine === context.startLine ? '' : `-${context.endLine}`})` : name;
};
export const TUTOR_CONTEXT_LIMIT = 64 * 1024;
/** Pure shape/budget validation. The host additionally authorizes every path against this window's project. */
export function validateTutorContexts(input: unknown, mode: TutorMode, buffer?: TutorBuffer): TutorContext[] {
    if (!Array.isArray(input) || input.length + (buffer ? 1 : 0) > 6) { throw new Error('最多附带 6 项上下文'); }
    let size = buffer ? new TextEncoder().encode(buffer.text).byteLength : 0;
    const keys = new Set<string>();
    const contexts = input.map((c: TutorContext) => {
        if (!c || Object.keys(c).some(k => !['kind','path','text','version','startLine','endLine','terminalName','terminalSelection'].includes(k))
            || !['file','selection','terminal'].includes(c.kind) || typeof c.path !== 'string' || !c.path || c.path.length > 1024
            || (c.kind === 'terminal' ? !isTerminalContextName(c.path) : c.path.startsWith('/') || c.path.includes('\\') || c.path.includes('\0') || c.path.split('/').some(p => !p || p === '..' || p === '.')
                || !(mode === 'ask' ? /\.(c|h|cc|cpp|hpp|py)$/i : /\.(c|h|cc|cpp|hpp)$/i).test(c.path))
            || (c.terminalName !== undefined && (c.kind !== 'terminal' || !isTerminalContextName(c.terminalName)))
            || (c.terminalSelection !== undefined && (c.kind !== 'terminal' || typeof c.terminalSelection !== 'boolean'))
            || typeof c.text !== 'string' || c.text.includes('\0') || !Number.isSafeInteger(c.version) || c.version < 1
            || !Number.isSafeInteger(c.startLine) || c.startLine < 1 || !Number.isSafeInteger(c.endLine) || c.endLine < c.startLine || c.endLine > 1000000
            // Xterm selections join soft-wrapped rows, so text lines can be fewer than buffer rows.
            || (c.kind === 'terminal' ? c.text.split('\n').length > c.endLine - c.startLine + 1 : c.text.split('\n').length !== c.endLine - c.startLine + 1)
            || (c.kind === 'file' && c.startLine !== 1)) { throw new Error('附件无效；Python 文件仅用于提问'); }
        const key = `${c.kind === 'terminal' ? `terminal:${!!c.terminalSelection}:` : ''}${c.path}:${c.startLine}:${c.endLine}`;
        if (keys.has(key)) { throw new Error('请移除重复的文件或选区'); } keys.add(key);
        size += new TextEncoder().encode(c.text).byteLength;
        return { kind: c.kind, path: c.path, text: c.text, version: c.version, startLine: c.startLine, endLine: c.endLine,
            ...(c.terminalName !== undefined ? { terminalName: c.terminalName } : {}), ...(c.terminalSelection !== undefined ? { terminalSelection: c.terminalSelection } : {}) };
    });
    if (size > TUTOR_CONTEXT_LIMIT) { throw new Error('附带代码总量不能超过 64 KiB，请移除部分附件'); }
    return contexts;
}
/** Selection metadata is editor-local. Do not duplicate it in a full-file protocol buffer. */
export const requestBuffer = (b: TutorBuffer): TutorBuffer => ({ path: b.path, text: b.text, version: b.version, line: b.line });
