// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService, MenuContribution, MenuModelRegistry, MessageService } from '@theia/core/lib/common';
import { URI } from '@theia/core/lib/common/uri';
import { ApplicationShell, CommonCommands, CommonMenus, FrontendApplicationContribution, KeybindingContribution, KeybindingRegistry } from '@theia/core/lib/browser';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { StatusBar, StatusBarAlignment } from '@theia/core/lib/browser/status-bar/status-bar';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { EmbeddedError, NoduEmbeddedModel, PanelTab } from './nodu-embedded-model';
import { NoduNewProjectDialog } from './nodu-new-project';
import { NODU_PROJECT_MENU, ScopeConsoleContribution } from './scope-workbench';
import { ScopeLayoutState } from './scope-layout-state';
import { C_COMMANDS, NODU_C_RUN_MENU } from './nodu-embedded-commands';

export { C_COMMANDS };

/** Commands, keys and menus of the STM32 C workbench; inert until a C project is open. */
@injectable()
export class NoduEmbeddedContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution, KeybindingContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(ScopeConsoleContribution) protected readonly panel!: ScopeConsoleContribution;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(StatusBar) protected readonly status!: StatusBar;
    @inject(ScopeLayoutState) protected readonly layoutState!: ScopeLayoutState;
    private openedFor = '';

    onStart(): void {
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
        (await this.panel.widget).showEmbedded(tab ?? this.model.panelTab);
        await this.panel.openView({ area: 'bottom', reveal: true, activate });
        this.model.fire();
    }

    private async togglePanel(): Promise<void> {
        if (this.isPanelVisible()) { await this.shell.collapsePanel('bottom'); } else { await this.showPanel(undefined, true); }
        this.model.fire();
    }

    private updateStatus(): void {
        const flash = this.model.isC ? (this.model.lastBuild?.capacity?.FLASH ?? this.model.project?.currentBuild?.capacity?.FLASH) : undefined;
        if (!flash) { this.status.removeElement('nodu:c-flash'); return; }
        void this.status.setElement('nodu:c-flash', {
            text: `Flash ${flash.percent.toFixed(1)}%`, alignment: StatusBarAlignment.RIGHT, priority: 70,
            tooltip: '程序占用的 Flash（最近一次编译）', command: C_COMMANDS.showProblems,
            accessibilityInformation: { label: `Flash 已用 ${flash.percent.toFixed(1)}%`, role: 'button' },
        });
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
        const ok = await this.model.run();
        const failedBuild = this.model.lastBuild && !this.model.lastBuild.ok;
        if (failedBuild) { await this.showPanel('problems'); }
        else if (ok) { await this.showPanel('output'); }
        else if (this.model.lastError) { this.layoutState.setDeviceOpen(true); }
    }

    private toolkitProblem(): void {
        const message = this.model.project?.toolkit.message || 'STM32 工具包不可用。';
        this.model.setTask('STM32 工具包不完整', 'error');
        void this.messages.error(message);
    }

    async newProject(): Promise<void> {
        let boards;
        try { boards = (await this.model.catalog()).boards; } catch (error) {
            void this.messages.error(`读取板卡包失败：${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const root = (await this.workspace.roots)[0]?.resource;
        const home = await this.model.rpc.homeDirectory();
        const parent = root && this.model.isC ? root.parent.path.fsPath() : home;
        const dialog = new NoduNewProjectDialog({ title: '新建 STM32 项目' }, {
            model: this.model, dialogs: this.dialogs, parent, boards,
            onCreated: project => this.workspace.open(URI.fromFilePath(project.path), { preserveWindow: true }),
        });
        await dialog.open();
    }

    registerCommands(registry: CommandRegistry): void {
        const c = () => this.model.isC;
        const add = (id: string, label: string, execute: () => unknown, enabled: () => boolean = c) =>
            registry.registerCommand({ id, label, category: 'STM32' }, { execute, isEnabled: enabled, isVisible: enabled });
        add(C_COMMANDS.build, '编译', () => this.build());
        add(C_COMMANDS.rebuild, '清理并重新编译', () => this.build(true));
        add(C_COMMANDS.run, '运行（编译并下载）', () => this.run());
        add(C_COMMANDS.stop, '停止', () => this.model.stop());
        add(C_COMMANDS.reset, '复位开发板', () => this.model.reset(), () => c() && this.model.project?.flashMethod === 'stlink');
        add(C_COMMANDS.identify, '识别芯片', () => this.model.identify(), () => c() && this.model.project?.flashMethod === 'stlink');
        registry.registerCommand({ id: C_COMMANDS.togglePanel, label: 'STM32 开发面板', category: 'STM32' }, {
            execute: () => this.togglePanel(), isEnabled: c, isVisible: c, isToggled: () => this.isPanelVisible(),
        });
        add(C_COMMANDS.finishBoot, '已恢复 BOOT 并复位', async () => { await this.model.finishBoot(); await this.showPanel('monitor'); });
        add(C_COMMANDS.showProblems, '显示问题', () => this.showPanel('problems', true));
        add(C_COMMANDS.showMonitor, '显示串口监视器', () => this.showPanel('monitor', true));
        add(C_COMMANDS.showOutput, '显示构建与下载', () => this.showPanel('output', true));
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
        registry.registerCommand({ id: C_COMMANDS.newProject, label: '新建 STM32 项目…', category: 'STM32' }, { execute: () => this.newProject() });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...NODU_PROJECT_MENU, '1_new'], { commandId: C_COMMANDS.newProject, label: '新建 STM32 项目…', order: '0a' });
        menus.registerMenuAction([...CommonMenus.FILE, '1_new'], { commandId: C_COMMANDS.newProject, label: '新建 STM32 项目…', order: 'a' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.run, label: '运行（编译并下载）', order: '0' });
        menus.registerSubmenu([...NODU_C_RUN_MENU, '0_c', 'method'], '下载方式', { sortString: '1' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c', 'method'], { commandId: C_COMMANDS.methodStlink, order: '0' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c', 'method'], { commandId: C_COMMANDS.methodUart, order: '1' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.reset, order: '2' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '0_c'], { commandId: C_COMMANDS.rebuild, order: '3' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '1_view'], { commandId: C_COMMANDS.showMonitor, order: '0' });
        menus.registerMenuAction([...NODU_C_RUN_MENU, '1_view'], { commandId: C_COMMANDS.showOutput, order: '1' });
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
