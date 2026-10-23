// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { downloadStatusText, taskProgress } = require('../scope-extension/lib/common/nodu-download-status.js');
const idle = { building: false, flashing: false, flashSteps: {} };

test('download status uses actual phases and clears stale percent', () => {
    assert.equal(downloadStatusText('uart', idle), '串口 ISP');
    assert.equal(downloadStatusText('stlink', idle), 'ST-LINK');
    assert.equal(downloadStatusText('uart', { ...idle, building: true }), '串口 ISP  配置工程');
    assert.equal(downloadStatusText('uart', { ...idle, flashing: true, awaitUser: 'enterBoot' }), '串口 ISP  等待芯片');
    for (const [step, label] of [['backup', '备份'], ['program', '写入'], ['verify', '校验']]) {
        assert.equal(downloadStatusText('uart', { ...idle, flashing: true, flashSteps: { [step]: 'running' }, flashPercent: 42.2 }), `串口 ISP  ${label} ${{ backup: 28, program: 48, verify: 68 }[step]}%`);
    }
    assert.equal(downloadStatusText('stlink', { ...idle, flashing: true, flashSteps: { program: 'done', verify: 'running' } }), 'ST-LINK  校验 60%');
    assert.equal(downloadStatusText('uart', { ...idle, awaitUser: 'exitBoot', flashPercent: 100 }), '串口 ISP  等待复位');
    assert.equal(downloadStatusText('uart', { ...idle, flashPercent: 100 }), '串口 ISP');
    assert.equal(downloadStatusText('uart', { ...idle, task: { tone: 'error', text: '下载失败' } }), '串口 ISP  失败');
    assert.equal(downloadStatusText('uart', { ...idle, task: { tone: 'warn', text: '已停止' } }), '串口 ISP  已停止');
});

test('help command and menu are isolated from model and hardware calls', async () => {
    const handlers = new Map(), menu = []; let opened = 0, focused = 0;
    const target = { isConnected: true, focus() { focused++; } };
    class Empty {}
    const fallback = new Proxy({}, { get: () => Empty });
    const module = { exports: {} };
    const mocks = {
        '@theia/core/shared/inversify': { inject: () => () => {}, injectable: () => value => value },
        '@theia/core/lib/common': { MAIN_MENU_BAR: ['main'] },
        '@theia/core/lib/browser': { CommonMenus: { FILE: ['file'] } },
        '@theia/core/lib/browser/status-bar/status-bar': { StatusBarAlignment: { LEFT: 0, RIGHT: 1 } },
        './scope-workbench': { NODU_PROJECT_MENU: ['project'] },
        './nodu-embedded-commands': require('../scope-extension/lib/browser/nodu-embedded-commands.js'),
        '../common/nodu-download-status': { downloadStatusText, taskProgress },
        './nodu-download-help': { NoduDownloadHelpDialog: class { async open() { opened++; } } },
    };
    vm.runInNewContext(fs.readFileSync(require.resolve('../scope-extension/lib/browser/nodu-embedded-contribution.js'), 'utf8'), {
        exports: module.exports, require: id => mocks[id] || fallback,
        document: { activeElement: null, querySelector: () => target },
    });
    const c = new module.exports.NoduEmbeddedContribution();
    c.model = new Proxy({}, { get(_, key) { if (key === 'isC') return true; throw Error(`Unexpected model access: ${String(key)}`); } });
    c.registerCommands({ registerCommand(command, handler) { handlers.set(command.id, handler); } });
    c.registerMenus({ registerMenuAction(path, item) { menu.push({ path, item }); }, registerSubmenu() {} });
    const id = mocks['./nodu-embedded-commands'].C_COMMANDS.downloadHelp;
    const entry = menu.find(x => x.item.commandId === id);
    assert.equal(entry.path.at(-1), '9_help');
    assert.equal(handlers.get(id).isEnabled(), true);
    await handlers.get(id).execute();
    assert.equal(opened, 1); assert.equal(focused, 1);
    const entries = new Map();
    c.status = { async setElement(id, entry) { entries.set(id, entry); }, async removeElement(id) { entries.delete(id); } };
    c.model = { ...idle, isC: true, project: { flashMethod: 'uart' }, flashing: true, flashSteps: { program: 'running' }, flashPercent: 42 };
    c.updateStatus();
    assert.equal(entries.get('nodu:c-download').text, '串口 ISP  写入 48%');
    assert.equal(entries.get('nodu:c-download-help').command, id);
    c.model.project.flashMethod = 'stlink'; c.model.flashing = false;
    c.updateStatus(); assert.equal(entries.get('nodu:c-download').text, 'ST-LINK');
    c.model.isC = false; c.updateStatus();
    assert.equal(entries.has('nodu:c-download'), false); assert.equal(entries.has('nodu:c-download-help'), false);
});

