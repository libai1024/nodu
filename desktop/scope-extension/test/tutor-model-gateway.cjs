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


test('SSE preserves CRLF split at every network boundary including multiline data and event names',()=>{
 const stream='event: response.output_text.delta\r\ndata: {"delta":\r\ndata: "你好"}\r\n\r\n';
 const expected=[{event:'response.output_text.delta',data:'{"delta":\n"你好"}'}];
 for(let n=1;n<stream.length;n++){const p=new SseParser();assert.deepEqual([...p.push(stream.slice(0,n)),...p.push(stream.slice(n)),...p.finish()],expected);}
 const p=new SseParser();let result=[];for(const ch of stream)result.push(...p.push(ch));result.push(...p.finish());assert.deepEqual(result,expected);
 const last=new SseParser();assert.deepEqual([...last.push('event: done\rdata: ok\r'),...last.finish()],[{event:'done',data:'ok'}]);
});

test('cancellation interrupts a blocked reader even when transport ignores the signal and cancel never settles', { timeout: 1500 }, async () => {
    const controller = new AbortController();
    let cancelled = 0;
    const http = async () => new Response(new ReadableStream({ cancel() { cancelled++; return new Promise(() => {}); } }));
    const output = [];
    const pending = streamCompletion(target(), [], controller.signal, t => output.push(t), http);
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, /已停止/);
    assert.equal(cancelled, 1);
    assert.deepEqual(output, []);
});

test('already cancelled calls never reach the provider; cancellation during delta prevents success', async () => {
    const stopped = new AbortController(); stopped.abort();
    let calls = 0;
    await assert.rejects(streamCompletion(target(), [], stopped.signal, () => {}, async () => { calls++; }), /已停止/);
    assert.equal(calls, 0);
    const controller = new AbortController();
    const local = target('chat-completions', { provider: provider('chat-completions', 'http://localhost:8080/v1'), key: undefined });
    const output = [];
    await assert.rejects(streamCompletion(local, [], controller.signal, t => { output.push(t); controller.abort(); },
        fakeFetch([chat('first') + chat('late') + 'data: [DONE]\n\n']).http), /已停止/);
    assert.deepEqual(output, ['first']);
});

test('completion does not wait for a stuck stream cleanup', { timeout: 1500 }, async () => {
    let cancelled = false;
    const http = async () => new Response(new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode(chat('ok') + 'data: [DONE]\n\n')); },
        cancel() { cancelled = true; return new Promise(() => {}); },
    }));
    assert.equal(await streamCompletion(target(), [], new AbortController().signal, () => {}, http), 'ok');
    assert.equal(cancelled, true);
});

test('refusals, tool terminal reasons and incomplete statuses cannot become successful text', async () => {
    const cases = [
        ['chat-completions', { choices: [{ delta: { refusal: 'no' } }] }],
        ...['tool_calls', 'function_call', 'content_filter'].map(finish_reason => ['chat-completions', { choices: [{ delta: {}, finish_reason }] }]),
        ['chat-completions', { choices: [{ delta: { function_call: { name: 'run' } } }] }],
        ['responses', { type: 'response.refusal.delta', delta: 'no' }],
        ['responses', { type: 'response.output_item.added', item: { type: 'function_call' } }],
        ['responses', { type: 'response.completed', response: { status: 'incomplete' } }],
        ['responses', { type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'refusal' }] }] } }],
        ...['tool_use', 'pause_turn', 'refusal'].map(stop_reason => ['anthropic-messages', { type: 'message_delta', delta: { stop_reason } }]),
        ['anthropic-messages', { type: 'content_block_start', content_block: { type: 'server_tool_use' } }],
    ];
    for (const [format, payload] of cases) {
        assert.deepEqual(readEvent(format, { data: JSON.stringify(payload) }), { error: true });
        await assert.rejects(streamCompletion(target(format), [], new AbortController().signal, () => {},
            fakeFetch([`data: ${JSON.stringify(payload)}\n\n`]).http), /不支持/);
    }
    assert.deepEqual(readEvent('anthropic-messages', { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } }) }), { truncated: true });
    assert.deepEqual(readEvent('anthropic-messages', { data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) }), {});
});

