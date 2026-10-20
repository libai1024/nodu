// SPDX-License-Identifier: MIT
// MaixPy IDE 0.2.5 编辑菜单 parity items Theia does not ship: clipboard
// history paste, the 高级 submenu (line cut/copy, case transform, fold, font
// size), the 查找/替换 submenu, 转到行 ⌘L, 新建文件 ⌘N and 打印...
// Static labels/keys live in ../common/nodu-editor-menu.ts for tests.
// Ported from openmv-qt-creator openmvplugin.cpp (MIT)
//
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvplugin.cpp
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, DisposableCollection, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonCommands, CommonMenus, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import * as monaco from '@theia/monaco-editor-core';
import {
    ADVANCED_MENU, FIND_REPLACE_MENU, ClipboardHistory, FONT_SIZE_DEFAULT,
    clampFontSize, clipboardItemDisplay, printDocumentHtml,
} from '../common/nodu-editor-menu';

const EDIT_SELECT_GROUP = [...CommonMenus.EDIT, '2y_select'];
const EDIT_ADVANCED_SUBMENU = [...CommonMenus.EDIT, '2z_advanced'];
const EDIT_FIND_GROUP = [...CommonMenus.EDIT, '3_find'];
const EDIT_FIND_SUBMENU = [...EDIT_FIND_GROUP, 'nodu-find-replace'];
const EDIT_GOTO_GROUP = [...CommonMenus.EDIT, '4_gotoline'];
const FILE_PRINT_GROUP = [...CommonMenus.FILE, '7_print'];

interface ICodeEditorLite {
    getModel(): monaco.editor.ITextModel | null;
    getSelections(): monaco.Selection[];
    executeEdits(source: string, edits: monaco.editor.IIdentifiedSingleEditOperation[]): boolean;
    trigger(source: string, handlerId: string, payload: unknown): void;
    getContribution(id: string): unknown;
}

@injectable()
export class NoduEditorMenusContribution implements CommandContribution, MenuContribution, KeybindingContribution, FrontendApplicationContribution {
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(MenuModelRegistry) protected readonly menus!: MenuModelRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings!: KeybindingRegistry;
    private readonly clipboardHistory = new ClipboardHistory();
    private readonly toDispose = new DisposableCollection();

    private codeEditor(): ICodeEditorLite | undefined {
        return MonacoEditor.getCurrent(this.editors)?.getControl() as unknown as ICodeEditorLite | undefined;
    }

