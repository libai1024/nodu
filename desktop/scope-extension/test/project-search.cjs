// SPDX-License-Identifier: MIT
// Exercise production title-bar methods with inert UI/service seams. No Electron or hardware is started.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const ts = require('typescript');

function productionClass(relative, className, members, dependencies = {}, Base = class {}) {
    const file = path.join(__dirname, '../src', relative);
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const cls = source.statements.find(node => ts.isClassDeclaration(node) && node.name.text === className);
    assert.ok(cls, `Production class ${className} is present`);
    const selected = cls.members.filter(member => members.includes(member.name?.getText(source)));
    for (const member of members) assert.ok(selected.some(node => node.name?.getText(source) === member), `Production member ${member} is present`);
    const js = ts.transpile(`class Subject extends Base { ${selected.map(member => member.getText(source)).join('\n')} }`, { target: ts.ScriptTarget.ES2022 });
    return new Function('Base', ...Object.keys(dependencies), `${js}; return Subject;`)(Base, ...Object.values(dependencies));
}
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const directory = name => ({ isDirectory: true, resource: { path: { base: name, name } } });
const workspaceFile = name => ({ isDirectory: false, resource: { path: { base: `${name}.theia-workspace`, name } } });

test('file search changes only provider copy and retains the existing search implementation', () => {
    let descriptor;
    const FileSearch = productionClass('electron-browser/nodu-file-search.ts', 'NoduFileSearch',
        ['registerQuickAccessProvider'], { QuickFileOpenService: { PREFIX: '' } });
    const service = new FileSearch();
    service.quickAccessRegistry = { registerQuickAccessProvider: value => { descriptor = value; } };
    service.registerQuickAccessProvider();
    assert.equal(descriptor.placeholder, '搜索文件…');
    assert.equal(descriptor.prefix, '');
    assert.equal(descriptor.getInstance(), service);
    assert.deepEqual(descriptor.helpEntries, [{ description: '搜索文件', needsEditor: false }]);
});

function searchFixture({ mac = true, width = 980, menu, toolbar, controls, workspace = directory('uart-demo') } = {}) {
    const listeners = {}, observers = [], mutations = [], calls = [], disposables = [], roots = deferred();
    class ResizeObserver {
        constructor(callback) { this.callback = callback; observers.push(this); }
        observed = new Set();
        observe(node) { this.observed.add(node); }
        unobserve(node) { this.observed.delete(node); }
        disconnect() { this.disconnected = true; }
    }
    class MutationObserver {
        constructor(callback) { this.callback = callback; mutations.push(this); }
        observe(node, options) { this.observed = node; this.options = options; }
        disconnect() { this.disconnected = true; }
    }
    const Search = productionClass('electron-browser/nodu-project-search.ts', 'NoduProjectSearch',
        ['opening', 'init', 'updateProject', 'openSearch', 'layoutSearch'], { isOSX: mac, ResizeObserver, MutationObserver, postConstruct: () => () => {} });
    const search = new Search();
    search.workspace = {
        workspace, roots: roots.promise, tryGetRoots: () => [],
        onWorkspaceChanged(callback) { listeners.roots = callback; return { dispose() { delete listeners.roots; } }; },
        onWorkspaceLocationChanged(callback) { listeners.location = callback; return { dispose() { delete listeners.location; } }; },
    };
    search.name = { textContent: '' };
    search.button = { attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } };
    search.node = { style: {}, hidden: false };
    const elements = { '.lm-MenuBar': menu, '.nodu-titlebar-toolbar': toolbar, '#window-controls': controls };
    search.shell = { topPanel: { node: { clientWidth: width, querySelector(selector) { assert.ok(selector in elements); return elements[selector]; } } } };
    search.commands = { executeCommand: async (...args) => { calls.push(['command', ...args]); } };
    search.messages = { error: async message => { calls.push(['error', message]); } };
    search.toDispose = { push(...items) { disposables.push(...items); } };
    return { search, listeners, observers, mutations, elements, calls, disposables, roots };
}

