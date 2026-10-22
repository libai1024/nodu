// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NoduEmbeddedServer } = require('../lib/node/nodu-embedded-server');
const client = () => ({ onEvent() {}, onClangd() {} });

test('closing a frontend connection releases only its monitor session', async () => {
    const server = new NoduEmbeddedServer();
    const a = client(), b = client();
    const removeA = server.addClient(a), removeB = server.addClient(b);
    const calls = [];
    server.call = async (method, args) => {
        calls.push({ method, args });
        return { ok: true, result: method === 'openMonitor' ? { open: true, owner: args.owner, session: `session-${args.owner}` } : { open: false } };
    };
    await server.callForClient(a, 'openMonitor', { owner: 'a' });
    await server.callForClient(b, 'openMonitor', { owner: 'b' });
    removeA();
    const closeA = calls.filter(call => call.method === 'closeMonitor');
    assert.deepEqual(closeA, [{ method: 'closeMonitor', args: { owner: 'a', session: 'session-a' } }]);
    removeB();
    assert.equal(calls.at(-1).args.owner, 'b');
});

test('connection removed during open releases the resulting late session', async () => {
    const server = new NoduEmbeddedServer(), a = client();
    const remove = server.addClient(a);
    let opened;
    const pending = new Promise(resolve => { opened = resolve; });
    const closes = [];
    server.call = async (method, args) => {
        if (method === 'openMonitor') { return pending; }
        closes.push(args); return { ok: true, result: { open: false } };
    };
    const opening = server.callForClient(a, 'openMonitor', { owner: 'a' });
    remove();
    opened({ ok: true, result: { open: true, owner: 'a', session: 'late-session' } });
    await opening;
    assert.deepEqual(closes, [{ owner: 'a', session: 'late-session' }]);
});
