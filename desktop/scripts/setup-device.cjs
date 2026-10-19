// SPDX-License-Identifier: MIT
// One per-user Python environment, shared by all Nodu projects.
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');
const envDir = join(homedir(), '.nodu', 'python');
const python = join(envDir, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command, args) {
    const result = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
    if (result.error || result.status !== 0) {
        console.error(result.error?.message || `${command} failed (${result.status})`);
        process.exit(result.status || 1);
    }
}
if (!existsSync(python)) { run(process.env.NODU_BASE_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-m', 'venv', envDir]); }
run(python, ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', join(__dirname, '../scope-extension/resources/requirements.txt')]);
console.log(`Nodu device environment ready: ${python}`);
