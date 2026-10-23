// SPDX-License-Identifier: MIT
// Compiles real firmware with an isolated sidecar. No hardware methods are called.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { createDaxinProject } = require('../scope-extension/lib/node/nodu-daxin-project');
const { parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
const { DAXIN_TEMPLATES } = require('../scope-extension/lib/common/nodu-project-catalog');
const desktop = path.resolve(__dirname, '..');
const toolkit = process.env.NODU_STM32_TOOLKIT || path.join(desktop, '.tools/stm32', process.platform);
const binary = process.env.NODU_EMBEDDED_BIN || path.join(desktop, 'native/target/debug/nodu-embedded');
test('three DACIR templates build through the real Nodu pipeline', { skip: !fs.existsSync(binary) || !fs.existsSync(toolkit), timeout: 240000 }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-daxin-host-'));
    const child = spawn(binary, ['--resources', path.join(desktop, 'scope-extension/resources/stm32'), '--toolkit', toolkit, '--data-dir', path.join(root, 'state')]);
    const pending = new Map(); let seq = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => {
        const data = JSON.parse(line); if (!data.id) return;
        const p = pending.get(data.id); if (!p) return;
        clearTimeout(p.timer); pending.delete(data.id);
        if (data.error) p.reject(new Error(data.error + ' ' + JSON.stringify(data.detail))); else p.resolve(data.result);
    });
    child.stderr.on('data', bytes => process.stderr.write(bytes));
    const call = (method, args) => {
        assert(['openProject', 'trustProject', 'build'].includes(method), 'hardware RPC forbidden');
        return new Promise((resolve, reject) => {
            const id = ++seq; const timer = setTimeout(() => reject(new Error('timeout: ' + method)), 90000);
            pending.set(id, { resolve, reject, timer }); child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
        });
    };
    try {
        for (const template of DAXIN_TEMPLATES) await t.test(template.source, async () => {
            const p = await createDaxinProject(parseProjectRequest({ parent: root, name: template.source, chip: 'STM32F103C8Tx', template: template.id }));
            await call('trustProject', { path: p.path });
            const build = await call('build', { path: p.path });
            assert.equal(build.ok, true, JSON.stringify(build.diagnostics));
            for (const file of ['firmware.elf', 'firmware.bin', 'firmware.hex', 'firmware.map', 'compile_commands.json']) assert(fs.statSync(path.join(p.path, 'build/debug', file)).size > 0);
            const status = await call('openProject', { path: p.path });
            assert.equal(status.buildStale, false);
            assert(status.currentBuild.binaryBytes <= 65536);
            const commands = JSON.parse(fs.readFileSync(path.join(p.path, 'build/debug/compile_commands.json')));
            assert(commands.some(c => c.file.endsWith('/src/main.c')));
            fs.appendFileSync(path.join(p.path, 'src/main.c'), '\n/* invalidate */\n');
            assert.equal((await call('openProject', { path: p.path })).buildStale, true);
        });
    } finally {
        child.stdin.end();
        await new Promise(resolve => child.once('exit', resolve));
        for (const p of pending.values()) clearTimeout(p.timer);
        fs.rmSync(root, { recursive: true, force: true });
    }
});
