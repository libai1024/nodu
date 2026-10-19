// SPDX-License-Identifier: MIT
import { ContainerModule } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler } from '@theia/core/lib/common';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { DeviceClient, NODU_DEVICE_PATH, NoduDeviceService } from '../common/nodu-device-protocol';
import { NoduDeviceServer } from './nodu-device-server';

export default new ContainerModule(bind => {
    bind(NoduDeviceServer).toSelf().inSingletonScope();
    bind(BackendApplicationContribution).toService(NoduDeviceServer);
    bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<DeviceClient>(NODU_DEVICE_PATH, client => {
        const server = ctx.container.get(NoduDeviceServer);
        const remove = server.addClient(client);
        client.onDidCloseConnection(() => remove());
        // RpcProxyFactory dispatches target[method]; TypeScript private is not
        // a runtime boundary. Export only the service API, with no prototype.
        const names: (keyof NoduDeviceService)[] = ['getState', 'listPorts', 'connect', 'disconnect', 'execute',
            'runScript', 'stop', 'listFiles', 'readFile', 'writeFile', 'setPreview', 'startCamera',
            'prepareFirmware', 'backupDevice', 'flashFirmware'];
        const facade = Object.create(null);
        for (const name of names) { facade[name] = server[name].bind(server); }
        return facade as NoduDeviceService;
    })).inSingletonScope();
});
