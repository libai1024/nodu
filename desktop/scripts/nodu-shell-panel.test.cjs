// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

// Run the actual session/lifecycle methods with only the Lumino DOM host stubbed.
// No terminal backend, browser or OS process is started by these tests.
class Host {
    isDisposed = false;
    isVisible = true;
    node = { addEventListener() {}, removeEventListener() {} };
    title = { changed: { connect() {}, disconnect() {} } };
    toDispose = { push() {} };
    hide() { this.isVisible = false; }
    show() { this.isVisible = true; }
    setHidden(hidden) { this.isVisible = !hidden; }
    addClass() {}
    update() {}
    dispose() { this.isDisposed = true; }
}
class Panel extends Host {
    widgets = [];
    addWidget(widget) {
        if (widget.parent) { widget.parent.widgets = widget.parent.widgets.filter(item => item !== widget); }
        widget.parent = this;
        this.widgets.push(widget);
    }
}
class Terminal extends Host {
    counts = { start: 0, close: 0, activate: 0, search: 0 };
    listeners = [];
    constructor(id, location = 1) { super(); this.id = id; this.location = location; }
    async start() { this.counts.start++; return 1; }
    close() { this.counts.close++; }
    activate() { this.counts.activate++; }
    getSearchBox() { return { show: () => this.counts.search++ }; }
    onDidDispose(listener) { this.listeners.push(listener); return { dispose() {} }; }
    dispose() {
        super.dispose();
        if (this.parent) { this.parent.widgets = this.parent.widgets.filter(item => item !== this); }
        for (const listener of this.listeners) { listener(); }
    }
}
class Disposables {
    values = [];
    push(value) { this.values.push(value); }
    dispose() { for (const value of this.values) { value.dispose(); } this.values = []; }
}
class Emitter { event = () => ({ dispose() {} }); fire() {} }
const decorator = () => () => {};
const token = class {};
const source = path.resolve(__dirname, '../scope-extension/src/browser/nodu-shell-panel.tsx');
const compiled = new Module(source, module);
compiled.filename = source;
compiled.require = id => {
    if (id.endsWith('.css') || id === './nodu-select') { return {}; }
    if (id === '@theia/core/shared/react') { return {}; }
    if (id === '@theia/core/shared/inversify') { return { inject: decorator, injectable: decorator, postConstruct: () => {} }; }
    if (id === '@theia/core/lib/browser') { return { BaseWidget: Host, ReactWidget: Host, SplitPanel: Panel, StackedPanel: Panel }; }
    if (id === '@theia/core/lib/common') { return { DisposableCollection: Disposables, Emitter, URI: token }; }
    if (id === '@theia/terminal/lib/browser/base/terminal-widget') { return { TerminalWidget: Terminal }; }
    return new Proxy({}, { get: () => token });
};
compiled._compile(transformSync(fs.readFileSync(source, 'utf8'), {
    loader: 'tsx', format: 'cjs', target: 'node24', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
}).code, source);
const { NoduShellPanelWidget } = compiled.exports;

function makePanel() {
    const widget = new NoduShellPanelWidget();
    const terminals = new Map();
    widget.stack = new Panel();
    widget.empty = new Host();
    widget.workspaceUri = 'file:///alpha';
    widget.workspaceName = 'alpha';
    widget.workspace = { roots: Promise.resolve([{ resource: { toString: () => 'file:///alpha', path: { base: 'alpha' } } }]) };
    widget.terminals = { getById: id => terminals.get(id), newTerminal: () => { throw new Error('Adoption must reuse a live terminal'); } };
    widget.refresh = () => {};
    widget.fitVisibleTerminals = () => {};
    return { widget, terminals };
}

