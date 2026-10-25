// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = name => fs.readFileSync(path.join(__dirname, '../src/browser', name), 'utf8');
const event = () => {
    const listeners = new Set();
    return { listeners, event: listener => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        fire(value) { for (const listener of [...listeners]) listener(value); } };
};
class Events {
    listeners = new Map();
    addEventListener(name, listener) { if (!this.listeners.has(name)) this.listeners.set(name, new Set()); this.listeners.get(name).add(listener); }
    removeEventListener(name, listener) { this.listeners.get(name)?.delete(listener); }
    dispatch(name, data = {}) { for (const listener of [...this.listeners.get(name) ?? []]) listener(data); }
    count() { return [...this.listeners.values()].reduce((count, group) => count + group.size, 0); }
}
class Element extends Events {
    children = []; style = {}; hidden = false; attributes = {};
    append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
    setAttribute(key, value) { this.attributes[key] = value; }
    getBoundingClientRect() { return this.bounds ?? { width: 170, height: 28 }; }
    querySelector(selector) { return selector === '.xterm-screen' ? this.screen : undefined; }
}
function mount() {
    const document = Object.assign(new Events(), { body: new Element(), createElement: () => new Element() });
    const window = Object.assign(new Events(), { innerWidth: 1000, innerHeight: 800 });
    const observers = [];
    class Collection { items = []; push(...items) { this.items.push(...items); } dispose() { for (const item of this.items.splice(0)) item.dispose(); } }
    const common = { Disposable: { create: dispose => ({ dispose }) }, DisposableCollection: Collection };
    const exports = {}, code = ts.transpileModule(source('nodu-tutor-terminal-selection.ts'), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS
    } }).outputText;
    vm.runInNewContext(code, { exports, document, window, require: id => id.endsWith('/common') ? common : {},
        ResizeObserver: class { constructor(callback) { this.callback = callback; observers.push(this); } observe() {} disconnect() { this.disconnected = true; } } });
    const terminal = id => {
        const selection = event(), scroll = event(), resize = event(), output = event(), open = event(), closed = event();
        const node = new Element(); node.screen = new Element(); node.screen.bounds = { left: 100, right: 900, top: 100, bottom: 580, width: 800, height: 480 };
        const xterm = { rows: 24, cols: 80, buffer: { active: { viewportY: 0 } },
            onSelectionChange: selection.event, onScroll: scroll.event, onResize: resize.event,
            getSelectionPosition: () => state.position };
        const state = { text: 'selected output', position: { start: { x: 2, y: 7 }, end: { x: 4, y: 8 } } };
        const widget = { id, node, isVisible: true, isDisposed: false, getSelection: () => state.text, getTerminal: () => xterm,
            onOutput: output.event, onDidOpen: open.event,
            disposed: { connect: fn => closed.listeners.add(fn), disconnect: fn => closed.listeners.delete(fn) } };
        return { widget, state, xterm, selection, scroll, resize, output, open, closed };
    };
    const first = terminal('first'), changed = event(), active = event(), modelChange = event(), quoted = [];
    const terminals = { currentTerminal: first.widget, onDidChangeCurrentTerminal: changed.event };
    const shell = { activeWidget: first.widget, onDidChangeActiveWidget: active.event };
    const tutor = { enabled: true, workspaceId: 'workspace', onDidChange: modelChange.event };
    const action = new exports.TutorTerminalSelectionAction(terminals, shell, tutor, async id => { quoted.push(id); }, '⌘⌥L');
    return { action, document, window, first, terminal, terminals, shell, tutor, changed, active, modelChange, quoted, observers,
        button: document.body.children[0] };
}

test('terminal selection action follows actual xterm cells, wraps line-end coordinates and hides offscreen selections', () => {
    const c = mount(), { button, first } = c;
    assert.equal(button.hidden, false);
    assert.equal(button.children.map(child => child.textContent).join(' '), '添加到对话 ⌘⌥L');
    assert.equal(button.style.left, '100px'); assert.equal(button.style.top, '226px');
    first.state.position = { start: { x: 0, y: 0 }, end: { x: 0, y: 1 } }; first.selection.fire();
    assert.equal(button.style.left, '730px'); assert.equal(button.style.top, '126px', 'exclusive end column zero anchors the preceding line');
    first.state.position = { start: { x: 0, y: 30 }, end: { x: 10, y: 31 } }; first.selection.fire();
    assert.equal(button.hidden, true);
    first.xterm.buffer.active.viewportY = 25; first.scroll.fire();
    assert.equal(button.hidden, false); assert.equal(button.style.top, '186px');
    first.state.position = { start: { x: 0, y: 0 }, end: { x: 10, y: 100 } }; first.selection.fire();
    assert.equal(button.style.left, '730px'); assert.equal(button.style.top, '526px', 'a long selection anchors its visible final row');
    first.xterm.buffer.active.viewportY = 110; first.scroll.fire(); assert.equal(button.hidden, true);
    c.action.dispose();
});

