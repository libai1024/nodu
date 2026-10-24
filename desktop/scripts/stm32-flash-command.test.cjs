// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load(file, extra = {}) {
    class Empty {}
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    const fallback = new Proxy({}, { get: () => Empty });
    const exports = {}, base = path.dirname(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        exports, TextDecoder, TextEncoder, atob, Date,
        setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: fn => fn(),
        require: id => extra[id] || (id.startsWith('../common/') ? require(path.resolve(base, id))
            : id === '@theia/core/shared/inversify' ? { inject: () => () => {}, postConstruct: () => () => {}, injectable: () => value => value }
            : id === '@theia/core/lib/common/event' ? { Emitter } : fallback),
    });
    return exports;
}
const { NoduEmbeddedModel, EmbeddedError } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-model'));
const commands = require('../scope-extension/lib/browser/nodu-embedded-commands');
const { NoduEmbeddedContribution } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-contribution'), {
    '@theia/core/lib/browser': { CommonCommands: { SAVE_ALL: { id: 'save-all' } } },
    './nodu-embedded-model': { NoduEmbeddedModel, EmbeddedError },
    './nodu-embedded-commands': commands,
});
const bundle = 'a'.repeat(64);
const success = { ok: true, identity: { uid: 'simulated', method: 'stlink' }, needsBootRestore: false, running: true };
const project = () => ({ path: '/test', name: 'fixture', trusted: true, toolkit: { ok: true }, manifest: { target: { vendor: 'st' }, monitor: {} }, flashMethod: 'stlink', currentBuild: { bundle }, buildStale: false });
const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
function model() {
    const m = new NoduEmbeddedModel(), calls = [];
    m.project = project(); m.editors = { all: [] }; m.setDiagnostics = () => {}; m.clearMarkers = () => {};
    m.ensureMonitor = async () => { calls.push(['monitor']); };
    m.loadBackups = async () => {};
    m.call = async (method, args) => {
        calls.push([method, args]);
        if (method === 'openProject') return { ...m.project };
        if (method === 'flash') return success;
        if (method === 'build') return { ok: true, diagnostics: [], artifact: { bundleSha256: bundle } };
        if (method === 'cancel') return {};
        throw Error(`Unexpected RPC ${method}`);
    };
    m.calls = calls;
    return m;
}
function dirtyEditor(file = '/test/Core/Src/main.c') {
    return { isDisposed: false, saveable: { dirty: true }, editor: { uri: { path: { fsPath: () => file } } } };
}

test('flash-only refreshes current bundle and preserves hardware guards without compiling', async () => {
    const m = model(); m.probe = 'selected-probe';
    assert.equal(await m.flashCurrent(true), true);
    assert.deepEqual(m.calls.map(x => x[0]), ['openProject', 'monitor', 'flash']);
    const args = m.calls.find(x => x[0] === 'flash')[1];
    assert.equal(args.path, '/test'); assert.equal(args.bundle, bundle);
    assert.equal(args.compatibleConfirmed, true); assert.equal(args.probe, 'selected-probe');
    assert.equal('skipBackup' in args, false);
    assert.equal(m.steps('stlink').some(x => x.id === 'build'), false, 'flash-only does not claim compilation');
    assert.equal(m.busy, false);
});

test('missing, stale, and unsaved sources reject before monitor or flash', async () => {
    for (const kind of ['missing', 'stale', 'dirty']) {
        const m = model();
        if (kind === 'missing') m.project.currentBuild = null;
        if (kind === 'stale') m.project.buildStale = true;
        if (kind === 'dirty') m.editors.all.push(dirtyEditor());
        assert.equal(await m.flashCurrent(), false);
        assert.equal(m.lastError.code, { missing: 'noBuild', stale: 'staleBuild', dirty: 'unsavedSources' }[kind]);
        assert.equal(m.calls.some(x => ['build', 'flash', 'monitor'].includes(x[0])), false);
        assert.equal(m.busy, false);
    }
});

test('dirty unrelated and generated files do not block current firmware', async () => {
    const m = model();
    m.editors.all.push(dirtyEditor('/another/main.c'), dirtyEditor('/test/.vscode/settings.json'), dirtyEditor('/test/build/generated.c'));
    assert.equal(await m.flashCurrent(), true);
});

test('unsaved custom build input is blocked even when it is not a C source extension', async () => {
    const m = model(); m.editors.all.push(dirtyEditor('/test/resources/calibration.json'));
    assert.equal(await m.flashCurrent(), false); assert.equal(m.lastError.code, 'unsavedSources');
    assert.equal(m.calls.length, 0);
});

