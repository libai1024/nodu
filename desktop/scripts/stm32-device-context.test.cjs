// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = require.resolve('../scope-extension/lib/browser/nodu-embedded-model');
const exports_ = {};
class Empty {}
class Emitter { event = () => ({ dispose() {} }); fire() {} }
const fallback = new Proxy({}, { get: () => Empty });
vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    exports: exports_, TextDecoder, TextEncoder, atob, Date,
    setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(),
    localStorage: { setItem() {}, getItem() { return null; } },
    require: id => id.startsWith('../common/') ? require(path.resolve(path.dirname(file), id))
        : id === '@theia/core/shared/inversify' ? { inject: () => () => {}, postConstruct: () => () => {}, injectable: () => value => value }
        : id === '@theia/core/lib/common/event' ? { Emitter } : fallback,
});
const { NoduEmbeddedModel } = exports_;
const project = () => ({ path: '/f103', name: 'f103', flashMethod: 'stlink', manifest: { target: { mcu: 'STM32F103C8T6' } } });
const f103 = { method: 'stlink', deviceId: 0x410, uid: 'f103-uid', probeId: 'usb:3-1', matches: null };
const f407 = { method: 'stlink', deviceId: 0x413, uid: 'f407-uid', probeId: 'usb:3-2', matches: null };
const a = { id: 'first', deviceId: 0x410, uid: 'f103-uid', deviceName: 'STM32F103' };
const b = { id: 'second', deviceId: 0x413, uid: 'f407-uid', deviceName: 'STM32F407' };
const probes = [{ id: 'usb:3-1', serial: 'one' }, { id: 'usb:3-2', serial: 'two' }];
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const flush = () => new Promise(setImmediate);
function model() {
    const m = new NoduEmbeddedModel(); m.project = project(); m.editors = { all: [] }; m.calls = [];
    m.ensureMonitor = async () => {};
    m.call = async (method, args) => {
        m.calls.push([method, args]);
        if (method === 'listBackups') return [a, b];
        if (method === 'listPorts') return [];
        if (method === 'listProbes') return probes;
        throw Error(`Unexpected RPC ${method}`);
    };
    return m;
}

test('unidentified device keeps history restoration available; known UID exposes only that exact device', async () => {
    const m = model(); await m.loadBackups();
    assert.equal(m.backupScope, 'history'); assert.deepEqual(m.backups, [a, b]);
    assert.equal(Object.keys(m.calls[0][1]).length, 0);
    m.rememberIdentity(f103); await m.loadBackups();
    assert.equal(m.backupScope, 'device'); assert.deepEqual(m.backups, [a]);
    assert.equal(m.calls.at(-1)[1].uid, 'f103-uid');
    m.call = async () => [{ ...b, uid: f103.uid }]; await m.loadBackups();
    assert.equal(m.backups.length, 0, 'same UID with a different device ID is not current-device evidence');
});

test('late backup success or error cannot replace another project or newer identity results', async () => {
    for (const change of ['project', 'identity', 'probe']) {
        for (const failure of [false, true]) {
            const m = model(), held = deferred(); m.rememberIdentity(f103); m.call = () => held.promise;
            const pending = m.loadBackups();
            if (change === 'project') { m.detection++; m.project = { ...project(), path: '/f407' }; }
            if (change === 'identity') m.rememberIdentity(f407);
            if (change === 'probe') m.probe = 'usb:3-2';
            m.backups = [b];
            if (failure) held.reject(Error('old failure')); else held.resolve([a]);
            await pending; assert.deepEqual(m.backups, [b]);
        }
    }
});

test('newest backup refresh wins when two requests for the same identity complete out of order', async () => {
    const m = model(), first = deferred(), second = deferred(); let calls = 0;
    m.rememberIdentity(f103); m.call = () => ++calls === 1 ? first.promise : second.promise;
    const old = m.loadBackups(), current = m.loadBackups(); second.resolve([a]); await current;
    first.resolve([]); await old; assert.deepEqual(m.backups, [a]);
});

