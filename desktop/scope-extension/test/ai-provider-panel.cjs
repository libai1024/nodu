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
        useEffect: effect, useLayoutEffect: effect,
    };
    const exports = {};
    vm.runInNewContext(code, { exports, Error, require: id => id === '@theia/core/shared/react' ? react : id.endsWith('tutor-ai-config') ? require('../lib/common/tutor/tutor-ai-config') : {} });
    const mountComponent = (component, props) => {
        const instance = { slots: [], cursor: 0, effects: [], dirty: false }; let tree;
        const render = () => {
            let count = 0;
            do {
                assert.ok(++count < 20, 'effects must settle without a render loop');
                instance.cursor = 0; instance.effects = []; instance.dirty = false;
                current = instance;
                try { tree = component(props()); } finally { current = undefined; }
                for (const run of instance.effects) run();
            } while (instance.dirty);
            return tree;
        };
        render();
        return { render, nodes: () => walk(tree), async flush() { for (let i = 0; i < 3; i++) { await new Promise(r => setImmediate(r)); render(); } } };
    };
    return { exports, mountComponent };
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
    return { ...c, setProvider(provider) { props = { ...props, provider }; c.render(); }, setVisible(visible) { props = { ...props, visible }; c.render(); } };
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
    const control = walk(label).find(n => n.type === 'input' || n.type === 'select');
    assert.ok(control, `missing control: ${name}`); return control;
};
const change = (c, name, value) => { field(c, name).props.onChange({ target: { value } }); c.render(); };
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
    c.nodes().find(n => n.type === 'button' && n.props.title === '从供应商读取可用模型 ID').props.onClick(); c.render();
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
