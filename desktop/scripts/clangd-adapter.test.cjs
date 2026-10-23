// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
test('plugin is lazy, serializes switches, filters SDK diagnostics, disposes old client', async () => {
    const commands = new Map(); let activated = 0, stopped = 0, disposed = 0, lastClient;
    const vscode = { commands: { registerCommand(id, handler) {
        assert(!commands.has(id), `duplicate registration: ${id}`); commands.set(id, handler);
        return { dispose: () => commands.delete(id) };
    } } };
    const context = { subscriptions: [] };
    const sandbox = { exports: {}, process: { env: {} }, require(name) {
        if (name === 'vscode') return vscode;
        if (name === 'node:fs') return { existsSync: () => true };
        if (name === './out/bundle.js') return { async activate(ctx) {
            activated++; ctx.subscriptions.push({ dispose() { disposed++; } });
            lastClient = { clientOptions: {}, async stop() { stopped++; } }; return { client: lastClient };
        } };
        throw new Error(name);
    } };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'clangd-adapter.cjs'), 'utf8'), sandbox);
    sandbox.exports.activate(context); assert.equal(activated, 0);
    const spec = { command: '/toolkit/clangd', args: Array(8).fill('--test'), sdk: '/toolkit/sdk' };
    await commands.get('nodu.clangd.start')(spec); assert.equal(activated, 1);
    const diagnostic = { message: 'test' }; let got;
    lastClient.clientOptions.middleware.handleDiagnostics({ fsPath: '/toolkit/sdk/HAL.c' }, [diagnostic], (_, ds) => got = ds); assert.equal(got.length, 0);
    lastClient.clientOptions.middleware.handleDiagnostics({ fsPath: '/toolkit/sdk-other/main.c' }, [diagnostic], (_, ds) => got = ds); assert.equal(got[0], diagnostic);
    await Promise.all([commands.get('nodu.clangd.start')(spec), commands.get('nodu.clangd.stop')()]);
    assert.equal(activated, 2); assert.equal(stopped, 2); assert.equal(disposed, 2);
    await sandbox.exports.deactivate(); assert.equal(stopped, 2);
});
