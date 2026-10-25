// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const React = require('react'), { renderToStaticMarkup } = require('react-dom/server');
const filename = path.join(__dirname, '../src/browser/nodu-tutor-context-picker.tsx');
const compiledRequire = require('node:module').createRequire(path.join(__dirname, '../lib/browser/nodu-tutor-context-picker.js'));
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
function load(react = React) {
    const exports = {};
    vm.runInNewContext(code, { exports, require: id => id === '@theia/core/shared/react' ? react : id.endsWith('.css') ? {}
        : id === './nodu-tutor-chat-controls' ? { ChatPopover: props => react.createElement('div', { role: 'menu' }, props.children) }
        : id === '../common/tutor/tutor-context' ? compiledRequire(id) : (() => { throw Error(id); })() });
    return exports;
}
const exported = load();
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const context = (path = 'App/main.c', extra = {}) => ({ kind: 'file', path, text: 'int x;', version: 1, startLine: 1, endLine: 1, ...extra });
function state(extra = {}) {
    return { workspaceId: 'workspace-a', mode: 'ask', connectionState: 'connected', includeCode: true, currentContextIncluded: true,
        buffer: { path: 'App/main.c', text: 'int main(void) {\n}\n', version: 1, line: 1 }, pins: [],
        setIncludeCode(value) { this.includeCode = value; this.currentContextIncluded = value; }, removeContext(index) { this.pins.splice(index, 1); },
        listContextFiles: async () => ['App/main.c', 'Board/board.h'], addCurrentContext: async () => true, addContextFile: async () => true, ...extra };
}
function mount(tutor = state(), open = () => {}) {
    const slots = [], effects = []; let cursor = 0, tree, dead = false, updatesAfterUnmount = 0;
    const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const react = { Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
            return [slots[i], value => { if (dead) { updatesAfterUnmount++; return; } slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useCallback(fn, deps) { const i = cursor++; if (!slots[i] || !same(slots[i].deps, deps)) slots[i] = { fn, deps }; return slots[i].fn; },
        useEffect(fn, deps) { const i = cursor++, previous = slots[i]; if (!previous || !same(previous.deps, deps)) { slots[i] = { deps }; effects.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); }); } },
    };
    const { ContextPicker } = load(react);
    const render = () => { cursor = 0; tree = ContextPicker({ tutor, open }); effects.splice(0).forEach(f => f()); return tree; };
    const nodes = () => { const result = []; const visit = value => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { result.push(value); visit(value.props?.children); } }; visit(tree); return result; };
    const text = node => (node?.props?.children ?? []).flat(Infinity).map(v => typeof v === 'object' ? text(v) : typeof v === 'boolean' ? '' : v ?? '').join('');
    render(); render();
    return { render, nodes, text, get tree() { return tree; }, get updatesAfterUnmount() { return updatesAfterUnmount; },
        button: label => nodes().find(n => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === label),
        find: test => nodes().find(test),
        async flush() { for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); if (!dead) render(); } },
        unmount() { for (const slot of slots) slot?.cleanup?.(); dead = true; },
    };
}
const anchor = () => ({ isConnected: true, focuses: 0, focus() { this.focuses++; } });
const click = (button, target = anchor()) => button.props.onClick({ currentTarget: target, stopPropagation() {} });

test('context labels disambiguate paths and SSR renders independent navigation and removal controls', () => {
    assert.equal(exported.tutorContextLabel('App/main.c', ['App/main.c', 'Tests/main.c']), 'App/main.c');
    assert.equal(exported.tutorContextLabel('Core/Inc/board.h', ['App/main.c']), 'board.h');
    const html = renderToStaticMarkup(React.createElement(exported.ContextPicker, { tutor: state({ pins: [context('Board/board.h')] }), open() {} }));
    for (const label of ['打开 main.c', '移除 main.c', '预览 board.h', '移除 board.h', '添加上下文']) assert.ok(html.includes(label), label);
    assert.match(html, /当前/); assert.match(html, /预览 board.h/); assert.doesNotMatch(html, /图片|摄像头|上传/);
});