test('dragging never intercepts terminal input and clicking the action preserves the selection before quoting', () => {
    const c = mount();
    c.first.widget.node.dispatch('pointerdown', { button: 0 }); assert.equal(c.button.hidden, true);
    c.first.selection.fire(); assert.equal(c.button.hidden, true);
    c.document.dispatch('pointerup'); assert.equal(c.button.hidden, false);
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    c.button.dispatch('mousedown', event); assert.equal(event.prevented && event.stopped, true);
    c.button.dispatch('click'); assert.deepEqual(c.quoted, ['first']); assert.equal(c.first.state.text, 'selected output');
    assert.equal(c.first.widget.node.listeners.has('keydown'), false, 'normal terminal keys stay with xterm');
    c.action.dispose();
});

test('focusing the selection button keeps it available for keyboard activation while editor focus hides it', () => {
    const c = mount();
    c.document.activeElement = c.button; c.shell.activeWidget = undefined; c.active.fire();
    assert.equal(c.button.hidden, false, 'the floating action is part of the active terminal selection flow');
    c.button.dispatch('click'); assert.deepEqual(c.quoted, ['first']);
    c.modelChange.fire(); assert.equal(c.button.hidden, false);
    c.document.activeElement = new Element(); c.shell.activeWidget = {}; c.active.fire();
    assert.equal(c.button.hidden, true);
    c.button.dispatch('click'); assert.deepEqual(c.quoted, ['first'], 'an editor focus cannot quote a hidden terminal action');
    c.action.dispose();
});

test('active terminal, empty selection, workspace and visibility changes hide the action; disposal removes every subscription', () => {
    const c = mount();
    c.shell.activeWidget = {}; c.active.fire(); assert.equal(c.button.hidden, true);
    c.shell.activeWidget = c.first.widget; c.active.fire(); assert.equal(c.button.hidden, false);
    c.first.state.text = ''; c.first.selection.fire(); assert.equal(c.button.hidden, true);
    c.first.state.text = 'selected'; c.first.selection.fire(); assert.equal(c.button.hidden, false);
    c.tutor.workspaceId = undefined; c.modelChange.fire(); assert.equal(c.button.hidden, true);
    c.tutor.workspaceId = 'workspace'; c.modelChange.fire(); assert.equal(c.button.hidden, false);
    c.first.widget.isVisible = false; c.observers[0].callback(); assert.equal(c.button.hidden, true);
    const next = c.terminal('second'); c.terminals.currentTerminal = next.widget; c.shell.activeWidget = next.widget; c.changed.fire();
    assert.equal(c.button.hidden, false); assert.equal(c.first.selection.listeners.size, 0); assert.equal(c.first.widget.node.count(), 0);
    c.button.dispatch('click'); assert.deepEqual(c.quoted, ['second']);
    next.widget.isDisposed = true; next.closed.fire(); assert.equal(c.button.hidden, true); assert.equal(next.selection.listeners.size, 0);
    c.action.dispose(); c.action.dispose();
    assert.equal(c.document.body.children.length, 0); assert.equal(c.document.count(), 0); assert.equal(c.window.count(), 0);
    for (const emitter of [c.changed, c.active, c.modelChange, next.closed, next.open, next.output, next.resize, next.scroll]) assert.equal(emitter.listeners.size, 0);
    assert.ok(c.observers.every(observer => observer.disconnected));
    c.button.dispatch('click'); assert.deepEqual(c.quoted, ['second']);
});

