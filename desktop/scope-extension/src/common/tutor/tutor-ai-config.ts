// SPDX-License-Identifier: MIT
/**
 * AI provider configuration shared by the settings UI and the Node gateway.
 * Credentials never appear here; the gateway keeps them in the OS keychain.
 */
export type TutorApiFormat = 'chat-completions' | 'responses' | 'anthropic-messages';
export type TutorInputType = 'text' | 'image' | 'video' | 'pdf';
/** builtin: shipped with Nodu; custom: added by the user; account: reserved for the account system's default relay. */
export type TutorProviderKind = 'builtin' | 'custom' | 'account';

export interface TutorModelConfig {
    id: string;
    enabled: boolean;
    /** Tokens the model accepts in one request; unknown when the user has not entered it. */
    contextWindow?: number;
    maxOutputTokens?: number;
    inputs: TutorInputType[];
    structuredOutput: boolean;
    webSearch: boolean;
    systemInConversation: boolean;
    /** Ordered low to high, e.g. low / medium / high. Empty when the model has no reasoning control. */
    reasoningLevels: string[];
}
export interface TutorProviderConfig {
    id: string;
    name: string;
    kind: TutorProviderKind;
    enabled: boolean;
    baseUrl: string;
    apiFormat: TutorApiFormat;
    models: TutorModelConfig[];
}
export interface TutorModelSelection { providerId: string; modelId: string; reasoning?: string }
export interface TutorAISettingsFile { schema: 1; providers: TutorProviderConfig[]; defaultModel?: TutorModelSelection }
/** What the UI receives: configuration plus key presence, never the key itself. */
export interface TutorProviderView extends TutorProviderConfig { hasKey: boolean; endpoint: string }
export interface TutorAISettingsView {
    providers: TutorProviderView[];
    selection?: TutorModelSelection;
    storage: 'keychain' | 'session';
    /** Reserved: the account system will supply a default relay and model configuration. */
    account: { status: 'signed-out' };
}

export const API_FORMATS: ReadonlyArray<{ value: TutorApiFormat; label: string }> = [
    { value: 'chat-completions', label: 'Chat Completions (/chat/completions)' },
    { value: 'responses', label: 'Responses (/responses)' },
    { value: 'anthropic-messages', label: 'Anthropic Messages (/messages)' },
];
export const GLM_CODING_PROVIDER = 'glm-coding';
const GLM_BASE = 'https://open.bigmodel.cn/api/coding/paas/v4';
const ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/;
const LEVEL = /^[A-Za-z0-9_-]{1,20}$/;
const INPUTS: TutorInputType[] = ['text', 'image', 'video', 'pdf'];

export function modelDefaults(id: string): TutorModelConfig {
    return { id, enabled: true, inputs: ['text'], structuredOutput: false, webSearch: false, systemInConversation: false, reasoningLevels: [] };
}
/** The built-in GLM Coding Plan entry; its endpoint and format are fixed. */
export function builtinProviders(): TutorProviderConfig[] {
    return [{ id: GLM_CODING_PROVIDER, name: '智谱 GLM Coding Plan', kind: 'builtin', enabled: true, baseUrl: GLM_BASE, apiFormat: 'chat-completions',
        models: ['glm-5.3', 'glm-5.3-flash', 'glm-4.7', 'glm-4.6'].map(modelDefaults) }];
}
export function defaultSettingsFile(): TutorAISettingsFile {
    return { schema: 1, providers: builtinProviders(), defaultModel: { providerId: GLM_CODING_PROVIDER, modelId: 'glm-5.3' } };
}

const isLoopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
/** HTTPS, or plain HTTP only to this machine (local model servers). No credentials, query or fragment. */
export function normalizeBaseUrl(raw: unknown): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > 300) { throw new Error('Base URL 无效'); }
    let url: URL;
    try { url = new URL(raw.trim()); } catch { throw new Error('Base URL 无效'); }
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) { throw new Error('Base URL 需使用 https（本机地址可用 http）'); }
    if (url.username || url.password || url.search || url.hash) { throw new Error('Base URL 不能包含账号、查询参数或锚点'); }
    return url.toString().replace(/\/+$/, '');
}
export function allowsNoKey(baseUrl: string): boolean {
    try { return isLoopback(new URL(baseUrl).hostname); } catch { return false; }
}
/** A bare host gets the conventional /v1 prefix; a base that already has a path is used as given. */
export function resolveEndpoint(baseUrl: string, format: TutorApiFormat): string {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    const prefix = path ? path : '/v1';
    const suffix = format === 'chat-completions' ? '/chat/completions' : format === 'responses' ? '/responses' : '/messages';
    return `${url.origin}${prefix}${suffix}`;
}
export function resolveModelsEndpoint(baseUrl: string): string {
    const url = new URL(baseUrl);
    const path = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${path || '/v1'}/models`;
}

const positive = (value: unknown, max: number, label: string): number | undefined => {
    if (value === undefined || value === null || value === '') { return undefined; }
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) { throw new Error(`${label}无效`); }
    return value as number;
};
export function validateModel(raw: unknown): TutorModelConfig {
    const m = raw as Partial<TutorModelConfig> | undefined;
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || !MODEL_ID.test(m.id)) { throw new Error('模型 ID 无效'); }
    const inputs = Array.isArray(m.inputs) ? m.inputs : ['text'];
    if (inputs.some(i => !INPUTS.includes(i as TutorInputType))) { throw new Error('输入类型无效'); }
    const levels = Array.isArray(m.reasoningLevels) ? m.reasoningLevels : [];
    if (levels.length > 8 || levels.some(l => typeof l !== 'string' || !LEVEL.test(l)) || new Set(levels).size !== levels.length) { throw new Error('推理等级无效'); }
    return {
        id: m.id, enabled: m.enabled !== false,
        contextWindow: positive(m.contextWindow, 10_000_000, '上下文窗口'),
        maxOutputTokens: positive(m.maxOutputTokens, 1_000_000, '最大输出 Tokens'),
        // Text is always accepted; the other inputs are capability flags for later features.
        inputs: INPUTS.filter(i => i === 'text' || inputs.includes(i)),
        structuredOutput: m.structuredOutput === true, webSearch: m.webSearch === true, systemInConversation: m.systemInConversation === true,
        reasoningLevels: levels as string[],
    };
}
export function validateProvider(raw: unknown, existing?: TutorProviderConfig): TutorProviderConfig {
    const p = raw as Partial<TutorProviderConfig> | undefined;
    if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !ID.test(p.id)) { throw new Error('供应商标识无效'); }
    if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 40) { throw new Error('供应商名称需为 1–40 个字符'); }
    if (!Array.isArray(p.models) || p.models.length > 64) { throw new Error('模型列表无效'); }
    const models = p.models.map(validateModel);
    if (new Set(models.map(m => m.id)).size !== models.length) { throw new Error('模型 ID 重复'); }
    const kind = existing?.kind ?? 'custom';
    if (kind === 'account') { throw new Error('账号供应商由账号系统管理'); }
    // Built-in endpoints are fixed so a Coding Plan key is never sent to another host.
    const locked = kind === 'builtin';
    const apiFormat = locked ? existing!.apiFormat : p.apiFormat;
    if (!API_FORMATS.some(f => f.value === apiFormat)) { throw new Error('API 格式无效'); }
    return { id: p.id, name: p.name.trim(), kind, enabled: p.enabled !== false,
        baseUrl: locked ? existing!.baseUrl : normalizeBaseUrl(p.baseUrl), apiFormat: apiFormat as TutorApiFormat, models };
}
export function validateSettingsFile(raw: unknown): TutorAISettingsFile {
    const file = raw as Partial<TutorAISettingsFile> | undefined;
    if (!file || file.schema !== 1 || !Array.isArray(file.providers) || file.providers.length > 32) { throw new Error('AI 配置文件无效'); }
    const builtins = builtinProviders();
    const providers: TutorProviderConfig[] = [];
    for (const builtin of builtins) {
        const saved = file.providers.find(p => p?.id === builtin.id);
        providers.push(saved ? validateProvider({ ...saved, id: builtin.id }, builtin) : builtin);
    }
    for (const raw of file.providers) {
        if (!raw || builtins.some(b => b.id === raw.id) || (raw as TutorProviderConfig).kind === 'account') { continue; }
        providers.push(validateProvider(raw));
    }
    if (new Set(providers.map(p => p.id)).size !== providers.length) { throw new Error('供应商标识重复'); }
    const sel = file.defaultModel;
    const defaultModel = sel && typeof sel.providerId === 'string' && typeof sel.modelId === 'string' ? { providerId: sel.providerId, modelId: sel.modelId,
        ...(typeof sel.reasoning === 'string' && LEVEL.test(sel.reasoning) ? { reasoning: sel.reasoning } : {}) } : undefined;
    return { schema: 1, providers, ...(defaultModel ? { defaultModel } : {}) };
}
/** The selection if it names an enabled model, otherwise the first enabled model. */
export function effectiveSelection(providers: readonly TutorProviderConfig[], wanted?: TutorModelSelection): TutorModelSelection | undefined {
    const usable = (p: TutorProviderConfig) => p.enabled && p.kind !== 'account';
    const provider = wanted && providers.find(p => p.id === wanted.providerId && usable(p));
    const model = provider?.models.find(m => m.id === wanted!.modelId && m.enabled);
    if (provider && model) {
        return { providerId: provider.id, modelId: model.id, ...(wanted!.reasoning && model.reasoningLevels.includes(wanted!.reasoning) ? { reasoning: wanted!.reasoning } : {}) };
    }
    for (const p of providers) {
        const m = usable(p) ? p.models.find(x => x.enabled) : undefined;
        if (m) { return { providerId: p.id, modelId: m.id }; }
    }
    return undefined;
}
export function formatTokens(value?: number): string {
    if (!value) { return ''; }
    return value >= 1_000_000 ? `${+(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}K` : String(value);
}
