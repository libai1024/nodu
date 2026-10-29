// SPDX-License-Identifier: MIT
// Exercise production copy/paste/drop handlers with real URI and context validation.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const URI = require('@theia/core/lib/common/uri').default;
const compile = relative => ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
}).outputText;
const context = {};
vm.runInNewContext(compile('common/tutor/tutor-context.ts'), { exports: context, TextEncoder, Error });
const code = compile('browser/nodu-tutor-context-transfer.ts');
const plain = value => JSON.parse(JSON.stringify(value));
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
class Target {
    contains(node) { return node === this || node?.parent === this; }
}
class TextArea extends Target {
    inComposer = true;
    closest(selector) { return this.inComposer && selector === '.nodu-ai-composer' ? this : undefined; }
}
function clipboard(values = {}, files = [], extraTypes = []) {
    const data = new Map(Object.entries(values));
    return { files, get types() { return [...data.keys(), ...extraTypes]; }, getData: type => data.get(type) ?? '', setData: (type, value) => data.set(type, value) };
}
function event(data, type = 'paste', target) {
    return { target, [type === 'drop' ? 'dataTransfer' : 'clipboardData']: data, prevented: false, stopped: false,
        preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
}
function mount() {
    const exports = {}, listeners = new Map(), windowListeners = new Map(), clipboardListeners = new Set(), executed = [];
    const window = {
        addEventListener(name, listener) { windowListeners.set(name, listener); },
        removeEventListener(name, listener) { if (windowListeners.get(name) === listener) windowListeners.delete(name); },
        dispatch(name) { windowListeners.get(name)?.(); }
    };
    const document = {
        activeElement: undefined,
        execCommand(...args) { executed.push(args); return true; },
        addEventListener(name, listener, capture) { listeners.set(name, { listener, capture }); },
        removeEventListener(name, listener, capture) { const entry = listeners.get(name); if (entry?.listener === listener && entry.capture === capture) listeners.delete(name); }
    };
    const decorators = { injectable: () => target => target, inject: () => () => undefined };
    vm.runInNewContext(code, { exports, document, window, Node: Target, HTMLTextAreaElement: TextArea, TextEncoder, Error, require: id => {
        if (id.endsWith('/inversify')) return decorators;
        if (id.endsWith('/common/uri')) return { default: URI };
        if (id.endsWith('/common/file-uri')) return require('@theia/core/lib/common/file-uri');
        if (id === '@theia/core/lib/browser') return { CommonCommands: { PASTE: { id: 'paste' }, COPY: { id: 'copy' }, CUT: { id: 'cut' } } };
        if (id.endsWith('/monaco-editor')) return { MonacoEditor: { get: widget => widget.monaco } };
        if (id.endsWith('/tutor-context')) return context;
        return {};
    } });
    const state = { focused: true, disposed: false, selected: 'first();\r\nsecond();\r\n', text: 'unsaved();\r\nnext();', nativeText: '', version: 7,
        ranges: [{ startLineNumber: 3, endLineNumber: 5, endColumn: 1, isEmpty: () => false }] };
    const dom = new Target(), target = new Target(); target.parent = dom;
    const model = { getValueInRange: () => state.selected, getValue: () => state.text, getVersionId: () => state.version, isDisposed: () => state.disposed };
    const editor = { getModel: () => model, getSelections: () => state.ranges, hasTextFocus: () => state.focused, getDomNode: () => dom,
        trigger(...args) { executed.push(args); } };
    const widget = { editor: { uri: new URI('file:///project/main.c') }, monaco: { getControl: () => editor } };
    const editors = { currentEditor: widget, all: [widget] }, copied = { content: undefined }, calls = [], transfers = { begun: 0, pending: 0, released: 0 };
    const tutor = { workspaceId: 'workspace', activeConversationId: 'conversation', mode: 'ask', epoch: 1, rootUri: new URI('file:///project'), conversationLoading: false,
        beginContextTransfer() { transfers.begun++; transfers.pending++; let finished = false; return () => { if (!finished) { finished = true; transfers.pending--; transfers.released++; } }; },
        addContextSnapshot: async value => { calls.push(['snapshot', plain(value)]); return true; },
        addContextFile: async value => { calls.push(['file', value]); return true; }, notify() { calls.push(['notify']); } };
    const nativeClipboard = { readText: () => state.nativeText,
        onDidWriteText(callback) { clipboardListeners.add(callback); return { dispose: () => clipboardListeners.delete(callback) }; },
        writeText(text) { state.nativeText = text; for (const callback of clipboardListeners) callback(text); } };
    const transfer = Object.assign(new exports.NoduTutorContextTransfer(), { editors, fileClipboard: { get: () => copied.content }, clipboard: nativeClipboard, tutor });
    const copy = () => { state.nativeText = state.selected; const data = clipboard({ 'text/plain': state.selected, 'text/html': '<code>original</code>' }); const e = event(data, 'copy', target); transfer.captureSelection(e); return { data, event: e }; };
    const commands = new Map(); transfer.registerCommands({ registerHandler: (id, handler) => commands.set(id, handler) });
    const composer = new TextArea();
    return { transfer, tutor, state, editors, copied, calls, transfers, target, widget, window, listeners, windowListeners, clipboardListeners, document, nativeClipboard, executed, commands, composer, copy, mime: exports.TUTOR_SELECTION_MIME };
}

test('copy captures source and exclusive end-line metadata without replacing native text or HTML', () => {
    const c = mount(); c.transfer.onStart();
    assert.deepEqual([...c.listeners.keys()], ['copy', 'cut']);
    assert.ok([...c.listeners.values()].every(entry => entry.capture));
    const { data, event: e } = c.copy(), value = JSON.parse(data.getData(c.mime));
    assert.deepEqual(value, { schema: 1, uri: 'file:///project/main.c', plain: 'first();\r\nsecond();\r\n', version: 7,
        text: 'first();\nsecond();', startLine: 3, endLine: 4 });
    assert.equal(data.getData('text/plain'), c.state.selected); assert.equal(data.getData('text/html'), '<code>original</code>');
    assert.equal(e.prevented || e.stopped, false);
    c.transfer.onStop(); assert.equal(c.listeners.size, 0); assert.equal(c.windowListeners.size, 0); assert.equal(c.clipboardListeners.size, 0);
});

test('copy metadata is limited to a focused editor with one nonempty bounded selection', () => {
    for (const change of [
        c => { c.state.focused = false; },
        c => { c.editors.currentEditor = undefined; },
        c => { c.state.ranges = []; },
        c => { c.state.ranges.push(c.state.ranges[0]); },
        c => { c.state.ranges[0].isEmpty = () => true; },
        c => { c.state.selected = '中'.repeat(22000); }
    ]) {
        const c = mount(); change(c); assert.equal(c.copy().data.getData(c.mime), '');
    }
    const c = mount(), data = clipboard(); c.transfer.captureSelection(event(data, 'copy', new Target()));
    assert.equal(data.getData(c.mime), '', 'copy in another control must not reuse the editor selection');
    c.transfer.captureSelection(event(data, 'copy', {})); assert.equal(data.getData(c.mime), '');
});

test('paste references the copy-time source and lines after the editor selection changes', async () => {
    const c = mount(), { data } = c.copy();
    c.state.selected = 'different'; c.state.version = 20; c.widget.editor.uri = new URI('file:///project/other.c');
    data.setData('text/plain', 'first();\nsecond();\n');
    const e = event(data); assert.equal(c.transfer.paste(e, c.tutor), true); await settle();
    assert.equal(e.prevented && e.stopped, true);
    assert.deepEqual(c.calls, [['snapshot', { kind: 'selection', path: 'main.c', text: 'first();\nsecond();', version: 7, startLine: 3, endLine: 4 }]]);
});

test('ordinary text, stale or malformed selection metadata, and cross-project copies retain native paste', async () => {
    for (const change of [
        (c, data) => data.setData(c.mime, ''),
        (c, data) => data.setData('text/plain', 'external clipboard content'),
        (c, data) => data.setData(c.mime, '{broken'),
        (c, data) => data.setData(c.mime, JSON.stringify({ ...JSON.parse(data.getData(c.mime)), schema: 2 })),
        (c, data) => data.setData(c.mime, JSON.stringify({ ...JSON.parse(data.getData(c.mime)), endLine: 20 })),
        c => { c.tutor.rootUri = new URI('file:///another-project'); },
        (c, data) => data.setData(c.mime, JSON.stringify({ ...JSON.parse(data.getData(c.mime)), uri: 'file:///project/main.c#L3' })),
        (c, data) => data.setData(c.mime, JSON.stringify({ ...JSON.parse(data.getData(c.mime)), uri: 'https://example.org/main.c' }))
    ]) {
        const c = mount(), { data } = c.copy(); change(c, data); const e = event(data);
        assert.equal(c.transfer.paste(e, c.tutor), false); await settle();
        assert.equal(e.prevented || e.stopped, false); assert.deepEqual(c.calls, []);
    }
});

test('navigator paste requires exact provenance and deduplicates multiple file URIs', async () => {
    const c = mount(); c.editors.all = [];
    c.copied.content = 'file:///project/main.c\nfile:///project/driver.c\nfile:///project/main.c';
    const e = event(clipboard({ 'text/plain': c.copied.content }));
    assert.equal(c.transfer.paste(e, c.tutor), true); await settle();
    assert.equal(e.prevented && e.stopped, true); assert.deepEqual(c.calls, [['file', 'main.c'], ['file', 'driver.c']]);
    for (const value of ['file:///project/other.c', '/project/main.c', 'plain code']) {
        c.calls.length = 0; const next = event(clipboard({ 'text/plain': value }));
        assert.equal(c.transfer.paste(next, c.tutor), false); assert.equal(next.prevented, false); assert.deepEqual(c.calls, []);
    }
    c.copied.content = undefined; const native = event(clipboard({ 'text/plain': 'file:///project/main.c' }));
    assert.equal(c.transfer.paste(native, c.tutor), false, 'a URI typed or copied elsewhere is not automatically a navigator reference');
});

test('file transfers snapshot an open unsaved document and read a disposed document from disk', async () => {
    const c = mount(); c.copied.content = c.widget.editor.uri.toString();
    c.transfer.paste(event(clipboard({ 'text/plain': c.copied.content })), c.tutor); await settle();
    assert.deepEqual(c.calls, [['snapshot', { kind: 'file', path: 'main.c', text: 'unsaved();\nnext();', version: 7, startLine: 1, endLine: 2 }]]);
    c.calls.length = 0; c.state.disposed = true;
    c.transfer.paste(event(clipboard({ 'text/plain': c.copied.content })), c.tutor); await settle();
    assert.deepEqual(c.calls, [['file', 'main.c']]);
});

test('dragging accepts Theia resources and URI lists but leaves ordinary dragged text alone', async () => {
    for (const values of [
        { 'theia-editor-dnd': 'file:///project/driver.c\nfile:///project/helper.c' },
        { 'text/uri-list': '# copied resources\r\nfile:///project/driver.c\r\nfile:///project/helper.c\r\n' }
    ]) {
        const c = mount(), e = event(clipboard(values), 'drop');
        assert.equal(c.transfer.acceptsDrop(e.dataTransfer), true); assert.equal(c.transfer.drop(e, c.tutor), true); await settle();
        assert.equal(e.prevented && e.stopped, true); assert.deepEqual(c.calls, [['file', 'driver.c'], ['file', 'helper.c']]);
    }
    const c = mount(), e = event(clipboard({ 'text/plain': 'ordinary dragged text' }), 'drop');
    assert.equal(c.transfer.acceptsDrop(e.dataTransfer), false); assert.equal(c.transfer.drop(e, c.tutor), false);
    assert.equal(e.prevented || e.stopped, false); assert.deepEqual(c.calls, []);
});

test('native file drops use the Electron path bridge, never an ambiguous basename', async () => {
    const c = mount(), file = { name: 'driver.c' }, seen = [];
    c.window.electronTheiaCore = { getPathForFile(value) { seen.push(value); return '/project/sub/driver.c'; } };
    const e = event(clipboard({}, [file], ['Files']), 'drop');
    assert.equal(c.transfer.drop(e, c.tutor), true); await settle();
    assert.deepEqual(seen, [file]); assert.deepEqual(c.calls, [['file', 'sub/driver.c']]);
    const missing = mount(); missing.transfer.drop(event(clipboard({}, [file], ['Files']), 'drop'), missing.tutor); await settle();
    assert.match(missing.tutor.contextError, /无法识别文件路径/); assert.deepEqual(missing.calls, [['notify']]);
});

test('file transfers reject outside roots, URI queries, empty payloads and overlarge batches before attaching', async () => {
    for (const payload of [
        'file:///project/good.c\nfile:///outside/bad.c',
        'file:///project/../outside/bad.c',
        'file://other-host/project/main.c',
        'file:///project/main.c?download=1',
        '',
        Array.from({ length: 7 }, (_, i) => `file:///project/file${i}.c`).join('\n')
    ]) {
        const c = mount(), e = event(clipboard({ 'theia-editor-dnd': payload }), 'drop');
        assert.equal(c.transfer.drop(e, c.tutor), true); await settle();
        assert.equal(e.prevented, true); assert.ok(c.tutor.contextError); assert.deepEqual(c.calls, [['notify']]);
    }
});

test('a transfer stops remaining attachments when its conversation, project, mode or epoch changes', async () => {
    for (const change of [
        tutor => { tutor.activeConversationId = 'other-conversation'; },
        tutor => { tutor.workspaceId = 'other-project'; },
        tutor => { tutor.mode = 'teach'; },
        tutor => { tutor.epoch++; },
        tutor => { tutor.conversationLoading = true; }
    ]) {
        const c = mount(), pending = deferred();
        c.tutor.addContextFile = async file => { c.calls.push(['file', file]); return pending.promise; };
        c.transfer.drop(event(clipboard({ 'theia-editor-dnd': 'file:///project/one.c\nfile:///project/two.c' }), 'drop'), c.tutor);
        assert.deepEqual(c.calls, [['file', 'one.c']]); change(c.tutor); pending.resolve(true); await settle();
        assert.deepEqual(c.calls, [['file', 'one.c']]); assert.equal(c.tutor.contextError, undefined);
    }
});

test('a failed attachment stops the batch and late errors do not overwrite a different conversation', async () => {
    const c = mount(); c.tutor.addContextFile = async file => { c.calls.push(['file', file]); return false; };
    c.transfer.drop(event(clipboard({ 'theia-editor-dnd': 'file:///project/one.c\nfile:///project/two.c' }), 'drop'), c.tutor); await settle();
    assert.deepEqual(c.calls, [['file', 'one.c']]);
    const late = mount(), pending = deferred(); late.tutor.addContextFile = () => pending.promise;
    late.transfer.drop(event(clipboard({ 'theia-editor-dnd': 'file:///project/one.c' }), 'drop'), late.tutor);
    late.tutor.activeConversationId = 'new'; pending.reject(new Error('old read failed')); await settle();
    assert.equal(late.tutor.contextError, undefined); assert.deepEqual(late.calls, []);
});

test('native file drops preserve Windows drive roots and UNC server authorities', async () => {
    for (const [root, nativePath] of [
        ['file:///c%3A/work/demo', 'C:\\work\\demo\\src\\main.c'],
        ['file://server/share/demo', '\\\\server\\share\\demo\\src\\main.c']
    ]) {
        const c = mount(); c.tutor.rootUri = new URI(root);
        c.window.electronTheiaCore = { getPathForFile: () => nativePath };
        c.transfer.drop(event(clipboard({}, [{ name: 'main.c' }], ['Files']), 'drop'), c.tutor); await settle();
        assert.deepEqual(c.calls, [['file', 'src/main.c']]); assert.equal(c.tutor.contextError, undefined);
    }
    const foreign = mount(); foreign.tutor.rootUri = new URI('file://server/share/demo');
    foreign.window.electronTheiaCore = { getPathForFile: () => '\\\\other-server\\share\\demo\\src\\main.c' };
    foreign.transfer.drop(event(clipboard({}, [{ name: 'main.c' }], ['Files']), 'drop'), foreign.tutor); await settle();
    assert.deepEqual(foreign.calls, [['notify']]); assert.match(foreign.tutor.contextError, /当前工程/);
});

test('native paste is scoped to the composer and editor copy/cut use Monaco clipboard actions', () => {
    const c = mount();
    assert.equal(c.commands.get('paste').isEnabled(), false);
    c.document.activeElement = c.composer; assert.equal(c.commands.get('paste').isEnabled(), true);
    c.composer.inComposer = false; assert.equal(c.commands.get('paste').isEnabled(), false);
    c.document.activeElement = c.target;
    for (const action of ['copy', 'cut']) { assert.equal(c.commands.get(action).isEnabled(), true); c.commands.get(action).execute(); }
    assert.deepEqual(c.executed, [
        ['nodu.editor-clipboard', 'editor.action.clipboardCopyAction', null],
        ['nodu.editor-clipboard', 'editor.action.clipboardCutAction', null],
    ]);
    c.state.focused = false; assert.equal(c.commands.get('copy').isEnabled(), false);
    c.state.focused = true; c.document.activeElement = new Target(); assert.equal(c.commands.get('cut').isEnabled(), false);
});

test('native paste command attaches navigator files without DOM paste or plain URI insertion', async () => {
    const c = mount(); c.document.activeElement = c.composer; c.editors.all = [];
    c.state.nativeText = c.copied.content = 'file:///project/main.c\nfile:///project/driver.c';
    await c.commands.get('paste').execute(); await settle();
    assert.deepEqual(c.calls, [['file', 'main.c'], ['file', 'driver.c']]); assert.deepEqual(c.executed, []);
});

test('native paste uses the saved copy-time selection when only clipboard plain text is available', async () => {
    const c = mount(); c.copy();
    c.widget.editor.uri = new URI('file:///project/other.c'); c.state.selected = 'different'; c.state.version = 99;
    c.document.activeElement = c.composer; await c.commands.get('paste').execute();
    assert.deepEqual(c.calls, [['snapshot', { kind: 'selection', path: 'main.c', text: 'first();\nsecond();', version: 7, startLine: 3, endLine: 4 }]]);
    assert.deepEqual(c.executed, []);
});

test('native paste inserts ordinary text and invalidated selection copies without guessing a source', async () => {
    for (const invalidate of [
        c => c.window.dispatch('blur'),
        c => c.nativeClipboard.writeText(c.state.nativeText),
        c => c.transfer.captureSelection(event(clipboard(), 'copy', new Target())),
        c => { c.state.nativeText = 'fresh ordinary text'; }
    ]) {
        const c = mount(); c.transfer.onStart(); c.copy(); invalidate(c);
        c.document.activeElement = c.composer; await c.commands.get('paste').execute();
        assert.deepEqual(c.calls, []); assert.deepEqual(c.executed, [['insertText', false, c.state.nativeText]]);
        c.transfer.onStop();
    }
    const c = mount(); c.document.activeElement = c.composer;
    await c.commands.get('paste').execute(); assert.deepEqual(c.executed, [], 'empty clipboard text must not alter the draft');
});

test('pending native clipboard reads are abandoned after focus, identity or clipboard changes', async () => {
    for (const change of [
        c => { c.document.activeElement = new Target(); },
        c => c.window.dispatch('blur'),
        c => { c.tutor.activeConversationId = 'other'; },
        c => { c.tutor.workspaceId = 'other-project'; },
        c => { c.tutor.mode = 'teach'; },
        c => { c.tutor.epoch++; },
        c => c.nativeClipboard.writeText('new clipboard'),
        c => c.transfer.captureSelection(event(clipboard(), 'cut', new Target()))
    ]) {
        const c = mount(), pending = deferred(); c.transfer.onStart(); c.document.activeElement = c.composer;
        c.nativeClipboard.readText = () => pending.promise;
        const operation = c.commands.get('paste').execute(); assert.equal(c.transfers.pending, 1); change(c); pending.resolve('old clipboard text'); await operation;
        assert.deepEqual(c.executed, []); assert.deepEqual(c.calls, []); assert.deepEqual(c.transfers, { begun: 1, pending: 0, released: 1 }); c.transfer.onStop();
    }
});

test('clipboard read errors appear only in the originating composer conversation', async () => {
    const current = mount(); current.document.activeElement = current.composer;
    current.nativeClipboard.readText = async () => { throw new Error('clipboard denied'); };
    await current.commands.get('paste').execute(); assert.equal(current.tutor.contextError, 'clipboard denied'); assert.deepEqual(current.calls, [['notify']]);
    assert.deepEqual(current.transfers, { begun: 1, pending: 0, released: 1 });
    for (const change of [c => { c.tutor.activeConversationId = 'new'; }, c => c.window.dispatch('blur'), c => c.nativeClipboard.writeText('new copy')]) {
        const c = mount(), pending = deferred(); c.transfer.onStart(); c.document.activeElement = c.composer;
        c.nativeClipboard.readText = () => pending.promise;
        const operation = c.commands.get('paste').execute(); change(c); pending.reject(new Error('stale read failure')); await operation;
        assert.equal(c.tutor.contextError, undefined); assert.deepEqual(c.calls, []); assert.deepEqual(c.transfers, { begun: 1, pending: 0, released: 1 }); c.transfer.onStop();
    }
});

test('native paste acquires the transfer guard before reading and releases it after text insertion', async () => {
    const c = mount(), pending = deferred(); c.document.activeElement = c.composer;
    c.nativeClipboard.readText = () => { assert.equal(c.transfers.pending, 1); return pending.promise; };
    const operation = c.commands.get('paste').execute(); assert.deepEqual(c.transfers, { begun: 1, pending: 1, released: 0 });
    c.document.execCommand = (...args) => { assert.equal(c.transfers.pending, 1); c.executed.push(args); return true; };
    pending.resolve('pasted prompt'); await operation;
    assert.deepEqual(c.executed, [['insertText', false, 'pasted prompt']]); assert.deepEqual(c.transfers, { begun: 1, pending: 0, released: 1 });
    c.document.activeElement = undefined; await c.commands.get('paste').execute();
    assert.deepEqual(c.transfers, { begun: 1, pending: 0, released: 1 }, 'a command without a composer must not leave a guard');
});
