// SPDX-License-Identifier: MIT
import { interfaces } from '@theia/core/shared/inversify';
import { ConnectionHandler, RpcConnectionHandler, RpcProxy } from '@theia/core/lib/common';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import { ConnectionContainerModule } from '@theia/core/lib/node/messaging/connection-container-module';
import { MainChannel } from '@theia/core/lib/node/messaging/default-messaging-service';
import { Channel } from '@theia/core/lib/common/message-rpc/channel';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { WorkspaceServer, workspacePath } from '@theia/workspace/lib/common/workspace-protocol';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { TutorAIClient, TutorModelTest, TutorService, TUTOR_SERVICE_PATH } from '../../common/tutor/tutor-ai-protocol';
import { TutorModelSelection } from '../../common/tutor/tutor-ai-config';
import { TutorProgressStore } from './tutor-progress-store';
import { TutorStorageServer } from './tutor-storage-server';
import { TutorWorkspaceHost } from './tutor-workspace-host';
import { TutorChatSession } from './tutor-chat-session';
import { TutorAISettingsStore } from './tutor-ai-settings-store';
import { listRemoteModels, streamCompletion } from './tutor-model-gateway';

const STORE = Symbol('NoduTutorStore');
const SETTINGS = Symbol('NoduTutorAISettings');
/** Inversify treats a bound Promise as an async dependency and refuses synchronous get(); keep it inside a holder. */
interface TutorStoreHolder { readonly ready: Promise<TutorStorageServer>; }
interface SettingsHub { readonly ready: Promise<TutorAISettingsStore>; readonly connections: Set<TutorConnection>; }

class TutorConnection {
    client?: RpcProxy<TutorAIClient>;
    /** The model this window chats with; other windows keep their own selection. */
    private selection?: TutorModelSelection;
    readonly ready: Promise<{ host: TutorWorkspaceHost; chat: TutorChatSession; service: TutorService }>;
    constructor(store: Promise<TutorStorageServer>, hub: SettingsHub, channel: Channel) {
        let closed = false;
        hub.connections.add(this);
        channel.onClose(() => { closed = true; hub.connections.delete(this); void this.ready.then(c => { c.chat.dispose(); c.host.dispose(); }); });
        this.ready = Promise.all([store, hub.ready]).then(([storage, settings]) => {
            const notify = (fn: (client: RpcProxy<TutorAIClient>) => unknown): void => { try { const client = this.client; if (client) { void Promise.resolve(fn(client)).catch(() => undefined); } } catch { /* closed */ } };
            const connection = storage.connect({ onDidChange: event => { notify(c => c.onDidChange(event)); } });
            const host = new TutorWorkspaceHost(connection, id => chat.revoke(id), () => notify(c => c.onWorkspacesChanged()));
            const chat = new TutorChatSession({
                complete: async (messages, signal, delta) => streamCompletion(await settings.target(this.selection), messages, signal, delta),
            }, {
                onDidChange: event => notify(c => c.onDidChange(event)),
                onChatDelta: event => notify(c => c.onChatDelta(event)),
                onWorkspacesChanged: () => undefined, onAISettingsChanged: () => undefined,
            }, (id, buffer) => host.authorize(id, buffer));
            /** Mutations reach every other window so their settings and model pickers stay current. */
            const changed = async () => {
                for (const other of hub.connections) { if (other !== this) { try { void other.client?.onAISettingsChanged(); } catch { /* closed */ } } }
                return settings.view(this.selection);
            };
            const service: TutorService = Object.assign(Object.create(null), connection.service, {
                workspaces: () => host.list(),
                aiSettings: () => settings.view(this.selection),
                saveProvider: async (provider: unknown) => { await settings.saveProvider(provider); return changed(); },
                removeProvider: async (id: string) => { await settings.removeProvider(id); return changed(); },
                setProviderKey: async (id: string, key: string) => { await settings.setKey(id, key); return changed(); },
                deleteProviderKey: async (id: string) => { await settings.deleteKey(id); return changed(); },
                selectModel: async (selection: TutorModelSelection) => {
                    await settings.setDefault(selection);
                    this.selection = { providerId: selection.providerId, modelId: selection.modelId, ...(selection.reasoning ? { reasoning: selection.reasoning } : {}) };
                    return changed();
                },
                testModel: async (providerId: string, modelId: string): Promise<TutorModelTest> => {
                    const started = Date.now();
                    try {
                        const target = await settings.targetFor(providerId, modelId);
                        await streamCompletion(target, [{ role: 'user', content: '只回复 OK' }], AbortSignal.timeout(20000), () => undefined);
                        const ms = Date.now() - started;
                        return { ok: true, message: `可用 · ${ms} ms`, ms };
                    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : '测试失败' }; }
                },
                listRemoteModels: async (providerId: string) => {
                    const target = await settings.targetFor(providerId);
                    return listRemoteModels(target.provider, target.key);
                },
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
    const configDir = (ctx: interfaces.Context): Promise<string> => ctx.container.get<EnvVariablesServer>(EnvVariablesServer).getConfigDirUri().then(uri => fileURLToPath(uri));
    bind(SETTINGS).toDynamicValue((ctx): SettingsHub => {
        const keys = ctx.container.get<KeyStoreService>(KeyStoreService);
        return { ready: configDir(ctx).then(dir => new TutorAISettingsStore(join(dir, 'nodu-tutor', 'ai-settings.json'), keys)), connections: new Set() };
    }).inSingletonScope();
    bind(STORE).toDynamicValue((ctx): TutorStoreHolder => ({ ready: configDir(ctx)
        .then(dir => new TutorStorageServer(new TutorProgressStore(join(dir, 'nodu-tutor')))) })).inSingletonScope();
    bind(ConnectionContainerModule).toConstantValue(ConnectionContainerModule.create(({ bind }) => {
        bind(TutorConnection).toDynamicValue(ctx => new TutorConnection(ctx.container.get<TutorStoreHolder>(STORE).ready, ctx.container.get<SettingsHub>(SETTINGS), ctx.container.get(MainChannel))).inSingletonScope();
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
                'workspaces','aiSettings','saveProvider','removeProvider','setProviderKey','deleteProviderKey','selectModel','testModel','listRemoteModels',
                'setPresentation','chat','cancelChat','clearChat'];
            const facade = Object.create(null);
            for (const name of names) { facade[name] = async (...args: unknown[]) => {
                const { service } = await connection.ready;
                return (service[name] as (...args: unknown[]) => unknown)(...args);
            }; }
            return Object.freeze(facade);
        })).inSingletonScope();
    }));
}
