// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { BoxLayout, Widget } from '@theia/core/shared/@lumino/widgets';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService, DisposableCollection, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { FrontendApplicationContribution, ApplicationShell, KeybindingContribution, KeybindingRegistry, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileNavigatorContribution } from '@theia/navigator/lib/browser/navigator-contribution';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
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
import { NoduBrand } from './scope-brand';
export { ScopeLayoutState } from './scope-layout-state';

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
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(EditorManager) protected readonly editors!: EditorManager;

    @postConstruct()
    protected init(): void {
        this.id = 'scope:toolbar';
        this.addClass('scope-toolbar-widget');
        this.toDispose.push(this.device.onDidChange(() => this.update()));
        this.toDispose.push(this.layoutState.onDidChange(() => this.update()));
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
        const simple = this.layoutState.mode === 'simple';
        const board = this.device.boardProfile === 'embedfire-cam-gc2145' ? '野火 K210 CAM' : 'K210';
        const port = (this.device.state.port || this.device.selectedPort).split('/').pop() || '选择端口';
        return <header className="scope-workspace-bar" aria-label="Nodu 工具栏">
            <div className="scope-toolbar-start">
                <NoduBrand />
                <button className="scope-action scope-toolbar-files" aria-label="文件" aria-pressed={this.layoutState.filesVisible} onClick={() => void this.commands.executeCommand('scope.toggle-files')} title="文件"><i className="codicon codicon-files" aria-hidden="true"/>文件</button>
                <button className="scope-action scope-action-primary scope-toolbar-run" disabled={this.device.busy || this.device.state.running} onClick={() => void this.commands.executeCommand('scope.run-current')} title="运行 · Ctrl / ⌘ Enter"><i className="codicon codicon-play" aria-hidden="true"/>运行</button>
                <button className="scope-action scope-toolbar-icon nodu-toolbar-stop" aria-label="停止" disabled={!this.device.canStop} onClick={() => void this.commands.executeCommand('scope.stop-device')} title="停止"><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>
                <div className="scope-device-picker">
                    <button className={`scope-action scope-device-chip ${this.device.connected ? 'nodu-is-connected' : ''} ${this.device.error ? 'nodu-has-error' : ''}`} aria-label="设备与端口" aria-haspopup="dialog" aria-controls="scope-device-popover" aria-expanded={this.layoutState.deviceOpen} aria-pressed={this.layoutState.deviceOpen} onClick={() => this.layoutState.setDeviceOpen(!this.layoutState.deviceOpen)} title={this.device.error || '设备与端口'}><i className="codicon codicon-circuit-board" aria-hidden="true"/><span className="scope-device-chip-board">{board}</span><span className="scope-device-chip-port">{port}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/></button>
                    {/* One permanently mounted form owns drafts/confirmations across popover and mode changes. */}
                    <div id="scope-device-popover" className="scope-device-popover scope-widget" role="dialog" aria-label="设备设置" hidden={!this.layoutState.deviceOpen}>
                        <NoduDevicePanel model={this.device} files={this.files} dialogs={this.dialogs} editors={this.editors} compact={simple} showLogs={() => void this.commands.executeCommand('scope.show-logs')} />
                    </div>
                </div>
            </div>
            <div className="scope-toolbar-project"><span className="scope-project-name">{this.layoutState.project}</span></div>
            <div className="scope-toolbar-end">
            <button className={`scope-action scope-toolbar-icon scope-toolbar-console ${this.device.error ? 'nodu-has-error' : ''}`} aria-label="控制台" aria-pressed={this.layoutState.consoleVisible} onClick={() => void this.commands.executeCommand('scope.toggle-console')} title="控制台"><i className="codicon codicon-terminal" aria-hidden="true"/></button>
            <button className="scope-layout-icon" aria-label={this.layoutState.mode === 'simple' ? '切换到专业模式' : '切换到简洁模式'} aria-pressed={this.layoutState.mode === 'pro'} title={this.layoutState.mode === 'simple' ? '切换到专业模式' : '切换到简洁模式'} onClick={() => void this.commands.executeCommand(this.layoutState.mode === 'simple' ? 'scope.layout.pro' : 'scope.layout.simple')}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>{this.layoutState.mode === 'pro' && <path d="M7 4v16M7 15h8"/>}</svg>
            </button>
            <button className="scope-action scope-toolbar-icon scope-toolbar-vision" aria-label="视觉" aria-pressed={this.layoutState.visionVisible} onClick={() => void this.commands.executeCommand('scope.toggle-vision')} title="视觉"><i className="codicon codicon-device-camera" aria-hidden="true"/></button>
            </div>
        </header>;
    }
}

