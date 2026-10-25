// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/browser/nodu-ai-provider-settings.tsx'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React }
}).outputText;
const walk = root => { const all = []; const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { all.push(node); visit(node.props?.children); } }; visit(root); return all; };
// Execute the production component functions with a small hook runtime. Tests interact
// through labels and callbacks, never through component-specific state slot numbers.
function runtime() {
    let current;
    class HTMLElement {}
    class HTMLInputElement extends HTMLElement {}
    const document = { activeElement: undefined, body: {}, addEventListener() {}, removeEventListener() {} };
    const slot = initial => {
        assert.ok(current, 'a hook must run inside a component render');
        const index = current.cursor++;
        if (!(index in current.slots)) current.slots[index] = typeof initial === 'function' ? initial() : initial;
        return [current, index];
    };
    const effect = (work, deps) => {
        const [instance, index] = slot(() => ({ deps: undefined, cleanup: undefined }));
        const state = instance.slots[index];
        if (!deps || !state.deps || deps.length !== state.deps.length || deps.some((value, i) => !Object.is(value, state.deps[i]))) {
            state.deps = deps;
            instance.effects.push(() => { state.cleanup?.(); state.cleanup = work(); });
        }
    };
    const react = {
        createElement: (type, props, ...children) => ({ type, props: { ...props, children } }),
        useState(initial) {
            const [instance, index] = slot(initial);
            return [instance.slots[index], value => {
                const next = typeof value === 'function' ? value(instance.slots[index]) : value;
                if (!Object.is(next, instance.slots[index])) { instance.slots[index] = next; instance.dirty = true; }
            }];
        },
        useRef(initial) { const [instance, index] = slot(() => ({ current: initial })); return instance.slots[index]; },
        useId() { const [instance, index] = slot(() => `provider-${Math.random().toString(36).slice(2)}`); return instance.slots[index]; },
        useCallback(callback, deps) {
            const [instance, index] = slot(() => ({ callback, deps }));
            const previous = instance.slots[index];
            if (deps.some((value, i) => !Object.is(value, previous.deps[i]))) instance.slots[index] = { callback, deps };
            return instance.slots[index].callback;
        },
        useEffect: effect, useLayoutEffect: effect,
    };
    const controls = {};
    const controlsCode = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/browser/nodu-tutor-chat-controls.tsx'), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React }
    }).outputText;
    const environment = { Error, document, HTMLElement, HTMLInputElement,
        window: { innerWidth: 900, innerHeight: 700, addEventListener() {}, removeEventListener() {} },
        ResizeObserver: class { observe() {} disconnect() {} } };
    vm.runInNewContext(controlsCode, { ...environment, exports: controls, require: id => id.endsWith('/react') ? react : { createPortal: node => node } });
    const exports = {};
    vm.runInNewContext(code, { ...environment, exports, require: id => id === '@theia/core/shared/react' ? react : id.endsWith('tutor-ai-config') ? require('../lib/common/tutor/tutor-ai-config') : id.endsWith('nodu-tutor-chat-controls') ? controls : {} });
    const mountComponent = (component, props, attach) => {
        const instance = { slots: [], cursor: 0, effects: [], dirty: false }; let tree;
        const render = () => {
            let count = 0;
            do {
                assert.ok(++count < 20, 'effects must settle without a render loop');
                instance.cursor = 0; instance.effects = []; instance.dirty = false;
                current = instance;
                try { tree = component(props()); } finally { current = undefined; }
                attach?.(tree);
                for (const run of instance.effects) run();
            } while (instance.dirty);
            return tree;
        };
        render();
        return { render, nodes: () => walk(tree), async flush() { for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); render(); } } };
    };
    return { exports, controls, document, HTMLInputElement, mountComponent };
}
function mount(tutor) {
    const r = runtime(), c = r.mountComponent(r.exports.AISettingsPanel, () => ({ tutor }));
    return { ...c, summaries: () => c.nodes().filter(n => n.props?.className === 'nodu-ai-provider-summary'),
        bodies: () => c.nodes().filter(n => n.props?.className === 'nodu-ai-provider-content'),
        add: () => c.nodes().find(n => n.props?.className === 'nodu-ai-catalog-add') };
}
function mountDetail(tutor, initialProvider) {
    const r = runtime(), panel = r.mountComponent(r.exports.AISettingsPanel, () => ({ tutor }));
    const descriptor = panel.nodes().find(n => n.props?.provider?.id === initialProvider.id);
    assert.equal(typeof descriptor?.type, 'function', 'mount the real detail component returned by the panel');
    let props = { ...descriptor.props, provider: initialProvider, visible: true };
    const c = r.mountComponent(descriptor.type, () => props);
    return { ...c, runtime: r, mountChild(descriptor) { return r.mountComponent(descriptor.type, () => descriptor.props); },
        setProvider(provider) { props = { ...props, provider }; c.render(); }, setVisible(visible) { props = { ...props, visible }; c.render(); } };
}
const provider = (id, kind = 'custom') => ({ id, kind, name: id, enabled: true, hasKey: false,
    baseUrl: 'http://127.0.0.1:24420/v1', apiFormat: 'chat-completions', models: [{ id: 'test-model', enabled: true, reasoningLevels: [] }] });
