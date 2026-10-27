// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ApplicationShell, BaseWidget, BoxLayout, FrontendApplicationContribution, ReactWidget, StackedPanel, Widget, WidgetManager, WidgetOpenerOptions } from '@theia/core/lib/browser';
import { CommandContribution, CommandRegistry, CommandService, DisposableCollection, Emitter, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { ContextMenuRenderer } from '@theia/core/lib/browser/context-menu-renderer';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { TerminalCreationHandler } from '@theia/terminal/lib/browser/terminal-creation-handler';
import { TerminalLocation, TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import { NoduConsoleWidget } from './nodu-console-widget';
import { NoduEmbeddedPanel } from './nodu-embedded-panel';
import { NoduEmbeddedModel, PanelTab } from './nodu-embedded-model';
import { NoduDeviceModel } from './nodu-device-client';
import { NoduShellPanelWidget } from './nodu-shell-panel';
import { NoduProblemsPanel } from './nodu-problems-panel';
import '../../style/bottom-panel.css';

export type BottomPage = 'output' | 'repl' | 'monitor' | 'terminal' | 'problems';
const PANEL_MENU = ['nodu-bottom-panel-menu'];

/** One docked owner, with a distinct page set for each project platform. */
@injectable()
export class NoduBottomPanelWidget extends BaseWidget implements ApplicationShell.TrackableWidgetProvider {
    static readonly ID = 'nodu:bottom-panel';
    static readonly LABEL = '开发面板';
    @inject(NoduConsoleWidget) protected readonly console!: NoduConsoleWidget;
    @inject(NoduEmbeddedPanel) protected readonly embeddedPanel!: NoduEmbeddedPanel;
    @inject(NoduShellPanelWidget) protected readonly terminalPanel!: NoduShellPanelWidget;
    @inject(NoduProblemsPanel) protected readonly problemsPanel!: NoduProblemsPanel;
    @inject(NoduEmbeddedModel) protected readonly embedded!: NoduEmbeddedModel;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(ContextMenuRenderer) protected readonly menus!: ContextMenuRenderer;
    @inject(MenuModelRegistry) protected readonly menuRegistry!: MenuModelRegistry;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    private readonly menuEntries = new DisposableCollection();
    private readonly problemAliases = new Set<Widget>();
    private readonly tracked = new Emitter<Widget[]>();
    readonly onDidChangeTrackableWidgets = this.tracked.event;
    private readonly stack = new StackedPanel();
    private header!: BottomPanelHeader;
    private workspacePath = '';
    private platform: 'k210' | 'stm32' | 'arduino' = 'k210';
    private selected: BottomPage = 'output';
    private statusSignature = '';
    private resizeObserver?: ResizeObserver;
    private saveSizeTimer?: ReturnType<typeof setTimeout>;

    @postConstruct()
    protected init(): void {
        this.id = NoduBottomPanelWidget.ID;
        this.title.label = NoduBottomPanelWidget.LABEL;
        this.title.iconClass = 'codicon codicon-terminal';
        this.title.closable = false;
        this.addClass('nodu-bottom-panel');
        this.node.setAttribute('aria-label', NoduBottomPanelWidget.LABEL);
        this.header = new BottomPanelHeader(this);
        const layout = new BoxLayout({ direction: 'top-to-bottom', spacing: 0 });
        this.layout = layout;
        layout.addWidget(this.header);
        layout.addWidget(this.stack);
        BoxLayout.setStretch(this.header, 0);
        BoxLayout.setStretch(this.stack, 1);
        this.stack.addClass('nodu-bottom-pages');
        this.stack.node.setAttribute('role', 'tabpanel');
        this.stack.node.id = 'nodu-bottom-page';
        for (const widget of [this.console, this.embeddedPanel, this.terminalPanel, this.problemsPanel]) {
            this.stack.addWidget(widget);
            widget.hide();
        }
        this.toDispose.push(this.tracked);
        this.toDispose.push(this.menuEntries);
        this.terminalPanel.setChromeHosted(true);
        this.toDispose.push(this.terminalPanel.onDidChangeChrome(() => { if (this.selected === 'terminal') { this.header.update(); } }));
        this.toDispose.push(this.embeddedPanel.onDidChangeChrome(() => { if (this.isEmbedded && (this.selected === 'monitor' || this.selected === 'output')) { this.header.update(); } }));
        this.toDispose.push(this.problemsPanel.onDidChangeProblems(() => this.refreshStatus()));
        this.toDispose.push(this.shell.bottomPanel.onDidChangeCurrent(() => this.syncDockTabs()));
        this.toDispose.push(this.terminalPanel.onDidChangeTrackableWidgets(() => this.tracked.fire(this.getTrackableWidgets())));
        this.toDispose.push(this.embedded.onDidChange(() => this.refreshPlatform()));
        this.toDispose.push(this.device.onDidChange(() => this.refreshStatus()));
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.setWorkspace(roots[0]?.resource.toString() ?? '')));
        void this.workspace.roots.then(roots => this.setWorkspace(roots[0]?.resource.toString() ?? ''));
        this.refreshPlatform();
        this.showSelected();
        this.resizeObserver = new ResizeObserver(() => {
            this.node.classList.toggle('nodu-panel-narrow', this.node.clientWidth < 480);
            this.node.classList.toggle('nodu-panel-compact', this.node.clientWidth < 420);
            if (this.saveSizeTimer) { clearTimeout(this.saveSizeTimer); }
            this.saveSizeTimer = setTimeout(() => {
                const height = this.node.clientHeight;
                if (this.isVisible && !this.maximized && height >= 180) {
                    this.remember('height', String(height));
                }
            }, 250);
        });
        this.resizeObserver.observe(this.node);
        const dockObserver = new MutationObserver(() => {
            // Native panel shortcuts also need to dismiss the maximized overlay.
            if (this.maximized && this.shell.bottomPanel.isHidden) { this.shell.doToggleMaximized(this.shell.bottomPanel); }
            this.refreshStatus();
            this.syncDockTabs();
        });
        dockObserver.observe(this.shell.bottomPanel.node, { attributes: true, childList: true, attributeFilter: ['class'] });
        this.toDispose.push({ dispose: () => dockObserver.disconnect() });
        this.toDispose.push({ dispose: () => { this.resizeObserver?.disconnect(); if (this.saveSizeTimer) { clearTimeout(this.saveSizeTimer); } } });
    }

    get isSTM32(): boolean { return this.platform === 'stm32'; }
    get isEmbedded(): boolean { return this.isSTM32 || this.platform === 'arduino'; }
    get activePage(): BottomPage { return this.selected; }
    get maximized(): boolean { return this.shell.bottomPanel.node.classList.contains('theia-maximized'); }
    get problemCounts(): { errors: number; warnings: number; infos: number; total: number } { return this.problemsPanel.counts; }
    /** The active page's own actions, shown in the header like VS Code panel view actions. */
    pageActions(): React.ReactNode {
        if (this.selected === 'terminal') { return this.terminalPanel.headerToolbar(); }
        if (this.isEmbedded && (this.selected === 'monitor' || this.selected === 'output')) { return this.embeddedPanel.headerActions(); }
        return null;
    }
    get tabs(): ReadonlyArray<{ id: BottomPage; label: string; status?: string }> {
        const tabs: Array<{ id: BottomPage; label: string; status?: string }> = this.isEmbedded ? [
            { id: 'output', label: this.platform === 'arduino' ? '编译输出' : '构建与下载', status: this.embedded.errors.length ? `${this.embedded.errors.length} 个错误` : this.embedded.busy ? '任务进行中' : undefined },
            { id: 'monitor', label: '串口监视', status: this.embedded.monitor.state === 'open' ? '串口已连接' : undefined },
            { id: 'terminal', label: '终端' },
        ] : [
            { id: 'output', label: '运行输出', status: this.device.state.running ? '程序运行中' : undefined },
            { id: 'repl', label: 'Python 交互' },
            { id: 'terminal', label: '终端' },
        ];
        tabs.push({ id: 'problems', label: '问题' });
        return tabs;
    }

    private syncDockTabs(): void {
        let changed = false;
        for (const bar of this.shell.bottomAreaTabBars) {
            const hide = bar.currentTitle?.owner === this;
            if (bar.hasClass('nodu-bottom-owner-tabs') !== hide) {
                bar.toggleClass('nodu-bottom-owner-tabs', hide);
                bar.fit();
                changed = true;
            }
        }
        if (changed) { this.shell.bottomPanel.fit(); }
    }

    private storageKey(name: string): string { return `nodu.bottom.${name}:${this.workspacePath}:${this.platform}`; }
    private read(name: string): string | null { try { return localStorage.getItem(this.storageKey(name)); } catch { return null; } }
    private remember(name: string, value: string): void { try { localStorage.setItem(this.storageKey(name), value); } catch { /* Storage can be unavailable in restricted sessions. */ } }
    private setWorkspace(path: string): void {
        if (path === this.workspacePath) { return; }
        this.workspacePath = path;
        this.restorePage();
    }
    private refreshPlatform(): void {
        const next = this.embedded.isC ? 'stm32' : this.embedded.isArduino ? 'arduino' : 'k210';
        if (next !== this.platform) {
            this.platform = next;
            this.restorePage();
        }
        this.refreshStatus();
    }
    private restorePage(): void {
        const saved = this.read('page');
        this.selected = saved === 'problems' || this.tabs.some(tab => tab.id === saved) ? saved as BottomPage : 'output';
        // Restoring a page never creates a terminal or opens a device connection.
        this.showSelected();
    }
    private refreshStatus(): void {
        const signature = JSON.stringify([this.platform, this.selected, this.tabs, this.maximized, this.problemCounts]);
        if (signature !== this.statusSignature) { this.statusSignature = signature; this.header.update(); }
    }
    async selectPage(page: BottomPage, createTerminal = true): Promise<void> {
        if (page !== 'problems' && !this.tabs.some(tab => tab.id === page)) { return; }
        this.selected = page;
        this.remember('page', page);
        this.showSelected();
        requestAnimationFrame(() => this.header.node.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
        if (page === 'terminal' && createTerminal) { await this.terminalPanel.ensureSession(); }
    }
    showEmbedded(tab: PanelTab = 'output'): void {
        this.refreshPlatform();
        if (tab === 'problems') { void this.selectPage('problems', false); return; }
        this.selected = tab === 'monitor' ? 'monitor' : 'output';
        this.embeddedPanel.setView(tab);
        this.remember('page', this.selected);
        this.showSelected(tab);
    }
    private showSelected(embeddedTab?: PanelTab): void {
        if (!this.header) { return; }
        const child = this.selected === 'problems' ? this.problemsPanel : this.selected === 'terminal' ? this.terminalPanel : this.isEmbedded ? this.embeddedPanel : this.console;
        if (child === this.console) { this.console.setView(this.selected === 'repl' ? 'repl' : 'output'); }
        if (child === this.embeddedPanel) { this.embeddedPanel.setView(embeddedTab ?? (this.selected === 'monitor' ? 'monitor' : 'output')); }
        for (const widget of this.stack.widgets) { widget.setHidden(widget !== child); }
        this.stack.node.setAttribute('aria-labelledby', `nodu-bottom-tab-${this.selected}`);
        this.node.dataset.platform = this.platform;
        this.header.update();
        this.stack.fit();
        child.fit();
    }
    async adoptTerminal(terminal: TerminalWidget, options?: WidgetOpenerOptions, reveal = true): Promise<void> {
        if (reveal) { await this.selectPage('terminal', false); }
        this.terminalPanel.adopt(terminal, options, reveal);
        this.tracked.fire(this.getTrackableWidgets());
    }
    /** Keep framework references valid while all Problems entry points reveal one view. */
    adoptProblemsAlias(widget: Widget): void {
        if (this.problemAliases.has(widget)) { return; }
        this.problemAliases.add(widget);
        this.stack.addWidget(widget);
        widget.hide();
        widget.disposed.connect(() => this.problemAliases.delete(widget));
        this.tracked.fire(this.getTrackableWidgets());
    }
    getTrackableWidgets(): Widget[] { return [this.console, this.embeddedPanel, this.terminalPanel, this.problemsPanel, ...this.problemAliases]; }
    revealWidget(id: string): Widget | undefined {
        if (id === this.problemsPanel.id || [...this.problemAliases].some(widget => widget.id === id)) {
            void this.selectPage('problems', false);
            return this.problemsPanel;
        }
        if (this.terminalPanel.getTrackableWidgets().some(widget => widget.id === id) || id === this.terminalPanel.id) {
            void this.selectPage('terminal', false);
            return id === this.terminalPanel.id ? this.terminalPanel : this.terminalPanel.revealWidget(id);
        }
        if (id === this.console.id || id === this.embeddedPanel.id) { this.showSelected(); return this.selected === 'terminal' ? undefined : this.isEmbedded ? this.embeddedPanel : this.console; }
        return undefined;
    }
    activateWidget(id: string): Widget | undefined {
        const widget = this.revealWidget(id);
        widget?.activate();
        return widget;
    }
    protected override onActivateRequest(msg: import('@theia/core/shared/@lumino/messaging').Message): void {
        super.onActivateRequest(msg);
        this.header.node.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    }
    openMenu(element: HTMLElement): void {
        this.menuEntries.dispose();
        const views = this.shell.getWidgets('bottom').filter(widget => widget !== this && !(widget instanceof TerminalWidget));
        if (views.length) {
            this.menuEntries.push(this.menuRegistry.registerSubmenu([...PANEL_MENU, '1-tools'], '其他面板'));
            for (const [index, widget] of views.entries()) {
                const id = `nodu.panel.reveal.${widget.id}`;
                this.menuEntries.push(this.commandRegistry.registerCommand({ id, label: widget.title.label }, { execute: () => this.shell.activateWidget(widget.id) }));
                this.menuEntries.push(this.menuRegistry.registerMenuAction([...PANEL_MENU, '1-tools'], { commandId: id, order: String(index) }));
            }
        }
        const rect = element.getBoundingClientRect();
        this.menus.render({ menuPath: PANEL_MENU, anchor: { x: rect.left, y: rect.bottom }, context: this.node });
    }
    collapse(): void { if (this.maximized) { this.toggleMaximized(); } void this.shell.collapsePanel('bottom'); }
    toggleMaximized(): void { this.shell.toggleMaximized(this); this.header.update(); }
    resizeBy(delta: number): void {
        if (this.maximized) { this.toggleMaximized(); }
        this.shell.resize(Math.max(180, Math.min(window.innerHeight - 150, this.node.clientHeight + delta)), 'bottom');
    }
    restoreHeight(): void {
        const saved = Number(this.read('height'));
        const height = Number.isFinite(saved) && saved >= 180 ? saved : Math.max(220, Math.min(320, Math.round(window.innerHeight * .28)));
        this.shell.resize(Math.min(height, window.innerHeight - 150), 'bottom');
    }
}

class BottomPanelHeader extends ReactWidget {
    constructor(private readonly owner: NoduBottomPanelWidget) {
        super();
        this.addClass('nodu-bottom-header-widget');
        this.update();
    }
    private key(event: React.KeyboardEvent<HTMLButtonElement>, index: number): void {
        const tabs = this.owner.tabs;
        let next: number | undefined;
        if (event.key === 'ArrowRight') { next = (index + 1) % tabs.length; }
        if (event.key === 'ArrowLeft') { next = (index + tabs.length - 1) % tabs.length; }
        if (event.key === 'Home') { next = 0; }
        if (event.key === 'End') { next = tabs.length - 1; }
        if (next !== undefined) {
            event.preventDefault(); event.stopPropagation();
            const target = this.node.querySelector<HTMLButtonElement>(`#nodu-bottom-tab-${tabs[next].id}`);
            target?.focus(); target?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
    }
    protected render(): React.ReactNode {
        return <div className="nodu-bottom-header">
            <div className="nodu-bottom-tabs" role="tablist" aria-label={this.owner.isSTM32 ? 'STM32 开发面板' : 'K210 开发面板'}>
                {this.owner.tabs.map((tab, index) => <button key={tab.id} id={`nodu-bottom-tab-${tab.id}`} className="nodu-bottom-tab"
                    role="tab" aria-selected={this.owner.activePage === tab.id} aria-controls="nodu-bottom-page"
                    tabIndex={this.owner.activePage === tab.id ? 0 : -1} title={tab.id === 'repl' ? 'Python 交互（REPL）' : tab.status ? `${tab.label}（${tab.status}）` : tab.label}
                    onKeyDown={event => this.key(event, index)} onClick={() => void this.owner.selectPage(tab.id)}>
                    <span>{tab.label}</span>{tab.id === 'problems' && this.owner.problemCounts.total > 0 && <span className="nodu-bottom-tab-count" aria-label={`${this.owner.problemCounts.total} 个问题`}>{this.owner.problemCounts.total}</span>}{tab.status && <span className="nodu-bottom-tab-status" aria-label={tab.status}/>}
                </button>)}
            </div>
            <div className="nodu-bottom-actions">{this.owner.pageActions()}</div>
            <div className="nodu-bottom-chrome">
                <button className="nodu-panel-icon" aria-label="面板更多操作" title="面板更多操作" onClick={event => this.owner.openMenu(event.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label={this.owner.maximized ? '恢复面板大小' : '最大化面板'} title={this.owner.maximized ? '恢复面板大小' : '最大化面板'} onClick={() => this.owner.toggleMaximized()}><i className={`codicon codicon-${this.owner.maximized ? 'screen-normal' : 'screen-full'}`} aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label="收起面板" title="收起面板（⌘/Ctrl+J）" onClick={() => this.owner.collapse()}><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
            </div>
        </div>;
    }
}

/** Standard Theia terminal commands use the same dock owner and real PTYs. */
@injectable()
export class NoduBottomPanelContribution implements TerminalCreationHandler, CommandContribution, MenuContribution, FrontendApplicationContribution {
    readonly priority = 0;
    @inject(WidgetManager) protected readonly widgets!: WidgetManager;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    private readonly disposables = new DisposableCollection();
    private owner?: NoduBottomPanelWidget;
    async onDidInitializeLayout(): Promise<void> {
        const owner = this.owner = await this.panel(false);
        this.disposables.push(this.shell.onDidAddWidget(widget => {
            // Let addWidget finish focus registration before moving the same live widget.
            queueMicrotask(() => {
                if (!this.owner || widget.isDisposed || !this.shell.getWidgets('bottom').includes(widget)) { return; }
                if (widget instanceof TerminalWidget) { void this.owner.adoptTerminal(widget, undefined, false); }
                else if (widget.id === 'problems') { this.owner.adoptProblemsAlias(widget); }
            });
        }));
        const existing = this.shell.getWidgets('bottom');
        // Parents first: a restored split must join its original terminal session.
        const terminals = existing.filter((widget): widget is TerminalWidget => widget instanceof TerminalWidget);
        const pending = new Set(terminals);
        while (pending.size) {
            const ready = [...pending].find(terminal => {
                const location = terminal.location;
                return typeof location !== 'object' || !('parentTerminal' in location)
                    || ![...pending].some(parent => parent.id === location.parentTerminal);
            }) ?? [...pending][0];
            pending.delete(ready);
            await owner.adoptTerminal(ready, undefined, false);
        }
        for (const widget of existing) { if (widget.id === 'problems') { owner.adoptProblemsAlias(widget); } }
    }
    onStop(): void { this.owner = undefined; this.disposables.dispose(); }
    private async panel(reveal = true): Promise<NoduBottomPanelWidget> {
        const panel = await this.widgets.getOrCreateWidget<NoduBottomPanelWidget>(NoduBottomPanelWidget.ID);
        if (!this.shell.getAreaFor(panel)) { await this.shell.addWidget(panel, { area: 'bottom', rank: 50 }); }
        if (reveal) { await this.shell.revealWidget(panel.id); }
        return panel;
    }
    async onWillOpenTerminal(terminal: TerminalWidget, options?: WidgetOpenerOptions): Promise<boolean> {
        if (terminal.location === TerminalLocation.Editor || (typeof terminal.location === 'object' && 'viewColumn' in terminal.location) || options?.widgetOptions?.area === 'main' || (options?.widgetOptions?.ref instanceof TerminalWidget && this.shell.getAreaFor(options.widgetOptions.ref) === 'main')) { return false; }
        const panel = await this.panel();
        await panel.adoptTerminal(terminal, options);
        if (!options?.mode || options.mode === 'activate') { await this.shell.activateWidget(terminal.id); }
        return true;
    }
    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'nodu.panel.problems', label: '问题', category: '见微 Nodu' }, {
            execute: async () => { const panel = await this.panel(); await panel.selectPage('problems', false); await this.shell.activateWidget(panel.revealWidget('nodu:problems-panel')!.id); },
        });
        this.disposables.push(registry.registerHandler('problemsView:toggle', {
            execute: () => registry.executeCommand('nodu.panel.problems'),
        }));
        registry.registerCommand({ id: 'scope.show-terminal', label: '显示终端', category: '见微 Nodu' }, {
            execute: async () => { const panel = await this.panel(); await panel.selectPage('terminal'); },
        });
        const pages: Array<[string, string, BottomPage, 'k210' | 'stm32' | 'both']> = [
            ['output-k210', '运行输出', 'output', 'k210'], ['repl', 'Python 交互', 'repl', 'k210'],
            ['output-stm32', '构建与下载', 'output', 'stm32'], ['monitor', '串口监视', 'monitor', 'stm32'],
            ['terminal', '终端', 'terminal', 'both'],
        ];
        for (const [key, label, page, platform] of pages) {
            registry.registerCommand({ id: `nodu.panel.page.${key}`, label, category: '见微 Nodu' }, {
                execute: async () => { await (await this.panel()).selectPage(page); },
                isVisible: () => { const panel = this.widgets.tryGetWidget<NoduBottomPanelWidget>(NoduBottomPanelWidget.ID); return !!panel && (platform === 'both' || panel.isSTM32 === (platform === 'stm32')); },
                isToggled: () => this.widgets.tryGetWidget<NoduBottomPanelWidget>(NoduBottomPanelWidget.ID)?.activePage === page,
            });
        }
        const actions = [
            ['nodu.panel.grow', '增大面板', (panel: NoduBottomPanelWidget) => panel.resizeBy(40)],
            ['nodu.panel.shrink', '缩小面板', (panel: NoduBottomPanelWidget) => panel.resizeBy(-40)],
            ['nodu.panel.maximize', '最大化 / 恢复面板', (panel: NoduBottomPanelWidget) => panel.toggleMaximized()],
            ['nodu.panel.collapse', '收起面板', (panel: NoduBottomPanelWidget) => panel.collapse()],
        ] as const;
        for (const [id, label, action] of actions) {
            registry.registerCommand({ id, label, category: '见微 Nodu' }, { execute: async () => action(await this.panel(false)) });
        }
    }
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...PANEL_MENU, '0-pages'], { commandId: 'nodu.panel.problems', order: '9' });
        for (const [index, page] of ['output-k210', 'repl', 'output-stm32', 'monitor', 'terminal'].entries()) {
            menus.registerMenuAction([...PANEL_MENU, '0-pages'], { commandId: `nodu.panel.page.${page}`, order: String(index) });
        }
        for (const [index, commandId] of ['nodu.panel.grow', 'nodu.panel.shrink', 'nodu.panel.maximize', 'nodu.panel.collapse'].entries()) {
            menus.registerMenuAction([...PANEL_MENU, '2-size'], { commandId, order: String(index) });
        }
    }
}
