// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KeyStoreService } from '@theia/core/lib/common/key-store';
import {
    GLM_CODING_PROVIDER, TutorAISettingsFile, TutorAISettingsView, TutorModelSelection, TutorProviderConfig,
    defaultSettingsFile, effectiveSelection, resolveEndpoint, validateProvider, validateSettingsFile,
} from '../../common/tutor/tutor-ai-config';
import type { TutorModelTarget } from './tutor-model-gateway';

const KEY_SERVICE = 'cn.nodu.tutor.ai';
/** The key the first GLM-only build stored; read once so existing users keep their key. */
const LEGACY_SERVICE = 'cn.nodu.tutor.glm-coding';
const KEY = /^[\x21-\x7e]{8,512}$/;

/**
 * Provider configuration in the Nodu config directory, API keys in the OS keychain through
 * Theia's KeyStoreService. If the keychain is unavailable, keys live only in this process.
 */
export class TutorAISettingsStore {
    private file?: TutorAISettingsFile;
    private loading?: Promise<TutorAISettingsFile>;
    private writing: Promise<unknown> = Promise.resolve();
    private readonly session = new Map<string, string>();
    storage: 'keychain' | 'session' = 'keychain';

    constructor(private readonly path: string, private readonly keys: Pick<KeyStoreService, 'getPassword' | 'setPassword' | 'deletePassword'>, private readonly readStoredKeys = true) { if (!readStoredKeys) { this.storage = 'session'; } }

