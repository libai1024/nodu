// SPDX-License-Identifier: MIT
// Exercises the real native CMake/GCC workflow; never opens a probe or flashes hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const desktop = path.resolve(__dirname, '..');
const toolkit = process.env.NODU_STM32_TOOLKIT || path.join(desktop, '.tools/stm32', process.platform === 'win32' ? 'win32-x64' : process.platform);
const binary = process.env.NODU_EMBEDDED_BIN || path.join(desktop, 'native/target/debug/nodu-embedded');
const resources = path.join(desktop, 'scope-extension/resources/stm32');
const { generateKeil } = require('../scope-extension/lib/node/nodu-keil-project');

test('native F103 settings, forced configure, Keil update and GCC build coexist', { skip: !fs.existsSync(binary) || !fs.existsSync(path.join(toolkit, 'toolkit.json')), timeout: 90000 }, async t => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-keil-host-')));
    const child = spawn(binary, ['--resources', resources, '--toolkit', toolkit, '--data-dir', path.join(root, 'data')]);
    const pending = new Map(); let sequence = 0;
    const reader = readline.createInterface({ input: child.stdout });
    reader.on('line', line => {
        const m = JSON.parse(line), p = pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); pending.delete(m.id);
        m.error ? p.reject(Object.assign(new Error(m.error), { code: m.code })) : p.resolve(m.result);
    });
    t.after(() => { child.kill(); reader.close(); fs.rmSync(root, { recursive: true, force: true }); });
    const call = (method, args = {}) => new Promise((resolve, reject) => {
        const id = ++sequence, timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 60000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
    const created = await call('createProject', { parent: root, name: 'f103', board: 'chip-f103c8', template: 'uart-hello' });
    let project = await call('openProject', { path: created.path });
    assert.notEqual(project.manifest.keil?.autoSync, true);
    project = await call('setProjectOptions', { path: project.path, options: { keilAutoSync: true } });
    assert.equal(project.manifest.keil.autoSync, true);
    let config = await call('configure', { path: project.path, force: true }); assert(config.ok);
    let result = await generateKeil(project, config.compileCommands, resources); assert(result.created);
    await call('createModule', { path: project.path, name: 'sensor' });
    config = await call('configure', { path: project.path, force: true }); assert(config.ok && config.ran);
    await generateKeil(project, config.compileCommands, resources);
    assert(fs.readFileSync(result.path, 'utf8').includes('..\\App\\sensor.c'));
    assert.equal((await call('build', { path: project.path })).ok, true);
    assert.equal((await call('openProject', { path: project.path })).buildStale, false);
    fs.mkdirSync(path.join(project.path, 'MDK-ARM/Objects'), { recursive: true });
    fs.writeFileSync(path.join(project.path, 'MDK-ARM/Objects/firmware.hex'), 'Keil build output');
    assert.equal((await call('openProject', { path: project.path })).buildStale, false);
    project = await call('setProjectOptions', { path: project.path, options: { preset: 'release', printfFloat: true, keilAutoSync: false } });
    config = await call('configure', { path: project.path, force: true }); assert(config.ok);
    await generateKeil(project, config.compileCommands, resources);
    assert(fs.readFileSync(result.path, 'utf8').includes('<Optim>4</Optim>'));
    assert.equal((await call('build', { path: project.path })).ok, true);
    const unsupported = await call('createProject', { parent: root, name: 'f407', board: 'chip-f407zg', template: 'empty' });
    await assert.rejects(call('setProjectOptions', { path: unsupported.path, options: { keilAutoSync: true } }), { code: 'badRequest' });
});
