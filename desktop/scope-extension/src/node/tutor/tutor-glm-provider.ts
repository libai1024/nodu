// SPDX-License-Identifier: MIT
export const GLM_CODING_ENDPOINT = 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions';
export const GLM_MODELS = ['glm-5.3', 'glm-5.3-flash', 'glm-4.7', 'glm-4.6'] as const;
export interface TutorModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface TutorModelProvider {
    complete(messages: TutorModelMessage[], signal: AbortSignal, delta: (text: string) => void): Promise<string>;
}
export interface TutorCredentialStore { get(): Promise<string | undefined>; set(value: string): Promise<void>; delete(): Promise<void>; }
/** No plaintext file fallback. An unavailable OS keychain keeps credentials in this process only. */
export class TutorKeychain implements TutorCredentialStore {
    private session: string | undefined;
    storage: 'keychain' | 'session' = 'keychain';
    private keytar(): typeof import('keytar') { return require('keytar'); }
    async get(): Promise<string | undefined> {
        if (this.session) { return this.session; }
        try { return (await this.keytar().getPassword('cn.nodu.tutor.glm-coding', 'default')) ?? undefined; }
        catch { this.storage = 'session'; return undefined; }
    }
    async set(value: string): Promise<void> {
        try { await this.keytar().setPassword('cn.nodu.tutor.glm-coding', 'default', value); this.session = undefined; this.storage = 'keychain'; }
        catch { this.storage = 'session'; this.session = value; }
    }
    async delete(): Promise<void> {
        this.session = undefined;
        try { await this.keytar().deletePassword('cn.nodu.tutor.glm-coding', 'default'); }
        catch { throw new Error('无法删除系统凭证'); }
    }
}

/** Fixed Coding Plan endpoint, no tools, redirects, retries, telemetry or pay-as-you-go fallback. */
export class GlmCodingProvider implements TutorModelProvider {
    constructor(private readonly credentials: TutorCredentialStore, public model = 'glm-5.3', private readonly http: typeof fetch = fetch) { }
    async complete(messages: TutorModelMessage[], signal: AbortSignal, delta: (text: string) => void): Promise<string> {
        const key = await this.credentials.get();
        if (!key) { throw new Error('请配置 GLM API Key'); }
        if (!GLM_MODELS.includes(this.model as typeof GLM_MODELS[number])) { throw new Error('模型不受支持'); }
        if (JSON.stringify(messages).length > 64000) { throw new Error('上下文过长'); }
        let response: Response;
        try {
            response = await this.http(GLM_CODING_ENDPOINT, {
                method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
                headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: this.model, messages, stream: true, max_tokens: 2048, thinking: { type: 'disabled' } }),
            });
        } catch { throw new Error(signal.aborted ? '已停止' : 'GLM 连接超时或网络不可用'); }
        if (!response.ok) {
            void response.body?.cancel();
            const errors: Record<number, string> = { 401: 'GLM 密钥无效', 403: 'GLM 套餐或模型权限不足', 429: 'GLM 额度或并发受限，请稍后重试' };
            throw new Error(errors[response.status] ?? `GLM 请求失败 (${response.status})`);
        }
        if (!response.body) { throw new Error('GLM 返回了空响应'); }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let pending = '', answer = '', bytes = 0, finished = false;
        const line = (raw: string): void => {
            if (!raw.startsWith('data:')) { return; }
            const data = raw.slice(5).trim();
            if (!data) { return; }
            if (data === '[DONE]') { finished = true; return; }
            const chunk = JSON.parse(data);
            if (chunk.error || chunk.choices?.[0]?.delta?.tool_calls) { throw new Error('GLM 响应格式无效'); }
            const text = chunk.choices?.[0]?.delta?.content;
            if (typeof text === 'string') {
                // Do not let an upstream echo leak the credential into UI or transcript.
                if ((answer + text).includes(key)) { throw new Error('GLM 响应包含敏感数据'); }
                answer += text;
                if (answer.length > 24000) { throw new Error('GLM 回复过长'); }
                delta(text);
            }
            if (chunk.choices?.[0]?.finish_reason === 'length') { throw new Error('GLM 回复被截断，请缩小问题范围'); }
        };
        try {
            while (!finished) {
                const { value, done } = await reader.read();
                if (done) { break; }
                bytes += value.byteLength;
                if (bytes > 1024 * 1024) { throw new Error('GLM 响应过大'); }
                pending += decoder.decode(value, { stream: true });
                const lines = pending.split('\n'); pending = lines.pop()!;
                for (const raw of lines) { line(raw.trimEnd()); }
            }
            pending += decoder.decode();
            if (pending.trim()) { line(pending.trimEnd()); }
            if (!finished || !answer.trim()) { throw new Error('GLM 响应中断'); }
            return answer;
        } finally { await reader.cancel().catch(() => undefined); }
    }
}
