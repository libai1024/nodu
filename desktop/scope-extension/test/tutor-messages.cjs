// SPDX-License-Identifier: MIT
// Real React SSR protects the markup boundary. Deterministic hooks exercise local
// interactions; Electron acceptance remains responsible for visual/focus layout.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const filename = path.join(__dirname, '../src/browser/nodu-tutor-messages.tsx');
const compiledRequire = createRequire(path.join(__dirname, '../lib/browser/nodu-tutor-messages.js'));
const code = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true },
}).outputText + '\nexports.testComponents = { CopyButton, CodeBlock, HighlightedCode, FileReference };';
const load = (react = React, globals = {}) => {
    const exported = {};
    vm.runInNewContext(code, {
        exports: exported,
        require: id => id === '@theia/core/shared/react' ? react : id.endsWith('.css') ? {} : id === '@theia/monaco-editor-core'
            ? (globals.monaco ?? { languages: { getLanguages: () => [] }, editor: { tokenize: () => [] } }) : compiledRequire(id),
        setTimeout, clearTimeout, ...globals,
    });
    return exported;
};
const messagesModule = load();
const item = (props = {}) => ({ id: 'one', role: 'assistant', text: '已完成。', status: 'done', ...props });
const render = props => renderToStaticMarkup(React.createElement(messagesModule.TutorMessage, { item: item(), open() {}, ...props }));
const plain = value => JSON.parse(JSON.stringify(value));
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function hooks(globals = {}) {
    const instances = new Map(); let current;
    const equal = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
    const react = {
        Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useState(initial) {
            const instance = current, i = instance.cursor++;
            if (!(i in instance.slots)) instance.slots[i] = typeof initial === 'function' ? initial() : initial;
            return [instance.slots[i], value => { if (instance.dead) { instance.deadUpdates++; return; } instance.slots[i] = typeof value === 'function' ? value(instance.slots[i]) : value; }];
        },
        useRef(value) { const i = current.cursor++; return current.slots[i] ??= { current: value }; },
        useEffect(fn, deps) {
            const instance = current, i = instance.cursor++, previous = instance.slots[i];
            if (!previous || !equal(previous.deps, deps)) {
                instance.slots[i] = { deps, cleanup: previous?.cleanup };
                instance.effects.push(() => { previous?.cleanup?.(); instance.slots[i].cleanup = fn(); });
            }
        },
    };
    const exported = load(react, globals);
    function mount(name, props, key = Symbol()) {
        const component = exported[name] ?? exported.testComponents[name];
        const instance = { slots: [], effects: [], cursor: 0, tree: undefined, dead: false, deadUpdates: 0 };
        instances.set(key, instance);
        const render = () => { current = instance; instance.cursor = 0; instance.tree = component(props); for (const effect of instance.effects.splice(0)) effect(); return instance.tree; };
        const nodes = () => {
            const result = []; const visit = v => { if (Array.isArray(v)) v.forEach(visit); else if (v && typeof v === 'object') { result.push(v); visit(v.props?.children); } };
            visit(instance.tree); return result;
        };
        const text = node => (node?.props?.children ?? []).flat(Infinity).map(v => typeof v === 'object' ? text(v) : typeof v === 'boolean' ? '' : v ?? '').join('');
        render();
        return { render, nodes, text, props, get tree() { return instance.tree; }, get deadUpdates() { return instance.deadUpdates; },
            button: label => nodes().find(n => n.type === 'button' && (n.props['aria-label'] ?? text(n)) === label),
            find: test => nodes().find(test),
            async flush() { for (let i = 0; i < 5; i++) { await new Promise(r => setImmediate(r)); if (!instance.dead) render(); } },
            unmount() { for (const slot of instance.slots) slot?.cleanup?.(); instance.dead = true; },
        };
    }
    return { mount, exported };
}

