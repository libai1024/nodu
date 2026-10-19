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
