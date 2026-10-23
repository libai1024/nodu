// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { CommandContribution, CommandRegistry, CommandService, Disposable, DisposableCollection, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { NoduTutorModel } from './nodu-tutor-model';
import { completedLines, ghostSuffix, reviewableLine, tutorMarkerLine } from '../common/tutor/tutor-guidance';
import { TutorBuffer } from '../common/tutor/tutor-ai-protocol';

export const TUTOR_MENU = ['nodu-ai-controls'];
export const TUTOR_COMMANDS = {
    openPanel: 'nodu.tutor.open-panel', togglePanel: 'nodu.tutor.toggle-panel', toggleHints: 'nodu.tutor.toggle-hints',
    revealStep: 'nodu.tutor.reveal-step', pause: 'nodu.tutor.pause', highlight: 'nodu.tutor.highlight', annotations: 'nodu.tutor.annotations', float: 'nodu.tutor.float', check: 'nodu.tutor.check',
} as const;
interface LineTask { decoration: string; text: string; status: 'pending' | 'ok' | 'needs-work' | 'context' | 'stale' | 'unavailable'; note: string; version?: number; }
let count = 0;
class TutorEditorController implements Disposable {
    private readonly disposables = new DisposableCollection();
    private readonly decorations: monaco.editor.IEditorDecorationsCollection;
    private readonly tasks = new Map<string, LineTask>();
    private before: string[];
    private composing = false;
    private line = 1;
    private changed = new Set<number>();
    private timer?: ReturnType<typeof setTimeout>;
    private processing = false;
    private disposed = false;
    private overlay?: monaco.editor.IOverlayWidget;
    private readonly id = `nodu.tutor.step.${++count}`;
    constructor(private readonly widget: EditorWidget, private readonly control: monaco.editor.IStandaloneCodeEditor,
        private readonly tutor: NoduTutorModel, private readonly active: () => boolean, private readonly openPanel: () => void) {
        this.decorations = control.createDecorationsCollection();
        this.before = control.getModel()?.getLinesContent() ?? [];
        this.disposables.push(control.onDidCompositionStart(() => { this.composing = true; }));
        this.disposables.push(control.onDidCompositionEnd(() => { this.composing = false; this.updateContext(); this.render(); }));
        this.disposables.push(control.onDidChangeModelContent(event => this.edit(event)));
        this.disposables.push(control.onDidChangeCursorPosition(event => {
            if (!this.composing && event.position.lineNumber !== this.line && this.changed.delete(this.line)) { this.enqueue(this.line); }
            this.line = event.position.lineNumber; this.updateContext(); this.render();
        }));
        this.disposables.push(control.onDidFocusEditorText(() => { this.updateContext(); this.render(); }));
        this.disposables.push(control.onDidLayoutChange(() => this.render()));
        // MonacoEditorModel is the document behind Theia's EditorWidget; it owns the save event.
        const document = MonacoEditor.get(widget)?.document;
        if (document) { this.disposables.push(document.onDidSaveModel(() => { const lines = [...this.changed]; this.changed.clear(); lines.forEach(n => this.enqueue(n)); })); }
        this.disposables.push(tutor.onDidChange(() => { this.render(); this.schedule(); }));
        this.disposables.push(control.onDidChangeModel(() => { this.clear(); this.before = control.getModel()?.getLinesContent() ?? []; this.updateContext(); this.render(); }));
        this.updateContext(); this.render();
    }
    private buffer(line = this.control.getPosition()?.lineNumber ?? 1): TutorBuffer | undefined {
        const model = this.control.getModel(), root = this.tutor.rootUri;
        const relative = root?.relative(this.widget.editor.uri)?.toString();
        if (!model || !relative || relative.startsWith('../') || !/\.(c|h|cpp|hpp|cc)$/i.test(relative) || model.getValueLength() > 32000) { return; }
        return { path: relative, text: model.getValue(), version: model.getVersionId(), line: Math.min(line, model.getLineCount()) };
    }
    private updateContext(): void { if (this.active()) { this.tutor.updateBuffer(this.buffer()); } }
    private edit(event: monaco.editor.IModelContentChangedEvent): void {
        const model = this.control.getModel(); if (!model) { return; }
        const after = model.getLinesContent();
        for (const task of this.tasks.values()) {
            const range = model.getDecorationRange(task.decoration);
            if (!range || model.getLineContent(range.startLineNumber).trim() !== task.text.trim()) { task.status = 'stale'; task.note = '代码已修改'; }
            else if (task.status !== 'pending') { task.status = 'stale'; task.note = '上下文已修改'; }
        }
        for (const change of event.changes) {
            this.changed.add(change.range.startLineNumber);
            if (!this.composing && !event.isUndoing && !event.isRedoing) {
                for (const line of completedLines(this.before, after, change.range.startLineNumber, change.range.endLineNumber, change.text)) { this.changed.delete(line); this.enqueue(line); }
            }
        }
        this.before = after; this.updateContext(); this.render();
    }
    private enabled(): boolean { return this.tutor.teaching && this.tutor.autoReview && !!this.tutor.provider?.configured && !!(this.tutor.plan || this.tutor.presentation?.answer.guidance); }
    private enqueuing = false;
    private enqueue(line: number): void {
        const model = this.control.getModel();
        // deltaDecorations flushes Monaco's queued cursor event synchronously, which would re-enter here
        // before the new task is stored and check the same line twice.
        if (this.enqueuing || !model || line < 1 || line > model.getLineCount() || !this.enabled() || this.composing || !this.active()) { return; }
        const text = model.getLineContent(line);
        if (!reviewableLine(text)) { return; }
        const existing = [...this.tasks.values()].find(t => model.getDecorationRange(t.decoration)?.startLineNumber === line);
        if (existing) { if (existing.text === text && ['pending','ok'].includes(existing.status)) { return; } existing.text = text; existing.status = 'pending'; existing.note = '待检查'; }
        else {
            if (this.tasks.size >= 20) {
                this.tutor.error = '待检查行已达 20 条，请先检查当前代码'; this.tutor.notify(); return;
            }
            this.enqueuing = true;
            let decoration: string;
            try { decoration = model.deltaDecorations([], [{ range: new monaco.Range(line, 1, line, 1), options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])[0]; }
            finally { this.enqueuing = false; }
            this.tasks.set(decoration, { decoration, text, status: 'pending', note: '待检查' });
        }
        this.schedule();
    }
    private schedule(): void {
        if (this.timer) { clearTimeout(this.timer); }
        this.timer = setTimeout(() => { this.timer = undefined; void this.drain(); }, 350);
    }
    private async drain(): Promise<void> {
        if (this.processing || this.disposed || !this.enabled() || this.composing || this.tutor.reviewing || !this.active()) { return; }
        const task = [...this.tasks.values()].find(t => t.status === 'pending');
        const model = this.control.getModel(); if (!task || !model) { return; }
        const line = model.getDecorationRange(task.decoration)?.startLineNumber;
        const buffer = line && this.buffer(line); if (!buffer) { this.tasks.delete(task.decoration); return; }
        this.processing = true; task.note = '检查中'; this.render();
        const epoch = this.tutor.epoch;
        try {
            const result = await this.tutor.send('line', buffer);
            if (this.disposed || epoch !== this.tutor.epoch) { task.status = 'stale'; task.note = '检查已取消'; return; }
            if (model.getVersionId() !== buffer.version) { task.status = 'stale'; task.note = '上下文已修改'; return; }
            if (result?.ok && result.answer.review) {
                task.status = result.answer.review.verdict; task.note = `${task.status === 'ok' ? 'AI 已检查' : task.status === 'context' ? '待补上下文' : '需要修改'}：${result.answer.review.note}`; task.version = buffer.version;
            } else { task.status = 'unavailable'; task.note = result && !result.ok ? result.error : 'AI 检查未完成'; }
        } finally { this.processing = false; this.render(); this.schedule(); }
    }
    private render(): void {
        const model = this.control.getModel();
        if (!model || !this.tutor.teaching) { this.decorations.clear(); this.removeOverlay(); return; }
        const buffer = this.buffer(); if (!buffer) { this.decorations.clear(); this.removeOverlay(); return; }
        const decorations: monaco.editor.IModelDeltaDecoration[] = [];
        const position = this.control.getPosition();
        const step = this.tutor.currentStep();
        const presentation = this.tutor.presentation;
        const valid = presentation?.buffer.path === buffer.path && presentation.buffer.version === buffer.version;
        if (valid && (this.tutor.highlightsVisible || this.tutor.annotationsVisible)) {
            for (const a of presentation.answer.annotations) {
                decorations.push({ range: new monaco.Range(a.startLine, 1, a.endLine, model.getLineMaxColumn(a.endLine)), options: {
                    isWholeLine: true, className: this.tutor.highlightsVisible ? 'nodu-tutor-highlight' : undefined,
                    hoverMessage: this.tutor.annotationsVisible ? { value: a.note.replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&'), isTrusted: false } : undefined,
                } });
            }
        }
        if (position && this.tutor.hintsVisible && !this.composing) {
            let candidate: string | undefined;
            if (valid && presentation.answer.guidance?.anchorLine === position.lineNumber) { candidate = presentation.answer.guidance.lines[0]; }
            if (!candidate) {
                for (const fragment of step?.guidance ?? []) {
                    const anchor = step?.anchors.find(a => a.id === fragment.anchorId && a.path === buffer.path);
                    const base = anchor && tutorMarkerLine(model.getLinesContent(), anchor);
                    if (!base || fragment.requiredSymbols.some(s => !new RegExp(`\\b${s}\\b`).test(buffer.text))) { continue; }
                    const index = position.lineNumber - base - 1;
                    if (index < 0 || index >= fragment.lines.length) { continue; }
                    // Advancing the lesson requires a semantic result for every prior line.
                    const prior = [...this.tasks.values()];
                    if (index && !fragment.lines.slice(0, index).every((_, i) => prior.some(t => t.status === 'ok' && model.getDecorationRange(t.decoration)?.startLineNumber === base + i + 1))) { continue; }
                    candidate = fragment.lines[index]; break;
                }
            }
            const typed = model.getLineContent(position.lineNumber);
            const suffix = candidate && position.column === typed.length + 1 ? ghostSuffix(typed, candidate) : undefined;
            if (suffix) { decorations.push({ range: new monaco.Range(position.lineNumber, typed.length + 1, position.lineNumber, typed.length + 1), options: {
                after: { content: suffix, inlineClassName: 'nodu-tutor-ghost-text', cursorStops: monaco.editor.InjectedTextCursorStops.None }, showIfCollapsed: true,
            } }); }
        }
        for (const task of this.tasks.values()) {
            const range = model.getDecorationRange(task.decoration); if (!range) { continue; }
            decorations.push({ range, options: { isWholeLine: true, linesDecorationsClassName: task.status === 'ok' ? 'nodu-tutor-line-ok' : task.status === 'needs-work' ? 'nodu-tutor-line-warn' : 'nodu-tutor-line-pending',
                hoverMessage: { value: task.note.replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&'), isTrusted: false } } });
        }
        this.decorations.set(decorations);
        this.removeOverlay();
        if (this.tutor.floatVisible && step) {
            const node = document.createElement('div'); node.className = 'nodu-tutor-step-float';
            const title = document.createElement('span'); title.textContent = step.title;
            const button = document.createElement('button'); button.className = 'theia-button secondary'; button.textContent = '检查'; button.disabled = !!this.tutor.busy;
            button.onclick = () => { this.updateContext(); void this.tutor.send('step'); };
            const more = document.createElement('button'); more.className = 'scope-text-button'; more.textContent = '步骤'; more.onclick = this.openPanel;
            node.append(title, button, more);
            if (this.control.getLayoutInfo().width < 620) { node.style.maxWidth = 'calc(100% - 24px)'; }
            this.overlay = { getId: () => this.id, getDomNode: () => node, getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }) };
            this.control.addOverlayWidget(this.overlay);
        }
    }
    private removeOverlay(): void { if (this.overlay) { this.control.removeOverlayWidget(this.overlay); this.overlay = undefined; } }
    private clear(): void { this.control.getModel()?.deltaDecorations([...this.tasks.keys()], []); this.tasks.clear(); this.changed.clear(); }
    dispose(): void { this.disposed = true; if (this.timer) { clearTimeout(this.timer); } this.clear(); this.decorations.clear(); this.removeOverlay(); this.disposables.dispose(); }
}
@injectable()
export class NoduTutorHintsContribution implements FrontendApplicationContribution, CommandContribution, KeybindingContribution, MenuContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    private readonly disposables = new DisposableCollection();
    private readonly controllers = new Map<EditorWidget, TutorEditorController>();
    onStart(): void {
        this.editors.all.forEach(widget => this.attach(widget));
        this.disposables.push(this.editors.onCreated(widget => this.attach(widget)));
    }
    onStop(): void { this.controllers.forEach(c => c.dispose()); this.controllers.clear(); this.disposables.dispose(); }
    private attach(widget: EditorWidget): void {
        const control = MonacoEditor.get(widget)?.getControl(); if (!control || this.controllers.has(widget)) { return; }
        const controller = new TutorEditorController(widget, control, this.tutor, () => this.editors.currentEditor === widget, () => void this.commands.executeCommand(TUTOR_COMMANDS.openPanel));
        this.controllers.set(widget, controller); widget.disposed.connect(() => { controller.dispose(); this.controllers.delete(widget); });
    }
    registerCommands(commands: CommandRegistry): void {
        const toggle = (id: string, label: string, key: 'hintsVisible' | 'highlightsVisible' | 'annotationsVisible' | 'floatVisible'): void => {
            commands.registerCommand({ id, label, category: 'Nodu' }, { execute: () => this.tutor.setDisplay(key, !this.tutor[key]), isToggled: () => this.tutor[key] });
        };
        toggle(TUTOR_COMMANDS.toggleHints, '代码虚影', 'hintsVisible'); toggle(TUTOR_COMMANDS.highlight, '代码高光', 'highlightsVisible');
        toggle(TUTOR_COMMANDS.annotations, '浮动批注', 'annotationsVisible'); toggle(TUTOR_COMMANDS.float, '步骤浮窗', 'floatVisible');
        commands.registerCommand({ id: TUTOR_COMMANDS.pause, label: '暂停教学', category: 'Nodu' }, { execute: () => this.tutor.setPaused(!this.tutor.paused), isToggled: () => this.tutor.paused });
        commands.registerCommand({ id: TUTOR_COMMANDS.check, label: '检查本步', category: 'Nodu' }, { execute: () => this.tutor.send('step'), isEnabled: () => this.tutor.teaching && !!this.tutor.buffer && !this.tutor.busy });
        commands.registerCommand({ id: TUTOR_COMMANDS.revealStep, label: '定位教学代码', category: 'Nodu' }, { execute: async () => {
            const step = this.tutor.currentStep(), anchor = step?.anchors[0]; if (!anchor || !this.tutor.rootUri) { return; }
            const widget = await this.editors.open(this.tutor.rootUri.resolve(anchor.path), { mode: 'activate' });
            const control = MonacoEditor.get(widget)?.getControl(), model = control?.getModel();
            const line = model && tutorMarkerLine(model.getLinesContent(), anchor);
            if (control && line) { control.setPosition({ lineNumber: Math.min(line + 1, model!.getLineCount()), column: 1 }); control.revealLineInCenterIfOutsideViewport(line); control.focus(); }
        } });
    }
    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: TUTOR_COMMANDS.togglePanel, keybinding: 'ctrlcmd+shift+a' });
        keys.registerKeybinding({ command: TUTOR_COMMANDS.toggleHints, keybinding: 'ctrlcmd+k h' });
        keys.registerKeybinding({ command: TUTOR_COMMANDS.check, keybinding: 'ctrlcmd+alt+enter', when: 'editorTextFocus' });
    }
    registerMenus(menus: MenuModelRegistry): void {
        for (const [i, command] of [TUTOR_COMMANDS.toggleHints,TUTOR_COMMANDS.highlight,TUTOR_COMMANDS.annotations,TUTOR_COMMANDS.float].entries()) { menus.registerMenuAction([...TUTOR_MENU, 'display'], { commandId: command, order: String(i) }); }
        menus.registerMenuAction([...TUTOR_MENU, 'pause'], { commandId: TUTOR_COMMANDS.pause });
    }
}
