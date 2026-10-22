// SPDX-License-Identifier: MIT
// In-editor ghost hints (docs/0.2/AI-TUTOR-DESIGN.md §5): a view zone below
// the current step's TODO marker. It is not part of the text model, so it is
// never undone, copied, saved or compiled, and there is no way to accept it
// into the file: the student types every line. Markers are re-found by text
// on each edit, so a deleted or duplicated marker hides the hint instead of
// leaving it on a guessed line.
import { inject, injectable } from '@theia/core/shared/inversify';
import * as monaco from '@theia/monaco-editor-core';
import { CommandContribution, CommandRegistry, CommandService, Disposable, DisposableCollection } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { NoduTutorModel } from './nodu-tutor-model';
import { HINT_LEVEL_LABELS, HintLevel, REFERENCE_LEVEL, TutorStep, findMarkerLines, hintSections, markerFor, maxHintLevel, regionText } from '../common/nodu-tutor-plan';

export const TUTOR_COMMANDS = {
    openPanel: 'nodu.tutor.open-panel',
    togglePanel: 'nodu.tutor.toggle-panel',
    toggleHints: 'nodu.tutor.toggle-hints',
    moreHint: 'nodu.tutor.more-hint',
    revealStep: 'nodu.tutor.reveal-step',
    insertMarker: 'nodu.tutor.insert-marker',
} as const;

/** Highest level the editor raises to on its own; the reference needs the panel's confirmation. */
const EDITOR_MAX_LEVEL: HintLevel = 2;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) { node.textContent = text; }
    return node;
}

/** Zone buttons keep focus in the editor; keyboard users have the same actions in the panel. */
function zoneButton(label: string, action: () => void): HTMLButtonElement {
    const button = el('button', 'nodu-tutor-ghost-button', label);
    button.type = 'button';
    button.tabIndex = -1;
    button.addEventListener('mousedown', event => event.preventDefault());
    button.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); action(); });
    return button;
}

let hintCount = 0;

class HintController implements Disposable {
    private readonly toDispose = new DisposableCollection();
    private zoneId: string | undefined;
    private zone: monaco.editor.IViewZone | undefined;
    private overlay: { node: HTMLElement; widget: monaco.editor.IOverlayWidget } | undefined;
    private readonly overlayId = `nodu.tutor.hint.${++hintCount}`;
    private key = '';
    /** Region text when the hint (re)appeared; any change collapses it to one line. */
    private baseline: { step: string; level: HintLevel; text: string } | undefined;
    private expanded = false;
    private frame: number | undefined;

    constructor(
        private readonly widget: EditorWidget,
        private readonly control: monaco.editor.IStandaloneCodeEditor,
        private readonly tutor: NoduTutorModel,
        private readonly openPanel: () => void,
    ) {
        this.toDispose.push(control.onDidChangeModelContent(() => this.schedule()));
        this.toDispose.push(control.onDidChangeModel(() => { this.baseline = undefined; this.schedule(); }));
        this.toDispose.push(control.onDidLayoutChange(() => this.schedule()));
        this.toDispose.push(control.onDidChangeConfiguration(() => this.schedule()));
        this.toDispose.push(tutor.onDidChange(() => this.schedule()));
        this.schedule();
    }

    get uri(): string { return this.widget.editor.uri.toString(); }

    dispose(): void {
        if (this.frame !== undefined) { cancelAnimationFrame(this.frame); }
        this.toDispose.dispose();
        this.removeZone();
        this.tutor.forgetEditor(this.uri);
    }

    /** Coalesce bursts (typing, model change events) into one render per frame. */
    private schedule(): void {
        if (this.frame !== undefined) { return; }
        this.frame = requestAnimationFrame(() => { this.frame = undefined; this.render(); });
    }