test('title search follows project and workspace names, with a useful empty fallback', () => {
    const { search } = searchFixture();
    search.updateProject();
    assert.equal(search.name.textContent, 'uart-demo');
    assert.equal(search.button.attributes['aria-label'], '搜索项目 uart-demo 中的文件');
    search.workspace.workspace = workspaceFile('Board Lab'); search.updateProject();
    assert.equal(search.name.textContent, 'Board Lab');
    search.workspace.workspace = undefined;
    search.workspace.tryGetRoots = () => [directory('fallback-root')]; search.updateProject();
    assert.equal(search.name.textContent, 'fallback-root');
    search.workspace.tryGetRoots = () => []; search.updateProject();
    assert.equal(search.name.textContent, '搜索文件');
    assert.equal(search.button.attributes['aria-label'], '搜索文件');
});

test('workspace events refresh the title; active-file changes never replace the project label', async () => {
    const f = searchFixture(); f.search.init();
    assert.equal(f.search.name.textContent, 'uart-demo');
    f.search.activeEditor = { title: { label: 'main.c' } };
    f.search.updateProject(); assert.equal(f.search.name.textContent, 'uart-demo');
    f.search.activeEditor.title.label = 'board.h'; f.search.updateProject();
    assert.equal(f.search.name.textContent, 'uart-demo');
    f.search.workspace.workspace = directory('sensor'); f.listeners.roots();
    assert.equal(f.search.name.textContent, 'sensor');
    f.search.workspace.workspace = workspaceFile('Renamed'); f.listeners.location();
    assert.equal(f.search.name.textContent, 'Renamed');
    assert.ok(f.observers[0].observed.has(f.search.shell.topPanel.node));
    f.observers[0].callback(); assert.ok(Math.abs(parseFloat(f.search.node.style.width) - 411.6) < 0.001);
    f.search.isDisposed = true; f.search.workspace.workspace = directory('late');
    f.roots.resolve([]); await f.roots.promise; await Promise.resolve();
    assert.equal(f.search.name.textContent, 'Renamed', 'late workspace readiness cannot update a disposed widget');
    f.disposables.forEach(item => item.dispose());
    assert.equal(f.observers[0].disconnected, true); assert.equal(f.mutations[0].disconnected, true); assert.deepEqual(f.listeners, {});
});

test('opening search only executes the existing file picker command and suppresses duplicate clicks', async () => {
    const { search, calls } = searchFixture(), pending = deferred();
    search.commands.executeCommand = (...args) => { calls.push(['command', ...args]); return pending.promise; };
    const first = search.openSearch(); await search.openSearch();
    assert.deepEqual(calls, [['command', 'file-search.openFile']]);
    pending.resolve(); await first; assert.equal(search.opening, false);
    search.commands.executeCommand = async (...args) => { calls.push(['command', ...args]); };
    await search.openSearch();
    assert.deepEqual(calls, [['command', 'file-search.openFile'], ['command', 'file-search.openFile']]);
    search.isDisposed = true; await search.openSearch(); assert.equal(calls.length, 2);
});

test('file picker failure is reported without leaking backend text and permits retry', async () => {
    const { search, calls } = searchFixture({ mac: false });
    search.commands.executeCommand = async command => { calls.push(['command', command]); throw Error('internal fixture failure'); };
    await search.openSearch();
    assert.deepEqual(calls, [['command', 'file-search.openFile'], ['error', '无法打开文件搜索，请重试。']]);
    assert.equal(search.opening, false);
    search.commands.executeCommand = async command => { calls.push(['command', command]); };
    await search.openSearch(); assert.deepEqual(calls.at(-1), ['command', 'file-search.openFile']);
    search.updateProject(); assert.ok(search.button.title.includes('Ctrl+P'));
});

