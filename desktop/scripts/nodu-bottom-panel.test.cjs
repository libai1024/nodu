// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

// Exercise the actual dock contribution, bottom owner and shell session methods.
// The host below supplies only framework widgets, events and command registries.
class Signal {
    listeners = new Set();
    connect = listener => this.listeners.add(listener);
    disconnect = listener => this.listeners.delete(listener);
    emit = value => { for (const listener of [...this.listeners]) { listener(value); } };
}
class Emitter {
    listeners = new Set();
    event = listener => { this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; };
    fire = value => { for (const listener of [...this.listeners]) { listener(value); } };
    dispose() { this.listeners.clear(); }
}
class Disposables {
    values = [];
    push(value) { this.values.push(value); }
    dispose() { for (const value of this.values.splice(0)) { value.dispose(); } }
}
class Host {
    isDisposed = false;
    isVisible = true;
    node = { dataset: {}, setAttribute() {}, querySelector() {}, addEventListener() {}, removeEventListener() {} };
    title = { owner: this, label: '', changed: new Signal() };
    disposed = new Signal();
    toDispose = new Disposables();
    activations = 0;
    constructor(id = '') { this.id = id; }
    hide() { this.isVisible = false; }
    show() { this.isVisible = true; }
    setHidden(hidden) { this.isVisible = !hidden; }
    addClass() {}
    update() {}
    fit() {}
    activate() { this.activations++; }
    dispose() {
        this.isDisposed = true;
        if (this.parent) { this.parent.widgets = this.parent.widgets.filter(widget => widget !== this); }
        this.disposed.emit();
    }
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
    starts = 0;
    closes = 0;
    constructor(id, location = 1) { super(id); this.location = location; }
    start() { this.starts++; }
    close() { this.closes++; }
    onDidDispose(listener) { this.disposed.connect(listener); return { dispose: () => this.disposed.disconnect(listener) }; }
}
class Registry {
    commands = new Map();
    registerCommand(command, handler) {
        assert.equal(this.commands.has(command.id), false, `duplicate command: ${command.id}`);
        this.commands.set(command.id, { command, handler });
        return { dispose: () => this.commands.delete(command.id) };
    }
    registerHandler(id, handler) {
        this.commands.set(id, { command: { id }, handler });
        return { dispose: () => this.commands.delete(id) };
    }
    executeCommand(id, ...args) { return this.commands.get(id).handler.execute(...args); }
}
const decorator = () => () => {};
const token = class {};
const modules = {};
function load(name) {
    const source = path.resolve(__dirname, `../scope-extension/src/browser/${name}.tsx`);
    const compiled = new Module(source, module);
    compiled.filename = source;
    compiled.require = id => {
        if (modules[id]) { return modules[id]; }
        if (id.endsWith('.css')) { return {}; }
        if (id === '@theia/core/shared/react') { return {}; }
        if (id === '@theia/core/shared/inversify') { return { inject: decorator, injectable: decorator, postConstruct: () => {} }; }
        if (id === '@theia/core/lib/browser') { return { BaseWidget: Host, ReactWidget: Host, SplitPanel: Panel, StackedPanel: Panel }; }
        if (id === '@theia/core/lib/common') { return { DisposableCollection: Disposables, Emitter, URI: token }; }
        if (id === '@theia/terminal/lib/browser/base/terminal-widget') { return { TerminalWidget: Terminal, TerminalLocation: { Panel: 1, Editor: 2 } }; }
        return new Proxy({}, { get: () => token });
    };
    compiled._compile(transformSync(fs.readFileSync(source, 'utf8'), {
        loader: 'tsx', format: 'cjs', target: 'node24', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } },
    }).code, source);
    return compiled.exports;
}
modules['./nodu-shell-panel'] = load('nodu-shell-panel');
const { NoduShellPanelWidget } = modules['./nodu-shell-panel'];
const { NoduBottomPanelWidget, NoduBottomPanelContribution } = load('nodu-bottom-panel');
global.requestAnimationFrame = callback => { callback(); return 1; };
const storage = new Map();
Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, String(value)) },
});

