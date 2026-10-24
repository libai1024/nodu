// SPDX-License-Identifier: MIT
// Exercise production toolbar/layout methods with inert service seams; never starts hardware or a model.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const walk = root => {
    const result = [];
    const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { result.push(node); visit(node.props?.children); } };
    visit(root); return result;
};
function harness() {
    const stored = new Map(), classes = new Set();
    const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    class Service {}
    class Widget {
        classes = new Set(); fitCount = 0;
        get parent() { return this._parent; }
        set parent(value) {
            if (this._parent?.layout?.widgets) this._parent.layout.widgets = this._parent.layout.widgets.filter(item => item !== this);
            this._parent = value;
        }
        fit() { this.fitCount++; }
        update() {}
        toggleClass(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }
    }
    class BoxLayout {
        widgets = [];
        constructor(owner) { this.owner = owner; }
        insertWidget(index, widget) { widget.parent = this.owner; this.widgets.splice(index, 0, widget); }
        static setStretch(widget, value) { widget.stretch = value; }
    }
    const stub = new Proxy({ __esModule: true, Emitter, ReactWidget: Widget, Widget, BoxLayout,
        injectable: () => value => value, inject: () => () => {}, postConstruct: () => () => {},
        getThemeMode: theme => theme === 'dark' ? 'dark' : 'light', PreferenceScope: { User: 1 },
        StatusBarAlignment: { LEFT: 0, RIGHT: 1 }, BOARD_MENU: [], environment: { electron: { is: () => false } },
    }, { get: (target, name) => name in target ? target[name] : Service });
    const React = { __esModule: true, Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const NoduMinimalAction = () => {}, NoduMinimalPreferences = () => {}, NoduToolbarPopover = () => {}, NoduMinimalSettingsHost = () => {};
    const C_COMMANDS = require('../lib/browser/nodu-embedded-commands').C_COMMANDS;
    const stateModule = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(__dirname, '../lib/browser/scope-layout-state.js'), 'utf8'), {
        exports: stateModule.exports, require: () => stub, localStorage: storage,
    });
    const modules = {
        '@theia/core/shared/react': React,
        './scope-layout-state': stateModule.exports,
        './nodu-minimal-action': { NoduMinimalAction },
        './nodu-minimal-preferences': { NoduMinimalPreferences },
        './nodu-minimal-settings-host': { NoduMinimalSettingsHost },
        './nodu-toolbar-popover': { NoduToolbarPopover },
        './nodu-minimal-action-state': require('../lib/browser/nodu-minimal-action-state'),
        './nodu-embedded-commands': { C_COMMANDS },
        './nodu-tutor-widget': { NoduTutorWidget: { ID: 'tutor' } },
        '../common/nodu-status': { fpsStatusText: () => 'FPS' },
    };
    const exports = {};
    vm.runInNewContext(readFileSync(resolve(__dirname, '../lib/browser/scope-workbench.js'), 'utf8'), {
        exports, require: id => modules[id] || stub, localStorage: storage,
        document: { body: { classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) } } },
    });
    return { ...exports, ...stateModule.exports, stored, storage, classes, Widget, BoxLayout, C_COMMANDS,
        NoduMinimalAction, NoduMinimalPreferences, NoduToolbarPopover, NoduMinimalSettingsHost };
}

function toolbar(kind = 'stm32', h = harness()) {
    const owner = new h.ScopeToolbar(), calls = [];
    owner.layoutState = new h.ScopeLayoutState(); owner.layoutState.setProject('same-name', '/a');
    owner.embedded = { isC: kind === 'stm32', isEsp: kind === 'esp', busy: false, awaitUser: undefined,
        project: kind === 'stm32' ? { path: '/a' } : undefined, refreshDevices: async () => {}, loadBackups: async () => {} };
    owner.device = { state: { running: false }, busy: false, canStop: false };
    owner.commands = { executeCommand: async command => { calls.push(command); } };
    owner.commandRegistry = { isToggled: () => false };
    owner.messages = { error: text => calls.push(text) };
    owner.themes = { getCurrentTheme: () => ({ type: 'light' }), setCurrentTheme() {} };
    owner.preferences = { get: (_, fallback) => fallback, set: async () => {} };
    owner.editors = {};
    owner.shell = { mainPanel: { node: {} } };
    const nodes = () => walk(owner.renderMinimal());
    const action = () => nodes().find(node => node.type === h.NoduMinimalAction).props;
    return { owner, calls, nodes, action, h };
}

