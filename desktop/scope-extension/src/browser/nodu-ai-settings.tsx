// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { ApplicationShell, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { SidebarBottomMenuWidget } from '@theia/core/lib/browser/shell/sidebar-bottom-menu-widget';
import { CommandContribution, CommandRegistry, MenuPath } from '@theia/core/lib/common';
import { NoduTutorModel } from './nodu-tutor-model';
import { TUTOR_COMMANDS } from './nodu-tutor-hints';
import { NoduProfessionalSettings } from './nodu-professional-settings';

/** Marker path for the left sidebar AI button; it opens a popover instead of a context menu. */
export const AI_SETTINGS_MENU: MenuPath = ['nodu-ai-settings-menu'];
const AI_SETTINGS_ID = 'nodu-ai-settings';

/** Existing command facade, now sharing the professional settings window. */
@injectable()
export class NoduAiSettingsPopover {
    @inject(NoduProfessionalSettings) protected readonly settings!: NoduProfessionalSettings;
    toggle(anchor?: HTMLElement): void { this.settings.open('ai', anchor); }
    close(): void { this.settings.close(false); }
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