    private render(): void {
        const plan = this.tutor.plan;
        const model = this.control.getModel();
        if (!plan || !model) { this.removeZone(); return; }
        const uri = this.uri;
        const lines = model.getLinesContent();
        const current = this.tutor.currentStep();
        let target: { step: TutorStep; line: number } | undefined;
        for (const step of plan.steps) {
            if (this.tutor.stepUri(step)?.toString() !== uri) { continue; }
            const found = findMarkerLines(lines, step.id);
            this.tutor.reportAnchor(uri, step.id, found.length === 1 ? { line: found[0] } : found.length ? 'ambiguous' : 'missing');
            if (step.id === current?.id && found.length === 1 && step.hints) { target = { step, line: found[0] }; }
        }
        if (!target || !this.tutor.hintsVisible || this.tutor.state(target.step.id)?.status !== 'available') {
            this.removeZone();
            return;
        }
        const { step, line } = target;
        const level = this.tutor.level(step.id);
        const text = regionText(lines, line);
        if (this.baseline?.step !== step.id || this.baseline.level !== level) {
            this.baseline = { step: step.id, level, text };
            this.expanded = false;
        }
        const typed = text !== this.baseline.text;
        const collapsed = typed && !this.expanded;
        const layout = this.control.getLayoutInfo();
        const width = Math.max(240, Math.floor(layout.contentWidth - layout.verticalScrollbarWidth - 16));
        const font = this.control.getOption(monaco.editor.EditorOption.fontInfo);
        const lineHeight = this.control.getOption(monaco.editor.EditorOption.lineHeight);
        const key = JSON.stringify([step.id, level, collapsed, typed, width, font.fontFamily, font.fontSize, lineHeight]);
        if (this.zone && this.zoneId && key === this.key) {
            if (this.zone.afterLineNumber !== line) {
                this.zone.afterLineNumber = line;
                const id = this.zoneId;
                this.control.changeViewZones(accessor => accessor.layoutZone(id));
            }
            return;
        }
        this.key = key;
        const content = this.build(step, level, collapsed, typed);
        Object.assign(content.style, { width: `${width}px`, fontFamily: font.fontFamily, fontSize: `${font.fontSize}px`, lineHeight: `${lineHeight}px` });
        const heightInPx = this.measure(content) + 4;
        const overlay = this.ensureOverlay();
        overlay.style.left = `${layout.contentLeft}px`;
        overlay.replaceChildren(content);
        // Monaco draws the text layer above view zones, so a zone cannot take clicks.
        // Like its own peek widgets, the zone only reserves the space and reports
        // where it is; the hint itself lives in an overlay widget moved to that spot.
        this.control.changeViewZones(accessor => {
            if (this.zoneId) { accessor.removeZone(this.zoneId); }
            this.zone = {
                afterLineNumber: line, heightInPx, domNode: document.createElement('div'), suppressMouseDown: true,
                onDomNodeTop: top => { overlay.style.top = `${top}px`; },
            };
            this.zoneId = accessor.addZone(this.zone);
        });
    }

    private ensureOverlay(): HTMLElement {
        if (this.overlay) { return this.overlay.node; }
        const node = el('div', 'nodu-tutor-ghost-zone');
        node.style.top = '-1000px';
        // The overlay sits outside Monaco's scrollable area; pass wheel scrolling through.
        node.addEventListener('wheel', event => {
            const lineHeight = this.control.getOption(monaco.editor.EditorOption.lineHeight);
            const scale = event.deltaMode === 1 ? lineHeight : event.deltaMode === 2 ? this.control.getLayoutInfo().height : 1;
            this.control.setScrollPosition({
                scrollTop: this.control.getScrollTop() + event.deltaY * scale,
                scrollLeft: this.control.getScrollLeft() + event.deltaX * scale,
            });
            event.preventDefault();
        }, { passive: false });
        const widget: monaco.editor.IOverlayWidget = { getId: () => this.overlayId, getDomNode: () => node, getPosition: () => null };
        this.control.addOverlayWidget(widget);
        this.overlay = { node, widget };
        return node;
    }