test('STM32 fan selection changes only its action; short activation maps to distinct production commands', () => {
    const c = toolbar();
    assert.equal(c.action().allowSelection, true);
    for (const [action, command] of [['build', c.h.C_COMMANDS.build], ['flash', c.h.C_COMMANDS.flash], ['build-flash', c.h.C_COMMANDS.run]]) {
        c.action().onSelect(action); assert.equal(c.calls.length, 0);
        assert.equal(c.action().action, action); c.action().onExecute();
        assert.deepEqual(c.calls.splice(0), [command]);
    }
    c.action().onStop(); assert.deepEqual(c.calls, [c.h.C_COMMANDS.stop]);
});

test('saved action is scoped by full project path, not repeated project names', () => {
    const c = toolbar(); c.action().onSelect('flash');
    c.owner.embedded.project.path = '/b'; c.owner.layoutState.setProject('same-name', '/b');
    assert.equal(c.action().action, 'build-flash'); c.action().onSelect('build');
    c.owner.embedded.project.path = '/a'; c.owner.layoutState.setProject('same-name', '/a');
    assert.equal(c.action().action, 'flash');
    const next = toolbar('stm32', c.h); assert.equal(next.action().action, 'flash');
    c.h.stored.set('nodu.minimal-action:/unrecognized', 'execute-untrusted-command');
    c.owner.embedded.project.path = '/unrecognized'; assert.equal(c.action().action, 'build-flash');
});

test('K210 uses Python run/stop with no flash fan; ESP never inherits a background K210 operation', () => {
    const k = toolbar('k210');
    assert.equal(k.action().allowSelection, false); k.action().onExecute(); assert.deepEqual(k.calls, ['scope.run-current']);
    k.owner.device.state.running = true; k.owner.device.canStop = true;
    assert.equal(k.action().busy, true); k.action().onStop(); assert.equal(k.calls.at(-1), 'scope.stop-device');
    const e = toolbar('esp'); e.owner.device.state.running = true; e.owner.device.busy = true;
    assert.equal(e.action().busy, false); assert.equal(e.action().allowSelection, false);
    e.action().onExecute(); assert.deepEqual(e.calls, ['task:run:build']);
});

test('saving download settings disables the selected action without presenting a fake stop operation', () => {
    const c = toolbar();
    c.owner.embedded.savingOptions = true;
    c.owner.embedded.busy = true;
    assert.equal(c.action().disabled, true);
    assert.equal(c.action().busy, false);
    c.owner.embedded.savingOptions = false;
    c.owner.embedded.busy = false;
    assert.equal(c.action().disabled, false);
});

test('minimal toolbar hosts settings once in the main area, keeps rail controls and never renders the AI entry', () => {
    const c = toolbar();
    const nodes = c.nodes(), label = name => nodes.find(node => node.props?.['aria-label'] === name);
    assert.ok(label('文件')); assert.ok(label('搜索')); assert.ok(label('设备'));
    label('终端与输出').props.onClick(); assert.deepEqual(c.calls, [c.h.C_COMMANDS.togglePanel]);
    const hosts = nodes.filter(node => node.type === c.h.NoduMinimalSettingsHost);
    assert.equal(hosts.length, 1); assert.equal(hosts[0].props.panel, c.owner.shell.mainPanel);
    assert.equal(walk(hosts[0]).filter(node => node.type === c.h.NoduMinimalPreferences).length, 1);
    const settings = nodes.find(node => node.type === c.h.NoduMinimalPreferences);
    assert.equal(settings.props.layoutNode, c.owner.shell.mainPanel.node);
    const tools = nodes.find(node => node.props?.className === 'nodu-minimal-tools');
    assert.equal(walk(tools).some(node => node.type === c.h.NoduMinimalPreferences), false);
    assert.equal(nodes.some(node => /AI|教学/.test(node.props?.['aria-label'] || '')), false);
    const k = toolbar('k210'); k.nodes().find(node => node.props?.['aria-label'] === '终端与输出').props.onClick();
    assert.deepEqual(k.calls, ['scope.toggle-console']);
});

