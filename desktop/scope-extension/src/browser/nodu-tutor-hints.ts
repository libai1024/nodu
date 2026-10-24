// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { TutorTaskWindow } from './nodu-tutor-task-window';
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { CommandContribution, CommandRegistry, CommandService, Disposable, DisposableCollection, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { ApplicationShell, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { NoduTutorModel } from './nodu-tutor-model';
import { completedLines, pendingReviewCount, reviewableLine, tutorMarkerLine, traceReference } from '../common/tutor/tutor-guidance';
import { TutorBuffer } from '../common/tutor/tutor-ai-protocol';

export const TUTOR_MENU = ['nodu-ai-controls'];
export const TUTOR_COMMANDS = {
    openReference: 'nodu.tutor.open-reference',
    prepareGoal: 'nodu.tutor.prepare-goal',
    openPanel: 'nodu.tutor.open-panel', togglePanel: 'nodu.tutor.toggle-panel', toggleHints: 'nodu.tutor.toggle-hints',
    revealStep: 'nodu.tutor.reveal-step', guidance: 'nodu.tutor.guidance', settings: 'nodu.tutor.settings', highlight: 'nodu.tutor.highlight', annotations: 'nodu.tutor.annotations', float: 'nodu.tutor.float', check: 'nodu.tutor.check',
} as const;
interface LineTask { decoration: string; text: string; status: 'pending' | 'ok' | 'needs-work' | 'context' | 'stale' | 'unavailable'; note: string; version?: number; guided?: boolean; }
interface TraceReference { candidate: string; typed: string; line: number; block?: { lines: readonly string[]; current: number }; }
class TutorEditorController implements Disposable {
    private readonly disposables = new DisposableCollection();
    private readonly decorations: monaco.editor.IEditorDecorationsCollection;
    private readonly tasks = new Map<string, LineTask>();
    private before: string[];
    private taskHistoryKey?: string;
    private historyTimer?: ReturnType<typeof setTimeout>;
    private composing = false;
    private line = 1;
    private changed = new Set<number>();
    private timer?: ReturnType<typeof setTimeout>;
    private processing = false;
    private disposed = false;
    private tracingOptions?: monaco.editor.IEditorOptions;
    private traceZone?: { id: string; zone: monaco.editor.IViewZone; content: HTMLDivElement; icon: HTMLElement; signature: string };
    constructor(private readonly widget: EditorWidget, private readonly control: monaco.editor.IStandaloneCodeEditor,
        private readonly tutor: NoduTutorModel, private readonly active: () => boolean) {
        this.decorations = control.createDecorationsCollection();
        this.before = control.getModel()?.getLinesContent() ?? [];
        this.disposables.push(control.onDidCompositionStart(() => { this.composing = true; }));
        this.disposables.push(control.onDidCompositionEnd(() => { this.composing = false; this.updateContext(); this.render(); }));
        this.disposables.push(control.onDidChangeModelContent(event => this.edit(event)));
        this.disposables.push(control.onDidChangeCursorPosition(event => {
            if (!this.composing && event.position.lineNumber !== this.line && this.changed.delete(this.line)) { this.enqueue(this.line); }
            this.line = event.position.lineNumber; this.updateContext(); this.render();
        }));
        if (control.onDidChangeCursorSelection) { this.disposables.push(control.onDidChangeCursorSelection(() => this.updateContext())); }
        this.disposables.push(control.onDidFocusEditorText(() => { this.updateContext(); this.render(); }));
        this.disposables.push(control.onDidLayoutChange(() => this.render()));
        // MonacoEditorModel is the document behind Theia's EditorWidget; it owns the save event.
        const document = MonacoEditor.get(widget)?.document;
        if (document) { this.disposables.push(document.onDidSaveModel(() => { const lines = [...this.changed]; this.changed.clear(); lines.forEach(n => this.enqueue(n)); })); }
        this.disposables.push(tutor.onDidChange(() => this.tutorChanged()));
        this.disposables.push(control.onWillChangeModel(() => { this.saveHistory(); this.renderTrace(); this.setTracing(false); }));
        this.disposables.push(control.onDidChangeModel(() => { this.clear(); this.restoreHistory(); this.before = control.getModel()?.getLinesContent() ?? []; this.updateContext(); this.render(); }));
        this.restoreHistory(); this.updateContext(); this.render();
    }
    private buffer(line = this.control.getPosition()?.lineNumber ?? 1, chat = false): TutorBuffer | undefined {
        const model = this.control.getModel(), root = this.tutor.rootUri;
        const relative = root?.relative(this.widget.editor.uri)?.toString();
        if (!model || model.isDisposed() || !relative || relative.startsWith('../') || !(/\.(c|h|cpp|hpp|cc)$/i.test(relative) || chat && this.tutor.mode === 'ask' && /\.py$/i.test(relative)) || model.getValueLength() > 32000) { return; }
        const range = this.control.getSelection?.();
        const selection = range && !range.isEmpty() ? { startLine: range.startLineNumber, endLine: range.endLineNumber, text: model.getValueInRange(range) } : undefined;
        return { path: relative, text: model.getValue(), version: model.getVersionId(), line: Math.min(line, model.getLineCount()), ...(selection ? { selection } : {}) };
    }
    private historyKey(): string | undefined {
        const buffer = this.buffer(), root = this.tutor.rootUri;
        if (!buffer || !root) { return; }
        return JSON.stringify([root.toString(), this.tutor.plan?.contentHash, this.tutor.goalState.goal, this.tutor.goalState.steps, this.tutor.goalState.target, buffer.path]);
    }
    private queueHistory(): void {
        if (this.historyTimer) { clearTimeout(this.historyTimer); }
        this.historyTimer = setTimeout(() => { this.historyTimer = undefined; if (!this.disposed) { this.saveHistory(); } }, 300);
    }
    private saveHistory(): void {
        const key = this.historyKey(), model = this.control.getModel();
        if (!key || !model || model.isDisposed() || key !== this.taskHistoryKey) { return; }
        const lines = [...this.tasks.values()].flatMap(task => {
            const line = model.getDecorationRange(task.decoration)?.startLineNumber;
            return line ? [{ line, text: model.getLineContent(line), status: task.status, note: task.note, guided: task.guided }] : [];
        });
        this.tutor.lineHistory.save(key, model.getValue(), lines);
    }
    private restoreHistory(): void {
        const key = this.historyKey(), model = this.control.getModel();
        if (!key || !model) { return; }
        this.taskHistoryKey = key;
        for (const task of this.tutor.lineHistory.restore(key, model.getValue())) {
            const decoration = model.deltaDecorations([], [{ range: new monaco.Range(task.line, 1, task.line, 1),
                options: { stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges } }])[0];
            this.tasks.set(decoration, { ...task, decoration, version: model.getVersionId() });
        }
    }
    private updateContext(): void { if (this.active()) { this.tutor.updateBuffer(this.buffer(undefined, true)); } }
    private tutorChanged(): void {
        if (this.disposed) { return; }
        // Workspace authorization can finish after the editor was restored. Publish
        // the active buffer before the first goal, without waiting for a focus event.
        this.updateContext();
        if (this.taskHistoryKey !== this.historyKey()) { this.clear(); this.restoreHistory(); }
        this.render(); this.schedule();
    }
    private edit(event: monaco.editor.IModelContentChangedEvent): void {
        const model = this.control.getModel(); if (!model) { return; }
        const after = model.getLinesContent();
        for (const task of this.tasks.values()) {
            const range = model.getDecorationRange(task.decoration);
            if (!range || model.getLineContent(range.startLineNumber).trim() !== task.text.trim()) { task.status = 'stale'; task.guided = false; task.note = '代码已修改'; }
            else if (task.status !== 'pending') { task.status = 'stale'; task.note = '上下文已修改'; }
        }
        for (const change of event.changes) {
            this.changed.add(change.range.startLineNumber);
            if (!this.composing && !event.isUndoing && !event.isRedoing) {
                for (const line of completedLines(this.before, after, change.range.startLineNumber, change.range.endLineNumber, change.text)) { this.changed.delete(line); this.enqueue(line); }
            }
        }
        this.before = after; this.updateContext(); this.render(); this.queueHistory();
    }
    private enabled(): boolean { return this.tutor.teaching && this.tutor.autoReview && this.tutor.configured && !!(this.tutor.plan || this.tutor.guidance); }
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
            if (pendingReviewCount(this.tasks.values()) >= 20) {
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
        const current = (): boolean => !this.disposed && this.control.getModel() === model && !model.isDisposed() && this.tasks.get(task.decoration) === task;
        try {
            const result = await this.tutor.send('line', buffer);
            if (!current()) { return; }
            if (epoch !== this.tutor.epoch) { task.status = 'stale'; task.note = '检查已取消'; return; }
            if (model.getVersionId() !== buffer.version) { task.status = 'stale'; task.note = '上下文已修改'; return; }
            if (result?.ok && result.answer.review) {
                task.status = result.answer.review.verdict; task.guided = task.status === 'ok'; task.note = `${task.status === 'ok' ? 'AI 已检查' : task.status === 'context' ? '待补上下文' : '需要修改'}：${result.answer.review.note}`; task.version = buffer.version;
            } else { task.status = 'unavailable'; task.note = result && !result.ok ? result.error : 'AI 检查未完成'; }
        } catch {
            if (current()) { task.status = 'unavailable'; task.note = 'AI 检查未完成'; }
        } finally {
            this.processing = false;
            if (!this.disposed) { this.render(); this.schedule(); this.queueHistory(); }
            if (current() && this.active() && model.getVersionId() === buffer.version && epoch === this.tutor.epoch) {
                const reviewed = [...this.tasks.values()].flatMap(t => {
                    const row = model.getDecorationRange(t.decoration)?.startLineNumber;
                    return t.guided && row && t.text.trim() === model.getLineContent(row).trim() ? [row] : [];
                });
                this.tutor.autoCheckFragment(reviewed);
            }
        }
    }
    private render(): void {
        const model = this.control.getModel();
        if (!model || model.isDisposed() || !this.tutor.teaching) { this.setTracing(false); this.renderTrace(); this.decorations.clear(); return; }
        const buffer = this.buffer(); if (!buffer) { this.setTracing(false); this.renderTrace(); this.decorations.clear(); return; }
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
        let tracing = false;
        let reference: TraceReference | undefined;
        if (this.tutor.hintsVisible) {
            const prior = [...this.tasks.values()];
            const complete = (line: number, expected: string): boolean => {
                const actual = model.getLineContent(line).trim();
                return actual === expected.trim() || prior.some(t => t.guided && t.text.trim() === actual
                    && model.getDecorationRange(t.decoration)?.startLineNumber === line);
            };
            const at = (start: number, lines: readonly string[], available: number): void => {
                if (start < 1 || start > model.getLineCount() || !lines.length) { return; }
                const count = Math.max(1, Math.min(available, lines.length, model.getLineCount() - start + 1));
                let index = 0;
                while (index < count - 1 && complete(start + index, lines[index])) { index++; }
                const inputLine = start + index;
                reference = { candidate: lines[index], typed: model.getLineContent(inputLine), line: start + count - 1,
                    ...(lines.length > 1 ? { block: { lines, current: index } } : {}) };
                // Focus controls typing aids, never the existence or location of the reference.
                tracing = !this.composing && this.active() && position?.lineNumber === inputLine;
            };
            const guidance = this.tutor.guidance;
            if (guidance?.source.path === buffer.path) {
                const inserted = model.getLineCount() - guidance.source.text.split('\n').length;
                at(guidance.anchorLine, guidance.lines, inserted + 1);
            }
            if (!reference) {
                for (const fragment of step?.guidance ?? []) {
                    const anchor = step?.anchors.find(a => a.id === fragment.anchorId && a.path === buffer.path);
                    const base = anchor && tutorMarkerLine(model.getLinesContent(), anchor);
                    if (!base || fragment.requiredSymbols.some(s => !new RegExp(`\\b${s}\\b`).test(buffer.text))) { continue; }
                    let available = 1;
                    while (available < fragment.lines.length && base + available < model.getLineCount()
                        && complete(base + available, fragment.lines[available - 1])) { available++; }
                    at(base + 1, fragment.lines, available);
                    if (reference) { break; }
                }
            }
        }
        this.setTracing(tracing);
        this.renderTrace(reference);
        for (const task of this.tasks.values()) {
            const range = model.getDecorationRange(task.decoration); if (!range) { continue; }
            decorations.push({ range, options: { isWholeLine: true, linesDecorationsClassName: task.status === 'ok' ? 'nodu-tutor-line-ok' : task.status === 'needs-work' ? 'nodu-tutor-line-warn' : 'nodu-tutor-line-pending',
                hoverMessage: { value: task.note.replace(/[\\`*_{}\[\]()#+.!<>]/g, '\\$&'), isTrusted: false } } });
        }
        this.decorations.set(decorations);
    }
    private renderTrace(reference?: TraceReference): void {
        if (!reference) {
            if (this.traceZone) {
                const id = this.traceZone.id; this.traceZone = undefined;
                this.control.changeViewZones(accessor => accessor.removeZone(id));
            }
            return;
        }
        const layout = this.control.getLayoutInfo();
        const width = Math.max(80, layout.contentWidth - 20);
        const font = this.control.getOption(monaco.editor.EditorOption.fontInfo);
        const lineHeight = this.control.getOption(monaco.editor.EditorOption.lineHeight);
        const tabSize = this.control.getModel()?.getOptions().tabSize ?? 4;
        const signature = JSON.stringify([reference, width, layout.lineNumbersLeft, layout.lineNumbersWidth, font.fontFamily, font.fontSize, font.fontWeight, font.letterSpacing, lineHeight, tabSize]);
        if (this.traceZone?.signature === signature) { return; }
        if (!this.traceZone) {
            const content = document.createElement('div'); content.className = 'nodu-tutor-trace-reference';
            content.setAttribute('role', 'note'); content.setAttribute('aria-label', 'AI 代码范字');
            const domNode = document.createElement('div'); domNode.append(content);
            const marginDomNode = document.createElement('div'); marginDomNode.className = 'nodu-tutor-trace-margin'; marginDomNode.setAttribute('aria-hidden', 'true');
            const icon = document.createElement('i'); icon.className = 'codicon codicon-sparkle'; marginDomNode.append(icon);
            const zone: monaco.editor.IViewZone = { afterLineNumber: reference.line, heightInPx: lineHeight + 14, domNode, marginDomNode, suppressMouseDown: true };
            let id = '';
            this.control.changeViewZones(accessor => { id = accessor.addZone(zone); });
            this.traceZone = { id, zone, content, icon, signature: '' };
        }
        const { content, icon, zone, id } = this.traceZone;
        this.traceZone.signature = signature;
        this.control.applyFontInfo(content); content.style.width = `${width}px`; content.style.tabSize = String(tabSize);
        icon.style.left = `${layout.lineNumbersLeft}px`; icon.style.width = `${layout.lineNumbersWidth}px`;
        icon.style.height = `${lineHeight}px`; icon.style.fontSize = `${Math.min(16, font.fontSize)}px`;
        content.replaceChildren();
        const lines = reference.block?.lines ?? [reference.candidate], current = reference.block?.current ?? 0;
        lines.forEach((line, index) => {
            const parts = index === current ? traceReference(reference.typed, line) : [{ text: line, state: 'pending' }];
            for (const part of parts) {
                const span = document.createElement('span'); span.className = `nodu-tutor-trace-${part.state}`;
                span.textContent = part.text; content.append(span);
            }
            if (index < lines.length - 1) { const newline = document.createElement('span'); newline.textContent = '\n'; content.append(newline); }
        });
        zone.afterLineNumber = reference.line;
        // scrollHeight includes padding, but not the two one-pixel separators.
        zone.heightInPx = Math.max(lineHeight * lines.length + 14, content.scrollHeight + 2);
        this.control.changeViewZones(accessor => accessor.layoutZone(id));
    }
    private setTracing(active: boolean): void {
        if (active && !this.tracingOptions) {
            const option = monaco.editor.EditorOption;
            this.tracingOptions = {
                quickSuggestions: this.control.getOption(option.quickSuggestions),
                suggestOnTriggerCharacters: this.control.getOption(option.suggestOnTriggerCharacters),
                inlineSuggest: this.control.getOption(option.inlineSuggest),
                autoClosingBrackets: this.control.getOption(option.autoClosingBrackets),
                autoClosingQuotes: this.control.getOption(option.autoClosingQuotes),
                autoSurround: this.control.getOption(option.autoSurround),
            };
            this.control.updateOptions({ quickSuggestions: false, suggestOnTriggerCharacters: false, inlineSuggest: { enabled: false },
                autoClosingBrackets: 'never', autoClosingQuotes: 'never', autoSurround: 'never' });
        } else if (!active && this.tracingOptions) {
            const options = this.tracingOptions; this.tracingOptions = undefined;
            this.control.updateOptions(options);
        }
    }
    private clear(): void {
        const model = this.control.getModel();
        if (model && !model.isDisposed()) { model.deltaDecorations([...this.tasks.keys()], []); }
        this.tasks.clear(); this.changed.clear();
    }
    dispose(): void { if (this.historyTimer) { clearTimeout(this.historyTimer); } this.saveHistory(); this.disposed = true; if (this.timer) { clearTimeout(this.timer); } this.setTracing(false); this.renderTrace(); this.clear(); this.decorations.clear(); this.disposables.dispose(); }
}
@injectable()
export class NoduTutorHintsContribution implements FrontendApplicationContribution, CommandContribution, KeybindingContribution, MenuContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    private readonly disposables = new DisposableCollection();
    private readonly controllers = new Map<EditorWidget, TutorEditorController>();
    onStart(): void {
        this.disposables.push(this.tutor.onDidRequestGoalFragment(() => { void this.prepareGoal(); }));
        this.editors.all.forEach(widget => this.attach(widget));
        this.disposables.push(this.editors.onCurrentEditorChanged(() => this.renderTask()));
        this.disposables.push(this.tutor.onDidChange(() => this.renderTask()));
        this.taskResize = new ResizeObserver(() => this.renderTask());
        this.taskResize.observe(this.shell.mainPanel.node);
        this.taskResize.observe(this.shell.node);
        window.addEventListener('resize', this.layoutTask);
        this.renderTask();
        this.disposables.push(this.editors.onCreated(widget => this.attach(widget)));
    }
    onStop(): void { this.controllers.forEach(c => c.dispose()); this.controllers.clear(); this.removeTask(); this.taskResize?.disconnect(); window.removeEventListener('resize', this.layoutTask); this.disposables.dispose(); }
    private attach(widget: EditorWidget): void {
        const control = MonacoEditor.get(widget)?.getControl(); if (!control || this.controllers.has(widget)) { return; }
        const controller = new TutorEditorController(widget, control, this.tutor, () => this.editors.currentEditor === widget);
        this.controllers.set(widget, controller); widget.disposed.connect(() => { controller.dispose(); this.controllers.delete(widget); });
    }
    private taskLayer?: HTMLDivElement;
    private taskHost?: HTMLDivElement;
    private taskRoot?: Root;
    private taskResize?: ResizeObserver;
    private taskOffset = { x: 0, y: 44 };
    private readonly layoutTask = (): void => this.renderTask();
    private renderTask(): void {
        const state = this.tutor.goalState;
        if (!this.tutor.teaching || !this.tutor.floatVisible || (!this.tutor.plan && ['none', 'cancelled'].includes(state.status))) {
            this.removeTask(); return;
        }
        const bounds = this.shell.mainPanel.node.getBoundingClientRect();
        if (bounds.width <= 0 || bounds.height <= 0) {
            if (this.taskLayer) { this.taskLayer.style.display = 'none'; }
            return;
        }
        if (!this.taskLayer) {
            this.taskLayer = document.createElement('div'); this.taskLayer.className = 'nodu-task-layer';
            this.taskHost = document.createElement('div'); this.taskHost.className = 'nodu-task-host';
            this.taskLayer.append(this.taskHost); document.body.append(this.taskLayer);
            this.taskRoot = createRoot(this.taskHost);
            this.taskResize?.observe(this.taskHost);
        }
        Object.assign(this.taskLayer.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`, display: bounds.width > 0 && bounds.height > 0 ? '' : 'none' });
        this.taskHost!.style.width = `${Math.min(324, bounds.width)}px`;
        this.taskHost!.style.setProperty('--nodu-task-max-height', `${Math.max(0, bounds.height - 16)}px`);
        this.taskRoot?.render(React.createElement(TutorTaskWindow, {
            tutor: this.tutor, narrow: bounds.width < 640,
            prepare: () => void this.prepareGoal(),
            revealStep: () => void this.commands.executeCommand(TUTOR_COMMANDS.revealStep),
            open: (path: string, line: number) => void this.commands.executeCommand(TUTOR_COMMANDS.openReference, path, line),
            openPanel: () => void this.commands.executeCommand(TUTOR_COMMANDS.openPanel),
            move: (dx: number, dy: number) => this.moveTask(dx, dy),
        }));
        this.moveTask(0, 0);
    }
    private moveTask(dx: number, dy: number): void {
        const host = this.taskHost, layer = this.taskLayer;
        if (!host || !layer) { return; }
        this.taskOffset.x = Math.max(Math.min(0, host.offsetWidth - layer.clientWidth), Math.min(0, this.taskOffset.x + dx));
        this.taskOffset.y = Math.max(0, Math.min(Math.max(0, layer.clientHeight - host.offsetHeight), this.taskOffset.y + dy));
        Object.assign(host.style, { right: '0', top: '0', transform: `translate(${this.taskOffset.x}px, ${this.taskOffset.y}px)` });
    }
    private removeTask(): void {
        if (this.taskHost) { this.taskResize?.unobserve(this.taskHost); }
        this.taskRoot?.unmount(); this.taskRoot = undefined;
        this.taskLayer?.remove(); this.taskLayer = undefined; this.taskHost = undefined;
    }
    private async openTeachingFile(root: NonNullable<NoduTutorModel['rootUri']>, path: string, current: () => boolean): Promise<EditorWidget | undefined> {
        const before = this.editors.currentEditor;
        const widget = await this.editors.open(root.resolve(path), { mode: 'open' });
        if (!current() || (this.editors.currentEditor !== before && this.editors.currentEditor !== widget)) { return; }
        await this.shell.activateWidget(widget.id);
        return current() && this.editors.currentEditor === widget ? widget : undefined;
    }
    private preparingGoal = false;
    private async prepareGoal(): Promise<void> {
        const root = this.tutor.rootUri, workspace = this.tutor.workspaceId, state = this.tutor.goalState;
        const step = state.steps[state.current];
        if (this.preparingGoal || !root || !workspace || !step || state.status !== 'active' || this.tutor.busy || !this.tutor.teaching) { return; }
        this.preparingGoal = true;
        const current = (): boolean => root === this.tutor.rootUri && workspace === this.tutor.workspaceId && state.revision === this.tutor.goalState.revision && this.tutor.teaching;
        try {
            const reference = await this.tutor.resolveReference(step.path, 1);
            if (!current()) { return; }
            const widget = await this.openTeachingFile(root, reference.path, current);
            if (!widget || !current()) { return; }
            const control = MonacoEditor.get(widget)?.getControl(), model = control?.getModel();
            if (!model || !control || model.getValueLength() > 32000) { return; }
            const source = { path: step.path, text: model.getValue(), version: model.getVersionId(), line: control.getPosition()?.lineNumber ?? 1 };
            this.tutor.updateBuffer(source);
            if (!state.fragment) { await this.tutor.goalAction('fragment', undefined, 'suggest'); }
            const fragment = this.tutor.goalState.fragment;
            if (!this.tutor.teaching || this.tutor.goalState.status !== 'active' || root !== this.tutor.rootUri || workspace !== this.tutor.workspaceId || this.editors.currentEditor !== widget
                || model.isDisposed() || model.getValue() !== source.text || model.getVersionId() !== source.version || fragment?.source.path !== source.path || fragment.source.text !== source.text) { return; }
            const line = fragment.answer.guidance?.anchorLine;
            if (line) { control.setPosition({lineNumber:line,column:model.getLineMaxColumn(line)}); control.revealLineInCenterIfOutsideViewport(line); control.focus(); }
        } catch (error) { if (current()) { this.tutor.error = error instanceof Error ? error.message : '无法准备教学位置'; this.tutor.notify(); } }
        finally { this.preparingGoal = false; }
    }
    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: TUTOR_COMMANDS.prepareGoal }, { execute: () => this.prepareGoal(), isEnabled: () => this.tutor.teaching && !this.tutor.busy });
        const available = { isEnabled: () => this.tutor.enabled, isVisible: () => this.tutor.enabled };
        commands.registerCommand({ id: TUTOR_COMMANDS.openReference }, { execute: async (path: string, line = 1) => {
            const root = this.tutor.rootUri, epoch = this.tutor.epoch;
            const current = (): boolean => !!root && root === this.tutor.rootUri && epoch === this.tutor.epoch;
            try {
                const reference = await this.tutor.resolveReference(path, line);
                if (!current()) { return; }
                const widget = await this.openTeachingFile(root!, reference.path, current);
                if (!widget || !current()) { return; }
                const control = MonacoEditor.get(widget)?.getControl();
                control?.setPosition({ lineNumber: reference.line, column: 1 }); control?.revealLineInCenterIfOutsideViewport(reference.line); control?.focus();
            } catch (error) { if (current()) { this.tutor.error = error instanceof Error ? error.message : '无法打开代码文件'; this.tutor.notify(); } return false; }
        }, ...available });
        const toggle = (id: string, label: string, key: 'hintsVisible' | 'highlightsVisible' | 'annotationsVisible' | 'floatVisible'): void => {
            commands.registerCommand({ id, label, category: 'Nodu' }, { execute: () => this.tutor.setDisplay(key, !this.tutor[key]), isToggled: () => this.tutor[key], ...available });
        };
        toggle(TUTOR_COMMANDS.toggleHints, '代码虚影', 'hintsVisible'); toggle(TUTOR_COMMANDS.highlight, '代码高光', 'highlightsVisible');
        toggle(TUTOR_COMMANDS.annotations, '浮动批注', 'annotationsVisible'); toggle(TUTOR_COMMANDS.float, '任务步骤窗', 'floatVisible');
        // The toolbar AI switch: editor guidance only; the AI conversation is unaffected.
        commands.registerCommand({ id: TUTOR_COMMANDS.guidance, label: 'AI 编辑指导', category: 'Nodu' }, { execute: () => this.tutor.setPaused(!this.tutor.paused), isToggled: () => !this.tutor.paused, ...available });
        commands.registerCommand({ id: TUTOR_COMMANDS.check, label: '检查本步', category: 'Nodu' }, { execute: () => this.tutor.send('step'), isEnabled: () => this.tutor.enabled && this.tutor.mode === 'teach' && !!this.tutor.buffer && !this.tutor.busy, isVisible: () => this.tutor.enabled });
        commands.registerCommand({ id: TUTOR_COMMANDS.revealStep, label: '定位教学代码', category: 'Nodu' }, { execute: async () => {
            const root = this.tutor.rootUri, epoch = this.tutor.epoch, step = this.tutor.currentStep(), anchor = step?.anchors[0];
            const current = (): boolean => root === this.tutor.rootUri && epoch === this.tutor.epoch && step === this.tutor.currentStep();
            if (!anchor || !root) { return; }
            try {
                const reference = await this.tutor.resolveReference(anchor.path, 1);
                if (!current()) { return; }
                const widget = await this.openTeachingFile(root, reference.path, current);
                if (!widget || !current()) { return; }
                const control = MonacoEditor.get(widget)?.getControl(), model = control?.getModel();
                const line = model && tutorMarkerLine(model.getLinesContent(), anchor);
                if (control && line) { control.setPosition({ lineNumber: Math.min(line + 1, model!.getLineCount()), column: 1 }); control.revealLineInCenterIfOutsideViewport(line); control.focus(); }
                else if (anchor.marker) { throw new Error('未找到唯一的教学位置'); }
            } catch (error) { if (current()) { this.tutor.error = error instanceof Error ? error.message : '无法定位教学代码'; this.tutor.notify(); } }
        }, ...available });
    }
    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: TUTOR_COMMANDS.togglePanel, keybinding: 'ctrlcmd+shift+a' });
        keys.registerKeybinding({ command: TUTOR_COMMANDS.toggleHints, keybinding: 'ctrlcmd+k h' });
        keys.registerKeybinding({ command: TUTOR_COMMANDS.check, keybinding: 'ctrlcmd+alt+enter', when: 'editorTextFocus' });
    }
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...TUTOR_MENU, '0_chat'], { commandId: TUTOR_COMMANDS.togglePanel });
        menus.registerMenuAction([...TUTOR_MENU, '1_guidance'], { commandId: TUTOR_COMMANDS.guidance });
        for (const [i, command] of [TUTOR_COMMANDS.toggleHints,TUTOR_COMMANDS.highlight,TUTOR_COMMANDS.annotations,TUTOR_COMMANDS.float].entries()) { menus.registerMenuAction([...TUTOR_MENU, '2_display'], { commandId: command, order: String(i) }); }
    }
}
