// SPDX-License-Identifier: MIT
// Exercise production device controls with a model double. No device service is loaded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const commands = require('../lib/browser/nodu-embedded-commands');
const formatBytes = bytes => bytes >= 1024 * 1024 ? `${bytes / (1024 * 1024)} MB` : `${bytes / 1024} KB`;
let activeHooks;
const React = {
    Fragment: 'fragment',
    useRef(initial) { const index = activeHooks.cursor++; return activeHooks.slots[index] ??= { current: initial }; },
    useLayoutEffect(callback) { activeHooks.cursor++; activeHooks.effects.push(callback); },
    createElement(type, props, ...children) { return { type, props: { ...props, children: children.length === 1 ? children[0] : children } }; }
};
const exportsObject = {};
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/browser/nodu-embedded-device.js'), 'utf8'), {
    exports: exportsObject,
    require: name => {
        if (name === '@theia/core/shared/react') return React;
        if (name === './nodu-embedded-model') return { NoduEmbeddedModel: class {}, formatBytes };
        if (name === './nodu-embedded-commands') return commands;
        if (name === './nodu-select') return { NoduSelect: 'nodu-select-control' };
        throw new Error(`Unexpected component dependency: ${name}`);
    }
});
const { NoduCDevicePanel, NoduDiagnosis } = exportsObject;
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const backupFixture = { id: 'backup-a', createdAt: '2026-10-24T08:00:00Z', bytes: 65536, firstBackup: true, deviceName: 'STM32F103C8T6', uid: '00112233445566778899aabb' };

function expand(node) {
    if (Array.isArray(node)) return node.map(expand);
    if (!node || typeof node !== 'object') return node;
    if (typeof node.type === 'function') return expand(node.type(node.props));
    return { ...node, props: { ...node.props, children: expand(node.props.children) } };
}
function nodes(root) {
    const result = [];
    const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { result.push(node); visit(node.props.children); } };
    visit(root); return result;
}
function text(root) {
    if (Array.isArray(root)) return root.map(text).join('');
    if (!root || typeof root === 'boolean') return '';
    return typeof root === 'object' ? text(root.props.children) : String(root);
}
const button = (view, label) => nodes(view).find(node => node.type === 'button' && (node.props['aria-label'] ?? text(node)).includes(label));
const selector = (view, label) => nodes(view).find(node => node.type === 'nodu-select-control' && node.props['aria-label'] === label);
const radios = view => nodes(view).filter(node => node.type === 'input' && node.props.type === 'radio');
function fixture(overrides = {}) {
    const calls = [];
    const hooks = { cursor: 0, slots: [], effects: [] };
    const project = {
        path: '/fixture/f103', flashMethod: 'stlink',
        chip: { name: 'STM32F103C8T6', core: 'Cortex-M3', flash: { size: 65536 }, ram: { size: 20480 } },
        manifest: { target: { vendor: 'st' } }, toolkit: { ok: true, version: 'fixture' }
    };
    const model = {
        project, projectGeneration: 1, probes: [], ports: [], probe: '', monitorPort: '', monitorBusy: false, backups: [], backupScope: 'history', savingOptions: false,
        building: false, flashing: false, identifying: false, awaitUser: undefined,
        get busy() { return this.building || this.flashing || this.identifying || this.savingOptions; },
        setOption(key, value) { calls.push(['setOption', key, value]); this.project = { ...this.project, [key]: value }; return Promise.resolve(); },
        setMonitorPort(value) { calls.push(['setMonitorPort', value]); this.monitorPort = value; },
        setProbe(value) { calls.push(['setProbe', value]); this.probe = value; },
        fire() { calls.push(['fire']); }, refreshDevices() { calls.push(['refresh']); return Promise.resolve(); },
        identify() { calls.push(['identify']); return Promise.resolve(); },
        reset() { calls.push(['reset']); return Promise.resolve(); },
        restore(backup, compatible) { calls.push(['restore', backup.id, compatible]); return Promise.resolve(); },
        ...overrides
    };
    const props = { model, simple: true, exec: id => calls.push(['exec', id]), showOutput: () => calls.push(['output']), confirm: async () => { calls.push(['confirm']); return false; } };
    return { model, props, calls, render() {
        const previous = activeHooks; hooks.cursor = 0; activeHooks = hooks;
        try {
            const view = expand(NoduCDevicePanel(props));
            for (const effect of hooks.effects.splice(0)) effect();
            return view;
        } finally { activeHooks = previous; }
    } };
}