function assertLayout(fixture, leftReserve, rightReserve) {
    fixture.search.layoutSearch();
    const width = parseFloat(fixture.search.node.style.width), left = parseFloat(fixture.search.node.style.left);
    assert.ok(width >= 0 && width <= 420);
    if (!fixture.search.node.hidden) {
        assert.ok(left >= leftReserve);
        assert.ok(left + width <= fixture.search.shell.topPanel.node.clientWidth - rightReserve + 0.001);
    }
    return { width, left };
}

test('mac title geometry remains centered and reserves traffic lights at narrow widths', () => {
    for (const width of [1520, 980, 640, 320]) {
        const f = searchFixture({ width }); const rect = assertLayout(f, 100, 100);
        assert.equal(f.search.node.hidden, false);
        assert.ok(Math.abs(rect.left + rect.width / 2 - width / 2) < 0.001);
    }
    const tiny = searchFixture({ width: 250 }); assertLayout(tiny, 100, 100);
    assert.equal(tiny.search.node.hidden, true);
});

test('non-mac geometry avoids both menus and window controls and hides rather than overlaps', () => {
    for (const [width, menuWidth] of [[1520, 330], [980, 350], [640, 330], [640, 420]]) {
        const f = searchFixture({ mac: false, width, menu: { offsetLeft: 8, offsetWidth: menuWidth } });
        assertLayout(f, 8 + menuWidth + 16, 156);
        assert.equal(f.search.node.hidden, width - (8 + menuWidth + 16) - 156 < 80);
    }
    assertLayout(searchFixture({ mac: false, width: 980 }), 16, 156);
});

test('professional header reserves the live toolbar width and restores centered search when it moves to the rail', () => {
    const f = searchFixture({ width: 1200 });
    f.search.init();
    assert.equal(parseFloat(f.search.node.style.left), 390);
    const toolbar = { offsetLeft: 720, offsetWidth: 472 };
    f.elements['.nodu-titlebar-toolbar'] = toolbar;
    f.mutations[0].callback();
    assert.ok(f.observers[0].observed.has(toolbar));
    assertLayout(f, 100, 1200 - toolbar.offsetLeft + 12);
    assert.equal(parseFloat(f.search.node.style.left) + parseFloat(f.search.node.style.width), 708);
    toolbar.offsetLeft = 620; toolbar.offsetWidth = 572;
    f.observers[0].callback();
    assert.equal(parseFloat(f.search.node.style.left) + parseFloat(f.search.node.style.width), 608);
    delete f.elements['.nodu-titlebar-toolbar'];
    // QuerySelector still recognizes the target when no matching child remains.
    f.elements['.nodu-titlebar-toolbar'] = undefined;
    f.mutations[0].callback();
    assert.equal(f.observers[0].observed.has(toolbar), false);
    assert.equal(parseFloat(f.search.node.style.left), 390);
});

test('professional search yields space to Windows menu, tools and native controls without overlap', () => {
    const toolbar = { offsetLeft: 730, offsetWidth: 320 };
    const f = searchFixture({ mac: false, width: 1200, menu: { offsetLeft: 8, offsetWidth: 330 }, toolbar,
        controls: { offsetLeft: 1062, offsetWidth: 138 } });
    assertLayout(f, 354, 482);
    assert.equal(f.search.node.hidden, false);
    toolbar.offsetLeft = 430;
    assertLayout(f, 354, 782);
    assert.equal(f.search.node.hidden, true);
    toolbar.offsetWidth = 0; // A hidden toolbar reserves no stale space.
    assertLayout(f, 354, 156);
    assert.equal(f.search.node.hidden, false);
    f.elements['#window-controls'] = { offsetLeft: 970, offsetWidth: 230 };
    assertLayout(f, 354, 242);
});

