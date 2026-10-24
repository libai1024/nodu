// SPDX-License-Identifier: MIT
// Test production component callbacks and focus rules; Electron covers rendering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

function setup(overrides = {}) {
    const listeners = new Map(), slots = [], effects = [], calls = [], observers = [];
    const anchor = { right: 780, top: 36, bottom: 64 };
    let cursor = 0, tree, dead = false, lateUpdates = 0;
    const walk = root => { const result = []; const visit = node => { if (Array.isArray(node)) { node.forEach(visit); } else if (node && typeof node === 'object') { result.push(node); visit(node.props?.children); } }; visit(root); return result; };
    const doc = { body: {}, documentElement: { clientWidth: 800, clientHeight: 600 }, activeElement: null,
        addEventListener(type, fn) { let group = listeners.get(type); if (!group) { listeners.set(type, group = new Set()); } group.add(fn); },
        removeEventListener(type, fn) { listeners.get(type)?.delete(fn); } };
    doc.defaultView = { addEventListener: doc.addEventListener, removeEventListener: doc.removeEventListener };
    const same = (a, b) => a && b && a.length === b.length && a.every((item, index) => Object.is(item, b[index]));
    const effect = (fn, deps) => { const index = cursor++; if (!slots[index] || !same(slots[index].deps, deps)) { const old = slots[index]; slots[index] = { deps, cleanup: old?.cleanup }; effects.push(() => { old?.cleanup?.(); slots[index].cleanup = fn(); }); } };
    const React = {
        Fragment: 'fragment',
        createElement(type, props, ...children) {
            const element = { type, props: { ...props, children } };
            const dom = props?.ref?.current || {};
            Object.assign(dom, { node: element, ownerDocument: doc, scrollHeight: 270, focus() {
                const card = walk(tree).find(node => node.props?.role === 'dialog');
                if (card?.props.style?.visibility === 'hidden' && card.dom.contains(this)) { return; }
                doc.activeElement = this;
            },
                getBoundingClientRect: () => ({ ...anchor }),
                contains(target) { return walk(this.node).some(node => node.dom === target); },
                querySelector() { return walk(this.node).find(node => node.type === 'button' && node.props['aria-pressed'])?.dom || walk(this.node).find(node => node.type === 'button')?.dom; },
                querySelectorAll() { return walk(this.node).filter(node => node.type === 'button' && !node.props.disabled).map(node => node.dom); }
            });
            element.dom = dom;
            if (props?.ref) { props.ref.current = dom; }
            return element;
        },
        useId() { cursor++; return 'preferences'; },
        useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
        useState(initial) { const index = cursor++; if (!(index in slots)) { slots[index] = initial; } return [slots[index], next => { if (dead) { lateUpdates++; } slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
        useEffect: effect, useLayoutEffect: effect
    };
    const exports = {};
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/browser/nodu-minimal-preferences.js'), 'utf8'), {
        exports, require: name => name === '@theia/core/shared/react' ? React : name === 'react-dom' ? { createPortal: element => element } : {},
        Error, Promise, String, Number, Math, Array,
        ResizeObserver: class {
            nodes = new Set();
            constructor(callback) { this.callback = callback; observers.push(this); }
            observe(node) { this.nodes.add(node); }
            disconnect() { this.nodes.clear(); this.disconnected = true; }
        }
    });
    const props = {
        theme: 'light', mode: 'simple', fontSize: 14, autoSave: false, wordWrap: false, tabSize: 4, scopeKey: 'project-a',
        onTheme: value => { calls.push(['theme', value]); props.theme = value; },
        onMode: value => { calls.push(['mode', value]); props.mode = value; },
        onFontSize: value => { calls.push(['font', value]); props.fontSize = value; },
        onAutoSave: value => { calls.push(['save', value]); props.autoSave = value; },
        onWordWrap: value => { calls.push(['wrap', value]); props.wordWrap = value; },
        onTabSize: value => { calls.push(['tab', value]); props.tabSize = value; },
        onAllSettings: () => calls.push(['all']), onOpen: () => calls.push(['open']), ...overrides
    };
    const render = () => { cursor = 0; tree = exports.NoduMinimalPreferences(props); for (const run of effects.splice(0)) { run(); } return tree; };
    const text = node => (node?.props?.children ?? []).flat(Infinity).map(child => typeof child === 'object' ? text(child) : child ?? '').join('');
    const nodes = () => walk(tree);
    const button = label => nodes().find(node => node.type === 'button' && (node.props['aria-label'] || text(node)) === label);
    const panel = () => nodes().find(node => node.props?.role === 'dialog');
    const flush = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setImmediate(resolve)); if (!dead) { render(); } } };
    const keyboard = (key, shiftKey = false) => { const event = { key, shiftKey, nativeEvent: {}, preventDefault() { this.prevented = true; }, stopPropagation() {} }; panel().props.onKeyDown(event); return event; };
    render();
    return { props, calls, render, nodes, button, panel, flush, keyboard, doc, exports, anchor, observers,
        show() { button('设置').props.onClick(); render(); render(); },
        emit(type, event) { for (const listener of listeners.get(type) || []) { listener(event); } },
        unmount() { dead = true; for (const slot of slots) { slot?.cleanup?.(); } }, get lateUpdates() { return lateUpdates; }
    };
}