    registerCommands(registry: CommandRegistry): void {
        const editorScoped = { isEnabled: () => !!this.codeEditor() };
        registry.registerCommand({ id: 'scope.clipboard-history-paste', label: '从剪贴板历史记录粘贴', category: '见微 Nodu' }, {
            ...editorScoped,
            execute: () => this.pasteFromHistory().catch(error => this.messages.error(`粘贴：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.edit.cut-line', label: '剪切行', category: '见微 Nodu' }, {
            ...editorScoped, execute: () => this.cutLines(true),
        });
        registry.registerCommand({ id: 'scope.edit.copy-line', label: '复制行', category: '见微 Nodu' }, {
            ...editorScoped, execute: () => this.cutLines(false),
        });
        registry.registerCommand({ id: 'scope.edit.toggle-fold-all', label: '切换折叠全部', category: '见微 Nodu' }, {
            ...editorScoped,
            execute: () => this.toggleFoldAll().catch(error => this.messages.error(`折叠：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.edit.increase-font', label: '增加字体大小', category: '见微 Nodu' }, { execute: () => this.bumpFont(1) });
        registry.registerCommand({ id: 'scope.edit.decrease-font', label: '减小字体大小', category: '见微 Nodu' }, { execute: () => this.bumpFont(-1) });
        registry.registerCommand({ id: 'scope.edit.reset-font', label: '重置字体大小', category: '见微 Nodu' }, { execute: () => this.bumpFont(0) });
        registry.registerCommand({ id: 'scope.print', label: '打印...', category: '见微 Nodu' }, {
            ...editorScoped, execute: () => this.print(),
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        // Original Edit relabels: Theia's flat items keep their positions but
        // get the original Chinese labels; FIND/REPLACE/SIW move into the
        // original 查找/替换 submenu instead of flat entries.
        const relabels: { commandId: string; label: string; order: string }[] = [
            { commandId: CommonCommands.UNDO.id, label: '撤销', order: '0' },
            { commandId: CommonCommands.REDO.id, label: '重做', order: '1' },
        ];
        for (const { commandId, label, order } of relabels) {
            menus.unregisterMenuAction(commandId, CommonMenus.EDIT_UNDO);
            menus.registerMenuAction(CommonMenus.EDIT_UNDO, { commandId, label, order });
        }
        const clipRelabels: { commandId: string; label: string; order: string }[] = [
            { commandId: CommonCommands.CUT.id, label: '剪切', order: '0' },
            { commandId: CommonCommands.COPY.id, label: '复制', order: '1' },
            { commandId: CommonCommands.PASTE.id, label: '粘贴', order: '2' },
        ];
        for (const { commandId, label, order } of clipRelabels) {
            menus.unregisterMenuAction(commandId, CommonMenus.EDIT_CLIPBOARD);
            menus.registerMenuAction(CommonMenus.EDIT_CLIPBOARD, { commandId, label, order });
        }
        menus.unregisterMenuAction(CommonCommands.FIND.id, EDIT_FIND_GROUP);
        menus.unregisterMenuAction(CommonCommands.REPLACE.id, EDIT_FIND_GROUP);
        menus.unregisterMenuAction('search-in-workspace.open', EDIT_FIND_GROUP);

        menus.registerMenuAction(CommonMenus.EDIT_CLIPBOARD, { commandId: 'scope.clipboard-history-paste', order: '25' });
        menus.registerMenuAction(EDIT_SELECT_GROUP, { commandId: CommonCommands.SELECT_ALL.id, label: '全选', order: '0' });
        this.toDispose.push(menus.registerSubmenu(EDIT_ADVANCED_SUBMENU, '高级'));
        this.toDispose.push(menus.registerSubmenu(EDIT_FIND_SUBMENU, '查找/替换'));
        menus.registerMenuAction(EDIT_GOTO_GROUP, { commandId: 'editor.action.gotoLine', label: '转到行...', order: '0' });
        menus.registerMenuAction(FILE_PRINT_GROUP, { commandId: 'scope.print', order: '0' });

        let advancedGroup = 0;
        for (const item of ADVANCED_MENU) {
            if (item.id === '-') { advancedGroup++; continue; }
            this.toDispose.push(menus.registerMenuAction(
                [...EDIT_ADVANCED_SUBMENU, `g${advancedGroup}`],
                { commandId: item.id, label: item.label, order: '0' }));
        }
        let findGroup = 0;
        for (const item of FIND_REPLACE_MENU) {
            if (item.id === '-') { findGroup++; continue; }
            this.toDispose.push(menus.registerMenuAction(
                [...EDIT_FIND_SUBMENU, `g${findGroup}`],
                { commandId: item.id, label: item.label, order: '0' }));
        }
    }

    registerKeybindings(registry: KeybindingRegistry): void {
        // Original key overrides: unregister whatever held these keys first
        // (Theia 新建文件 ⌘N, Monaco expandLineSelection ⌘L, native cut
        // shift+delete, cursorUndo ⌃U) — ours are registered right after.
        for (const key of ['ctrlcmd+n', 'ctrlcmd+l', 'shift+delete', 'ctrl+u']) {
            registry.unregisterKeybinding(key);
        }
        registry.registerKeybindings(
            { command: 'scope.new-script', keybinding: 'ctrlcmd+n' },
            { command: 'scope.clipboard-history-paste', keybinding: 'ctrlcmd+shift+v', when: 'editorTextFocus' },
            { command: 'editor.action.gotoLine', keybinding: 'ctrlcmd+l', when: 'editorTextFocus' },
            { command: 'editor.action.nextMatchFindAction', keybinding: 'ctrlcmd+g', when: 'editorTextFocus' },
            { command: 'editor.action.previousMatchFindAction', keybinding: 'ctrlcmd+shift+g', when: 'editorTextFocus' },
            { command: 'editor.action.commentLine', keybinding: 'ctrlcmd+/', when: 'editorTextFocus' },
        );
        for (const item of [...ADVANCED_MENU, ...FIND_REPLACE_MENU]) {
            if (item.id === '-' || !item.keybinding || ['ctrlcmd+/', 'ctrlcmd+f', 'ctrlcmd+shift+f', 'ctrlcmd+g', 'ctrlcmd+shift+g'].includes(item.keybinding)) {
                continue;
            }
            registry.registerKeybinding({ command: item.id, keybinding: item.keybinding, when: item.when });
        }
    }

    onStart(): void {
        // Clipboard ring: copy/cut inside a Monaco editor's own textarea.
        const onCopy = (event: ClipboardEvent): void => {
            const editor = this.codeEditor();
            if (!editor) { return; }
            const target = event.target;
            if (!(target instanceof HTMLElement) || !target.classList.contains('inputarea')) { return; }
            const model = editor.getModel();
            if (!model) { return; }
            const eol = model.getEOL();
            const parts = editor.getSelections().map(selection =>
                selection.isEmpty()
                    ? model.getLineContent(selection.startLineNumber) + eol
                    : model.getValueInRange(selection));
            this.clipboardHistory.push(parts.join(eol));
        };
        document.addEventListener('copy', onCopy, true);
        document.addEventListener('cut', onCopy, true);
        this.toDispose.push({ dispose: () => { document.removeEventListener('copy', onCopy, true); document.removeEventListener('cut', onCopy, true); } });
    }

    private async pasteFromHistory(): Promise<void> {
        const editor = this.codeEditor();
        const model = editor?.getModel();
        if (!editor || !model) { return; }
        const items = this.clipboardHistory.list;
        if (!items.length) {
            await this.messages.info('剪贴板历史记录为空');
            return;
        }
        const picked = await this.quickPick.show(
            items.map(text => {
                const { label, detail } = clipboardItemDisplay(text);
                return { label, detail, text };
            }),
            { placeholder: '从剪贴板历史记录粘贴' });
        if (!picked) { return; }
        editor.executeEdits('nodu.clipboard-history',
            editor.getSelections().map(range => ({ range, text: picked.text, forceMoveMarkers: true })));
    }

    /** 剪切行 / 复制行: the full line(s) covering the selections, trailing
     * newline included; cut also deletes them. */
    private cutLines(cut: boolean): void {
        const editor = this.codeEditor();
        const model = editor?.getModel();
        if (!editor || !model) { return; }
        const eol = model.getEOL();
        const covered = new Set<number>();
        for (const selection of editor.getSelections()) {
            // A selection ending in column 1 does not cover that last line.
            const end = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber
                ? selection.endLineNumber - 1
                : selection.endLineNumber;
            for (let line = selection.startLineNumber; line <= end; line++) { covered.add(line); }
        }
        const lines = [...covered].sort((a, b) => a - b);
        const text = lines.map(line => model.getLineContent(line)).join(eol)
            + (lines[lines.length - 1] < model.getLineCount() ? eol : '');
        void navigator.clipboard.writeText(text);
        this.clipboardHistory.push(text);
        if (!cut) { return; }
        const last = model.getLineCount();
        editor.executeEdits('nodu.cut-line', lines.map(line => ({
            range: line < last
                ? new monaco.Range(line, 1, line + 1, 1)
                : new monaco.Range(line, 1, line, model.getLineMaxColumn(line)),
            text: null,
        })));
    }

    /** 切换折叠全部: fold all when any region is unfolded, else unfold all. */
    private async toggleFoldAll(): Promise<void> {
        const editor = this.codeEditor();
        if (!editor) { return; }
        const folding = editor.getContribution('editor.contrib.folding') as {
            getFoldingModel?: () => Promise<{ regions: { length: number; isCollapsed(index: number): boolean } } | null>;
        } | null;
        let unfold = false;
        try {
            const model = await folding?.getFoldingModel?.();
            if (model && model.regions.length > 0) {
                let allCollapsed = true;
                for (let i = 0; i < model.regions.length; i++) {
                    if (!model.regions.isCollapsed(i)) { allCollapsed = false; break; }
                }
                unfold = allCollapsed;
            }
        } catch { /* no folding model — fold-all is a harmless no-op */ }
        editor.trigger('nodu', unfold ? 'editor.unfoldAll' : 'editor.foldAll', null);
    }

    private bumpFont(delta: number): void {
        const current = this.preferences.get<number>('editor.fontSize', FONT_SIZE_DEFAULT) ?? FONT_SIZE_DEFAULT;
        const next = delta === 0 ? FONT_SIZE_DEFAULT : clampFontSize(current + delta);
        void this.preferences.set('editor.fontSize', next, PreferenceScope.User);
    }

    /** Print via a hidden iframe: escaped text in a monospace <pre>. */
    private print(): void {
        const editor = MonacoEditor.getCurrent(this.editors);
        const model = editor?.getControl().getModel();
        if (!editor || !model) { return; }
        const name = editor.uri?.path.base ?? 'untitled';
        const iframe = document.createElement('iframe');
        iframe.style.display = 'none';
        const cleanup = (): void => iframe.remove();
        iframe.onload = () => {
            try {
                iframe.contentWindow?.focus();
                iframe.contentWindow?.print();
            } finally {
                iframe.contentWindow?.addEventListener('afterprint', cleanup);
                setTimeout(cleanup, 60_000);
            }
        };
        iframe.srcdoc = printDocumentHtml(model.getValue(), name);
        document.body.appendChild(iframe);
    }
}
