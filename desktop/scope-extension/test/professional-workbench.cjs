// SPDX-License-Identifier: MIT
// Production toolbar and mode-switch contracts. No Electron, device or model is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const walk = root => {
    const result = [];
    const visit = node => { if (Array.isArray(node)) node.forEach(visit); else if (node && typeof node === 'object') { result.push(node); visit(node.props?.children); } };
    visit(root); return result;
};
const text = root => Array.isArray(root) ? root.map(text).join('') : root && typeof root === 'object' ? text(root.props?.children) : typeof root === 'string' ? root : '';
function harness(electron = true, mac = true) {
    const stored = new Map();
    const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    class Emitter { event = () => ({ dispose() {} }); fire() {} }
    class Service {}
    class Widget {
        classes = new Set(); node = {}; fitCount = 0;
        get parent() { return this._parent; }
        set parent(value) {
            if (this._parent?.layout?.widgets) this._parent.layout.widgets = this._parent.layout.widgets.filter(item => item !== this);
            this._parent = value;
        }
        hasClass(name) { return this.classes.has(name); }
        fit() { this.fitCount++; }
        update() {}
        toggleClass(name, on) { on ? this.classes.add(name) : this.classes.delete(name); }
        addWidget(widget) { this.layout.insertWidget(this.layout.widgets.length, widget); }
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
        StatusBarAlignment: { LEFT: 0, RIGHT: 1 }, BOARD_MENU: [], environment: { electron: { is: () => electron } },
    }, { get: (target, name) => name in target ? target[name] : Service });
    const React = { __esModule: true, Fragment: 'fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
    const NoduMinimalPreferences = () => {}, NoduMinimalSettingsHost = () => {}, NoduMinimalAction = () => {}, ActionIcon = () => {}, ChipMark = () => {};
    const TUTOR_COMMANDS = { guidance: 'nodu.tutor.guidance' };
    const modules = {
        '@theia/core/shared/react': React,
        '@theia/core/lib/common/os': { isOSX: mac, isWindows: !mac },
        'react-dom': { createPortal: (children, target) => ({ type: 'portal', props: { children: [children], target } }) },
        './nodu-minimal-action': { NoduMinimalAction, ActionIcon },
        './nodu-minimal-preferences': { NoduMinimalPreferences },
        './nodu-minimal-settings-host': { NoduMinimalSettingsHost },
        './nodu-project-icon': { ChipMark, FrameworkMark: () => {} },
        '../common/nodu-arduino-protocol': { ARDUINO_COMMANDS: { build: 'nodu.arduino.build', upload: 'nodu.arduino.upload', stop: 'nodu.arduino.stop', libraries: 'nodu.arduino.libraries' } },
        './nodu-arduino-contribution': { ARDUINO_FLASH_COMMAND: 'nodu.arduino.flash' },
        './nodu-tutor-hints': { TUTOR_COMMANDS, TUTOR_MENU: ['nodu-ai-controls'] },
        './nodu-tutor-widget': { NoduTutorWidget: { ID: 'tutor' } },
        './scope-theme': { SCOPE_LIGHT_THEME_ID: 'scope-light', SCOPE_THEME_ID: 'scope-dark' },
    };
    const load = name => {
        const source = readFileSync(resolve(__dirname, `../src/browser/${name}`), 'utf8');
        const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
            jsx: ts.JsxEmit.React, experimentalDecorators: true, esModuleInterop: true } }).outputText;
        const exports = {};
        vm.runInNewContext(code, { exports, require: id => modules[id] || stub, localStorage: storage,
            document: { body: { classList: { toggle() {} } } } });
        return exports;
    };
    modules['./scope-layout-state'] = load('scope-layout-state.ts');
    modules['./nodu-minimal-action-state'] = load('nodu-minimal-action-state.ts');
    modules['./nodu-embedded-commands'] = load('nodu-embedded-commands.ts');
    modules['./nodu-embedded-toolbar'] = load('nodu-embedded-toolbar.tsx');
    return { ...load('scope-workbench.tsx'), ...modules['./scope-layout-state'], ...modules['./nodu-embedded-toolbar'],
        ...modules['./nodu-embedded-commands'], TUTOR_COMMANDS, Widget, BoxLayout, NoduMinimalPreferences, NoduMinimalSettingsHost, NoduMinimalAction, ActionIcon };
}
function toolbar(kind = 'stm32', h = harness()) {
    const owner = new h.ScopeToolbar(), calls = [], preferences = [], themes = [], menu = [];
    owner.layoutState = new h.ScopeLayoutState(); owner.layoutState.setMode('pro'); owner.layoutState.setProject('unique-project-name', '/project');
    owner.embedded = { isC: kind === 'stm32', isEsp: kind === 'esp' || kind === 'arduino', isArduino: kind === 'arduino', espChip: 'esp32', busy: false, savingOptions: false,
        project: { path: '/project', chip: { name: 'STM32F103C8T6' }, board: { name: 'STM32F103C8T6 最小系统板' }, flashMethod: 'stlink' },
        probes: [], monitorPort: '', flashSteps: {}, refreshDevices: async () => {}, loadBackups: async () => {}, setTask(text) { this.task = { text }; } };
    owner.arduino = { busy: false, loading: false, configuring: false, selectedPort: '/dev/upload', ports: [{ path: '/dev/upload' }], canFlash: true, boardName: 'ESP32S3 Dev Module', refresh: async () => calls.push('refresh-arduino') };
    owner.device = { state: { running: false, phase: 'idle' }, busy: false, canStop: false, boardLabel: 'K210', connected: false };
    owner.tutor = { paused: false };
    owner.commands = { executeCommand: async command => { calls.push(command); } };
    owner.commandRegistry = { isToggled: () => false };
    owner.messages = { error: text => calls.push(text) };
    owner.themes = { getCurrentTheme: () => ({ type: 'light' }), setCurrentTheme: theme => themes.push(theme) };
    owner.preferences = { get: (_, fallback) => fallback, set: async (...args) => { preferences.push(args); } };
    owner.professionalSettings = { isOpen: false, toggle: (page, anchor) => calls.push(['settings', page, anchor]) };
    owner.editors = { currentEditor: { activate: () => calls.push('activate-editor') } };
    owner.shell = { mainPanel: { node: {} }, topPanel: { node: { id: 'titlebar' }, hasClass: () => false }, leftPanelHandler: { container: { node: { querySelector: () => ({ id: 'rail' }) } } } };
    owner.contextMenu = { render: options => menu.push(options) };
    const render = () => kind === 'stm32' ? h.NoduCToolbar(owner.renderC().props) : kind === 'arduino' ? owner.renderArduino() : owner.renderPythonOrEsp();
    const button = label => walk(render()).find(node => node.type === 'button' && node.props['aria-label'] === label);
    return { h, owner, calls, preferences, themes, menu, render, button };
}
test('Windows project menu uses the title-bar icon slot in both modes with a native-titlebar fallback', () => {
    const c = toolbar('arduino', harness(true, false)), rect = { left: 8, bottom: 32 }, slot = { id: 'windows-icon', getBoundingClientRect: () => rect };
    c.owner.shell.topPanel.isVisible = true;
    c.owner.shell.topPanel.node.querySelector = () => slot;
    for (const mode of ['simple', 'pro']) {
        c.owner.layoutState.setMode(mode);
        const logo = c.owner.renderProjectLogo();
        assert.equal(logo.props.target, slot);
        const button = walk(logo).find(node => node.type === 'button');
        assert.match(button.props.className, /nodu-titlebar-project/);
        button.props.onClick({ currentTarget: slot }); assert.equal(c.menu.at(-1).anchor.x, 8); assert.equal(c.menu.at(-1).anchor.y, 34); assert.equal(c.menu.at(-1).context, slot);
    }
    c.owner.shell.topPanel.isVisible = false;
    assert.equal(c.owner.renderProjectLogo().props.target.id, 'rail');
});
test('Arduino uses the shared professional action row and the same minimal three-action gesture', () => {
    const c = toolbar('arduino');
    const actions = walk(c.render()).filter(node => node.props?.['data-action']);
    assert.deepEqual(actions.map(node => node.props['data-action']), ['build', 'flash', 'run']);
    actions.forEach(node => { assert.equal(node.props.disabled, false); node.props.onClick(); });
    assert.deepEqual(c.calls.splice(0), ['nodu.arduino.build', 'nodu.arduino.flash', 'nodu.arduino.upload']);
    c.owner.layoutState.setMode('simple');
    const primary = () => walk(c.owner.renderMinimal()).find(node => node.type === c.h.NoduMinimalAction).props;
    assert.equal(primary().allowSelection, true);
    for (const [action, command] of [['build', 'nodu.arduino.build'], ['flash', 'nodu.arduino.flash'], ['build-flash', 'nodu.arduino.upload']]) {
        primary().onSelect(action); primary().onExecute(); assert.deepEqual(c.calls.splice(0), [command]);
    }
    c.owner.arduino.operation = 'upload'; assert.equal(primary().busy, true); primary().onStop(); assert.deepEqual(c.calls.splice(0), ['nodu.arduino.stop']);
});
test('Arduino opens the shared device popover for a missing upload port while compilation remains available', () => {
    const c = toolbar('arduino'); c.owner.arduino.selectedPort = '';
    const actions = walk(c.render()).filter(node => node.props?.['data-action']);
    assert.equal(actions[0].props.disabled, false); assert.equal(actions[1].props.disabled, true); assert.equal(actions[2].props.disabled, true);
    c.owner.layoutState.setMode('simple');
    const primary = () => walk(c.owner.renderMinimal()).find(node => node.type === c.h.NoduMinimalAction).props;
    assert.equal(primary().disabled, false); primary().onExecute();
    assert.equal(c.owner.layoutState.deviceOpen, true); assert.deepEqual(c.calls.splice(0), ['refresh-arduino']);
    primary().onSelect('build'); primary().onExecute(); assert.deepEqual(c.calls.splice(0), ['nodu.arduino.build']);
    assert.ok(walk(c.owner.renderMinimal()).some(node => node.props?.['aria-label'] === '库管理'));
});
test('professional STM32 actions are compile, flash, run with distinct production command dispatch', () => {
    const c = toolbar();
    const actions = walk(c.render()).filter(node => node.props?.['data-action']);
    assert.deepEqual(actions.map(node => node.props['data-action']), ['build', 'flash', 'run']);
    actions.forEach(node => { assert.equal(node.props.disabled, false); node.props.onClick(); });
    assert.deepEqual(c.calls, [c.h.C_COMMANDS.build, c.h.C_COMMANDS.flash, c.h.C_COMMANDS.run]);
    assert.equal(c.button('停止').props.disabled, true);
    const tree = c.owner.renderProfessional();
    assert.equal(walk(tree).filter(node => node.type === c.h.NoduCToolbar).length, 1);
    assert.doesNotMatch(text(tree), /unique-project-name/);
    assert.equal(walk(tree).filter(node => node.props?.['aria-label'] === '项目菜单').length, 1);
    const props = walk(tree).find(node => node.type === c.h.NoduCToolbar).props;
    assert.equal(props.externalDevicePanel, true);
});
test('compiling, flashing and serial boot waits disable all C launch actions and preserve Stop', () => {
    const c = toolbar();
    for (const state of [{ busy: true, building: true, awaitUser: undefined }, { busy: true, building: false, flashing: true, awaitUser: undefined }, { busy: false, flashing: false, awaitUser: 'enterBoot' }]) {
        Object.assign(c.owner.embedded, state);
        assert.ok(walk(c.render()).filter(node => node.props?.['data-action']).every(node => node.props.disabled));
        assert.equal(c.button('停止').props.disabled, false);
        c.button('停止').props.onClick(); assert.equal(c.calls.at(-1), c.h.C_COMMANDS.stop);
    }
});
test('saving C download options prevents execution without pretending there is a cancellable build', () => {
    const c = toolbar(); Object.assign(c.owner.embedded, { busy: true, savingOptions: true });
    assert.ok(walk(c.render()).filter(node => node.props?.['data-action']).every(node => node.props.disabled));
    assert.equal(c.button('停止').props.disabled, true);
});
test('K210 retains memory execution and its own stop, never C compile or flash', () => {
    const c = toolbar('k210');
    assert.deepEqual(walk(c.render()).filter(node => node.props?.['data-action']).map(node => node.props['data-action']), ['run']);
    c.button('运行到开发板内存').props.onClick(); assert.deepEqual(c.calls, ['scope.run-current']);
    assert.equal(c.button('停止').props.disabled, true);
    c.owner.device.busy = true; assert.equal(c.button('运行到开发板内存').props.disabled, true);
    c.owner.device.busy = false; c.owner.device.state.running = true; c.owner.device.canStop = true;
    assert.equal(c.button('运行到开发板内存').props.disabled, true); assert.equal(c.button('停止').props.disabled, false);
    c.button('停止').props.onClick(); assert.equal(c.calls.at(-1), 'scope.stop-device');
    assert.equal(c.calls.some(command => command.startsWith('nodu.c.')), false);
});
test('ESP task controls do not inherit unrelated connected K210 state or STM32 flash', () => {
    const c = toolbar('esp'); c.owner.device.busy = true; c.owner.device.state.running = true;
    c.button('编译').props.onClick(); c.button('项目任务').props.onClick();
    assert.deepEqual(c.calls, ['task:run:build', 'task:run']);
    assert.equal(c.button('停止'), undefined);
    assert.equal(walk(c.render()).some(node => node.props?.['data-action'] === 'flash'), false);
});
test('professional gear opens unified settings while simple mode keeps the compact preference card', async () => {
    const c = toolbar(), anchor = {};
    const gear = walk(c.render()).find(node => node.type === 'button' && node.props['aria-label'] === '设置');
    assert.equal(gear.props['aria-expanded'], false);
    assert.equal(walk(c.render()).filter(node => node.type === c.h.NoduMinimalPreferences).length, 0);
    gear.props.onClick({ currentTarget: anchor }); assert.deepEqual(c.calls, [['settings', 'general', anchor]]);
    c.owner.professionalSettings.isOpen = true;
    assert.equal(walk(c.render()).find(node => node.props['aria-label'] === '设置').props['aria-expanded'], true);
    c.owner.layoutState.setMode('simple');
    const minimal = walk(c.owner.renderMinimal()).filter(node => node.type === c.h.NoduMinimalPreferences);
    assert.equal(minimal.length, 1); assert.equal(minimal[0].props.mode, 'simple');
    await minimal[0].props.onMode('pro'); assert.deepEqual(c.calls.slice(-2), ['scope.layout.pro', 'activate-editor']);
    minimal[0].props.onTheme('dark'); assert.deepEqual(c.themes, ['scope-dark']);
    await minimal[0].props.onFontSize(16); assert.deepEqual(c.preferences[0], ['editor.fontSize', 16, 1]);
    c.owner.layoutState.setDeviceOpen(true); minimal[0].props.onOpen(); assert.equal(c.owner.layoutState.deviceOpen, false);
    const portal = walk(c.owner.renderMinimal()).find(node => node.type === 'portal');
    assert.equal(portal.props.target, c.owner.shell.topPanel.node);
    assert.equal(walk(c.owner.renderMinimal()).some(node => node.type === c.h.NoduMinimalSettingsHost), false);
});
test('native titlebars use the same settings host in both modes', () => {
    const c = toolbar('stm32', harness(true, false));
    for (const mode of ['simple', 'pro']) {
        c.owner.layoutState.setMode(mode);
        const host = c.owner.renderSettings();
        assert.equal(host.type, c.h.NoduMinimalSettingsHost);
        assert.equal(host.props.panel, c.owner.shell.mainPanel);
        assert.equal(walk(host).filter(node => node.type === c.h.NoduMinimalPreferences).length, mode === 'simple' ? 1 : 0);
        if (mode === 'pro') assert.equal(walk(host).filter(node => node.type === 'button' && node.props['aria-label'] === '设置').length, 1);
    }
});
test('AI teaching switches guidance without closing conversation; more menus remain target-specific', () => {
    for (const [kind, segment] of [['stm32', 'stm32'], ['k210', 'k210'], ['esp', 'esp']]) {
        const c = toolbar(kind); const ai = () => walk(c.render()).find(node => node.props?.role === 'switch');
        assert.equal(ai().props['aria-checked'], true); ai().props.onClick(); assert.deepEqual(c.calls, [c.h.TUTOR_COMMANDS.guidance]);
        c.owner.tutor.paused = true; assert.equal(ai().props['aria-checked'], false);
        c.button('视图与更多操作').props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) } });
        assert.equal(c.menu[0].menuPath.at(-1), segment);
        c.owner.layoutState.setMode('simple'); assert.equal(c.owner.renderAI(), undefined);
    }
});
function layout(electron, mac = true, custom = false) {
    const h = harness(electron, mac), owner = new h.ScopeWorkbenchContribution();
    const shell = new h.Widget(), body = new h.Widget(), toolbar = new h.Widget(), top = new h.Widget(), editors = new h.Widget();
    for (const widget of [shell, body, top]) widget.layout = new h.BoxLayout(widget);
    if (custom) top.classes.add('nodu-project-titlebar');
    const search = new h.Widget(); top.addWidget(search); shell.addWidget(top); shell.addWidget(body); body.addWidget(editors);
    editors.documents = [{ text: 'unsaved input', dirty: true }];
    owner.shell = Object.assign(shell, { topPanel: top }); owner.workbenchBody = body; owner.toolbar = toolbar;
    owner.layoutState = new h.ScopeLayoutState();
    return { h, owner, shell, body, top, toolbar, editors, search };
}
test('Electron switches the same toolbar between title row and rail without moving or recreating editors', () => {
    const w = layout(true), documents = w.editors.documents, editor = documents[0];
    w.owner.layoutState.setMode('pro'); w.owner.positionToolbar();
    assert.equal(w.toolbar.parent, w.top); assert.deepEqual(w.top.layout.widgets, [w.search, w.toolbar]);
    assert.ok(w.toolbar.classes.has('nodu-titlebar-toolbar')); assert.ok(w.toolbar.classes.has('nodu-professional-toolbar'));
    for (let count = 0; count < 3; count++) {
        w.owner.layoutState.setMode('simple'); w.owner.positionToolbar();
        assert.equal(w.toolbar.parent, w.body); assert.deepEqual(w.body.layout.widgets, [w.toolbar, w.editors]);
        assert.deepEqual(w.top.layout.widgets, [w.search]); assert.ok(w.toolbar.classes.has('nodu-minimal-toolbar'));
        assert.equal(w.toolbar.classes.has('nodu-titlebar-toolbar'), false);
        w.owner.layoutState.setMode('pro'); w.owner.positionToolbar(); w.owner.positionToolbar();
        assert.deepEqual(w.top.layout.widgets, [w.search, w.toolbar]); assert.deepEqual(w.body.layout.widgets, [w.editors]);
    }
    assert.equal(w.editors.documents, documents); assert.equal(documents[0], editor); assert.equal(editor.text, 'unsaved input'); assert.equal(editor.dirty, true);
});
test('browser keeps a standalone toolbar instead of attempting the Electron title row', () => {
    const w = layout(false); w.owner.layoutState.setMode('pro'); w.owner.positionToolbar();
    assert.equal(w.toolbar.parent, w.shell); assert.equal(w.shell.layout.widgets[1], w.toolbar);
    assert.deepEqual(w.top.layout.widgets, [w.search]); assert.equal(w.toolbar.classes.has('nodu-titlebar-toolbar'), false);
});