test('closed gear exposes no settings until requested and all choices are controlled', async () => {
    const c = setup(); assert.equal(c.panel(), undefined); c.show();
    assert.equal(c.button('明亮').props['aria-pressed'], true);
    c.button('暗色').props.onClick(); await c.flush(); assert.equal(c.button('暗色').props['aria-pressed'], true);
    c.button('自动换行').props.onClick(); await c.flush(); assert.equal(c.button('自动换行').props['aria-checked'], true);
    c.button('2').props.onClick(); await c.flush(); assert.equal(c.button('2').props['aria-pressed'], true);
    c.button('专业').props.onClick(); await c.flush(); assert.equal(c.button('专业').props['aria-pressed'], true);
    assert.deepEqual(c.calls, [['open'], ['theme', 'dark'], ['wrap', true], ['tab', 2], ['mode', 'pro']]);
});

test('Escape restores the gear and Tab remains inside the popover', () => {
    const c = setup(); c.show(); const buttons = c.panel().dom.querySelectorAll();
    buttons.at(-1).focus(); assert.equal(c.keyboard('Tab').prevented, true); assert.equal(c.doc.activeElement, buttons[0]);
    buttons[0].focus(); assert.equal(c.keyboard('Tab', true).prevented, true); assert.equal(c.doc.activeElement, buttons.at(-1));
    c.keyboard('Escape'); const gear = c.button('设置').dom; c.render(); assert.equal(c.panel(), undefined); assert.equal(c.doc.activeElement, gear);
});

test('first focus waits for the measured popover to become visible and resize does not steal focus', () => {
    const c = setup(); const gear = c.button('设置').dom; gear.focus(); c.button('设置').props.onClick(); c.render();
    assert.equal(c.panel().props.style.visibility, 'hidden'); assert.equal(c.doc.activeElement, gear);
    c.render(); assert.equal(c.panel().props.style.visibility, 'visible'); assert.equal(c.doc.activeElement, c.button('明亮').dom);
    const control = c.button('自动保存').dom; control.focus(); c.emit('resize', {}); c.render(); assert.equal(c.doc.activeElement, control);
});

test('outside click closes without stealing focus from another editor', () => {
    const c = setup(); c.show(); const editor = {}; c.doc.activeElement = editor; c.emit('pointerdown', { target: editor }); c.render();
    assert.equal(c.panel(), undefined); assert.equal(c.doc.activeElement, editor);
});

test('rapid settings clicks never overlap and failures allow retry', async () => {
    const held = defer(); let attempts = 0;
    const c = setup({ onTheme() { attempts++; return held.promise; } }); c.show();
    c.button('暗色').props.onClick(); c.button('暗色').props.onClick(); c.button('自动保存').props.onClick(); c.render();
    assert.equal(attempts, 1); assert.equal(c.props.autoSave, false); assert.equal(c.panel().props['aria-busy'], true);
    held.reject(new Error('private implementation error')); await c.flush();
    assert.equal(c.panel().props['aria-busy'], false); assert.equal(c.nodes().filter(node => node.props?.role === 'alert').length, 1);
    c.button('自动保存').props.onClick(); await c.flush(); assert.equal(c.props.autoSave, true); assert.equal(c.nodes().filter(node => node.props?.role === 'alert').length, 0);
});

