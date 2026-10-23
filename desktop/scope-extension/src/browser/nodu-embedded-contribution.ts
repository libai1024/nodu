// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { NoduProjectDialog, ModuleForm, ProjectSettings, ToolkitInfo } from './nodu-project-dialogs';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService, MAIN_MENU_BAR, MenuContribution, MenuModelRegistry, MessageService } from '@theia/core/lib/common';
import { URI } from '@theia/core/lib/common/uri';
import { ApplicationShell, CommonCommands, CommonMenus, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { StatusBarImpl, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { EmbeddedError, NoduEmbeddedModel, PanelTab } from './nodu-embedded-model';
import { NoduEmbeddedPanel } from './nodu-embedded-panel';
import { NoduNewProjectDialog } from './nodu-new-project';
import { NODU_PROJECT_MENU } from './scope-workbench';
import { ScopeLayoutState } from './scope-layout-state';
import { C_COMMANDS, NODU_C_RUN_MENU } from './nodu-embedded-commands';
import { NoduDownloadHelpDialog, downloadHelpContent } from './nodu-download-help';
import { downloadStatusText } from '../common/nodu-download-status';

export { C_COMMANDS };

@injectable()
export class NoduEmbeddedPanelContribution extends AbstractViewContribution<NoduEmbeddedPanel> {
    constructor() {
        super({ widgetId: NoduEmbeddedPanel.ID, widgetName: NoduEmbeddedPanel.LABEL, defaultWidgetOptions: { area: 'bottom', rank: 40 } });
    }
}

/** Commands, keys and menus of the STM32 C workbench; inert until a C project is open. */
@injectable()
export class NoduEmbeddedContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(NoduEmbeddedPanelContribution) protected readonly panel!: NoduEmbeddedPanelContribution;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(MenuModelRegistry) protected readonly menus!: MenuModelRegistry;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(StatusBarImpl) protected readonly status!: StatusBarImpl;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    private openedFor = '';
    private helpOpen = false;
    private readonly versionNotices = new Set<string>();

    onStart(): void {
        const watchEditor = (widget: EditorWidget): void => {
            const subscription = widget.editor.onDocumentContentChanged(() => this.model.sourceChanged(widget.editor.uri.path.fsPath(), true));
            widget.disposed.connect(() => subscription.dispose());
        };
        this.editors.all.forEach(watchEditor);
        this.editors.onCreated(watchEditor);
        this.files.onDidFilesChange(event => event.changes.forEach(change => this.model.sourceChanged(change.resource.path.fsPath())));
        const statusNode = this.status.node;
        if (statusNode) {
            const makeHelpFocusable = (): void => {
                const help = document.getElementById('status-bar-nodu:c-download-help');
                if (help) {
                    help.tabIndex = 0;
                    help.onkeydown = event => {
                        if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault(); event.stopPropagation(); void this.showDownloadHelp();
                        }
                    };
                }
            };
            new MutationObserver(makeHelpFocusable).observe(statusNode, { childList: true, subtree: true });
        }
        // plugin-ext pulls in Debug, but Nodu 0.2.1 has no debug-adapter workflow.
        this.menus.unregisterMenuAction('6_debug', MAIN_MENU_BAR);
        // The toolbar shows whether the bottom panel is open; Lumino has no visibility event.
        const observer = new MutationObserver(() => this.model.fire());
        observer.observe(this.shell.bottomPanel.node, { attributes: true, attributeFilter: ['class'] });
        this.model.onDidChangeProject(project => void this.projectOpened(project));
        this.model.onDidChange(() => this.updateStatus());
        if (this.model.project) { void this.projectOpened(this.model.project); }
    }

    private async projectOpened(project: ProjectStatus | undefined): Promise<void> {
        this.updateStatus();
        if (!project || this.openedFor === project.path) { return; }
        this.openedFor = project.path;
        const locked = project.lockedToolkitVersion;
        const current = project.toolkit.version;
        const notice = `${project.path}:${locked}:${current}`;
        if (locked && current && locked !== current && !this.versionNotices.has(notice)) {
            this.versionNotices.add(notice);
            const accepted = await this.messages.warn(`这个工程使用工具包 ${locked}，当前内置 ${current}。编译结果可能不同。`, '使用当前版本');
            if (accepted) { await this.model.call('acceptToolkit', { path: project.path }); await this.model.reload(); }
        }
        await this.shell.pendingUpdates;
        // Open main.c the first time; never create files on startup.
        if (!this.editors.all.length) {
            const main = URI.fromFilePath(project.path).resolve('Core/Src/main.c');
            if (await this.files.exists(main)) { await this.editors.open(main, { mode: 'activate' }); }
        }
    }

    isPanelVisible(): boolean {
        const widget = this.panel.tryGetWidget();
        return !!widget?.isVisible && !this.shell.bottomPanel.isHidden;
    }

    async showPanel(tab?: PanelTab, activate = false): Promise<void> {
        if (tab) { this.model.panelTab = tab; }
        await this.panel.openView({ area: 'bottom', reveal: true, activate });
        this.model.fire();
    }

    private async togglePanel(): Promise<void> {
        if (this.isPanelVisible()) { await this.shell.collapsePanel('bottom'); } else { await this.showPanel(undefined, true); }
        this.model.fire();
    }

    private updateStatus(): void {
        if (this.model.isC && this.model.project) {
            const text = downloadStatusText(this.model.project.flashMethod, this.model);
            void this.status.setElement('nodu:c-download', {
                text, alignment: StatusBarAlignment.LEFT, priority: 90,
                command: C_COMMANDS.showOutput, accessibilityInformation: { label: text, role: 'button' },
            });
            void this.status.setElement('nodu:c-download-help', {
                text: '$(info)', alignment: StatusBarAlignment.LEFT, priority: 89,
                affinity: { id: 'nodu:c-download', alignment: StatusBarAlignment.RIGHT, compact: true },
                tooltip: () => { const content = downloadHelpContent(); content.classList.add('nodu-download-help-hover'); return content; },
                command: C_COMMANDS.downloadHelp, accessibilityInformation: { label: '下载帮助', role: 'button' },
            });
        } else {
            void this.status.removeElement('nodu:c-download');
            void this.status.removeElement('nodu:c-download-help');
        }
        const flash = this.model.isC ? (this.model.lastBuild?.capacity?.FLASH ?? this.model.project?.currentBuild?.capacity?.FLASH) : undefined;
        if (!flash) { this.status.removeElement('nodu:c-flash'); return; }
        void this.status.setElement('nodu:c-flash', {
            text: `Flash ${flash.percent.toFixed(1)}%`, alignment: StatusBarAlignment.RIGHT, priority: 70,
            tooltip: '程序占用的 Flash（最近一次编译）', command: C_COMMANDS.showProblems,
            accessibilityInformation: { label: `Flash 已用 ${flash.percent.toFixed(1)}%`, role: 'button' },
        });
    }

    private async showDownloadHelp(): Promise<void> {
        if (this.helpOpen) { return; }
        this.helpOpen = true;
        const active = document.activeElement as HTMLElement | null;
        const returnTo = active?.id === 'status-bar-nodu:c-download-help' ? active
            : document.querySelector<HTMLElement>('.nodu-run-more');
        try { await new NoduDownloadHelpDialog().open(); }
        finally { this.helpOpen = false; if (returnTo?.isConnected) { returnTo.focus({ preventScroll: true }); } }
    }

    private confirm(title: string, msg: string, ok: string): Promise<boolean> {
        return new ConfirmDialog({ title, msg, ok, cancel: '取消' }).open().then(value => value === true);
    }

    /** Building runs the project's CMake scripts: only trusted projects build (§11). */
    private async ensureTrusted(): Promise<boolean> {
        const project = this.model.project;
        if (!project) { return false; }
        if (project.trusted) { return true; }
        const ok = await this.confirm('信任这个工程？', `编译会执行 ${project.name} 里的 CMake 脚本。只信任自己创建或来源可靠的工程。`, '信任并编译');
        if (!ok) { return false; }
        await this.model.call('trustProject', { path: project.path });
        await this.model.reload();
        return true;
    }

    private async saveAll(): Promise<void> {
        await this.commands.executeCommand(CommonCommands.SAVE_ALL.id).catch(() => undefined);
    }

    private async build(clean = false): Promise<void> {
        if (!this.model.isC || this.model.busy) { return; }
        if (!this.model.project?.toolkit.ok) { this.toolkitProblem(); return; }
        if (!await this.ensureTrusted()) { return; }
        await this.saveAll();
        const result = await this.model.build(clean);
        if (result && !result.ok) { await this.showPanel('problems'); }
    }

    private async run(): Promise<void> {
        if (!this.model.isC || this.model.busy) { return; }
        if (!this.model.project?.toolkit.ok) { this.toolkitProblem(); return; }
        if (!await this.ensureTrusted()) { return; }
        await this.saveAll();
        const compatible = this.model.project?.manifest.target.vendor === 'compatible';
        if (compatible && !await this.confirm('兼容芯片下载', '此工程按兼容芯片处理，尚未验证其与 ST 芯片的全部差异。继续前请核对具体型号和手册；设备 ID、容量、读保护及备份检查仍会执行。', '确认并下载')) { return; }
        const ok = await this.model.run(compatible);
        const failedBuild = this.model.lastBuild && !this.model.lastBuild.ok;
        if (failedBuild) { await this.showPanel('problems'); }
        else if (ok) { await this.showPanel(this.model.monitor.open || this.model.lastFlash?.needsBootRestore ? 'monitor' : 'output'); }
        else if (this.model.lastError) { this.layoutState.setDeviceOpen(true); }
    }

    private toolkitProblem(): void {
        const message = this.model.project?.toolkit.message || 'STM32 工具包不可用。';
        this.model.setTask('STM32 工具包不完整', 'error');
        void this.messages.error(message);
    }

    async newProject(): Promise<void> {
        const root = (await this.workspace.roots)[0]?.resource;
        const home = await this.model.rpc.homeDirectory();
        const parent = root && this.model.isC ? root.parent.path.fsPath() : home;
        const dialog = new NoduNewProjectDialog({ title: '新建项目' }, {
            model: this.model, dialogs: this.dialogs, parent, family: this.model.project?.chip.family === 'f4' ? 'stm32f407' : this.model.isC ? 'stm32f103' : this.model.isEsp ? 'esp32' : 'k210',
            onCreated: project => this.workspace.open(URI.fromFilePath(project.path), { preserveWindow: true }),
        });
        await dialog.open();
    }

    private async exportProject(): Promise<void> {
        const project = this.model.project;
        if (!project || this.model.busy) { return; }
        const uri = await this.dialogs.showSaveDialog({ title: '导出独立工程（选择新文件夹名称）', saveLabel: '导出',
            inputValue: `${project.name}-export` });
        if (!uri) { return; }
        await this.saveAll();
        try {
            const result = await this.model.call<{ path: string }>('exportProject', { path: project.path, destination: uri.path.fsPath() });
            void this.messages.info(`已导出独立工程：${result.path}`);
        } catch (error) { void this.messages.error(errorText(error)); }
    }

    private async projectDialog(kind: 'module' | 'settings' | 'toolkit'): Promise<void> {
        const active = document.activeElement as HTMLElement | null;
        const returnTo = active?.matches('button, input, select, [role=button]') ? active : document.querySelector<HTMLElement>('.nodu-toolbar-project');
        const title = kind === 'module' ? '新建 C 模块' : kind === 'settings' ? '工程设置' : 'STM32 工具包';
        const view = (close: () => void): React.ReactNode => kind === 'module'
            ? React.createElement(ModuleForm, { model: this.model, close, open: (path: string) => this.editors.open(URI.fromFilePath(path), { mode: 'activate' }) })
            : kind === 'settings' ? React.createElement(ProjectSettings, { model: this.model, close }) : React.createElement(ToolkitInfo, { model: this.model, close });
        try { await new NoduProjectDialog(title, view).open(); }
        finally { if (returnTo?.isConnected) { returnTo.focus({ preventScroll: true }); } }
    }

    registerCommands(registry: CommandRegistry): void {
        const c = () => this.model.isC;
        const add = (id: string, label: string, execute: () => unknown, enabled: () => boolean = c) =>
            registry.registerCommand({ id, label, category: 'STM32' }, { execute, isEnabled: enabled, isVisible: enabled });
        add(C_COMMANDS.newModule, '新建 C 模块…', () => this.projectDialog('module'), () => c() && !this.model.busy && !this.model.project?.manifest.build?.external);
        add(C_COMMANDS.projectSettings, '工程设置…', () => this.projectDialog('settings'), () => c() && !this.model.busy);
        add(C_COMMANDS.toolkitInfo, 'STM32 工具包…', () => this.projectDialog('toolkit'));
        add(C_COMMANDS.exportProject, '导出独立工程…', () => this.exportProject());
        add(C_COMMANDS.openBuildLocation, '打开产物目录', async () => {
            const project = this.model.project;
            if (!project) { return; }
            try { await this.model.call('openBuildLocation', { path: project.path }); }
            catch (error) { void this.messages.error(errorText(error)); }
        });
        add(C_COMMANDS.build, '编译', () => this.build());
        add(C_COMMANDS.rebuild, '清理并重新编译', () => this.build(true));
        add(C_COMMANDS.run, '运行（编译并下载）', () => this.run());
        add(C_COMMANDS.downloadHelp, '下载帮助', () => this.showDownloadHelp());
        add(C_COMMANDS.stop, '停止', () => this.model.stop());
        add(C_COMMANDS.reset, '复位开发板', () => this.model.reset(), () => c() && this.model.project?.flashMethod === 'stlink');
        add(C_COMMANDS.identify, '识别芯片', () => this.model.identify(), () => c() && this.model.project?.flashMethod === 'stlink');
        registry.registerCommand({ id: C_COMMANDS.togglePanel, label: '问题与串口监视器', category: 'STM32' }, {
            execute: () => this.togglePanel(), isEnabled: c, isVisible: c, isToggled: () => this.isPanelVisible(),
        });
        add(C_COMMANDS.finishBoot, '已恢复 BOOT0，打开串口监视器', async () => { await this.model.finishBoot(); await this.showPanel('monitor'); });
        add(C_COMMANDS.showProblems, '显示问题', () => this.showPanel('problems', true));
        add(C_COMMANDS.showMonitor, '显示串口监视器', () => this.showPanel('monitor', true));
        add(C_COMMANDS.showOutput, '显示编译输出', () => this.showPanel('output', true));
        add(C_COMMANDS.checkToolkit, '检查 STM32 工具包', async () => {
            const report = await this.model.call<{ ok: boolean; problemCount: number; version: string }>('checkToolkit', { full: true });
            if (report.ok) { void this.messages.info(`STM32 工具包 ${report.version} 完整。`); }
            else { void this.messages.error(`STM32 工具包有 ${report.problemCount} 个文件缺失或损坏。重新安装 Nodu 可以修复。`); }
            await this.model.reload();
        });
        registry.registerCommand({ id: C_COMMANDS.methodStlink, label: 'ST-LINK（SWD）', category: 'STM32' }, {
            execute: () => this.model.setOption('flashMethod', 'stlink'), isEnabled: c, isVisible: c,
            isToggled: () => this.model.project?.flashMethod === 'stlink',
        });
        registry.registerCommand({ id: C_COMMANDS.methodUart, label: '串口（ISP）', category: 'STM32' }, {
            execute: () => this.model.setOption('flashMethod', 'uart'), isEnabled: c, isVisible: c,
            isToggled: () => this.model.project?.flashMethod === 'uart',
        });
        registry.registerCommand({ id: C_COMMANDS.newProject, label: '新建项目…', category: 'Nodu' }, { execute: () => this.newProject() });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: C_COMMANDS.newModule, order: '0b' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '4_settings'], { commandId: C_COMMANDS.projectSettings, order: '0' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '4_settings'], { commandId: C_COMMANDS.toolkitInfo, order: '1' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '2_export'], { commandId: C_COMMANDS.exportProject, label: '导出独立工程…' });
        menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: C_COMMANDS.newProject, label: '新建项目…', order: '0a' });
        menus.registerMenuAction([...CommonMenus.FILE, '1_new'], { commandId: C_COMMANDS.newProject, label: '新建项目…', order: 'a' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.run, label: '运行（编译并下载）', order: '0' });
        menus.registerSubmenu([...NODU_C_RUN_MENU, '0_c', 'method'], '下载方式', { sortString: '1' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c', 'method'], { commandId: C_COMMANDS.methodStlink, order: '0' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c', 'method'], { commandId: C_COMMANDS.methodUart, order: '1' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.reset, order: '2' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.rebuild, order: '3' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '1_view'], { commandId: C_COMMANDS.showMonitor, order: '0' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '1_view'], { commandId: C_COMMANDS.showOutput, order: '1' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '1_view'], { commandId: C_COMMANDS.openBuildLocation, order: '2' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '9_help'], { commandId: C_COMMANDS.downloadHelp });
    }

    registerKeybindings(keys: KeybindingRegistry): void {
        keys.registerKeybinding({ command: C_COMMANDS.build, keybinding: 'ctrlcmd+b', when: 'nodu.cProject && !terminalFocus' });
        keys.registerKeybinding({ command: C_COMMANDS.run, keybinding: 'ctrlcmd+r', when: 'nodu.cProject && !terminalFocus' });
        keys.registerKeybinding({ command: C_COMMANDS.run, keybinding: 'ctrlcmd+enter', when: 'nodu.cProject && editorTextFocus' });
        keys.registerKeybinding({ command: C_COMMANDS.stop, keybinding: 'ctrlcmd+.', when: 'nodu.cProject' });
    }
}

export function errorText(error: unknown): string {
    return error instanceof EmbeddedError ? error.message : error instanceof Error ? error.message : String(error);
}
