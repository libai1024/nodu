// SPDX-License-Identifier: MIT
// Nodu lifecycle adapter; upstream vscode-clangd's language client is unchanged.
const vscode = require('vscode');
const fs = require('node:fs');
let session;
let queue = Promise.resolve();
function enqueue(action) { const result = queue.then(action); queue = result.catch(() => {}); return result; }
async function stop() {
    const old = session; session = undefined;
    if (!old) return;
    try { await old.api?.client?.stop(); }
    finally { for (const item of old.context.subscriptions.reverse()) item.dispose(); }
}
exports.activate = context => {
    context.subscriptions.push(vscode.commands.registerCommand('nodu.clangd.start', spec => enqueue(async () => {
        await stop();
        if (!spec || !fs.existsSync(spec.command) || !Array.isArray(spec.args) || spec.args.length !== 8) throw new Error('STM32 clangd 工具包不可用');
        process.env.NODU_CLANGD_PATH = spec.command;
        spec.args.forEach((arg, i) => { process.env[`NODU_CLANGD_ARG_${i}`] = arg; });
        // Separate subscription ownership permits switching projects without duplicate registrations.
        const childContext = Object.create(context);
        Object.defineProperty(childContext, 'subscriptions', { value: [], enumerable: true });
        session = { context: childContext };
        try {
            session.api = await require('./out/bundle.js').activate(childContext);
            const client = session.api?.client;
            if (client) {
                const sdk = spec.sdk.replace(/\\/g, '/').replace(/\/$/, '') + '/';
                client.clientOptions.middleware = { ...client.clientOptions.middleware,
                    handleDiagnostics(uri, diagnostics, next) {
                        next(uri, uri.fsPath.replace(/\\/g, '/').startsWith(sdk) ? [] : diagnostics);
                    } };
            }
        }
        catch (error) { await stop(); throw error; }
    })));
    context.subscriptions.push(vscode.commands.registerCommand('nodu.clangd.stop', () => enqueue(stop)));
};
exports.deactivate = () => enqueue(stop);
