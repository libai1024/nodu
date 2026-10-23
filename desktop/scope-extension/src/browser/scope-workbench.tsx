// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { BoxLayout, Widget } from '@theia/core/shared/@lumino/widgets';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService, DisposableCollection, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR, environment } from '@theia/core/lib/common';
import { getThemeMode } from '@theia/core/lib/common/theme';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution, ApplicationShell, CommonCommands, CommonMenus, KeybindingContribution, KeybindingRegistry, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import * as monaco from '@theia/monaco-editor-core';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { OutputChannelManager, OutputChannelSeverity } from '@theia/output/lib/browser/output-channel';
import { OutputContribution } from '@theia/output/lib/browser/output-contribution';
import { ScopeSession } from './scope-session';
import { ScopeDeviceWidget, ScopeVisionWidget } from './scope-widgets';
import { registerScopeLanguages } from './scope-languages';
import { NoduDeviceModel } from './nodu-device-client';
import { copyImageParameters } from './nodu-image-clipboard';
import { ScopeLayoutState } from './scope-layout-state';
import { NoduDevicePanel } from './nodu-device-panel';
import { NoduConsoleWidget } from './nodu-console-widget';
import { NoduBoardFilesContribution } from './nodu-board-files';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS, TUTOR_MENU } from './nodu-tutor-hints';
import { NoduTutorWidget } from './nodu-tutor-widget';
import { NoduBrand } from './scope-brand';
import { NoduEmbeddedModel } from './nodu-embedded-model';
import { NoduCToolbar } from './nodu-embedded-toolbar';
import { C_COMMANDS } from './nodu-embedded-commands';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { SCOPE_LIGHT_THEME_ID, SCOPE_THEME_ID } from './scope-theme';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import { URI } from '@theia/core/lib/common/uri';
import { MAIXPY_RELEASES_URL } from './nodu-file-docs';
import { firmwareStatusText, fpsStatusText, serialPortStatusText } from '../common/nodu-status';
import { BOARD_MENU, TOOLS_MENU_GROUPS } from '../common/nodu-tools-menu';
import { ContextMenuRenderer } from '@theia/core/lib/browser/context-menu-renderer';
import { isOSX } from '@theia/core/lib/common/os';
import '@theia/core/lib/electron-common/electron-api';
export { ScopeLayoutState } from './scope-layout-state';

/** Toolbar dropdown menus (rendered as context menus under their button). */
export const NODU_PROJECT_MENU = ['nodu-toolbar-project'];
export const NODU_RUN_MENU = ['nodu-toolbar-run'];
export const NODU_MORE_MENU = ['nodu-toolbar-more'];
/** Theia workspace items that a single-project beginner IDE does not expose in 文件. */
const HIDDEN_FILE_MENU_COMMANDS = ['workbench.action.newWindow', 'workspace:openWorkspace', 'workspace:openRecent', 'workspace:addFolder', 'workspace:saveAs', 'workspace:close'];

@injectable()
export class ScopeVisionContribution extends AbstractViewContribution<ScopeVisionWidget> {
    constructor() {
        super({ widgetId: ScopeVisionWidget.ID, widgetName: ScopeVisionWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 100 }, toggleCommandId: 'scope.vision' });
    }
}

@injectable()
export class ScopeDeviceContribution extends AbstractViewContribution<ScopeDeviceWidget> {
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    constructor() {
        super({ widgetId: ScopeDeviceWidget.ID, widgetName: ScopeDeviceWidget.LABEL,
            defaultWidgetOptions: { area: 'right', rank: 200 }, toggleCommandId: 'scope.devices' });
    }
    override async openView(args: { toggle?: boolean } = {}): Promise<ScopeDeviceWidget> {
        this.layoutState.setDeviceOpen(args.toggle ? !this.layoutState.deviceOpen : true);
        return this.widget;
    }
}

@injectable()
export class ScopeConsoleContribution extends AbstractViewContribution<NoduConsoleWidget> {
    constructor() {
        super({ widgetId: NoduConsoleWidget.ID, widgetName: NoduConsoleWidget.LABEL,
            defaultWidgetOptions: { area: 'bottom', rank: 50 } });
    }
}

@injectable()
export class ScopeToolbar extends ReactWidget {
    // Operations whose failure means the user's Python raised, not a device fault.
    private static readonly USER_CODE_OPS = new Set(['执行 REPL', '发送脚本', '运行脚本']);
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(ContextMenuRenderer) protected readonly contextMenu!: ContextMenuRenderer;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(NoduEmbeddedModel) protected readonly embedded!: NoduEmbeddedModel;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;

