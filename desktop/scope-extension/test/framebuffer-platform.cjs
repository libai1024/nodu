// SPDX-License-Identifier: MIT
// Product methods with inert services: no device connection, screenshot or Electron process.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const source = ts.createSourceFile('scope-widgets.tsx', fs.readFileSync(path.join(__dirname, '../src/browser/scope-widgets.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const React = { createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat() }; } };
function productionClass(name, names, dependencies = {}, Base = class {}) {
    const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === name);
    const selected = cls.members.filter(member => names.includes(member.name?.getText(source)));
    for (const n of names) assert.ok(selected.some(member => member.name?.getText(source) === n), `production member ${n}`);
    const js = ts.transpile(`class ${name} extends Base {${selected.map(member => member.getText(source)).join('\n')}}`, { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }, 'fixture.tsx');
    return new Function('Base', 'React', 'postConstruct', ...Object.keys(dependencies), `${js}; return ${name};`)(Base, React, () => () => {}, ...Object.values(dependencies));
}
function emitter() {
    const listeners = new Set();
    return { event(fn) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; }, fire() { for (const fn of listeners) fn(); }, dispose() { listeners.clear(); } };
}
function fixture(platform = 'k210') {
    const embeddedChanged = emitter(), deviceChanged = emitter(), sessionChanged = emitter(), layoutChanged = emitter(), calls = [];
    const Widget = productionClass('ScopeVisionWidget', ['CAMERA_OPS', 'source', 'exporting', 'imageSourceEpoch', 'lastSourceAvailable', 'toolbarKey',
        'init', 'deviceSourceAvailable', 'render', 'renderDevicePreview', 'refresh', 'showLocalDemo', 'toggleDemo', 'syncClock', 'stopClock', 'exportFrame', 'exportBusy'], {
        NoduImageTools: 'ImageTools', clockText: () => '0:00', sizeText: () => '1 KB',
        BinaryBuffer: { wrap: x => x }, atob: x => Buffer.from(x, 'base64').toString('binary'), pngBytes: async () => Uint8Array.of(1),
        performance: { now: () => 1 }, window: { setInterval() { return 1; }, clearInterval() {} },
    });
    const widget = new Widget();
    widget.title = {}; widget.node = { classList: { toggle() {} } }; widget.addClass = () => {}; widget.update = () => { calls.push('update'); };
    const disposables = []; widget.toDispose = { push(...items) { disposables.push(...items); } };
    widget.embedded = { isC: platform === 'stm32', isEsp: platform === 'esp', onDidChange: embeddedChanged.event };
    widget.device = { connected: true, busy: false, frame: { data: 'AQ==', sequence: 7 },
        state: { running: false, preview: true, capabilities: { framebuffer: true, script: true } },
        onDidChange: deviceChanged.event, note: text => calls.push(['note', text]), startCamera: () => calls.push('camera'), setPreview: value => calls.push(['preview', value]),
    };
    widget.session = { onDidChange: sessionChanged.event };
    widget.layoutState = { mode: 'pro', onDidChange: layoutChanged.event };
    widget.toolbarChanged = emitter(); widget.imageTools = { fit: true };
    widget.workspace = { tryGetRoots: () => [] };
    widget.dialogs = { showSaveDialog: async () => { calls.push('dialog'); return { path: { base: 'frame.jpg', fsPath: () => '/temporary/frame.jpg' } }; } };
    widget.files = { writeFile: async () => { calls.push('write'); } }; widget.messages = { error: text => calls.push(['error', text]) };
    widget.commands = { executeCommand: id => calls.push(['command', id]) }; widget.renderDemo = () => ({ demo: true });
    widget.init();
    return { widget, embeddedChanged, calls, disposables };
}
function contents(node) { return JSON.stringify(node); }

