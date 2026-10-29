// SPDX-License-Identifier: MIT
import { existsSync, statSync } from 'node:fs';
import { win32 as path } from 'node:path';
import { injectable } from '@theia/core/shared/inversify';
import { isWindows } from '@theia/core/lib/common/os';
import { ShellProcess } from '@theia/terminal/lib/node/shell-process';
import { ShellTerminalServer } from '@theia/terminal/lib/node/shell-terminal-server';
import { IShellTerminalServerOptions } from '@theia/terminal/lib/common/shell-terminal-protocol';

/** node-pty's relative-name lookup can miss the last PATH entry on Windows. */
export function windowsShellExecutable(shell: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
    const variable = (name: string): string => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase()) || name] || '';
    const root = variable('SystemRoot') || variable('windir');
    const system = root ? path.join(root, 'System32') : '';
    const candidates = path.isAbsolute(shell) ? [shell] : [
        ...(/^cmd(?:\.exe)?$/i.test(shell) ? [variable('ComSpec'), system && path.join(system, 'cmd.exe')] : []),
        ...(/^powershell(?:\.exe)?$/i.test(shell) && system ? [path.join(system, 'WindowsPowerShell/v1.0/powershell.exe')] : []),
        ...variable('PATH').split(';').map(directory => directory.trim().replace(/^"(.*)"$/, '$1')).filter(Boolean)
            .flatMap(directory => [path.join(directory, shell), ...(!path.extname(shell) ? [path.join(directory, `${shell}.exe`)] : [])]),
    ];
    return candidates.find(file => {
        try { return path.isAbsolute(file) && existsSync(file) && statSync(file).isFile(); } catch { return false; }
    });
}

@injectable()
export class NoduShellTerminalServer extends ShellTerminalServer {
    protected override validateTerminalOptions(options: IShellTerminalServerOptions): void {
        super.validateTerminalOptions(options);
        if (isWindows) {
            const shell = options.shell || ShellProcess.getShellExecutablePath();
            options.shell = windowsShellExecutable(shell) || windowsShellExecutable('cmd.exe');
        }
    }
}