test('backend tamper rejection stays authoritative and is never converted into success', async () => {
    const m = model(), call = m.call;
    m.call = (method, args) => method === 'flash'
        ? Promise.reject(new EmbeddedError({ code: 'tampered', message: 'changed artifact' })) : call(method, args);
    assert.equal(await m.flashCurrent(), false);
    assert.equal(m.lastError.code, 'tampered'); assert.equal(m.lastFlash, undefined); assert.equal(m.busy, false);
});

test('changing project while refreshing bundle aborts without adopting old project status', async () => {
    const m = model(), wait = deferred(); m.call = () => wait.promise;
    const pending = m.flashCurrent();
    assert.equal(m.busy, true);
    m.detection++; m.project = { ...project(), path: '/other' };
    wait.resolve(project());
    assert.equal(await pending, false); assert.equal(m.project.path, '/other'); assert.equal(m.lastError, undefined);
});

test('edits during monitor preparation invalidate bundle before hardware flash', async () => {
    const m = model(), wait = deferred(); m.ensureMonitor = () => wait.promise;
    const pending = m.flashCurrent(); await new Promise(setImmediate);
    m.sourceChanged('/test/Core/Src/main.c', true); wait.resolve();
    assert.equal(await pending, false); assert.equal(m.lastError.code, 'staleBuild');
    assert.equal(m.calls.some(x => x[0] === 'flash'), false);
});

test('cancel during read-only preflight prevents subsequent monitor, flash, and concurrent command', async () => {
    const m = model(), wait = deferred(), call = m.call;
    m.call = (method, args) => method === 'openProject' ? wait.promise : call(method, args);
    const pending = m.flashCurrent();
    assert.equal(await m.flashCurrent(), false); assert.equal(await m.build(), undefined);
    await m.stop(); wait.resolve(project());
    assert.equal(await pending, false); assert.equal(m.calls.length, 0); assert.equal(m.task.text, '已停止');
});

test('cancel or project switch after RPC dispatch does not apply an old completion to current UI', async () => {
    for (const kind of ['cancel', 'switch']) {
        const m = model(), wait = deferred(), call = m.call;
        m.call = (method, args) => method === 'flash' ? wait.promise : call(method, args);
        const pending = m.flashCurrent(); await new Promise(setImmediate);
        if (kind === 'cancel') await m.stop();
        else { m.detection++; m.project = { ...project(), path: '/other' }; }
        wait.resolve(success);
        assert.equal(await pending, false); assert.equal(m.lastFlash, undefined); assert.equal(m.identity, undefined);
        assert.equal(m.busy, false);
    }
});

test('compile-and-flash retains compile stage and refuses a build from a different workspace generation', async () => {
    const m = model();
    assert.equal(await m.run(), true);
    assert.deepEqual(m.calls.map(x => x[0]), ['build', 'openProject', 'monitor', 'flash']);
    assert.equal(m.steps('stlink')[0].id, 'build');
    const n = model(), wait = deferred(); n.call = () => wait.promise;
    const pending = n.run(); n.detection++; n.project = { ...project(), path: '/other' };
    wait.resolve({ ok: true, diagnostics: [], artifact: { bundleSha256: bundle } });
    assert.equal(await pending, false); assert.equal(n.lastBuild, undefined); assert.equal(n.busy, false);
});

test('UART flash-only requires an explicit serial port and retains BOOT restoration flow', async () => {
    const m = model(); m.project.flashMethod = 'uart';
    assert.equal(await m.flashCurrent(), false); assert.equal(m.lastError.code, 'noPort');
    m.monitorPort = '/dev/simulated'; const call = m.call;
    m.call = async (method, args) => method === 'flash' ? { ...success, needsBootRestore: true } : call(method, args);
    assert.equal(await m.flashCurrent(), true); assert.equal(m.awaitUser, 'exitBoot');
});

function contribution() {
    const c = new NoduEmbeddedContribution(); c.model = model();
    c.commands = { executeCommand: async () => {} }; c.ensureTrusted = async () => true;
    c.showPanel = async () => {}; c.layoutState = { setDeviceOpen() {} }; c.confirm = async () => true;
    return c;
}