test('same-named workspace change updates full identity and closes the old device form', () => {
    const h = harness(), state = new h.ScopeLayoutState();
    state.setProject('same', '/first'); state.setDeviceOpen(true);
    state.setProject('same', '/second');
    assert.equal(state.projectPath, '/second'); assert.equal(state.deviceOpen, false);
});

function workbench() {
    const h = harness(), owner = new h.ScopeWorkbenchContribution(), calls = [];
    const visible = { files: false, vision: false, bottom: true };
    const bottom = { area: 'bottom', sessions: [{ pid: 'test-session' }], draft: 'unfinished input', page: 'terminal' };
    const vision = { area: 'right' }, files = { area: 'left' };
    owner.layoutState = new h.ScopeLayoutState(); owner.embedded = { isC: true, project: { chip: { name: 'STM32F103C8T6' } } };
    owner.device = { state: {} }; owner.tutorModel = { panelPreferred: false }; owner.tutorView = { openView: async () => assert.fail('AI should remain closed') };
    const shell = new h.Widget(), body = new h.Widget(), toolbar = new h.Widget(), side = new h.Widget();
    shell.layout = new h.BoxLayout(shell); body.layout = new h.BoxLayout(body);
    shell.layout.insertWidget(0, new h.Widget()); shell.layout.insertWidget(1, body); body.layout.insertWidget(0, side);
    owner.shell = Object.assign(shell, {
        getAreaFor: widget => widget.area, getWidgetById: () => undefined,
        collapsePanel: async area => { calls.push(['collapse', area]); visible[area === 'left' ? 'files' : area === 'right' ? 'vision' : 'bottom'] = false; },
    });
    owner.toolbar = toolbar; owner.workbenchBody = body;
    owner.devices = { tryGetWidget: () => undefined }; owner.consoleView = { tryGetWidget: () => bottom };
    owner.vision = { tryGetWidget: () => vision, openView: async () => { visible.vision = true; } };
    owner.navigator = { openView: async () => { visible.files = true; } }; owner.boardFiles = { tryGetWidget: () => ({ isAttached: true }) };
    owner.filesWidget = () => files;
    owner.syncPanels = () => owner.layoutState.setPanels(visible.files, visible.bottom, visible.vision);
    owner.settlePanels = async () => owner.syncPanels(); owner.updateStatus = () => {};
    owner.showConsole = async () => { calls.push(['open', 'bottom']); visible.bottom = true; };
    return { h, owner, calls, visible, bottom, body, toolbar, side, shell };
}

test('first simple layout hides restored bottom once; subsequent mode changes preserve sessions, draft and user visibility', async () => {
    const w = workbench(), session = w.bottom.sessions[0];
    await w.owner.applyLayout('simple'); assert.equal(w.visible.bottom, false);
    assert.deepEqual(w.calls.filter(([, area]) => area === 'bottom'), [['collapse', 'bottom']]);
    w.visible.bottom = true; w.calls.length = 0;
    await w.owner.applyLayout('pro'); await w.owner.applyLayout('simple');
    assert.equal(w.visible.bottom, true); assert.equal(w.calls.some(([, area]) => area === 'bottom'), false);
    w.visible.bottom = false; await w.owner.applyLayout('pro');
    assert.equal(w.visible.bottom, false); assert.equal(w.bottom.sessions[0], session);
    assert.equal(w.bottom.draft, 'unfinished input'); assert.equal(w.bottom.page, 'terminal');
});

test('mode transition reparents the same rail/header and preserves the editor body without duplication', async () => {
    const w = workbench();
    await w.owner.applyLayout('simple');
    assert.equal(w.toolbar.parent, w.body); assert.deepEqual(w.body.layout.widgets, [w.toolbar, w.side]);
    assert.ok(w.toolbar.classes.has('nodu-minimal-toolbar'));
    await w.owner.applyLayout('pro');
    assert.equal(w.toolbar.parent, w.shell); assert.deepEqual(w.body.layout.widgets, [w.side]);
    assert.equal(w.shell.layout.widgets[1], w.toolbar); assert.equal(w.toolbar.classes.has('nodu-minimal-toolbar'), false);
    await w.owner.applyLayout('simple'); await w.owner.applyLayout('simple');
    assert.deepEqual(w.body.layout.widgets, [w.toolbar, w.side]); assert.equal(w.toolbar.stretch, 0);
});

