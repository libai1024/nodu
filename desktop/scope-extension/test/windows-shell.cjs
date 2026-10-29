// SPDX-License-Identifier: MIT
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/node/nodu-shell-terminal-server.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, experimentalDecorators: true }
}).outputText;
function load(files, windows = true, env = {}) {
    const exports = {}, known = new Set(files.map(file => file.toLowerCase()));
    class Server { validateTerminalOptions(options) { if (options.shell === 'invalid') { options.shell = undefined; } } }
    vm.runInNewContext(code, { exports, process: { env }, require: name => ({
        'node:fs': { existsSync: file => known.has(file.toLowerCase()), statSync: () => ({ isFile: () => true }) },
        'node:path': path, '@theia/core/shared/inversify': { injectable: () => value => value },
        '@theia/core/lib/common/os': { isWindows: windows },
        '@theia/terminal/lib/node/shell-process': { ShellProcess: { getShellExecutablePath: () => 'cmd.exe' } },
        '@theia/terminal/lib/node/shell-terminal-server': { ShellTerminalServer: Server }
    }[name]) });
    return exports;
}
test('Windows shells use absolute system paths without needing a developer PATH', () => {
    const cmd = 'C:\\Windows\\System32\\cmd.exe', powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    const api = load([cmd, powershell], true, { SystemRoot: 'C:\\Windows', PATH: '' });
    const options = {}; new api.NoduShellTerminalServer().validateTerminalOptions(options);
    assert.equal(options.shell, cmd);
    assert.equal(api.windowsShellExecutable('powershell.exe', { WINDIR: 'C:\\Windows' }), powershell);
    const invalid = { shell: 'invalid' }; new api.NoduShellTerminalServer().validateTerminalOptions(invalid); assert.equal(invalid.shell, cmd);
});
test('custom shells resolve the last quoted PATH entry and preserve explicit executable paths', () => {
    const file = 'E:\\Shell Tools\\pwsh.exe', api = load([file]);
    assert.equal(api.windowsShellExecutable('pwsh', { Path: 'D:\\absent;"E:\\Shell Tools"' }), file);
    assert.equal(api.windowsShellExecutable(file, {}), file);
    assert.equal(api.windowsShellExecutable('missing.exe', { Path: 'E:\\Shell Tools' }), undefined);
});
test('non-Windows terminal options retain the upstream shell and arguments', () => {
    const api = load([], false), options = { shell: '/bin/zsh', args: ['-l'] };
    new api.NoduShellTerminalServer().validateTerminalOptions(options);
    assert.deepEqual(options, { shell: '/bin/zsh', args: ['-l'] });
});
