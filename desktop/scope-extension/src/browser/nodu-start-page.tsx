// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService, MenuModelRegistry } from '@theia/core/lib/common';
import { CommonMenus, FrontendApplicationContribution, ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import URI from '@theia/core/lib/common/uri';
import { C_COMMANDS } from './nodu-embedded-commands';

@injectable()
export class NoduStartPage extends ReactWidget {
    static readonly ID = 'nodu:start';
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    protected recent: URI[] = [];
    protected query = '';
    @postConstruct() protected init(): void {
        this.id = NoduStartPage.ID; this.title.label = '开始'; this.title.closable = true;
        this.addClass('scope-widget'); this.addClass('nodu-start-page'); this.update();
        void this.workspace.recentWorkspaces().then(items => { this.recent = items.map(item => new URI(item)); this.update(); });
    }
    protected render(): React.ReactNode {
        const recent = this.recent.filter(uri => uri.path.toString().toLowerCase().includes(this.query.toLowerCase()));
        return <main className="nodu-start-content">
            <nav className="nodu-start-nav" aria-label="开始页">
                <div className="nodu-start-brand">Nodu</div>
                <button className="nodu-start-current" aria-current="page">项目</button>
                <button onClick={() => void this.commands.executeCommand('preferences:open')}>设置</button>
            </nav>
            <section className="nodu-start-projects" aria-label="项目">
                <div className="nodu-start-actions">
                    <button className="theia-button main" onClick={() => void this.commands.executeCommand(C_COMMANDS.newProject)}>新建项目</button>
                    <button className="theia-button secondary" onClick={() => void this.commands.executeCommand('workspace:open')}>打开项目</button>
                    <input type="search" aria-label="搜索项目" placeholder="搜索项目" value={this.query} onChange={event => { this.query = event.currentTarget.value; this.update(); }}/>
                </div>
                <ul className="nodu-start-recent" aria-label="最近项目">
                    {recent.map(uri => <li key={uri.toString()}><button onClick={() => this.workspace.open(uri)}>
                        <i className="codicon codicon-folder" aria-hidden="true"/>
                        <span><strong>{uri.path.base}</strong><span className="nodu-start-path">{uri.path.fsPath()}</span></span>
                    </button></li>)}
                </ul>
            </section>
        </main>;
    }
}

@injectable()
export class NoduStartContribution extends AbstractViewContribution<NoduStartPage> implements FrontendApplicationContribution {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    constructor() { super({ widgetId: NoduStartPage.ID, widgetName: '开始', defaultWidgetOptions: { area: 'main' }, toggleCommandId: 'nodu.start' }); }
    async onStart(): Promise<void> {
        const roots = await this.workspace.roots;
        const root = roots[0]?.resource;
        const children = root ? (await this.files.resolve(root)).children ?? [] : [];
        if (!children.some(child => !child.resource.path.base.startsWith('.'))) { await this.openView({ activate: true }); }
    }
    registerCommands(commands: CommandRegistry): void { super.registerCommands(commands); }
    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction([...CommonMenus.HELP, '0_start'], { commandId: 'nodu.start', label: '开始' });
    }
}
