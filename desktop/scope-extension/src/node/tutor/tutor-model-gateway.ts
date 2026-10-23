// SPDX-License-Identifier: MIT
import { TutorApiFormat, TutorModelConfig, TutorProviderConfig, allowsNoKey, resolveEndpoint, resolveModelsEndpoint } from '../../common/tutor/tutor-ai-config';
import type { TutorRemoteModel } from '../../common/tutor/tutor-ai-protocol';

export interface TutorModelMessage { role: 'system' | 'user' | 'assistant'; content: string }
export interface TutorModelProvider {
    complete(messages: TutorModelMessage[], signal: AbortSignal, delta: (text: string) => void): Promise<string>;
}
export interface TutorModelTarget { provider: TutorProviderConfig; model: TutorModelConfig; key?: string; reasoning?: string }

const MAX_BYTES = 1024 * 1024;
const MAX_ANSWER = 24000;
const MAX_CONTEXT = 64000;
const TIMEOUT_MS = 60000;

/** One server-sent event: the event name (if any) and its data lines joined with "\n". */
export interface SseEvent { event?: string; data: string }

/**
 * Incremental SSE framing. Handles CRLF, multi-line data fields, comments and a final event
 * without a trailing blank line. Bytes are decoded with a streaming UTF-8 decoder by the caller.
 */
export class SseParser {
    private buffer = '';
    private event?: string;
    private data: string[] = [];
    push(text: string): SseEvent[] {
        this.buffer += text;
        const out: SseEvent[] = [];
        let index: number;
        while ((index = this.buffer.search(/\r\n|\r|\n/)) >= 0) {
            // A CR at a network chunk boundary may be the first half of CRLF.
            if (this.buffer[index] === '\r' && index === this.buffer.length - 1) { break; }
            const line = this.buffer.slice(0, index);
            this.buffer = this.buffer.slice(index + (this.buffer.startsWith('\r\n', index) ? 2 : 1));
            this.line(line, out);
        }
        return out;
    }
    finish(): SseEvent[] {
        const out: SseEvent[] = [];
        if (this.buffer) { this.line(this.buffer.replace(/\r$/, ''), out); this.buffer = ''; }
        this.line('', out);
        return out;
    }
    private line(line: string, out: SseEvent[]): void {
        if (!line) {
            if (this.data.length) { out.push({ ...(this.event ? { event: this.event } : {}), data: this.data.join('\n') }); }
            this.event = undefined; this.data = [];
            return;
        }
        if (line.startsWith(':')) { return; }
        const colon = line.indexOf(':');
        const field = colon < 0 ? line : line.slice(0, colon);
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'data') { this.data.push(value); } else if (field === 'event') { this.event = value; }
    }
}

/**
 * Holds back the last key.length - 1 characters so a credential split across deltas is
 * detected before any part of it reaches the UI or the transcript.
 */
export class SecretGuard {
    private held = '';
    constructor(private readonly secret: string | undefined, private readonly emit: (text: string) => void) { }
    push(text: string): void {
        if (!this.secret) { this.emit(text); return; }
        this.held += text;
        if (this.held.includes(this.secret)) { throw new Error('模型响应包含敏感数据'); }
        const keep = this.secret.length - 1;
        if (this.held.length > keep) { this.emit(this.held.slice(0, this.held.length - keep)); this.held = this.held.slice(this.held.length - keep); }
    }
    finish(): void { if (this.held) { this.emit(this.held); this.held = ''; } }
}

