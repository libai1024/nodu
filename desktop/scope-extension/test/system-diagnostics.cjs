// SPDX-License-Identifier: MIT
// Production service contracts; native UI verification covers notification placement.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function flush() {
    // Finish a notification action and its rejection handler without fixed sleeps.
    for (let index = 0; index < 3; index++) { await new Promise(resolve => setImmediate(resolve)); }
}
function harness() {
    const exports = {}, severity = { Error: 1, Info: 3 };
    const decorate = () => () => undefined;
    const imports = {
        '@theia/core/shared/inversify': { inject: decorate, injectable: decorate },
        '@theia/core/lib/common': { CommandRegistry: class {}, MessageService: class {} },
        '@theia/output/lib/browser/output-channel': { OutputChannelManager: class {}, OutputChannelSeverity: severity },
        '@theia/output/lib/browser/output-contribution': { OutputContribution: class {} }
    };
    const filename = path.join(__dirname, '../lib/browser/nodu-diagnostics.js');
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        exports, Error, Promise,
        require(name) { assert.ok(name in imports, `Unexpected dependency: ${name}`); return imports[name]; }
    }, { filename });
    const service = new exports.NoduDiagnostics();
    const entries = [], requests = [], shown = [], views = [], channels = [];
    const channel = {
        appendLine(text, level) { entries.push({ text, level }); },
        show(options) { shown.push(options); }
    };
    service.output = { getChannel(name) { channels.push(name); return channel; } };
    service.outputView = { async openView(options) { views.push(options); } };
    service.messages = { error(message, ...actions) {
        const result = deferred(); requests.push({ message, actions, ...result }); return result.promise;
    } };
    const failure = (overrides = {}) => ({
        source: '编辑器服务', key: '/projects/demo', message: 'C/C++ 编辑器服务未启动',
        error: new Error("The command 'nodu.clangd.start' has no active handlers"), ...overrides
    });
    return { service, entries, requests, shown, views, channels, severity, failure };
}

test('system failure keeps notification concise and full diagnostics available without revealing output', () => {
    const h = harness();
    h.service.report(h.failure({ context: { project: '/projects/demo', phase: 'start' }, retry() {} }));
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].message, 'C/C++ 编辑器服务未启动');
    assert.deepEqual(h.requests[0].actions, ['查看日志', '重试', '本次不再提醒']);
    assert.equal(h.entries.length, 2);
    assert.match(h.entries[0].text, /^\[\d{4}-\d\d-\d\dT[^\]]+\] \[error\] \[编辑器服务\]/);
    assert.match(h.entries[0].text, /nodu\.clangd\.start/);
    assert.match(h.entries[0].text, /\n\s+at /);
    assert.equal(h.entries[0].level, h.severity.Error);
    assert.match(h.entries[1].text, /"project":"\/projects\/demo"/);
    assert.ok(h.channels.every(name => name === 'Nodu 日志'));
    assert.equal(h.shown.length, 0);
    assert.equal(h.views.length, 0);
});

test('repeated failures remain in logs but notify once until recovery', () => {
    const h = harness();
    h.service.report(h.failure()); h.service.report(h.failure());
    assert.equal(h.entries.length, 2);
    assert.equal(h.requests.length, 1);
    h.service.resolve('编辑器服务', '/projects/demo');
    h.service.report(h.failure());
    assert.equal(h.entries.length, 3);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[0].actions.includes('重试'), false);
});

test('view logs action selects system channel and reveals bottom output', async () => {
    const h = harness(); h.service.report(h.failure());
    h.requests[0].resolve('查看日志'); await flush();
    assert.equal(h.shown.length, 1);
    assert.equal(h.shown[0].preserveFocus, true);
    assert.equal(h.views.length, 1);
    assert.equal(h.views[0].area, 'bottom');
    assert.equal(h.views[0].activate, true);
    assert.equal(h.views[0].reveal, true);
});

test('system log command is independently available after notification dismissal', async () => {
    const h = harness(), commands = [];
    h.service.registerCommands({ registerCommand(command, handler) { commands.push({ command, handler }); } });
    assert.equal(commands.length, 1);
    assert.equal(commands[0].command.id, 'nodu.logs.show');
    await commands[0].handler.execute();
    assert.equal(h.shown.length, 1); assert.equal(h.views[0].area, 'bottom');
});