test('compact target summary renders actual chip data without repeated section headings', () => {
    for (const chip of [
        { name: 'STM32F103C8T6', core: 'Cortex-M3', flash: { size: 65536 }, ram: { size: 20480 } },
        { name: 'STM32F103CBT6', core: 'Cortex-M3', flash: { size: 131072 }, ram: { size: 20480 } },
        { name: 'STM32F407ZGT6', core: 'Cortex-M4', flash: { size: 1048576 }, ram: { size: 196608 } }
    ]) {
        const f = fixture(); f.model.project.chip = chip; const view = f.render();
        assert.ok(view.props.className.includes('nodu-c-device-compact'));
        assert.equal(nodes(view).filter(node => node.type === 'h2').length, 0);
        assert.ok(text(view).includes(chip.name));
        const summary = nodes(view).find(node => node.type === 'dl'); assert.ok(summary);
        for (const value of [chip.core, formatBytes(chip.flash.size), formatBytes(chip.ram.size)]) assert.ok(text(summary).includes(value));
        assert.deepEqual(f.calls, [], 'opening and rendering must not identify, reset, or restore');
    }
});

test('changing download method only saves the option and changes its relevant controls', () => {
    const f = fixture(); const stlink = f.render(); const choices = radios(stlink);
    assert.equal(choices.length, 2); assert.equal(choices[0].props.checked, true);
    assert.ok(selector(stlink, '下载器')); assert.ok(selector(stlink, '监视器串口')); assert.equal(selector(stlink, 'ISP 串口'), undefined);
    choices[1].props.onChange({ target: { checked: true, value: 'uart' } });
    assert.deepEqual(f.calls, [['setOption', 'flashMethod', 'uart']]);
    const uart = f.render(); assert.equal(radios(uart)[1].props.checked, true);
    assert.ok(selector(uart, 'ISP 串口')); assert.equal(selector(uart, '下载器'), undefined); assert.equal(selector(uart, '监视器串口'), undefined);
    assert.equal(f.calls.some(call => ['identify', 'reset', 'restore'].includes(call[0])), false);
});

function pendingMethodSelection(initiallyFocused = true) {
    const f = fixture(), held = deferred();
    let focusCount = 0;
    const doc = { body: {}, activeElement: null };
    const input = { ownerDocument: doc, isConnected: true, disabled: false, focus() { focusCount++; doc.activeElement = input; } };
    doc.activeElement = initiallyFocused ? input : {};
    f.model.setOption = (key, value) => {
        f.calls.push(['setOption', key, value]); f.model.savingOptions = true; input.disabled = true;
        if (doc.activeElement === input) doc.activeElement = doc.body;
        return held.promise;
    };
    radios(f.render())[1].props.onChange({ currentTarget: input });
    return { f, doc, input, get focusCount() { return focusCount; },
        async settle() { f.model.savingOptions = false; input.disabled = false; held.resolve(); await new Promise(setImmediate); }
    };
}

test('a focused download method regains focus after its asynchronous save and visible enabled commit', async () => {
    const selection = pendingMethodSelection();
    assert.equal(selection.input.disabled, true); assert.equal(selection.doc.activeElement, selection.doc.body);
    selection.f.render(); assert.equal(selection.focusCount, 0, 'a render during the pending save must not restore focus');
    await selection.settle(); assert.equal(selection.focusCount, 0, 'promise completion alone is earlier than the DOM commit');
    selection.f.render(); assert.equal(selection.doc.activeElement, selection.input); assert.equal(selection.focusCount, 1);
    selection.f.render(); assert.equal(selection.focusCount, 1, 'later renders must not refocus the control');
    assert.deepEqual(selection.f.calls, [['setOption', 'flashMethod', 'uart']]);
});

