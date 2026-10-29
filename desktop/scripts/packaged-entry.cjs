// SPDX-License-Identifier: MIT
'use strict';

// Standalone app entry: copied to the package root as main.cjs. It boots the
// bundled Theia electron-main directly — no Theia CLI, npm, Cargo or system
// Node is involved at runtime.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function fail(message) {
    console.error(`Nodu: ${message}`);
    process.exit(1);
}

const { app } = require('electron');
process.env.NODU_APP_EXECUTABLE = process.execPath;

// The launcher ships next to this file so packaged mode reuses the exact
// original-flag parser (terminal modes, read timeouts, -update_resources).
// Requiring it does not invoke its main().
const { extractLauncherFlags } = require('./scripts/launch.cjs');

// Profile root: the original IDE profile dir by default; NODU_PROFILE_DIR is
// an absolute-path escape hatch for isolated package testing only.
const profileEnv = process.env.NODU_PROFILE_DIR;
const profile = profileEnv
    ? path.resolve(profileEnv)
    : path.join(os.homedir(), '.scope-studio');
if (profileEnv && !path.isAbsolute(profileEnv)) {
    fail('NODU_PROFILE_DIR must be an absolute path.');
}

process.env.THEIA_CONFIG_DIR = path.join(profile, 'config');
fs.mkdirSync(process.env.THEIA_CONFIG_DIR, { recursive: true });

const userData = path.join(profile, 'electron');
fs.mkdirSync(userData, { recursive: true });
// Must run before the bundled electron-main acquires its single-instance
// lock so the lock lands inside the chosen profile.
app.setPath('userData', userData);

// Inherited from Electron-hosted terminals; it would demote this process to
// plain Node. The outer packaging smoke removes it from the environment too.
delete process.env.ELECTRON_RUN_AS_NODE;

// Packaged: argv = [electron, ...userArgs]; dev require: [node, entry, ...].
const argvOffset = app.isPackaged ? 1 : 2;
const userArgs = process.argv.slice(argvOffset);

let extracted;
try {
    extracted = extractLauncherFlags(userArgs);
} catch (error) {
    fail(error instanceof Error ? error.message : String(error));
}
const rest = extracted.args;
if (rest.some(argument => /^(?:--(?:hostname|port|electronUserData)|-h|-p)(?:=|$)/.test(argument))) {
    fail('The launcher manages hostname, port and electronUserData. Use other options after the workspace path.');
}

if (extracted.terminals.length) {
    process.env.NODU_STARTUP_TERMINALS = JSON.stringify(extracted.terminals);
}
Object.assign(process.env, extracted.timeouts);

const workspaceArgument = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
// Keep the no-project launch empty so the dedicated workbench opens.
// Do not manufacture an empty Documents/Nodu workspace or add it to recents.
const workspace = workspaceArgument ? path.resolve(process.cwd(), workspaceArgument) : undefined;
if (workspace && !fs.existsSync(workspace)) {
    fail(`Workspace does not exist: ${workspace}`);
}

const managed = [
    '--hostname=127.0.0.1',
    `--plugins=local-dir:${path.join(__dirname, 'plugins')}`,
    '--port=0',
    `--electronUserData=${userData}`,
];
// Bundled ElectronMainProcessArgv.processArgvBinIndex is 0, so packaged
// mode keeps exactly one binary entry; a second one would be parsed as
// an extra workspace/file argument (the app executable itself).
process.argv = [process.argv[0], ...(app.isPackaged ? [] : [__filename]), ...(workspace ? [workspace] : []), ...rest, ...managed];

require('./lib/backend/electron-main.js');