test('selecting a different probe immediately clears old identity and reloads clearly scoped history', async () => {
    const m = model(); m.probe = 'usb:3-1'; m.rememberIdentity(f103); m.backups = [a]; m.lastFlash = { ok: true };
    m.setProbe('usb:3-2'); assert.equal(m.identity, undefined); assert.equal(m.lastFlash, undefined); assert.equal(m.backups.length, 0);
    await flush(); assert.equal(m.probe, 'usb:3-2'); assert.equal(m.backupScope, 'history'); assert.deepEqual(m.backups, [a, b]);
    assert.equal(m.calls.every(([method]) => method === 'listBackups'), true, 'selection performs no target identification or hardware action');
});

test('probe disappearance clears the old chip identity without silently switching explicit choice to auto', async () => {
    const m = model(); m.probes = probes; m.probe = 'usb:3-1'; m.rememberIdentity(f103); m.backups = [a];
    const call = m.call; m.call = (method, args) => method === 'listProbes' ? Promise.resolve([probes[1]]) : call(method, args);
    await m.refreshDevices(); await flush();
    assert.equal(m.probe, 'usb:3-1'); assert.equal(m.identity, undefined); assert.equal(m.backupScope, 'history');
    assert.equal(m.calls.some(([method]) => ['identify', 'flash', 'reset', 'restore'].includes(method)), false);
});

test('automatic probe mode invalidates only the vanished identified target; an unrelated probe removal preserves it', async () => {
    for (const survivor of [0, 1]) {
        const m = model(); m.probes = probes; m.rememberIdentity(f103);
        const call = m.call; m.call = (method, args) => method === 'listProbes' ? Promise.resolve([probes[survivor]]) : call(method, args);
        await m.refreshDevices(); await flush();
        assert.equal(!!m.identity, survivor === 0);
    }
});

test('a late probe enumeration cannot erase a newer connected target', async () => {
    const m = model(), first = deferred(), second = deferred(); let calls = 0; const call = m.call;
    m.probes = probes; m.rememberIdentity(f103);
    m.call = (method, args) => method === 'listProbes' ? (++calls === 1 ? first.promise : second.promise) : call(method, args);
    const old = m.refreshDevices(), current = m.refreshDevices(); second.resolve(probes); await current;
    first.resolve([]); await old; assert.equal(m.identity.uid, f103.uid); assert.deepEqual(m.probes, probes);
});

test('ST-LINK monitor-port changes preserve chip identity; ISP changes and unplugging invalidate it', async () => {
    const m = model(); m.rememberIdentity(f103); m.setMonitorPort('/dev/cu.usbserial-a');
    assert.equal(m.identity.uid, f103.uid);
    m.project.flashMethod = 'uart'; m.rememberIdentity({ ...f103, method: 'uart' });
    m.setMonitorPort('/dev/cu.usbserial-b'); assert.equal(m.identity, undefined); await flush();
    m.rememberIdentity({ ...f103, method: 'uart' });
    await m.refreshPorts(); await flush();
    assert.equal(m.identity, undefined); assert.equal(m.monitorPort, '/dev/cu.usbserial-b', 'unplugged explicit port is still remembered');
});

test('successful method changes invalidate old identity while failed settings save preserves it', async () => {
    const m = model(), call = m.call; m.rememberIdentity(f103);
    m.call = (method, args) => method === 'setProjectOption' ? Promise.reject(Error('read-only')) : call(method, args);
    await m.setOption('flashMethod', 'uart'); assert.equal(m.identity.uid, f103.uid);
    m.call = (method, args) => method === 'setProjectOption' ? Promise.resolve({ ...project(), flashMethod: 'uart' }) : call(method, args);
    await m.setOption('flashMethod', 'uart'); await flush();
    assert.equal(m.identity, undefined); assert.equal(m.backupScope, 'history');
});

test('identify response after workspace change or cancellation cannot restore an obsolete identity', async () => {
    for (const change of ['project', 'cancel']) {
        const m = model(), held = deferred(); m.call = () => held.promise;
        const pending = m.identify();
        if (change === 'project') { m.detection++; m.project = { ...project(), path: '/f407' }; }
        else m.downloadIntent++;
        held.resolve(f103); await pending; assert.equal(m.identity, undefined); assert.equal(m.identifying, false); assert.equal(m.backups.length, 0);
    }
});