const settings = () => ({ storage: 'session', selection: { providerId: 'second', modelId: 'test-model' }, providers: [provider('first', 'builtin'), provider('second')] });

test('asynchronously loaded settings expand the selected provider without triggering a connection or changing configuration', () => {
    const tutor = {}, c = mount(tutor);
    assert.equal(c.summaries().length, 0);
    tutor.settings = settings(); c.render();
    assert.deepEqual(c.summaries().map(n => n.props['aria-expanded']), [false, true]);
    c.summaries()[1].props.onClick(); c.render();
    assert.deepEqual(c.bodies().map(n => n.props.hidden), [true, true]);
    c.render(); assert.deepEqual(c.bodies().map(n => n.props.hidden), [true, true], 'refresh must not reopen a deliberately collapsed provider');
});

test('provider switching retains both mounted detail forms so unsaved credentials and connection fields are not discarded', () => {
    const tutor = { settings: settings() }, c = mount(tutor);
    const details = c.bodies().map(n => n.props.children[0]);
    c.summaries()[0].props.onClick(); c.render();
    assert.deepEqual(c.bodies().map(n => n.props.hidden), [false, true]);
    assert.equal(c.bodies().length, 2);
    c.bodies().forEach((body, i) => { assert.equal(body.props.children[0].type, details[i].type); assert.equal(body.props.children[0].props.provider, details[i].props.provider); });
});

test('provider creation opens the returned configuration; a failed save leaves existing provider state intact', async () => {
    const calls = [], tutor = { settings: settings(), saveProvider: async p => { calls.push(p); tutor.settings.providers.push(p); } }, c = mount(tutor);
    c.add().props.onClick(); await c.flush();
    assert.equal(calls.length, 1); assert.equal(calls[0].models.length, 0);
    assert.equal(c.summaries().at(-1).props['aria-expanded'], true);
    tutor.saveProvider = async () => { throw Error('连接设置未保存'); };
    c.add().props.onClick(); await c.flush();
    assert.equal(c.summaries().length, 3); assert.equal(c.summaries().at(-1).props['aria-expanded'], true);
    assert.ok(c.nodes().some(n => n.props?.role === 'alert' && n.props.children.includes('连接设置未保存')));
});

const content = node => Array.isArray(node) ? node.map(content).join('') : typeof node === 'string' ? node : node && typeof node === 'object' ? content(node.props?.children) : '';
const field = (c, name) => {
    const label = c.nodes().find(n => n.type === 'label' && content(n.props.children[0]).startsWith(name));
    assert.ok(label, `missing field: ${name}`);
    const control = walk(label).find(n => n.type === 'input' || n.type === 'button' && n.props['aria-haspopup'] === 'menu');
    assert.ok(control, `missing control: ${name}`); return control;
};
const anchor = () => ({ isConnected: true, focusCount: 0, focus() { this.focusCount++; }, contains() { return false; },
    getBoundingClientRect() { return { top: 100, bottom: 136, left: 100, right: 388 }; } });
const change = (c, name, value) => {
    const control = field(c, name);
    if (control.type === 'input') control.props.onChange({ target: { value } });
    else {
        const connection = c.nodes().find(n => n.props?.className === 'nodu-ai-connection-trigger');
        if (!connection.props['aria-expanded']) { connection.props.onClick(); c.render(); }
        field(c, name).props.onClick({ currentTarget: anchor() }); c.render();
        const option = c.nodes().find(n => n.props?.role === 'menuitemradio' && n.props.value === value);
        assert.ok(option, `missing menu option: ${value}`); option.props.onClick();
    }
    c.render();
};
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const dialog = c => c.nodes().find(n => typeof n.type === 'function' && n.type.name === 'ModelDialog');