test('STM32 status target routes to an enabled device command while K210-only execution commands remain disabled', () => {
    const w = workbench(), commands = new Map(), status = new Map();
    w.owner.registerCommands({ registerCommand: (command, handler) => commands.set(command.id, handler) });
    w.owner.status = { setElement: (id, entry) => status.set(id, entry), removeElement: id => status.delete(id) };
    w.h.ScopeWorkbenchContribution.prototype.updateStatus.call(w.owner);
    const target = status.get('scope:minimal-target'); assert.equal(target.text, 'STM32F103C8T6');
    assert.equal(commands.get(target.command).isEnabled(), true); commands.get(target.command).execute();
    assert.equal(w.owner.layoutState.deviceOpen, true);
    assert.equal(commands.get('scope.run-current').isEnabled(), false);
    assert.equal(commands.get('scope.stop-device').isEnabled(), false);
});

function devicePopover() {
    let cursor = 0, tree, focusCount = 0;
    const slots = [], pending = [], frames = new Map(), listeners = new Map(); let nextFrame = 0;
    const doc = { body: {} };
    const panel = { offsetHeight: 520, props: {}, querySelector: () => ({ focus() {
        // A browser cannot focus a control inside display:none or visibility:hidden.
        if (!panel.props.hidden && panel.props.style?.visibility !== 'hidden') focusCount++;
    } }) };
    const effect = (fn, deps) => {
        const i = cursor++, previous = slots[i];
        if (previous?.deps?.length === deps.length && deps.every((value, index) => value === previous.deps[index])) return;
        slots[i] = { deps, cleanup: previous?.cleanup };
        pending.push(() => { previous?.cleanup?.(); slots[i].cleanup = fn(); });
    };
    const React = { __esModule: true,
        useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; },
        useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
        useLayoutEffect: effect, useEffect: effect,
        createElement(type, props, ...children) { tree = { type, props: { ...props, children } }; panel.props = tree.props; if (props.ref) props.ref.current = panel; return tree; },
    };
    const raf = fn => { const id = ++nextFrame; frames.set(id, fn); return id; };
    const win = { innerWidth: 800, innerHeight: 600,
        addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
        requestAnimationFrame: raf, cancelAnimationFrame: id => frames.delete(id),
    };
    const exports = {};
    vm.runInNewContext(readFileSync(resolve(__dirname, '../lib/browser/nodu-toolbar-popover.js'), 'utf8'), {
        exports, require: id => id === '@theia/core/shared/react' ? React : { createPortal: node => node },
        window: win, document: doc, requestAnimationFrame: raf, cancelAnimationFrame: id => frames.delete(id),
        ResizeObserver: class { observe() {} disconnect() {} },
    });
    const props = { open: false, simple: true, owner: { querySelector: () => ({ getBoundingClientRect: () => ({ left: 8, right: 44, top: 120, bottom: 156 }) }) }, children: {} };
    const render = () => { cursor = 0; const result = exports.NoduToolbarPopover(props); pending.splice(0).forEach(fn => fn()); return result; };
    const flush = () => { for (let n = 0; n < 4; n++) { render(); const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); } };
    return { props, win, doc, render, flush, panel, get tree() { return tree; }, get focusCount() { return focusCount; },
        unmount() { for (const slot of slots) slot?.cleanup?.(); }, listeners };
}

test('first device popover opening focuses only after visibility is committed; resizing does not steal focus again', () => {
    const p = devicePopover(); p.flush(); assert.equal(p.focusCount, 0);
    p.props.open = true; p.flush();
    assert.equal(p.tree.props.hidden, false); assert.equal(p.tree.props.style.visibility, undefined);
    assert.equal(p.focusCount, 1, 'first opening must move keyboard focus into the now-visible portal');
    p.listeners.get('resize')(); p.flush(); assert.equal(p.focusCount, 1);
    p.props.open = false; p.flush(); p.props.open = true; p.flush(); assert.equal(p.focusCount, 2);
    p.unmount(); assert.equal(p.listeners.size, 0);
});