test('removing a chip never opens its file; fixed selections navigate to the original start line', () => {
    const calls = [], tutor = state({ currentContextIncluded: false, pins: [context('App/main.c', { kind: 'selection', startLine: 10, endLine: 18 })] });
    const c = mount(tutor, (...args) => calls.push(args));
    click(c.button('预览 main.c:10–18')); c.render(); assert.deepEqual(calls, []);
    click(c.button('打开源文件')); c.render(); assert.deepEqual(calls, [['App/main.c', 10]]);
    let stopped = false; c.button('移除 main.c:10–18').props.onClick({ stopPropagation() { stopped = true; } });
    assert.equal(stopped, true); assert.equal(tutor.pins.length, 0); assert.equal(calls.length, 1);
    tutor.currentContextIncluded = true; c.render(); click(c.button('移除 main.c')); assert.equal(tutor.includeCode, false); assert.equal(calls.length, 1);
});

test('Python current-file controls only appear in ask, and selection requires a real selection', () => {
    const tutor = state({ mode: 'teach', buffer: { path: 'main.py', text: 'print(1)', selection: undefined } }), c = mount(tutor);
    assert.equal(c.button('打开 main.py'), undefined); click(c.button('添加上下文')); c.render();
    assert.equal(c.button('引用当前文件').props.disabled, true); assert.equal(c.button('引用选中代码').props.disabled, true);
    tutor.mode = 'ask'; c.render(); c.render(); click(c.button('添加上下文')); c.render();
    assert.equal(c.button('引用当前文件').props.disabled, false); assert.equal(c.button('引用选中代码').props.disabled, true);
    tutor.buffer.selection = { text: 'print(1)', startLine: 1, endLine: 1 }; c.render(); assert.equal(c.button('引用选中代码').props.disabled, false);
});

test('authorized project choices load on demand and pin only the explicitly selected file', async () => {
    const calls = [], request = defer(), tutor = state({ listContextFiles: () => { calls.push('list'); return request.promise; }, addContextFile: async path => { calls.push(path); return true; } });
    const c = mount(tutor), trigger = anchor(); click(c.button('添加上下文'), trigger); c.render(); assert.deepEqual(calls, []);
    click(c.button('从工程选择文件')); c.render(); assert.match(c.text(c.tree), /读取工程文件/);
    request.resolve(['App/main.c', 'Board/board.h']); await c.flush(); click(c.button('Board/board.h')); await c.flush();
    assert.deepEqual(calls, ['list', 'Board/board.h']); assert.equal(trigger.focuses, 1); assert.equal(c.button('Board/board.h'), undefined);
});

test('selection pinning captures the requested kind once and false outcomes retain the menu and concrete error', async () => {
    const calls = [], request = defer(), tutor = state({ addCurrentContext: kind => { calls.push(kind); return request.promise; } });
    tutor.buffer.selection = { text: 'x', startLine: 2, endLine: 2 };
    const c = mount(tutor); click(c.button('添加上下文')); c.render(); click(c.button('引用选中代码')); click(c.button('引用选中代码')); c.render();
    assert.deepEqual(calls, ['selection']); assert.equal(c.button('引用当前文件').props.disabled, true);
    tutor.contextError = '代码上下文超过 64 KiB，请移除一项'; request.resolve(false); await c.flush();
    assert.match(c.text(c.tree), /64 KiB/); assert.ok(c.button('引用选中代码'));
});

test('stale project listing and unmounted navigation results do not leak across workspace changes', async () => {
    const request = defer(), tutor = state({ listContextFiles: () => request.promise }), c = mount(tutor);
    click(c.button('添加上下文')); c.render(); click(c.button('从工程选择文件')); c.render();
    tutor.workspaceId = 'workspace-b'; c.render(); c.render(); request.resolve(['secret-old-project.c']); await c.flush();
    assert.doesNotMatch(c.text(c.tree), /secret-old-project/); assert.equal(c.button('返回'), undefined);
    const navigation = defer(), d = mount(state(), () => navigation.promise); click(d.button('打开 main.c')); d.unmount(); navigation.reject(Error('revoked')); await d.flush();
    assert.equal(d.updatesAfterUnmount, 0);
});

test('overflow exposes all pinned contexts with keyboard-addressable navigation and removal', () => {
    const tutor = state({ currentContextIncluded: false, pins: ['a.c', 'b.c', 'c.c', 'd.c'].map(path => context(path)) }), c = mount(tutor);
    assert.ok(c.button('预览 a.c')); assert.ok(c.button('预览 b.c')); assert.equal(c.button('预览 c.c'), undefined);
    click(c.button('查看全部 4 项上下文')); c.render();
    assert.equal(c.button('预览 c.c').props.role, 'menuitem'); assert.equal(c.button('移除 d.c').props.role, 'menuitem');
});