test('title observers ignore queued callbacks after disposal', () => {
    const f = searchFixture(); f.search.init();
    const before = { ...f.search.node.style };
    f.search.isDisposed = true;
    f.search.shell.topPanel.node.clientWidth = 400;
    f.mutations[0].callback(); f.observers[0].callback();
    assert.deepEqual(f.search.node.style, before);
});

function menuFixture({ mac = true, query = '' } = {}) {
    const calls = [], widgets = [], classes = new Set();
    class Base {
        setMenu(app) { calls.push('base-menu'); this.createCustomTitleWidget(app); }
        createCustomTitleWidget(app) { calls.push('title-created'); app.shell.addWidget({ id: 'nodu-project-search' }, { area: 'top' }); }
    }
    const Menu = productionClass('electron-browser/nodu-electron-menu-contribution.ts', 'NoduElectronMenuContribution',
        ['projectTitleMounted', 'setMenu', 'createCustomTitleWidget'], {
            isOSX: mac, NODU_LAUNCHER_QUERY: 'noduLauncher', URLSearchParams,
            window: { location: { search: query } }, Widget: class {},
        }, Base);
    const menu = new Menu(); menu.factory = { setMenuBar() { calls.push('native-menu'); } };
    const app = { shell: { topPanel: { show() { calls.push('show'); }, addClass(name) { classes.add(name); } },
        addWidget(widget, options) { assert.deepEqual(options, { area: 'top' }); widgets.push(widget); } } };
    return { menu, app, calls, widgets, classes };
}

test('repeated mac window focus mounts one drag region and one project search widget', () => {
    const f = menuFixture(); for (let i = 0; i < 4; i++) f.menu.setMenu(f.app);
    assert.deepEqual(f.widgets.map(widget => widget.id), ['theia-drag-panel', 'nodu-project-search']);
    assert.equal(f.calls.filter(call => call === 'native-menu').length, 4);
    assert.equal(f.calls.filter(call => call === 'title-created').length, 1);
    assert.equal(f.classes.has('nodu-project-titlebar'), true);
});

test('launcher never mounts project search, while non-mac retains the native Theia menu path', () => {
    for (const mac of [true, false]) {
        const f = menuFixture({ mac, query: '?port=1&noduLauncher=1' });
        f.menu.setMenu(f.app); f.menu.setMenu(f.app);
        assert.deepEqual(f.calls, ['native-menu', 'native-menu']); assert.equal(f.widgets.length, 0);
    }
    const f = menuFixture({ mac: false }); f.menu.setMenu(f.app); f.menu.setMenu(f.app);
    assert.equal(f.calls.filter(call => call === 'base-menu').length, 2);
    assert.deepEqual(f.widgets.map(widget => widget.id), ['nodu-project-search']);
});

test('mac hidden title defaults preserve window sizing and security/preload options without mutating base defaults', () => {
    const original = { width: 1520, height: 960, minWidth: 980, minHeight: 720, frame: true,
        webPreferences: { preload: '/app/preload.js', contextIsolation: true, nodeIntegration: false },
        backgroundColor: '#14171c', titleBarStyle: 'default' };
    class Base { getDefaultOptions() { return original; } }
    for (const mac of [true, false]) {
        const App = productionClass('electron-main/nodu-electron-main-application.ts', 'NoduElectronMainApplication', ['getDefaultOptions'], { isOSX: mac }, Base);
        const result = new App().getDefaultOptions();
        assert.equal(result.width, 1520); assert.equal(result.height, 960); assert.equal(result.minWidth, 980);
        assert.equal(result.minHeight, 720); assert.equal(result.frame, true);
        assert.equal(result.webPreferences, original.webPreferences); assert.equal(result.backgroundColor, '#14171c');
        assert.equal(result.titleBarStyle, mac ? 'hidden' : 'default');
        if (mac) assert.deepEqual(result.trafficLightPosition, { x: 14, y: 10 });
        else assert.equal(result, original);
    }
    assert.equal(original.titleBarStyle, 'default'); assert.equal(original.trafficLightPosition, undefined);
});
