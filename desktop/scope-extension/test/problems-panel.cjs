// SPDX-License-Identifier: MIT
// Execute the production clipboard handlers and persistent bottom tabs at their service boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { collectProblems } = require('../lib/common/nodu-problems');
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), createRef: () => ({ current: null }) };
class Widget { title = {}; updates = 0; update() { this.updates++; } }
class Service { event() {} }
class URI { constructor(value) { this.value = value; } get parent() { return new URI(this.value.slice(0, this.value.lastIndexOf('/'))); } }
function load(name) {
    const timers = new Map(); let timer = 0;
    const stub = new Proxy({ ...React, __esModule: true, injectable: () => value => value, inject: () => () => {}, postConstruct: () => () => {},
        ReactWidget: Widget, BaseWidget: Widget, URI }, { get: (target, name) => name in target ? target[name] : Service });
    const exports = {};
    const file = path.resolve(__dirname, `../lib/browser/${name}.js`);
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports, require: name => name === '../common/nodu-problems' ? require('../lib/common/nodu-problems') : stub,
        setTimeout: fn => { timers.set(++timer, fn); return timer; }, clearTimeout: id => timers.delete(id) }, { filename: file });
    return { ...exports, timers };
}
function nodes(tree) {
    const found = [];
    const visit = value => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { found.push(value); visit(value.props?.children); } };
    visit(tree); return found;
}
function setup() {
    const module = load('nodu-problems-panel'), panel = new module.NoduProblemsPanel(), calls = [], errors = [], opens = [];
    panel.items = collectProblems([
        { owner: 'build', uri: 'file:///project/main.c', data: { severity: 1, code: 'undeclared_var_use', message: 'missing GPIO', range: { start: { line: 4, character: 2 }, end: { line: 4, character: 6 } } } },
        { owner: 'clangd', uri: 'file:///project/serial.c', data: { severity: 2, message: 'unused UART', range: { start: { line: 8, character: 0 }, end: { line: 8, character: 4 } } } }
    ]);
    panel.labels = { getLongName: uri => uri.value.replace('file://', ''), getName: uri => uri.value.split('/').at(-1) };
    panel.clipboard = { writeText: async text => calls.push(text) };
    panel.messages = { error: text => errors.push(text) };
    panel.editors = { open: async (...args) => opens.push(args) };
    return { panel, calls, errors, opens, timers: module.timers, button: name => nodes(panel.render()).find(node => node.type === 'button' && node.props['aria-label'] === name) };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test('each problem has an independent copy button without opening its file', async () => {
    const c = setup();
    const row = c.panel.renderProblem(c.panel.items[0]);
    const buttons = nodes(row).filter(node => node.type === 'button');
    assert.equal(buttons.length, 2);
    assert.equal(nodes(buttons[0]).some(node => node.type === 'button' && node !== buttons[0]), false);
    buttons[1].props.onClick(); await flush();
    assert.equal(c.calls[0], '/project/main.c:5:3 [错误] missing GPIO\n来源：build · 代码：undeclared_var_use');
    assert.equal(c.opens.length, 0);
    assert.equal(c.panel.copied, c.panel.items[0].key);
    buttons[0].props.onClick(); await flush(); assert.equal(c.opens.length, 1);
});

test('copy all includes hidden, filtered and collapsed problems and preserves the current filter', async () => {
    const c = setup();
    c.panel.query = 'missing'; c.panel.hiddenSeverities.add(2); c.panel.collapsed.add(c.panel.items[1].uri);
    assert.equal(c.button('复制全部问题').props.disabled, false);
    c.button('复制全部问题').props.onClick(); await flush();
    assert.match(c.calls[0], /main\.c:5:3/); assert.match(c.calls[0], /serial\.c:9:1/);
    assert.equal(c.calls[0].split('\n\n').length, 2);
    assert.equal(c.panel.query, 'missing'); assert.equal(c.panel.hiddenSeverities.has(2), true);
    assert.equal(c.panel.collapsed.has(c.panel.items[1].uri), true); assert.equal(c.opens.length, 0);
    c.panel.items = []; assert.equal(c.button('复制全部问题').props.disabled, true);
    await c.panel.copy([], 'all'); assert.equal(c.calls.length, 1);
});

test('clipboard failure is reported and late completion cannot replace newer copy feedback', async () => {
    const c = setup();
    c.panel.clipboard.writeText = async () => { throw new Error('clipboard denied'); };
    await c.panel.copy(c.panel.items, 'all');
    assert.deepEqual(c.errors, ['复制问题失败，请重试']); assert.equal(c.panel.copied, undefined);
    let complete;
    c.panel.clipboard.writeText = () => new Promise(resolve => { complete = resolve; });
    const old = c.panel.copy([c.panel.items[0]], c.panel.items[0].key);
    c.panel.clipboard.writeText = async () => {};
    await c.panel.copy(c.panel.items, 'all'); complete(); await old;
    assert.equal(c.panel.copied, 'all');
    for (const fn of c.timers.values()) fn();
    assert.equal(c.panel.copied, undefined);
});

test('Problems remains a bottom tab with no diagnostics on both project platforms and every selected page', () => {
    const { NoduBottomPanelWidget } = load('nodu-bottom-panel');
    const panel = new NoduBottomPanelWidget();
    panel.device = { state: { running: false } }; panel.embedded = { errors: [], monitor: { state: 'closed' } };
    panel.problemsPanel = { counts: { total: 0, errors: 0, warnings: 0, infos: 0 } };
    for (const platform of ['k210', 'stm32']) {
        panel.platform = platform;
        for (const page of ['output', 'terminal', 'repl', 'monitor', 'problems']) {
            panel.selected = page;
            assert.equal(panel.tabs.filter(tab => tab.id === 'problems').length, 1);
            assert.equal(panel.tabs.find(tab => tab.id === 'problems').label, '问题');
        }
    }
});
