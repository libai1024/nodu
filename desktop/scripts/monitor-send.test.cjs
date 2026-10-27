// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { encodeMonitorText } = require('../scope-extension/lib/node/nodu-monitor-encoding');
const { monitorLog, logLine } = require('../scope-extension/lib/common/nodu-monitor-log');
function load(relative) {
    const file = require.resolve(`../scope-extension/lib/${relative}`), exports = {};
    class Empty {}
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    const fallback = new Proxy({}, { get: () => Empty });
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        exports, TextDecoder, TextEncoder, atob, Date, process, __filename: file,
        setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
        localStorage: { setItem() {}, getItem() { return null; } },
        require: id => id.includes('inversify') ? { inject: () => () => {}, postConstruct: () => () => {}, injectable: () => value => value }
            : id === '@theia/core/lib/common/event' ? { Emitter }
            : id.startsWith('../common/') || id === './nodu-monitor-encoding' ? require(path.resolve(path.dirname(file), id))
            : id === './tutor/tutor-runtime-evidence' ? { TutorRuntimeEvidence: class { result() {} } }
            : id.startsWith('.') || id.startsWith('@') ? fallback : require(id),
    });
    return exports;
}
const { NoduEmbeddedModel } = load('browser/nodu-embedded-model');
const { NoduEmbeddedServer } = load('node/nodu-embedded-server');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function model(encoding = 'utf-8') {
    const m = new NoduEmbeddedModel();
    m.project = { path: '/project', manifest: { monitor: { encoding } }, flashMethod: 'stlink' };
    m.monitor = { open: true, port: '/dev/uart', baud: 115200, state: 'open' }; m.monitorPort = '/dev/uart';
    m.systemDiagnostics = { report() {}, resolve() {} };
    m.calls = [];
    m.call = async (method, args) => {
        m.calls.push([method, args]);
        const data = encodeMonitorText(args.text, args.encoding);
        return { sent: Buffer.from(data, 'base64').length, data };
    };
    return m;
}
const snapshot = m => ({ lines: m.monitorLines, partial: m.monitorPartial, partialAt: m.monitorPartialAt, hex: m.monitorHex });

test('a serial sidecar crash cannot clear an independent Arduino CLI build', () => {
    const m = model(); m.isArduino = true; m.building = true; m.task = { text: '正在编译', tone: 'busy' };
    m.onEvent('service.state', { running: false });
    assert.equal(m.building, true); assert.equal(m.task.text, '正在编译');
});

test('successful sends add a TX record with exact encoded bytes while raw RX remains unchanged', async () => {
    for (const encoding of ['utf-8', 'gbk']) {
        const m = model(encoding), text = '中文\r\n';
        m.decode(Buffer.from('ready\n').toString('base64')); const raw = m.monitorBytes.hex();
        assert.equal(await m.sendMonitor(text), true);
        assert.equal(m.monitorLines.at(-1).kind, 'sent'); assert.equal(m.monitorLines.at(-1).text, text);
        assert.equal(monitorLog(snapshot(m), false, false), 'ready\nTX 中文\\r\\n');
        const bytes = Buffer.from(encodeMonitorText(text, encoding), 'base64');
        assert.match(m.monitorHex, new RegExp(`TX ${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join(' ')}$`));
        assert.equal(m.monitorBytes.hex(), raw, 'TX must not contaminate receive-only wire bytes');
        assert.equal(monitorLog(snapshot(m), true, true), m.monitorHex);
    }
    const at = new Date(2026, 9, 26, 12, 1, 2, 3).getTime();
    assert.equal(logLine({ kind: 'sent', text: 'ping\n', at }, true), '[12:01:02.003] TX ping\\n');
});

test('a TX record between receive chunks does not finish an incomplete UTF-8 or GBK character', async () => {
    for (const encoding of ['utf-8', 'gbk']) {
        const m = model(encoding), bytes = Buffer.from(encodeMonitorText('中文\n', encoding), 'base64');
        m.decode(Buffer.concat([Buffer.from('prefix '), bytes.subarray(0, 1)]).toString('base64'));
        assert.equal(await m.sendMonitor('ping\n'), true);
        m.decode(bytes.subarray(1).toString('base64'));
        assert.equal(monitorLog(snapshot(m), false, false), 'prefix \nTX ping\\n\n中文');
        assert.equal(monitorLog(snapshot(m), false, false).includes('\ufffd'), false);
    }
});

