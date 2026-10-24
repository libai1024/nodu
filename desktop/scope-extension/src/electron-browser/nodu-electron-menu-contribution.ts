// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { KeybindingRegistry } from '@theia/core/lib/browser';
import { ElectronCommands, ElectronMenuContribution } from '@theia/core/lib/electron-browser/menu/electron-menu-contribution';

@injectable()
export class NoduElectronMenuContribution extends ElectronMenuContribution {
    override registerKeybindings(registry: KeybindingRegistry): void {
        super.registerKeybindings(registry);
        // Ctrl/Cmd+R belongs to Nodu's run command and the terminal. Remove only
        // Electron's default reload binding; user/workspace overrides stay intact.
        registry.unregisterKeybinding(ElectronCommands.RELOAD);
        registry.registerKeybinding({ command: ElectronCommands.RELOAD.id, keybinding: 'ctrlcmd+shift+r' });
    }
}
