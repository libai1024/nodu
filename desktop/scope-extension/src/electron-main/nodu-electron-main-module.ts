// SPDX-License-Identifier: MIT
// Electron main process: the launcher-aware application and its two window calls for the renderer.
import { ContainerModule } from '@theia/core/shared/inversify';
import { RpcConnectionHandler } from '@theia/core/lib/common';
import { ElectronMainApplication } from '@theia/core/lib/electron-main/electron-main-application';
import { ElectronConnectionHandler } from '@theia/core/lib/electron-main/messaging/electron-connection-handler';
import { NODU_LAUNCHER_MAIN_PATH, NoduLauncherMain } from '../common/nodu-launcher-protocol';
import { NoduElectronMainApplication } from './nodu-electron-main-application';

export default new ContainerModule((bind, _unbind, _isBound, rebind) => {
    bind(NoduElectronMainApplication).toSelf().inSingletonScope();
    rebind(ElectronMainApplication).toService(NoduElectronMainApplication);
    // Only these two calls reach the main process; the application object itself is not exposed.
    bind(ElectronConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(NODU_LAUNCHER_MAIN_PATH, () => {
        const app = ctx.container.get(NoduElectronMainApplication);
        const facade: NoduLauncherMain = Object.assign(Object.create(null), {
            openProject: (fsPath: string, options?: { keepLauncher?: boolean }) => app.openProject(fsPath, options),
            showLauncher: () => app.showLauncher(),
        });
        return facade;
    })).inSingletonScope();
});
