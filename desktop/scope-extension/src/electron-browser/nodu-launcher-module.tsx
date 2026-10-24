// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonCommands, CommonMenus, FrontendApplicationContribution } from '@theia/core/lib/browser';
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
import { NODU_LAUNCHER_MAIN_PATH, NODU_LAUNCHER_QUERY, NODU_PROJECTS_PATH, NoduLauncherMain, NoduProjectsService } from '../common/nodu-launcher-protocol';
import { Launcher } from './nodu-launcher-view';
import '../../style/launcher.css';
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
class LauncherContribution implements FrontendApplicationContribution, CommandContribution, MenuContribution {
    @inject(NoduLauncherMain) protected readonly main!: NoduLauncherMain;
    @inject(NoduProjectsService) protected readonly projects!: NoduProjectsService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(ThemeService) protected readonly themes!: ThemeService;
    private root?: Root;
    async onStart(): Promise<void> {
        if (!isLauncher()) {
            const project = (await this.workspace.roots)[0]?.resource;
            if (project) { await this.projects.touch(project.path.fsPath()).catch(() => undefined); }
            return;
        }
        document.title = 'Nodu';
        const host = document.createElement('div');
        host.id = 'nodu-launcher'; document.body.appendChild(host);
        this.root = createRoot(host);
        this.root.render(<Launcher projects={this.projects} open={path => this.main.openProject(path)}
            browse={() => this.openFolder()} themes={this.themes} model={this.model} dialogs={this.dialogs} />);
        document.getElementById('theia-app-shell')?.setAttribute('inert', '');
    }
    onStop(): void { this.root?.unmount(); }
    private async openFolder(): Promise<void> {
        const chosen = await this.dialogs.showOpenDialog({ title: '打开项目', canSelectFolders: true, canSelectFiles: false, openLabel: '打开' });
        const uri = Array.isArray(chosen) ? chosen[0] : chosen;
        if (uri) { await this.main.openProject(uri.path.fsPath()); }
    }
    registerCommands(commands: CommandRegistry): void {
        commands.registerHandler(CommonCommands.FIND.id, {
            isEnabled: isLauncher, isVisible: isLauncher,
            execute: () => document.querySelector<HTMLInputElement>('#nodu-launcher input[type=search]')?.focus(),
        });
        commands.registerCommand({ id: 'nodu.launcher', label: '工作台', category: 'Nodu' }, { execute: () => this.main.showLauncher() });
    }
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...CommonMenus.FILE, '0_nodu_launcher'], { commandId: 'nodu.launcher', label: '工作台', order: '0' });
    }
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
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