test('closing a pending addition does not later steal focus or close a newly opened menu', async () => {
    const request = defer(), tutor = state({ addCurrentContext: () => request.promise }), c = mount(tutor), old = anchor(), fresh = anchor();
    click(c.button('添加上下文'), old); c.render(); click(c.button('引用当前文件')); c.render();
    c.find(n => typeof n.type === 'function').props.close(); c.render(); click(c.button('添加上下文'), fresh); c.render();
    request.resolve(true); await c.flush(); assert.equal(old.focuses, 0); assert.equal(fresh.focuses, 0); assert.ok(c.button('引用当前文件'));
});

test('failed file enumeration has a retry and does not pretend an empty project', async () => {
    let count = 0; const tutor = state({ listContextFiles: async () => { count++; throw Error('offline'); } }), c = mount(tutor);
    click(c.button('添加上下文')); c.render(); click(c.button('从工程选择文件')); await c.flush();
    assert.match(c.text(c.tree), /无法读取工程文件/); assert.match(c.text(c.tree), /文件列表不可用/); assert.doesNotMatch(c.text(c.tree), /没有可附带/);
    click(c.button('重新读取')); await c.flush(); assert.equal(count, 2);
});

test('terminal picker attaches only the chosen source and inline terminal references expose removal without preview or navigation', async () => {
    const calls=[],tutor=state({currentContextIncluded:false,pins:[context('build #1 · 最近输出',{kind:'terminal',terminalName:'zsh',terminalSelection:true,text:'error: undefined symbol\nretry stopped',startLine:601,endLine:602})],listContextTerminals:()=>[{id:'t1',title:'build'}],addTerminalContext:async (...args)=>{calls.push(args);return true;}}), c=mount(tutor,()=>{throw Error('terminal is not a file');});
    const chip=c.find(n=>n.type==='span'&&n.props.className?.includes('nodu-chat-context-terminal'));assert.ok(chip);assert.equal(c.text(chip),'zsh (601-602)');assert.equal(chip.props.title,'zsh (601-602)');assert.equal(chip.props.onClick,undefined);
    assert.ok(c.button('移除 zsh (601-602)'));assert.equal(c.button('预览 zsh (601-602)'),undefined);assert.equal(c.button('打开源文件'),undefined);
    assert.doesNotMatch(c.text(c.tree),/build|#1|最近输出|固定快照|error: undefined symbol|retry stopped/);
    click(c.button('添加上下文'));c.render();click(c.button('终端'));c.render();
    assert.deepEqual(calls,[]);click(c.button('build'));await c.flush();assert.equal(calls.length,1);assert.equal(calls[0][0],'t1');assert.notEqual(calls[0][1],true);
    click(c.button('移除 zsh (601-602)'));assert.equal(tutor.pins.length,0);
});
test('terminal chip SSR shows the captured name and single selection row while legacy source ids use a neutral fallback',()=>{
    const html=renderToStaticMarkup(React.createElement(exported.ContextPicker,{tutor:state({currentContextIncluded:false,pins:[
        context('build #19 · 选区',{kind:'terminal',terminalName:'zsh',terminalSelection:true,text:'error',startLine:47,endLine:47}),
        context('terminal:internal-widget-id',{kind:'terminal',text:'next',startLine:801,endLine:801}),
    ]}),open(){}}));
    assert.match(html,/title="zsh \(47\)"/);assert.match(html,/aria-label="移除 zsh \(47\)"/);assert.match(html,/title="终端"/);
    assert.doesNotMatch(html,/build|#19|选区|internal-widget-id|terminal:|最近输出|固定快照|预览|801|47-47/);
});
test('changing conversations dismisses old snapshot previews and pending file searches', async () => {
    const request=defer(),tutor=state({activeConversationId:'a',listContextFiles:()=>request.promise}),c=mount(tutor);
    click(c.button('添加上下文'));c.render();click(c.button('从工程选择文件'));c.render();
    tutor.activeConversationId='b';c.render();c.render();request.resolve(['old.c']);await c.flush();assert.equal(c.button('old.c'),undefined);
});
