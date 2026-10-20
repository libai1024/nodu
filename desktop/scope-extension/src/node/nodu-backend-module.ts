// SPDX-License-Identifier: MIT
import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { LocalizationContribution } from '@theia/core/lib/node/i18n/localization-contribution';
import { DeviceClient, NODU_DEVICE_PATH, NoduDeviceService } from '../common/nodu-device-protocol';
import { NoduZhCnLocalizationContribution } from './nodu-localization';
import { NoduResourcesServer } from './nodu-resources-server';
import { NODU_RESOURCES_PATH, NoduResourcesService, ResourcesClient } from '../common/nodu-resources-protocol';
import { NoduDeviceServer } from './nodu-device-server';

export default new ContainerModule(bind => {
    bind(NoduDeviceServer).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(NoduDeviceServer);
    bind(NoduResourcesServer).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(NoduResourcesServer);
    bind(NoduZhCnLocalizationContribution).toSelf().inSingletonScope();
    bind(LocalizationContribution).toService(NoduZhCnLocalizationContribution);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<ResourcesClient>(NODU_RESOURCES_PATH, client => {
        const server = ctx.container.get(NoduResourcesServer);
        const remove = server.addClient(client);
        client.onDidCloseConnection(() => remove());
        const names: (keyof NoduResourcesService)[] = ['ready', 'checkVersion', 'checkResources', 'installResources', 'cancelInstall'];
        const facade = Object.create(null);
        for (const name of names) { facade[name] = server[name].bind(server); }
        return facade as NoduResourcesService;
    })).inSingletonScope();
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<DeviceClient>(NODU_DEVICE_PATH, client => {
        const server = ctx.container.get(NoduDeviceServer);
        const remove = server.addClient(client);
        client.onDidCloseConnection(() => remove());
        // RpcProxyFactory dispatches target[method]; TypeScript private is not
        // a runtime boundary. Export only the service API, with no prototype.
        const names: (keyof NoduDeviceService)[] = ['getState', 'listPorts', 'connect', 'disconnect', 'execute',
            'runScript', 'stop', 'listFiles', 'readFile', 'writeFile', 'setPreview', 'startCamera',
            'saveFile', 'formatScript', 'resetDevice', 'inspectBoard',
            'startRecording', 'stopRecording', 'convertVideo', 'playVideo',
            'getTerminalExecutable', 'takeStartupTerminals',
            'prepareFirmware', 'backupDevice', 'flashFirmware'];
        const facade = Object.create(null);
        for (const name of names) { facade[name] = server[name].bind(server); }
        return facade as NoduDeviceService;
    })).inSingletonScope();
});
