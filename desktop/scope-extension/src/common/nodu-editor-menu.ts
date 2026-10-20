// SPDX-License-Identifier: MIT
// Pure logic for the 0.1.4 File/Edit menu parity work: clipboard-history
// ring, recent-files list ops, print HTML rendering, font-size clamp and the
// static label/keybinding table the tests assert against the original menu
// evidence (docs/0.1.3/evidence/maixpy-ide-0.2.5-menus.txt).

export const CLIPBOARD_HISTORY_MAX = 10;
export const RECENT_FILES_MAX = 10;
export const FONT_SIZE_MIN = 6;
export const FONT_SIZE_MAX = 72;
/** electron-app package.json default for `editor.fontSize`. */
export const FONT_SIZE_DEFAULT = 13;

/**
 * Last-N distinct copied/cut texts, newest first. Re-copying an existing
 * entry moves it to the front rather than duplicating it.
 */
export class ClipboardHistory {
    private items: string[] = [];
    push(text: string): void {
        if (!text) { return; }
        const at = this.items.indexOf(text);
        if (at >= 0) { this.items.splice(at, 1); }
        this.items.unshift(text);
        this.items.length = Math.min(this.items.length, CLIPBOARD_HISTORY_MAX);
    }
    get list(): readonly string[] { return this.items; }
    clear(): void { this.items = []; }
}

/** QuickPick row for a clipboard entry: first line ≤80 chars + line count. */
export function clipboardItemDisplay(text: string): { label: string; detail: string } {
    const lines = text.split('\n');
    const first = lines[0];
    const label = first.length > 80 ? `${first.slice(0, 80)}…` : first;
    return { label, detail: `${lines.length} 行` };
}

/** Most-recent-first list update: dedupe, unshift, cap at RECENT_FILES_MAX. */
export function pushRecentFile(list: readonly string[], path: string): string[] {
    const next = [path, ...list.filter(item => item !== path)];
    next.length = Math.min(next.length, RECENT_FILES_MAX);
    return next;
}

export function removeRecentFile(list: readonly string[], path: string): string[] {
    return list.filter(item => item !== path);
}

export function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Standalone print document: monospace 10pt, title = file name. */
export function printDocumentHtml(text: string, title: string): string {
    return '<!doctype html><html><head><meta charset="utf-8">'
        + `<title>${escapeHtml(title)}</title>`
        + '<style>body{margin:0}pre{font-family:monospace;font-size:10pt;white-space:pre-wrap;word-break:break-all}</style>'
        + `</head><body><pre>${escapeHtml(text)}</pre></body></html>`;
}

/** `editor.fontSize` stays inside [6, 72]; reset lands on the app default. */
export function clampFontSize(size: number): number {
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(size)));
}

export interface EditorMenuSpec {
    id: string;
    label: string;
    keybinding?: string;
    when?: string;
}

/** 高级 submenu entries (original MaixPy IDE 0.2.5 编辑→高级), in order. */
export const ADVANCED_MENU: EditorMenuSpec[] = [
    { id: 'editor.action.toggleRenderWhitespace', label: '使空格可见' },
    { id: 'editor.action.trimTrailingWhitespace', label: '清除空格' },
    { id: 'editor.action.toggleWordWrap', label: '启用文本环绕' },
    { id: 'editor.action.commentLine', label: '切换注释选择', keybinding: 'ctrlcmd+/' },
    { id: '-', label: '-' },
    { id: 'scope.edit.cut-line', label: '剪切行', keybinding: 'shift+delete', when: 'editorTextFocus' },
    { id: 'scope.edit.copy-line', label: '复制行', when: 'editorTextFocus' },
    { id: 'editor.action.transformToUppercase', label: '大写选择', keybinding: 'ctrl+shift+u', when: 'editorTextFocus' },
    { id: 'editor.action.transformToLowercase', label: '小写选择', keybinding: 'ctrl+u', when: 'editorTextFocus' },
    { id: '-', label: '-' },
    { id: 'editor.fold', label: '折叠', keybinding: 'ctrlcmd+shift+,', when: 'editorTextFocus' },
    { id: 'editor.unfold', label: '展开', keybinding: 'ctrlcmd+shift+.', when: 'editorTextFocus' },
    { id: 'scope.edit.toggle-fold-all', label: '切换折叠全部', when: 'editorTextFocus' },
    { id: '-', label: '-' },
    { id: 'scope.edit.increase-font', label: '增加字体大小', keybinding: 'ctrlcmd+=', when: 'editorTextFocus && !findWidgetVisible' },
    { id: 'scope.edit.decrease-font', label: '减小字体大小', keybinding: 'ctrlcmd+-', when: 'editorTextFocus' },
    { id: 'scope.edit.reset-font', label: '重置字体大小', keybinding: 'ctrl+0', when: 'editorTextFocus' },
];

/** 查找/替换 submenu entries, in order. */
export const FIND_REPLACE_MENU: EditorMenuSpec[] = [
    { id: 'actions.find', label: '查找/替换', keybinding: 'ctrlcmd+f' },
    { id: 'search-in-workspace.open', label: '打开高级查找...', keybinding: 'ctrlcmd+shift+f' },
    { id: '-', label: '-' },
    { id: 'editor.action.nextMatchFindAction', label: '查找下一个', keybinding: 'ctrlcmd+g', when: 'editorTextFocus' },
    { id: 'editor.action.previousMatchFindAction', label: '查找上一个', keybinding: 'ctrlcmd+shift+g', when: 'editorTextFocus' },
    { id: 'editor.action.replaceOne', label: '替换并查找', keybinding: 'ctrlcmd+=', when: 'findWidgetVisible' },
    { id: 'editor.action.replaceAll', label: '全部替换' },
];