test('late method saves never steal focus after a project switch, explicit focus move, or removed input', async () => {
    for (const change of [
        selection => { selection.f.model.project = { ...selection.f.model.project, path: '/other' }; },
        selection => { selection.f.model.projectGeneration++; },
        selection => { selection.doc.activeElement = { editor: true }; },
        selection => { selection.input.isConnected = false; },
        selection => { selection.input.disabled = true; }
    ]) {
        const selection = pendingMethodSelection(); selection.f.render(); await selection.settle(); change(selection); selection.f.render();
        assert.equal(selection.focusCount, 0);
        selection.f.render(); assert.equal(selection.focusCount, 0, 'an invalidated request remains discarded');
    }
    const unfocused = pendingMethodSelection(false); await unfocused.settle(); unfocused.f.render(); assert.equal(unfocused.focusCount, 0);
});

test('busy operations, pending option saves, and BOOT handoff keep method controls locked', () => {
    for (const state of ['building', 'flashing', 'identifying', 'savingOptions', 'awaitUser']) {
        const f = fixture(); f.model[state] = state === 'awaitUser' ? 'exitBoot' : true;
        const view = f.render(), choices = radios(view); assert.equal(choices.length, 2);
        assert.equal(choices.every(choice => choice.props.disabled), true, state);
        if (state === 'savingOptions') {
            assert.equal(nodes(view).find(node => node.props.role === 'radiogroup').props['aria-busy'], true);
            assert.ok(nodes(view).some(node => node.props.role === 'status'));
        }
        assert.equal(selector(view, '下载器').props.disabled, true);
        assert.equal(selector(view, '监视器串口').props.disabled, true);
        assert.deepEqual(f.calls, []);
    }
});

test('an active monitor connection change prevents selecting another port in both download modes', () => {
    for (const method of ['stlink', 'uart']) {
        const f = fixture({ monitorBusy: true }); f.model.project.flashMethod = method;
        const label = method === 'stlink' ? '监视器串口' : 'ISP 串口';
        assert.equal(selector(f.render(), label).props.disabled, true);
        f.model.monitorBusy = false; assert.equal(Boolean(selector(f.render(), label).props.disabled), false);
        assert.deepEqual(f.calls, []);
    }
});

test('zero, one, and multiple probes retain automatic matching and stable explicit identities', () => {
    const first = { id: 'usb:1-1', model: 'ST-LINK/V2', serial: '11111111111111111111' };
    const second = { id: 'usb:1-2', model: 'ST-LINK/V3', serial: '22222222222222222222' };
    for (const probes of [[], [first], [first, second]]) {
        const f = fixture({ probes }); const select = selector(f.render(), '下载器');
        assert.equal(select.props.value, ''); assert.equal(select.props.options[0].value, '');
        if (probes.length === 0) assert.match(select.props.options[0].label, /未检测/);
        else {
            if (probes.length > 1) assert.match(select.props.options[0].label, /自动/);
            assert.deepEqual(Array.from(select.props.options.slice(1), option => option.value), probes.map(probe => probe.id));
            const explicit = probes.at(-1).id; select.props.onChange(explicit); assert.equal(f.model.probe, explicit);
            assert.deepEqual(f.calls, [['setProbe', explicit]]);
            const selected = selector(f.render(), '下载器');
            assert.equal(selected.props.value, explicit); assert.ok(selected.props.options.some(option => option.value === explicit));
        }
    }
});