test('controlled markdown preserves paragraphs, lists, strong text and exact fenced code bytes', () => {
    const source = '说明 **串口** 与 `UART`。\n下一行\n\n3. 配置\n4. 发送\n\n- 检查\n- 完成\n\n```c\r\nint x = 1;\r\n\r\n```\r\n';
    const blocks = plain(messagesModule.parseTutorMarkdown(source));
    assert.deepEqual(blocks, [
        { kind: 'paragraph', text: '说明 **串口** 与 `UART`。\n下一行' },
        { kind: 'list', ordered: true, start: 3, items: ['配置', '发送'] },
        { kind: 'list', ordered: false, start: 1, items: ['检查', '完成'] },
        { kind: 'code', language: 'c', text: 'int x = 1;\r\n\r\n' },
    ]);
    const html = render({ item: item({ text: source }) });
    assert.match(html, /<strong>串口<\/strong>/); assert.match(html, /<code>UART<\/code>/);
    assert.match(html, /<ol start="3">/); assert.match(html, /<ul><li>/); assert.match(html, /复制代码/);
});

test('only safe C/Python project references become buttons; dangerous and unsupported destinations stay literal', () => {
    const rejected = ['javascript:alert', 'command:workbench.action.terminal.new', 'https://evil.example/main.c', 'file:///tmp/a.c',
        '/tmp/a.c', '../secret.c', 'dir/../a.c', 'C:\\tmp\\a.c', 'dir%2fa.c', 'dir/%2e%2e/a.c', '//server/a.c', 'a.c#L0',
        'a.c#L-1', 'a.c#L1.2', 'a.c#L1000000', 'a.c#other', 'a.c?x=1', 'con.c', 'dir./a.c', 'a.c\u0000', 'a.json'];
    for (const target of rejected) {
        const source = `[查看](${target})`;
        assert.ok(messagesModule.parseTutorInline(source).every(n => n.kind === 'text'), source);
    }
    assert.deepEqual(plain(messagesModule.parseTutorInline('[头文件](Core/Inc/board.h#L17)')), [{ kind: 'reference', text: '头文件', path: 'Core/Inc/board.h', line: 17 }]);
    assert.deepEqual(plain(messagesModule.parseTutorInline('[脚本](main.py#L2)')), [{ kind: 'reference', text: '脚本', path: 'main.py', line: 2 }]);
    assert.ok(messagesModule.parseTutorInline('![图](main.c)').every(n => n.kind === 'text'));
    assert.ok(messagesModule.parseTutorInline('\\[图](main.c)').every(n => n.kind === 'text'));
    const html = render({ item: item({ text: '[头文件](Core/Inc/board.h#L17) [危险](command:run)' }) });
    assert.match(html, /title="Core\/Inc\/board.h:17"/); assert.doesNotMatch(html, /<a\b|href=/);
});