type Outcome = { text?: string; done?: boolean; truncated?: boolean; error?: boolean };
/** Map one event of each API format to text, completion and failure. Unknown events are ignored. */
export function readEvent(format: TutorApiFormat, event: SseEvent): Outcome {
    if (format === 'chat-completions') {
        if (event.data === '[DONE]') { return { done: true }; }
        const chunk = JSON.parse(event.data);
        const choice = chunk.choices?.[0];
        if (chunk.error || choice?.delta?.tool_calls) { return { error: true }; }
        return { ...(typeof choice?.delta?.content === 'string' ? { text: choice.delta.content } : {}),
            ...(choice?.finish_reason === 'length' ? { truncated: true } : {}) };
    }
    const chunk = JSON.parse(event.data);
    const type = event.event ?? chunk.type;
    if (format === 'responses') {
        if (type === 'response.output_text.delta' && typeof chunk.delta === 'string') { return { text: chunk.delta }; }
        if (type === 'response.completed') { return { done: true }; }
        if (type === 'response.incomplete') { return chunk.response?.incomplete_details?.reason === 'max_output_tokens' ? { truncated: true } : { error: true }; }
        if (type === 'response.failed' || type === 'error' || type === 'response.function_call_arguments.delta') { return { error: true }; }
        return {};
    }
    if (type === 'content_block_delta' && chunk.delta?.type === 'text_delta' && typeof chunk.delta.text === 'string') { return { text: chunk.delta.text }; }
    if (type === 'content_block_start' && chunk.content_block?.type === 'tool_use') { return { error: true }; }
    if (type === 'message_delta' && chunk.delta?.stop_reason === 'max_tokens') { return { truncated: true }; }
    if (type === 'message_stop') { return { done: true }; }
    if (type === 'error') { return { error: true }; }
    return {};
}

export function requestBody(target: TutorModelTarget, messages: TutorModelMessage[]): Record<string, unknown> {
    const { provider, model, reasoning } = target;
    const max = Math.min(model.maxOutputTokens ?? 2048, 8192);
    const system = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
    const turns = messages.filter(m => m.role !== 'system');
    if (provider.apiFormat === 'responses') {
        return { model: model.id, stream: true, max_output_tokens: max, ...(system ? { instructions: system } : {}),
            input: turns.map(m => ({ role: m.role, content: m.content })), ...(reasoning ? { reasoning: { effort: reasoning } } : {}) };
    }
    if (provider.apiFormat === 'anthropic-messages') {
        return { model: model.id, stream: true, max_tokens: max, ...(system ? { system } : {}), messages: turns.map(m => ({ role: m.role, content: m.content })) };
    }
    return { model: model.id, stream: true, max_tokens: max, messages,
        // The built-in Coding Plan endpoint answers faster with thinking off unless a level is chosen.
        ...(provider.kind === 'builtin' ? { thinking: { type: reasoning ? 'enabled' : 'disabled' } } : reasoning ? { reasoning_effort: reasoning } : {}) };
}

function headers(target: TutorModelTarget): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' };
    if (!target.key) { return h; }
    if (target.provider.apiFormat === 'anthropic-messages') { h['x-api-key'] = target.key; h['anthropic-version'] = '2023-06-01'; }
    else { h.Authorization = `Bearer ${target.key}`; }
    return h;
}
/** User-facing errors never carry headers, keys or upstream bodies. */
function statusError(status: number): Error {
    const errors: Record<number, string> = { 400: '模型拒绝了请求，请检查模型 ID 与 API 格式', 401: 'API Key 无效', 403: '套餐或模型权限不足',
        404: '接口地址或模型不存在，请检查 Base URL 与 API 格式', 408: '模型服务超时', 413: '请求内容过大', 429: '额度或并发受限，请稍后重试' };
    return new Error(errors[status] ?? (status >= 500 ? `模型服务暂时不可用 (${status})` : `模型请求失败 (${status})`));
}