test('flash command saves first and an edited saved project requires explicit recompilation', async () => {
    const c = contribution(); const editor = dirtyEditor(); c.model.editors.all.push(editor);
    c.commands.executeCommand = async id => { assert.equal(id, 'save-all'); editor.saveable.dirty = false; c.model.project.buildStale = true; };
    await c.flash();
    assert.equal(c.model.lastError.code, 'staleBuild');
    assert.equal(c.model.calls.some(x => x[0] === 'build' || x[0] === 'flash'), false);
});

test('failed/cancelled save and project switch during save prevent flash-only command dispatch', async () => {
    for (const kind of ['failed', 'dirty', 'switch']) {
        const c = contribution();
        c.model.editors.all.push(dirtyEditor());
        c.commands.executeCommand = async () => {
            if (kind === 'failed') throw Error('read-only disk');
            if (kind === 'switch') { c.model.detection++; c.model.project = { ...project(), path: '/other' }; }
        };
        await c.flash(); assert.equal(c.model.calls.length, 0);
        if (kind !== 'switch') assert.ok(c.model.lastError);
    }
});

test('flash command is STM32-scoped and compatibility cancellation never dispatches hardware', async () => {
    const c = contribution(), handlers = new Map();
    c.registerCommands({ registerCommand: (command, handler) => handlers.set(command.id, handler) });
    assert.equal(commands.C_COMMANDS.flash, 'nodu.c.flash');
    assert.equal(handlers.get(commands.C_COMMANDS.flash).isEnabled(), true);
    c.model.project.manifest.target.vendor = 'compatible'; c.confirm = async () => false;
    await handlers.get(commands.C_COMMANDS.flash).execute(); assert.equal(c.model.calls.length, 0);
    c.model.project = undefined;
    assert.equal(handlers.get(commands.C_COMMANDS.flash).isVisible(), false);
});

test('download method changes serialize actual saves and expose pending state until the final choice is saved', async () => {
    const m = model(), saves = [];
    m.call = (method, args) => { assert.equal(method, 'setProjectOption'); const held = deferred(); saves.push({ ...held, args }); return held.promise; };
    const first = m.setOption('flashMethod', 'uart');
    const second = m.setOption('flashMethod', 'stlink');
    assert.equal(m.savingOptions, true); assert.equal(m.busy, true);
    await new Promise(setImmediate); assert.equal(saves.length, 1); assert.equal(saves[0].args.value, 'uart');
    saves[0].resolve({ ...project(), flashMethod: 'uart' }); await first; await new Promise(setImmediate);
    assert.equal(saves.length, 2); assert.equal(saves[1].args.value, 'stlink'); assert.equal(m.savingOptions, true);
    saves[1].resolve(project()); await second;
    assert.equal(m.project.flashMethod, 'stlink'); assert.equal(m.savingOptions, false); assert.equal(m.busy, false);
});

test('old option response cannot replace a different project or a new visit to the same path', async () => {
    for (const samePath of [true, false]) {
        const m = model(), held = deferred(); m.call = () => held.promise;
        const pending = m.setOption('flashMethod', 'uart'); await new Promise(setImmediate);
        m.detection++; m.project = { ...project(), path: samePath ? '/test' : '/new-project', name: 'new instance' };
        held.resolve({ ...project(), flashMethod: 'uart' }); await pending;
        assert.equal(m.project.name, 'new instance'); assert.equal(m.project.flashMethod, 'stlink'); assert.equal(m.savingOptions, false);
    }
});

test('old option failure cannot overwrite new project errors; save failures permit retry', async () => {
    const m = model(); let reject;
    m.call = () => new Promise((_, fail) => { reject = fail; });
    const pending = m.setOption('flashMethod', 'uart'); await new Promise(setImmediate);
    m.detection++; m.project = { ...project(), path: '/new-project' }; m.lastError = { code: 'new', message: 'new problem' };
    reject(Error('old disk failure')); await pending;
    assert.equal(m.lastError.code, 'new'); assert.equal(m.savingOptions, false);
    m.call = async () => { throw Error('read-only'); }; await m.setOption('flashMethod', 'uart');
    assert.match(m.lastError.message, /read-only/); assert.equal(m.savingOptions, false);
    m.call = async () => ({ ...m.project, flashMethod: 'uart' }); await m.setOption('flashMethod', 'uart');
    assert.equal(m.project.flashMethod, 'uart'); assert.equal(m.savingOptions, false);
    assert.equal(m.lastError, undefined); assert.equal(m.task, undefined);
});