test('retry executes only while originating project remains current', async () => {
    const h = harness(); let current = true, retried = 0;
    h.service.report(h.failure({ isCurrent: () => current, retry: () => { retried++; } }));
    current = false; h.requests[0].resolve('重试'); await flush();
    assert.equal(retried, 0);
    h.service.report(h.failure({ key: '/projects/new', isCurrent: () => true, retry: () => { retried++; } }));
    h.requests[1].resolve('重试'); await flush();
    assert.equal(retried, 1);
    // A subsequent retry failure may notify again; the previous token was removed.
    h.service.report(h.failure({ key: '/projects/new' }));
    assert.equal(h.requests.length, 3);
});

test('recovery and a new failure invalidate an older notification retry token', async () => {
    const h = harness(); let oldRetries = 0, newRetries = 0;
    h.service.report(h.failure({ retry: () => { oldRetries++; } }));
    h.service.resolve('编辑器服务', '/projects/demo');
    h.service.report(h.failure({ retry: () => { newRetries++; } }));
    h.requests[0].resolve('重试'); await flush();
    assert.equal(oldRetries, 0); assert.equal(newRetries, 0);
    h.requests[1].resolve('重试'); await flush();
    assert.equal(newRetries, 1);
});

test('returning to a previously failed project replaces stale notification actions and keeps current lifecycle deduplicated', async () => {
    const h = harness(), retries = []; let generation = 1;
    const failureFor = (key, origin) => h.failure({ key,
        isCurrent: () => generation === origin, retry: () => { retries.push(origin); } });
    h.service.report(failureFor('/projects/a', 1));
    generation = 2; h.service.report(failureFor('/projects/b', 2));
    generation = 3; h.service.report(failureFor('/projects/a', 3));
    h.service.report(failureFor('/projects/a', 3));
    assert.equal(h.entries.length, 4);
    assert.equal(h.requests.length, 3, 'returning to A must replace its stale notification, without duplicating current failures');
    h.requests[0].resolve('重试'); h.requests[1].resolve('重试'); await flush();
    assert.deepEqual(retries, []);
    h.requests[2].resolve('重试'); await flush();
    assert.deepEqual(retries, [3]);
});

test('obsolete project failure creates neither notification nor misleading log entry', () => {
    const h = harness(); h.service.report(h.failure({ isCurrent: () => false }));
    assert.equal(h.entries.length, 0); assert.equal(h.requests.length, 0);
});

test('session mute suppresses only that source while retaining each failure in logs', async () => {
    const h = harness(); h.service.report(h.failure());
    h.requests[0].resolve('本次不再提醒'); await flush();
    h.service.report(h.failure({ key: '/projects/second' }));
    h.service.resolve('编辑器服务', '/projects/demo');
    h.service.report(h.failure());
    h.service.report(h.failure({ source: 'STM32 服务', message: 'STM32 服务已停止' }));
    assert.equal(h.entries.length, 4);
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].message, 'STM32 服务已停止');
});

test('failed log opening, retry and message delivery are recorded without recursive notifications or unhandled rejection', async () => {
    const unhandled = [];
    const listener = error => unhandled.push(error);
    process.on('unhandledRejection', listener);
    try {
        const log = harness();
        log.service.outputView.openView = async () => { throw new Error('output unavailable'); };
        log.service.report(log.failure()); log.requests[0].resolve('查看日志'); await flush();
        assert.equal(log.requests.length, 1);
        assert.match(log.entries.at(-1).text, /通知操作未完成[\s\S]*output unavailable/);

        const retry = harness();
        retry.service.report(retry.failure({ retry: async () => { throw new Error('retry unavailable'); } }));
        retry.requests[0].resolve('重试'); await flush();
        assert.equal(retry.requests.length, 1);
        assert.match(retry.entries.at(-1).text, /通知操作未完成[\s\S]*retry unavailable/);

        const message = harness();
        message.service.report(message.failure()); message.requests[0].reject(new Error('message unavailable')); await flush();
        assert.equal(message.requests.length, 1);
        assert.match(message.entries.at(-1).text, /通知操作未完成[\s\S]*message unavailable/);
        assert.deepEqual(unhandled, []);
    } finally { process.off('unhandledRejection', listener); }
});

test('recording lifecycle information is quiet and strips control characters from log entries', () => {
    const h = harness();
    h.service.record('编辑器\u0000服务', '启动\u001b中', 'line one\nline two\r\u0008');
    assert.equal(h.entries.length, 1); assert.equal(h.entries[0].level, h.severity.Info);
    assert.match(h.entries[0].text, /\[编辑器服务\] 启动中\nline one\nline two$/);
    assert.equal(h.requests.length, 0); assert.equal(h.shown.length, 0);
});

