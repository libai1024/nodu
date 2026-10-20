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

// Original OpenMV IDE launch flags: the five terminal modes open real
// terminals after startup; the two read-timeout overrides tune the device
// protocol. They are consumed here, never forwarded to Theia.
const TERMINAL_FLAGS = new Set([
    '-open_serial_terminal',
    '-open_tcp_client_terminal',
    '-open_tcp_server_terminal',
    '-open_udp_client_terminal',
    '-open_udp_server_terminal',
]);
const READ_TIMEOUT_FLAGS = {
    '-override_read_timeout': 'NODU_READ_TIMEOUT_MS',
    '-override_read_stall_timeout': 'NODU_READ_STALL_TIMEOUT_MS',
};

/** Pull original flags out of `args`; returns {args, terminals, timeouts}. */
function extractLauncherFlags(args) {
    const terminals = [];
    const timeouts = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (TERMINAL_FLAGS.has(arg)) {
            const value = args[++i];
            if (value === undefined || value.startsWith('-')) {
                throw new Error(`${arg} requires a parameter.`);
            }
            if (value.length > 512 || value.includes('\0')) {
                throw new Error(`${arg} parameter must be <=512 chars and NUL-free.`);
            }
            if (terminals.length >= 16) { throw new Error('too many -open_*_terminal flags (max 16).'); }
            terminals.push([arg, value]);
        } else if (Object.hasOwn(READ_TIMEOUT_FLAGS, arg)) {
            const value = args[++i];
            const ms = Number(value);
            if (!Number.isInteger(ms) || ms < 1 || ms > 60000) {
                throw new Error(`${arg} expects 1-60000 ms, got ${value}.`);
            }
            timeouts[READ_TIMEOUT_FLAGS[arg]] = String(ms);
        } else {
            rest.push(arg);
        }
    }
    return { args: rest, terminals, timeouts };
}

async function main() {
    if (!['browser', 'electron'].includes(target)) {
        fail('Usage: node scripts/launch.cjs <browser|electron> [workspace] [Theia options]');
        return;
    }
    let args = suppliedArgs[0] === '--' ? suppliedArgs.slice(1) : [...suppliedArgs];
    if (args.includes('--help') || args.includes('-h')) {
        console.log(`Nodu ${target} launcher\nUsage: npm run start:${target} -- [workspace] [Theia options]\nDefault workspace: examples/green-tracker\nAddress: http://127.0.0.1:${target === 'browser' ? 4188 : 4189}\nProfile: ${path.join(os.homedir(), '.scope-studio')}\n\nOriginal OpenMV IDE flags (consumed by the launcher, not Theia):\n  -open_serial_terminal <port:baud>        open a serial terminal\n  -open_tcp_client_terminal <host:port>    open a TCP client terminal\n  -open_tcp_server_terminal <port>         open a TCP server terminal\n  -open_udp_client_terminal <host:port>    open a UDP client terminal\n  -open_udp_server_terminal <port>         open a UDP server terminal\n  -override_read_timeout <ms>              IDE reply deadline, 1-60000 (unset keeps each operation's default)\n  -override_read_stall_timeout <ms>        stalled-reply bound, 1-60000 (unset adds no bound)\n\nExample: npm run start:electron -- -open_udp_server_terminal 9000\nNode.js 24 and a completed build are required.`);
        return;
    }
    let extracted;
    try {
        extracted = extractLauncherFlags(args);
    } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        return;
    }
    args = extracted.args;
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
    if (extracted.terminals.length) {
        env.NODU_STARTUP_TERMINALS = JSON.stringify(extracted.terminals);
        console.log(`Nodu: opening ${extracted.terminals.length} terminal(s) after startup`);
    }
    Object.assign(env, extracted.timeouts);
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

// Exportable for unit tests; only run when invoked directly.
module.exports = { extractLauncherFlags, TERMINAL_FLAGS, READ_TIMEOUT_FLAGS };

if (require.main === module) {
    main().catch(error => fail(error instanceof Error ? error.message : String(error)));
}