function setup(existing = []) {
    const bottom = new Panel();
    const main = new Panel();
    const added = new Emitter();
    const terminals = new Map(existing.filter(widget => widget instanceof Terminal).map(widget => [widget.id, widget]));
    const owner = new NoduBottomPanelWidget();
    owner.id = NoduBottomPanelWidget.ID;
    owner.header = new Host();
    owner.console = Object.assign(new Host('console'), { setView(view) { this.view = view; } });
    owner.embeddedPanel = Object.assign(new Host('embedded'), { setView(view) { this.view = view; } });
    owner.problemsPanel = Object.assign(new Host('nodu:problems-panel'), { counts: { errors: 0, warnings: 0, infos: 0, total: 0 } });
    owner.embedded = { isC: false, errors: [], monitor: {} };
    owner.device = { state: {} };
    const terminalPanel = owner.terminalPanel = new NoduShellPanelWidget();
    terminalPanel.id = 'nodu:shell-panel';
    terminalPanel.stack = new Panel();
    terminalPanel.empty = new Host();
    terminalPanel.workspaceUri = 'file:///project';
    terminalPanel.workspaceName = 'project';
    terminalPanel.terminals = { getById: id => terminals.get(id), newTerminal: () => { throw new Error('must not create a PTY'); } };
    terminalPanel.refresh = () => {};
    terminalPanel.fitVisibleTerminals = () => {};
    for (const widget of [owner.console, owner.embeddedPanel, terminalPanel, owner.problemsPanel]) { owner.stack.addWidget(widget); }
    bottom.addWidget(owner);
    for (const widget of existing) { bottom.addWidget(widget); }
    const bar = {
        currentTitle: owner.title, classes: new Set(),
        hasClass(name) { return this.classes.has(name); },
        toggleClass(name, enabled) { enabled ? this.classes.add(name) : this.classes.delete(name); }, fit() {},
    };
    const shell = owner.shell = {
        bottomPanel: bottom, bottomAreaTabBars: [bar], activated: [], revealed: [],
        getWidgets: area => [...(area === 'bottom' ? bottom.widgets : main.widgets)],
        getAreaFor(widget) {
            for (let parent = widget; parent; parent = parent.parent) {
                if (parent === bottom) { return 'bottom'; }
                if (parent === main) { return 'main'; }
            }
        },
        async addWidget(widget, { area }) {
            if (widget instanceof Terminal) { terminals.set(widget.id, widget); }
            (area === 'bottom' ? bottom : main).addWidget(widget);
            added.fire(widget);
        },
        onDidAddWidget: added.event,
        async revealWidget(id) { this.revealed.push(id); return id === owner.id ? owner : owner.revealWidget(id); },
        async activateWidget(id) {
            this.activated.push(id);
            const direct = bottom.widgets.find(widget => widget.id === id);
            if (direct) { bar.currentTitle = direct.title; direct.activate(); owner.syncDockTabs(); return direct; }
            return owner.activateWidget(id);
        },
    };
    const registry = owner.commandRegistry = new Registry();
    const actions = new Set();
    owner.menuRegistry = {
        registerSubmenu: () => ({ dispose() {} }),
        registerMenuAction: (menuPath, item) => { const action = { menuPath, ...item }; actions.add(action); return { dispose: () => actions.delete(action) }; },
    };
    owner.menus = { render() {} };
    const contribution = new NoduBottomPanelContribution();
    contribution.shell = shell;
    contribution.widgets = { getOrCreateWidget: async () => owner, tryGetWidget: () => owner };
    const calls = [];
    const adopt = owner.adoptTerminal.bind(owner);
    owner.adoptTerminal = (...args) => { calls.push(args); return adopt(...args); };
    return { owner, terminalPanel, contribution, bottom, shell, added, bar, registry, actions, calls };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('restored split chains migrate parent-first without changing the active page or any PTY lifecycle', async () => {
    const parent = new Terminal('parent');
    const child = new Terminal('child', { parentTerminal: parent.id });
    const grandchild = new Terminal('grandchild', { parentTerminal: child.id });
    const app = setup([grandchild, child, parent]);
    await app.owner.selectPage('repl', false);
    await app.contribution.onDidInitializeLayout();
    assert.deepEqual(app.calls.map(([terminal]) => terminal.id), ['parent', 'child', 'grandchild']);
    assert.ok(app.calls.every(([, , reveal]) => reveal === false));
    assert.equal(app.owner.activePage, 'repl');
    assert.equal(app.terminalPanel.sessions.length, 1);
    assert.deepEqual(app.terminalPanel.sessions[0].terminals, [parent, child, grandchild]);
    assert.deepEqual(app.bottom.widgets, [app.owner]);
    for (const terminal of [parent, child, grandchild]) {
        assert.deepEqual([terminal.starts, terminal.closes, terminal.activations], [0, 0, 0]);
    }
    assert.deepEqual(app.shell.activated, []);
    assert.deepEqual(app.shell.revealed, []);
});

test('later bottom additions are adopted once while editor terminals and repeated events remain untouched', async () => {
    const app = setup();
    await app.contribution.onDidInitializeLayout();
    const terminal = new Terminal('late');
    await app.shell.addWidget(terminal, { area: 'bottom' });
    await flush();
    app.added.fire(terminal);
    app.added.fire(terminal);
    const editor = new Terminal('editor', 2);
    await app.shell.addWidget(editor, { area: 'main' });
    await flush();
    assert.equal(app.calls.length, 1);
    assert.deepEqual(app.terminalPanel.getTrackableWidgets(), [terminal]);
    assert.equal(app.shell.getAreaFor(editor), 'main');
    assert.equal(app.owner.activePage, 'output');
    app.contribution.onStop();
    const stopped = new Terminal('after-stop');
    await app.shell.addWidget(stopped, { area: 'bottom' });
    await flush();
    assert.equal(app.calls.length, 1);
});

test('a terminal added during initial migration is not left behind in the outer dock', async () => {
    const first = new Terminal('first');
    const late = new Terminal('during-migration');
    const app = setup([first]);
    const adopt = app.owner.adoptTerminal.bind(app.owner);
    app.owner.adoptTerminal = async (...args) => {
        if (args[0] === first) { await app.shell.addWidget(late, { area: 'bottom' }); }
        return adopt(...args);
    };
    await app.contribution.onDidInitializeLayout();
    await flush();
    assert.deepEqual(new Set(app.terminalPanel.getTrackableWidgets()), new Set([first, late]));
    assert.deepEqual(app.bottom.widgets, [app.owner]);
});

test('framework Problems aliases stay hidden and reveal or activate the single unified Problems page', async () => {
    const alias = new Host('problems');
    const app = setup([alias]);
    await app.contribution.onDidInitializeLayout();
    assert.equal(app.owner.activePage, 'output');
    assert.equal(alias.isVisible, false);
    assert.ok(app.owner.getTrackableWidgets().includes(alias));
    assert.equal(app.bottom.widgets.includes(alias), false);
    assert.equal(app.owner.revealWidget(alias.id), app.owner.problemsPanel);
    assert.equal(app.owner.activePage, 'problems');
    assert.equal(alias.isVisible, false);
    assert.equal(app.owner.problemsPanel.isVisible, true);
    app.owner.activateWidget(alias.id);
    assert.equal(app.owner.problemsPanel.activations, 1);
    assert.equal(alias.activations, 0);
    app.owner.adoptProblemsAlias(alias);
    assert.equal(app.owner.stack.widgets.filter(widget => widget === alias).length, 1);
    alias.dispose();
    assert.equal(app.owner.getTrackableWidgets().includes(alias), false);
});

test('the framework Problems command routes to the same unified page', async () => {
    const app = setup();
    app.contribution.registerCommands(app.registry);
    await app.registry.executeCommand('problemsView:toggle');
    assert.equal(app.owner.activePage, 'problems');
    assert.equal(app.owner.problemsPanel.activations, 1);
    assert.equal(app.owner.embeddedPanel.view, undefined);
    assert.deepEqual(app.shell.activated, ['nodu:problems-panel']);
});

test('ordinary auxiliary views retain their dock and remain accessible from More without stale commands', async () => {
    const auxiliary = new Host('output-view');
    auxiliary.title.label = '扩展输出';
    const app = setup([auxiliary]);
    await app.contribution.onDidInitializeLayout();
    assert.equal(auxiliary.parent, app.bottom);
    assert.equal(app.owner.getTrackableWidgets().includes(auxiliary), false);
    app.owner.syncDockTabs();
    assert.equal(app.bar.hasClass('nodu-bottom-owner-tabs'), true);
    const anchor = { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) };
    app.owner.openMenu(anchor);
    const entry = [...app.actions].find(action => action.commandId === 'nodu.panel.reveal.output-view');
    assert.ok(entry);
    await app.registry.executeCommand(entry.commandId);
    assert.equal(auxiliary.activations, 1);
    assert.equal(auxiliary.parent, app.bottom);
    assert.equal(app.bar.hasClass('nodu-bottom-owner-tabs'), false);
    app.owner.openMenu(anchor);
    assert.equal(app.actions.size, 1);
    auxiliary.dispose();
    app.owner.openMenu(anchor);
    assert.equal(app.actions.size, 0);
    assert.equal(app.registry.commands.has(entry.commandId), false);
});
