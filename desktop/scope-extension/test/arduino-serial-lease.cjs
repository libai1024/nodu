// SPDX-License-Identifier: MIT
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const uploadModule = require('../lib/node/nodu-arduino-upload');
const { NoduArduinoServer } = require('../lib/node/nodu-arduino-server');
const { NoduEmbeddedServer } = require('../lib/node/nodu-embedded-server');
const { arduinoInputDigest } = require('../lib/node/nodu-arduino-project');
const port = { path: '/dev/cu.nodu-audit-original', vid: 0x303a, pid: 0x1001, serial_number: 'AUDIT-UNIQUE-01' };
const nextPort = { ...port, path: '/dev/cu.nodu-audit-reenumerated', pid: 0x1002 };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const reach = (event, operation) => Promise.race([event, operation.then(result => { throw new Error(`Upload ended before the audited phase: ${JSON.stringify(result)}`); })]);

function embeddedFixture(options = {}) {
    const embedded = new NoduEmbeddedServer(), calls = []; let inventories = 0;
    embedded.request = async (method, args) => {
        calls.push({ method, args: { ...args } });
        if (method === 'listPorts') { return ++inventories === 1 ? [options.port ?? port] : await (options.inventory?.() ?? [nextPort]); }
        if (method === 'acquireExternalPort') { return { wasOpen: true, baud: 115200 }; }
        if (method === 'releaseExternalPort') {
            await options.release?.(args);
            return { released: true, restored: !!args.restore };
        }
        if (method === 'closeMonitor') { return { open: false, state: 'closed' }; }
        throw new Error(`Unexpected native request: ${method}`);
    };
    return { embedded, calls };
}

async function arduinoFixture(t, embedded) {
    const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-lease-audit-')));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const project = path.join(dir, 'hello'), artifacts = path.join(dir, 'build');
    await fs.mkdir(project); await fs.mkdir(artifacts);
    await fs.writeFile(path.join(project, 'nodu.json'), JSON.stringify({ kind: 'esp32-arduino', target: { mcu: 'esp32c3' } }));
    await fs.writeFile(path.join(project, 'hello.ino'), 'void setup() {}\nvoid loop() {}\n');
    await fs.writeFile(path.join(project, 'sketch.yaml'), 'default_profile: nodu\nprofiles:\n  nodu:\n    fqbn: esp32:esp32:esp32c3\n    platforms:\n      - platform: esp32:esp32 (3.3.12)\n        platform_index_url: https://espressif.github.io/arduino-esp32/package_esp32_index.json\n');
    const header = Buffer.alloc(48); header[0] = 0xe9; header[1] = 1; header[23] = 1;
    header.writeUInt16LE(5, 12); header.writeUInt32LE(4, 28); header.set([1, 2, 3, 4], 32); header[47] = 0xef ^ 1 ^ 2 ^ 3 ^ 4;
    const image = Buffer.concat([header, createHash('sha256').update(header).digest()]);
    await fs.writeFile(path.join(artifacts, 'hello.ino.bin'), image); await fs.writeFile(path.join(artifacts, 'hello.ino.bootloader.bin'), image);
    await fs.writeFile(path.join(artifacts, 'build.options.json'), JSON.stringify({ fqbn: 'esp32:esp32:esp32c3', sketchLocation: project }));
    await fs.writeFile(path.join(artifacts, 'flash_args'), '--flash-mode dio --flash-freq 80m --flash-size 4MB\n0x0 hello.ino.bootloader.bin\n0x10000 hello.ino.bin\n');
    const server = new NoduArduinoServer();
    server.directory = () => path.join(dir, 'home'); server.embedded = embedded;
    server.checkCli = async () => undefined;
    server.builds.set('audit-build', { path: project, directory: artifacts, digest: await arduinoInputDigest(project),
        artifacts: await server.artifactDigest(artifacts), fqbn: 'esp32:esp32:esp32c3' });
    const original = uploadModule.executeArduinoUpload;
    uploadModule.executeArduinoUpload = async options => { options.onStage?.('upload'); return { ok: true, stage: 'complete' }; };
    t.after(() => { uploadModule.executeArduinoUpload = original; server.onStop(); });
    return { server, request: { path: project, operationId: 'audit-upload', port: port.path, buildToken: 'audit-build' } };
}

