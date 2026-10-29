// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
class Empty {}
function fixture() {
    const timers = new Map(), exports = {}; let sequence = 0;
    const lib = path.join(__dirname, '../lib/browser');
    vm.runInNewContext(fs.readFileSync(path.join(lib, 'nodu-embedded-model.js'), 'utf8'), {
        exports, Date, Promise, Error, Set, Map, TextDecoder, TextEncoder, Uint8Array,
        setTimeout: fn => { const id = ++sequence; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
        require(id) {
            if (id.includes('inversify')) return { inject: () => () => {}, injectable: () => x => x, postConstruct: () => () => {} };
            if (id.startsWith('../common/')) return require(path.resolve(lib, id));
            if (id.endsWith('/event')) return { Emitter: class { event() {} fire() {} } };
            return new Proxy({}, { get: () => Empty });
        }
    });
    const model = new exports.NoduEmbeddedModel(), calls = [], warnings = [];
    model.project = { path: '/project', chip: { id: 'STM32F103C8Tx' }, trusted: true, manifest: {} };
    model.fire = () => {}; model.hasUnsavedSources = () => false;
    model.messages = { warn: text => warnings.push(text) };
    model.call = async (method, args) => { calls.push({ method, args }); return method === 'generateKeil' ? { created: false, changed: true, path: '/project/MDK-ARM/Nodu.uvprojx' } : { supported: true, generated: true }; };
    const tick = async () => { const current = [...timers.values()]; timers.clear(); for (const fn of current) fn(); await new Promise(setImmediate); };
    return { model, calls, warnings, timers, tick, EmbeddedError: exports.EmbeddedError };
}

test('maintenance is opt-in, debounced and ignores shared source contents and generated files', async () => {
    const f = fixture(); f.model.keilFilesChanged('/project/App/new.c', true); assert.equal(f.timers.size, 0);
    f.model.project.manifest.keil = { autoSync: true };
    f.model.keilFilesChanged('/project/App/new.c', false); f.model.keilFilesChanged('/project/MDK-ARM/new.c', true);
    assert.equal(f.timers.size, 0);
    f.model.keilFilesChanged('/project/App/new.c', true); f.model.keilFilesChanged('/project/App/new.h', true);
    assert.equal(f.timers.size, 1); await f.tick();
    assert.deepEqual(f.calls.map(c => c.method), ['generateKeil', 'keilStatus']);
    assert.equal(f.model.keilUpdating, false); assert.equal(f.timers.size, 0);
});

test('dirty buffers and builds defer maintenance; switching or disabling cancels pending work', async () => {
    const f = fixture(); f.model.project.manifest.keil = { autoSync: true };
    f.model.hasUnsavedSources = () => true;
    f.model.keilFilesChanged('/project/App/new.c', true); await f.tick();
    assert.equal(f.calls.length, 0); assert.equal(f.timers.size, 1);
    f.model.hasUnsavedSources = () => false; f.model.building = true; await f.tick(); assert.equal(f.calls.length, 0);
    f.model.building = false; f.model.project.manifest.keil.autoSync = false; await f.tick(); assert.equal(f.calls.length, 0);
    f.model.project.manifest.keil.autoSync = true; f.model.keilFilesChanged('/project/App/new.c', true);
    f.model.detection++; await f.tick(); assert.equal(f.calls.length, 0);
});

test('conflicts stop maintenance and repeated events do not repeat the same notification', async () => {
    const f = fixture(); f.model.project.manifest.keil = { autoSync: true };
    f.model.call = async () => { throw new f.EmbeddedError({ code: 'keilConflict', message: 'Keep user config' }); };
    f.model.keilFilesChanged('/project/App/new.c', true); await f.tick();
    assert.equal(f.model.keilError, 'Keep user config'); assert.equal(f.warnings.length, 1); assert.equal(f.timers.size, 0);
    f.model.keilFilesChanged('/project/App/new.h', true); await f.tick(); assert.equal(f.warnings.length, 1);
});

test('an external manifest change reloads the project before deciding whether to maintain it', async () => {
    const f = fixture(); f.model.reload = async () => { f.model.project.manifest.keil = { autoSync: true }; };
    f.model.keilFilesChanged('/project/nodu.json', false); await new Promise(setImmediate);
    assert.equal(f.timers.size, 1); await f.tick(); assert(f.calls.some(c => c.method === 'generateKeil'));
});
