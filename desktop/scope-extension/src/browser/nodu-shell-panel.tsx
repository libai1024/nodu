// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import {
    ApplicationShell, BaseWidget, BoxLayout, Message, ReactWidget, SplitPanel,
    StackedPanel, Widget, WidgetOpenerOptions
} from '@theia/core/lib/browser';
import { SingleTextInputDialog } from '@theia/core/lib/browser/dialogs';
import { ContextMenuRenderer } from '@theia/core/lib/browser/context-menu-renderer';
import { CommandRegistry, DisposableCollection, Emitter, MenuModelRegistry, URI } from '@theia/core/lib/common';
import { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { ShellTerminalServerProxy } from '@theia/terminal/lib/common/shell-terminal-protocol';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { NoduSelect } from './nodu-select';
import '../../style/shell-panel.css';

export type TerminalOpenerOptions = WidgetOpenerOptions;
const SHELL_MORE_MENU = ['nodu-shell-more'];

interface ShellSession {
    readonly id: string;
    readonly panel: SplitPanel;
    readonly terminals: TerminalWidget[];
    readonly workspaceUri: string;
    readonly workspace: string;
    active: TerminalWidget;
}

/** A React-owned toolbar or empty state, separate from Lumino's terminal DOM. */
class ShellChrome extends ReactWidget {
    constructor(id: string, private readonly content: () => React.ReactNode) {
        super();
        this.id = id;
        this.scrollOptions = undefined;
    }

    protected render(): React.ReactNode { return this.content(); }
}

/**
 * Shared real PTY content for the K210 and STM32 terminal pages.
 * Hiding this widget never closes or recreates its terminal processes.
 */
@injectable()
export class NoduShellPanelWidget extends BaseWidget implements ApplicationShell.TrackableWidgetProvider {
    static readonly ID = 'nodu:shell-panel';
    @inject(TerminalService) protected readonly terminals!: TerminalService;
    @inject(ShellTerminalServerProxy) protected readonly terminalServer!: ShellTerminalServerProxy;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(MenuModelRegistry) protected readonly menuRegistry!: MenuModelRegistry;
    @inject(ContextMenuRenderer) protected readonly menus!: ContextMenuRenderer;

    private readonly sessions: ShellSession[] = [];
    private readonly terminalListeners = new Map<TerminalWidget, DisposableCollection>();
    private readonly trackedChanged = new Emitter<Widget[]>();
    readonly onDidChangeTrackableWidgets = this.trackedChanged.event;
    private stack!: StackedPanel;
    private toolbar!: ShellChrome;
    private empty!: ShellChrome;
    private selected: ShellSession | undefined;
    private workspaceUri = '';
    private workspaceName = '本机';
    private readonly lastSession = new Map<string, string>();
    private creating: Promise<void> | undefined;
    private failure = '';
    private fitFrame: number | undefined;

    @postConstruct()
    protected init(): void {
        this.id = NoduShellPanelWidget.ID;
        this.title.label = '终端';
        this.title.closable = false;
        this.addClass('nodu-shell-panel');
        this.node.setAttribute('aria-label', '本机终端');
        this.registerMenu();

        const layout = new BoxLayout({ direction: 'top-to-bottom', spacing: 0 });
        this.layout = layout;
        this.toolbar = new ShellChrome(`${this.id}:toolbar`, () => this.renderToolbar());
        this.toolbar.addClass('nodu-shell-toolbar');
        this.empty = new ShellChrome(`${this.id}:empty`, () => this.renderEmpty());
        this.empty.addClass('nodu-shell-empty-widget');
        this.stack = new StackedPanel();
        this.stack.addClass('nodu-shell-stack');
        this.stack.addWidget(this.empty);
        layout.addWidget(this.toolbar);
        layout.addWidget(this.stack);
        BoxLayout.setStretch(this.toolbar, 0);
        BoxLayout.setStretch(this.stack, 1);

        this.toDispose.push(this.trackedChanged);
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.switchWorkspace(roots[0]?.resource)));
        this.switchWorkspace(this.workspace.tryGetRoots()[0]?.resource);
        void this.workspace.roots.then(roots => {
            if (!this.isDisposed) { this.switchWorkspace(roots[0]?.resource); }
        }).catch(() => undefined);
        this.toDispose.push(this.terminals.onDidChangeCurrentTerminal(terminal => {
            const session = terminal && this.sessionFor(terminal);
            if (session && terminal) {
                session.active = terminal;
                this.refresh();
            }
        }));
        this.toDispose.push({ dispose: () => {
            if (this.fitFrame !== undefined) { cancelAnimationFrame(this.fitFrame); }
            for (const listeners of this.terminalListeners.values()) { listeners.dispose(); }
            this.terminalListeners.clear();
        } });
        this.refresh();
    }

    /** Called only after the user explicitly opens the terminal page. */
    async ensureSession(): Promise<void> {
        if (this.creating) { await this.creating; }
        if (this.isDisposed) { return; }
        this.switchWorkspace((await this.workspace.roots)[0]?.resource);
        const existing = this.sessions.find(session => session.workspaceUri === this.workspaceUri
            && session.id === this.lastSession.get(this.workspaceUri))
            ?? this.sessions.find(session => session.workspaceUri === this.workspaceUri);
        if (existing) { this.selectSession(existing); return; }
        await this.createSession(false);
    }

    /**
     * Take ownership of a terminal already started by the caller.
     * This deliberately does not call start(), close() or TerminalService.open().
     * Silent adoption preserves the selected session and focus. When no session is
     * selected yet, the first one is prepared without activating its terminal.
     */
    adopt(terminal: TerminalWidget, options?: TerminalOpenerOptions, reveal = true): void {
        this.adoptInWorkspace(terminal, options, this.workspaceUri, this.workspaceName, reveal);
    }

    private adoptInWorkspace(terminal: TerminalWidget, options: TerminalOpenerOptions | undefined,
        workspaceUri: string, workspace: string, reveal = true): void {
        if (this.isDisposed || terminal.isDisposed) { return; }
        let session = this.sessionFor(terminal);
        if (!session) {
            const ref = options?.widgetOptions?.ref;
            const parentId = typeof terminal.location === 'object' && 'parentTerminal' in terminal.location
                ? terminal.location.parentTerminal : undefined;
            const reference = ref instanceof TerminalWidget ? ref
                : parentId ? this.terminals.getById(parentId) : undefined;
            const split = !!options?.widgetOptions?.mode?.startsWith('split-') || !!parentId;
            session = split && reference ? this.sessionFor(reference) : undefined;
            if (!session) {
                const panel = new SplitPanel({ orientation: 'horizontal', spacing: 1 });
                panel.id = `${this.id}:session:${terminal.id}`;
                panel.addClass('nodu-shell-split');
                session = {
                    id: terminal.id,
                    panel,
                    terminals: [],
                    workspaceUri, workspace,
                    active: terminal,
                };
                panel.hide();
                this.stack.addWidget(panel);
                this.sessions.push(session);
            }
            // Lumino reparents the widget and delivers its attach/resize messages.
            session.panel.addWidget(terminal);
            session.terminals.push(terminal);
            this.watchTerminal(terminal);
            this.trackedChanged.fire(this.getTrackableWidgets());
        }
        // The session panel owns visibility; showing a child cannot reveal a
        // background session or the bottom panel itself.
        terminal.show();
        if (reveal) {
            session.active = terminal;
            this.failure = '';
            this.selectSession(session);
            if (options?.mode !== 'reveal') { terminal.activate(); }
        } else if (!this.selected && session.workspaceUri === this.workspaceUri) {
            this.selectSession(session);
        } else { this.refresh(); }
    }

    getTrackableWidgets(): Widget[] {
        return this.sessions.flatMap(session => session.terminals);
    }

    activateWidget(id: string): Widget | undefined {
        const terminal = this.revealWidget(id);
        terminal?.activate();
        return terminal;
    }

    revealWidget(id: string): Widget | undefined {
        const session = this.sessions.find(item => item.terminals.some(terminal => terminal.id === id));
        if (!session) { return undefined; }
        const terminal = session.terminals.find(item => item.id === id)!;
        session.active = terminal;
        this.selectSession(session);
        return terminal;
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.fitVisibleTerminals();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.currentTerminal()?.activate();
    }

    private currentTerminal(): TerminalWidget | undefined {
        const current = this.terminals.currentTerminal;
        return current && this.selected?.terminals.includes(current) ? current : this.selected?.active;
    }

    private sessionFor(terminal: TerminalWidget): ShellSession | undefined {
        return this.sessions.find(session => session.terminals.includes(terminal));
    }

    /** Project switches only change the visible group; old PTYs keep their owner. */
    private switchWorkspace(root: URI | undefined): void {
        const uri = root?.toString() ?? '';
        if (uri === this.workspaceUri) { return; }
        this.workspaceUri = uri;
        this.workspaceName = root?.path.base || '本机';
        this.failure = '';
        const previous = this.lastSession.get(uri);
        const session = this.sessions.find(item => item.workspaceUri === uri && item.id === previous)
            ?? this.sessions.find(item => item.workspaceUri === uri);
        if (session) { this.selectSession(session); }
        else {
            this.selected = undefined;
            for (const item of this.sessions) { item.panel.hide(); }
            this.empty.show();
            this.refresh();
        }
    }

    private selectSession(session: ShellSession): void {
        this.selected = session;
        this.lastSession.set(session.workspaceUri, session.id);
        this.empty.hide();
        for (const item of this.sessions) { item.panel.setHidden(item !== session); }
        this.refresh();
        this.fitVisibleTerminals();
    }

    private fitVisibleTerminals(): void {
        if (this.fitFrame !== undefined) { cancelAnimationFrame(this.fitFrame); }
        this.fitFrame = requestAnimationFrame(() => {
            this.fitFrame = undefined;
            if (this.isDisposed || !this.isAttached || !this.isVisible) { return; }
            this.stack.fit();
            this.selected?.panel.fit();
            for (const terminal of this.selected?.terminals ?? []) {
                if (terminal.isAttached && terminal.isVisible) { terminal.fit(); }
            }
        });
    }

    private watchTerminal(terminal: TerminalWidget): void {
        const listeners = new DisposableCollection();
        this.terminalListeners.set(terminal, listeners);
        const focused = (): void => {
            const session = this.sessionFor(terminal);
            if (session) { session.active = terminal; this.refresh(); }
        };
        const titleChanged = (): void => this.refresh();
        terminal.node.addEventListener('focusin', focused);
        terminal.title.changed.connect(titleChanged);
        listeners.push({ dispose: () => {
            terminal.node.removeEventListener('focusin', focused);
            terminal.title.changed.disconnect(titleChanged);
        } });
        listeners.push(terminal.onDidDispose(() => this.removeTerminal(terminal)));
    }

    private removeTerminal(terminal: TerminalWidget): void {
        const listeners = this.terminalListeners.get(terminal);
        this.terminalListeners.delete(terminal);
        listeners?.dispose();
        if (this.isDisposed) { return; }
        const session = this.sessionFor(terminal);
        if (!session) { return; }
        session.terminals.splice(session.terminals.indexOf(terminal), 1);
        if (!session.terminals.length) {
            this.sessions.splice(this.sessions.indexOf(session), 1);
            session.panel.dispose();
            if (this.selected === session) {
                this.selected = this.sessions.filter(item => item.workspaceUri === this.workspaceUri).at(-1);
            }
        } else if (session.active === terminal) {
            session.active = session.terminals.at(-1)!;
        }
        this.trackedChanged.fire(this.getTrackableWidgets());
        if (this.selected) { this.selectSession(this.selected); }
        else { this.empty.show(); this.refresh(); }
    }

    private createSession(activate: boolean, splitFrom?: TerminalWidget): Promise<void> {
        if (this.creating) { return this.creating; }
        this.failure = '';
        const opening = (async (): Promise<void> => {
            let terminal: TerminalWidget | undefined;
            let ownerUri = this.workspaceUri;
            try {
                const root = (await this.workspace.roots)[0]?.resource;
                const source = splitFrom && this.sessionFor(splitFrom);
                ownerUri = source?.workspaceUri ?? root?.toString() ?? '';
                const ownerName = source?.workspace ?? root?.path.base ?? '本机';
                let cwd = ownerUri ? new URI(ownerUri) : undefined;
                if (splitFrom) {
                    try { cwd = new URI(await this.terminalServer.getCwdURI(splitFrom.terminalId)); }
                    catch { /* Keep the original workspace when the process already exited. */ }
                }
                terminal = await this.terminals.newTerminal({
                    cwd, kind: 'nodu-shell', useServerTitle: true,
                    destroyTermOnClose: true, isTransient: true,
                });
                if (this.isDisposed) { terminal.dispose(); return; }
                this.adoptInWorkspace(terminal, {
                    mode: 'reveal',
                    widgetOptions: splitFrom ? { ref: splitFrom, mode: 'split-right' } : undefined,
                }, ownerUri, ownerName, ownerUri === this.workspaceUri);
                // This is the only start() in this widget; adopted external terminals skip it.
                const terminalId = await terminal.start();
                if (this.isDisposed || terminal.isDisposed) {
                    // Disposal may happen while the backend is still creating the PTY.
                    // Its id was not available to TerminalWidget.dispose() at that point.
                    await this.terminalServer.close(terminalId);
                    return;
                }
                this.fitVisibleTerminals();
                if (activate && this.isVisible && terminal.isVisible) { terminal.activate(); }
            } catch (error) {
                terminal?.dispose();
                if (!this.isDisposed && ownerUri === this.workspaceUri) {
                    this.failure = `终端启动失败：${error instanceof Error ? error.message : String(error)}`;
                }
            }
        })();
        this.creating = opening;
        this.refresh();
        return opening.finally(() => {
            this.creating = undefined;
            if (!this.isDisposed) { this.refresh(); }
        });
    }

    private async renameTerminal(terminal = this.currentTerminal()): Promise<void> {
        if (!terminal) { return; }
        const name = await new SingleTextInputDialog({
            title: '重命名终端', initialValue: terminal.title.label,
            confirmButtonLabel: '重命名',
            validate: value => !value.trim() ? '名称不能为空。' : value.trim().length > 80 ? '名称最多 80 个字符。' : '',
        }).open();
        if (name !== undefined && !terminal.isDisposed) {
            terminal.setTitle(name.trim());
            this.refresh();
        }
    }

    private refresh(): void {
        this.toolbar?.update();
        this.empty?.update();
        this.chromeChanged.fire();
    }

    private readonly chromeChanged = new Emitter<void>();
    /** Fires whenever the session controls change, for a host that renders them elsewhere. */
    readonly onDidChangeChrome = this.chromeChanged.event;
    headerToolbar(): React.ReactNode { return this.renderToolbar(); }
    /** The bottom panel header shows the session controls; the in-page bar is then hidden. */
    setChromeHosted(hosted: boolean): void {
        this.toolbar.setHidden(hosted);
        this.fit();
    }

    private menuTerminal(id?: string): TerminalWidget | undefined {
        const terminal = id ? this.getTrackableWidgets().find(widget => widget.id === id) as TerminalWidget | undefined : this.currentTerminal();
        return terminal && !terminal.isDisposed ? terminal : undefined;
    }

    private registerMenu(): void {
        const actions = [
            { id: 'nodu.shell.find', label: '查找终端内容', run: (terminal: TerminalWidget) => terminal.getSearchBox().show() },
            { id: 'nodu.shell.rename', label: '重命名终端…', run: (terminal: TerminalWidget) => this.renameTerminal(terminal) },
        ];
        actions.forEach((action, index) => {
            this.toDispose.push(this.commands.registerCommand({ id: action.id, label: action.label }, {
                execute: (id?: string) => { const terminal = this.menuTerminal(id); if (terminal) { return action.run(terminal); } },
                isEnabled: (id?: string) => !!this.menuTerminal(id),
            }));
            this.toDispose.push(this.menuRegistry.registerMenuAction(SHELL_MORE_MENU, { commandId: action.id, order: String(index) }));
        });
    }

    private openMore(element: HTMLElement): void {
        const terminal = this.currentTerminal();
        if (!terminal) { return; }
        const bounds = element.getBoundingClientRect();
        this.menus.render({
            menuPath: SHELL_MORE_MENU, anchor: { x: bounds.left, y: bounds.bottom },
            context: this.node, args: [terminal.id], includeAnchorArg: false,
        });
    }

    private action(label: string, icon: string, run: () => void, disabled = false): React.ReactNode {
        return <button className="nodu-shell-action" title={label} aria-label={label} disabled={disabled}
            onClick={run}><i className={`codicon codicon-${icon}`} aria-hidden="true"/></button>;
    }

    private renderToolbar(): React.ReactNode {
        const terminal = this.currentTerminal();
        const busy = !!this.creating;
        // Explicit terminal activation may reveal a background project's session.
        // Its original project stays visible in the context, never relabelled as this one.
        const sessions = this.sessions.filter(session => session.workspaceUri === this.workspaceUri || session === this.selected);
        return <div className="nodu-shell-bar" role="toolbar" aria-label="终端会话操作">
            <i className="codicon codicon-terminal nodu-shell-context-icon" aria-hidden="true"/>
            <NoduSelect className="nodu-shell-select" aria-label="终端会话" value={this.selected?.id ?? ''}
                title={this.selected ? `${this.selected.active.title.label} · ${this.selected.workspace}` : '本机终端'}
                disabled={!sessions.length} onChange={value => {
                    const session = sessions.find(item => item.id === value);
                    if (session) { this.selectSession(session); }
                }} options={sessions.length ? sessions.map((session, index) => ({ value: session.id,
                    label: `${sessions.length > 1 ? `${index + 1} · ` : ''}${session.active.title.label}${session.terminals.length > 1 ? ` · ${session.terminals.length} 个分屏` : ''}`,
                })) : [{ value: '', label: '本机终端' }]}/>
            <span className={`nodu-shell-context${this.failure ? ' nodu-shell-failure' : ''}`}
                title={this.failure || this.selected?.workspace || this.workspaceName} role={this.failure ? 'alert' : undefined}>
                {this.failure || (busy ? '正在启动…' : this.selected?.workspace ?? this.workspaceName)}
            </span>
            <div className="nodu-shell-actions">
                {this.action('新建终端', 'add', () => void this.createSession(true), busy)}
                {this.action('拆分终端', 'split-horizontal', () => void this.createSession(true, terminal), busy || !terminal)}
                {this.action('结束终端', 'trash', () => terminal?.close(), !terminal || busy)}
                <button type="button" className="nodu-shell-action" title="终端更多操作" aria-label="终端更多操作" aria-haspopup="menu" disabled={!terminal}
                    onClick={event => this.openMore(event.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
            </div>
        </div>;
    }

    private renderEmpty(): React.ReactNode {
        return <div className="nodu-shell-empty">
            {this.failure && <p className="nodu-shell-empty-error" role="alert">{this.failure}</p>}
            <button className="nodu-shell-create" disabled={!!this.creating} aria-busy={!!this.creating}
                title={this.failure ? '重试启动终端' : '新建终端'}
                onClick={() => void this.createSession(true)}>
                <i className={`codicon ${this.creating ? 'codicon-loading codicon-modifier-spin' : 'codicon-add'}`} aria-hidden="true"/>{this.failure ? '重试' : '新建终端'}
            </button>
        </div>;
    }
}
