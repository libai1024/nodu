// SPDX-License-Identifier: MIT
// Real toolchain tests, never write to hardware.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const readline = require('node:readline');
const desktop = path.resolve(__dirname, '..');
const toolkit = process.env.NODU_STM32_TOOLKIT || path.join(desktop, '.tools/stm32', process.platform === 'win32' ? 'win32-x64' : process.platform);
const binary = process.env.NODU_EMBEDDED_BIN || path.join(desktop, 'native/target/debug/nodu-embedded');
const available = fs.existsSync(path.join(toolkit, 'toolkit.json')) && fs.existsSync(binary);
test('STM32 real-toolchain workflows', { skip: !available, timeout: 180000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-host-'));
    const child = spawn(binary, ['--resources', path.join(desktop, 'scope-extension/resources/stm32'), '--toolkit', toolkit, '--data-dir', path.join(root, 'data')]);
    const pending = new Map(); let sequence = 0; let eventHook = () => {};
    readline.createInterface({ input: child.stdout }).on('line', line => {
        const m = JSON.parse(line);
        if (m.event) { eventHook(m); return; }
        const p = pending.get(m.id); if (!p) return;
        clearTimeout(p.timer); pending.delete(m.id);
        if (m.error) p.reject(Object.assign(new Error(m.error), { code: m.code })); else p.resolve(m.result);
    });
    child.stderr.on('data', data => process.stderr.write(data));
    const call = (method, args = {}) => new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)); }, 60000);
        pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
    const board = 'generic-f103c8';
    try {
        await t.test('unknown LED is hidden and RPC cannot bypass verification', async () => {
            const c = await call('catalog'); assert(c.boards.every(b => !b.templates.some(t => t.id === 'blink')));
            await assert.rejects(call('createProject', { parent: root, name: 'bad-led', board, template: 'blink', led: { port: 'C', pin: 13, activeLow: true } }), { code: 'needLed' });
            assert(!fs.existsSync(path.join(root, 'bad-led')));
        });
        for (const [name, target] of [['f103', 'chip-f103c8'], ['f407', 'chip-f407zg']]) {
            await t.test(`${name}: build/export/standalone build yields identical BIN`, async () => {
                const p = await call('createProject', { parent: root, name, board: target, template: 'uart-hello' });
                assert.equal((await call('build', { path: p.path })).ok, true);
                const destination = path.join(root, `${name}-export`);
                await call('exportProject', { path: p.path, destination });
                assert(!fs.existsSync(path.join(destination, '.nodu')));
                const env = { ...process.env, PATH: ['cmake', 'ninja', 'arm-gnu'].map(c => path.join(toolkit, c, 'bin')).concat('/usr/bin', '/bin').join(path.delimiter) };
                delete env.NODU_STM32_TOOLKIT;
                const cmake = path.join(toolkit, 'cmake/bin/cmake');
                execFileSync(cmake, ['--preset', 'debug'], { cwd: destination, env, stdio: 'pipe' });
                execFileSync(cmake, ['--build', '--preset', 'debug'], { cwd: destination, env, stdio: 'pipe' });
                assert.deepEqual(fs.readFileSync(path.join(destination, 'build/debug/firmware.bin')), fs.readFileSync(path.join(p.path, 'build/debug/firmware.bin')));
                await assert.rejects(call('exportProject', { path: p.path, destination }));
                await assert.rejects(call('exportProject', { path: p.path, destination: path.join(p.path, 'recursive') }), { code: 'badRequest' });
            });
        }
        const project = path.join(root, 'f103');
        await t.test('C module pair is atomic, path-safe, and included in the real build', async () => {
            const pair = await call('createModule', { path: project, name: 'sensor' });
            assert.match(fs.readFileSync(pair.header, 'utf8'), /NODU_APP_SENSOR_H/);
            assert.match(fs.readFileSync(pair.source, 'utf8'), /#include "sensor.h"/);
            const original = fs.readFileSync(pair.source);
            await assert.rejects(call('createModule', { path: project, name: 'sensor' }));
            assert.deepEqual(fs.readFileSync(pair.source), original);
            fs.writeFileSync(path.join(project, 'App/conflict.h'), 'keep');
            await assert.rejects(call('createModule', { path: project, name: 'conflict' }));
            assert(!fs.existsSync(path.join(project, 'App/conflict.c')));
            assert.equal(fs.readFileSync(path.join(project, 'App/conflict.h'), 'utf8'), 'keep');
            for (const name of ['../escape', 'a/b', '1bad', 'CON', 'COM1', '中文', 'x'.repeat(65)]) {
                await assert.rejects(call('createModule', { path: project, name }), { code: 'badRequest' });
            }
            assert.equal((await call('build', { path: project })).ok, true);
            const commands = JSON.parse(fs.readFileSync(path.join(project, 'build/debug/compile_commands.json')));
            assert(commands.some(c => c.file.endsWith('/App/sensor.c')));
            if (process.platform !== 'win32') {
                const app = path.join(project, 'App'); fs.renameSync(app, `${app}-real`);
                fs.symlinkSync(root, app, 'dir');
                await assert.rejects(call('createModule', { path: project, name: 'escape' }), { code: 'badRequest' });
                assert(!fs.existsSync(path.join(root, 'escape.c')));
                fs.unlinkSync(app); fs.renameSync(`${app}-real`, app);
            }
        });
        await t.test('project settings persist atomically and printf float links in the real toolchain', async () => {
            const manifest = path.join(project, 'nodu.json'), before = fs.readFileSync(manifest);
            await assert.rejects(call('setProjectOptions', { path: project, options: { printfFloat: true, preset: 'invalid' } }), { code: 'badRequest' });
            assert.deepEqual(fs.readFileSync(manifest), before);
            const next = await call('setProjectOptions', { path: project, options: { printfFloat: true, preset: 'release', chipVendor: 'st' } });
            assert.equal(next.preset, 'release'); assert.equal(next.manifest.build.printfFloat, true);
            assert.equal((await call('build', { path: project })).ok, true);
            const cache = fs.readFileSync(path.join(project, 'build/release/CMakeCache.txt'), 'utf8');
            assert.match(cache, /NODU_PRINTF_FLOAT:BOOL=ON/);
            const nm = path.join(toolkit, 'arm-gnu/bin/arm-none-eabi-nm');
            const symbols = execFileSync(nm, [path.join(project, 'build/release/firmware.elf')], { encoding: 'utf8' });
            assert.match(symbols, /_printf_float/);
            await call('setProjectOptions', { path: project, options: { preset: 'debug', printfFloat: false } });
        });
        await t.test('compatible chip and automatic boot require explicit confirmation before hardware access', async () => {
            await call('setProjectOptions', { path: project, options: { chipVendor: 'compatible' } });
            for (const method of ['flash', 'restore']) {
                await assert.rejects(call(method, { path: project }), { code: 'compatibilityConfirmation' });
            }
            const autoBoot = { enabled: true, confirmed: false, boot0HighDtr: false, resetActiveRts: true };
            await assert.rejects(call('setProjectOptions', { path: project, options: { autoBoot } }), { code: 'autoBootUnsupported' });
            autoBoot.confirmed = true;
            await assert.rejects(call('setProjectOptions', { path: path.join(root, 'f407'), options: { autoBoot } }), { code: 'autoBootUnsupported' });
            const next = await call('setProjectOptions', { path: project, options: { autoBoot } });
            assert.equal(next.manifest.flash.autoBoot.enabled, true);
            // Do not call download/openMonitor: no board or serial hardware is needed here.
            await call('setProjectOptions', { path: project, options: { chipVendor: 'st', autoBoot: { ...autoBoot, enabled: false } } });
        });
        await t.test('toolkit inventory, licenses, byte totals and active full check', async () => {
            const checking = call('checkToolkit', { full: true });
            const started = Date.now(); assert((await call('ping')).version);
            assert(Date.now() - started < 2000, 'full check must not block the RPC reader');
            const report = await checking;
            assert.equal(report.ok, true); assert.equal(report.full, true); assert(report.inventory.length >= 8);
            assert(report.inventory.every(c => c.version && c.bytes > 0));
            assert.equal(report.inventory.reduce((sum, c) => sum + c.bytes, 0), report.totalBytes);
            const license = report.inventory.flatMap(c => c.licenses)[0]; assert(license);
            const content = await call('readToolkitLicense', { file: license }); assert(content.text.length > 100);
            await assert.rejects(call('readToolkitLicense', { file: '../secret' }), { code: 'badRequest' });
            await assert.rejects(call('readToolkitLicense', { file: 'toolkit.json' }), { code: 'badRequest' });
            const cached = await call('checkToolkit', { full: false }); assert(cached.inventory.length >= 8);
        });
        await t.test('accepting toolkit version preserves template metadata', async () => {
            const file = path.join(project, 'nodu.lock.json'), lock = JSON.parse(fs.readFileSync(file));
            lock.toolkit.version = 'old-version'; fs.writeFileSync(file, JSON.stringify(lock));
            assert.equal((await call('openProject', { path: project })).lockedToolkitVersion, 'old-version');
            await call('acceptToolkit', { path: project });
            const current = JSON.parse(fs.readFileSync(file));
            assert.notEqual(current.toolkit.version, 'old-version'); assert.deepEqual(current.template, lock.template);
        });
        await t.test('CubeMX import preserves CMake; configure requires trust', async () => {
            const external = path.join(root, 'f103-export');
            fs.rmSync(path.join(external, 'nodu.json')); fs.rmSync(path.join(external, 'build'), { recursive: true });
            fs.writeFileSync(path.join(external, 'project.ioc'), 'Mcu.Name=STM32F103C8Tx\n');
            const original = fs.readFileSync(path.join(external, 'CMakeLists.txt'));
            assert.equal((await call('detectExternal', { path: external })).mcu, 'STM32F103C8Tx');
            assert.equal((await call('importExternal', { path: external, board })).trusted, false);
            await assert.rejects(call('configure', { path: external }), { code: 'untrusted' });
            assert(!fs.existsSync(path.join(external, 'build')));
            assert.deepEqual(fs.readFileSync(path.join(external, 'CMakeLists.txt')), original);
            await call('trustProject', { path: external }); assert.equal((await call('build', { path: external })).ok, true);
        });
        await t.test('source changed during build invalidates artifact', async () => {
            fs.appendFileSync(path.join(project, 'CMakeLists.txt'), '\nadd_custom_target(nodu_test_delay ALL COMMAND ${CMAKE_COMMAND} -E sleep 1)\n');
            let changed = false;
            eventHook = m => { if (!changed && m.event === 'build.progress' && m.data.phase === 'build') {
                fs.appendFileSync(path.join(project, 'Core/Src/main.c'), '\n// changed during build\n'); changed = true;
            } };
            const result = await call('build', { path: project, clean: true }); eventHook = () => {};
            assert(changed); assert.equal(result.stale, true);
            // flash refuses before device discovery; no probe is touched.
            await assert.rejects(call('flash', { path: project }), { code: 'noBuild' });
        });
        await t.test('cancel real Ninja child process and release build lock', async () => {
            fs.appendFileSync(path.join(project, 'CMakeLists.txt'), '\nadd_custom_target(nodu_test_cancel ALL COMMAND ${CMAKE_COMMAND} -E sleep 20)\n');
            let sent = false, cancellation;
            eventHook = m => { if (!sent && m.event === 'build.progress' && m.data.phase === 'build') { sent = true; cancellation = call('cancel', { queue: 'build' }); } };
            await assert.rejects(call('build', { path: project, clean: true }), { code: 'cancelled' });
            eventHook = () => {}; await cancellation; assert(sent);
            assert.equal((await call('configure', { path: project })).ok, true);
        });
    } finally {
        child.stdin.end(); await new Promise(resolve => child.once('exit', resolve));
        fs.rmSync(root, { recursive: true, force: true });
    }
});
