// SPDX-License-Identifier: MIT
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');
const source = path.resolve(__dirname, '../scope-extension/src/browser/nodu-console-state.ts');
const compiled = new Module(source, module);
compiled.filename = source;
compiled._compile(transformSync(fs.readFileSync(source, 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code, source);
const { ConsoleBuffer, findConsoleMatches, canBrowsePythonHistory, shouldExecutePython } = compiled.exports;

const enter = { key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false };
test('Python submission does not send IME composition or unfinished multiline input', () => {
    assert.equal(shouldExecutePython('print(42)', enter), true);
    assert.equal(shouldExecutePython('print(42)', { ...enter, isComposing: true }), false);
    assert.equal(shouldExecutePython('print(42)', { ...enter, keyCode: 229 }), false);
    assert.equal(shouldExecutePython('print(42)', { ...enter, shiftKey: true }), false);
    assert.equal(shouldExecutePython('for i in range(3):\n    print(i)', enter), false);
    assert.equal(shouldExecutePython('for i in range(3):\n    print(i)', { ...enter, ctrlKey: true }), true);
    assert.equal(shouldExecutePython('for i in range(3):\n    print(i)', { ...enter, metaKey: true }), true);
    assert.equal(shouldExecutePython('print(42)', { ...enter, ctrlKey: true, isComposing: true }), false);
});
test('history navigation does not hijack multiline cursor movement or a selection', () => {
    const code = 'first\nsecond\nthird';
    assert.equal(canBrowsePythonHistory(code, 7, 7, 'previous'), false);
    assert.equal(canBrowsePythonHistory(code, 7, 7, 'next'), false);
    assert.equal(canBrowsePythonHistory(code, 3, 3, 'previous'), true);
    assert.equal(canBrowsePythonHistory(code, code.length, code.length, 'next'), true);
    assert.equal(canBrowsePythonHistory(code, 0, 5, 'previous'), false);
});
test('a clear cursor distinguishes events that have the same timestamp', () => {
    const buffer = new ConsoleBuffer();
    buffer.append('first\n', 'stdout');
    const clearCursor = buffer.sequence;
    buffer.append('second\n', 'stdout');
    assert.deepEqual(buffer.records.filter(record => record.sequence > clearCursor).map(record => record.text), ['second\n']);
});
test('bounded output retains monotonic ordering and measurable truncation', () => {
    const buffer = new ConsoleBuffer();
    for (let index = 0; index < 350; index++) { buffer.append(`${index}\n`, 'stdout'); }
    assert.equal(buffer.records.length, 300);
    assert.equal(buffer.records[0].sequence, 51);
    assert.equal(buffer.sequence, 350);
    const large = new ConsoleBuffer();
    for (let index = 0; index < 8; index++) { large.append('x'.repeat(32000), 'stdout'); }
    assert.ok(large.records.reduce((sum, record) => sum + record.text.length, 0) <= 200000);
    assert.equal(large.records[0].sequence, 3);
    large.append('prefix🙂' + 'x'.repeat(31999), 'stderr');
    assert.equal(large.records.at(-1).text, 'x'.repeat(31999));
    assert.equal(large.records.at(-1).clippedCharacters, 8);
});
test('search treats regex syntax as literal and retains original Unicode positions', () => {
    assert.deepEqual(findConsoleMatches('a[0] = A[0]', 'a[0]').matches, [{ start: 0, end: 4 }, { start: 7, end: 11 }]);
    assert.deepEqual(findConsoleMatches('🙂 ERROR\nerror', 'error').matches, [{ start: 3, end: 8 }, { start: 9, end: 14 }]);
    assert.deepEqual(findConsoleMatches('text', '').matches, []);
    assert.deepEqual(findConsoleMatches('a.b a+b', '+').matches, [{ start: 5, end: 6 }]);
});
test('search bounds rendered matches and reports additional occurrences', () => {
    const result = findConsoleMatches('x'.repeat(200000), 'x');
    assert.equal(result.matches.length, 1000);
    assert.equal(result.hasMore, true);
    assert.equal(findConsoleMatches('xxx', 'x', 3).hasMore, false);
});

// Exercise submission outcomes without connecting a board or a browser. The
// widget's UI host is stubbed; its actual submission/state methods run unchanged.
const widgetSource = path.resolve(__dirname, '../scope-extension/src/browser/nodu-console-widget.tsx');
class WidgetHost { isDisposed = false; isVisible = true; update() {} }
const widgetModule = new Module(widgetSource, module);
widgetModule.filename = widgetSource;
const decorator = () => () => {};
const token = class {};
widgetModule.require = id => {
    if (id === './nodu-console-state') { return compiled.exports; }
    if (id.endsWith('.css')) { return {}; }
    if (id === '@theia/core/shared/react') { return { createRef: () => ({ current: null }) }; }
    if (id === '@theia/core/shared/inversify') { return { inject: decorator, injectable: decorator, postConstruct: () => {} }; }
    if (id === '@theia/core/lib/browser') { return { ReactWidget: WidgetHost }; }
    return new Proxy({}, { get: () => token });
};
widgetModule._compile(transformSync(fs.readFileSync(widgetSource, 'utf8'), {
    loader: 'tsx', format: 'cjs', target: 'node24', tsconfigRaw: { compilerOptions: { experimentalDecorators: true } }
}).code, widgetSource);
const { NoduConsoleWidget } = widgetModule.exports;
const makeWidget = execute => {
    const widget = new NoduConsoleWidget();
    widget.refresh = () => {};
    widget.device = { connected: true, busy: false, state: { capabilities: { repl: true }, running: false, port: '/test' }, execute };
    return widget;
};
test('an empty successful Python response clears the submitted draft without inventing output', async () => {
    const widget = makeWidget(async () => '');
    widget.active.code = 'x = 42';
    await widget.execute();
    assert.equal(widget.active.code, '');
    assert.equal(widget.active.repl.records.length, 1);
    assert.equal(widget.active.repl.records[0].text, '>>> x = 42\n');
    assert.equal(widget.active.reading.repl.unread, 1);
});
test('failed execution preserves the draft, and success never erases a newer draft', async () => {
    const failed = makeWidget(async () => undefined);
    failed.device.error = '执行失败';
    failed.active.code = 'bad()';
    await failed.execute();
    assert.equal(failed.active.code, 'bad()');
    assert.equal(failed.active.repl.records.at(-1).stream, 'stderr');
    let complete;
    const running = makeWidget(() => new Promise(resolve => { complete = resolve; }));
    running.active.code = 'print(42)';
    const pending = running.execute();
    running.active.code = 'print(43)';
    complete('42\n');
    await pending;
    assert.equal(running.active.code, 'print(43)');
    assert.equal(running.active.repl.records.at(-1).text, '42\n');
});
test('a busy board prevents submission while leaving the editable draft intact', async () => {
    let calls = 0;
    const widget = makeWidget(async () => { calls++; return ''; });
    widget.active.code = 'print(42)';
    widget.device.busy = true;
    await widget.execute();
    assert.equal(calls, 0);
    assert.equal(widget.active.code, 'print(42)');
    assert.equal(widget.active.repl.records.length, 0);
});
