// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { CommonCommands, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { CommandContribution, CommandRegistry, Disposable } from '@theia/core/lib/common';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { NavigatorFileClipboard } from '@theia/navigator/lib/browser/navigator-file-clipboard';
import { TUTOR_CONTEXT_LIMIT, tutorSelection, validateTutorContexts } from '../common/tutor/tutor-context';
import type { TutorContext } from '../common/tutor/tutor-context';
import { NoduTutorModel } from './nodu-tutor-model';

export const TUTOR_SELECTION_MIME = 'application/x-nodu-code-selection';
const FILE_DRAG_MIME = 'theia-editor-dnd';
const normalize = (text: string): string => text.replace(/\r\n?/g, '\n');
interface CopiedSelection { schema: 1; uri: string; plain: string; text: string; version: number; startLine: number; endLine: number; }

/** Clipboard metadata records the copy-time source; current editor selection is never guessed at paste time. */
@injectable()
export class NoduTutorContextTransfer implements FrontendApplicationContribution, CommandContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(NavigatorFileClipboard) protected readonly fileClipboard!: NavigatorFileClipboard;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    private copied?: CopiedSelection;
    private clipboardChange?: Disposable;
    private clipboardGeneration = 0;
    private readonly clearCopy = (): void => { this.copied = undefined; ++this.clipboardGeneration; };

    onStart(): void {
        document.addEventListener('copy', this.captureSelection, true);
        document.addEventListener('cut', this.captureSelection, true);
        window.addEventListener('blur', this.clearCopy);
        this.clipboardChange = this.clipboard.onDidWriteText?.(this.clearCopy);
    }
    onStop(): void {
        document.removeEventListener('copy', this.captureSelection, true);
        document.removeEventListener('cut', this.captureSelection, true);
        window.removeEventListener('blur', this.clearCopy); this.clipboardChange?.dispose(); this.clearCopy();
    }
    protected readonly captureSelection = (event: ClipboardEvent): void => {
        this.clearCopy();
        const widget = this.editors.currentEditor, editor = widget && MonacoEditor.get(widget)?.getControl();
        const model = editor?.getModel(), ranges = editor?.getSelections();
        if (!widget || !editor || !model || !event.clipboardData || !editor.hasTextFocus() || !(event.target instanceof Node)
            || !editor.getDomNode()?.contains(event.target) || ranges?.length !== 1 || ranges[0].isEmpty()) { return; }
        const range = ranges[0], plain = model.getValueInRange(range);
        if (!plain || new TextEncoder().encode(plain).byteLength > TUTOR_CONTEXT_LIMIT) { return; }
        const selection: CopiedSelection = { schema: 1, uri: widget.editor.uri.toString(), plain, version: model.getVersionId(),
            ...tutorSelection(plain, range.startLineNumber, range.endLineNumber, range.endColumn) };
        this.copied = selection;
        try { event.clipboardData.setData(TUTOR_SELECTION_MIME, JSON.stringify(selection)); } catch { /* Native text copying remains available. */ }
    };

    registerCommands(registry: CommandRegistry): void {
        // Theia's Electron paste command inserts text directly, bypassing DOM paste events.
        registry.registerHandler(CommonCommands.PASTE.id, {
            isEnabled: () => !!this.composer(), execute: () => this.pasteIntoComposer(),
        });
        // Monaco also handles Electron's clipboard fallback and EditContext here.
        // Raw execCommand can delete the selection without writing the clipboard.
        for (const [command, action] of [[CommonCommands.COPY, 'copy'], [CommonCommands.CUT, 'cut']] as const) {
            registry.registerHandler(command.id, {
                isEnabled: () => {
                    const widget = this.editors.currentEditor, editor = widget && MonacoEditor.get(widget)?.getControl();
                    return !!editor?.hasTextFocus() && !!editor.getDomNode()?.contains(document.activeElement);
                },
                execute: () => {
                    const widget = this.editors.currentEditor, editor = widget && MonacoEditor.get(widget)?.getControl();
                    editor?.trigger('nodu.editor-clipboard', action === 'cut' ? 'editor.action.clipboardCutAction' : 'editor.action.clipboardCopyAction', null);
                },
            });
        }
    }
    private composer(): HTMLTextAreaElement | undefined {
        const active = document.activeElement;
        return active instanceof HTMLTextAreaElement && active.closest('.nodu-ai-composer') ? active : undefined;
    }
    private async pasteIntoComposer(): Promise<void> {
        const target = this.composer(), tutor = this.tutor, generation = this.clipboardGeneration;
        const identity = [tutor.workspaceId, tutor.mode, tutor.epoch, tutor.activeConversationId].join(':');
        const current = (): boolean => target === this.composer() && generation === this.clipboardGeneration && identity === [tutor.workspaceId, tutor.mode, tutor.epoch, tutor.activeConversationId].join(':');
        if (!target) { return; }
        const finish = tutor.beginContextTransfer();
        try {
            const plain = await this.clipboard.readText();
            if (!current()) { return; }
            const data = { getData: (type: string) => type === TUTOR_SELECTION_MIME && this.copied ? JSON.stringify(this.copied) : type === 'text/plain' ? plain : '' };
            if (!this.pasteData(data, tutor) && plain) { document.execCommand('insertText', false, plain); }
        } catch (error) { if (current()) { this.fail(tutor, error); } }
        finally { finish(); }
    }

    acceptsDrop(data: DataTransfer): boolean {
        return Array.from(data.types).some(type => [FILE_DRAG_MIME, 'text/uri-list', 'Files'].includes(type));
    }
    paste(event: ClipboardEvent, tutor: NoduTutorModel): boolean {
        const data = event.clipboardData;
        if (!data) { return false; }
        if (!this.pasteData(data, tutor)) { return false; }
        event.preventDefault(); event.stopPropagation(); return true;
    }
    private pasteData(data: Pick<DataTransfer, 'getData'>, tutor: NoduTutorModel): boolean {
        const plain = data.getData('text/plain'), context = this.copiedSelection(data, tutor, plain);
        if (context) {
            void tutor.addContextSnapshot(context); return true;
        }
        // Navigator copies are plain-text URIs. Require both provenance and an exact clipboard match.
        if (plain && plain === this.fileClipboard.get()) {
            const uris = plain.split(/\r?\n/).filter(Boolean);
            if (uris.length && uris.every(uri => uri.startsWith('file:'))) {
                void this.attachFiles(uris, tutor); return true;
            }
        }
        return false;
    }
    drop(event: DragEvent, tutor: NoduTutorModel): boolean {
        const data = event.dataTransfer;
        if (!data || !this.acceptsDrop(data)) { return false; }
        event.preventDefault(); event.stopPropagation();
        try {
            const raw = data.getData(FILE_DRAG_MIME) || data.getData('text/uri-list');
            let uris = raw.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
            if (!uris.length && data.files.length) {
                const bridge = (window as Window & { electronTheiaCore?: { getPathForFile(file: File): string } }).electronTheiaCore;
                uris = Array.from(data.files).map(file => {
                    const path = bridge?.getPathForFile(file);
                    if (!path) { throw new Error('无法识别文件路径，请从工程文件列表拖入'); }
                    return FileUri.create(path.replace(/\\/g, '/')).toString();
                });
            }
            if (!uris.length) { throw new Error('未找到可引用的文件'); }
            void this.attachFiles(uris, tutor);
        } catch (error) { this.fail(tutor, error); }
        return true;
    }
    private relativePath(uri: string, tutor: NoduTutorModel): string {
        const root = tutor.rootUri, source = new URI(uri);
        const relative = root?.relative(source)?.toString();
        if (!root || source.scheme !== 'file' || source.authority !== root.authority || source.query || source.fragment || !relative
            || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) {
            throw new Error('只能引用当前工程内的文件');
        }
        return relative;
    }
    private copiedSelection(data: Pick<DataTransfer, 'getData'>, tutor: NoduTutorModel, plain: string): TutorContext | undefined {
        try {
            const raw = data.getData(TUTOR_SELECTION_MIME);
            if (!raw || raw.length > TUTOR_CONTEXT_LIMIT * 4) { return; }
            const value = JSON.parse(raw) as CopiedSelection;
            if (value.schema !== 1 || typeof value.uri !== 'string' || typeof value.plain !== 'string' || normalize(plain) !== normalize(value.plain)) { return; }
            const context: TutorContext = { kind: 'selection', path: this.relativePath(value.uri, tutor), text: value.text,
                version: value.version, startLine: value.startLine, endLine: value.endLine };
            return validateTutorContexts([context], tutor.mode)[0];
        } catch { return; }
    }
    private async attachFiles(uris: string[], tutor: NoduTutorModel): Promise<void> {
        const workspace = tutor.workspaceId, conversation = tutor.activeConversationId, mode = tutor.mode, epoch = tutor.epoch;
        const current = (): boolean => workspace === tutor.workspaceId && conversation === tutor.activeConversationId && mode === tutor.mode && epoch === tutor.epoch && !tutor.conversationLoading;
        try {
            const paths = [...new Set(uris.map(uri => this.relativePath(uri, tutor)))];
            if (paths.length > 6) { throw new Error('最多附带 6 项上下文'); }
            for (const path of paths) {
                if (!current()) { return; }
                const uri = tutor.rootUri!.resolve(path), widget = this.editors.all.find(editor => editor.editor.uri.isEqual(uri));
                const model = widget && MonacoEditor.get(widget)?.getControl().getModel();
                // Use the open document, including unsaved edits, rather than an older disk copy.
                const text = model && !model.isDisposed() ? normalize(model.getValue()) : undefined;
                const added = text !== undefined ? await tutor.addContextSnapshot({ kind: 'file', path, text, version: model!.getVersionId(), startLine: 1, endLine: text.split('\n').length })
                    : await tutor.addContextFile(path);
                if (!added) { return; }
            }
        } catch (error) { if (current()) { this.fail(tutor, error); } }
    }
    private fail(tutor: NoduTutorModel, error: unknown): void {
        tutor.contextError = error instanceof Error ? error.message : '无法引用文件'; tutor.notify();
    }
}
