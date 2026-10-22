// SPDX-License-Identifier: MIT
// Exercise async ownership without loading the desktop DOM or using serial hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const filename = resolve(__dirname, '../lib/browser/nodu-embedded-model.js');
const actualRequire = createRequire(filename);
class Emitter {
    event = () => ({ dispose() {} });
    fire() {}
}
let confirm = async () => true;
const stub = {
    Emitter, ConfirmDialog: class { open() { return confirm(); } },
    injectable: () => value => value, inject: () => () => {}, postConstruct: () => () => {},
    URI: class {},
};
const moduleValue = { exports: {} };
vm.runInNewContext(readFileSync(filename, 'utf8'), {
    module: moduleValue, exports: moduleValue.exports,
    require: name => name.startsWith('@theia/') ? stub : actualRequire(name),
    TextEncoder, TextDecoder, atob, btoa, Uint8Array, crypto, Date, setTimeout, clearTimeout,
    localStorage: { getItem: () => '', setItem() {} },
}, { filename });
const { NoduEmbeddedModel } = moduleValue.exports;
const project = path => ({ path, flashMethod: 'stlink', manifest: { monitor: { baud: 115200 } } });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('another window cannot grant monitor state; explicit connection owns its session', async () => {
    const model = new NoduEmbeddedModel(); model.project = project('/a'); model.monitorPort = 'COM5';
    model.onEvent('monitor.state', { port: 'COM5', state: 'open', owner: 'other', session: 'other-session' });
    assert.equal(model.monitor.open, false);
    const calls = [];
    model.service = { call: async (method, args) => {
        calls.push({ method, args });
        if (method === 'openMonitor') {
            const status = { open: true, port: 'COM5', baud: 115200, state: 'open', owner: args.owner, session: 'owned' };
            model.onEvent('monitor.state', status);
            return { ok: true, result: status };
        }
        return { ok: true, result: { sent: 1 } };
    } };
    await model.ensureMonitor();
    assert.equal(model.monitor.session, 'owned');
    assert.equal(await model.sendMonitorBytes(Uint8Array.of(255)), true);
    const write = calls.find(c => c.method === 'writeMonitor');
    assert.equal(write.args.session, 'owned'); assert.equal(write.args.owner, calls[0].args.owner);
    model.onEvent('monitor.state', { state: 'closed', owner: calls[0].args.owner, session: 'old', port: 'COM5' });
    assert.equal(model.monitor.open, true);
});

test('changing project while a build finishes cannot flash the old artifact at a new target', async () => {
    const model = new NoduEmbeddedModel(); model.project = project('/a');
    const build = deferred(); model.build = () => build.promise;
    const calls = []; model.call = async (method, args) => { calls.push({ method, args }); };
    const running = model.run();
    model.projectEpoch++; model.project = { ...project('/b'), flashMethod: 'uart' }; model.monitorPort = 'COM8';
    build.resolve({ ok: true, artifact: { bundleSha256: 'old-firmware' } });
    assert.equal(await running, false); assert.equal(calls.length, 0);
});

test('late build results do not publish diagnostics into another project', async () => {
    const model = new NoduEmbeddedModel(); model.project = project('/a');
    const result = deferred(); model.call = () => result.promise;
    let diagnostics = 0; model.setDiagnostics = () => diagnostics++;
    const building = model.build();
    model.projectEpoch++; model.project = project('/b');
    result.resolve({ ok: true, diagnostics: [], warnings: 0, ms: 1 });
    assert.equal(await building, undefined); assert.equal(diagnostics, 0); assert.equal(model.lastBuild, undefined);
});

test('ISP consent expires when the confirmed serial session changes', async () => {
    const model = new NoduEmbeddedModel(); model.monitor = { open: true, port: 'COM5', session: 'first', state: 'open' };
    const dialog = deferred(); confirm = () => dialog.promise;
    const approval = model.confirmMonitorRelease('uart', 'COM5');
    model.monitor.session = 'replacement'; dialog.resolve(true);
    assert.equal(await approval, undefined);
});