test('busy and BOOT restoration prevent download method mutation and preserve the guide', async () => {
    for (const state of ['building', 'flashing', 'identifying', 'exitBoot']) {
        const m = model(); if (state === 'exitBoot') m.awaitUser = 'exitBoot'; else m[state] = true;
        await m.setOption('flashMethod', 'uart');
        assert.equal(m.project.flashMethod, 'stlink'); assert.equal(m.calls.length, 0);
        assert.equal(m.lastError.code, state === 'exitBoot' ? 'awaitBoot' : 'busy');
        if (state === 'exitBoot') assert.equal(m.awaitUser, 'exitBoot');
    }
});

test('a pending project option cannot race a new compile or flash; queued obsolete saves are skipped', async () => {
    const m = model(), held = deferred(); let saves = 0;
    m.call = async method => { assert.equal(method, 'setProjectOption'); saves++; return held.promise; };
    const first = m.setOption('flashMethod', 'uart'), second = m.setOption('monitorEncoding', 'gbk');
    await new Promise(setImmediate);
    assert.equal(await m.build(), undefined); assert.equal(await m.flashCurrent(), false);
    m.detection++; m.project = { ...project(), path: '/next' }; held.resolve(project());
    await Promise.all([first, second]); assert.equal(saves, 1); assert.equal(m.project.path, '/next'); assert.equal(m.busy, false);
});

test('device radio shows pending feedback and stays locked during BOOT restoration', async () => {
    const React = { ...require('react'), useRef: current => ({ current }), useLayoutEffect() {} };
    const { NoduCDevicePanel } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-device'), {
        '@theia/core/shared/react': React,
        './nodu-embedded-model': { NoduEmbeddedModel, formatBytes: n => String(n) },
        './nodu-embedded-commands': commands,
    });
    const m = model(); m.project.chip = { name: 'STM32F103C8T6', core: 'Cortex-M3', flash: { size: 65536 }, ram: { size: 20480 } };
    const nodes = () => {
        const out = [], visit = node => {
            if (Array.isArray(node)) node.forEach(visit);
            else if (node && typeof node === 'object') { out.push(node); visit(node.props?.children); visit(node.props?.action); }
        };
        visit(NoduCDevicePanel({ model: m, simple: true, confirm: async () => false, exec() {}, showOutput() {} })); return out;
    };
    const radios = () => nodes().filter(node => node.type === 'input' && node.props.type === 'radio');
    assert.equal(radios().every(node => !node.props.disabled), true);
    const held = deferred(); m.call = () => held.promise;
    const pending = m.setOption('flashMethod', 'uart'); await new Promise(setImmediate);
    assert.equal(radios().every(node => node.props.disabled), true);
    assert.equal(nodes().find(node => node.props?.role === 'radiogroup').props['aria-busy'], true);
    assert.ok(nodes().find(node => node.props?.role === 'status' && node.props.children === '保存中'));
    held.resolve({ ...m.project, flashMethod: 'uart' }); await pending;
    assert.equal(radios()[1].props.checked, true); assert.equal(radios().every(node => !node.props.disabled), true);
    m.awaitUser = 'exitBoot'; assert.equal(radios().every(node => node.props.disabled), true);
    assert.match(nodes().find(node => node.props?.role === 'radiogroup').props.title, /BOOT/);
    m.awaitUser = undefined; assert.equal(radios().every(node => !node.props.disabled), true);
});


async function waitingDownload() {
    const m = model(), flash = deferred(), cancel = deferred(), call = m.call;
    m.project.flashMethod = 'uart'; m.monitorPort = '/dev/simulated';
    m.call = (method, args) => method === 'flash' ? flash.promise : method === 'cancel' ? cancel.promise : call(method, args);
    const pending = m.flashCurrent(); await new Promise(setImmediate);
    m.onEvent('flash.started', { path: '/test', runId: 'test-run' });
    m.onEvent('flash.awaitUser', { runId: 'test-run', kind: 'enterBoot' });
    m.onEvent('flash.step', { runId: 'test-run', step: 'identify', state: 'running' });
    return { m, flash, cancel, pending };
}

