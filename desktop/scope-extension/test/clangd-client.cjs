// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const START = 'nodu.clangd.start', STOP = 'nodu.clangd.stop';
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
const project = (name, overrides = {}) => ({ path: `/${name}`, toolkit: { ok: true }, trusted: true, chip: { sdk: { version: name } }, ...overrides });
function harness(initial = project('a')) {
    const events = new Map(), commands = new Map(), calls = [], executed = [], reports = [], records = [], resolved = [], timers = [];
    let now = 0, available = true, disposed = 0;
    const exports = {};
    class DisposableCollection { values = []; push(value) { this.values.push(value); } dispose() { this.values.splice(0).forEach(value => value.dispose()); } }
    const signal = name => listener => { events.set(name, listener); return { dispose() { events.delete(name); disposed++; } }; };
    const sandbox = { exports, Promise, Error, String, Date: { now: () => now },
        setTimeout(fn, delay) { timers.push({ fn, at: now + delay }); },
        require(name) {
            if (name.includes('inversify')) return { inject: () => () => {}, injectable: () => target => target };
            if (name === '@theia/core/lib/common') return { DisposableCollection };
            if (name.includes('editor-manager')) return { EditorManager: class {} };
            if (name.includes('monaco-editor')) return { MonacoEditor: { get: widget => ({ getControl: () => widget.control }) } };
            if (name.endsWith('nodu-embedded-model')) return { NoduEmbeddedModel: class {} };
            if (name.endsWith('nodu-diagnostics')) return { NoduDiagnostics: class {} };
            throw new Error(name);
        }
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../lib/browser/nodu-clangd-client.js'), 'utf8'), sandbox);
    const client = new exports.NoduClangdClient();
    const h = { client, calls, executed, reports, records, resolved, commands, events,
        get available() { return available; }, set available(value) { available = value; },
        get disposed() { return disposed; },
        configure: async () => {}, spec: async args => ({ command: '/tool/clangd', args: Array(8).fill('--test'), sdk: `${args.path}/sdk` }),
        start: async () => {}, stop: async () => {},
        async advance(ms) { now += ms; const due = timers.filter(t => t.at <= now); for (const timer of due) { timers.splice(timers.indexOf(timer), 1); timer.fn(); } await settle(); },
        change(value) { client.model.project = value; events.get('project')?.(value); },
        begin() { client.onStart(); return client.chain; },
        restart() { return commands.get(exports.RESTART_EDITOR_SERVICE).execute(); }
    };
    client.model = { project: initial, onDidChangeProject: signal('project'), setTask() { throw new Error('Language service must not overwrite build/device task state'); },
        async call(method, args) { calls.push({ method, path: args.path }); return method === 'configure' ? h.configure(args) : h.spec(args); } };
    client.editors = { all: [], onCreated: signal('editor') };
    client.registry = { getCommand: () => ({ id: START }), getActiveHandler: () => available ? { execute() {} } : undefined,
        registerCommand(command, handler) { commands.set(command.id, handler); } };
    client.commands = { async executeCommand(id, spec) { executed.push({ id, spec }); return id === START ? h.start(spec) : h.stop(); } };
    client.diagnostics = { record: (...args) => records.push(args), report: failure => reports.push(failure), resolve: (...args) => resolved.push(args) };
    client.registerCommands(client.registry);
    return h;
}

test('command metadata without an active bridge waits, then starts once after deployment', async () => {
    const h = harness(); h.available = false; h.begin(); await settle();
    assert.equal(h.executed.length, 0); assert.equal(h.reports.length, 0);
    await h.advance(20_000); assert.equal(h.executed.length, 0);
    h.available = true; await h.advance(100); await h.client.chain;
    assert.equal(h.executed.length, 1); assert.equal(h.executed[0].id, START); assert.equal(h.client.sdk, '/a/sdk');
});

test('readiness timeout reports actionable diagnostics and the restart command recovers', async () => {
    const h = harness(); h.available = false; h.begin(); await settle(); await h.advance(30_000); await h.client.chain;
    assert.equal(h.executed.length, 0); assert.equal(h.reports.length, 1);
    const failure = h.reports[0]; assert.equal(failure.message, 'C/C++ 编辑器服务未启动'); assert.equal(failure.context.stage, '启动插件');
    assert.equal(failure.error.code, 'CLANGD_PLUGIN_NOT_READY'); assert.equal(failure.context.command, START);
    assert.match(failure.error.message, /插件尚未就绪/); assert.equal(failure.isCurrent(), true);
    h.available = true; await h.restart(); assert.equal(h.executed.length, 1); assert.equal(h.resolved[0][1], '/a:startup');
    assert.equal(failure.isCurrent(), false);
});

test('only a pre-execution NO_ACTIVE_HANDLER race is retried automatically', async () => {
    const h = harness(); let attempts = 0;
    h.start = async () => { if (++attempts === 1) throw Object.assign(new Error('bridge removed'), { code: 'NO_ACTIVE_HANDLER' }); };
    h.begin(); await settle(); assert.equal(attempts, 1); await h.advance(100); await h.client.chain;
    assert.equal(attempts, 2); assert.equal(h.reports.length, 0);
    const failed = harness(); failed.start = async () => { throw new Error('clangd failed after execution'); };
    await failed.begin(); await failed.advance(30_000);
    assert.equal(failed.executed.length, 1); assert.equal(failed.reports.length, 1);
});

test('switch during configuration cannot read tools or start the old project', async () => {
    const h = harness(), held = deferred(); h.configure = args => args.path === '/a' ? held.promise : Promise.resolve();
    h.begin(); await settle(); h.change(project('b')); held.resolve(); await h.client.chain;
    assert.equal(h.calls.some(call => call.method === 'clangd' && call.path === '/a'), false);
    assert.equal(h.executed.length, 1); assert.equal(h.executed[0].spec.sdk, '/b/sdk'); assert.equal(h.reports.length, 0);
});

test('switch during tool lookup drops the old start before command execution', async () => {
    const h = harness(), held = deferred(), getSpec = h.spec; h.spec = args => args.path === '/a' ? held.promise : getSpec(args);
    h.begin(); await settle(); h.change(project('b')); held.resolve({ command: '/tool/old', args: [], sdk: '/old/sdk' }); await h.client.chain;
    assert.equal(h.executed.length, 1); assert.equal(h.executed[0].spec.sdk, '/b/sdk'); assert.equal(h.client.version, 'b');
});

test('a superseded in-flight start is stopped before the next project starts', async () => {
    const h = harness(), held = deferred(); h.start = spec => spec.sdk === '/a/sdk' ? held.promise : Promise.resolve();
    h.begin(); await settle(); h.change(project('b')); held.resolve(); await h.client.chain;
    assert.deepEqual(h.executed.map(call => call.id), [START, STOP, START]);
    assert.equal(h.client.sdk, '/b/sdk'); assert.deepEqual(h.resolved.map(args => args[1]), ['/b:startup']);
});

test('a failure from a superseded project cannot notify or replace current task state', async () => {
    const h = harness(), held = deferred(); h.configure = args => args.path === '/a' ? held.promise : Promise.resolve();
    h.begin(); await settle(); h.change(project('b')); held.reject(new Error('old configuration failed')); await h.client.chain;
    assert.equal(h.reports.length, 0); assert.equal(h.executed[0].spec.sdk, '/b/sdk');
});

test('a missing stop bridge after host reconnect does not permanently block the next start', async () => {
    const h = harness(); await h.begin(); h.stop = async () => { throw Object.assign(new Error('host replaced'), { code: 'NO_ACTIVE_HANDLER' }); };
    h.change(project('b')); await h.client.chain;
    assert.deepEqual(h.executed.map(call => call.id), [START, STOP, START]); assert.equal(h.client.sdk, '/b/sdk'); assert.equal(h.reports.length, 0);
    assert.ok(h.records.some(record => record[1].includes('重新注册')));
});

test('an actual stop failure is not swallowed or followed by another server start', async () => {
    const h = harness(); await h.begin(); h.stop = async () => { throw new Error('cannot dispose server'); };
    h.change(project('b')); await h.client.chain;
    assert.deepEqual(h.executed.map(call => call.id), [START, STOP]); assert.equal(h.reports[0].context.stage, '停止旧会话');
    h.stop = async () => {}; await h.reports[0].retry();
    assert.deepEqual(h.executed.map(call => call.id), [START, STOP, STOP, START]); assert.equal(h.client.sdk, '/b/sdk');
});

test('frontend teardown cancels readiness and disposes both subscriptions', async () => {
    const h = harness(); h.available = false; h.begin(); await settle(); h.client.onStop(); h.available = true; await h.advance(100); await h.client.chain;
    assert.equal(h.disposed, 2); assert.equal(h.executed.length, 0); assert.equal(h.reports.length, 0);
    assert.equal(h.commands.get('nodu.editorService.restart').isEnabled(), false);
});

test('untrusted projects do not configure builds; unavailable toolkits do not launch services', async () => {
    const untrusted = harness(project('a', { trusted: false })); await untrusted.begin();
    assert.deepEqual(untrusted.calls.map(call => call.method), ['clangd']); assert.equal(untrusted.executed.length, 1);
    const unavailable = harness(project('a', { toolkit: { ok: false } })); await unavailable.begin();
    assert.equal(unavailable.calls.length, 0); assert.equal(unavailable.executed.length, 0); assert.equal(unavailable.commands.get('nodu.editorService.restart').isEnabled(), false);
});

test('repeated registration loss keeps the final cause in diagnostics without hiding timeout classification', async () => {
    const h = harness(); let last;
    h.start = async () => { last = Object.assign(new Error('bridge disappeared'), { code: 'NO_ACTIVE_HANDLER' }); throw last; };
    h.begin(); await settle(); await h.advance(30_000); await h.client.chain;
    assert.equal(h.reports[0].error.code, 'CLANGD_PLUGIN_NOT_READY'); assert.equal(h.reports[0].error.cause, last);
    assert.ok(h.records.some(record => record[1].includes('最后一次') && record[2] === last));
});

test('switch during old-session shutdown cannot configure the superseded intermediate project', async () => {
    const h = harness(), held = deferred(); await h.begin(); h.stop = () => held.promise;
    h.change(project('b')); await settle(); h.change(project('c')); held.resolve(); await h.client.chain;
    assert.equal(h.calls.some(call => call.path === '/b'), false);
    assert.deepEqual(h.executed.map(call => call.id), [START, STOP, START]); assert.equal(h.client.sdk, '/c/sdk');
});