test('model and provider switches do not save hidden connection drafts; explicit connection save does', async () => {
    const saved = [], p = provider('custom'), tutor = { settings: { providers: [p] }, saveProvider: async value => { saved.push(value); } }, c = mountDetail(tutor, p);
    change(c, '供应商名称', 'Draft name'); change(c, 'Base URL', 'https://draft.invalid/v1'); change(c, 'API 格式', 'responses');
    // Close the connection disclosure after editing its fields.
    const trigger = c.nodes().find(n => n.props?.className === 'nodu-ai-connection-trigger');
    if (trigger.props['aria-expanded']) { trigger.props.onClick(); c.render(); }
    assert.equal(c.nodes().find(n => n.props?.className === 'nodu-ai-connection-fields').props.hidden, true);
    c.nodes().find(n => n.props?.label === '停用模型').props.onChange(false); await c.flush();
    c.nodes().find(n => n.props?.label === '停用供应商').props.onChange(false); await c.flush();
    assert.equal(saved.length, 2);
    for (const value of saved) {
        assert.equal(value.name, p.name); assert.equal(value.baseUrl, p.baseUrl); assert.equal(value.apiFormat, p.apiFormat);
    }
    assert.equal(saved[0].models[0].enabled, false); assert.equal(saved[1].enabled, false);
    c.nodes().find(n => n.props?.className === 'nodu-ai-connection-trigger').props.onClick(); c.render();
    const actions = c.nodes().find(n => n.props?.className === 'nodu-ai-form-actions');
    walk(actions).find(n => n.type === 'button' && content(n) === '保存').props.onClick(); await c.flush();
    assert.equal(saved[2].name, 'Draft name'); assert.equal(saved[2].baseUrl, 'https://draft.invalid/v1'); assert.equal(saved[2].apiFormat, 'responses');
});

test('updated provider props refresh clean connection fields while preserving user edits', () => {
    const p = provider('custom'), tutor = { settings: { providers: [p] } }, c = mountDetail(tutor, p);
    change(c, '供应商名称', 'Unsaved name');
    c.setProvider({ ...p, name: 'Name saved elsewhere', baseUrl: 'https://new.invalid/v1', apiFormat: 'responses' });
    assert.equal(field(c, '供应商名称').props.value, 'Unsaved name');
    assert.equal(field(c, 'Base URL').props.value, 'https://new.invalid/v1');
    assert.equal(field(c, 'API 格式').props.value, 'responses');
    change(c, 'Base URL', 'https://draft.invalid/v1');
    c.setProvider({ ...p, name: 'New remote name', baseUrl: 'https://newer.invalid/v1', apiFormat: 'anthropic-messages' });
    assert.equal(field(c, '供应商名称').props.value, 'Unsaved name');
    assert.equal(field(c, 'Base URL').props.value, 'https://draft.invalid/v1');
    assert.equal(field(c, 'API 格式').props.value, 'anthropic-messages');
});

test('remote models finishing in a collapsed provider cannot mount a hidden modal; opening mounts it once visible', async () => {
    const gate = deferred(), p = provider('custom'), tutor = { settings: { providers: [p] }, listRemoteModels: async () => gate.promise }, c = mountDetail(tutor, p);
    c.nodes().find(n => n.type === 'button' && content(n) === '获取模型').props.onClick(); c.render();
    c.setVisible(false); gate.resolve([{ id: 'remote-model' }]); await c.flush();
    assert.equal(dialog(c), undefined, 'a hidden provider must not mount/focus a modal');
    c.setVisible(true);
    assert.ok(dialog(c), 'showing the provider mounts the requested dialog so its real focus effect can run');
    assert.equal(dialog(c).props.remote[0].id, 'remote-model');
    c.setVisible(false); assert.equal(dialog(c), undefined);
});

