// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { MessageService } from '@theia/core/lib/common/message-service';
import { NODU_PROJECT_MENU } from '../browser/scope-workbench';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonCommands, CommonMenus, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { PreferenceContribution } from '@theia/core/lib/common/preferences/preference-schema';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { CustomTitleWidgetFactory, ElectronMenuContribution } from '@theia/core/lib/electron-browser/menu/electron-menu-contribution';
import { NoduElectronMenuContribution } from './nodu-electron-menu-contribution';
import { NoduProjectSearch } from './nodu-project-search';
import { QuickFileOpenService } from '@theia/file-search/lib/browser/quick-file-open';
import { NoduFileSearch } from './nodu-file-search';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import URI from '@theia/core/lib/common/uri';
import { NoduEmbeddedModel } from '../browser/nodu-embedded-model';
import { NODU_LAUNCHER_MAIN_PATH, NODU_LAUNCHER_QUERY, NODU_PROJECTS_PATH, NODU_REOPEN_LAST_PREF, NoduLauncherMain, NoduProjectsService } from '../common/nodu-launcher-protocol';
import { Launcher } from './nodu-launcher-view';
import '../../style/launcher.css';
import '../../style/project-icon.css';
import '../../style/project-search.css';

const isLauncher = (): boolean => new URLSearchParams(window.location.search).get(NODU_LAUNCHER_QUERY) === '1';
// Runs before the shell is attached, preventing a flash of the IDE in the welcome window.
if (isLauncher()) { document.documentElement.classList.add('nodu-launcher-window'); }

@injectable()
class LauncherWorkspaceService extends WorkspaceService {
    @inject(NoduLauncherMain) protected readonly launcher!: NoduLauncherMain;
    override async getDefaultWorkspaceUri(): Promise<string | undefined> {
        return isLauncher() ? undefined : super.getDefaultWorkspaceUri();
    }
    protected override async doOpen(uri: URI, options?: Parameters<WorkspaceService['open']>[1]): Promise<void> {
        if (isLauncher()) {
            try { await this.launcher.openProject(uri.path.fsPath()); }
            catch (error) { await this.messageService.error(String(error)); }
        } else { await super.doOpen(uri, options); }
    }
    override async close(): Promise<void> {
        await this.launcher.showLauncher();
        // Electron's existing beforeunload flow prompts for unsaved editors.
        window.close();
    }
}