test('only one lease exists and user close prevents restoration across the complete lease', async () => {
    const f = embeddedFixture(), lease = await f.embedded.acquireArduinoPort(port.path);
    await assert.rejects(f.embedded.acquireArduinoPort(port.path), /正在使用/);
    assert.equal((await f.embedded.call('openMonitor', { port: nextPort.path })).error.code, 'portBusy');
    assert.equal((await f.embedded.call('writeMonitor', { text: 'never sent' })).error.code, 'portBusy');
    assert.equal((await f.embedded.call('closeMonitor', {})).error.code, 'portBusy');
    assert.equal((await lease.release(true, () => true)).restored, false);
    assert.ok(!f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
    const count = f.calls.length; await lease.release(true, () => true); assert.equal(f.calls.length, count);
    assert.equal(f.embedded.arduinoLease, undefined);
});

test('a unique serial identity may change USB path/PID, but ambiguous identities are never restored', async () => {
    const f = embeddedFixture(), lease = await f.embedded.acquireArduinoPort(port.path);
    assert.deepEqual(await lease.release(true, () => true), { restored: true, port: nextPort.path });
    assert.ok(f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore && call.args.port === nextPort.path));
    const duplicate = embeddedFixture({ inventory: () => [nextPort, { ...nextPort, path: '/dev/cu.nodu-audit-duplicate' }] });
    assert.equal((await (await duplicate.embedded.acquireArduinoPort(port.path)).release(true, () => true)).restored, false);
    assert.ok(!duplicate.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
});

test('a Windows UART bridge without a serial number restores only its original path and VID/PID', async () => {
    const bridge = { path: 'COM4', vid: 0x1a86, pid: 0x55d3 };
    const same = embeddedFixture({ port: bridge, inventory: () => [bridge] });
    assert.equal((await (await same.embedded.acquireArduinoPort('COM4')).release(true)).restored, true);
    for (const candidate of [{ ...bridge, path: 'COM5' }, { ...bridge, pid: 0x7523 }, { path: 'COM4' }]) {
        let f;
        f = embeddedFixture({ port: bridge, inventory: () => { f.embedded.arduinoLease.restore = false; return [candidate]; } });
        assert.equal((await (await f.embedded.acquireArduinoPort('COM4')).release(true)).restored, false);
        assert.ok(!f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
    }
});

test('cancellation while rediscovering a port prevents the restore RPC and marks upload cancelled', async t => {
    const entered = deferred(), inventory = deferred();
    const f = embeddedFixture({ inventory: () => { entered.resolve(); return inventory.promise; } });
    const { server, request } = await arduinoFixture(t, f.embedded);
    const pending = server.upload(request); await reach(entered.promise, pending);
    await server.cancel(request.operationId); inventory.resolve([nextPort]);
    const result = await pending;
    assert.equal(result.cancelled, true); assert.equal(result.ok, false); assert.equal(result.monitorRestored, false);
    assert.ok(!f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
    assert.equal(f.embedded.arduinoLease, undefined);
});

test('cancellation after restore RPC starts closes only the monitor restored by that lease', async t => {
    const entered = deferred(), completion = deferred();
    const f = embeddedFixture({ release: async args => { if (args.restore) { entered.resolve(); await completion.promise; } } });
    const { server, request } = await arduinoFixture(t, f.embedded);
    const pending = server.upload(request); await reach(entered.promise, pending);
    await server.cancel(request.operationId); completion.resolve();
    const result = await pending;
    assert.equal(result.cancelled, true); assert.equal(result.ok, false); assert.equal(result.monitorRestored, false);
    const restoreAt = f.calls.findIndex(call => call.method === 'releaseExternalPort' && call.args.restore);
    const closeAt = f.calls.findIndex(call => call.method === 'closeMonitor');
    assert.ok(restoreAt >= 0 && closeAt > restoreAt, 'cancellation left the restored monitor running');
    assert.equal(f.embedded.arduinoLease, undefined);
});

test('a failed acquisition clears the Node reservation so the next valid request can proceed', async () => {
    const f = embeddedFixture(), original = f.embedded.request;
    let first = true;
    f.embedded.request = async (method, args) => {
        if (method === 'acquireExternalPort' && first) { first = false; throw new Error('native lock busy'); }
        if (method === 'listPorts') { return [port]; }
        return original(method, args);
    };
    await assert.rejects(f.embedded.acquireArduinoPort(port.path), /native lock busy/);
    assert.equal(f.embedded.arduinoLease, undefined);
    const lease = await f.embedded.acquireArduinoPort(port.path); await lease.release(false, () => true);
    assert.equal(f.embedded.arduinoLease, undefined);
});

test('losing the native sidecar cancels an in-flight upload and never restores its monitor', async t => {
    const entered = deferred(), completion = deferred();
    const f = embeddedFixture(), { server, request } = await arduinoFixture(t, f.embedded);
    uploadModule.executeArduinoUpload = async options => {
        entered.resolve(); await completion.promise;
        return { ok: !options.isCancelled(), cancelled: options.isCancelled(), stage: 'upload' };
    };
    const child = {}; f.embedded.sidecar = child;
    const pending = server.upload(request); await reach(entered.promise, pending);
    f.embedded.failSidecar(child, 'audit sidecar exited');
    assert.equal(server.active.cancelled, true, 'lease loss did not reach the upload cancellation path');
    completion.resolve();
    const result = await pending;
    assert.equal(result.ok, false); assert.equal(result.cancelled, true); assert.equal(result.monitorRestored, false);
    assert.ok(!f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
    assert.equal(f.embedded.arduinoLease, undefined);
});

test('loss occurring before the onLost handler is registered is delivered immediately', async () => {
    const f = embeddedFixture(), lease = await f.embedded.acquireArduinoPort(port.path);
    const child = {}; f.embedded.sidecar = child;
    f.embedded.failSidecar(child, 'audit sidecar exited');
    let notified = 0; lease.onLost(() => { notified++; });
    assert.equal(notified, 1);
    assert.equal((await lease.release(true, () => true)).restored, false);
    assert.ok(!f.calls.some(call => call.method === 'releaseExternalPort' && call.args.restore));
});
