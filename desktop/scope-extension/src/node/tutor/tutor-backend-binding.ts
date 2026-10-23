// SPDX-License-Identifier: MIT
import { interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler, RpcProxy } from '@theia/core/lib/common';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { MainChannel } from '@theia/core/lib/node/messaging/default-messaging-service';
import { Channel } from '@theia/core/lib/common/message-rpc/channel';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { WorkspaceServer, workspacePath } from '@theia/workspace/lib/common/workspace-protocol';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TutorAIClient, TutorService, TUTOR_SERVICE_PATH } from '../../common/tutor/tutor-ai-protocol';
import { TutorProgressStore } from './tutor-progress-store';
import { TutorStorageServer } from './tutor-storage-server';
import { TutorWorkspaceHost } from './tutor-workspace-host';
import { TutorChatSession } from './tutor-chat-session';
import { GlmCodingProvider, GLM_MODELS, TutorKeychain } from './tutor-glm-provider';

const STORE = Symbol('NoduTutorStore');
const CREDENTIALS = Symbol('NoduTutorCredentials');
const PROVIDER = Symbol('NoduTutorProvider');
/** Inversify treats a bound Promise as an async dependency and refuses synchronous get(); keep it inside a holder. */
interface TutorStoreHolder { readonly ready: Promise<TutorStorageServer>; }
class TutorConnection {
    client?: RpcProxy<TutorAIClient>;
    readonly ready: Promise<{ host: TutorWorkspaceHost; chat: TutorChatSession; service: TutorService }>;
    constructor(store: Promise<TutorStorageServer>, credentials: TutorKeychain, provider: GlmCodingProvider, channel: Channel) {
        let closed = false;
        channel.onClose(() => { closed = true; void this.ready.then(c => { c.chat.dispose(); c.host.dispose(); }); });
        this.ready = store.then(storage => {
            const connection = storage.connect({ onDidChange: event => { this.client?.onDidChange(event); } });
            const host = new TutorWorkspaceHost(connection, id => chat.revoke(id));
            const chat = new TutorChatSession(provider, {
                onDidChange: event => this.client?.onDidChange(event),
                onChatDelta: event => { void this.client?.onChatDelta(event); },
            }, (id, buffer) => host.authorize(id, buffer));
            const state = async () => ({ provider: 'glm-coding' as const, model: provider.model, configured: !!await credentials.get(), storage: credentials.storage });
            const service: TutorService = Object.assign(Object.create(null), connection.service, {
                workspaces: () => host.list(),
                providerState: state,
                configureProvider: async (key: string, model: string) => {
                    if (typeof key !== 'string' || key.length > 512 || (key && !/^[A-Za-z0-9._-]{16,512}$/.test(key)) || !GLM_MODELS.includes(model as typeof GLM_MODELS[number])) { throw new Error('GLM 配置无效'); }
                    if (key) { await credentials.set(key); }
                    provider.model = model;
                    return state();
                },
                forgetCredential: () => credentials.delete(),
                setPresentation: (id: string, epoch: number, mode: 'teach' | 'ask', paused: boolean) => chat.setPresentation(id, epoch, mode, paused),
                chat: (request: Parameters<TutorService['chat']>[0]) => chat.chat(request),
                cancelChat: async (id: string) => chat.cancel(id),
                clearChat: async (id: string, mode: 'teach' | 'ask') => { await host.authorize(id); chat.clear(id, mode); },
            });
            if (closed) { chat.dispose(); host.dispose(); }
            return { host, chat, service: Object.freeze(service) };
        });
    }
}
export function bindTutorBackend(bind: interfaces.Bind): void {
    bind(CREDENTIALS).toDynamicValue(() => new TutorKeychain()).inSingletonScope();
    bind(PROVIDER).toDynamicValue(ctx => new GlmCodingProvider(ctx.container.get(CREDENTIALS))).inSingletonScope();
    bind(STORE).toDynamicValue((ctx): TutorStoreHolder => ({ ready: ctx.container.get<EnvVariablesServer>(EnvVariablesServer).getConfigDirUri()
        .then(uri => new TutorStorageServer(new TutorProgressStore(join(fileURLToPath(uri), 'nodu-tutor')))) })).inSingletonScope();
    bind(ConnectionContainerModule).toConstantValue(ConnectionContainerModule.create(({ bind }) => {
        bind(TutorConnection).toDynamicValue(ctx => new TutorConnection(ctx.container.get<TutorStoreHolder>(STORE).ready, ctx.container.get(CREDENTIALS), ctx.container.get(PROVIDER), ctx.container.get(MainChannel))).inSingletonScope();
        // Scoped handlers are resolved before inherited handlers by Theia's messaging container.
        bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler(workspacePath, () => {
            const base = ctx.container.get<WorkspaceServer>(WorkspaceServer);
            const connection = ctx.container.get(TutorConnection);
            return Object.assign(Object.create(null), {
                getMostRecentlyUsedWorkspace: () => base.getMostRecentlyUsedWorkspace(),
                getRecentWorkspaces: () => base.getRecentWorkspaces(),
                removeRecentWorkspace: (uri: string) => base.removeRecentWorkspace(uri),
                setMostRecentlyUsedWorkspace: async (uri: string) => {
                    await base.setMostRecentlyUsedWorkspace(uri);
                    // Workspace opening remains available if the optional tutor cannot inspect it.
                    await connection.ready.then(c => c.host.select(uri)).catch(() => undefined);
                },
            });
        })).inSingletonScope();
        bind(ConnectionHandler).toDynamicValue(ctx => new RpcConnectionHandler<TutorAIClient>(TUTOR_SERVICE_PATH, client => {
            const connection = ctx.container.get(TutorConnection);
            connection.client = client;
            const names: (keyof TutorService)[] = ['openSession','getSnapshot','closeSession','previewMigration','acceptMigration','recordAction','importLegacyProgress',
                'workspaces','providerState','configureProvider','forgetCredential','setPresentation','chat','cancelChat','clearChat'];
            const facade = Object.create(null);
            for (const name of names) { facade[name] = async (...args: unknown[]) => {
                const { service } = await connection.ready;
                return (service[name] as (...args: unknown[]) => unknown)(...args);
            }; }
            return Object.freeze(facade);
        })).inSingletonScope();
    }));
}
