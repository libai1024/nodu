// SPDX-License-Identifier: MIT
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, MessageService } from '@theia/core/lib/common';
import { isOSX } from '@theia/core/lib/common/os';
import { ApplicationShell, BaseWidget, Message } from '@theia/core/lib/browser';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';

/** Shared by the minimal and professional workbenches; search uses Theia's file picker. */
@injectable()
export class NoduProjectSearch extends BaseWidget {
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    private readonly button = document.createElement('button');
    private readonly name = document.createElement('span');
    private opening = false;

    constructor() {
        super();
        this.id = 'nodu-project-search';
        this.button.type = 'button';
        this.button.className = 'nodu-project-search-button';
        const icon = document.createElement('i');
        icon.className = 'codicon codicon-search';
        icon.setAttribute('aria-hidden', 'true');
        this.name.className = 'nodu-project-search-name';
        const shortcut = document.createElement('kbd');
        shortcut.textContent = isOSX ? '⌘P' : 'Ctrl+P';
        shortcut.setAttribute('aria-hidden', 'true');
        this.button.append(icon, this.name, shortcut);
        this.node.append(this.button);
        this.button.addEventListener('click', () => { void this.openSearch(); });
    }

    @postConstruct()
    protected init(): void {
        this.updateProject();
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => this.updateProject()));
        this.toDispose.push(this.workspace.onWorkspaceLocationChanged(() => this.updateProject()));
        void this.workspace.roots.then(() => { if (!this.isDisposed) { this.updateProject(); } });
        const resize = new ResizeObserver(() => this.layoutSearch());
        resize.observe(this.shell.topPanel.node);
        this.toDispose.push({ dispose: () => resize.disconnect() });
    }

    protected updateProject(): void {
        const workspace = this.workspace.workspace;
        const label = workspace?.isDirectory ? workspace.resource.path.base
            : workspace ? workspace.resource.path.name : this.workspace.tryGetRoots()[0]?.resource.path.base;
        this.name.textContent = label || '搜索文件';
        this.button.title = `搜索文件 (${isOSX ? '⌘P' : 'Ctrl+P'})`;
        this.button.setAttribute('aria-label', label ? `搜索项目 ${label} 中的文件` : '搜索文件');
    }

    protected async openSearch(): Promise<void> {
        if (this.opening || this.isDisposed) { return; }
        this.opening = true;
        try { await this.commands.executeCommand('file-search.openFile'); }
        catch { await this.messages.error('无法打开文件搜索，请重试。'); }
        finally { this.opening = false; }
    }

    protected override onAfterAttach(msg: Message): void {
        super.onAfterAttach(msg);
        this.layoutSearch();
    }

    protected layoutSearch(): void {
        const panel = this.shell.topPanel.node;
        const width = panel.clientWidth;
        const menu = panel.querySelector<HTMLElement>('.lm-MenuBar');
        const left = isOSX ? 100 : (menu ? menu.offsetLeft + menu.offsetWidth + 16 : 16);
        const right = isOSX ? 100 : 156;
        const available = Math.max(0, width - left - right);
        const searchWidth = Math.min(420, width * .42, available);
        this.node.style.width = `${searchWidth}px`;
        this.node.style.left = `${Math.max(left, Math.min((width - searchWidth) / 2, width - right - searchWidth))}px`;
        this.node.hidden = available < 80;
    }
}
