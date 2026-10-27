// SPDX-License-Identifier: MIT
// Separate from the STM32 clangd adapter: Arduino Language Server owns .ino source mapping.
const vscode = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');
const fs = require('node:fs');
const path = require('node:path');
const { restrictArduinoCapabilities, restrictArduinoServerCapabilities } = require('./arduino-language-capabilities.cjs');
const { arduinoLineChange, arduinoPatchedChange, createArduinoResyncGate } = require('./arduino-language-sync.cjs');
let client, watcher, output, fingerprint, restartTimer, fileSubscriptions = [], generation = 0, chain = Promise.resolve();
function enqueue(action) { const task = chain.then(action); chain = task.catch(() => {}); return task; }
async function stop() { const old = client, oldWatcher = watcher, oldOutput = output, subscriptions = fileSubscriptions; client = watcher = output = undefined; fingerprint = undefined; fileSubscriptions = [];
    clearTimeout(restartTimer); restartTimer = undefined;
    try { if (old) await old.stop(5000); } finally { subscriptions.forEach(item => item.dispose()); oldWatcher?.dispose(); oldOutput?.dispose(); } }
function validate(spec) {
    if (!spec?.ok || !path.isAbsolute(spec.command || '') || !fs.existsSync(spec.command)
        || !path.isAbsolute(spec.project || '') || !fs.existsSync(spec.project)
        || !Array.isArray(spec.args) || spec.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))
        || typeof spec.fingerprint !== 'string') throw new Error(spec?.error || 'Arduino 编辑器工具不可用。');
}
exports.activate = context => {
    context.subscriptions.push(vscode.commands.registerCommand('nodu.arduino.language.start', spec => {
        const current = ++generation;
        return enqueue(async () => {
            validate(spec); if (current !== generation) return;
            if (client && fingerprint === spec.fingerprint && !spec.refresh) return;
            await stop(); if (current !== generation) return;
            const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('ARDUINO_')));
            for (const name of ['NODU_ARDUINO_CLANGD_REAL', 'NODU_ARDUINO_DATA']) {
                if (typeof spec.environment?.[name] === 'string') env[name] = spec.environment[name];
            }
            const folder = vscode.Uri.file(spec.project);
            // Theia 1.76 drops RelativePattern.baseUri across the plugin RPC bridge.
            // A scoped absolute glob survives both LanguageClient conversion and that bridge.
            const projectGlob = spec.project.replace(/\\/g, '/').replace(/[?*\[\]{}]/g, char => `[${char}]`).replace(/\/$/, '');
            const pattern = `${projectGlob}/**/*.{ino,pde,c,cpp,cxx,cc,h,hpp}`;
            const selector = [{ scheme: 'file', pattern }];
            watcher = vscode.workspace.createFileSystemWatcher(pattern);
            output = vscode.window.createOutputChannel('Arduino 编辑器');
            const currentOutput = output;
            const snapshots = new Map();
            const resync = createArduinoResyncGate(error => currentOutput.appendLine(error.message));
            let syncChain = Promise.resolve(), reopenTimer; const pendingReopens = new Map();
            const flushReopen = async () => { const documents = [...pendingReopens.values()]; pendingReopens.clear(); clearTimeout(reopenTimer); for (const document of documents) if (client === next) { resync.mark(); await next.sendNotification('textDocument/didClose', { textDocument: { uri: document.uri } }); await next.sendNotification('textDocument/didOpen', { textDocument: document }); } };
            const requests = Object.fromEntries(['provideCompletionItem', 'provideHover', 'provideDefinition', 'provideTypeDefinition',
                'provideImplementation', 'provideSignatureHelp', 'provideDocumentHighlights', 'provideDocumentSymbols',
                'provideDocumentFormattingEdits', 'provideDocumentRangeFormattingEdits', 'provideRenameEdits', 'prepareRename'].map(name => [name, async (...args) => {
                    const handler = args.pop(), token = args[args.length - 1]; await syncChain; await flushReopen(); await resync.wait();
                    if (!token?.isCancellationRequested && client === next) return handler(...args);
                }]));
            const next = new LanguageClient('nodu-arduino-language', 'Arduino', { command: spec.command, args: spec.args,
                options: { cwd: spec.project, env } }, { documentSelector: selector,
                workspaceFolder: { uri: folder, name: path.basename(spec.project), index: 0 },
                outputChannel: currentOutput, revealOutputChannelOn: 4,
                middleware: { ...requests, handleWorkDoneProgress(token, value, nextHandler) {
                    resync.progress(token, value); nextHandler();
                }, didOpen(document, nextHandler) {
                    snapshots.set(document.uri.toString(), document.getText()); return nextHandler(document);
                }, didClose(document, nextHandler) {
                    snapshots.delete(document.uri.toString()); return nextHandler(document);
                }, didChange(event, nextHandler) {
                    const uri = event.document.uri.toString(), text = event.document.getText(), version = event.document.version;
                    const update = (spec.incrementalSync ? arduinoPatchedChange : arduinoLineChange)(snapshots.get(uri), text); snapshots.set(uri, text);
                    if (!update) return;
                    const reopen = update.reopen || resync.isPending();
                    if (reopen) resync.mark();
                    const task = syncChain.then(async () => {
                        if (client !== next) return;
                        if (reopen) {
                            pendingReopens.set(uri, { uri, version, languageId: event.document.languageId, text });
                            clearTimeout(reopenTimer); reopenTimer = setTimeout(() => { syncChain = syncChain.then(flushReopen).catch(error => currentOutput.appendLine(String(error))); }, 180);
                        } else { await nextHandler({ ...event, contentChanges: [update.change] }); }
                    });
                    syncChain = task.catch(() => {}); return task;
                }, async didSave(document, nextHandler) { await syncChain; await flushReopen(); return nextHandler(document); }, async provideCodeActions(document, range, context, token, nextHandler) {
                    await syncChain; await flushReopen(); await resync.wait(); if (token?.isCancellationRequested || client !== next) return;
                    const actions = await nextHandler(document, range, context, token);
                    // ALS cannot execute clangd.applyFix/applyTweak; retain directly applicable edits.
                    return actions?.filter(action => !action.command);
                }, handleDiagnostics(uri, diagnostics, nextHandler) {
                    // ALS publishes toolchain diagnostics to a synthetic file:///not-ino document.
                    // Keep those in its output stream, not an invented project source file.
                    if (uri.scheme !== 'file' || uri.fsPath === '/not-ino') {
                        for (const diagnostic of diagnostics) currentOutput.appendLine(diagnostic.message);
                        return;
                    }
                    nextHandler(uri, diagnostics);
                } },
            });
            next.registerFeature({ fillClientCapabilities: restrictArduinoCapabilities, preInitialize: restrictArduinoServerCapabilities, initialize() {}, clear() {} });
            // ALS 0.7.7 panics on workspace/didChangeWatchedFiles. Open editors use normal
            // didChange/didSave; additions, removals and external closed-file edits rebuild the session.
            const refreshForFile = (uri, structural) => {
                if (client !== next) return;
                const relative = path.relative(spec.project, uri.fsPath);
                if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
                    || relative.split(/[\\/]/).some(part => ['.nodu', '.git', 'build', 'node_modules'].includes(part))) return;
                if (!structural && vscode.workspace.textDocuments.some(document => !document.isClosed && document.uri.toString() === uri.toString())) return;
                clearTimeout(restartTimer);
                restartTimer = setTimeout(() => {
                    restartTimer = undefined;
                    if (client === next) void vscode.commands.executeCommand('nodu.arduino.language.start', { ...spec, refresh: true })
                        .catch(error => currentOutput.appendLine(String(error)));
                }, 500);
            };
            fileSubscriptions = [watcher.onDidChange(uri => refreshForFile(uri, false)),
                watcher.onDidCreate(uri => refreshForFile(uri, true)), watcher.onDidDelete(uri => refreshForFile(uri, true)), { dispose: () => { clearTimeout(reopenTimer); pendingReopens.clear(); resync.dispose(); } }];
            fileSubscriptions.push(next.onDidChangeState(event => { if (event.newState === 1) resync.dispose(); }));
            client = next;
            try { await next.start(); fingerprint = spec.fingerprint; if (current !== generation) await stop(); }
            catch (error) { await stop(); throw error; }
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('nodu.arduino.language.stop', () => { ++generation; return enqueue(stop); }));
};
exports.deactivate = () => { ++generation; return enqueue(stop); };
