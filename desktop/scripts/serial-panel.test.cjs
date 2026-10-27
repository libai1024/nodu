// SPDX-License-Identifier: MIT
// Production panel event handlers; no real port, device service, or browser is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const React = require('react');
const walk = root => {
    const nodes = [];
    const visit = item => {
        if (Array.isArray(item)) item.forEach(visit);
        else if (item && typeof item === 'object') { nodes.push(item); visit(item.props?.children); }
    };
    visit(root); return nodes;
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
function harness() {
    const exports = {}, calls = [];
    class Empty { update() {} }
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    const NoduSelect = () => null;
    const stub = new Proxy({ Emitter, ReactWidget: Empty }, { get: (object, name) => object[name] || Empty });
    const source = fs.readFileSync(path.join(__dirname, '../scope-extension/src/browser/nodu-embedded-panel.tsx'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.React, experimentalDecorators: true } }).outputText;
    vm.runInNewContext(code, { exports, Date, Error, requestAnimationFrame: callback => callback(),
        require: name => name === '@theia/core/shared/react' ? React
            : name === '@theia/core/shared/inversify' ? { injectable: () => value => value, inject: () => () => {}, postConstruct: () => () => {} }
            : name === './nodu-select' ? { NoduSelect }
            : name === '../common/nodu-monitor-log' ? require('../scope-extension/lib/common/nodu-monitor-log') : stub });
    const panel = new exports.NoduEmbeddedPanel();
    const model = panel.model = { project: { path: '/test', manifest: { monitor: { baud: 115200, encoding: 'utf-8' } } },
        monitor: { state: 'open', open: true, port: '/dev/cu.test' }, monitorPort: '/dev/cu.test', ports: [{ path: '/dev/cu.test' }],
        panelTab: 'monitor', monitorBusy: false, flashing: false, monitorLines: [], monitorPartial: '', monitorBytes: { hex: () => '' },
        get monitorConfig() { return this.project.manifest.monitor; },
        get monitorLocked() { return this.monitorBusy || this.flashing || !!this.awaitUser || !!this.arduinoBusy; },
        get monitorSettingsLocked() { return this.monitorLocked || !!this.building; },
        sendMonitor: async text => { calls.push(text); return true; }, setMonitorPort() {}, setOption() {}, toggleMonitor() {} };
    const nodes = () => walk(panel.monitor());
    const input = () => nodes().find(node => node.type === 'input' && node.props['aria-label'] === '发送到串口');
    const ending = () => nodes().find(node => node.type === NoduSelect && /行尾/.test(node.props['aria-label']));
    const send = () => nodes().find(node => node.type === 'button' && node.props.children === '发送');
    const draft = text => input().props.onChange({ currentTarget: { value: text } });
    return { panel, model, calls, nodes, input, ending, send, draft, NoduSelect };
}

test('serial controls use the custom selector and expose exact line endings', () => {
    const h = harness(), nodes = h.nodes();
    assert.equal(nodes.some(node => node.type === 'select'), false);
    const selectors = nodes.filter(node => node.type === h.NoduSelect);
    assert.equal(selectors.length, 4);
    assert.deepEqual(Array.from(h.ending().props.options, option => [option.value, option.label]),
        [['crlf', '\\r\\n'], ['lf', '\\n'], ['cr', '\\r'], ['none', '无']]);
    assert.equal(h.ending().props.value, 'crlf');
});

test('each line ending adds exactly its selected wire suffix', async () => {
    for (const [ending, suffix] of Object.entries({ crlf: '\r\n', lf: '\n', cr: '\r', none: '' })) {
        const h = harness(); h.ending().props.onChange(ending); h.draft('hello');
        await h.send().props.onClick(); await tick();
        assert.deepEqual(h.calls, ['hello' + suffix]);
        assert.equal(h.input().props.value, '');
    }
});

test('a pending send cannot be duplicated and only clears the draft it actually sent', async () => {
    const h = harness(), pending = deferred();
    h.model.sendMonitor = text => { h.calls.push(text); return pending.promise; };
    h.draft('first'); const send = h.send(); send.props.onClick(); send.props.onClick();
    assert.deepEqual(h.calls, ['first\r\n']);
    assert.equal(h.send().props.disabled, true); assert.equal(h.input().props.disabled, true);
    h.draft('newer draft'); pending.resolve(true); await tick();
    assert.equal(h.input().props.value, 'newer draft'); assert.equal(h.send().props.disabled, false);
});

test('refused sends preserve the draft and empty or unavailable ports do not send', async () => {
    const h = harness(); h.model.sendMonitor = async text => { h.calls.push(text); return false; };
    h.draft('retry me'); h.send().props.onClick(); await tick();
    assert.equal(h.input().props.value, 'retry me'); assert.equal(h.send().props.disabled, false);
    for (const change of [m => { m.monitor.state = 'closed'; }, m => { m.monitor.open = false; }, m => { m.monitorBusy = true; }, m => { m.flashing = true; }, m => { m.awaitUser = 'enterBoot'; }, m => { m.awaitUser = 'exitBoot'; }, m => { m.arduinoBusy = true; }]) {
        const next = harness(); next.draft('no send'); change(next.model); assert.equal(next.send().props.disabled, true);
        next.send().props.onClick(); await tick(); assert.deepEqual(next.calls, []);
    }
    const empty = harness(); assert.equal(empty.send().props.disabled, true); empty.send().props.onClick(); await tick(); assert.deepEqual(empty.calls, []);
});

test('IME confirmation keeps the draft while Enter sends exactly once', async () => {
    const h = harness(); h.draft('状态'); let prevented = 0;
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: true }, preventDefault() { prevented++; } });
    h.input().props.onKeyDown({ key: 'Enter', keyCode: 229, nativeEvent: { isComposing: false }, preventDefault() { prevented++; } });
    await tick(); assert.deepEqual(h.calls, []); assert.equal(prevented, 0); assert.equal(h.input().props.value, '状态');
    h.input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() { prevented++; } });
    await tick(); assert.deepEqual(h.calls, ['状态\r\n']); assert.equal(prevented, 1);
});

test('unexpected send rejection releases the input and presents the error without clearing text', async () => {
    const h = harness(); h.draft('retry after failure');
    h.model.sendMonitor = async () => { throw new Error('transport failed'); };
    h.send().props.onClick(); await tick();
    assert.equal(h.model.monitorError, 'transport failed'); assert.equal(h.input().props.value, 'retry after failure');
    assert.equal(h.input().props.disabled, false); assert.equal(h.send().props.disabled, false);
    assert.ok(h.nodes().some(node => node.props?.role === 'alert' && node.props.children === 'transport failed'));
});


test('compiling locks serial configuration while an already-open monitor can still send', async () => {
    const h = harness(); h.model.building = true; h.draft('status');
    for (const label of ['串口', '波特率', '编码']) {
        assert.equal(h.nodes().find(n => n.type === h.NoduSelect && n.props['aria-label'] === label).props.disabled, true);
    }
    assert.equal(h.send().props.disabled, false); await h.send().props.onClick(); assert.deepEqual(h.calls, ['status\r\n']);
});