test('stopping UART Bootloader wait clears its guide and releases busy only after the worker finishes', async () => {
    const { m, flash, cancel, pending } = await waitingDownload();
    assert.equal(m.awaitUser, 'enterBoot'); assert.equal(m.busy, true);
    const stopping = m.stop(); cancel.resolve({ cancelled: true }); await stopping;
    assert.equal(m.awaitUser, undefined); assert.equal(m.flashing, true);
    m.onEvent('flash.awaitUser', { runId: 'test-run', kind: 'enterBoot' });
    assert.equal(m.awaitUser, undefined, 'queued wait does not resurrect the guide');
    flash.reject(new EmbeddedError({ code: 'cancelled', message: 'cancelled' }));
    assert.equal(await pending, false); assert.equal(m.busy, false); assert.equal(m.awaitUser, undefined);
    assert.equal(m.lastError, undefined); assert.equal(m.task.text, '已停止');
    m.onEvent('flash.started', { path: '/test', runId: 'test-run' });
    m.onEvent('flash.awaitUser', { runId: 'test-run', kind: 'enterBoot' });
    assert.equal(m.awaitUser, undefined, 'late start from a cancelled run is ignored');
    m.call = async () => ({ ...m.project, flashMethod: 'stlink' });
    await m.setOption('flashMethod', 'stlink'); assert.equal(m.project.flashMethod, 'stlink');
});

test('stopping a stale guide without an active worker dismisses it without touching hardware', async () => {
    for (const guide of ['enterBoot', 'exitBoot']) {
        const m = model(); m.awaitUser = guide; m.runId = 'finished-old-run';
        await m.stop(); assert.equal(m.awaitUser, undefined); assert.equal(m.task.text, '已停止');
        assert.equal(m.calls.length, 0);
        m.onEvent('flash.started', { path: '/test', runId: 'finished-old-run' });
        m.onEvent('flash.awaitUser', { runId: 'finished-old-run', kind: 'enterBoot' });
        assert.equal(m.awaitUser, undefined, 'late events cannot revive a finished renderer guide');
    }
});

test('cancel during UART programming waits for safe worker completion and preserves BOOT restoration', async () => {
    const { m, flash, cancel, pending } = await waitingDownload();
    m.onEvent('flash.detected', { runId: 'test-run' });
    m.onEvent('flash.step', { runId: 'test-run', step: 'program', state: 'running' });
    const stopping = m.stop(); cancel.resolve({ cancelled: true }); await stopping;
    assert.equal(m.busy, true); assert.equal(m.task.text, '写入完成后停止');
    assert.equal(await m.flashCurrent(), false, 'no concurrent flash while safe write is draining');
    flash.resolve({ ...success, needsBootRestore: true }); assert.equal(await pending, false);
    assert.equal(m.busy, false); assert.equal(m.awaitUser, 'exitBoot'); assert.match(m.task.text, /恢复 BOOT/);
    assert.equal(m.lastFlash, undefined, 'cancelled intent does not claim a successful run');
});

test('detection immediately after stop still preserves the required manual BOOT restoration', async () => {
    const { m, flash, cancel, pending } = await waitingDownload();
    const stopping = m.stop();
    m.onEvent('flash.detected', { runId: 'test-run' });
    cancel.resolve({ cancelled: true }); await stopping;
    flash.reject(new EmbeddedError({ code: 'cancelled', message: 'cancelled' })); await pending;
    assert.equal(m.awaitUser, 'exitBoot'); assert.equal(m.busy, false);
});

test('cancel failure is reported without claiming the worker stopped; later failures remain visible', async () => {
    const { m, flash, cancel, pending } = await waitingDownload();
    const stopping = m.stop(); cancel.reject(new EmbeddedError({ code: 'offline', message: 'service unavailable' }));
    await stopping; assert.equal(m.flashing, true); assert.equal(m.lastError.code, 'offline');
    assert.match(m.task.text, /停止失败/);
    flash.reject(new EmbeddedError({ code: 'writeFailed', message: 'write failed' })); await pending;
    assert.equal(m.busy, false); assert.equal(m.awaitUser, undefined); assert.equal(m.lastError.code, 'writeFailed');
});

test('late cancel acknowledgement cannot overwrite another project or a subsequent download', async () => {
    for (const change of ['project', 'download']) {
        const { m, flash, cancel, pending } = await waitingDownload();
        const stopping = m.stop(); flash.reject(new EmbeddedError({ code: 'cancelled', message: 'cancelled' })); await pending;
        if (change === 'project') { m.detection++; m.project = { ...project(), path: '/other' }; }
        else { m.downloadIntent++; }
        m.setTask('new task', 'busy'); m.awaitUser = 'exitBoot';
        cancel.resolve({ cancelled: true }); await stopping;
        assert.equal(m.task.text, 'new task'); assert.equal(m.awaitUser, 'exitBoot');
    }
});


