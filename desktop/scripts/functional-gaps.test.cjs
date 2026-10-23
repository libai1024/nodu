// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { monitorLog } = require('../scope-extension/lib/common/nodu-monitor-log');
function load(file, extra = {}) {
    class Empty { update() {} }
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    const fallback = new Proxy({}, { get: () => Empty });
    const exports = {}, base = path.dirname(file);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
        exports, TextDecoder, TextEncoder, atob, Date,
        setTimeout: () => 0, clearTimeout() {}, requestAnimationFrame: callback => callback(),
        require: id => extra[id] || (id.startsWith('../common/') ? require(path.resolve(base, id))
            : id === '@theia/core/shared/inversify' ? { inject: () => () => {}, postConstruct: () => () => {}, injectable: () => value => value }
            : id === '@theia/core/lib/common/event' ? { Emitter }
            : id === '@theia/core/shared/react' ? require('react')
            : id === '@theia/core/lib/common/buffer' ? { BinaryBuffer: { fromString: value => value } }
            : fallback),
    });
    return exports;
}
const { NoduEmbeddedModel } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-model'));
const { NoduEmbeddedPanel } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-panel'));
const model = () => { const m = new NoduEmbeddedModel(); m.project = { path: '/test', manifest: { monitor: {} }, flashMethod: 'uart' }; m.clearMarkers = () => { m.cleared = (m.cleared || 0) + 1; }; m.reload = async () => {}; return m; };
test('source edits invalidate diagnostics; generated and unrelated files do not', () => {
    const m = model(); m.lastBuild = { diagnostics: [{ severity: 'error' }] };
    for (const file of ['/else/main.c', '/test/build/debug/x.c', '/test/.nodu/foo.c', '/test/readme.md']) m.sourceChanged(file, true);
    assert.equal(m.diagnosticsStale, false); assert.equal(m.errors.length, 1);
    m.sourceChanged('/test/App/sensor.h', true);
    assert.equal(m.diagnosticsStale, true); assert.equal(m.errors.length, 0); assert.equal(m.cleared, 1);
    assert.equal(m.lastBuild.diagnostics.length, 1);
});
test('unsaved edits during build stay stale; next fresh build replaces diagnostics', async () => {
    const m = model(); let release, markers = 0; m.setDiagnostics = () => { markers++; };
    m.call = () => new Promise(resolve => { release = resolve; });
    const pending = m.build(); m.sourceChanged('/test/Core/Src/main.c', true);
    release({ ok: true, diagnostics: [], artifact: {} });
    assert.equal((await pending).stale, true); assert.equal(m.diagnosticsStale, true); assert.equal(markers, 0);
    m.call = async () => ({ ok: true, diagnostics: [] });
    assert.equal((await m.build()).stale, false); assert.equal(m.diagnosticsStale, false); assert.equal(markers, 1);
});
test('timestamped text and HEX exports preserve partial text and original bytes', () => {
    const at = new Date(2026, 9, 22, 10, 2, 3, 45).getTime();
    const s = { lines: [{ kind: 'system', text: 'connected', at }, { kind: 'data', text: '你好', at }], partial: 'tail', partialAt: at, hex: 'e4 bd a0 e5 a5 bd 0a' };
    assert.equal(monitorLog(s, false, true), 'connected\n[10:02:03.045] 你好\n[10:02:03.045] tail');
    assert.equal(monitorLog(s, true, true), s.hex);
    assert.equal(monitorLog(s, false, false), 'connected\n你好\ntail');
});
test('pause freezes display/export while reception continues; resume and clear work independently', async () => {
    const m = model(); m.panelTab = 'monitor';
    const p = new NoduEmbeddedPanel(); p.model = m;
    const action = label => p.actions().props.children.find(c => c.props['aria-label'] === label).props.onClick();
    m.decode(Buffer.from('first\n').toString('base64'));
    action('暂停显示'); const frozen = monitorLog(p.snapshot(), false, false);
    m.decode(Buffer.from('second\nunfinished').toString('base64'));
    assert.equal(m.monitorLines.length, 2); assert.equal(monitorLog(p.snapshot(), false, false), frozen);
    let copied; p.clipboard = { writeText: text => { copied = text; } }; action('复制输出'); assert.equal(copied, frozen);
    let saved; p.dialogs = { showSaveDialog: async () => '/log' }; p.files = { writeFile: async (uri, text) => { saved = text; } };
    await p.saveLog(); assert.equal(saved, frozen);
    action('继续显示'); assert.match(monitorLog(p.snapshot(), false, false), /second\nunfinished$/);
    action('暂停显示'); action('清空'); assert.equal(monitorLog(p.snapshot(), false, false), ''); assert.equal(m.monitorLines.length, 0);
    m.decode(Buffer.from('new\n').toString('base64')); assert.equal(monitorLog(p.snapshot(), false, false), '');
    action('继续显示'); assert.equal(monitorLog(p.snapshot(), false, false), 'new');
    p.dialogs.showSaveDialog = async () => undefined; saved = undefined; await p.saveLog(); assert.equal(saved, undefined);
    p.dialogs.showSaveDialog = async () => '/log'; p.files.writeFile = async () => { throw Error('read-only'); }; await p.saveLog(); assert.match(m.monitorError, /read-only/);
});
test('compatible-chip UI cancellation prevents download and acceptance passes a one-shot confirmation', async () => {
    const { NoduEmbeddedContribution } = load(require.resolve('../scope-extension/lib/browser/nodu-embedded-contribution'), {
        '@theia/core/lib/common': {}, '@theia/core/lib/browser': {},
    });
    const c = new NoduEmbeddedContribution(); let downloads = 0, confirmed;
    c.model = { isC: true, busy: false, project: { toolkit: { ok: true }, manifest: { target: { vendor: 'compatible' } } },
        run: async value => { downloads++; confirmed = value; return false; } };
    c.ensureTrusted = async () => true; c.saveAll = async () => {};
    c.confirm = async () => false; await c.run(); assert.equal(downloads, 0);
    c.confirm = async () => true; await c.run(); assert.equal(downloads, 1); assert.equal(confirmed, true);
});

test('build log retains completion and an explicit no-monitor choice survives refresh', async () => {
    const m = model(); m.setDiagnostics = () => {};
    m.call = async () => ({ ok: true, diagnostics: [] });
    await m.build(); assert.equal(m.output.at(-1), '编译成功');
    m.call = async () => ({ ok: false, diagnostics: [], errors: 1 });
    await m.build(); assert.match(m.output.at(-1), /编译失败/);
    m.call = async () => [{ path: '/dev/cu.usbserial-test' }];
    m.monitorPortExplicit = true; m.monitorPort = '';
    await m.refreshPorts(); assert.equal(m.monitorPort, '');
});