test('historical ISP backup can still be submitted for authoritative backend UID verification', async () => {
    const m = model(); m.project.flashMethod = 'uart'; m.monitorPort = '/dev/cu.usbserial-test';
    m.call = async (method, args) => {
        if (method === 'listBackups') return [a];
        assert.equal(method, 'restore'); assert.equal(args.backup, a.id); assert.equal('skipBackup' in args, false);
        return { identity: { ...f103, method: 'uart' }, needsBootRestore: true };
    };
    await m.restore(a); assert.equal(m.identity.uid, f103.uid); assert.equal(m.awaitUser, 'exitBoot');
});


test('a new identity never temporarily labels another devices history as its own backups', () => {
    const m = model(); m.backups = [a, b];
    m.rememberIdentity(f103); assert.equal(m.backupScope, 'device'); assert.equal(m.backups.length, 0);
    m.backups = [a]; m.rememberIdentity(f407); assert.equal(m.backups.length, 0);
});


test('pending monitor connection rejects another port change without changing selected target', () => {
    for (const method of ['stlink', 'uart']) {
        const m = model(); m.project.flashMethod = method; m.monitorPort = '/dev/cu.usbserial-a';
        m.rememberIdentity({ ...f103, method }); m.monitor.open = true; m.monitorBusy = true;
        m.setMonitorPort('/dev/cu.usbserial-b');
        assert.equal(m.monitorPort, '/dev/cu.usbserial-a'); assert.equal(m.identity.uid, f103.uid);
        assert.equal(m.calls.length, 0); assert.equal(m.monitorPortExplicit, false);
    }
});

test('BOOT waiting locks ISP port selection even after the device worker has ended', () => {
    for (const guide of ['enterBoot', 'exitBoot']) {
        const m = model(); m.project.flashMethod = 'uart'; m.monitorPort = '/dev/cu.usbserial-a';
        m.rememberIdentity({ ...f103, method: 'uart' }); m.awaitUser = guide;
        assert.equal(m.busy, false);
        m.setMonitorPort('/dev/cu.usbserial-b');
        assert.equal(m.monitorPort, '/dev/cu.usbserial-a'); assert.equal(m.identity.uid, f103.uid);
        assert.equal(m.awaitUser, guide); assert.equal(m.calls.length, 0);
    }
});


test('detect at the same path invalidates device identity when on-disk target or method changed', async () => {
    for (const change of ['target', 'method']) {
        const m = model(), call = m.call;
        m.rememberIdentity(f103); m.backups = [a]; m.lastFlash = { ok: true };
        const build = { ok: true }; m.lastBuild = build;
        const updated = change === 'target'
            ? { ...project(), manifest: { target: { mcu: 'STM32F407ZGT6' } } }
            : { ...project(), flashMethod: 'uart' };
        m.call = (method, args) => method === 'openProject' ? Promise.resolve(updated) : call(method, args);
        m.files = { exists: async () => true, read: async () => ({ value: JSON.stringify({ kind: 'stm32-hal' }) }) };
        m.espProjectKey = m.cProjectKey = { set() {} };
        m.refreshDevices = m.syncMonitor = async () => {};
        const root = { resolve: () => ({}), path: { fsPath: () => '/f103' } };
        await m.detect(root); await flush();
        assert.equal(m.project, updated); assert.equal(m.identity, undefined); assert.equal(m.lastFlash, undefined);
        assert.equal(m.backupScope, 'history'); assert.deepEqual(m.backups, [a, b]);
        assert.equal(m.lastBuild, build, 'this fix does not change compilation state semantics');
    }
});

test('reload invalidates same-path target/method changes but preserves identity for unrelated settings', async () => {
    for (const change of ['target', 'method', 'unrelated']) {
        const m = model(), call = m.call; m.rememberIdentity(f103); m.backups = [a];
        const updated = change === 'target'
            ? { ...project(), manifest: { target: { mcu: 'STM32F407ZGT6' } } }
            : change === 'method' ? { ...project(), flashMethod: 'uart' }
            : { ...project(), manifest: { ...project().manifest, monitor: { baud: 9600 } } };
        m.call = (method, args) => method === 'openProject' ? Promise.resolve(updated) : call(method, args);
        await m.reload(); await flush();
        assert.equal(m.project, updated);
        assert.equal(!!m.identity, change === 'unrelated');
        assert.equal(m.backupScope, change === 'unrelated' ? 'device' : 'history');
    }
});
