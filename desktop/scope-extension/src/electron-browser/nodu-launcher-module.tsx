// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { ContainerModule, inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MessageService } from '@theia/core/lib/common';
import { CommonCommands, CommonMenus, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ElectronIpcConnectionProvider } from '@theia/core/lib/electron-browser/messaging/electron-ipc-connection-source';
import { ElectronMenuContribution } from '@theia/core/lib/electron-browser/menu/electron-menu-contribution';
import { NoduElectronMenuContribution } from './nodu-electron-menu-contribution';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import URI from '@theia/core/lib/common/uri';
import { NoduEmbeddedModel } from '../browser/nodu-embedded-model';
import { NoduNewProjectDialog } from '../browser/nodu-new-project';
import { NODU_LAUNCHER_MAIN_PATH, NODU_LAUNCHER_QUERY, NODU_PROJECTS_PATH, NoduLauncherMain, NoduProjectsService, RecentProject } from '../common/nodu-launcher-protocol';
import { relativeTime } from '../common/nodu-launcher-util';
import '../../style/launcher.css';

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
    @inject(MessageService) protected readonly messages!: MessageService;
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
            create={() => this.createProject()} browse={() => this.openFolder()} />);
        document.getElementById('theia-app-shell')?.setAttribute('inert', '');
    }
    onStop(): void { this.root?.unmount(); }
    private async createProject(): Promise<void> {
        const parent = await this.projects.projectsDir();
        const dialog = new NoduNewProjectDialog({ title: '新建项目' }, {
            model: this.model, dialogs: this.dialogs, parent, family: 'stm32f103',
            onCreated: project => { void this.main.openProject(project.path).catch(error => this.messages.error(String(error))); },
        });
        await dialog.open();
    }
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

function Launcher({ projects, open, create, browse }: {
    projects: NoduProjectsService; open(path: string): Promise<void>; create(): Promise<void>; browse(): Promise<void>;
}): React.ReactElement {
    const [rows, setRows] = React.useState<RecentProject[]>([]);
    const [query, setQuery] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [error, setError] = React.useState('');
    const search = React.useRef<HTMLInputElement>(null);
    const pending = React.useRef(false);
    React.useEffect(() => {
        let live = true;
        const refresh = (): void => { void projects.recent().then(items => { if (live) { setRows(items); } })
            .catch(err => { if (live) { setError(String(err)); } }).finally(() => { if (live) { setLoading(false); } }); };
        refresh(); window.addEventListener('focus', refresh);
        return () => { live = false; window.removeEventListener('focus', refresh); };
    }, [projects]);
    const run = async (action: () => Promise<void>, trigger?: HTMLElement): Promise<void> => {
        if (pending.current) { return; }
        pending.current = true; setBusy(true); setError('');
        try { await action(); } catch (err) { setError(String(err)); }
        finally {
            pending.current = false; setBusy(false);
            requestAnimationFrame(() => { if (trigger?.isConnected) { trigger.focus(); } });
        }
    };
    const visible = rows.filter(row => `${row.name} ${row.path} ${row.tag ?? ''}`.toLowerCase().includes(query.toLowerCase()));
    return <main className="nodu-launcher-content scope-widget" aria-label="Nodu 工作台" aria-busy={busy}
        onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
            if (event.key === 'Escape' && document.activeElement === search.current) { setQuery(''); }
        }}>
        <aside className="nodu-launcher-nav">
            <div className="nodu-launcher-brand">Nodu</div>
            <span className="nodu-launcher-section" aria-current="page"><i className="codicon codicon-folder" aria-hidden="true"/>项目</span>
        </aside>
        <section className="nodu-launcher-projects" aria-label="项目">
            <div className="nodu-launcher-actions">
                <button className="theia-button main" disabled={busy} onClick={event => void run(create, event.currentTarget)}>新建项目</button>
                <button className="theia-button secondary" disabled={busy} onClick={event => void run(browse, event.currentTarget)}>打开项目</button>
            </div>
            <input ref={search} autoFocus type="search" className="theia-input nodu-launcher-search" placeholder="搜索项目" aria-label="搜索项目"
                value={query} onChange={event => setQuery(event.currentTarget.value)} />
            {error && <div className="nodu-launcher-error" role="alert">{error}</div>}
            <ul className="nodu-launcher-list" aria-label="最近项目">
                {visible.map(row => <li key={row.path} className={row.missing ? 'missing' : ''}>
                    <button className="nodu-launcher-project" disabled={busy || row.missing} title={row.path} onClick={() => void run(() => open(row.path))}>
                        <i className="codicon codicon-folder" aria-hidden="true"/>
                        <span className="nodu-launcher-project-info"><strong>{row.name}</strong><span>{row.path}</span></span>
                        <span className="nodu-launcher-meta">{row.missing ? '找不到' : row.tag}<time>{relativeTime(row.lastOpened)}</time></span>
                    </button>
                    <button className="nodu-launcher-remove" title="从最近项目移除" aria-label={`移除 ${row.name}`} disabled={busy}
                        onClick={() => void run(async () => { await projects.remove(row.path); setRows(await projects.recent()); search.current?.focus(); })}>
                        <i className="codicon codicon-close" aria-hidden="true"/>
                    </button>
                </li>)}
            </ul>
            {!visible.length && <div className="nodu-launcher-empty" role="status">{loading ? '正在加载…' : query ? '没有匹配项目' : '暂无最近项目'}</div>}
        </section>
    </main>;
}

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    rebind(ElectronMenuContribution).to(NoduElectronMenuContribution).inSingletonScope();
    bind(NoduLauncherMain).toDynamicValue(ctx => ElectronIpcConnectionProvider.createProxy<NoduLauncherMain>(ctx.container, NODU_LAUNCHER_MAIN_PATH)).inSingletonScope();
    bind(NoduProjectsService).toDynamicValue(ctx => WebSocketConnectionProvider.createProxy<NoduProjectsService>(ctx.container, NODU_PROJECTS_PATH)).inSingletonScope();
    bind(LauncherWorkspaceService).toSelf().inSingletonScope();
    rebind(WorkspaceService).toService(LauncherWorkspaceService);
    bind(LauncherContribution).toSelf().inSingletonScope();
    for (const contribution of [FrontendApplicationContribution, CommandContribution, MenuContribution]) { bind(contribution).toService(LauncherContribution); }
});