@injectable()
export class LauncherContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution {
    @inject(NoduLauncherMain) protected readonly main!: NoduLauncherMain;
    @inject(NoduProjectsService) protected readonly projects!: NoduProjectsService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(ApplicationServer) protected readonly appServer!: ApplicationServer;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(MessageService) protected readonly messages!: MessageService;
    private registry?: CommandRegistry;
    private menuRegistry?: MenuModelRegistry;
    private readonly recentEntries = new DisposableCollection();
    private readonly subscriptions = new DisposableCollection();
    private recentGeneration = 0;
    private root?: Root;
    async onStart(): Promise<void> {
        const refresh = (): void => { void this.refreshRecent(); };
        window.addEventListener('focus', refresh);
        this.subscriptions.push({ dispose: () => window.removeEventListener('focus', refresh) });
        this.subscriptions.push(this.workspace.onWorkspaceChanged(roots => {
            const path = roots[0]?.resource.path.fsPath();
            void (path ? this.projects.touch(path) : Promise.resolve()).then(() => this.refreshRecent());
        }));
        void this.refreshRecent();
        if (!isLauncher()) {
            const project = (await this.workspace.roots)[0]?.resource;
            if (project) { await this.projects.touch(project.path.fsPath()).catch(() => undefined); }
            return;
        }
        document.title = 'Nodu';
        const host = document.createElement('div');
        host.id = 'nodu-launcher'; document.body.appendChild(host);
        this.root = createRoot(host);
        this.root.render(<Launcher projects={this.projects} open={(path, keepLauncher) => this.openSelected(path, keepLauncher)}
            reveal={async path => window.electronTheiaCore.showItemInFolder(path)} browse={() => this.openFolder()} themes={this.themes}
            model={this.model} dialogs={this.dialogs} preferences={this.preferences} application={this.appServer} />);
        document.getElementById('theia-app-shell')?.setAttribute('inert', '');
    }
    onStop(): void { this.recentGeneration++; this.root?.unmount(); this.subscriptions.dispose(); this.recentEntries.dispose(); }
    private async openFolder(): Promise<void> {
        const chosen = await this.dialogs.showOpenDialog({ title: '打开项目（文件夹、nodu.json 或 Keil 工程）', canSelectFolders: true, canSelectFiles: true, openLabel: '打开' });
        const uri = Array.isArray(chosen) ? chosen[0] : chosen;
        if (uri) { await this.openSelected(uri.path.fsPath()); }
    }
    async openSelected(path: string, keepLauncher?: boolean): Promise<void> {
        try {
            const inspected = await this.projects.inspect(path);
            let chosen = inspected.candidates.length === 1 ? inspected.candidates[0].path : inspected.folder;
            if (inspected.candidates.length > 1) {
                const pick = await this.quickPick.show(inspected.candidates.map(p => ({ label: p.name, description: p.tag, detail: p.path, path: p.path })), { title: '选择项目', placeholder: '此目录包含多个项目，请选择要打开的项目' });
                if (!pick) return;
                chosen = pick.path;
            }
            await this.main.openProject(chosen, { keepLauncher });
            await this.projects.touch(chosen).catch(() => undefined);
            await this.refreshRecent();
        } catch (error) { void this.messages.error(`项目未打开：${error instanceof Error ? error.message : String(error)}`); }
    }
    async refreshRecent(): Promise<void> {
        if (!this.registry || !this.menuRegistry) return;
        const generation = ++this.recentGeneration;
        try {
            const rows = await this.projects.recent();
            if (generation !== this.recentGeneration) return;
            this.recentEntries.dispose();
            for (const [index, row] of rows.slice(0, 15).entries()) {
                const id = `nodu.project.recent.${index}`;
                this.recentEntries.push(this.registry.registerCommand({ id, label: `${row.name}${row.missing ? '（找不到）' : ''}` }, {
                    execute: () => this.openSelected(row.path), isEnabled: () => !row.missing,
                }));
                for (const menu of [CommonMenus.FILE, NODU_PROJECT_MENU]) {
                    this.recentEntries.push(this.menuRegistry.registerMenuAction([...menu, '1_projects', 'recent', '0_items'], { commandId: id, order: String(index).padStart(2, '0') }));
                }
            }
            if (!rows.length) for (const menu of [CommonMenus.FILE, NODU_PROJECT_MENU]) {
                this.recentEntries.push(this.menuRegistry.registerMenuAction([...menu, '1_projects', 'recent', '0_items'], { commandId: 'nodu.project.noRecents' }));
            }
        } catch { /* A read-only or unavailable profile must not prevent opening a project. */ }
    }
    registerCommands(commands: CommandRegistry): void {
        this.registry = commands;
        commands.registerCommand({ id: 'nodu.project.open', label: '打开项目…', category: 'Nodu' }, { execute: () => this.openFolder() });
        commands.registerCommand({ id: 'nodu.project.noRecents', label: '暂无最近项目' }, { execute() {}, isEnabled: () => false });

        commands.registerHandler(CommonCommands.FIND.id, {
            isEnabled: isLauncher, isVisible: isLauncher,
            execute: () => document.querySelector<HTMLInputElement>('#nodu-launcher input[type=search]')?.focus(),
        });
        commands.registerCommand({ id: 'nodu.launcher', label: '工作台', category: 'Nodu' }, { execute: () => this.main.showLauncher() });
    }
    registerMenus(menus: MenuModelRegistry): void {
        this.menuRegistry = menus;
        for (const menu of [CommonMenus.FILE, NODU_PROJECT_MENU]) {
            menus.registerMenuAction([...menu, '1_projects'], { commandId: 'nodu.project.open', order: '0' });
            menus.registerSubmenu([...menu, '1_projects', 'recent'], '最近项目', { sortString: '1' });
        }
        menus.registerMenuAction([...CommonMenus.FILE, '0_nodu_launcher'], { commandId: 'nodu.launcher', label: '工作台', order: '0' });
    }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(PreferenceContribution).toConstantValue({ schema: {
        title: 'Nodu 启动', properties: {
            [NODU_REOPEN_LAST_PREF]: { type: 'boolean', default: false, description: '启动时重新打开上次的项目。' },
        },
    } });
    rebind(ElectronMenuContribution).to(NoduElectronMenuContribution).inSingletonScope();
    bind(NoduProjectSearch).toSelf().inSingletonScope();
    rebind(QuickFileOpenService).to(NoduFileSearch).inSingletonScope();
    rebind(CustomTitleWidgetFactory).toFactory(ctx => () => ctx.container.get(NoduProjectSearch));
    bind(NoduLauncherMain).toDynamicValue(ctx => ElectronIpcConnectionProvider.createProxy<NoduLauncherMain>(ctx.container, NODU_LAUNCHER_MAIN_PATH)).inSingletonScope();
    bind(NoduProjectsService).toDynamicValue(ctx => WebSocketConnectionProvider.createProxy<NoduProjectsService>(ctx.container, NODU_PROJECTS_PATH)).inSingletonScope();
    bind(LauncherWorkspaceService).toSelf().inSingletonScope();
    rebind(WorkspaceService).toService(LauncherWorkspaceService);
    bind(LauncherContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution]) { bind(contribution).toService(LauncherContribution); }
});