test('write failures preserve logs and report the error without a TX success entry', async () => {
    const m = model(); m.decode(Buffer.from('before\n').toString('base64'));
    const before = monitorLog(snapshot(m), false, false), hex = m.monitorHex;
    m.call = async () => { throw Error('disconnected while writing'); };
    assert.equal(await m.sendMonitor('ping\r\n'), false); assert.match(m.monitorError, /disconnected/);
    assert.equal(monitorLog(snapshot(m), false, false), before); assert.equal(m.monitorHex, hex);
});

test('closed, disconnected, lent, busy, flashing and boot-wait states refuse sending before RPC', async () => {
    for (const alter of [
        m => { m.monitor.open = false; }, m => { m.monitor.state = 'closed'; }, m => { m.monitor.state = 'disconnected'; },
        m => { m.monitor.state = 'lent'; }, m => { m.monitorBusy = true; }, m => { m.flashing = true; },
        m => { m.awaitUser = 'enterBoot'; }, m => { m.awaitUser = 'exitBoot'; }
    ]) {
        const m = model(); alter(m); assert.equal(await m.sendMonitor('ping'), false); assert.equal(m.calls.length, 0);
        assert.equal(m.monitorLines.length, 0);
    }
    const building = model(); building.building = true;
    assert.equal(await building.sendMonitor('status'), true, 'compilation alone does not lock a monitor');
});

test('only one send is in flight and older backends can still return their sent count', async () => {
    const m = model(), held = deferred(); let calls = 0;
    m.call = () => { calls++; return held.promise; };
    const first = m.sendMonitor('one'); assert.equal(await m.sendMonitor('two'), false); assert.equal(calls, 1);
    held.resolve({ sent: 3 }); assert.equal(await first, true); assert.equal(m.monitorLines.length, 1);
    assert.equal(logLine(m.monitorLines[0], false), 'TX one');
    m.call = async () => ({ sent: 3 }); assert.equal(await m.sendMonitor('two'), true);
});

test('late send success or error cannot refill cleared logs or pollute changed sessions', async () => {
    for (const change of [
        m => m.clearMonitor(),
        m => { m.detection++; m.project = { ...m.project, path: '/another' }; },
        m => { m.monitorPort = '/dev/other'; },
        m => { m.monitor = { ...m.monitor, port: '/dev/other' }; },
        m => { m.onEvent('monitor.state', { state: 'disconnected', port: '/dev/uart', baud: 115200 }); m.onEvent('monitor.state', { state: 'open', port: '/dev/uart', baud: 115200 }); },
        m => { m.onEvent('monitor.state', { state: 'closed', port: '/dev/uart' }); m.onEvent('monitor.state', { state: 'open', port: '/dev/uart', baud: 115200 }); },
        m => m.onEvent('service.state', { running: false }),
    ]) for (const failure of [false, true]) {
        const m = model(), held = deferred(); m.call = () => held.promise;
        const pending = m.sendMonitor('old'); change(m); m.monitorError = 'new session error';
        if (failure) held.reject(Error('late old error')); else held.resolve({ sent: 3, data: Buffer.from('old').toString('base64') });
        assert.equal(await pending, false); assert.equal(m.monitorLines.filter(line => line.kind === 'sent').length, 0);
        assert.equal(m.monitorHex.includes('TX'), false); assert.equal(m.monitorError, 'new session error');
    }
});

test('Node returns actual UTF-8 or GBK wire bytes only after a successful write', async () => {
    const server = new NoduEmbeddedServer(); const requests = [];
    server.request = async (method, args) => { requests.push([method, args]); return { sent: Buffer.from(args.data, 'base64').length }; };
    for (const encoding of ['utf-8', 'gbk']) {
        const result = await server.call('writeMonitor', { text: '中文\r\n', encoding });
        assert.equal(result.ok, true); assert.equal(result.result.data, encodeMonitorText('中文\r\n', encoding));
        assert.equal(result.result.sent, Buffer.from(result.result.data, 'base64').length);
        assert.equal(requests.at(-1)[1].text, undefined);
    }
    const data = Buffer.from([0, 255, 128]).toString('base64');
    assert.equal((await server.call('writeMonitor', { data })).result.data, data, 'existing raw-byte API remains usable');
    server.request = async () => { throw Error('write failed'); };
    const failure = await server.call('writeMonitor', { text: 'ping', encoding: 'utf-8' });
    assert.equal(failure.ok, false); assert.equal(failure.result, undefined);
});
