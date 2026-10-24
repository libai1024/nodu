// SPDX-License-Identifier: MIT
// Exercise layout ownership without loading Electron or starting device/terminal services.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

class Service {}
const stub = new Proxy({
    __esModule: true,
    injectable: () => value => value,
    inject: () => () => {},
    postConstruct: () => () => {},
}, { get: (target, name) => name in target ? target[name] : Service });
const moduleValue = { exports: {} };
const filename = resolve(__dirname, '../lib/browser/scope-workbench.js');
vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module: moduleValue, exports: moduleValue.exports, require: () => stub,
    document: { body: { classList: { toggle() {} } } },
    localStorage: { getItem() { return null; }, setItem() {} },
}, { filename });
const { ScopeWorkbenchContribution } = moduleValue.exports;

function workbench(isC = false) {
    const owner = new ScopeWorkbenchContribution();
    const visible = { files: false, vision: false, bottom: true };
    const calls = [];
    const bottom = { area: 'bottom', sessions: [{ pid: 42 }], page: 'terminal', draft: 'pending command' };
    const vision = { area: 'right' }, files = { area: 'left' };
    owner.embedded = { isC };
    // The AI sidebar preference is off here so layout tests only cover the panels they assert on.
    owner.tutorModel = { panelPreferred: false };
    owner.tutorView = { openView: async () => { throw new Error('AI sidebar should stay closed'); } };
    owner.layoutState = { mode: 'simple', setMode(mode) { this.mode = mode; }, setDeviceOpen() {} };
    owner.shell = {
        getAreaFor: widget => widget.area,
        getWidgetById: () => undefined,
        collapsePanel: async area => { calls.push(['collapse', area]); visible[area === 'left' ? 'files' : area === 'right' ? 'vision' : 'bottom'] = false; },
    };
    owner.devices = { tryGetWidget: () => undefined };
    owner.consoleView = { tryGetWidget: () => bottom };
    owner.vision = { tryGetWidget: () => vision, openView: async () => { calls.push(['open', 'vision']); visible.vision = true; } };
    owner.navigator = { openView: async () => { visible.files = true; } };
    owner.boardFiles = { tryGetWidget: () => ({ isAttached: true }) };
    owner.filesWidget = () => files;
    owner.syncPanels = () => Object.assign(owner.layoutState, { filesVisible: visible.files, visionVisible: visible.vision, consoleVisible: visible.bottom });
    owner.settlePanels = async () => owner.syncPanels();
    owner.updateStatus = () => {};
    owner.showConsole = async () => { calls.push(['open', 'bottom']); visible.bottom = true; };
    return { owner, visible, calls, bottom };
}

test('changing mode leaves the shared bottom visibility, sessions and draft untouched', async () => {
    const { owner, visible, calls, bottom } = workbench();
    await owner.applyLayout('simple');
    const session = bottom.sessions[0];
    visible.bottom = false;
    calls.length = 0;
    await owner.applyLayout('pro');
    await owner.applyLayout('simple');
    assert.equal(visible.bottom, false);
    assert.equal(calls.some(([, panel]) => panel === 'bottom'), false);
    assert.equal(bottom.sessions[0], session);
    assert.equal(bottom.page, 'terminal');
    assert.equal(bottom.draft, 'pending command');
});

test('STM32 initial and switched layouts do not open framebuffer or overwrite K210 choices', async () => {
    const { owner, visible, calls } = workbench(true);
    await owner.applyLayout('pro');
    assert.equal(visible.vision, false);
    assert.equal(calls.some((action) => action[0] === 'open' && action[1] === 'vision'), false);
    owner.embedded.isC = false;
    await owner.applyPlatformLayout();
    assert.equal(visible.vision, true);
    visible.vision = false; // The user closes it in K210 professional mode.
    owner.embedded.isC = true;
    await owner.applyPlatformLayout();
    await owner.applyLayout('simple');
    await owner.applyLayout('pro');
    owner.embedded.isC = false;
    await owner.applyPlatformLayout();
    assert.equal(visible.vision, false);
});

test('switching to STM32 closes a visible framebuffer but leaves another right-side tool alone', async () => {
    const { owner, visible, calls } = workbench();
    await owner.applyLayout('pro');
    owner.embedded.isC = true;
    calls.length = 0;
    await owner.applyPlatformLayout();
    assert.deepEqual(calls, [['collapse', 'right']]);
    owner.embedded.isC = false;
    await owner.applyPlatformLayout();
    visible.vision = false; // A different right-side tool is now active.
    owner.embedded.isC = true;
    calls.length = 0;
    await owner.applyPlatformLayout();
    assert.deepEqual(calls, []);
});

test('K210 and STM32 can explicitly open, collapse and reopen the same right-side framebuffer', async () => {
    for (const isC of [false, true]) {
        const { owner, visible, calls } = workbench(isC);
        owner.layoutState.mode = 'pro';
        const widget = owner.vision.tryGetWidget();
        await owner.toggleVision();
        assert.equal(visible.vision, true);
        await owner.toggleVision();
        assert.equal(visible.vision, false);
        await owner.toggleVision();
        assert.equal(visible.vision, true);
        assert.equal(owner.vision.tryGetWidget(), widget);
        assert.deepEqual(calls, [['open', 'vision'], ['collapse', 'right'], ['open', 'vision']]);
    }
});
