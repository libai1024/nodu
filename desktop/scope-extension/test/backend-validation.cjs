// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NoduDeviceServer } = require('../lib/node/nodu-device-server');

test('device filesystem rejects traversal and protects board startup files before opening serial', () => {
    const server = new NoduDeviceServer();
    for (const path of ['/etc/passwd', '/flash/../boot.py', '/flash/a\0b', '/sd/../flash/main.py']) {
        assert.throws(() => server.readFile(path), /路径/);
    }
    for (const path of ['/flash/boot.py', '/flash/main.py', '/sd/main.py']) {
        assert.throws(() => server.writeFile(path, 'eA==', true), /保护/);
    }
    server.onStop();
});

test('malformed and oversized payloads never reach the worker', () => {
    const server = new NoduDeviceServer();
    assert.throws(() => server.writeFile('/flash/nodu-test.txt', '%%%not-base64', false), /有效数据/);
    assert.throws(() => server.writeFile('/flash/nodu-test.txt', Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'), false), /2 MiB/);
    assert.throws(() => server.runScript('  '), /非空/);
    assert.throws(() => server.execute('x'.repeat(256 * 1024 + 1)), /256 KiB/);
    server.onStop();
});

test('invalid connections fail before port probing', async () => {
    const server = new NoduDeviceServer();
    await assert.rejects(server.connect({ port: '', boardProfile: 'generic-k210' }), /串口/);
    await assert.rejects(server.connect({ port: '/dev/fake', boardProfile: 'not-a-board' }), /板型/);
    await assert.rejects(server.connect({ port: '/dev/fake', boardProfile: 'generic-k210', baud: 1 }), /115200/);
    assert.equal((await server.getState()).phase, 'disconnected');
    server.onStop();
});

test('disconnect cancels a connection still waiting on port discovery', async () => {
    const server = new NoduDeviceServer();
    let finishProbe;
    server.listPorts = () => new Promise(resolve => { finishProbe = resolve; });
    let actualConnects = 0;
    server.request = async method => { if (method === 'connect') actualConnects++; };
    const attempt = server.connect({ port: '/dev/fake', boardProfile: 'generic-k210' });
    await server.disconnect();
    finishProbe([{ path: '/dev/fake', description: 'test' }]);
    await assert.rejects(attempt, /取消/);
    assert.equal(actualConnects, 0);
    await server.onStop();
});

test('another client cannot queue a short-timeout request behind an active firmware write', async () => {
    const server = new NoduDeviceServer();
    server.flashTask = new Promise(() => {});
    await assert.rejects(server.listPorts(), /固件/);
    await assert.rejects(server.stop(), /固件/);
    await assert.rejects(server.disconnect(), /固件/);
    assert.equal((await server.getState()).phase, 'disconnected');
    server.flashTask = undefined;
    await server.onStop();
});

test('losing the last UI client defers cleanup until the firmware critical section ends', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = new NoduDeviceServer();
    let disconnected = 0;
    server.disconnect = async () => { disconnected++; };
    const remove = server.addClient({ onState() {}, onLog() {}, onFrame() {} });
    server.flashTask = new Promise(() => {});
    remove();
    t.mock.timers.tick(5000);
    assert.equal(disconnected, 0);
    server.flashTask = undefined;
    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.equal(disconnected, 1);
    await server.onStop();
});

// End-to-end against the Rust sidecar's --mock transport (no hardware).
// Requires `npm run build:native` to have produced the dev release binary.
test('rust sidecar mock board: connect, REPL execute, file round-trip, disconnect', async t => {
    const { existsSync } = require('node:fs');
    const { join } = require('node:path');
    const binary = join(__dirname, '..', '..', 'native', 'target', 'release',
        process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
    if (!existsSync(binary)) { t.skip('nodu-device release binary missing; run npm run build:native'); return; }
    const savedBin = process.env.NODU_DEVICE_BIN;
    const savedMock = process.env.NODU_DEVICE_MOCK;
    process.env.NODU_DEVICE_BIN = binary;
    process.env.NODU_DEVICE_MOCK = '1';
    const server = new NoduDeviceServer();
    try {
        const ports = await server.listPorts();
        assert.ok(ports.some(port => port.path === 'mock'), 'mock port listed');
        const state = await server.connect({ port: 'mock', boardProfile: 'generic-k210' });
        assert.equal(state.phase, 'connected');
        assert.equal(state.capabilities.repl, true);
        assert.equal(state.capabilities.firmware, false);
        assert.equal(await server.execute('print(42)'), '42\n');
        const payload = Buffer.alloc(4096, 0x5a);
        await server.writeFile('/flash/nodu_e2e.bin', payload.toString('base64'), false);
        const back = await server.readFile('/flash/nodu_e2e.bin');
        assert.equal(Buffer.from(back.data, 'base64').equals(payload), true);
        const files = await server.listFiles('/flash');
        assert.ok(files.some(file => file.name === 'nodu_e2e.bin'));
        await server.disconnect();
        assert.equal((await server.getState()).phase, 'disconnected');
    } finally {
        await server.onStop();
        if (savedBin === undefined) { delete process.env.NODU_DEVICE_BIN; } else { process.env.NODU_DEVICE_BIN = savedBin; }
        if (savedMock === undefined) { delete process.env.NODU_DEVICE_MOCK; } else { process.env.NODU_DEVICE_MOCK = savedMock; }
    }
});

// deviceBinary() resolution: dev fallback when the packaged sidecar is absent.
// Renames the staged binary inside try/finally; no port or spawn involved.
test('deviceBinary falls back to the dev release build', async t => {
    const { existsSync, renameSync } = require('node:fs');
    const { join } = require('node:path');
    const server = new NoduDeviceServer();
    const savedBin = process.env.NODU_DEVICE_BIN;
    delete process.env.NODU_DEVICE_BIN;
    try {
        const staged = join(__dirname, '..', 'resources', 'bin',
            `${process.platform}-${process.arch}`,
            process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
        const dev = join(__dirname, '..', '..', 'native', 'target', 'release',
            process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
        if (!existsSync(dev)) { t.skip('dev release binary missing; run npm run build:native'); return; }
        const aside = `${staged}.aside`;
        const hadStaged = existsSync(staged);
        try {
            if (hadStaged) { renameSync(staged, aside); }
            assert.equal(server.deviceBinary(), dev, 'must fall back to desktop/native dev build');
        } finally {
            if (hadStaged && existsSync(aside)) { renameSync(aside, staged); }
        }
        if (hadStaged) { assert.equal(server.deviceBinary(), staged); }
    } finally {
        if (savedBin === undefined) { delete process.env.NODU_DEVICE_BIN; } else { process.env.NODU_DEVICE_BIN = savedBin; }
    }
});