test('device popover stays within narrow viewport for both rail and professional toolbar anchors', () => {
    const p = devicePopover(); p.win.innerWidth = 340; p.win.innerHeight = 380; p.props.open = true;
    for (const simple of [true, false]) {
        p.props.simple = simple; p.flush(); const pos = p.tree.props.style;
        assert.ok(pos.left >= 8); assert.ok(pos.left + pos.width <= p.win.innerWidth - 8);
        assert.ok(pos.top >= 8); assert.ok(pos.top + pos.maxHeight <= p.win.innerHeight - 8);
    }
});

test('layout mode commands stay responsive during a build/download or BOOT wait without touching the operation', async () => {
    for (const phase of ['building', 'flashing', 'exitBoot']) {
        const w = workbench(), commands = new Map();
        await w.owner.applyLayout('simple'); w.calls.length = 0;
        w.owner.embedded.busy = phase !== 'exitBoot'; w.owner.embedded[phase] = true;
        w.owner.embedded.awaitUser = phase === 'exitBoot' ? 'exitBoot' : undefined;
        w.owner.registerCommands({ registerCommand: (command, handler) => commands.set(command.id, handler) });
        await commands.get('scope.layout.pro').execute();
        assert.equal(w.owner.layoutState.mode, 'pro'); assert.equal(w.toolbar.parent, w.shell);
        await commands.get('scope.layout.simple').execute();
        assert.equal(w.owner.layoutState.mode, 'simple'); assert.equal(w.toolbar.parent, w.body);
        assert.equal(w.owner.embedded.busy, phase !== 'exitBoot');
        assert.equal(w.owner.embedded.awaitUser, phase === 'exitBoot' ? 'exitBoot' : undefined);
        assert.equal(w.calls.some(([, area]) => area === 'bottom'), false);
    }
});


test('compact STM32 popover changes size without shrinking K210 or professional device forms', () => {
    for (const kind of ['stm32', 'k210']) {
        const c = toolbar(kind); c.owner.layoutState.mode = 'simple';
        const popover = walk(c.owner.render()).find(node => node.type === c.h.NoduToolbarPopover);
        assert.equal(popover.props.compact, kind === 'stm32');
        c.owner.layoutState.mode = 'pro'; c.owner.renderProfessional = () => null;
        assert.equal(walk(c.owner.render()).find(node => node.type === c.h.NoduToolbarPopover).props.compact, false);
    }
    const p = devicePopover(); p.props.open = true; p.props.compact = true; p.flush();
    assert.equal(p.tree.props.style.width, 304);
    p.props.compact = false; p.flush(); assert.equal(p.tree.props.style.width, 410);
});

test('compact device Tab cycle excludes folded controls and unchecked radios; nested selectors retain their keys', () => {
    const p = devicePopover(); p.props.open = true; p.props.compact = true; p.flush();
    const focus = [];
    const control = (name, type, checked, visible = true) => ({ getClientRects: () => visible ? [{}] : [],
        getAttribute: key => key === 'type' ? type : null, checked, focus: () => focus.push(name) });
    const first = control('refresh'), radio = control('stlink', 'radio', true), unchecked = control('isp', 'radio', false),
        folded = control('restore', null, false, false), last = control('settings');
    const target = { contains: node => node !== 'portal', querySelectorAll: () => [first, radio, unchecked, folded, last] };
    let prevented = 0;
    const event = { key: 'Tab', currentTarget: target, target: last, preventDefault: () => prevented++ };
    p.doc.activeElement = last; p.tree.props.onKeyDown(event); assert.deepEqual(focus, ['refresh']);
    p.doc.activeElement = first; p.tree.props.onKeyDown({ ...event, shiftKey: true }); assert.deepEqual(focus, ['refresh', 'settings']);
    p.tree.props.onKeyDown({ ...event, target: 'portal' });
    p.tree.props.onKeyDown({ ...event, defaultPrevented: true }); assert.equal(prevented, 2);
});