test('an unplugged explicitly selected probe remains selected instead of silently using a different board', () => {
    const f = fixture({ probe: 'usb:1-2', probes: [{ id: 'usb:1-1', model: 'ST-LINK/V2', serial: '111111111111' }] });
    const select = selector(f.render(), '下载器'); assert.equal(select.props.value, 'usb:1-2');
    const offline = select.props.options.find(option => option.value === 'usb:1-2'); assert.ok(offline); assert.match(offline.label, /未连接/);
    assert.equal(f.model.probe, 'usb:1-2'); assert.deepEqual(f.calls, []);
});

test('an unplugged selected serial port stays explicit in both ST-LINK and ISP controls', () => {
    for (const method of ['stlink', 'uart']) {
        const f = fixture({ monitorPort: '/dev/cu.unplugged', ports: [{ path: '/dev/cu.available' }] }); f.model.project.flashMethod = method;
        const select = selector(f.render(), method === 'stlink' ? '监视器串口' : 'ISP 串口');
        assert.equal(select.props.value, '/dev/cu.unplugged');
        const unplugged = select.props.options.find(option => option.value === '/dev/cu.unplugged');
        assert.match(unplugged.label, /未连接/); assert.equal(f.model.monitorPort, '/dev/cu.unplugged'); assert.deepEqual(f.calls, []);
        select.props.onChange('/dev/cu.available'); assert.deepEqual(f.calls, [['setMonitorPort', '/dev/cu.available']]);
    }
});

test('backups start folded, keep their original meaning, and expanding never restores hardware', async () => {
    const f = fixture({ backups: [backupFixture] });
    const view = f.render(); const folded = nodes(view).find(node => node.type === 'details' && text(node).includes('备份'));
    assert.ok(folded); assert.notEqual(folded.props.open, true); assert.ok(text(folded).includes('首次备份')); assert.equal(text(folded).includes('出厂'), false);
    folded.props.onToggle?.({ currentTarget: { open: true } }); assert.deepEqual(f.calls, []);
    await button(folded, '恢复').props.onClick(); await new Promise(setImmediate);
    assert.deepEqual(f.calls, [['confirm']], 'cancelled confirmation must not restore');
});

test('historical and current-device backups have distinct scopes and retain chip and UID identification', () => {
    for (const backupScope of ['history', 'device']) {
        const f = fixture({ backups: [backupFixture], backupScope });
        const folded = nodes(f.render()).find(node => node.type === 'details' && text(node).includes('备份'));
        const summary = nodes(folded).find(node => node.type === 'summary');
        assert.ok(text(summary).includes(backupScope === 'device' ? '设备备份' : '历史备份'));
        assert.ok(text(folded).includes(backupFixture.deviceName)); assert.ok(text(folded).includes(backupFixture.uid.slice(-8)));
        assert.ok(nodes(folded).some(node => String(node.props.title ?? '').includes(backupFixture.uid)));
        assert.deepEqual(f.calls, []);
    }
});

test('historical backups can restore through ISP after explicit confirmation without identification or reset', async () => {
    const f = fixture({ backups: [backupFixture], backupScope: 'history', monitorPort: '/dev/cu.isp' });
    f.model.project.flashMethod = 'uart'; f.props.confirm = async () => { f.calls.push(['confirm']); return true; };
    const restore = button(f.render(), '恢复'); assert.equal(Boolean(restore.props.disabled), false);
    restore.props.onClick(); await new Promise(setImmediate);
    assert.deepEqual(f.calls, [['confirm'], ['restore', backupFixture.id, false]]);
});

test('changes to the confirmed project, probe, port, method, or run state invalidate pending restore', async () => {
    const changes = [
        model => { model.project = { ...model.project, path: '/another/project' }; },
        model => { model.projectGeneration++; },
        model => { model.project = { ...model.project, manifest: { ...model.project.manifest, target: { ...model.project.manifest.target, mcu: 'STM32F407ZGT6' } } }; },
        model => { model.project.manifest.target.vendor = 'compatible'; },
        model => { model.probe = 'usb:another'; },
        model => { model.monitorPort = '/dev/cu.another'; },
        model => { model.project = { ...model.project, flashMethod: 'uart' }; },
        model => { model.building = true; },
        model => { model.awaitUser = 'exitBoot'; }
    ];
    for (const change of changes) {
        const held = deferred(), f = fixture({ backups: [backupFixture] });
        f.props.confirm = () => { f.calls.push(['confirm']); return held.promise; };
        button(f.render(), '恢复').props.onClick(); change(f.model); held.resolve(true); await new Promise(setImmediate);
        assert.deepEqual(f.calls, [['confirm']], 'stale confirmation must not restore or operate on a changed target');
    }
});

