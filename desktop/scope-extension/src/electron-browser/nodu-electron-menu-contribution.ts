// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { FrontendApplication, KeybindingRegistry, Widget } from '@theia/core/lib/browser';
import { ElectronCommands, ElectronMenuContribution } from '@theia/core/lib/electron-browser/menu/electron-menu-contribution';
import { isOSX } from '@theia/core/lib/common/os';
import { NODU_LAUNCHER_QUERY } from '../common/nodu-launcher-protocol';

@injectable()
export class NoduElectronMenuContribution extends ElectronMenuContribution {
    private projectTitleMounted = false;

    protected override setMenu(app: FrontendApplication): void {
        if (new URLSearchParams(window.location.search).get(NODU_LAUNCHER_QUERY) === '1') {
            this.factory.setMenuBar();
            return;
        }
        if (!isOSX) { super.setMenu(app); return; }
        this.factory.setMenuBar();
        app.shell.topPanel.show();
        if (!this.projectTitleMounted) {
            const dragPanel = new Widget();
            dragPanel.id = 'theia-drag-panel';
            app.shell.addWidget(dragPanel, { area: 'top' });
            this.createCustomTitleWidget(app);
        }
    }

    protected override createCustomTitleWidget(app: FrontendApplication): void {
        if (this.projectTitleMounted) { return; }
        this.projectTitleMounted = true;
        app.shell.topPanel.addClass('nodu-project-titlebar');
        super.createCustomTitleWidget(app);
    }

    protected override handleFullScreen(menuBarVisibility: string): void {
        super.handleFullScreen(menuBarVisibility);
        if (this.projectTitleMounted) { this.shell.topPanel.show(); }
    }

    override registerKeybindings(registry: KeybindingRegistry): void {
        super.registerKeybindings(registry);
        // Ctrl/Cmd+R belongs to Nodu's run command and the terminal. Remove only
        // Electron's default reload binding; user/workspace overrides stay intact.
        registry.unregisterKeybinding(ElectronCommands.RELOAD);
        registry.registerKeybinding({ command: ElectronCommands.RELOAD.id, keybinding: 'ctrlcmd+shift+r' });
    }
}
