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
        const panel = this.shell.topPanel.node;
        const resize = new ResizeObserver(() => { if (!this.isDisposed) { this.layoutSearch(); } });
        const observed = new Set<Element>();
        const sync = (): void => {
            if (this.isDisposed) { return; }
            // The same toolbar moves between this title bar and the minimal rail.
            // Observe its live width, including chip/operation changes, not a guessed width.
            const current = new Set<Element>([panel]);
            for (const selector of ['.nodu-titlebar-toolbar', '.lm-MenuBar', '#window-controls']) {
                const child = panel.querySelector(selector);
                if (child) { current.add(child); }
            }
            for (const child of observed) { if (!current.has(child)) { resize.unobserve(child); observed.delete(child); } }
            for (const child of current) { if (!observed.has(child)) { resize.observe(child); observed.add(child); } }
            this.layoutSearch();
        };
        const children = new MutationObserver(sync);
        children.observe(panel, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
        sync();
        this.toDispose.push({ dispose: () => { children.disconnect(); resize.disconnect(); observed.clear(); } });
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
        const controls = panel.querySelector<HTMLElement>('#window-controls');
        let end = width - (isOSX ? 100 : 156);
        if (controls && controls.offsetWidth > 0) { end = Math.min(end, controls.offsetLeft - 12); }
        const toolbar = panel.querySelector<HTMLElement>('.nodu-titlebar-toolbar');
        if (toolbar && toolbar.offsetWidth > 0) { end = Math.min(end, toolbar.offsetLeft - 12); }
        const available = Math.max(0, end - left);
        const searchWidth = Math.min(420, width * .42, available);
        this.node.style.width = `${searchWidth}px`;
        this.node.style.left = `${Math.max(left, Math.min((width - searchWidth) / 2, end - searchWidth))}px`;
        // Avoid a hidden-attribute observer loop when nothing changed.
        if (this.node.hidden !== (available < 80)) { this.node.hidden = available < 80; }
    }
}