test('silent adoption reparents a live terminal once and never starts, closes or focuses its PTY', async () => {
    const { widget } = makePanel();
    const dock = new Panel();
    const terminal = new Terminal('existing');
    dock.addWidget(terminal);
    widget.adopt(terminal, undefined, false);
    widget.adopt(terminal, undefined, false);
    await widget.ensureSession();
    assert.deepEqual(widget.getTrackableWidgets(), [terminal]);
    assert.equal(dock.widgets.length, 0);
    assert.equal(widget.sessions.length, 1);
    assert.equal(widget.selected.active, terminal);
    assert.deepEqual(terminal.counts, { start: 0, close: 0, activate: 0, search: 0 });
});

test('silent background adoption preserves the selected session and its active split', () => {
    const { widget } = makePanel();
    const first = new Terminal('first');
    const second = new Terminal('second');
    widget.adopt(first, undefined, false);
    const selected = widget.selected;
    widget.adopt(second, undefined, false);
    assert.equal(widget.selected, selected);
    assert.equal(widget.selected.active, first);
    assert.equal(widget.sessions.find(session => session.active === second).panel.isVisible, false);
    assert.equal(second.counts.activate, 0);
});

test('a silent split retains its parent session and workspace after the active workspace changes', () => {
    const { widget, terminals } = makePanel();
    const parent = new Terminal('parent');
    terminals.set(parent.id, parent);
    widget.adopt(parent, undefined, false);
    const session = widget.selected;
    widget.workspaceUri = 'file:///beta';
    widget.workspaceName = 'beta';
    const child = new Terminal('child', { parentTerminal: parent.id });
    widget.adopt(child, undefined, false);
    assert.equal(widget.sessions.length, 1);
    assert.deepEqual(session.terminals, [parent, child]);
    assert.equal(session.workspaceUri, 'file:///alpha');
    assert.equal(session.workspace, 'alpha');
    assert.equal(session.active, parent);
    widget.adopt(child, undefined, false);
    assert.equal(session.terminals.length, 2);
    assert.equal(child.counts.activate, 0);
});

test('explicit split options join the same group and normal adoption retains activation semantics', () => {
    const { widget } = makePanel();
    const parent = new Terminal('parent');
    const child = new Terminal('child');
    widget.adopt(parent, undefined, false);
    widget.adopt(child, { mode: 'reveal', widgetOptions: { ref: parent, mode: 'split-right' } });
    assert.equal(widget.sessions.length, 1);
    assert.equal(widget.selected.active, child);
    assert.equal(child.counts.activate, 0);
    widget.adopt(child);
    assert.equal(child.counts.activate, 1);
    assert.equal(child.counts.start, 0);
});

test('disposing one adopted split preserves the sibling and disposing the last clears the session', () => {
    const { widget } = makePanel();
    const parent = new Terminal('parent');
    const child = new Terminal('child');
    widget.adopt(parent, undefined, false);
    widget.adopt(child, { mode: 'reveal', widgetOptions: { ref: parent, mode: 'split-right' } });
    const session = widget.selected;
    child.dispose();
    assert.deepEqual(widget.getTrackableWidgets(), [parent]);
    assert.equal(session.active, parent);
    assert.equal(session.panel.isDisposed, false);
    assert.equal(parent.counts.close, 0);
    parent.dispose();
    assert.equal(widget.selected, undefined);
    assert.equal(widget.sessions.length, 0);
    assert.equal(session.panel.isDisposed, true);
    assert.equal(widget.empty.isVisible, true);
});

test('a menu command keeps its captured terminal target after another session becomes active', () => {
    const { widget } = makePanel();
    const handlers = new Map();
    widget.commands = { registerCommand: (command, handler) => { handlers.set(command.id, handler); return { dispose() {} }; } };
    widget.menuRegistry = { registerMenuAction: () => ({ dispose() {} }) };
    widget.registerMenu();
    const first = new Terminal('first');
    const second = new Terminal('second');
    widget.adopt(first, undefined, false);
    widget.adopt(second, undefined, false);
    widget.revealWidget(second.id);
    handlers.get('nodu.shell.find').execute(first.id);
    assert.equal(first.counts.search, 1);
    assert.equal(second.counts.search, 0);
    first.dispose();
    assert.equal(handlers.get('nodu.shell.find').isEnabled(first.id), false);
});