test('STM32 and ESP retain a read-only view without old K210 image or device actions', async () => {
    for (const platform of ['stm32', 'esp']) {
        const { widget, calls } = fixture(platform);
        widget.source = 'demo';
        const rendered = contents(widget.render());
        assert.ok(rendered.includes('当前工程暂无图像来源'));
        for (const hidden of ['ImageTools', 'button', '未连接设备', '启动相机', 'demo']) assert.equal(rendered.includes(hidden), false);
        widget.showLocalDemo(); widget.toggleDemo(); await widget.exportFrame();
        assert.equal(calls.includes('dialog'), false); assert.equal(calls.includes('write'), false);
    }
});

test('project changes refresh visible content and toolbar, then K210 keeps existing image behavior', () => {
    const { widget, embeddedChanged } = fixture();
    let toolbarChanges = 0; widget.toolbarChanged.event(() => toolbarChanges++);
    assert.ok(contents(widget.render()).includes('ImageTools'));
    widget.source = 'demo'; widget.embedded.isC = true; embeddedChanged.fire();
    assert.equal(widget.source, 'device'); assert.ok(contents(widget.render()).includes('当前工程暂无图像来源'));
    widget.embedded.isC = false; embeddedChanged.fire();
    assert.ok(contents(widget.render()).includes('ImageTools')); assert.equal(toolbarChanges, 2);
    widget.device.connected = false; widget.device.frame = undefined;
    assert.ok(contents(widget.render()).includes('连接设备'));
});

test('K210 frame export remains available, but switching platform while the save dialog is open cancels the export', async () => {
    const ready = fixture(); await ready.widget.exportFrame(); assert.equal(ready.calls.filter(x => x === 'write').length, 1);
    const f = fixture(); let answer;
    f.widget.dialogs.showSaveDialog = () => new Promise(resolve => { answer = resolve; });
    const exporting = f.widget.exportFrame();
    f.widget.embedded.isEsp = true; f.embeddedChanged.fire();
    // Returning to K210 does not make the old save dialog current again.
    f.widget.embedded.isEsp = false; f.embeddedChanged.fire();
    answer({ path: { base: 'frame.jpg', fsPath: () => '/temporary/frame.jpg' } }); await exporting;
    assert.equal(f.calls.includes('write'), false); assert.equal(f.widget.exportBusy, false);
});

function toolbarFixture(f) {
    const Toolbar = productionClass('ScopeVisionToolbarContribution', ['registerCommands', 'renderActions'], { ScopeVisionWidget: { ID: 'scope:vision' } });
    const toolbar = new Toolbar(), handlers = new Map();
    toolbar.device = f.widget.device; toolbar.embedded = f.widget.embedded; toolbar.layoutState = f.widget.layoutState;
    toolbar.widgets = { tryGetWidget: () => f.widget }; toolbar.commands = f.widget.commands;
    toolbar.registerCommands({ registerCommand(command, handler) { handlers.set(command.id, handler); } });
    return { toolbar, handlers };
}

test('unsupported platforms disable framebuffer commands and suppress the complete camera toolbar', async () => {
    for (const platform of ['stm32', 'esp']) {
        const f = fixture(platform), { toolbar, handlers } = toolbarFixture(f);
        f.widget.toggleFit = () => f.calls.push('fit');
        assert.equal(toolbar.renderActions(f.widget), null);
        for (const handler of handlers.values()) { assert.equal(handler.isEnabled(), false); await handler.execute(); }
        assert.equal(f.calls.some(x => x === 'dialog' || x === 'fit' || Array.isArray(x) && x[0] === 'preview'), false);
    }
    const f = fixture(), { toolbar, handlers } = toolbarFixture(f);
    assert.ok(contents(toolbar.renderActions(f.widget)).includes('帧缓冲操作'));
    assert.equal(handlers.get('scope.framebuffer.toggle-preview').isEnabled(), true);
    assert.equal(handlers.get('scope.framebuffer.snapshot').isEnabled(), true);
    await handlers.get('scope.framebuffer.toggle-preview').execute();
    assert.deepEqual(f.calls.at(-1), ['preview', false]);
});