test('key save is synchronously exclusive and a late save cannot clear newer input', async () => {
    const gate = deferred(), calls = [], p = provider('custom'), tutor = { settings: { providers: [p] }, setProviderKey: async (...args) => { calls.push(args); return gate.promise; } }, c = mountDetail(tutor, p);
    assert.equal(c.nodes().some(n => n.type === 'button' && n.props['aria-label'] === '显示'), false);
    change(c, 'API Key', 'first-test-value');
    c.nodes().find(n => n.type === 'button' && n.props['aria-label'] === '显示').props.onClick(); c.render();
    assert.equal(field(c, 'API Key').props.type, 'text');
    const enter = field(c, 'API Key').props.onKeyDown, event = { key: 'Enter', preventDefault() {} };
    enter(event); enter(event); c.render();
    assert.equal(calls.length, 1, 'two Enter events before React renders must not submit twice');
    change(c, 'API Key', 'second-test-value');
    assert.equal(field(c, 'API Key').props.type, 'password', 'editing always hides the new value');
    field(c, 'API Key').props.onKeyDown(event); c.render();
    assert.equal(calls.length, 1, 'pending save also blocks Enter after a rerender');
    gate.resolve(); await c.flush();
    assert.equal(field(c, 'API Key').props.value, 'second-test-value', 'the first save must preserve newer unsaved input');
    assert.equal(field(c, 'API Key').props.type, 'password');
    field(c, 'API Key').props.onKeyDown(event); await c.flush();
    assert.equal(calls.length, 2); assert.equal(calls[1][1], 'second-test-value');
    assert.equal(field(c, 'API Key').props.value, '');
    assert.equal(c.nodes().some(n => n.type === 'button' && ['显示', '隐藏'].includes(n.props['aria-label'])), false);
});