    /** Measure off-screen inside the editor so fonts and wrapping match the real render. */
    private measure(content: HTMLElement): number {
        const host = this.control.getDomNode();
        if (!host) { return 0; }
        const probe = el('div', 'nodu-tutor-ghost-zone');
        Object.assign(probe.style, { visibility: 'hidden', position: 'absolute', top: '0', left: '0' });
        probe.appendChild(content);
        host.appendChild(probe);
        const height = content.offsetHeight;
        host.removeChild(probe);
        probe.removeChild(content);
        return height;
    }

    private build(step: TutorStep, level: HintLevel, collapsed: boolean, typed: boolean): HTMLElement {
        const root = el('div', `nodu-tutor-ghost${collapsed ? ' nodu-tutor-ghost-collapsed' : ''}`);
        // The panel shows the same text where screen readers and the keyboard can reach it (§5.5).
        root.setAttribute('aria-hidden', 'true');
        const head = el('div', 'nodu-tutor-ghost-head');
        head.append(el('span', 'nodu-tutor-ghost-step', `${step.id} · ${step.title}`));
        head.append(collapsed ? el('span', 'nodu-tutor-ghost-intent', step.hints!.intent) : el('span', 'nodu-tutor-ghost-level', HINT_LEVEL_LABELS[level]));
        const actions = el('span', 'nodu-tutor-ghost-actions');
        if (collapsed) {
            actions.append(zoneButton('展开', () => { this.expanded = true; this.schedule(); }));
        } else {
            if (level < Math.min(EDITOR_MAX_LEVEL, maxHintLevel(step))) {
                actions.append(zoneButton('再提示一点', () => this.tutor.setLevel(step.id, (level + 1) as HintLevel)));
            }
            if (typed) { actions.append(zoneButton('收起', () => { this.expanded = false; this.schedule(); })); }
            actions.append(zoneButton('步骤面板', this.openPanel));
        }
        head.append(actions);
        root.append(head);
        if (collapsed) { return root; }
        for (const section of hintSections(step, level)) {
            const block = el('div', `nodu-tutor-ghost-section nodu-tutor-ghost-l${section.level}`);
            if (section.level >= 2) {
                block.append(el('div', 'nodu-tutor-ghost-label', section.level === REFERENCE_LEVEL ? '参考实现 · 已记入学习记录' : section.label));
                block.append(el('pre', 'nodu-tutor-ghost-code', section.text));
            } else {
                block.append(el('span', 'nodu-tutor-ghost-label', section.label), el('span', 'nodu-tutor-ghost-text', section.text));
            }
            root.append(block);
        }
        return root;
    }

    private removeZone(): void {
        const id = this.zoneId;
        this.zoneId = undefined;
        this.zone = undefined;
        this.key = '';
        if (id) { this.control.changeViewZones(accessor => accessor.removeZone(id)); }
        if (this.overlay) {
            this.control.removeOverlayWidget(this.overlay.widget);
            this.overlay = undefined;
        }
    }
}