/** Streams one completion. No tools, redirects, retries or fallback to another endpoint. */
export async function streamCompletion(target: TutorModelTarget, messages: TutorModelMessage[], signal: AbortSignal,
    delta: (text: string) => void, http: typeof fetch = fetch): Promise<string> {
    if (!target.key && !allowsNoKey(target.provider.baseUrl)) { throw new Error('请先在 AI 设置中填写 API Key'); }
    if (JSON.stringify(messages).length > MAX_CONTEXT) { throw new Error('上下文过长'); }
    let response: Response;
    try {
        response = await http(resolveEndpoint(target.provider.baseUrl, target.provider.apiFormat), {
            method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
            headers: headers(target), body: JSON.stringify(requestBody(target, messages)),
        });
    } catch { throw new Error(signal.aborted ? '已停止' : '模型服务连接超时或网络不可用'); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw statusError(response.status); }
    if (!response.body) { throw new Error('模型返回了空响应'); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const parser = new SseParser();
    let answer = '', bytes = 0, finished = false;
    const guard = new SecretGuard(target.key, text => {
        answer += text;
        if (answer.length > MAX_ANSWER) { throw new Error('模型回复过长'); }
        delta(text);
    });
    const handle = (events: SseEvent[]): void => {
        for (const event of events) {
            if (finished) { return; }
            let outcome: Outcome;
            try { outcome = readEvent(target.provider.apiFormat, event); } catch { throw new Error('模型响应格式无效'); }
            if (outcome.error) { throw new Error('模型返回了错误或不支持的内容'); }
            if (outcome.text) { guard.push(outcome.text); }
            if (outcome.truncated) { throw new Error('模型回复被截断，请缩小问题范围或调高最大输出 Tokens'); }
            if (outcome.done) { finished = true; }
        }
    };
    try {
        while (!finished) {
            let chunk: ReadableStreamReadResult<Uint8Array>;
            try { chunk = await reader.read(); } catch { throw new Error(signal.aborted ? '已停止' : '模型响应中断'); }
            if (chunk.done) { break; }
            bytes += chunk.value.byteLength;
            if (bytes > MAX_BYTES) { throw new Error('模型响应过大'); }
            let text: string;
            try { text = decoder.decode(chunk.value, { stream: true }); } catch { throw new Error('模型响应编码无效'); }
            handle(parser.push(text));
        }
        if (!finished) {
            try { handle(parser.push(decoder.decode())); } catch (error) { if (error instanceof TypeError) { throw new Error('模型响应编码无效'); } throw error; }
            handle(parser.finish());
        }
        if (!finished) { throw new Error('模型响应中断'); }
        guard.finish();
        if (!answer.trim()) { throw new Error('模型没有返回内容'); }
        return answer;
    } finally { await reader.cancel().catch(() => undefined); }
}

/** Reads the provider's model list (OpenAI-compatible /models). Used to suggest IDs; never required. */
export async function listRemoteModels(provider: TutorProviderConfig, key: string | undefined, http: typeof fetch = fetch): Promise<TutorRemoteModel[]> {
    if (!key && !allowsNoKey(provider.baseUrl)) { throw new Error('请先填写 API Key'); }
    const h: Record<string, string> = { Accept: 'application/json' };
    if (key) { if (provider.apiFormat === 'anthropic-messages') { h['x-api-key'] = key; h['anthropic-version'] = '2023-06-01'; } else { h.Authorization = `Bearer ${key}`; } }
    let response: Response;
    try { response = await http(resolveModelsEndpoint(provider.baseUrl), { method: 'GET', redirect: 'error', headers: h, signal: AbortSignal.timeout(15000) }); }
    catch { throw new Error('模型服务连接超时或网络不可用'); }
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw statusError(response.status); }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) { throw new Error('模型列表过大'); }
    let data: { data?: Array<{ id?: unknown; context_length?: unknown; context_window?: unknown }> };
    try { data = JSON.parse(text); } catch { throw new Error('模型列表格式无效'); }
    const out: TutorRemoteModel[] = [];
    for (const item of Array.isArray(data?.data) ? data.data : []) {
        if (typeof item?.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,119}$/.test(item.id)) { continue; }
        const context = Number(item.context_length ?? item.context_window);
        out.push({ id: item.id, ...(Number.isSafeInteger(context) && context > 0 ? { contextWindow: context } : {}) });
        if (out.length >= 500) { break; }
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}