test('API format opens a checked custom menu by keyboard and closes when its provider is hidden', () => {
    const p = provider('custom'), c = mountDetail({ settings: { providers: [p] } }, p), trigger = anchor();
    c.nodes().find(n => n.props?.className === 'nodu-ai-connection-trigger').props.onClick(); c.render();
    const event = { key: 'ArrowDown', currentTarget: trigger, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    field(c, 'API 格式').props.onKeyDown(event); c.render();
    assert.equal(event.prevented && event.stopped, true);
    const popup = c.nodes().find(n => n.type === c.runtime.controls.ChatPopover);
    assert.equal(popup.props.layer, 'settings');
    assert.equal(c.nodes().find(n => n.props?.role === 'menuitemradio' && n.props['aria-checked']).props.value, p.apiFormat);
    c.nodes().find(n => n.props?.role === 'menuitemradio' && n.props.value === 'responses').props.onClick(); c.render();
    assert.equal(field(c, 'API 格式').props.value, 'responses');
    assert.equal(field(c, 'API 格式').props['aria-expanded'], false);
    assert.equal(trigger.focusCount, 1);
    field(c, 'API 格式').props.onClick({ currentTarget: trigger }); c.render();
    c.setVisible(false); c.setVisible(true);
    assert.equal(c.nodes().some(n => n.type === c.runtime.controls.ChatPopover), false);
    assert.equal(field(c, 'API 格式').props.value, 'responses', 'closing the menu retains the unsaved draft');
    const builtIn = provider('builtin', 'builtin'), locked = mountDetail({ settings: { providers: [builtIn] } }, builtIn);
    assert.equal(field(locked, 'API 格式').props.disabled, true);
});

test('model IDs remain editable and remote candidates search, select and fill reported context through real callbacks', async () => {
    const saved = [], p = provider('custom'), remote = [{ id: 'test-model' }, { id: 'Alpha', contextWindow: 32000 }, { id: 'Beta', contextWindow: 64000 }];
    const tutor = { settings: { providers: [p] }, listRemoteModels: async () => remote, saveProvider: async value => saved.push(value) };
    const c = mountDetail(tutor, p);
    c.nodes().find(n => n.type === 'button' && content(n) === '获取模型').props.onClick(); await c.flush();
    const editor = c.mountChild(dialog(c)), trigger = anchor();
    assert.equal(editor.nodes().some(n => n.type === 'select' || n.type === 'datalist' || n.props?.list), false);
    assert.equal(editor.nodes().some(n => n.props?.placeholder || n.props?.className?.includes('nodu-ai-help')), false);
    change(editor, '模型 ID', 'manual-model');
    assert.equal(field(editor, '模型 ID').props.value, 'manual-model');
    editor.nodes().find(n => n.props?.['aria-label'] === '选择模型 ID').props.onClick({ currentTarget: trigger }); editor.render();
    let choices = editor.nodes().filter(n => n.props?.role === 'menuitemradio');
    assert.deepEqual(choices.map(content), ['Alpha', 'Beta'], 'existing model IDs are excluded from candidates');
    const search = editor.nodes().find(n => n.props?.['aria-label'] === '搜索模型 ID');
    search.props.onChange({ target: { value: 'BETA' } }); editor.render();
    choices = editor.nodes().filter(n => n.props?.role === 'menuitemradio');
    assert.deepEqual(choices.map(content), ['Beta']);
    choices[0].props.onClick(); editor.render();
    assert.equal(field(editor, '模型 ID').props.value, 'Beta');
    assert.equal(field(editor, '上下文窗口').props.value, 64000);
    assert.equal(trigger.focusCount, 1);
    assert.equal(editor.nodes().some(n => n.props?.role === 'menuitemradio'), false);
    editor.nodes().find(n => n.type === 'button' && content(n) === '添加').props.onClick(); await editor.flush();
    assert.equal(saved[0].models.at(-1).id, 'Beta'); assert.equal(saved[0].models.at(-1).contextWindow, 64000);
});

test('provider forms retain real key status and model validation without instructional copy', async () => {
    const p = { ...provider('custom'), hasKey: true, models: [] }, c = mountDetail({ settings: { providers: [p] } }, p);
    assert.ok(c.nodes().some(n => n.props?.className === 'nodu-ai-key-status' && content(n) === '已设置'));
    assert.equal(c.nodes().some(n => n.type === 'select' || n.type === 'datalist' || n.props?.placeholder || n.props?.className?.includes('nodu-ai-help')), false);
    assert.equal(content(c.nodes()[0]).includes('还没有模型'), false);
    c.nodes().find(n => n.type === 'button' && content(n) === '添加模型').props.onClick(); c.render();
    const editor = c.mountChild(dialog(c));
    assert.equal(editor.nodes().some(n => n.props?.['aria-label'] === '选择模型 ID'), false);
    editor.nodes().find(n => n.type === 'button' && content(n) === '添加').props.onClick(); await editor.flush();
    assert.ok(editor.nodes().some(n => n.props?.role === 'alert' && content(n) === '请输入模型 ID'));
});

test('settings popover owns arrow navigation and Portal Escape/Tab events, returning focus to its trigger', () => {
    for (const exit of ['Escape', 'Tab']) {
        const r = runtime(), trigger = anchor(); let closed = 0;
        const search = new r.HTMLInputElement(); search.focus = () => { r.document.activeElement = search; };
        const items = Array.from({ length: 3 }, () => ({ focus() { r.document.activeElement = this; } }));
        const node = { style: {}, contains: target => target === search || items.includes(target),
            getBoundingClientRect: () => ({ width: 288, height: 160 }),
            querySelector: selector => selector === 'input' ? search : items[0], querySelectorAll: () => items };
        const c = r.mountComponent(r.controls.ChatPopover, () => ({ anchor: trigger, label: '模型 ID', layer: 'settings', close: () => closed++ }),
            tree => { tree.props.ref.current = node; });
        const menu = c.nodes().find(n => n.props?.role === 'menu');
        assert.match(menu.props.className, /nodu-ai-popover-settings/);
        assert.equal(r.document.activeElement, search);
        const key = value => { const event = { key: value, target: r.document.activeElement, prevented: false, stopped: false,
            preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } }; menu.props.onKeyDown(event); return event; };
        key('ArrowUp'); assert.equal(r.document.activeElement, items[2]);
        key('ArrowDown'); assert.equal(r.document.activeElement, items[0]);
        key('End'); assert.equal(r.document.activeElement, items[2]);
        key('Home'); assert.equal(r.document.activeElement, items[0]);
        const event = key(exit);
        assert.equal(event.prevented && event.stopped, true, 'the parent dialog must not receive the Portal keyboard event');
        assert.equal(closed, 1); assert.equal(trigger.focusCount, 1);
    }
    const css = fs.readFileSync(path.join(__dirname, '../style/ai-provider-settings.css'), 'utf8');
    const zIndex = css.match(/\.nodu-ai-popover\.nodu-ai-popover-settings\s*\{\s*z-index:\s*(\d+)/);
    assert.ok(Number(zIndex?.[1]) > 10020, 'the portal must appear above the settings backdrop');
});