test('repeat stop and a delayed first flash event cannot revive the cancelled wait', async () => {
    for (const beforeStarted of [true, false]) {
        const { m, flash, cancel, pending } = await waitingDownload();
        if (beforeStarted) { m.runId = ''; m.awaitUser = undefined; }
        const stopping = m.stop(), again = m.stop(); cancel.resolve({ cancelled: true }); await Promise.all([stopping, again]);
        assert.equal(m.task.text, '正在停止');
        m.onEvent('flash.started', { path: '/test', runId: 'test-run' });
        m.onEvent('flash.awaitUser', { runId: 'test-run', kind: 'enterBoot' });
        assert.equal(m.awaitUser, undefined);
        flash.reject(new EmbeddedError({ code: 'cancelled', message: 'cancelled' })); await pending;
        m.onEvent('flash.started', { path: '/test', runId: 'test-run' });
        m.onEvent('flash.awaitUser', { runId: 'test-run', kind: 'enterBoot' });
        assert.equal(m.awaitUser, undefined); assert.equal(m.busy, false);
    }
});


test('failed cancellation can be retried without old intent blocking the next device cancel', async () => {
    const { m, flash, cancel, pending } = await waitingDownload();
    const stopping = m.stop(); cancel.reject(new EmbeddedError({ code: 'offline', message: 'temporary connection failure' }));
    await stopping; assert.equal(m.flashing, true); assert.equal(m.lastError.code, 'offline');
    let retries = 0; m.call = async (method, args) => {
        assert.equal(method, 'cancel'); assert.equal(args.queue, 'device'); retries++;
        flash.reject(new EmbeddedError({ code: 'cancelled', message: 'cancelled' }));
        return { cancelled: true };
    };
    await m.stop(); await pending;
    assert.equal(retries, 1); assert.equal(m.busy, false); assert.equal(m.awaitUser, undefined);
    assert.equal(m.lastError, undefined); assert.equal(m.task.text, '已停止');
});


test('refresh never suggests or retains an implicit Bluetooth or system console as the ISP port', async () => {
    const system = [
        { path: '/dev/cu.Bluetooth-Incoming-Port', description: 'BluetoothPort' },
        { path: '/dev/cu.debug-console', description: 'Unknown' },
        { path: '/dev/cu.wlan-debug', description: 'Unknown' },
        { path: 'COM4', description: 'BluetoothPort' },
    ];
    for (const port of system) {
        const m = model(); m.monitorPort = port.path; m.call = async () => system;
        await m.refreshPorts(); assert.equal(m.monitorPort, '');
        const usb = { path: '/dev/cu.usbserial-test', vid: 0x1a86, description: 'USB Serial' };
        m.monitorPort = port.path; m.call = async () => [...system, usb];
        await m.refreshPorts(); assert.equal(m.monitorPort, usb.path);
    }
});

test('explicit virtual port, unplugged USB port, and explicit no-monitor choice survive automatic refresh', async () => {
    for (const current of ['/dev/cu.Bluetooth-Incoming-Port', '/dev/cu.usbserial-unplugged', '']) {
        const m = model(); m.monitorPort = current; m.monitorPortExplicit = true;
        m.call = async () => [{ path: '/dev/cu.usbserial-new', vid: 0x1a86 }];
        await m.refreshPorts(); assert.equal(m.monitorPort, current);
    }
});

test('background monitor status does not silently inherit a system port or replace an explicit choice', async () => {
    const m = model();
    m.call = async () => ({ open: true, port: '/dev/cu.Bluetooth-Incoming-Port', baud: 115200 });
    await m.syncMonitor(); assert.equal(m.monitorPort, ''); assert.equal(m.monitor.open, true);
    m.call = async () => ({ open: true, port: '/dev/cu.usbserial-test', baud: 115200 });
    await m.syncMonitor(); assert.equal(m.monitorPort, '/dev/cu.usbserial-test');
    m.monitorPortExplicit = true; m.monitorPort = '';
    await m.syncMonitor(); assert.equal(m.monitorPort, '');
});

test('ISP rejects an inherited system port before flash but permits a deliberate selection', async () => {
    const m = model(); m.project.flashMethod = 'uart'; m.monitorPort = '/dev/cu.Bluetooth-Incoming-Port';
    assert.equal(await m.flashCurrent(), false); assert.equal(m.lastError.code, 'noPort');
    assert.equal(m.calls.some(([method]) => method === 'flash' || method === 'monitor'), false);
    m.monitorPortExplicit = true;
    assert.equal(await m.flashCurrent(), true);
    assert.equal(m.calls.find(([method]) => method === 'flash')[1].port, '/dev/cu.Bluetooth-Incoming-Port');
});