test('real React rendering escapes HTML and keeps user markdown entirely literal', () => {
    const attack = '<img src=x onerror="alert(1)">\n<script>window.bad=1</script>\n**bold** [file](main.c)';
    const html = render({ item: item({ role: 'user', text: attack }) });
    assert.match(html, /nodu-chat-user/); assert.match(html, /nodu-chat-bubble/);
    assert.doesNotMatch(html, /<img|<script|<strong|nodu-chat-file-link/); assert.match(html, /&lt;script&gt;/);
    const assistant = render({ item: item({ text: attack }) });
    assert.doesNotMatch(assistant, /<img|<script|onerror="/); assert.match(assistant, /&lt;img/);
});

test('incomplete fences remain code and fence info never fabricates a filename or link', () => {
    const blocks = plain(messagesModule.parseTutorMarkdown('```c main.c#L3\n<script>bad()</script>\n[x](main.c)'));
    assert.deepEqual(blocks, [{ kind: 'code', language: '', text: '<script>bad()</script>\n[x](main.c)' }]);
    const html = render({ item: item({ text: '```c main.c#L3\n<script>bad()</script>\n[x](main.c)' }) });
    assert.match(html, /aria-label="代码"/); assert.doesNotMatch(html, /nodu-chat-file-link|<script/);
});

test('hostile long inputs have bounded parse trees without silently dropping source', () => {
    const huge = '*'.repeat(130000);
    assert.deepEqual(plain(messagesModule.parseTutorMarkdown(huge)), [{ kind: 'paragraph', text: huge }]);
    assert.deepEqual(plain(messagesModule.parseTutorInline(huge)), [{ kind: 'text', text: huge }]);
    const alternating = Array.from({ length: 2000 }, (_, i) => `paragraph${i}\n\n`).join('');
    const blocks = messagesModule.parseTutorMarkdown(alternating);
    assert.equal(blocks.length, 513); assert.match(blocks.at(-1).text, /paragraph1999/);
    const inline = Array.from({ length: 2000 }, (_, i) => `**b${i}**`).join('');
    const nodes = messagesModule.parseTutorInline(inline); assert.ok(nodes.length <= 257); assert.match(nodes.at(-1).text, /\*\*b1999\*\*/);
});

test('code token rendering escapes every segment and maps tokenizer styles to a fixed vocabulary', async () => {
    const h = hooks({ monaco: { languages: { getLanguages: () => [{ id: 'c' }] }, editor: { tokenize: () => [
        [{ offset: 0, type: 'keyword.c' }, { offset: 3, type: 'string" onclick="bad' }], [{ offset: 0, type: 'comment.c' }],
    ] } } });
    const source = 'int <script>\n// hi';
    const c = h.mount('HighlightedCode', { text: source, language: 'c' });
    assert.equal(c.text(c.tree), source); await c.flush();
    assert.equal(c.text(c.tree), source);
    assert.ok(c.find(n => n.props?.className === 'nodu-chat-token-keyword'));
    assert.ok(c.nodes().every(n => !String(n.props?.className).includes('onclick')));
    c.props.text = 'different'; c.render(); assert.equal(c.text(c.tree), 'different');
    c.unmount(); await c.flush(); assert.equal(c.deadUpdates, 0);
});

test('copy writes the full original text and acknowledges locally, failures remain retryable', async () => {
    const writes = [], timers = [];
    let fail = false;
    const h = hooks({ navigator: { clipboard: { writeText: async text => { if (fail) throw Error('denied'); writes.push(text); } } },
        setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {} });
    const source = 'x\r\n  y\r\n';
    const c = h.mount('CopyButton', { text: source, label: '复制代码' });
    c.button('复制代码').props.onClick(); await c.flush(); assert.deepEqual(writes, [source]); assert.ok(c.button('已复制'));
    timers.at(-1)(); c.render(); assert.ok(c.button('复制代码'));
    fail = true; c.button('复制代码').props.onClick(); await c.flush(); assert.match(c.text(c.tree), /复制失败/);
    fail = false; c.button('复制代码').props.onClick(); await c.flush(); assert.ok(c.button('已复制'));
});

test('pending clipboard and file navigation results do not update unmounted messages', async () => {
    const clipboard = defer(), file = defer();
    const h = hooks({ navigator: { clipboard: { writeText: () => clipboard.promise } } });
    const copy = h.mount('CopyButton', { text: 'x', label: '复制' }); copy.button('复制').props.onClick(); copy.unmount(); clipboard.resolve(); await copy.flush();
    assert.equal(copy.deadUpdates, 0);
    const link = h.mount('FileReference', { node: { kind: 'reference', text: 'main.c', path: 'main.c', line: 3 }, open: () => file.promise });
    link.button('main.c').props.onClick(); link.unmount(); file.reject(Error('revoked')); await link.flush(); assert.equal(link.deadUpdates, 0);
});

test('code and user message expansion survive remounts but remain scoped to each message', () => {
    const h = hooks(), block = { kind: 'code', language: 'c', text: Array.from({ length: 40 }, (_, i) => `int line${i};\n`).join('') };
    const code = h.mount('CodeBlock', { block, stateKey: 'chat-a:code:0' });
    assert.ok(code.button('展开代码（40 行）')); assert.equal(code.find(n => n.type?.name === 'CopyButton').props.text, block.text);
    code.button('展开代码（40 行）').props.onClick(); code.render(); assert.ok(code.button('收起代码')); code.unmount();
    assert.ok(h.mount('CodeBlock', { block, stateKey: 'chat-a:code:0' }).button('收起代码'));
    assert.ok(h.mount('CodeBlock', { block, stateKey: 'chat-b:code:0' }).button('展开代码（40 行）'));
    const props = { item: item({ id: 'long-user', role: 'user', text: '输入内容'.repeat(200) }), open() {} };
    const message = h.mount('TutorMessage', props); assert.ok(message.button('展开')); message.button('展开').props.onClick(); message.render(); message.unmount();
    assert.ok(h.mount('TutorMessage', props).button('收起'));
});

test('failed replies use a quiet status and optional retry, and details stay behind more', async () => {
    const h = hooks(), deferred = defer(), calls = [], original = item({ status: 'failed', text: '部分回复', note: 'sanitized request-id: abc' });
    const c = h.mount('TutorMessage', { item: original, open() {}, retry: value => { calls.push(value); return deferred.promise; } });
    assert.match(c.text(c.tree), /回复中断/); assert.doesNotMatch(c.text(c.tree), /request-id/);
    c.button('消息详情').props.onClick(); c.render(); assert.match(c.text(c.tree), /sanitized request-id: abc/);
    c.button('重试').props.onClick(); c.button('重试').props.onClick(); c.render(); assert.deepEqual(calls, [original]);
    assert.equal(c.button('重试中').props.disabled, true); deferred.reject(Error('unavailable')); await c.flush();
    assert.ok(c.button('重试')); assert.match(c.text(c.tree), /操作未完成/); assert.equal(original.text, '部分回复');
    const html = render({ item: item({ status: 'failed', text: '', note: 'detail' }) });
    assert.match(html, /未收到回复/); assert.doesNotMatch(html, />重试<|>detail<|codicon-warning/);
});

test('busy actions cannot dispatch; reask passes the original message without editing it', async () => {
    const h = hooks(), calls = [], original = item({ id: 'user-edit', role: 'user', text: '原问题' });
    const props = { item: original, open() {}, busy: true, onReask: value => calls.push(value) };
    const c = h.mount('TutorMessage', props); assert.equal(c.button('修改后再问').props.disabled, true);
    c.button('修改后再问').props.onClick(); await c.flush(); assert.deepEqual(calls, []);
    props.busy = false; c.render(); c.button('修改后再问').props.onClick(); await c.flush(); assert.deepEqual(calls, [original]); assert.equal(original.text, '原问题');
    const stopped = render({ item: item({ status: 'stopped', text: 'partial' }), retry() {} }); assert.match(stopped, /已停止/); assert.doesNotMatch(stopped, /回复中断/);
});

test('project links call the authorized navigation callback and show failed references inline', async () => {
    const h = hooks(), calls = [], request = defer();
    const c = h.mount('FileReference', { node: { kind: 'reference', text: '头文件', path: 'Core/Inc/board.h', line: 17 }, open: (...args) => { calls.push(args); return request.promise; } });
    c.button('头文件').props.onClick(); c.button('头文件').props.onClick(); c.render();
    assert.deepEqual(calls, [['Core/Inc/board.h', 17]]); assert.equal(c.button('头文件').props.disabled, true);
    request.reject(Error('not authorized')); await c.flush(); assert.match(c.text(c.tree), /无法打开此文件/); assert.equal(c.button('头文件').props.disabled, false);
});

test('pending replies keep partial text without exposing copy or retry controls', () => {
    const empty = render({ item: item({ status: 'pending', text: '' }), retry() {} });
    assert.match(empty, /aria-busy="true"/); assert.match(empty, /正在生成/); assert.doesNotMatch(empty, /复制回复|>重试</);
    const partial = render({ item: item({ status: 'pending', text: '流式内容' }) });
    assert.match(partial, /流式内容/); assert.doesNotMatch(partial, /正在生成/);
});

test('sent user context references render safe snapshot paths/ranges and ignore hostile metadata', () => {
    const html = render({ item: item({ role: 'user', text: '**保持原问题**', contextRefs: [
        { kind: 'selection', path: 'Core/Src/main.c', startLine: 10, endLine: 18 },
        { kind: 'file', path: 'boot.py', startLine: 1, endLine: 4 },
        { kind: 'file', path: '../secret.c', startLine: 1, endLine: 1 },
        { kind: 'file', path: 'javascript:run.c', startLine: 1, endLine: 1 },
        { kind: 'selection', path: 'bad.c', startLine: -1, endLine: 1 },
        { kind: 'file', path: 'embedded.c', startLine: 1, endLine: 1, text: '<script>hidden source</script>' },
    ] }) });
    assert.match(html, /本条消息附带的上下文/); assert.match(html, /title="Core\/Src\/main.c:10"/); assert.match(html, /main.c:10–18/); assert.match(html, /boot.py/);
    assert.doesNotMatch(html, /secret.c|javascript:|bad.c|embedded.c|hidden source|<strong>|href=/);
    assert.match(html, /\*\*保持原问题\*\*/);
});

test('sent terminal references expand immutable escaped output without a filesystem navigation action',()=>{
    const context={kind:'terminal',path:'build #123 · 最近输出',terminalName:'zsh',terminalSelection:true,startLine:601,endLine:602,text:'error: <missing symbol>\nlink failed',version:1};
    const {text,version,...ref}=context;
    const html=render({item:item({role:'user',text:'分析',contextRefs:[ref]}),snapshot:{contexts:[context]}});
    assert.match(html,/<details/);assert.match(html,/<summary><i[^>]*><\/i>zsh \(601-602\)<\/summary>/);
    assert.match(html,/error: &lt;missing symbol&gt;/);assert.doesNotMatch(html,/打开源文件|build|#123|最近输出|固定快照|发送时的快照|2 行/);
});
test('sent terminal references without snapshot text retain selection labels and whole terminal names with a safe legacy fallback',()=>{
    const html=render({item:item({role:'user',text:'分析',contextRefs:[
        {kind:'terminal',path:'build #123 · 选区',terminalName:'zsh',terminalSelection:true,startLine:47,endLine:48},
        {kind:'terminal',path:'terminal:internal-widget-id',terminalName:'bash',terminalSelection:false,startLine:90,endLine:90},
        {kind:'terminal',path:'terminal:legacy-widget-id',startLine:21,endLine:21},
    ]})});
    assert.match(html,/zsh \(47-48\)/);assert.match(html,/>bash<\/span>/);assert.match(html,/>终端<\/span>/);
    assert.doesNotMatch(html,/<details|打开源文件|build|#123|选区|internal-widget-id|legacy-widget-id|terminal:|固定快照|发送时的快照|90|21/);
});
test('terminal display names are escaped and invalid metadata is not rendered',()=>{
    const html=render({item:item({role:'user',text:'分析',contextRefs:[
        {kind:'terminal',path:'terminal:html-name',terminalName:'<img src=x>',terminalSelection:true,startLine:3,endLine:3},
        {kind:'terminal',path:'terminal:bad-name',terminalName:'bad\nname',startLine:1,endLine:1},
        {kind:'terminal',path:'terminal:bad-scope',terminalName:'bad scope',terminalSelection:'true',startLine:1,endLine:1},
    ]})});
    assert.match(html,/&lt;img src=x&gt; \(3\)/);assert.doesNotMatch(html,/<img|bad.scope|bad.name|terminal:/);
});
