// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { SidebarBottomMenuWidget } from '@theia/core/lib/browser/shell/sidebar-bottom-menu-widget';
import { CommandContribution, CommandRegistry, DisposableCollection, MenuPath } from '@theia/core/lib/common';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS } from './nodu-tutor-hints';
import { AISettingsPanel } from './nodu-ai-provider-settings';

/** Marker path for the left sidebar AI button; it opens a popover instead of a context menu. */
export const AI_SETTINGS_MENU: MenuPath = ['nodu-ai-settings-menu'];
const AI_SETTINGS_ID = 'nodu-ai-settings';

/** A floating AI settings card anchored to the button that opened it. */
@injectable()
export class NoduAiSettingsPopover {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    private host?: HTMLDivElement;
    private root?: Root;
    private anchor?: HTMLElement;
    private readonly listeners = new DisposableCollection();

    toggle(anchor?: HTMLElement): void {
        if (this.host && (!anchor || anchor === this.anchor)) { this.close(); return; }
        this.close();
        this.show(anchor);
    }

    close(): void {
        if (!this.host) { return; }
        this.listeners.dispose();
        this.root?.unmount();
        this.host.remove();
        this.host = undefined; this.root = undefined;
        this.anchor?.focus({ preventScroll: true });
        this.anchor = undefined;
    }

    private show(anchor?: HTMLElement): void {
        const host = document.createElement('div');
        host.className = 'nodu-ai-popover';
        host.setAttribute('role', 'dialog');
        host.setAttribute('aria-label', 'AI 设置');
        this.place(host, anchor);
        document.body.appendChild(host);
        this.host = host; this.anchor = anchor;
        this.root = createRoot(host);
        this.render();
        const outside = (event: PointerEvent): void => {
            const target = event.target as Node | null;
            // NoduSelect and native pickers render outside the card; only real outside clicks close it.
            if (!target || host.contains(target) || anchor?.contains(target) || (target instanceof Element && target.closest('.nodu-select-menu'))) { return; }
            this.close();
        };
        const escape = (event: KeyboardEvent): void => { if (event.key === 'Escape') { event.stopPropagation(); this.close(); } };
        document.addEventListener('pointerdown', outside, true);
        host.addEventListener('keydown', escape);
        const reposition = (): void => { if (this.host) { this.place(this.host, this.anchor); } };
        window.addEventListener('resize', reposition);
        this.listeners.push({ dispose: () => { document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', reposition); } });
        this.listeners.push(this.tutor.onDidChange(() => this.render()));
        void this.tutor.refreshSettings();
        requestAnimationFrame(() => host.querySelector<HTMLElement>('.nodu-ai-provider-item-on, input:not([readonly]), button')?.focus());
    }

    private render(): void {
        this.root?.render(<div className="nodu-ai-popover-card">
            <div className="nodu-ai-popover-head">
                <span><i className="codicon codicon-sparkle" aria-hidden="true"/>AI 设置</span>
                <button type="button" className="nodu-ai-icon" aria-label="关闭" title="关闭 Esc" onClick={() => this.close()}><i className="codicon codicon-close" aria-hidden="true"/></button>
            </div>
            <AISettingsPanel tutor={this.tutor} />
            <label className="nodu-ai-popover-foot"><input type="checkbox" checked={this.tutor.autoReview} onChange={e => this.tutor.setDisplay('autoReview', e.target.checked)}/>逐行 AI 检查（完成一行后发送当前文件给所选模型）</label>
        </div>);
    }

    /** Beside the left sidebar button, or above an in-panel anchor such as the composer model picker. */
    private place(host: HTMLDivElement, anchor?: HTMLElement): void {
        // A hidden or not-yet-laid-out window can report 0; fall back to the document size.
        const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
        const vh = window.innerHeight || document.documentElement.clientHeight || 800;
        const margin = 8, width = Math.max(320, Math.min(760, vw - margin * 2));
        const rect = anchor?.getBoundingClientRect();
        host.style.width = `${width}px`;
        if (!rect || (!rect.width && !rect.height)) { host.style.left = '56px'; host.style.bottom = '16px'; host.style.maxHeight = `${Math.max(320, vh - 32)}px`; return; }
        const beside = rect.left < 80;
        const left = beside ? rect.right + margin : rect.left;
        const top = beside ? rect.bottom : rect.top - 6;
        host.style.left = `${Math.max(margin, Math.min(left, vw - width - margin))}px`;
        host.style.bottom = `${Math.max(margin, vh - top)}px`;
        host.style.maxHeight = `${Math.max(320, top - margin * 2)}px`;
    }
}

/** Left sidebar bottom menu: the AI button sits above the settings gear and opens the popover. */
@injectable()
export class NoduSidebarBottomMenuWidget extends SidebarBottomMenuWidget {
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    protected override onClick(e: React.MouseEvent<HTMLElement, MouseEvent>, menuPath: MenuPath): void {
        if (menuPath[0] === AI_SETTINGS_MENU[0]) { void this.commandRegistry.executeCommand(TUTOR_COMMANDS.settings, e.currentTarget); return; }
        super.onClick(e, menuPath);
    }
}

@injectable()
export class NoduAiSettingsContribution implements FrontendApplicationContribution, CommandContribution {
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(NoduAiSettingsPopover) protected readonly popover!: NoduAiSettingsPopover;
    private shown = false;

    onStart(): void {
        this.sync();
        this.tutor.onDidChange(() => this.sync());
    }

    registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: TUTOR_COMMANDS.settings, label: 'AI 设置', category: 'Nodu' }, {
            execute: (anchor?: unknown) => this.popover.toggle(anchor instanceof HTMLElement ? anchor : undefined),
            isEnabled: () => this.tutor.enabled, isVisible: () => this.tutor.enabled,
        });
    }

    /** Simple mode has no AI, so the button only exists in professional mode. */
    private sync(): void {
        const enabled = this.tutor.enabled;
        if (enabled === this.shown) { return; }
        this.shown = enabled;
        if (enabled) {
            this.shell.leftPanelHandler.addBottomMenu({ id: AI_SETTINGS_ID, iconClass: 'codicon codicon-sparkle', title: 'AI 设置', menuPath: AI_SETTINGS_MENU, order: 0.5 });
        } else {
            this.shell.leftPanelHandler.removeBottomMenu(AI_SETTINGS_ID);
            this.popover.close();
        }
    }
}
