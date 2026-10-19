#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const [target, ...suppliedArgs] = process.argv.slice(2);
let activeChild;

function fail(message) {
    console.error(`Nodu: ${message}`);
    process.exitCode = 1;
}

function run(cli, args, cwd, env) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: 'inherit', shell: false });
        activeChild = child;
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            activeChild = undefined;
            if (signal) {
                resolve(signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
            } else {
                resolve(code ?? 1);
            }
        });
    });
}

async function main() {
    if (!['browser', 'electron'].includes(target)) {
        fail('Usage: node scripts/launch.cjs <browser|electron> [workspace] [Theia options]');
        return;
    }
    const args = suppliedArgs[0] === '--' ? suppliedArgs.slice(1) : [...suppliedArgs];
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`Nodu ${target} launcher\nUsage: npm run start:${target} -- [workspace] [Theia options]\nDefault workspace: examples/green-tracker\nAddress: http://127.0.0.1:${target === 'browser' ? 4188 : 4189}\nProfile: ${path.join(os.homedir(), '.scope-studio')}\nNode.js 24 and a completed build are required.`);
        return;
    }
    if (Number(process.versions.node.split('.')[0]) !== 24) {
        fail(`Node.js 24 is required; this process uses ${process.version}. Activate Node 24 before starting.`);
        return;
    }

    const workspaceArgument = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    const invocationDirectory = process.env.INIT_CWD || process.cwd();
    const workspace = path.resolve(workspaceArgument ? invocationDirectory : root, workspaceArgument || 'examples/green-tracker');
    if (!fs.existsSync(workspace)) {
        fail(`Workspace does not exist: ${workspace}`);
        return;
    }
    // These options belong to the local application profile, not arbitrary forwarded backend flags.
    if (args.some(argument => /^(?:--(?:hostname|port|electronUserData)|-h|-p)(?:=|$)/.test(argument))) {
        fail('The launcher manages hostname, port and electronUserData. Use other Theia options after the workspace path.');
        return;
    }

    const appDirectory = path.join(root, `${target}-app`);
    const requiredFiles = ['lib/frontend/index.html', 'lib/backend/main.js'];
    if (target === 'electron') {
        requiredFiles.push('lib/backend/electron-main.js');
    }
    if (requiredFiles.some(file => !fs.existsSync(path.join(appDirectory, file)))) {
        fail(`The ${target} app is not built. From desktop/, run npm run build:${target}.`);
        return;
    }
    let cli;
    try {
        cli = require.resolve('@theia/cli/bin/theia.js', { paths: [root] });
        if (target === 'electron') {
            const electronBinary = require(require.resolve('electron', { paths: [appDirectory, root] }));
            if (!fs.existsSync(electronBinary)) {
                throw new Error('Electron executable was not found.');
            }
        }
    } catch (error) {
        fail(`Dependencies are incomplete. Run npm ci, then npm exec -- install-electron.\n${error.message}`);
        return;
    }

    const profile = path.join(os.homedir(), '.scope-studio');
    const env = { ...process.env, THEIA_CONFIG_DIR: path.join(profile, 'config') };
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
    env[pathKey] = [path.dirname(process.execPath), env[pathKey] || ''].join(path.delimiter);
    fs.mkdirSync(env.THEIA_CONFIG_DIR, { recursive: true });

    // Theia creates .browser_modules when Electron's native modules are active,
    // and removes that cache when restoring the Node/browser versions.
    const electronModulesActive = fs.existsSync(path.join(root, '.browser_modules'));
    if ((target === 'electron') !== electronModulesActive) {
        console.log(`Nodu: switching native dependencies to ${target}.`);
        const result = await run(cli, [`rebuild:${target}`, '--cacheRoot', root], appDirectory, env);
        if (result !== 0) {
            process.exitCode = result;
            return;
        }
    }

    const launchArgs = ['start', fs.realpathSync(workspace), ...args, '--hostname=127.0.0.1', `--port=${target === 'browser' ? 4188 : 4189}`];
    require('./refresh-native-artifacts.cjs').refreshNativeArtifacts(appDirectory);
    if (target === 'electron') {
        launchArgs.push('--electronUserData', path.join(profile, 'electron'));
    }
    console.log(`Nodu: opening ${workspace}`);
    process.exitCode = await run(cli, launchArgs, appDirectory, env);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        if (activeChild && !activeChild.killed) {
            activeChild.kill(signal);
        }
    });
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
