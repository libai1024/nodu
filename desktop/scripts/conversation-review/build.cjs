// SPDX-License-Identifier: MIT
const fs = require('node:fs'), path = require('node:path'), esbuild = require('esbuild');
const out = process.argv[2];
if (!out) throw Error('Pass an external output directory');
fs.mkdirSync(out, { recursive: true });
const stubs = {
    '@theia/core/shared/inversify': 'const n=()=>()=>{};export {n as inject,n as injectable,n as postConstruct};',
    '@theia/core/lib/common': 'export class CommandRegistry{};export class MenuModelRegistry{};export class CommandService{};',
    '@theia/core/lib/browser': 'export class ReactWidget{};export class ApplicationShell{};export const CommonMenus={};',
    '@theia/core/lib/browser/shell/view-contribution': 'export class AbstractViewContribution{};',
    '@theia/core/lib/browser/dialogs': 'export class ConfirmDialog{};',
    './nodu-tutor-model': 'export class NoduTutorModel{};',
    './nodu-tutor-context-transfer': 'export class NoduTutorContextTransfer{};',
    './nodu-tutor-hints': 'export const TUTOR_COMMANDS={};',
};
esbuild.build({
    entryPoints: [path.join(__dirname, 'fixture.tsx')], bundle: true, format: 'iife', outfile: path.join(out, 'fixture.js'),
    loader: { '.woff2': 'file', '.ttf': 'file', '.svg': 'file' }, define: { 'process.env.NODE_ENV': '"development"' },
    alias: { '@theia/core/shared/react': require.resolve('react'), '@theia/core/shared/react-dom': require.resolve('react-dom') },
    plugins: [{ name: 'service-boundaries', setup(build) {
        for (const name of Object.keys(stubs)) build.onResolve({ filter: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }, () => ({ path: name, namespace: 'fixture-stub' }));
        build.onLoad({ filter: /.*/, namespace: 'fixture-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }));
    } }],
}).catch(error => { console.error(error); process.exitCode = 1; });
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><html lang="zh-CN"><meta charset="UTF-8"><title>Nodu 会话界面验收</title><link rel="stylesheet" href="fixture.css"><div id="review"></div><script src="fixture.js"></script></html>');