    @postConstruct()
    protected init(): void {
        this.id = 'scope:toolbar';
        this.addClass('scope-toolbar-widget');
        this.toDispose.push(this.device.onDidChange(() => this.update()));
        this.toDispose.push(this.embedded.onDidChange(() => this.update()));
        this.toDispose.push(this.layoutState.onDidChange(() => this.update()));
        this.toDispose.push(this.themes.onDidColorThemeChange(() => this.update()));
        // Hint and anchor changes fire often; the toolbar only shows whether a plan exists and the panel is open.
        this.toDispose.push(this.tutor.onDidChange(() => this.update()));
        const outside = (event: PointerEvent): void => {
            if (this.layoutState.deviceOpen && event.target instanceof Node && !this.node.querySelector('.scope-device-picker')?.contains(event.target)) {
                this.layoutState.setDeviceOpen(false);
            }
        };
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape' && this.layoutState.deviceOpen) {
                event.preventDefault(); event.stopPropagation(); this.layoutState.setDeviceOpen(false);
                this.node.querySelector<HTMLButtonElement>('.scope-device-chip')?.focus();
            }
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        this.toDispose.push({ dispose: () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); } });
        this.update();
    }

    protected render(): React.ReactNode {
        // STM32 C projects get their own buttons (UI-DESIGN §3); K210 projects keep this toolbar.
        if (this.embedded.isC) { return this.renderC(); }
        if (this.embedded.isEsp) { return this.renderEsp(); }
        const simple = this.layoutState.mode === 'simple';
        const { phase } = this.device.state;
        // Beginner code faults (REPL/RAM script) are not device failures; they stay in the console.
        const deviceError = !!this.device.error && !ScopeToolbar.USER_CODE_OPS.has(this.device.errorOperation);
        const chipState = deviceError || phase === 'error' ? 'error' : phase === 'connecting' ? 'connecting' : this.device.connected ? 'connected' : 'disconnected';
        const board = this.device.boardLabel;
        const port = (this.device.state.port || this.device.selectedPort).split('/').pop() || '选择端口';
        const { filesVisible, consoleVisible, visionVisible } = this.layoutState;
        // Layout: project menu, primary action (+ variants), stop, single device
        // entry … position-named panel toggles and one overflow menu. Stop stays
        // a separate fixed button so future compile/flash jobs share it.
        return <header className="scope-workspace-bar" aria-label="Nodu 工具栏">
            <div className="scope-toolbar-start">
                <NoduBrand />
                <button className="scope-action nodu-toolbar-project" aria-label={`项目菜单 · ${this.layoutState.project}`} aria-haspopup="menu" title="新建、打开、示例与最近的文件" onClick={event => this.openMenu(NODU_PROJECT_MENU, event.currentTarget)}><i className="codicon codicon-folder" aria-hidden="true"/><span className="nodu-toolbar-project-name">{this.layoutState.project}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                <div className="nodu-run-split" role="group" aria-label="运行">
                    <button className={`scope-action scope-action-primary scope-toolbar-run${this.device.state.running ? ' nodu-is-running' : ''}`} disabled={this.device.busy || this.device.state.running} aria-busy={this.device.state.running || undefined} onClick={() => void this.commands.executeCommand('scope.run-current')} title="运行到开发板内存，不保存 · Ctrl / ⌘ Enter"><i className={`codicon ${this.device.state.running ? 'codicon-loading codicon-modifier-spin' : 'codicon-play'}`} aria-hidden="true"/>{this.device.state.running ? '运行中' : '运行'}</button>
                    <button className="scope-action scope-action-primary nodu-run-more" aria-label="更多运行方式" aria-haspopup="menu" title="保存到开发板、设为开机脚本" onClick={event => this.openMenu(NODU_RUN_MENU, event.currentTarget)}><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                </div>
                <button className={`scope-action scope-toolbar-icon nodu-toolbar-stop${this.device.state.running || this.device.busy ? ' nodu-stop-active' : ''}`} aria-label="停止" disabled={!this.device.canStop} onClick={() => void this.commands.executeCommand('scope.stop-device')} title="停止"><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>
                <div className="scope-device-picker">
                    <button className={`scope-action scope-device-chip nodu-chip-${chipState} ${deviceError ? 'nodu-has-error' : ''}`} aria-label="设备与端口" aria-haspopup="dialog" aria-controls="scope-device-popover" aria-expanded={this.layoutState.deviceOpen} aria-pressed={this.layoutState.deviceOpen} onClick={() => this.layoutState.setDeviceOpen(!this.layoutState.deviceOpen)} title={this.device.error || (this.device.connected ? `${board} · 板端配置声明，非硬件实测` : '设备与端口')}><span className="scope-status-dot" aria-hidden="true"/><span className="scope-device-chip-board">{board}</span><span className="scope-device-chip-port">{port}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                    {/* One permanently mounted form owns drafts/confirmations across popover and mode changes. */}
                    <div id="scope-device-popover" className="scope-device-popover scope-widget" role="dialog" aria-label="设备设置" hidden={!this.layoutState.deviceOpen}>
                        <NoduDevicePanel model={this.device} files={this.files} dialogs={this.dialogs} editors={this.editors} compact={simple} onConnected={() => this.layoutState.setDeviceOpen(false)} showLogs={() => void this.commands.executeCommand('scope.show-logs')} showBoardGuide={() => void this.commands.executeCommand('scope.board-guide')} />
                    </div>
                </div>
            </div>
            <div className="scope-toolbar-center">{deviceError ? <button className="nodu-toolbar-alert" onClick={() => void this.commands.executeCommand('scope.show-logs')} title={this.device.error}><i className="codicon codicon-error" aria-hidden="true"/><span>{this.device.error}</span></button> : null}</div>
            <div className="scope-toolbar-end">
            {/* Position-named toggles (left / bottom / right) avoid clashing with the 文件 menu. */}
            <button className="scope-action scope-toolbar-icon scope-toolbar-files" aria-label="文件列表" aria-pressed={filesVisible} onClick={() => void this.commands.executeCommand('scope.toggle-files')} title={filesVisible ? '隐藏文件列表' : '显示文件列表'}><i className={`codicon codicon-layout-sidebar-left${filesVisible ? '' : '-off'}`} aria-hidden="true"/></button>
            <button className={`scope-action scope-toolbar-icon scope-toolbar-console ${this.device.error ? 'nodu-has-error' : ''}`} aria-label="串行终端" aria-pressed={consoleVisible} onClick={() => void this.commands.executeCommand('scope.toggle-console')} title={consoleVisible ? '隐藏串行终端' : '显示串行终端'}><i className={`codicon codicon-layout-panel${consoleVisible ? '' : '-off'}`} aria-hidden="true"/></button>
            {/* Teaching projects only; 帧缓冲 stays the rightmost panel toggle. */}
            {this.renderAI()}
            <button className="scope-action scope-toolbar-icon scope-toolbar-vision" aria-label="帧缓冲" aria-pressed={visionVisible} onClick={() => void this.commands.executeCommand('scope.toggle-vision')} title={visionVisible ? '隐藏帧缓冲' : '显示帧缓冲'}><i className={`codicon codicon-layout-sidebar-right${visionVisible ? '' : '-off'}`} aria-hidden="true"/></button>
            <span className="scope-toolbar-divider" aria-hidden="true"/>
            <button className="scope-action scope-toolbar-icon nodu-toolbar-more" aria-label={`更多 · 当前${simple ? '简洁' : '专业'}模式`} aria-haspopup="menu" title="主题、布局模式与设置" onClick={event => this.openMenu(NODU_MORE_MENU, event.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
            </div>
        </header>;
    }

    private renderEsp(): React.ReactNode {
        return <header className="scope-workspace-bar" aria-label="Nodu 工具栏">
            <div className="scope-toolbar-start">
                <NoduBrand />
                <button className="scope-action nodu-toolbar-project" aria-label={`项目菜单 · ${this.layoutState.project}`} aria-haspopup="menu" onClick={event => this.openMenu(NODU_PROJECT_MENU, event.currentTarget)}><i className="codicon codicon-folder" aria-hidden="true"/><span>{this.layoutState.project}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                <button className="scope-action scope-action-primary" onClick={() => void this.commands.executeCommand('task:run:build')}><i className="codicon codicon-tools" aria-hidden="true"/>编译</button>
                <button className="scope-action" onClick={() => void this.commands.executeCommand('task:run')}>任务</button>
                <span className="scope-device-chip-board">{this.embedded.espChip.toUpperCase().replace(/^ESP32(?=.)/, 'ESP32-')}</span>
            </div>
            <div className="scope-toolbar-end">
                {this.renderAI()}
                <button className="scope-action scope-toolbar-icon" aria-label="文件列表" aria-pressed={this.layoutState.filesVisible} onClick={() => void this.commands.executeCommand('scope.toggle-files')}><i className="codicon codicon-layout-sidebar-left" aria-hidden="true"/></button>
                <button className="scope-action scope-toolbar-icon" aria-label="更多" aria-haspopup="menu" onClick={event => this.openMenu(NODU_MORE_MENU, event.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
            </div>
        </header>;
    }

    private renderAI(): React.ReactNode {
        // 简洁模式不提供 AI 功能。
        if (this.layoutState.mode === 'simple') { return undefined; }
        return <div className="nodu-ai-split" role="group" aria-label="AI">
            <button className="scope-action scope-toolbar-icon nodu-toolbar-tutor" aria-label="AI 侧栏" aria-pressed={this.tutor.panelVisible} onClick={() => void this.commands.executeCommand(TUTOR_COMMANDS.togglePanel)} title="AI 侧栏"><i className="codicon codicon-sparkle" aria-hidden="true" /></button>
            <button className="scope-action nodu-ai-more" aria-label="AI 显示设置" aria-haspopup="menu" title="AI 显示设置" onClick={event => this.openMenu(TUTOR_MENU, event.currentTarget)}><i className="codicon codicon-chevron-down" aria-hidden="true" /></button>
        </div>;
    }

    private renderC(): React.ReactNode {
        const tutor = this.renderAI();
        return <NoduCToolbar model={this.embedded} simple={this.layoutState.mode === 'simple'} project={this.layoutState.project}
            deviceOpen={this.layoutState.deviceOpen} filesVisible={this.layoutState.filesVisible}
            panelVisible={this.commandRegistry.isToggled(C_COMMANDS.togglePanel)}
            setDeviceOpen={open => this.layoutState.setDeviceOpen(open)} exec={id => void this.commands.executeCommand(id)}
            openMenu={(path, anchor) => this.openMenu(path, anchor)} projectMenu={NODU_PROJECT_MENU} moreMenu={NODU_MORE_MENU}
            confirm={(title, msg, ok) => new ConfirmDialog({ title, msg, ok, cancel: '取消' }).open().then(v => v === true)}
            tutorButton={tutor} />;
    }

    /** Toolbar dropdowns are ordinary Theia menus anchored under their button. */
    private openMenu(menuPath: string[], anchor: HTMLElement): void {
        this.layoutState.setDeviceOpen(false);
        this.onBeforeMenu?.(menuPath);
        const rect = anchor.getBoundingClientRect();
        this.contextMenu.render({ menuPath, anchor: { x: rect.left, y: rect.bottom + 2 }, context: anchor, includeAnchorArg: false });
    }

    /** Set by the workbench to lazily link submenus owned by other contributions. */
    onBeforeMenu?: (menuPath: string[]) => void;
}

@injectable()
export class ScopeWorkbenchContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution {
    @inject(NoduEmbeddedModel) protected readonly embedded!: NoduEmbeddedModel;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(ScopeToolbar) protected readonly toolbar!: ScopeToolbar;
    @inject(ScopeSession) protected readonly session!: ScopeSession;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    @inject(ScopeVisionContribution) protected readonly vision!: ScopeVisionContribution;
    @inject(ScopeDeviceContribution) protected readonly devices!: ScopeDeviceContribution;
    @inject(ScopeConsoleContribution) protected readonly consoleView!: ScopeConsoleContribution;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileNavigatorContribution) protected readonly navigator!: FileNavigatorContribution;
    @inject(OutputChannelManager) protected readonly output!: OutputChannelManager;
    @inject(OutputContribution) protected readonly outputView!: OutputContribution;
    @inject(StatusBar) protected readonly status!: StatusBar;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(OpenerService) protected readonly opener!: OpenerService;
    @inject(MenuModelRegistry) protected readonly menuRegistry!: MenuModelRegistry;
    @inject(NoduBoardFilesContribution) protected readonly boardFiles!: NoduBoardFilesContribution;
    protected readonly toDispose = new DisposableCollection();
    // Each panel auto-opens at most once per session (first run / first frame);
    // a manual toggle also counts, so a panel the user closed never pops back.
    private readonly autoRevealed = { console: false, vision: false };
    private readonly linkedProjectSubmenus = new Set<string>();
    private layoutQueue: Promise<unknown> = Promise.resolve();
    private layoutApplied = false;
    private syncFrame: number | undefined;
    private geometry = '';
    // Traceback navigation: the editor that started the current run, plus the
    // stderr tail and the highlight ids it produced.
    private runTarget?: { widget: EditorWidget; control: monaco.editor.IStandaloneCodeEditor; model: monaco.editor.ITextModel; version: number; path: string };
    private tracebackTail = '';
    private tracebackDecorations: string[] = [];
    private readonly panelProfiles = {
        simple: { files: false, console: false, vision: false },
        pro: { files: true, console: true, vision: true }
    };

    private serializeLayout(action: () => Promise<unknown>): Promise<unknown> {
        const next = this.layoutQueue.then(action, action);
        this.layoutQueue = next.catch(() => undefined);
        return next;
    }

    private schedulePanelSync(): void {
        if (this.syncFrame !== undefined) { return; }
        this.syncFrame = requestAnimationFrame(() => { this.syncFrame = undefined; this.syncPanels(); });
    }

    private syncPanels(): void {
        const left = this.shell.leftPanelHandler;
        const right = this.shell.rightPanelHandler;
        const files = this.filesWidget();
        const vision = this.vision.tryGetWidget();
        const console = this.consoleView.tryGetWidget();
        this.layoutState.setPanels(!!files?.isVisible && this.shell.getAreaFor(files) === 'left',
            this.layoutState.mode === 'simple' ? !!console?.isVisible && this.shell.getAreaFor(console) === 'bottom' : !this.shell.bottomPanel.isHidden,
            !!vision?.isVisible && this.shell.getAreaFor(vision) === 'right' && right.tabBar.currentTitle?.owner === vision);
        const geometry = `${this.layoutState.mode}:${left.dockPanel.isHidden}:${right.dockPanel.isHidden}`;
        if (geometry !== this.geometry) {
            this.geometry = geometry;
            left.container.fit(); right.container.fit(); this.shell.mainPanel.fit(); this.refitMainTabBars(); this.shell.fit(); this.shell.update();
        }
    }

    private refitMainTabBars(): void {
        // Lumino clamps each tab-area's allocated height to the sizeHint captured at
        // attach time. Mode-scoped CSS changes the natural height (breadcrumbs row,
        // tab height), so re-seat the hints from live measurement before relayout.
        const layout = (this.shell.mainPanel as unknown as { layout?: { _root?: unknown } }).layout;
        const visit = (node: unknown): void => {
            const n = node as { tabBar?: { node: HTMLElement }; sizers?: { sizeHint: number; size: number }[]; children?: ReadonlyArray<unknown> } | undefined;
            if (!n || typeof n !== 'object') { return; }
            if (n.tabBar?.node && n.sizers?.length === 2) {
                const bar = n.tabBar.node;
                bar.style.height = '';
                // Hidden tab areas measure 0; keep their old hint so re-showing them does not collapse.
                const hint = bar.offsetHeight;
                if (hint > 0) { n.sizers[0].sizeHint = hint; n.sizers[0].size = hint; }
            }
            if (n.children) { for (const child of n.children) { visit(child); } }
        };
        if (layout?._root) { visit(layout._root); this.shell.mainPanel.update(); }
    }

    private async settlePanels(): Promise<void> {
        await this.shell.pendingUpdates;
        await Promise.all([this.shell.leftPanelHandler.state.pendingUpdate, this.shell.rightPanelHandler.state.pendingUpdate]);
        this.syncPanels();
    }

    initialize(): void {
        registerScopeLanguages();
        // Apply the mode class before widgets attach: Lumino only measures
        // dock-panel tab-bar height once, at attach/structural change.
        document.body.classList.toggle('nodu-simple', this.layoutState.mode === 'simple');
        document.body.classList.toggle('nodu-pro', this.layoutState.mode === 'pro');
    }

    async onStart(): Promise<void> {
        // The shell's vertical BoxLayout places the product toolbar below the native menu/title area.
        // Leave the top panel intact for Electron window controls and platform menus.
        const shellLayout = this.shell.layout as BoxLayout;
        shellLayout.insertWidget(1, this.toolbar);
        BoxLayout.setStretch(this.toolbar, 0);
        // Editors persist local files; ScopeSession supplies synthetic sample frames.
        const channel = this.output.getChannel('Nodu · 示例');
        this.toDispose.push(this.session.onDidLog(line => channel.appendLine(line)));
        const deviceChannel = this.output.getChannel('Nodu · 设备');
        for (const log of this.device.logs) { deviceChannel.append(log.text, log.stream === 'stderr' ? OutputChannelSeverity.Error : OutputChannelSeverity.Info); }
        this.toDispose.push(this.device.onDidLog(log => {
            deviceChannel.append(log.text, log.stream === 'stderr' ? OutputChannelSeverity.Error : OutputChannelSeverity.Info);
            if (log.stream === 'stderr') { this.followTraceback(log.text); }
        }));
        // Panel geometry, tab activation and external close commands all update the toolbar.
        const observer = new MutationObserver(() => this.schedulePanelSync());
        for (const node of [this.shell.leftPanelHandler.container.node, this.shell.rightPanelHandler.container.node, this.shell.bottomPanel.node]) {
            observer.observe(node, { attributes: true, childList: true, subtree: true, attributeFilter: ['class', 'style', 'hidden'] });
        }
        this.toDispose.push({ dispose: () => { observer.disconnect(); if (this.syncFrame !== undefined) { cancelAnimationFrame(this.syncFrame); } } });
        this.toDispose.push(this.shell.onDidChangeActiveWidget(() => this.schedulePanelSync()));
        this.toDispose.push(this.shell.onDidChangeCurrentWidget(() => this.schedulePanelSync()));
        this.toDispose.push(this.shell.onDidAddWidget(() => this.schedulePanelSync()));
        this.toDispose.push(this.shell.onDidRemoveWidget(() => this.schedulePanelSync()));
        for (const commandId of HIDDEN_FILE_MENU_COMMANDS) { this.menuRegistry.unregisterMenuAction(commandId, CommonMenus.FILE); }
        this.toolbar.onBeforeMenu = path => { if (path === NODU_PROJECT_MENU) { this.linkProjectSubmenus(); } };
        let lastDeviceStatus = '';
        this.toDispose.push(this.device.onDidChange(() => {
            if (this.device.frame && !this.autoRevealed.vision) { this.autoReveal('vision'); }
            const next = `${this.device.statusLabel}:${this.device.state.port || ''}:${this.device.state.fps ?? ''}:${this.device.state.firmware ?? ''}`;
            if (next !== lastDeviceStatus) { lastDeviceStatus = next; this.updateStatus(); }
        }));
        let lastRunning = this.session.running;
        this.toDispose.push(this.session.onDidChange(() => {
            if (lastRunning !== this.session.running) { lastRunning = this.session.running; this.updateStatus(); }
        }));
        this.toDispose.push(this.workspace.onWorkspaceChanged(roots => this.layoutState.setProject(roots[0]?.resource.path.base || '打开项目')));
        void this.workspace.roots.then(roots => this.layoutState.setProject(roots[0]?.resource.path.base || '打开项目'));
        this.updateStatus();
    }

    async initializeLayout(): Promise<void> {
        await this.navigator.openView({ activate: false });
        await this.vision.openView({ activate: false });
        await this.outputView.openView({ activate: false });
        this.output.getChannel('Nodu · 设备').show({ preserveFocus: true });
        this.shell.resize(220, 'left');
        this.shell.resize(420, 'right');
        this.shell.resize(160, 'bottom');
        const root = (await this.workspace.roots)[0];
        if (root) {
            // Only open files that exist; never create or overwrite a user's project on startup.
            for (const file of ['thresholds.py', 'camera.py', 'main.py', 'main/main.c']) {
                const uri = root.resource.resolve(file);
                if (await this.files.exists(uri)) { await this.editors.open(uri, { mode: 'activate' }); }
            }
        }
    }

    async onDidInitializeLayout(): Promise<void> { await this.serializeLayout(() => this.applyLayout(this.layoutState.mode)); }
    onStop(): void { this.clearTracebackDecoration(); this.toDispose.dispose(); this.session.dispose(); this.device.dispose(); }

    protected updateStatus(): void {
        // Original right-side items keep the label with an empty value while
        // disconnected; FPS stays visible in simple mode like before.
        const fps = this.device.state.fps;
        void this.status.setElement('scope:fps', { text: fpsStatusText(fps), alignment: StatusBarAlignment.RIGHT, priority: 80, className: 'nodu-statusbar-fps', tooltip: '可能与摄像头帧率(FPS)不同', accessibilityInformation: { label: typeof fps === 'number' ? `帧缓冲帧率 ${fps.toFixed(1)} FPS` : '帧缓冲帧率', role: 'status' } });
        if (this.layoutState.mode === 'simple') {
            this.status.removeElement('scope:device'); this.status.removeElement('scope:demo');
            this.status.removeElement('scope:firmware'); this.status.removeElement('scope:serial-port');
            return;
        }
        const fw = this.device.state.firmware ? ` · ${this.device.state.firmware.split(' ').slice(0, 2).join(' ')}` : '';
        void this.status.setElement('scope:device', { text: `$(${this.device.connected ? 'plug' : 'debug-disconnect'}) ${this.device.statusLabel}${this.device.state.port ? ` · ${this.device.state.port}` : ''}${fw}`, alignment: StatusBarAlignment.LEFT, priority: 1000, command: 'scope.show-devices', tooltip: this.device.error || '管理设备', color: this.device.connected ? 'var(--theia-scope-ok)' : undefined });
        void this.status.setElement('scope:firmware', { text: firmwareStatusText(this.device.state.firmware), alignment: StatusBarAlignment.RIGHT, priority: 100, command: 'scope.firmware-releases', tooltip: '点击查看最新的固件版本及说明', accessibilityInformation: { label: `固件版本 ${this.device.state.firmware ?? '无'}`, role: 'button' } });
        void this.status.setElement('scope:serial-port', { text: serialPortStatusText(this.device.state.port), alignment: StatusBarAlignment.RIGHT, priority: 90, tooltip: '开发板串口', accessibilityInformation: { label: `串行端口 ${this.device.state.port || '无'}`, role: 'status' } });
        if (this.session.running) {
            void this.status.setElement('scope:demo', { text: '$(play) 示例播放中', alignment: StatusBarAlignment.LEFT, priority: 990, command: 'scope.show-demo-logs', tooltip: '查看示例日志' });
        } else {
            this.status.removeElement('scope:demo');
        }
    }

    protected async applyLayout(mode: 'simple' | 'pro'): Promise<void> {
        if (this.layoutApplied) {
            this.syncPanels();
            this.panelProfiles[this.layoutState.mode] = { files: this.layoutState.filesVisible, console: this.layoutState.consoleVisible, vision: this.layoutState.visionVisible };
        }
        this.layoutState.setMode(mode);
        // Simple mode has no AI; also close a sidebar restored from a professional-mode layout.
        const tutor = mode === 'simple' ? this.shell.getWidgetById(NoduTutorWidget.ID) : undefined;
        if (tutor) { await this.shell.closeWidget(tutor.id); }
        document.body.classList.toggle('nodu-simple', mode === 'simple');
        document.body.classList.toggle('nodu-pro', mode === 'pro');
        this.layoutState.setDeviceOpen(false);
        // Remove restored legacy settings containers; the form now lives once in the toolbar.
        const legacy = this.devices.tryGetWidget();
        if (legacy && this.shell.getAreaFor(legacy)) { await this.shell.closeWidget(legacy.id); }
        await this.ensureSimplePanel(this.filesWidget(), 'left');
        await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right');
        await this.ensureSimplePanel(this.consoleView.tryGetWidget(), 'bottom');
        await Promise.all([this.shell.collapsePanel('left'), this.shell.collapsePanel('right'), this.shell.collapsePanel('bottom')]);
        // Professional mode docks 开发板文件 beside the local explorer (added, not revealed).
        if (mode === 'pro' && !this.boardFiles.tryGetWidget()?.isAttached) { await this.boardFiles.openView({ activate: false, reveal: false }); }
        const profile = this.panelProfiles[mode];
        if (profile.files) { await this.navigator.openView({ reveal: true, activate: false }); }
        if (profile.vision) { await this.vision.openView({ reveal: true, activate: false }); }
        if (profile.console) { await this.showConsole(false); }
        this.layoutApplied = true;
        this.updateStatus();
        await this.settlePanels();
    }

    private async ensureSimplePanel(widget: Widget | undefined, area: 'left' | 'right' | 'bottom'): Promise<void> {
        // Reparent the same auxiliary widget if it was dragged in professional mode.
        if (this.layoutState.mode === 'simple' && widget && this.shell.getAreaFor(widget) !== area) {
            await this.shell.addWidget(widget, { area });
        }
    }

    private filesWidget(): Widget | undefined {
        // Explorer's shell widget is its ViewContainer, not the nested file tree.
        return this.shell.getWidgetById(this.navigator.effectiveWidgetId);
    }

    private async showConsole(activate: boolean): Promise<void> {
        if (this.layoutState.mode === 'simple') {
            await this.ensureSimplePanel(await this.consoleView.widget, 'bottom');
            await this.consoleView.openView({ area: 'bottom', reveal: true, activate });
        } else {
            this.output.getChannel('Nodu · 设备').show({ preserveFocus: !activate });
            await this.outputView.openView({ reveal: true, activate });
        }
    }

    /** 示例 / 最近的文件 live under the 文件 menu (NoduFileDocsContribution); link, never copy. */
    private linkProjectSubmenus(): void {
        const submenus: [string, string][] = [['examples', '0'], ['recent', '1'], ['documents', '2']];
        for (const [id, order] of submenus) {
            if (this.linkedProjectSubmenus.has(id)) { continue; }
            const submenuPath = [...CommonMenus.FILE, '2z_nodu', id];
            if (!this.menuRegistry.getMenu(submenuPath)) { continue; }
            try {
                this.toDispose.push(this.menuRegistry.linkCompoundMenuNode({ newParentPath: [...NODU_PROJECT_MENU, '2_browse'], submenuPath, order }));
                this.linkedProjectSubmenus.add(id);
            } catch { /* Submenu not ready (examples still loading); retry on next open. */ }
        }
    }

    private autoReveal(panel: 'console' | 'vision'): void {
        // Frames may already be flowing when the page loads; the startup layout would collapse the
        // panel again and the one-shot would be spent. Keep it for the first frame after layout.
        if (this.autoRevealed[panel] || !this.layoutApplied) { return; }
        this.autoRevealed[panel] = true;
        void this.serializeLayout(async () => {
            this.syncPanels();
            if (panel === 'console' && !this.layoutState.consoleVisible) { await this.showConsole(false); }
            if (panel === 'vision' && !this.layoutState.visionVisible) {
                await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right');
                await this.vision.openView({ reveal: true, activate: false });
            }
            await this.settlePanels();
        });
    }

    private async toggleFiles(): Promise<void> {
        await this.ensureSimplePanel(this.filesWidget(), 'left');
        this.syncPanels();
        if (this.layoutState.filesVisible) { await this.shell.collapsePanel('left'); }
        else { await this.navigator.openView({ reveal: true, activate: false }); }
        await this.settlePanels();
    }

    private async toggleVision(): Promise<void> {
        this.autoRevealed.vision = true;
        await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right');
        this.syncPanels();
        this.layoutState.setDeviceOpen(false);
        if (this.layoutState.visionVisible) { await this.shell.collapsePanel('right'); }
        else { await this.vision.openView({ reveal: true, activate: false }); }
        await this.settlePanels();
    }

    private async toggleConsole(): Promise<void> {
        this.autoRevealed.console = true;
        await this.ensureSimplePanel(this.consoleView.tryGetWidget(), 'bottom');
        this.syncPanels();
        if (this.layoutState.consoleVisible) { await this.shell.collapsePanel('bottom'); }
        else { await this.showConsole(true); }
        await this.settlePanels();
    }

    registerCommands(registry: CommandRegistry): void {
        const deviceCommands = new Set(['scope.run-current', 'scope.stop-device', 'scope.toggle-run', 'scope.toggle-connect', 'scope.reset-device', 'scope.show-devices']);
        const command = (id: string, label: string, execute: () => unknown, proOnly = false) => {
            const available = () => (!proOnly || this.layoutState.mode === 'pro') && (!deviceCommands.has(id) || (!this.embedded.isC && !this.embedded.isEsp));
            return registry.registerCommand({ id, label, category: '见微 Nodu' }, { execute, isVisible: available, isEnabled: available });
        };
        registry.registerCommand({ id: 'scope.layout.simple', label: '简洁模式', category: '见微 Nodu' }, {
            execute: () => this.serializeLayout(() => this.applyLayout('simple')), isToggled: () => this.layoutState.mode === 'simple',
        });
        registry.registerCommand({ id: 'scope.layout.pro', label: '专业模式', category: '见微 Nodu' }, {
            execute: () => this.serializeLayout(() => this.applyLayout('pro')), isToggled: () => this.layoutState.mode === 'pro',
        });
        const panel = (id: string, label: string, execute: () => Promise<void>, visible: () => boolean) => registry.registerCommand({ id, label, category: '见微 Nodu' }, { execute: () => this.serializeLayout(execute), isToggled: visible });
        panel('scope.toggle-files', '文件列表', () => this.toggleFiles(), () => this.layoutState.filesVisible);
        panel('scope.toggle-console', '串行终端', () => this.toggleConsole(), () => this.layoutState.consoleVisible);
        panel('scope.toggle-vision', '帧缓冲', () => this.toggleVision(), () => this.layoutState.visionVisible);
        command('scope.show-files', '显示项目文件', () => this.serializeLayout(async () => { await this.ensureSimplePanel(this.filesWidget(), 'left'); await this.navigator.openView({ activate: true }); await this.settlePanels(); }));
        command('scope.show-vision', '显示帧缓冲', () => this.serializeLayout(async () => { await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right'); await this.vision.openView({ activate: true }); await this.settlePanels(); }));
        command('scope.show-devices', '显示设备与连接', () => this.layoutState.setDeviceOpen(true));
        command('scope.run-current', '运行当前代码', () => this.runCurrentEditor());
        command('scope.stop-device', '停止脚本 / 取消设备操作', () => this.device.stop());
        // Original IDE shortcuts: Ctrl/⌘+R toggles run/stop, Ctrl/⌘+E toggles connect.
        command('scope.toggle-run', '运行 / 停止', () => { if (this.device.state.running || this.device.busy) { void this.device.stop(); } else { void this.runCurrentEditor(); } });
        command('scope.toggle-connect', '连接 / 断开设备', () => {
            const phase = this.device.state.phase;
            if (this.device.connected || this.device.busy || phase === 'connecting') { void this.device.disconnect(); return; }
            if (this.device.selectedPort) { void this.device.connect(); return; }
            this.layoutState.setDeviceOpen(true);
            void this.device.scanPorts();
        });
        command('scope.reset-device', '复位设备', () => this.device.resetDevice());
        // The toggle stays inside the two product themes; other registered themes stay reachable via command palette.
        command('scope.toggle-theme', '切换深浅主题', () => this.themes.setCurrentTheme(getThemeMode(this.themes.getCurrentTheme().type) === 'dark' ? SCOPE_LIGHT_THEME_ID : SCOPE_THEME_ID));
        command('scope.run-demo', '播放 / 暂停示例', async () => { const widget = await this.vision.openView({ activate: true }); widget.showLocalDemo(); this.session.toggleRun(); }, true);
        command('scope.show-logs', '显示设备日志', () => this.serializeLayout(async () => { await this.showConsole(true); await this.settlePanels(); }));
        command('scope.show-demo-logs', '显示示例日志', () => { this.output.getChannel('Nodu · 示例').show(); return this.outputView.openView({ activate: true }); }, true);
        command('scope.apply-thresholds', '复制示例 LAB 参数', () => this.applyThresholds(), true);
        command('scope.firmware-releases', '最新固件版本及说明', () => open(this.opener, new URI(MAIXPY_RELEASES_URL)).catch(error => this.messages.error(`固件版本：${error instanceof Error ? error.message : String(error)}`)));
        // Original 工具 ▸ 选择开发板: the ids are the reset-sequence indices
        // persisted as nodu.board-id; the panel applies the same
        // connected/busy disable rule to its select.
        for (const entry of BOARD_MENU) {
            registry.registerCommand({ id: `scope.select-board.${entry.boardId}`, label: entry.label, category: '见微 Nodu' }, {
                execute: () => this.device.selectBoardId(entry.boardId),
                isToggled: () => this.device.boardId === entry.boardId,
                isEnabled: () => !this.device.connected && !this.device.busy,
            });
        }
        // Electron-only 窗口 menu commands (browser keeps them out of the palette).
        registry.registerCommand({ id: 'scope.window-minimize', label: '最小化', category: '见微 Nodu' }, {
            execute: () => { if (window.electronTheiaCore) { window.electronTheiaCore.minimize(); } },
            isVisible: () => environment.electron.is(),
        });
        registry.registerCommand({ id: 'scope.window-zoom', label: '缩放', category: '见微 Nodu' }, {
            execute: () => {
                if (!window.electronTheiaCore) { return; }
                if (window.electronTheiaCore.isMaximized()) { window.electronTheiaCore.unMaximize(); }
                else { window.electronTheiaCore.maximize(); }
            },
            isVisible: () => environment.electron.is(),
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const menu = [...MAIN_MENU_BAR, '5_scope'];
        menus.registerSubmenu(menu, '工具');
        const boards = [...menu, TOOLS_MENU_GROUPS.boardSubmenu];
        menus.registerSubmenu(boards, '选择开发板', { sortString: '0' });
        BOARD_MENU.forEach((entry, order) => {
            menus.registerMenuAction(boards, { commandId: `scope.select-board.${entry.boardId}`, order: String(order) });
        });
        const nodu = [...menu, TOOLS_MENU_GROUPS.noduGroup];
        for (const [order, commandId] of ['scope.run-current', 'scope.stop-device', 'scope.reset-device', 'scope.show-vision', 'scope.show-devices', 'scope.board-guide', 'scope.show-logs', 'scope.toggle-theme', 'scope.layout.simple', 'scope.layout.pro'].entries()) {
            menus.registerMenuAction(nodu, { commandId, order: String(order) });
        }
        // 项目 ▾: new/open, then examples + recent (linked lazily, see linkProjectSubmenus), then save.
        const electronSplitOpen = !isOSX && environment.electron.is();
        menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: 'scope.new-script', label: '新建文件', order: '0' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: electronSplitOpen ? 'workspace:openFile' : 'workspace:open', label: '打开…', order: '1' });
        if (electronSplitOpen) { menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: 'workspace:openFolder', label: '打开文件夹…', order: '2' }); }
        menus.registerMenuAction([...NODU_PROJECT_MENU, '3_save'], { commandId: CommonCommands.SAVE.id, label: '保存到电脑', order: '0' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '3_save'], { commandId: CommonCommands.SAVE_AS.id, label: '另存为…', order: '1' });
        // 运行 ▾: the three distinct "where does this code go" semantics.
        menus.registerMenuAction([...NODU_RUN_MENU, '1_run'], { commandId: 'scope.run-current', label: '运行（开发板内存，不保存）', order: '0' });
        menus.registerMenuAction([...NODU_RUN_MENU, '2_board'], { commandId: 'scope.save-current-to-board', label: '保存到开发板…', order: '0' });
        menus.registerMenuAction([...NODU_RUN_MENU, '2_board'], { commandId: 'scope.save-boot-script', label: '设为开机脚本（boot.py）…', order: '1' });
        menus.registerMenuAction([...NODU_RUN_MENU, '3_other'], { commandId: 'scope.send-file', label: '发送其他文件到开发板…', order: '0' });
        // ⋯: rarely used chrome, also reachable from 查看 and the command palette.
        menus.registerMenuAction([...NODU_MORE_MENU, '1_view'], { commandId: 'scope.toggle-theme', order: '0' });
        menus.registerMenuAction([...NODU_MORE_MENU, '2_mode'], { commandId: 'scope.layout.simple', order: '0' });
        menus.registerMenuAction([...NODU_MORE_MENU, '2_mode'], { commandId: 'scope.layout.pro', order: '1' });
        menus.registerMenuAction([...NODU_MORE_MENU, '3_app'], { commandId: 'workbench.action.showCommands', label: '命令面板', order: '0' });
        menus.registerMenuAction([...NODU_MORE_MENU, '3_app'], { commandId: CommonCommands.OPEN_PREFERENCES.id, label: '设置', order: '1' });
        menus.registerMenuAction([...NODU_MORE_MENU, '3_app'], { commandId: 'scope.about', order: '2' });
        // 查看: layout mode and the three panels.
        for (const [order, commandId] of ['scope.layout.simple', 'scope.layout.pro', 'scope.toggle-files', 'scope.toggle-console', 'scope.toggle-vision'].entries()) {
            menus.registerMenuAction(CommonMenus.VIEW_LAYOUT, { commandId, order: `0_nodu_${order}` });
        }
        const demoMenu = [...nodu, 'local-demo'];
        menus.registerSubmenu(demoMenu, '示例', { sortString: 'z' });
        for (const [order, commandId] of ['scope.run-demo', 'scope.apply-thresholds', 'scope.show-demo-logs'].entries()) { menus.registerMenuAction(demoMenu, { commandId, order: String(order) }); }
        if (environment.electron.is()) {
            // Theia registers workbench.action.toggleFullScreen (⌃⌘F) only in
            // Electron builds; the browser never gets a 窗口 menu.
            const windowMenu = [...MAIN_MENU_BAR, '8_window'];
            menus.registerSubmenu(windowMenu, '窗口');
            menus.registerMenuAction(windowMenu, { commandId: 'scope.window-minimize', order: '0' });
            menus.registerMenuAction(windowMenu, { commandId: 'scope.window-zoom', order: '1' });
            menus.registerMenuAction(windowMenu, { commandId: 'workbench.action.toggleFullScreen', label: '进入全屏', order: '2' });
        }
    }

    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: 'scope.run-current', keybinding: 'ctrlcmd+enter', when: 'editorTextFocus && !nodu.cProject && !nodu.espProject' });
        // Inside a terminal these keys forward raw bytes instead (terminalFocus).
        keys.registerKeybinding({ command: 'scope.toggle-run', keybinding: 'ctrlcmd+r', when: '!terminalFocus && !nodu.cProject && !nodu.espProject' });
        keys.registerKeybinding({ command: 'scope.toggle-connect', keybinding: 'ctrlcmd+e', when: '!terminalFocus && !nodu.cProject && !nodu.espProject' });
        if (environment.electron.is()) {
            // Original 窗口 ▸ 最小化 accelerator (⌘M on macOS).
            keys.registerKeybinding({ command: 'scope.window-minimize', keybinding: 'ctrlcmd+m' });
        }
    }

    protected async runCurrentEditor(): Promise<void> {
        if (!this.device.connected) {
            this.layoutState.setDeviceOpen(true);
            await this.messages.info('请先连接设备。');
            return;
        }
        if (this.device.busy || this.device.state.running) { await this.messages.info('设备正在运行或处理操作。请先停止 / 取消，再运行脚本。'); return; }
        if (!this.device.state.capabilities.script) { this.device.reportError('运行脚本', new Error('当前固件不支持脚本运行。')); return; }
        const widget = this.editors.currentEditor;
        if (!widget) { await this.messages.info('请先打开要运行的 Python 文件。'); return; }
        const editor = MonacoEditor.get(widget)?.getControl();
        const model = editor?.getModel();
        if (model && model.getLanguageId() !== 'python' && !widget.editor.uri.path.toString().toLowerCase().endsWith('.py')) { await this.messages.info('请打开 Python 文件，再运行到设备。'); return; }
        // Run Monaco's current buffer, including unsaved changes.
        const code = model?.getValue() ?? widget.editor.document.getText();
        if (!code.trim()) { await this.messages.info('当前代码为空，请输入 Python 代码。'); return; }
        // Clear the previous run's decoration first: the stored ids belong to
        // the old run's model and must be removed on that model, not the new one.
        this.clearTracebackDecoration();
        // Beginners otherwise see no reaction: the output lands in a hidden panel.
        this.autoReveal('console');
        // Traceback frames resolve only against this exact buffer and version.
        if (editor && model) {
            this.runTarget = { widget, control: editor, model, version: model.getVersionId(), path: widget.editor.uri.path.toString() };
        } else {
            this.runTarget = undefined;
        }
        await this.device.runScript(code, widget.editor.uri.path.base || '当前 Python 代码');
    }

    /**
     * Follow stderr `File "…", line n` frames from a device traceback onto the
     * editor that produced the running script. Only `<stdin>` or the captured
     * source path/basename map to it; board-internal paths are logged but
     * never open foreign files. A moved/edited/disposed buffer is skipped.
     */
    private followTraceback(text: string): void {
        const target = this.runTarget;
        if (!target || target.widget.isDisposed || target.model.isDisposed()
            || target.control.getModel() !== target.model || target.model.getVersionId() !== target.version) {
            return;
        }
        this.tracebackTail = (this.tracebackTail + text).slice(-16384);
        const frames = /File "([^"\n]+)", line (\d+)/g;
        let match: RegExpExecArray | null;
        let line = 0;
        while ((match = frames.exec(this.tracebackTail)) !== null) {
            const name = match[1];
            if (name === '<stdin>' || name === target.path || name.split('/').pop() === target.path.split('/').pop()) {
                line = parseInt(match[2], 10);
            }
        }
        if (!line || !Number.isInteger(line) || line < 1 || line > target.model.getLineCount()) { return; }
        target.control.revealLineInCenter(line);
        target.control.setPosition({ lineNumber: line, column: 1 });
        this.tracebackDecorations = target.model.deltaDecorations(this.tracebackDecorations, [{
            range: new monaco.Range(line, 1, line, target.model.getLineMaxColumn(line)),
            options: { isWholeLine: true, className: 'nodu-traceback-line' },
        }]);
    }

    private clearTracebackDecoration(): void {
        const target = this.runTarget;
        if (target && !target.model.isDisposed() && this.tracebackDecorations.length) {
            target.model.deltaDecorations(this.tracebackDecorations, []);
        }
        this.tracebackDecorations = [];
        this.tracebackTail = '';
    }

    protected async applyThresholds(): Promise<void> {
        // Sample thresholds are copied to the clipboard without editing source files.
        await copyImageParameters(this.clipboard, `(${this.session.threshold.join(', ')})`);
        void this.messages.info('已复制示例 LAB 参数。');
    }
}