test('professional overflow links registered menus lazily once per platform and retries absent sources', () => {
    const h = harness(), owner = new h.ScopeWorkbenchContribution(), sources = new Map(), links = [], disposables = [];
    owner.toDispose = { push: item => disposables.push(item) };
    owner.menuRegistry = {
        getMenu: source => sources.get(source.join('/')),
        linkCompoundMenuNode: options => { links.push(JSON.parse(JSON.stringify(options))); return { dispose() {} }; },
    };
    const root = ['nodu-toolbar-more'];
    owner.linkProfessionalSubmenus([...root, 'stm32']);
    assert.equal(links.length, 0);
    sources.set('nodu-ai-controls', {});
    owner.linkProfessionalSubmenus([...root, 'stm32']); assert.equal(links.length, 1);
    sources.set('nodu-toolbar-run-c', {}); sources.set('nodu-toolbar-run', {});
    owner.linkProfessionalSubmenus([...root, 'stm32']); owner.linkProfessionalSubmenus([...root, 'stm32']);
    assert.equal(links.length, 2);
    owner.linkProfessionalSubmenus([...root, 'k210']); owner.linkProfessionalSubmenus([...root, 'esp']);
    assert.equal(links.length, 5); assert.equal(disposables.length, 5);
    assert.deepEqual(links.filter(link => link.newParentPath[1] === 'stm32').map(link => link.submenuPath), [['nodu-ai-controls'], ['nodu-toolbar-run-c']]);
    assert.deepEqual(links.filter(link => link.newParentPath[1] === 'k210').map(link => link.submenuPath), [['nodu-ai-controls'], ['nodu-toolbar-run']]);
    assert.deepEqual(links.filter(link => link.newParentPath[1] === 'esp').map(link => link.submenuPath), [['nodu-ai-controls']]);
});