@injectable()
export class NoduTutorHintsContribution implements FrontendApplicationContribution, CommandContribution, KeybindingContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(MessageService) protected readonly messages!: MessageService;
    protected readonly toDispose = new DisposableCollection();
    private readonly controllers = new Map<EditorWidget, HintController>();

    onStart(): void {
        for (const widget of this.editors.all) { this.attach(widget); }
        this.toDispose.push(this.editors.onCreated(widget => this.attach(widget)));
    }

    onStop(): void {
        for (const controller of this.controllers.values()) { controller.dispose(); }
        this.controllers.clear();
        this.toDispose.dispose();
    }

    private attach(widget: EditorWidget): void {
        const control = MonacoEditor.get(widget)?.getControl();
        if (!control || this.controllers.has(widget)) { return; }
        const controller = new HintController(widget, control, this.tutor, () => void this.commands.executeCommand(TUTOR_COMMANDS.openPanel));
        this.controllers.set(widget, controller);
        widget.disposed.connect(() => { controller.dispose(); this.controllers.delete(widget); });
    }

    registerCommands(registry: CommandRegistry): void {
        const hasPlan = (): boolean => !!this.tutor.plan;
        registry.registerCommand({ id: TUTOR_COMMANDS.toggleHints, label: '显示 / 隐藏代码提示', category: '见微 Nodu' }, {
            execute: () => this.tutor.setHintsVisible(!this.tutor.hintsVisible),
            isEnabled: hasPlan, isVisible: hasPlan, isToggled: () => this.tutor.hintsVisible,
        });
        registry.registerCommand({ id: TUTOR_COMMANDS.moreHint, label: '再提示一点', category: '见微 Nodu' }, {
            execute: () => {
                const step = this.tutor.currentStep();
                if (!step?.hints) { return; }
                const level = this.tutor.level(step.id);
                const limit = Math.min(EDITOR_MAX_LEVEL, maxHintLevel(step));
                if (level < limit) { this.tutor.setLevel(step.id, (level + 1) as HintLevel); }
                // The reference is never one keystroke away: it needs the panel's confirmation.
                else { void this.commands.executeCommand(TUTOR_COMMANDS.openPanel); }
                if (!this.tutor.hintsVisible) { this.tutor.setHintsVisible(true); }
            },
            isEnabled: hasPlan, isVisible: hasPlan,
        });
        registry.registerCommand({ id: TUTOR_COMMANDS.revealStep }, { execute: (id: string) => this.reveal(id) });
        registry.registerCommand({ id: TUTOR_COMMANDS.insertMarker }, { execute: (id: string) => this.insertMarker(id) });
    }

    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: TUTOR_COMMANDS.toggleHints, keybinding: 'ctrlcmd+k h' });
        keys.registerKeybinding({ command: TUTOR_COMMANDS.moreHint, keybinding: 'ctrlcmd+k ctrlcmd+h', when: 'editorTextFocus' });
    }

    private async reveal(id: string): Promise<void> {
        const step = this.tutor.state(id)?.step;
        const uri = step && this.tutor.stepUri(step);
        if (!step || !uri) { return; }
        const widget = await this.editors.open(uri, { mode: 'activate' });
        const control = MonacoEditor.get(widget)?.getControl();
        const model = control?.getModel();
        if (!control || !model) { return; }
        const found = findMarkerLines(model.getLinesContent(), step.id);
        if (found.length === 1) {
            control.revealLineInCenterIfOutsideViewport(found[0]);
            control.setPosition({ lineNumber: found[0] + 1, column: 1 });
        }
        control.focus();
    }

    /**
     * The student picks where the step's code goes; only a marker comment is
     * written, through the editor so it can be undone like any other edit.
     */
    private async insertMarker(id: string): Promise<void> {
        const step = this.tutor.state(id)?.step;
        const uri = step && this.tutor.stepUri(step);
        const current = this.editors.currentEditor;
        if (!step || !uri) { return; }
        if (!current || current.editor.uri.toString() !== uri.toString()) {
            await this.editors.open(uri, { mode: 'activate' });
            void this.messages.info(`已打开 ${step.anchor!.file}。把光标放到这一步要写代码的位置，再点一次“在光标处放置标记”。`);
            return;
        }
        const control = MonacoEditor.get(current)?.getControl();
        const model = control?.getModel();
        const position = control?.getPosition();
        if (!control || !model || !position) { return; }
        if (findMarkerLines(model.getLinesContent(), step.id).length) {
            void this.messages.info(`文件里已有 ${markerFor(step.id)}，请保留其中一处。`);
            return;
        }
        const line = position.lineNumber;
        const text = `/* ${markerFor(step.id)} ${step.title} */`;
        const blank = !model.getLineContent(line).trim();
        control.executeEdits('nodu-tutor', [blank
            ? { range: new monaco.Range(line, 1, line, model.getLineMaxColumn(line)), text }
            : { range: new monaco.Range(line, 1, line, 1), text: `${text}\n` }]);
        control.setPosition({ lineNumber: line + 1, column: 1 });
        control.focus();
    }
}
