/**
 * Packaging-only variant of electron-app/esbuild.mjs: identical
 * context/rebuild/watch template, but node/electron backends are left
 * unminified so per-architecture workspace builds emit identical JS
 * (no nondeterministic mangled-name assignment) for the universal
 * merge. The browser bundle keeps its production options.
 */
import { browserOptions, watch } from './gen-esbuild.browser.mjs';
import { nodeOptions } from './gen-esbuild.node.mjs';
import { electronOptions } from './gen-esbuild.electron.mjs';
import esbuild from 'esbuild';

nodeOptions.minify = false;
electronOptions.minify = false;

const browserContext = await esbuild.context(browserOptions);
const nodeContext = await esbuild.context(nodeOptions);
const electronContext = await esbuild.context(electronOptions);

if (watch) {
    await Promise.all([
        browserContext.watch(),
        nodeContext.watch(),
        electronContext.watch(),
    ]);
} else {
    try {
        await browserContext.rebuild();
        await browserContext.dispose();
        await nodeContext.rebuild();
        await nodeContext.dispose();
        await electronContext.rebuild();
        await electronContext.dispose();
    } catch {
        process.exit(1);
    }
}