    private async read(): Promise<TutorAISettingsFile> {
        if (this.file) { return this.file; }
        this.loading ??= (async () => {
            let file: TutorAISettingsFile;
            try {
                const text = await fs.readFile(this.path, 'utf8');
                if (text.length > 512 * 1024) { throw new Error('too large'); }
                file = validateSettingsFile(JSON.parse(text));
            } catch (error) {
                // A missing file is normal; a damaged one is kept aside, never silently overwritten.
                if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
                    await fs.rename(this.path, `${this.path}.invalid-${Date.now()}`).catch(() => undefined);
                }
                file = defaultSettingsFile();
            }
            this.file = file;
            return file;
        })();
        return this.loading;
    }
    private async save(file: TutorAISettingsFile): Promise<void> {
        this.file = file;
        const run = this.writing.catch(() => undefined).then(async () => {
            await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
            const temporary = join(dirname(this.path), `.ai-settings-${randomUUID()}.tmp`);
            const handle = await fs.open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(file, null, 2) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
            await fs.rename(temporary, this.path);
        });
        this.writing = run;
        await run;
    }

    async getKey(providerId: string): Promise<string | undefined> {
        const session = this.session.get(providerId);
        if (session) { return session; }
        if (!this.readStoredKeys) { return undefined; }
        try {
            const stored = await this.keys.getPassword(KEY_SERVICE, providerId);
            if (stored) { return stored; }
            if (providerId === GLM_CODING_PROVIDER) {
                const legacy = await this.keys.getPassword(LEGACY_SERVICE, 'default');
                if (legacy) {
                    await this.keys.setPassword(KEY_SERVICE, providerId, legacy);
                    await this.keys.deletePassword(LEGACY_SERVICE, 'default').catch(() => false);
                    return legacy;
                }
            }
            return undefined;
        } catch { this.storage = 'session'; return undefined; }
    }
    async setKey(providerId: string, key: string): Promise<void> {
        if (typeof key !== 'string' || !KEY.test(key)) { throw new Error('API Key 格式无效'); }
        await this.provider(providerId);
        if (!this.readStoredKeys) { this.session.set(providerId, key); return; }
        try { await this.keys.setPassword(KEY_SERVICE, providerId, key); this.session.delete(providerId); this.storage = 'keychain'; }
        catch { this.storage = 'session'; this.session.set(providerId, key); }
    }
    async deleteKey(providerId: string): Promise<void> {
        this.session.delete(providerId);
        if (!this.readStoredKeys) { return; }
        try { await this.keys.deletePassword(KEY_SERVICE, providerId); }
        catch { throw new Error('无法删除系统凭证'); }
        if (providerId === GLM_CODING_PROVIDER) { await this.keys.deletePassword(LEGACY_SERVICE, 'default').catch(() => false); }
    }

    private async provider(id: string): Promise<TutorProviderConfig> {
        const provider = (await this.read()).providers.find(p => p.id === id);
        if (!provider) { throw new Error('供应商不存在'); }
        return provider;
    }
    async view(selection?: TutorModelSelection): Promise<TutorAISettingsView> {
        const file = await this.read();
        const providers = await Promise.all(file.providers.map(async p => ({ ...p, hasKey: !!await this.getKey(p.id),
            endpoint: resolveEndpoint(p.baseUrl, p.apiFormat) })));
        return { providers, selection: effectiveSelection(file.providers, selection ?? file.defaultModel), storage: this.storage, account: { status: 'signed-out' } };
    }
    async defaultSelection(): Promise<TutorModelSelection | undefined> {
        const file = await this.read();
        return effectiveSelection(file.providers, file.defaultModel);
    }
    async saveProvider(raw: unknown): Promise<void> {
        const file = await this.read();
        const id = (raw as { id?: unknown })?.id;
        const existing = file.providers.find(p => p.id === id);
        const next = validateProvider(raw, existing);
        if (!existing && file.providers.length >= 32) { throw new Error('供应商数量已达上限'); }
        // Re-authenticate after any endpoint/protocol change. Never forward the old secret to a new destination.
        if (existing && (existing.baseUrl !== next.baseUrl || existing.apiFormat !== next.apiFormat)) { await this.deleteKey(next.id); }
        const providers = existing ? file.providers.map(p => p.id === next.id ? next : p) : [...file.providers, next];
        await this.save({ ...file, providers });
    }
    async removeProvider(id: string): Promise<void> {
        const file = await this.read();
        const provider = await this.provider(id);
        if (provider.kind !== 'custom') { throw new Error('内置供应商不能删除'); }
        await this.save({ ...file, providers: file.providers.filter(p => p.id !== id) });
        await this.deleteKey(id).catch(() => undefined);
    }
    async setDefault(selection: TutorModelSelection): Promise<void> {
        const file = await this.read();
        const effective = effectiveSelection(file.providers, selection);
        if (!effective || effective.providerId !== selection.providerId || effective.modelId !== selection.modelId) { throw new Error('模型未启用或不存在'); }
        await this.save({ ...file, defaultModel: effective });
    }
    /** A specific provider (and model) for tests and model listing, even if not the current selection. */
    async targetFor(providerId: string, modelId?: string): Promise<TutorModelTarget> {
        const provider = await this.provider(providerId);
        const model = modelId ? provider.models.find(m => m.id === modelId) : provider.models[0];
        if (modelId && !model) { throw new Error('模型不存在'); }
        return { provider, model: model ?? { id: '', enabled: false, inputs: ['text'], structuredOutput: false, webSearch: false, systemInConversation: false, reasoningLevels: [] },
            key: await this.getKey(provider.id) };
    }
    /** Resolves a selection to everything the gateway needs, or explains what is missing. */
    async target(selection?: TutorModelSelection): Promise<TutorModelTarget> {
        const file = await this.read();
        const effective = effectiveSelection(file.providers, selection ?? file.defaultModel);
        if (!effective) { throw new Error('没有可用的模型，请在 AI 设置中启用一个模型'); }
        const provider = file.providers.find(p => p.id === effective.providerId)!;
        const model = provider.models.find(m => m.id === effective.modelId)!;
        return { provider, model, key: await this.getKey(provider.id), ...(effective.reasoning ? { reasoning: effective.reasoning } : {}) };
    }
}