function contribution() {
    const text = source('nodu-tutor-hints.ts'), file = ts.createSourceFile('hints.ts', text, ts.ScriptTarget.Latest, true);
    const cls = file.statements.find(node => ts.isClassDeclaration(node) && node.name.text === 'NoduTutorHintsContribution');
    const names = ['selectedTerminal', 'quotingTerminal', 'quoteTerminalSelection', 'registerCommands', 'registerKeybindings', 'registerMenus'];
    const members = cls.members.filter(member => names.includes(member.name?.getText(file))).map(member => member.getText(file)).join('\n');
    const commands = { quoteSelection: 'editor-selection', quoteTerminalSelection: 'terminal-selection', openPanel: 'nodu.tutor.open-panel' };
    const exports = {};
    vm.runInNewContext(ts.transpile(`class Subject { ${members} }; exports.Subject = Subject;`, { target: ts.ScriptTarget.ES2022 }), {
        exports, Error, TUTOR_COMMANDS: commands, TUTOR_MENU: ['nodu-ai-controls'], EditorContextMenu: { COMMANDS: ['editor', 'commands'] },
        TerminalMenus: { TERMINAL_CONTRIBUTIONS: ['terminal-context-menu', '5_terminal_contributions'] }
    });
    const widget = { id: 'term', isDisposed: false, getSelection: () => 'real selected text' }, captured = [], opened = [];
    const tutor = { enabled: true, workspaceId: 'workspace', addTerminalContext: async (...args) => { captured.push(args); return true; }, showHistory: value => opened.push(['history', value]), notify() {} };
    const subject = Object.assign(new exports.Subject(), { tutor, terminals: { currentTerminal: widget, getById: id => id === widget.id ? widget : undefined },
        shell: { activeWidget: widget }, commands: { executeCommand: async command => opened.push(['command', command]) } });
    const handlers = new Map(); subject.registerCommands({ registerCommand: (command, handler) => handlers.set(command.id, handler) });
    return { subject, tutor, widget, captured, opened, handler: handlers.get(commands.quoteTerminalSelection), commands };
}

test('terminal menu and shortcut invoke selection-only capture, open the composer on success and reject a stale terminal', async () => {
    const c = contribution(); assert.equal(c.handler.isEnabled(), true);
    await c.handler.execute(); assert.deepEqual(c.captured, [['term', true]]);
    assert.deepEqual(c.opened, [['history', false], ['command', 'nodu.tutor.open-panel']]);
    c.subject.shell.activeWidget = {}; assert.equal(c.handler.isEnabled(), false); assert.equal(c.handler.isVisible(), false);
    await c.handler.execute(); assert.equal(c.captured.length, 1);
    c.subject.shell.activeWidget = c.widget; c.widget.isDisposed = true; await c.handler.execute(); assert.equal(c.captured.length, 1);
    const keys = [], menus = [];
    c.subject.registerKeybindings({ registerKeybinding: binding => keys.push(binding) });
    c.subject.registerMenus({ registerMenuAction: (path, item) => menus.push({ path, item }) });
    const shortcut = keys.find(binding => binding.command === c.commands.quoteTerminalSelection);
    assert.equal(shortcut.keybinding, 'ctrlcmd+alt+l'); assert.equal(shortcut.when, 'terminalFocus');
    const menu = menus.find(item => item.item.commandId === c.commands.quoteTerminalSelection);
    assert.deepEqual(Array.from(menu.path), ['terminal-context-menu', '5_terminal_contributions']);
});

test('an in-flight terminal capture cannot duplicate attachments or open the composer after a rejected capture', async () => {
    const c = contribution(); let resolve;
    c.tutor.addTerminalContext = () => new Promise(done => { resolve = done; });
    const running = c.handler.execute(); assert.equal(c.handler.isEnabled(), false);
    await c.handler.execute(); resolve(false); await running; assert.deepEqual(c.opened, []);
    c.tutor.addTerminalContext = async () => { throw Error('读取选区失败'); };
    await c.handler.execute(); assert.equal(c.tutor.contextError, '读取选区失败'); assert.deepEqual(c.opened, []);
    assert.equal(c.handler.isEnabled(), true);
});

test('an explicit floating-action terminal ID survives button focus but still rejects changed or cleared terminals', async () => {
    const c = contribution(); c.subject.shell.activeWidget = undefined;
    assert.equal(c.handler.isEnabled(), false, 'menu and shortcut still require terminal focus');
    await c.subject.quoteTerminalSelection('term');
    assert.deepEqual(c.captured, [['term', true]]);
    c.subject.terminals.currentTerminal = { id: 'other' };
    await c.subject.quoteTerminalSelection('term'); assert.equal(c.captured.length, 1);
    c.subject.terminals.currentTerminal = c.widget; c.widget.getSelection = () => '';
    await c.subject.quoteTerminalSelection('term'); assert.equal(c.captured.length, 1);
    c.widget.getSelection = () => 'selected'; c.widget.isDisposed = true;
    await c.subject.quoteTerminalSelection('term'); assert.equal(c.captured.length, 1);
});