test('model list caps streamed bytes and cancels without draining the rest', { timeout: 1500 }, async () => {
    let pulls = 0, cancelled = 0;
    const http = async () => new Response(new ReadableStream({
        pull(c) { pulls++; c.enqueue(new Uint8Array(1024 * 1024)); },
        cancel() { cancelled++; return new Promise(() => {}); },
    }, { highWaterMark: 0 }));
    await assert.rejects(listRemoteModels(provider(), KEY, http), /列表过大/);
    assert.equal(pulls, 3);
    assert.equal(cancelled, 1);
});

test('model list rejects invalid UTF-8 and sanitizes stream errors', async () => {
    await assert.rejects(listRemoteModels(provider(), KEY, fakeFetch([new Uint8Array([0xc3])]).http), /编码无效/);
    await assert.rejects(listRemoteModels(provider(), KEY, async () => new Response(new ReadableStream({
        start(c) { c.error(new Error(`network ${KEY}`)); },
    }))), error => { assert.equal(error.message, '模型列表响应中断'); return true; });
});

test('keyless local Anthropic requests retain the version header', async () => {
    const p = provider('anthropic-messages', 'http://localhost:8080/v1');
    const stream = fakeFetch(['data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\ndata: {"type":"message_stop"}\n\n']);
    await streamCompletion(target('anthropic-messages', { provider: p, key: undefined }), [], new AbortController().signal, () => {}, stream.http);
    const models = fakeFetch(['{"data":[]}']);
    await listRemoteModels(p, undefined, models.http);
    for (const call of [...stream.calls, ...models.calls]) {
        assert.equal(call.init.headers['anthropic-version'], '2023-06-01');
        assert.equal(call.init.headers['x-api-key'], undefined);
    }
});

test('real localhost HTTP cancellation closes the response and a later request still completes', { timeout: 5000 }, async () => {
    const { createServer } = require('node:http');
    const { once } = require('node:events');
    let count = 0;
    let closed;
    const connectionClosed = new Promise(resolve => { closed = resolve; });
    const server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (++count === 1) {
            res.once('close', closed);
            res.write(chat('first'));
        } else { res.end(chat('second') + 'data: [DONE]\n\n'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const p = provider('chat-completions', `http://127.0.0.1:${server.address().port}/v1`);
        const t = target('chat-completions', { provider: p, key: undefined });
        const controller = new AbortController();
        const output = [];
        await assert.rejects(streamCompletion(t, [], controller.signal, text => { output.push(text); controller.abort(); }), /已停止/);
        await connectionClosed;
        assert.deepEqual(output, ['first']);
        assert.equal(await streamCompletion(t, [], new AbortController().signal, () => {}), 'second');
        assert.equal(count, 2);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('real localhost HTTP disconnect never returns a partial answer as completed', { timeout: 5000 }, async () => {
    const { createServer } = require('node:http');
    const { once } = require('node:events');
    const server = createServer((req, res) => {
        req.resume();
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(chat('partial'));
        setImmediate(() => res.destroy());
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
        const p = provider('chat-completions', `http://127.0.0.1:${server.address().port}/v1`);
        await assert.rejects(streamCompletion(target('chat-completions', { provider: p, key: undefined }), [], new AbortController().signal, () => {}), /中断|网络不可用/);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('request deadline covers stalled completion and model-list bodies', { timeout: 1500 }, async context => {
    const deadlines = [];
    context.mock.method(AbortSignal, 'timeout', ms => {
        const controller = new AbortController();
        deadlines.push(ms);
        setTimeout(() => controller.abort(), 20);
        return controller.signal;
    });
    const http = async () => new Response(new ReadableStream({ cancel() { return new Promise(() => {}); } }));
    await assert.rejects(streamCompletion(target(), [], new AbortController().signal, () => {}, http), /模型服务超时/);
    await assert.rejects(listRemoteModels(provider(), KEY, http), /模型服务超时/);
    assert.deepEqual(deadlines, [60000, 15000]);
});


test('model-list credential echoes are never offered as model IDs', async () => {
    const http = async () => new Response(JSON.stringify({ data: [{ id: KEY }, { id: `prefix-${KEY}` }, { id: 'safe-model' }] }));
    assert.deepEqual(await listRemoteModels(provider(), KEY, http), [{ id: 'safe-model' }]);
});