test('Windows and Linux retain visible standalone toolbar with native titlebar and merge only for a custom titlebar', () => {
    const native = layout(true, false, false); native.owner.layoutState.setMode('pro'); native.owner.positionToolbar();
    assert.equal(native.toolbar.parent, native.shell); assert.equal(native.toolbar.classes.has('nodu-titlebar-toolbar'), false);
    assert.deepEqual(native.top.layout.widgets, [native.search]);
    const custom = layout(true, false, true); custom.owner.layoutState.setMode('pro'); custom.owner.positionToolbar();
    assert.equal(custom.toolbar.parent, custom.top); assert.equal(custom.toolbar.classes.has('nodu-titlebar-toolbar'), true);
    assert.deepEqual(custom.top.layout.widgets, [custom.search, custom.toolbar]);
});


test('a saved Arduino port absent from the current port list is shown as disconnected', () => {
    const c = toolbar('arduino'); c.owner.arduino.ports = [];
    const trigger = walk(c.render()).find(n => n.type === 'button' && n.props['aria-controls'] === 'scope-device-popover');
    assert.match(trigger.props.className, /nodu-chip-disconnected/); assert.match(trigger.props['aria-label'], /串口未连接/);
    c.owner.arduino.ports = [{ path: '/dev/upload' }];
    assert.match(walk(c.render()).find(n => n.type === 'button' && n.props['aria-controls'] === 'scope-device-popover').props.className, /nodu-chip-connected/);
});
