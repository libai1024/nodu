// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Real Node streams/readline exercise the production stdio parser; no tools or devices start.
function harness(t) {
    const children = [], events = [], deadlines = [], exports = {};
    const lib = path.join(__dirname, '../lib/node');
    const sandbox = { exports, process, setTimeout(callback, ms) { deadlines.push(ms); return setTimeout(callback, ms); }, clearTimeout, __filename: path.join(lib, 'nodu-embedded-server.js'),
        require(name) {
            if (name.includes('inversify')) return { injectable: () => target => target };
            if (name === 'child_process') return { spawn() {
                const child = new EventEmitter(); child.requests = [];
                child.stdout = new PassThrough(); child.stderr = new PassThrough();
                child.stdin = new Writable({ write(chunk, encoding, callback) { child.requests.push(JSON.parse(chunk.toString())); callback(); } });
                child.send = value => child.stdout.write(JSON.stringify(value) + '\n');
                children.push(child); return child;
            } };
            if (['./nodu-build-location', './nodu-monitor-encoding', './nodu-project-generator', './nodu-daxin-project'].includes(name)) return {};
            return name.startsWith('.') ? require(path.resolve(lib, name)) : require(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(sandbox.__filename, 'utf8'), sandbox);
    const server = new exports.NoduEmbeddedServer();
    server.binary = () => '/unused/sidecar'; server.extensionDir = () => '/unused';
    server.toolkitRoot = () => '/unused/toolkit'; server.dataDir = () => '/unused/data';
    server.addClient({ onEvent(event, data) { events.push({ event, data }); } });
    t.after(() => {
        if (server.sidecar) server.failSidecar(server.sidecar, 'test cleanup');
        for (const child of children) { child.stdout.end(); child.stderr.end(); child.stdin.end(); }
    });
    return { server, children, events, deadlines, states: () => events.filter(e => e.event === 'service.state').map(e => e.data.running) };
}

test('cold toolkit startup has time to initialize; warm requests retain normal deadlines', async t => {
    const h = harness(t);
    const first = h.server.call('listPorts', {}), child = h.children[0];
    assert.equal(h.deadlines.at(-1), 180000);
    child.send({ id: child.requests.at(-1).id, result: [] }); await first;
    const warm = h.server.call('listPorts', {});
    assert.equal(h.deadlines.at(-1), 30000);
    child.send({ id: child.requests.at(-1).id, result: [] }); await warm;
    child.emit('exit', 1);
    const replacement = h.server.call('listPorts', {}), next = h.children[1];
    assert.equal(h.deadlines.at(-1), 180000);
    next.send({ id: next.requests[0].id, result: [] }); await replacement;
});

test('only the first valid correlated response marks the current process ready', async t => {
    const h = harness(t), result = h.server.call('ping', {}), child = h.children[0];
    const id = child.requests[0].id;
    child.stderr.write('starting'); child.send({ event: 'service.state', data: { running: true } });
    child.send({ event: 'build.progress', data: { percent: 0 } });
    child.stdout.write('not-json\nnull\n[]\n');
    child.send({ id }); child.send({ id, error: {} }); child.send({ id, result: {}, error: 'ambiguous' });
    child.send({ id: id + 50, result: {} });
    assert.deepEqual(h.states(), []); assert.equal(h.server.pending.size, 1);
    child.send({ id, result: { version: 'test' } });
    assert.equal((await result).ok, true); assert.deepEqual(h.states(), [true]);
    child.send({ id, result: {} });
    const again = h.server.call('ping', {}); child.send({ id: child.requests[1].id, result: null });
    assert.equal((await again).ok, true); assert.deepEqual(h.states(), [true]);
});

test('a business refusal proves readiness without changing the failure outcome', async t => {
    const h = harness(t), result = h.server.call('ping', {}), child = h.children[0];
    child.send({ id: child.requests[0].id, error: 'Project requires trust', code: 'untrusted', detail: { phase: 'configure' } });
    const outcome = await result;
    assert.equal(outcome.ok, false); assert.equal(outcome.error.code, 'untrusted');
    assert.equal(outcome.error.detail.phase, 'configure'); assert.deepEqual(h.states(), [true]);
});

test('failed process messages cannot resolve replacement requests or revive service state', async t => {
    const h = harness(t), first = h.server.call('ping', {}), old = h.children[0];
    old.send({ id: old.requests[0].id, result: {} }); await first;
    const interrupted = h.server.call('ping', {});
    old.emit('error', new Error('broken transport'));
    assert.equal((await interrupted).ok, false); assert.deepEqual(h.states(), [true, false]);
    const replacement = h.server.call('ping', {}), next = h.children[1], id = next.requests[0].id;
    const count = h.events.length;
    old.send({ id, result: { stale: true } });
    old.send({ event: 'service.state', data: { running: true } });
    old.send({ event: 'flash.started', data: { runId: 'old', path: '/project' } });
    old.stderr.write('old log'); old.emit('exit', 1);
    assert.equal(h.events.length, count); assert.equal(h.server.pending.size, 1); assert.equal(h.server.sidecar, next);
    next.send({ id, result: { current: true } });
    assert.equal((await replacement).result.current, true); assert.deepEqual(h.states(), [true, false, true]);
});

test('first response readiness preserves active flash evidence; service loss clears it', async t => {
    const h = harness(t), bundle = 'a'.repeat(64), root = '/project';
    const result = h.server.call('flash', { path: root, bundle }), child = h.children[0];
    child.send({ event: 'flash.started', data: { path: root, runId: 'first-run' } });
    child.send({ id: child.requests[0].id, result: { ok: true, runId: 'first-run', method: 'stlink', identity: { uid: 'test-uid' }, running: true } });
    assert.equal((await result).ok, true); assert.deepEqual(h.states(), [true]);
    assert.equal(h.server.teachingEvidence.snapshot(root, bundle).download.uid, 'test-uid');
    child.emit('exit', 1);
    assert.equal(h.server.teachingEvidence.snapshot(root, bundle), undefined); assert.deepEqual(h.states(), [true, false]);
});