function embeddedHarness() {
    const h = harness(), exports = {};
    const filename = path.join(__dirname, '../lib/browser/nodu-embedded-model.js');
    const actualRequire = createRequire(filename), decorate = () => () => undefined;
    class Emitter {
        event() { return { dispose() {} }; }
        fire() {}
    }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        exports, Error, Promise, setTimeout, clearTimeout,
        require(name) {
            if (name === '@theia/core/shared/inversify') { return { inject: decorate, injectable: decorate, postConstruct: decorate }; }
            if (name === '@theia/core/lib/common/event') { return { Emitter }; }
            if (name.startsWith('@theia/')) { return {}; }
            if (name === './nodu-diagnostics') { return { NoduDiagnostics: h.service.constructor }; }
            if (name.startsWith('../common/')) { return actualRequire(name); }
            throw new Error(`Unexpected embedded model dependency: ${name}`);
        }
    }, { filename });
    const model = new exports.NoduEmbeddedModel();
    model.systemDiagnostics = h.service;
    model.cProjectKey = model.espProjectKey = { set() {} };
    model.files = {
        async exists() { return true; },
        async read() { return { value: '{"kind":"stm32-hal"}' }; }
    };
    const root = folder => ({
        path: { fsPath: () => folder }, resolve: name => `${folder}/${name}`, toString: () => `file://${folder}`
    });
    return { ...h, model, root };
}

test('project opening failure becomes actionable system notification without overwriting task progress', async () => {
    const h = embeddedHarness(); let attempts = 0;
    const task = h.model.task = { text: '已有编译结果', tone: 'ok' };
    h.model.service = { async call(method) {
        assert.equal(method, 'openProject'); attempts++;
        return { ok: false, error: { code: 'invalidProject', message: 'manifest target is missing' } };
    } };
    await h.model.detect(h.root('/projects/broken'));
    assert.equal(h.model.task, task);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].message, 'STM32 工程无法打开。');
    assert.match(h.entries[0].text, /manifest target is missing/);
    assert.match(h.entries[1].text, /\/projects\/broken/);
    h.requests[0].resolve('重试'); await flush();
    assert.equal(attempts, 2); assert.equal(h.requests.length, 2);
});

test('late failure while opening a previous workspace does not notify the new workspace', async () => {
    const h = embeddedHarness(), pending = deferred();
    h.model.service = { call: () => pending.promise };
    const opening = h.model.detect(h.root('/projects/old'));
    await flush();
    await h.model.detect(undefined);
    pending.reject(new Error('old workspace inaccessible')); await opening;
    assert.equal(h.entries.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.model.project, undefined); assert.equal(h.model.task, undefined);
});

test('reopening an unresolved project failure offers a fresh working retry', async () => {
    const h = embeddedHarness(); let attempts = 0;
    h.model.service = { async call() {
        attempts++; return { ok: false, error: { code: 'invalidProject', message: 'still unavailable' } };
    } };
    await h.model.detect(h.root('/projects/broken'));
    await h.model.detect(undefined);
    await h.model.detect(h.root('/projects/broken'));
    assert.equal(h.requests.length, 2);
    h.requests[0].resolve('重试'); await flush();
    assert.equal(attempts, 2, 'old workspace action cannot reopen the project');
    h.requests[1].resolve('重试'); await flush();
    assert.equal(attempts, 3, 'current workspace retry must execute');
    assert.equal(h.requests.length, 3);
});

test('background service failure is logged and deduplicated without consuming an idle task strip', () => {
    const h = embeddedHarness();
    h.model.onEvent('service.state', { running: false, message: 'sidecar unexpectedly exited: 101' });
    h.model.onEvent('service.state', { running: false, message: 'sidecar unexpectedly exited: 101' });
    assert.equal(h.model.task, undefined);
    assert.equal(h.entries.length, 2); assert.equal(h.requests.length, 1);
    assert.match(h.entries[0].text, /sidecar unexpectedly exited: 101/);
    h.model.onEvent('service.state', { running: true });
    h.model.onEvent('service.state', { running: false, message: 'second failure' });
    assert.equal(h.requests.length, 2);
});

test('background service loss interrupts active work but keeps technical error in system logs', () => {
    const h = embeddedHarness(); h.model.building = true; h.model.flashing = true;
    h.model.onEvent('service.state', { running: false, message: 'raw service transport failure' });
    assert.equal(h.model.building, false); assert.equal(h.model.flashing, false);
    assert.equal(h.model.task.text, '任务已中断');
    assert.equal(h.model.task.target, 'output');
    assert.equal(h.model.task.text.includes('transport'), false);
    assert.match(h.entries[0].text, /raw service transport failure/);
    assert.equal(h.requests.length, 1);
});