test('project changes close immediately and discard a late rejected preference response', async () => {
    const held = defer(); const c = setup({ onTheme: () => held.promise }); c.show(); c.button('暗色').props.onClick();
    c.props.scopeKey = 'project-b'; c.render(); assert.equal(c.panel(), undefined);
    held.reject(new Error('late failure')); await c.flush(); c.show(); assert.equal(c.nodes().filter(node => node.props?.role === 'alert').length, 0);
});

test('font sizes stay in range and opening full settings closes the card', async () => {
    const c = setup({ fontSize: 40 }); c.show(); assert.equal(c.button('增大字号').props.disabled, true);
    c.button('减小字号').props.onClick(); await c.flush(); assert.equal(c.props.fontSize, 39);
    c.props.fontSize = 8; c.render(); assert.equal(c.button('减小字号').props.disabled, true);
    c.button('全部设置').props.onClick(); await c.flush(); assert.equal(c.panel(), undefined); assert.deepEqual(c.calls.at(-1), ['all']);
});

test('settled callbacks do not update an unmounted settings card', async () => {
    const held = defer(); const c = setup({ onTheme: () => held.promise }); c.show(); c.button('暗色').props.onClick(); c.unmount();
    held.reject(new Error('late failure')); await c.flush(); assert.equal(c.lateUpdates, 0);
});

test('popover clamps its full dimensions into a small viewport', () => {
    const c = setup(); const position = c.exports.minimalPreferencesPosition({ right: 230, bottom: 58 }, { width: 240, height: 320 }, 370);
    assert.equal(position.width, 224); assert.equal(position.left, 8); assert.equal(position.top, 8); assert.equal(position.maxHeight, 304);
    const regular = c.exports.minimalPreferencesPosition({ right: 1188, bottom: 58 }, { width: 1200, height: 800 }, 270);
    assert.equal(regular.left, 924); assert.equal(regular.top, 64); assert.equal(regular.width, 264);
    assert.equal(regular.left + regular.width, 1188);
});

test('open settings follow main-area resizing without stealing focus and release observers on close', () => {
    const layoutNode = {}, c = setup({ layoutNode }); c.show();
    const observer = c.observers.at(-1);
    assert.ok(observer.nodes.has(layoutNode)); assert.ok(observer.nodes.has(c.button('设置').dom));
    const control = c.button('自动保存').dom; control.focus();
    c.anchor.right = 600; c.anchor.bottom = 90;
    observer.callback(); c.render();
    assert.equal(c.panel().props.style.left, 336); assert.equal(c.panel().props.style.top, 96);
    assert.equal(c.doc.activeElement, control);
    c.keyboard('Escape'); c.render();
    assert.equal(observer.disconnected, true); assert.equal(observer.nodes.size, 0);
    c.show(); const reopened = c.observers.at(-1); assert.notEqual(reopened, observer);
    c.unmount(); assert.equal(reopened.disconnected, true);
});

test('theme buttons use visible SVG geometry without relying on missing codicon glyphs', () => {
    const React = require('@theia/core/shared/react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const previous = require.extensions['.css'];
    require.extensions['.css'] = () => {};
    let MinimalThemeIcon;
    try { ({ MinimalThemeIcon } = require('../lib/browser/nodu-minimal-preferences')); }
    finally { if (previous) { require.extensions['.css'] = previous; } else { delete require.extensions['.css']; } }
    const c = setup(); c.show();
    for (const [label, theme] of [['明亮', 'light'], ['暗色', 'dark']]) {
        const icon = c.button(label).props.children[0]; assert.equal(icon.props.theme, theme);
        const markup = renderToStaticMarkup(React.createElement(MinimalThemeIcon, { theme }));
        assert.match(markup, /<svg[^>]*width="16"[^>]*height="16"/);
        assert.match(markup, /<path d="[^"]+"/); assert.match(markup, /stroke="currentColor"/);
        assert.doesNotMatch(markup, /codicon/);
    }
});
