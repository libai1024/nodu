// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SseParser, SecretGuard, readEvent, requestBody, streamCompletion, listRemoteModels } = require('../lib/node/tutor/tutor-model-gateway');
const { modelDefaults } = require('../lib/common/tutor/tutor-ai-config');

const KEY = 'sk-test-0123456789abcdef';
const provider = (apiFormat = 'chat-completions', baseUrl = 'https://relay.example.com/v1') => ({ id: 'relay', name: 'relay', kind: 'custom', enabled: true, baseUrl, apiFormat, models: [] });
const target = (apiFormat, extra = {}) => ({ provider: provider(apiFormat), model: modelDefaults('m1'), key: KEY, ...extra });
/** A fetch that streams the given byte chunks and records the request. */
function fakeFetch(chunks, { status = 200 } = {}) {
    const calls = [];
    const http = async (url, init) => {
        calls.push({ url, init });
        const body = new ReadableStream({ start(controller) { for (const c of chunks) { controller.enqueue(typeof c === 'string' ? new TextEncoder().encode(c) : c); } controller.close(); } });
        return new Response(body, { status });
    };
    return { http, calls };
}
const chat = text => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;

test('SSE parser handles CRLF, multi-line data, comments and a final event without a blank line', () => {
    const parser = new SseParser();
    const events = [...parser.push(': keep-alive\r\nevent: a\r\ndata: one\r\ndata: two\r\n\r\ndata: x'), ...parser.push('yz\n\n'), ...parser.push('data: tail'), ...parser.finish()];
    assert.deepEqual(events, [{ event: 'a', data: 'one\ntwo' }, { data: 'xyz' }, { data: 'tail' }]);
});

test('secret guard holds back a key split across deltas', () => {
    const out = [];
    const guard = new SecretGuard(KEY, t => out.push(t));
    guard.push('前缀 sk-test-0123');
    assert.ok(!out.join('').includes('sk-test-0123'), 'the partial key is not emitted');
    assert.throws(() => guard.push('456789abcdef 后缀'), /敏感数据/);
    const safe = [];
    const ok = new SecretGuard(KEY, t => safe.push(t));
    ok.push('普通回答'); ok.push('第二段'); ok.finish();
    assert.equal(safe.join(''), '普通回答第二段');
});

test('each API format maps text, completion, truncation and tool calls', () => {
    assert.deepEqual(readEvent('chat-completions', { data: '[DONE]' }), { done: true });
    assert.deepEqual(readEvent('chat-completions', { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{}] } }] }) }), { error: true });
    assert.deepEqual(readEvent('chat-completions', { data: JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) }), { truncated: true });
    assert.deepEqual(readEvent('responses', { event: 'response.output_text.delta', data: JSON.stringify({ delta: '你好' }) }), { text: '你好' });
    assert.deepEqual(readEvent('responses', { data: JSON.stringify({ type: 'response.completed' }) }), { done: true });
    assert.deepEqual(readEvent('anthropic-messages', { event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'text_delta', text: 'hi' } }) }), { text: 'hi' });
    assert.deepEqual(readEvent('anthropic-messages', { event: 'message_stop', data: '{}' }), { done: true });
    assert.deepEqual(readEvent('anthropic-messages', { event: 'content_block_start', data: JSON.stringify({ content_block: { type: 'tool_use' } }) }), { error: true });
});

test('request bodies follow each format; system text moves where the format expects it', () => {
    const messages = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }];
    const r = requestBody(target('responses'), messages);
    assert.equal(r.instructions, 'S'); assert.deepEqual(r.input, [{ role: 'user', content: 'U' }]);
    const a = requestBody(target('anthropic-messages'), messages);
    assert.equal(a.system, 'S'); assert.deepEqual(a.messages, [{ role: 'user', content: 'U' }]);
    const c = requestBody(target('chat-completions', { reasoning: 'high' }), messages);
    assert.equal(c.reasoning_effort, 'high'); assert.equal(c.messages.length, 2);
});

test('streaming joins UTF-8 split across chunks and uses the resolved endpoint and auth header', async () => {
    const bytes = new TextEncoder().encode(chat('中文回答'));
    const { http, calls } = fakeFetch([bytes.slice(0, 31), bytes.slice(31), 'data: [DONE]\n\n']);
    const deltas = [];
    const answer = await streamCompletion(target('chat-completions'), [{ role: 'user', content: 'q' }], new AbortController().signal, t => deltas.push(t), http);
    assert.equal(answer, '中文回答'); assert.equal(deltas.join(''), '中文回答');
    assert.equal(calls[0].url, 'https://relay.example.com/v1/chat/completions');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].init.redirect, 'error');
    const anthropic = fakeFetch([`event: content_block_delta\ndata: ${JSON.stringify({ delta: { type: 'text_delta', text: 'ok' } })}\n\nevent: message_stop\ndata: {}\n\n`]);
    await streamCompletion(target('anthropic-messages'), [{ role: 'user', content: 'q' }], new AbortController().signal, () => undefined, anthropic.http);
    assert.equal(anthropic.calls[0].url, 'https://relay.example.com/v1/messages');
    assert.equal(anthropic.calls[0].init.headers['x-api-key'], KEY);
    assert.equal(anthropic.calls[0].init.headers.Authorization, undefined);
});

test('a stream that ends without a completion event, or with tool calls, fails cleanly', async () => {
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, () => undefined, fakeFetch([chat('半句')]).http), /中断/);
    const tools = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'x' }] } }] })}\n\n`;
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, () => undefined, fakeFetch([tools]).http), /不支持/);
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, () => undefined, fakeFetch(['data: {broken\n\n']).http), /格式无效/);
});

test('HTTP errors and key echoes never reach the caller with upstream text', async () => {
    const { http } = fakeFetch([`{"error":"bad key ${KEY}"}`], { status: 401 });
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, () => undefined, http), error => {
        assert.equal(error.message, 'API Key 无效'); assert.ok(!error.message.includes(KEY)); return true;
    });
    const echo = fakeFetch([chat(`your key is ${KEY.slice(0, 10)}`), chat(KEY.slice(10)), 'data: [DONE]\n\n']);
    const deltas = [];
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, t => deltas.push(t), echo.http), /敏感数据/);
    assert.ok(!deltas.join('').includes(KEY.slice(0, 10)), 'no part of the key was emitted');
    await assert.rejects(streamCompletion(target('chat-completions'), [], new AbortController().signal, () => undefined, fakeFetch([], { status: 429 }).http), /额度或并发受限/);
});

test('a missing key is refused except for local servers', async () => {
    await assert.rejects(streamCompletion({ ...target('chat-completions'), key: undefined }, [], new AbortController().signal, () => undefined, fakeFetch([]).http), /API Key/);
    const local = { provider: provider('chat-completions', 'http://127.0.0.1:11434/v1'), model: modelDefaults('llama'), key: undefined };
    const { http, calls } = fakeFetch([chat('ok'), 'data: [DONE]\n\n']);
    assert.equal(await streamCompletion(local, [], new AbortController().signal, () => undefined, http), 'ok');
    assert.equal(calls[0].init.headers.Authorization, undefined);
});

test('remote model listing filters invalid ids and keeps context windows', async () => {
    const http = async () => new Response(JSON.stringify({ data: [{ id: 'gpt-x', context_length: 128000 }, { id: 'bad id!' }, { id: 'glm-5.3' }] }));
    assert.deepEqual(await listRemoteModels(provider(), KEY, http), [{ id: 'glm-5.3' }, { id: 'gpt-x', contextWindow: 128000 }]);
});
