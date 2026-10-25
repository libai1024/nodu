// SPDX-License-Identifier: MIT
// Execute the production persistent list's handlers at its model and focus boundary.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/browser/nodu-tutor-history.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
function descendants(tree) {
    const out = []; const visit = value => { if (Array.isArray(value)) value.forEach(visit); else if (value && typeof value === 'object') { out.push(value); visit(value.props?.children); } };
    visit(tree); return out;
}
function content(tree) {
    if (Array.isArray(tree)) return tree.map(content).join('');
    return tree && typeof tree === 'object' ? content(tree.props?.children) : typeof tree === 'string' ? tree : '';
}
function mount(overrides = {}) {
    let cursor = 0, tree; const slots = [], cleanups = [], calls = [], exports = {}, rowElements = new Map();
    const React = {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }), Fragment: 'fragment',
        useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => slots[i] = value]; },
        useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
        useEffect(fn) { const i = cursor++; if (!(i in slots)) { slots[i] = true; cleanups.push(fn()); } },
    };
    vm.runInNewContext(code, { exports, require: () => React });
    const tutor = {
        workspaceId: 'project-one', activeConversationId: 'one', mode: 'ask', conversationSidebarOpen: true, historyOpen: false,
        messages: { ask: [], teach: [] }, drafts: { ask: '保留当前草稿', teach: '' }, pins: [],
        historyEntries: [
            { id: 'one', mode: 'ask', title: '串口初始化', preview: '继续检查 DMA', hasDraft: true, updatedAt: Date.now() },
            { id: 'two', mode: 'teach', title: '新对话', preview: '配置 GPIO 引脚', hasDraft: true, updatedAt: Date.now() },
            { id: 'three', mode: 'ask', title: 'Blink Timer', preview: 'TIM2', hasDraft: false, updatedAt: Date.now() - 86400000 },
        ],
        async newConversation() { calls.push('new'); this.activeConversationId = 'new'; this.drafts[this.mode] = ''; this.messages[this.mode] = []; },
        async selectConversation(id, mode) { calls.push(['select', id, mode]); this.activeConversationId = id; this.mode = mode; this.historyOpen = false; },
        ...overrides,
    };
    const all = predicate => descendants(tree).filter(predicate), find = predicate => all(predicate)[0];
    const rows = () => all(n => n.props?.className === 'nodu-chat-sidebar-item');
    function render() {
        cursor = 0; tree = exports.ConversationSidebar({ tutor, selected: () => calls.push('composer-focus') });
        const list = find(n => n.props?.className === 'nodu-chat-sidebar-list');
        for (const row of rows()) if (!rowElements.has(row.props.title)) rowElements.set(row.props.title, { focus() { calls.push(['row-focus', row.props.title]); } });
        list.props.ref.current = { querySelectorAll: () => rows().filter(row => !row.props.disabled).map(row => rowElements.get(row.props.title)) };
    }
    render();
    const input = () => find(n => n.type === 'input');
    const key = (node, value) => {
        let prevented = false, stopped = false;
        node.props.onKeyDown({ key: value, currentTarget: rowElements.get(node.props.title), preventDefault() { prevented = true; }, stopPropagation() { stopped = true; } });
        render(); return { prevented, stopped };
    };
    return { tutor, calls, rows, all, find, input, key, render, text: () => content(tree), unmount: () => cleanups.forEach(fn => fn?.()), search(value) { input().props.onChange({ target: { value } }); render(); } };
}

test('persistent list is a labelled navigation surface with ordinary buttons, dates and identifiable drafts', () => {
    const c = mount();
    assert.equal(c.find(n => n.type === 'aside').props['aria-label'], '会话列表');
    assert.equal(c.input().props.placeholder, undefined);
    assert.equal(c.all(n => n.props?.role?.startsWith('menu')).length, 0);
    assert.deepEqual(c.rows().map(n => n.props.title), ['串口初始化', '配置 GPIO 引脚', 'Blink Timer']);
    assert.equal(c.rows()[0].props['aria-current'], 'true');
    assert.equal(c.find(n => n.props?.className === 'nodu-chat-sidebar-preview').props.children[0], '继续检查 DMA');
    assert.ok(c.text().includes('今天')); assert.ok(c.text().includes('昨天'));
    assert.deepEqual(c.calls, [], 'mount must not steal focus from the composer');
});

test('search and optional mode filters preserve the existing record order and do not select or send', () => {
    const c = mount(); const before = c.tutor.historyEntries.map(entry => entry.id);
    c.search('  dma  '); assert.deepEqual(c.rows().map(n => n.props.title), ['串口初始化']);
    c.search('GPIO'); assert.deepEqual(c.rows().map(n => n.props.title), ['配置 GPIO 引脚']);
    c.search(''); c.find(n => n.props?.['aria-label'] === '筛选会话模式').props.onClick(); c.render();
    const group = c.find(n => n.props?.className === 'nodu-chat-sidebar-filters');
    descendants(group).find(n => n.type === 'button' && content(n) === '教学').props.onClick(); c.render();
    assert.deepEqual(c.rows().map(n => n.props.title), ['配置 GPIO 引脚']);
    assert.deepEqual(c.tutor.historyEntries.map(entry => entry.id), before); assert.deepEqual(c.calls, []);
});