test('compatible-device second confirmation also rechecks the selected target', async () => {
    const held = deferred(), f = fixture({ backups: [backupFixture] }); f.model.project.manifest.target.vendor = 'compatible';
    let count = 0; f.props.confirm = () => { f.calls.push(['confirm']); return ++count === 1 ? Promise.resolve(true) : held.promise; };
    button(f.render(), '恢复').props.onClick(); await new Promise(setImmediate); assert.equal(count, 2);
    f.model.probe = 'usb:changed'; held.resolve(true); await new Promise(setImmediate);
    assert.deepEqual(f.calls, [['confirm'], ['confirm']]);
});

test('empty target state avoids a redundant status row and real identity or mismatch remains visible', () => {
    const f = fixture(); assert.equal(text(f.render()).includes('未识别'), false); assert.deepEqual(f.calls, []);
    f.model.identity = { deviceName: 'STM32F103C8T6', deviceIdHex: '0x410', flashKiB: 64, matches: null };
    const identified = f.render(); assert.ok(text(identified).includes('已识别')); assert.ok(text(identified).includes('0x410'));
    f.model.identity = { ...f.model.identity, matches: '目标为 STM32F407，工程要求 STM32F103' };
    const mismatch = f.render(); assert.ok(text(mismatch).includes(f.model.identity.matches)); assert.equal(text(mismatch).includes('已识别'), false);
    assert.deepEqual(f.calls, [], 'rendering evidence must never perform identification implicitly');
});

test('an identified device with unknown flash capacity never presents null as measured capacity', () => {
    const f = fixture({ identity: { deviceName: 'STM32F103', deviceIdHex: '0x410', flashKiB: null, matches: null } });
    const view = f.render(); assert.ok(text(view).includes('已识别')); assert.ok(text(view).includes('0x410'));
    assert.equal(text(view).includes('null'), false); assert.equal(text(view).includes('undefined'), false);
    assert.deepEqual(f.calls, []);
});

test('compact diagnosis keeps its failure visible and defers detailed checks behind disclosure', () => {
    const calls = [];
    const props = { compact: true, method: 'stlink', failure: { code: 'noTarget', message: '未能连接目标芯片' }, showOutput: () => calls.push('output'), dismiss: () => calls.push('dismiss') };
    const view = expand(NoduDiagnosis(props)); assert.equal(view.props.role, 'alert'); assert.ok(text(view).includes(props.failure.message));
    const folded = nodes(view).find(node => node.type === 'details'); assert.ok(folded); assert.notEqual(folded.props.open, true);
    assert.ok(nodes(folded).find(node => node.type === 'ol'));
    folded.props.onToggle?.({ currentTarget: { open: true } }); assert.deepEqual(calls, []);
    assert.equal(nodes(expand(NoduDiagnosis({ ...props, compact: false }))).some(node => node.type === 'details'), false);
});

test('project settings remain reachable while professional mode retains the full device form', () => {
    const f = fixture(); const compact = f.render(); button(compact, '工程设置').props.onClick();
    assert.deepEqual(f.calls, [['exec', commands.C_COMMANDS.projectSettings]]);
    f.calls.length = 0; f.props.simple = false; const professional = f.render();
    assert.equal(professional.props.className.includes('nodu-c-device-compact'), false);
    assert.ok(nodes(professional).some(node => node.type === 'h2')); assert.equal(radios(professional).length, 2); assert.ok(selector(professional, '下载器'));
    assert.deepEqual(f.calls, []);
});