test('real model events update progress and reset percent between stages without RPC', () => {
    class Empty {}
    class Emitter { event = () => {}; fire() {} }
    const fallback = new Proxy({}, { get: () => Empty });
    const exports = {};
    const base = require('node:path').dirname(require.resolve('../scope-extension/lib/browser/nodu-embedded-model.js'));
    vm.runInNewContext(fs.readFileSync(require.resolve('../scope-extension/lib/browser/nodu-embedded-model.js'), 'utf8'), {
        exports, TextDecoder, TextEncoder,
        require: id => id.startsWith('../common/') ? require(require('node:path').resolve(base, id))
            : id === '@theia/core/shared/inversify' ? { inject: () => () => {}, postConstruct: () => () => {}, injectable: () => value => value }
            : id === '@theia/core/lib/common/event' ? { Emitter } : fallback,
    });
    const model = new exports.NoduEmbeddedModel();
    model.project = { path: '/simulated', flashMethod: 'uart' };
    model.flashing = true;
    model.onEvent('flash.started', { path: '/simulated', runId: 'simulation' });
    model.onEvent('flash.step', { runId: 'simulation', step: 'program', state: 'running' });
    model.onEvent('flash.progress', { runId: 'simulation', percent: 42.2 });
    assert.equal(downloadStatusText('uart', model), '串口 ISP  写入 48%');
    model.onEvent('flash.progress', { runId: 'another-window', percent: 90 });
    assert.equal(downloadStatusText('uart', model), '串口 ISP  写入 48%');
    model.onEvent('flash.step', { runId: 'simulation', step: 'program', state: 'done' });
    model.onEvent('flash.step', { runId: 'simulation', step: 'verify', state: 'running' });
    assert.equal(downloadStatusText('uart', model), '串口 ISP  校验 60%');
    model.onEvent('flash.progress', { runId: 'simulation', percent: 17.76 });
    assert.equal(downloadStatusText('uart', model), '串口 ISP  校验 63%');
    model.onEvent('flash.awaitUser', { runId: 'simulation', kind: 'exitBoot' });
    assert.equal(downloadStatusText('uart', model), '串口 ISP  等待复位');
});

 test('build progress only completes on a successful result; errors never show 100%', () => {
    assert.equal(taskProgress({ ...idle, building: true }), undefined);
    assert.equal(taskProgress({ ...idle, building: true, buildProgress: { done: 3, total: 10 } }), 30);
    assert.equal(taskProgress({ ...idle, building: true, buildProgress: { done: 10, total: 10 } }), 99);
    assert.equal(downloadStatusText('stlink', { ...idle, task: { text: '编译成功', tone: 'ok' } }), 'ST-LINK  编译成功 100%');
    assert.equal(taskProgress({ ...idle, task: { text: '编译失败', tone: 'error' } }), undefined);
    assert.equal(taskProgress({ ...idle, flashing: true, awaitUser: 'exitBoot' }), undefined);
    assert.equal(taskProgress({ ...idle, flashing: true, flashSteps: { identify: 'done', program: 'done' } }), 60);
    assert.equal(taskProgress({ ...idle, flashing: true, flashSteps: { run: 'done' } }), 99);
});
