// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/browser/nodu-professional-settings.tsx'), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, experimentalDecorators: true } }).outputText;
const walk = root => { const out = []; const visit = x => { if (Array.isArray(x)) x.forEach(visit); else if (x && typeof x === 'object') { out.push(x); visit(x.props?.children); } }; visit(root); return out; };
const text = node => (node?.props?.children ?? []).flat(Infinity).map(child => typeof child === 'object' ? text(child) : child ?? '').join('');
class Emitter { callbacks = new Set(); event = callback => { this.callbacks.add(callback); return { dispose: () => this.callbacks.delete(callback) }; }; fire() { for (const fn of [...this.callbacks]) fn(); } }
class DisposableCollection { items = []; push(item) { this.items.push(item); } dispose() { this.items.splice(0).forEach(item => item.dispose()); } }
class Element { inert = false; isConnected = true; focus() { this.focused = (this.focused || 0) + 1; } }
class Service {}
const AISettingsPanel = () => null, MinimalThemeIcon = () => null;
const baseModules = {
    '@theia/core/shared/inversify': { injectable: () => value => value, inject: () => () => {} },
    '@theia/core/lib/common': { Emitter, DisposableCollection, CommandService: Service, MessageService: Service },
    '@theia/core/lib/common/preferences/preference-service': { PreferenceService: Service },
    '@theia/core/lib/common/preferences/preference-scope': { PreferenceScope: { User: 1 } },
    '@theia/core/lib/common/theme': { getThemeMode: type => type },
    '@theia/core/lib/browser/theming': { ThemeService: Service },
    '@theia/editor/lib/browser': { EditorManager: Service },
    './scope-layout-state': { ScopeLayoutState: Service },
    './scope-theme': { SCOPE_LIGHT_THEME_ID: 'scope-light', SCOPE_THEME_ID: 'scope-dark' },
    './nodu-tutor-model': { NoduTutorModel: Service },
    './nodu-ai-provider-settings': { AISettingsPanel },
    './nodu-minimal-preferences': { MinimalThemeIcon }
};
function load(modules = {}, globals = {}) {
    const exports = {};
    vm.runInNewContext(code, { exports, require: id => modules[id] ?? baseModules[id] ?? {}, Element, HTMLElement: Element, ...globals });
    return exports;
}
function service() {
    const roots = [], renders = [], background = new Element(), prior = new Element(), anchor = new Element(); prior.inert = true;
    const document = { activeElement: anchor, body: { children: [background, prior], appendChild(node) { this.children.push(node); } },
        createElement() { const node = new Element(); node.remove = () => { node.isConnected = false; document.body.children = document.body.children.filter(x => x !== node); }; return node; } };
    const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const exports = load({ '@theia/core/shared/react': React, '@theia/core/shared/react-dom/client': { createRoot: host => { const root = { host, render: node => renders.push(node), unmount() { this.unmounted = true; } }; roots.push(root); return root; } } }, { document });
    const value = new exports.NoduProfessionalSettings(), layoutEvent = new Emitter(), preferencesEvent = new Emitter(), themeEvent = new Emitter(), tutorEvent = new Emitter(), calls = [];
    value.layout = { mode: 'pro', projectPath: '/one', onDidChange: layoutEvent.event, setDeviceOpen: open => calls.push(['device', open]) };
    value.tutor = { autoReview: true, onDidChange: tutorEvent.event, refreshSettings: async () => calls.push(['refresh-settings']) };
    value.preferences = { onPreferenceChanged: preferencesEvent.event, get: (_, fallback) => fallback, set: async (...args) => calls.push(['preference', ...args]) };
    value.themes = { onDidColorThemeChange: themeEvent.event, getCurrentTheme: () => ({ type: 'light' }), setCurrentTheme: theme => calls.push(['theme', theme]) };
    value.commands = { executeCommand: async id => calls.push(['command', id]) };
    value.editors = { currentEditor: { activate: () => calls.push(['editor']) } }; value.messages = { error: text => calls.push(['error', text]) };
    return { value, roots, renders, background, prior, anchor, layoutEvent, preferencesEvent, themeEvent, tutorEvent, calls, document, exports };
}
test('one professional modal handles gear and AI deep link without creating another root or reading keys', () => {
    const c = service(); c.value.open('general', c.anchor);
    assert.equal(c.value.isOpen, true); assert.equal(c.roots.length, 1); assert.equal(c.renders.at(-1).props.page, 'general');
    assert.equal(c.background.inert, true); assert.equal(c.prior.inert, true);
    assert.deepEqual(c.calls, [['device', false], ['refresh-settings']]);
    c.value.open('ai'); assert.equal(c.roots.length, 1); assert.equal(c.renders.at(-1).props.page, 'ai');
    c.value.close(); assert.equal(c.roots[0].unmounted, true); assert.equal(c.value.isOpen, false);
    assert.equal(c.background.inert, false); assert.equal(c.prior.inert, true); assert.equal(c.anchor.focused, 1);
    for (const events of [c.layoutEvent, c.preferencesEvent, c.themeEvent, c.tutorEvent]) assert.equal(events.callbacks.size, 0);
    c.value.layout.mode = 'simple'; c.value.open('ai'); assert.equal(c.roots.length, 1, 'simple mode never mounts the professional AI manager');
});
test('professional controls use the existing user preferences and layout commands; project/mode changes close safely', async () => {
    const c = service(); c.value.open(); const props = c.renders.at(-1).props;
    props.onTheme('dark'); await props.onFontSize(16); await props.onAutoSave(true); await props.onWordWrap(true); await props.onTabSize(2); await props.onMode('simple');
    assert.deepEqual(c.calls.slice(2), [['theme','scope-dark'], ['preference','editor.fontSize',16,1], ['preference','files.autoSave','afterDelay',1], ['preference','editor.wordWrap','on',1], ['preference','editor.tabSize',2,1], ['command','scope.layout.simple'], ['editor']]);
    c.value.layout.projectPath = '/two'; c.layoutEvent.fire(); assert.equal(c.value.isOpen, false); assert.equal(c.anchor.focused, undefined);
    c.value.open(); c.value.layout.mode = 'simple'; c.layoutEvent.fire(); assert.equal(c.value.isOpen, false); assert.equal(c.background.inert, false);
});
test('closed modal releases subscriptions and reopening starts with fresh rendering', () => {
    const c = service(); c.value.open(); c.value.close(); const count = c.renders.length;
    c.preferencesEvent.fire(); c.themeEvent.fire(); c.tutorEvent.fire(); assert.equal(c.renders.length, count);
    c.value.open('ai'); assert.equal(c.roots.length, 2); c.preferencesEvent.fire(); assert.equal(c.renders.length, count + 2);
});
function component(overrides = {}) {
    let cursor = 0, tree, dead = false, late = 0; const slots = [], effects = [], calls = [];
    const doc = { activeElement: null };
    const same = (a, b) => a && b && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
    const effect = (fn, deps) => { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) { const old = slots[index]; slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = fn(); }); } };
    const React = { Fragment: 'fragment', createElement(type, props, ...children) {
        const node = { type, props: { ...props, children } }, dom = props?.ref?.current || new Element();
        Object.assign(dom, { node, ownerDocument: doc, focus() { doc.activeElement = dom; },
            contains(target) { return walk(node).some(x => x.dom === target); },
            closest(selector) { if (selector === '[hidden]') return walk(tree).find(x => x.props.hidden && walk(x).includes(node))?.dom; return dialog()?.dom; },
            querySelector(selector) { const nodes = walk(node); return selector.includes('id=') ? nodes.find(x => selector.includes(x.props.id) && x.props.id)?.dom : nodes.find(x => x.props.role === 'tab' && x.props['aria-selected'])?.dom; },
            querySelectorAll() { return walk(node).filter(x => x.type === 'button' && !x.props.disabled && x.props.tabIndex !== -1).map(x => x.dom); }
        }); node.dom = dom; if (props?.ref) props.ref.current = dom; return node;
    }, useId() { cursor++; return 'settings'; }, useRef(value) { const index = cursor++; return slots[index] ??= { current: value }; },
        useState(value) { const index = cursor++; if (!(index in slots)) slots[index] = value; return [slots[index], next => { if (dead) late++; slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; }, useLayoutEffect: effect };
    const { ProfessionalSettingsDialog } = load({ '@theia/core/shared/react': React });
    const props = { tutor: { autoReview: true, setDisplay: (...args) => calls.push(['display', ...args]) }, page: 'general', onPage(page) { props.page = page; }, close: () => calls.push(['close']), allSettings: () => calls.push(['all']), theme: 'light', mode: 'pro', fontSize: 14, autoSave: false, wordWrap: false, tabSize: 4,
        onTheme: value => calls.push(['theme', value]), onMode: value => calls.push(['mode', value]), onFontSize: value => calls.push(['font', value]), onAutoSave: value => calls.push(['save', value]), onWordWrap: value => calls.push(['wrap', value]), onTabSize: value => calls.push(['tab', value]), ...overrides };
    const render = () => { cursor = 0; tree = ProfessionalSettingsDialog(props); effects.splice(0).forEach(fn => fn()); return tree; };
    const dialog = () => walk(tree).find(x => x.props?.role === 'dialog');
    const button = label => walk(tree).find(x => x.type === 'button' && (x.props['aria-label'] || text(x)) === label);
    const key = (key, shiftKey = false, target = dialog().dom) => { const e = { key, shiftKey, target, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() {} }; dialog().props.onKeyDown(e); return e; };
    render();
    return { props, calls, render, dialog, button, key, doc, tree: () => tree, flush: async () => { for (let i = 0; i < 3; i++) { await new Promise(setImmediate); if (!dead) render(); } },
        unmount() { dead = true; slots.forEach(x => x?.cleanup?.()); }, get late() { return late; } };
}
test('general and AI tabs share a dialog, reuse the provider component and keep one selected keyboard tab', () => {
    const c = component(); assert.equal(c.doc.activeElement, c.button('通用').dom);
    assert.equal(walk(c.tree()).filter(x => x.type === AISettingsPanel).length, 1);
    assert.equal(walk(c.tree()).filter(x => x.props?.role === 'tab' && x.props.tabIndex === 0).length, 1);
    c.button('AI').props.onClick(); c.render(); assert.equal(c.button('AI').props['aria-selected'], true);
    assert.equal(walk(c.tree()).find(x => x.props.id === 'settings-general').props.hidden, true);
    c.button('逐行 AI 检查').props.onClick(); assert.deepEqual(c.calls, [['display','autoReview',false]]);
});
test('Escape, outside clicks and focus wrap work; nested model dialogs retain their keyboard ownership', () => {
    const c = component(); const controls = c.dialog().dom.querySelectorAll().filter(x => !x.closest('[hidden]'));
    controls.at(-1).focus(); assert.equal(c.key('Tab').prevented, true); assert.equal(c.doc.activeElement, controls[0]);
    controls[0].focus(); assert.equal(c.key('Tab', true).prevented, true); assert.equal(c.doc.activeElement, controls.at(-1));
    const nested = new Element(); nested.closest = () => nested; c.key('Escape', false, nested); assert.deepEqual(c.calls, []);
    assert.equal(c.key('Escape').prevented, true); assert.deepEqual(c.calls, [['close']]);
    const backdrop = c.tree(); backdrop.props.onPointerDown({ target: {}, currentTarget: backdrop }); assert.equal(c.calls.length, 1);
    backdrop.props.onPointerDown({ target: backdrop, currentTarget: backdrop, preventDefault() {} }); assert.equal(c.calls.length, 2);
});
test('rapid changes cannot overlap; failed changes can retry and late failures do not update an unmounted modal', async () => {
    let reject, count = 0; const held = new Promise((_, no) => { reject = no; });
    const c = component({ onTheme: () => { count++; return held; } });
    c.button('暗色').props.onClick(); c.button('暗色').props.onClick(); c.button('自动保存').props.onClick(); assert.equal(count, 1); assert.deepEqual(c.calls, []);
    reject(Error('failure')); await c.flush(); assert.equal(walk(c.tree()).filter(x => x.props?.role === 'alert').length, 1);
    c.button('自动保存').props.onClick(); await c.flush(); assert.deepEqual(c.calls, [['save',true]]);
    let rejectLate; const late = component({ onTheme: () => new Promise((_, no) => { rejectLate = no; }) }); late.button('暗色').props.onClick(); late.unmount(); rejectLate(Error('late')); await late.flush(); assert.equal(late.late, 0);
});
test('real markup uses modal/tab semantics and stylesheet constrains small viewports without transforming nested dialogs', () => {
    const React = require('@theia/core/shared/react'), { renderToStaticMarkup } = require('react-dom/server');
    const { ProfessionalSettingsDialog } = load({ '@theia/core/shared/react': React });
    const props = component().props; const markup = renderToStaticMarkup(React.createElement(ProfessionalSettingsDialog, props));
    assert.match(markup, /aria-modal="true"/); assert.match(markup, /role="tablist"/); assert.match(markup, /aria-orientation="vertical"/); assert.match(markup, /role="tabpanel"/);
    assert.equal((markup.match(/role="dialog"/g) || []).length, 1);
    const css = fs.readFileSync(path.join(__dirname,'../style/professional-settings.css'),'utf8');
    assert.match(css, /width: min\(760px, 100%\)/); assert.match(css, /height: 560px/); assert.match(css, /max-height: 100%/); assert.match(css, /\.scope-widget\.nodu-professional-settings/); assert.match(css, /@media \(max-width: 520px\)/); assert.doesNotMatch(css, /transform:/);
});

test('legacy AI settings command routes to the unified AI page and never opens a separate popover', () => {
    const input = fs.readFileSync(path.join(__dirname, '../src/browser/nodu-ai-settings.tsx'), 'utf8');
    const exports = {}, calls = [];
    const compiled = ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, experimentalDecorators: true } }).outputText;
    vm.runInNewContext(compiled, { exports, require: id => id === '@theia/core/lib/browser/shell/sidebar-bottom-menu-widget' ? { SidebarBottomMenuWidget: Service } : baseModules[id] ?? {}, HTMLElement: Element });
    const facade = new exports.NoduAiSettingsPopover(), anchor = new Element();
    facade.settings = { open: (...args) => calls.push(args), close: value => calls.push(['close', value]) };
    facade.toggle(anchor); facade.close();
    assert.deepEqual(calls, [['ai', anchor], ['close', false]]);
});

test('vertical settings navigation changes only pages with Up/Down/Home/End and keeps the selected tab focused', () => {
    const c = component();
    const navKey = (label, key) => { const event = { key, preventDefault() { this.prevented = true; }, stopPropagation() {} }; c.button(label).props.onKeyDown(event); return event; };
    assert.equal(navKey('通用', 'ArrowDown').prevented, true); assert.equal(c.props.page, 'ai'); assert.equal(c.doc.activeElement, c.button('AI').dom); c.render();
    assert.equal(c.button('AI').props.tabIndex, 0); assert.equal(c.button('通用').props.tabIndex, -1);
    navKey('AI', 'ArrowUp'); assert.equal(c.props.page, 'general'); c.render();
    navKey('通用', 'End'); assert.equal(c.props.page, 'ai'); c.render();
    navKey('AI', 'Home'); assert.equal(c.props.page, 'general'); c.render();
    assert.equal(navKey('通用', 'ArrowRight').prevented, undefined); assert.equal(c.props.page, 'general');
});