test('search arrows focus rows, row arrows/Home/End navigate, and Escape clears only the search', () => {
    const c = mount();
    assert.deepEqual(c.key(c.input(), 'ArrowDown'), { prevented: true, stopped: true });
    assert.deepEqual(c.calls.pop(), ['row-focus', '串口初始化']);
    c.key(c.input(), 'ArrowUp'); assert.deepEqual(c.calls.pop(), ['row-focus', 'Blink Timer']);
    c.key(c.rows()[0], 'ArrowDown'); assert.deepEqual(c.calls.pop(), ['row-focus', '配置 GPIO 引脚']);
    c.key(c.rows()[1], 'End'); assert.deepEqual(c.calls.pop(), ['row-focus', 'Blink Timer']);
    c.key(c.rows()[2], 'Home'); assert.deepEqual(c.calls.pop(), ['row-focus', '串口初始化']);
    c.key(c.rows()[0], 'ArrowUp'); assert.deepEqual(c.calls.pop(), ['row-focus', '串口初始化']);
    c.search('GPIO'); assert.deepEqual(c.key(c.input(), 'Escape'), { prevented: true, stopped: true });
    assert.equal(c.input().props.value, ''); assert.equal(c.tutor.conversationSidebarOpen, true); assert.equal(c.tutor.drafts.ask, '保留当前草稿');
    assert.deepEqual(c.key(c.input(), 'Escape'), { prevented: false, stopped: false });
    c.tutor.busy = { kind: 'chat' }; c.render(); c.key(c.input(), 'ArrowDown'); assert.deepEqual(c.calls, []);
});

test('select waits for activation, focuses once and keeps the persistent list open', async () => {
    let complete; const c = mount({ async selectConversation(id, mode) { c.calls.push(['select', id, mode]); await new Promise(resolve => complete = resolve); this.activeConversationId = id; this.mode = mode; } });
    const pending = c.rows()[1].props.onClick();
    assert.deepEqual(c.calls, [['select', 'two', 'teach']]);
    await c.rows()[2].props.onClick(); assert.equal(c.calls.length, 1, 'duplicate in-flight navigation must be ignored');
    complete(); await pending; assert.deepEqual(c.calls, [['select', 'two', 'teach'], 'composer-focus']); assert.equal(c.tutor.conversationSidebarOpen, true);
});

test('new conversation waits for activation, preserves list visibility and also focuses a reused empty conversation', async () => {
    let complete; const c = mount({ async newConversation() { c.calls.push('new'); await new Promise(resolve => complete = resolve); this.activeConversationId = 'new'; this.drafts[this.mode] = ''; } });
    const button = () => c.find(n => n.props?.className === 'nodu-chat-sidebar-new');
    const pending = button().props.onClick(); assert.deepEqual(c.calls, ['new']); complete(); await pending;
    assert.deepEqual(c.calls, ['new', 'composer-focus']); assert.equal(c.tutor.conversationSidebarOpen, true);
    const reused = button().props.onClick(); complete(); await reused; assert.deepEqual(c.calls, ['new', 'composer-focus', 'new', 'composer-focus']);
});

test('busy, history synchronization and missing workspace block new and selection even with stale handlers', async () => {
    for (const pending of [{ busy: { kind: 'chat' } }, { conversationLoading: true }, { workspaceId: undefined }]) {
        const c = mount(); const row = c.rows()[1], button = c.find(n => n.props?.className === 'nodu-chat-sidebar-new');
        Object.assign(c.tutor, pending); await row.props.onClick(); await button.props.onClick(); c.render();
        assert.ok(c.rows().every(n => n.props.disabled)); assert.equal(c.find(n => n.props?.className === 'nodu-chat-sidebar-new').props.disabled, true); assert.deepEqual(c.calls, []);
    }
});

test('failed or missing selection never focuses an unrelated conversation and exposes only the operation error', async () => {
    const c = mount({ async selectConversation() { throw new Error('provider or transport detail'); } });
    await c.rows()[1].props.onClick(); c.render(); assert.deepEqual(c.calls, []); assert.ok(c.text().includes('无法打开对话')); assert.ok(!c.text().includes('transport'));
    c.tutor.selectConversation = async () => {}; await c.rows()[1].props.onClick(); c.render(); assert.deepEqual(c.calls, []);
    c.tutor.newConversation = async () => { throw new Error('failed'); }; await c.find(n => n.props?.className === 'nodu-chat-sidebar-new').props.onClick(); c.render();
    assert.ok(c.text().includes('新建对话失败')); assert.equal(c.tutor.drafts.ask, '保留当前草稿'); assert.deepEqual(c.calls, []);
});

test('closing the list or changing workspace during activation cancels deferred focus', async () => {
    for (const leave of ['unmount', 'workspace']) {
        let complete; const c = mount({ async selectConversation(id, mode) { await new Promise(resolve => complete = resolve); this.activeConversationId = id; this.mode = mode; } });
        const pending = c.rows()[1].props.onClick(); if (leave === 'unmount') c.unmount(); else c.tutor.workspaceId = 'project-two';
        complete(); await pending; assert.deepEqual(c.calls, []);
    }
});
