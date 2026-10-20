// SPDX-License-Identifier: MIT
// Shared frontend handle for the resources service; one RPC session is
// reused by the update checks and the examples menu.
import { Emitter } from '@theia/core/lib/common/event';
import { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { InstallPhase, InstallProgress, NODU_RESOURCES_PATH, NoduResourcesService, ResourcesClient, ResourcesReady, VersionCheck } from '../common/nodu-resources-protocol';

@injectable()
export class NoduResources implements ResourcesClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    private service!: RpcProxy<NoduResourcesService>;
    private readyPromise?: Promise<ResourcesReady>;
    private readonly progressEmitter = new Emitter<InstallProgress>();
    private readonly phaseEmitter = new Emitter<InstallPhase>();
    readonly onDidInstallProgress = this.progressEmitter.event;
    readonly onDidInstallPhase = this.phaseEmitter.event;

    @postConstruct()
    protected initialize(): void {
        this.service = this.connections.createProxy<NoduResourcesService>(NODU_RESOURCES_PATH, this);
    }

    /** Backend init is shared; every caller waits for the same result. */
    ready(): Promise<ResourcesReady> {
        return this.readyPromise ??= this.service.ready();
    }
    checkVersion(url: string): Promise<VersionCheck> {
        return this.service.checkVersion(url);
    }
    checkResources(url: string): Promise<VersionCheck> {
        return this.service.checkResources(url);
    }
    installResources(template: string, version: string, requireSha256: boolean): Promise<void> {
        return this.service.installResources(template, version, requireSha256);
    }
    cancelInstall(): Promise<void> {
        return this.service.cancelInstall();
    }

    onInstallProgress(progress: InstallProgress): void { this.progressEmitter.fire(progress); }
    onInstallPhase(phase: InstallPhase): void { this.phaseEmitter.fire(phase); }
}