@injectable()
export class ScopeWorkbenchContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution {
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
    protected readonly toDispose = new DisposableCollection();
    private layoutQueue: Promise<unknown> = Promise.resolve();
    private layoutApplied = false;
    private syncFrame: number | undefined;
    private geometry = '';
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
            left.container.fit(); right.container.fit(); this.shell.fit(); this.shell.update();
        }
    }

    private async settlePanels(): Promise<void> {
        await this.shell.pendingUpdates;
        await Promise.all([this.shell.leftPanelHandler.state.pendingUpdate, this.shell.rightPanelHandler.state.pendingUpdate]);
        this.syncPanels();
    }

    initialize(): void { registerScopeLanguages(); }

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
        let lastDeviceStatus = '';
        this.toDispose.push(this.device.onDidChange(() => {
            const next = `${this.device.statusLabel}:${this.device.state.port || ''}`;
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
            for (const file of ['thresholds.py', 'camera.py', 'main.py']) {
                const uri = root.resource.resolve(file);
                if (await this.files.exists(uri)) { await this.editors.open(uri, { mode: 'activate' }); }
            }
        }
    }

    async onDidInitializeLayout(): Promise<void> { await this.serializeLayout(() => this.applyLayout(this.layoutState.mode)); }
    onStop(): void { this.toDispose.dispose(); this.session.dispose(); this.device.dispose(); }

    protected updateStatus(): void {
        if (this.layoutState.mode === 'simple') {
            this.status.removeElement('scope:device'); this.status.removeElement('scope:demo');
            return;
        }
        void this.status.setElement('scope:device', { text: `$(${this.device.connected ? 'plug' : 'debug-disconnect'}) ${this.device.statusLabel}${this.device.state.port ? ` · ${this.device.state.port}` : ''}`, alignment: StatusBarAlignment.LEFT, priority: 1000, command: 'scope.show-devices', tooltip: this.device.error || '管理设备', color: this.device.connected ? 'var(--theia-terminal-ansiBrightGreen, #64C5AC)' : undefined });
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

    private async toggleFiles(): Promise<void> {
        await this.ensureSimplePanel(this.filesWidget(), 'left');
        this.syncPanels();
        if (this.layoutState.filesVisible) { await this.shell.collapsePanel('left'); }
        else { await this.navigator.openView({ reveal: true, activate: false }); }
        await this.settlePanels();
    }

    private async toggleVision(): Promise<void> {
        await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right');
        this.syncPanels();
        this.layoutState.setDeviceOpen(false);
        if (this.layoutState.visionVisible) { await this.shell.collapsePanel('right'); }
        else { await this.vision.openView({ reveal: true, activate: false }); }
        await this.settlePanels();
    }

    private async toggleConsole(): Promise<void> {
        await this.ensureSimplePanel(this.consoleView.tryGetWidget(), 'bottom');
        this.syncPanels();
        if (this.layoutState.consoleVisible) { await this.shell.collapsePanel('bottom'); }
        else { await this.showConsole(true); }
        await this.settlePanels();
    }

    registerCommands(registry: CommandRegistry): void {
        const command = (id: string, label: string, execute: () => unknown, proOnly = false) => registry.registerCommand({ id, label, category: '见微 Nodu' }, { execute, isVisible: () => !proOnly || this.layoutState.mode === 'pro', isEnabled: () => !proOnly || this.layoutState.mode === 'pro' });
        command('scope.layout.simple', '切换简洁布局', () => this.serializeLayout(() => this.applyLayout('simple')));
        command('scope.layout.pro', '切换专业布局', () => this.serializeLayout(() => this.applyLayout('pro')));
        command('scope.toggle-files', '文件', () => this.serializeLayout(() => this.toggleFiles()));
        command('scope.toggle-vision', '视觉', () => this.serializeLayout(() => this.toggleVision()));
        command('scope.toggle-console', '控制台', () => this.serializeLayout(() => this.toggleConsole()));
        command('scope.show-files', '显示项目文件', () => this.serializeLayout(async () => { await this.ensureSimplePanel(this.filesWidget(), 'left'); await this.navigator.openView({ activate: true }); await this.settlePanels(); }));
        command('scope.show-vision', '显示视觉调试', () => this.serializeLayout(async () => { await this.ensureSimplePanel(this.vision.tryGetWidget(), 'right'); await this.vision.openView({ activate: true }); await this.settlePanels(); }));
        command('scope.show-devices', '显示设备与连接', () => this.layoutState.setDeviceOpen(true));
        command('scope.run-current', '运行当前代码', () => this.runCurrentEditor());
        command('scope.stop-device', '停止脚本 / 取消设备操作', () => this.device.stop());
        command('scope.run-demo', '播放 / 暂停示例', async () => { const widget = await this.vision.openView({ activate: true }); widget.showLocalDemo(); this.session.toggleRun(); }, true);
        command('scope.show-logs', '显示设备日志', () => this.serializeLayout(async () => { await this.showConsole(true); await this.settlePanels(); }));
        command('scope.show-demo-logs', '显示示例日志', () => { this.output.getChannel('Nodu · 示例').show(); return this.outputView.openView({ activate: true }); }, true);
        command('scope.apply-thresholds', '复制示例 LAB 参数', () => this.applyThresholds(), true);
    }

    registerMenus(menus: MenuModelRegistry): void {
        const menu = [...MAIN_MENU_BAR, '5_scope'];
        menus.registerSubmenu(menu, '见微');
        for (const [order, commandId] of ['scope.run-current', 'scope.stop-device', 'scope.show-vision', 'scope.show-devices', 'scope.show-logs', 'scope.layout.simple', 'scope.layout.pro'].entries()) {
            menus.registerMenuAction(menu, { commandId, order: String(order) });
        }
        const demoMenu = [...menu, 'local-demo'];
        menus.registerSubmenu(demoMenu, '示例', { sortString: '9' });
        for (const [order, commandId] of ['scope.run-demo', 'scope.apply-thresholds', 'scope.show-demo-logs'].entries()) { menus.registerMenuAction(demoMenu, { commandId, order: String(order) }); }
    }

    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: 'scope.run-current', keybinding: 'ctrlcmd+enter', when: 'editorTextFocus' });
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
        await this.device.runScript(code, widget.editor.uri.path.base || '当前 Python 代码');
    }

    protected async applyThresholds(): Promise<void> {
        // Sample thresholds are copied to the clipboard without editing source files.
        await copyImageParameters(this.clipboard, `(${this.session.threshold.join(', ')})`);
        void this.messages.info('已复制示例 LAB 参数。');
    }
}
