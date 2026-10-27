// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { ArduinoLanguageSpec, NoduArduinoLanguageService } from '../common/nodu-arduino-language-protocol';
import { readArduinoProject } from './nodu-arduino-project';
import { arduinoResources } from './nodu-arduino-paths';
import { arduinoOfflineRoot } from './nodu-arduino-offline';

export interface ArduinoLanguageEnvironment { home: string; cli: string; als: string; clangd: string; launcher?: string }
const quote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;

/** ALS owns .ino preprocessing and source mapping; this only locates the same prepared environment. */
export async function arduinoLanguageSpec(path: string, environment: ArduinoLanguageEnvironment): Promise<ArduinoLanguageSpec> {
    try {
        const project = await readArduinoProject(path), home = await fs.realpath(environment.home);
        const config = join(home, 'arduino-cli.yaml'); await fs.access(config);
        const cli = await fs.realpath(environment.cli), als = await fs.realpath(environment.als), clangd = await fs.realpath(environment.clangd);
        for (const tool of [cli, als, clangd]) { if (!isAbsolute(tool) || !(await fs.stat(tool)).isFile()) { throw new Error('Arduino 编辑器工具不可用。'); } }
        let incrementalSync = false;
        try {
            const manifest = JSON.parse(await fs.readFile(join(dirname(als), 'ARDUINO-LANGUAGE-TOOLS.json'), 'utf8'));
            const pinned = JSON.parse(await fs.readFile(join(arduinoResources(), 'language/tools.json'), 'utf8'));
            incrementalSync = manifest.alsVersion === '0.7.7-nodu.1' && manifest.alsVersion === pinned.alsVersion
                && manifest.als.sha256 === pinned.alsSource.sha256 && manifest.als.patchSha256 === pinned.alsSource.patchSha256
                && manifest.als.binarySha256 === createHash('sha256').update(await fs.readFile(als)).digest('hex');
        } catch { /* Unknown/custom ALS retains conservative document synchronization. */ }
        const data = await fs.realpath(join(home, 'data'));
        if (/[\r\n,]/.test(data)) { throw new Error('Arduino 工具路径包含不支持的字符。'); }
        const libraryProfile = await fs.readFile(join(project.path, 'sketch.yaml'), 'utf8');
        const fingerprint = createHash('sha256').update([project.path, home, libraryProfile, cli, als, clangd,
            await fs.readFile(config, 'utf8'), ...await Promise.all([cli, als, clangd].map(async tool => `${(await fs.stat(tool)).mtimeMs}`)),
        ].join('\0')).digest('hex');
        const runtime = join(home, 'language'); await fs.mkdir(runtime, { recursive: true });
        let launcher: string;
        const variables: Record<string, string> = {};
        if (process.platform === 'win32') {
            if (!environment.launcher) { throw new Error('Arduino 编辑器缺少 Windows clangd 启动器。'); }
            launcher = await fs.realpath(environment.launcher);
            variables.NODU_ARDUINO_CLANGD_REAL = clangd; variables.NODU_ARDUINO_DATA = data;
        } else {
            // Upstream ALS only allows data/packages/**. Profiles install their compiler in data/internal/**.
            // Restrict GCC query execution to these two Nodu-owned roots, never a workspace-wide glob.
            launcher = join(runtime, `clangd-${createHash('sha256').update(clangd + '\0' + data).digest('hex').slice(0, 20)}.sh`);
            // An explicit SDKROOT prevents macOS clangd from injecting the host SDK into Xtensa compilation.
            const source = `#!/bin/sh\n${process.platform === 'darwin' ? "SDKROOT=''; export SDKROOT\n" : ''}exec ${quote(clangd)} "$@" ${quote(`--query-driver=${data}/packages/**,${data}/internal/**`)}\n`;
            const temporary = `${launcher}.${process.pid}.${Date.now()}.tmp`;
            try { await fs.writeFile(temporary, source, { mode: 0o700 }); await fs.rename(temporary, launcher); }
            finally { await fs.rm(temporary, { force: true }); }
        }
        return { ok: true, command: als, args: ['-clangd', launcher, '-cli', cli, '-cli-config', config, '-fqbn', project.fqbn, '-jobs', '1'],
            project: project.path, fingerprint, incrementalSync, environment: variables };
    } catch (error) { return { ok: false, error: (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Arduino 编辑器环境尚未准备完成。' : error instanceof Error ? error.message : String(error) }; }
}

@injectable()
export class NoduArduinoLanguageServer implements NoduArduinoLanguageService {
    async spec(request: { path: string }): Promise<ArduinoLanguageSpec> {
        if (!request || typeof request.path !== 'string') { return { ok: false, error: '无效的 Arduino 工程。' }; }
        const resources = arduinoResources(), home = process.env.NODU_ARDUINO_HOME || join(homedir(), '.nodu/arduino');
        const bin = join(resources, '../bin', `${process.platform}-${process.arch}`), exe = process.platform === 'win32' ? '.exe' : '';
        const first = (paths: (string | undefined)[]): string => paths.find(path => !!path && existsSync(path)) ?? paths.find(Boolean) ?? '';
        const arduinoIDE = '/Applications/Arduino IDE.app/Contents/Resources/app/lib/backend/resources';
        const offline = arduinoOfflineRoot(), released = !!process.env.NODU_ARDUINO_OFFLINE_BUNDLES || existsSync(join(offline, 'required.json'))
            || existsSync(join(offline, `${process.platform}-${process.arch}`, 'manifest.json'));
        return arduinoLanguageSpec(request.path, {
            home,
            cli: first([process.env.NODU_ARDUINO_CLI, join(home, 'bin/1.5.1', `${process.platform}-${process.arch}`, `arduino-cli${exe}`), join(bin, `arduino-cli${exe}`), ...released ? [] : ['/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli']]),
            als: first([process.env.NODU_ARDUINO_LANGUAGE_SERVER, join(bin, `arduino-language-server${exe}`), !released && process.platform === 'darwin' ? join(arduinoIDE, 'arduino-language-server') : undefined]),
            clangd: first([process.env.NODU_ARDUINO_CLANGD, join(bin, 'arduino-clangd/bin', `clangd${exe}`), ...released ? [] : ['/usr/bin/clangd']]),
            launcher: join(bin, `arduino-clangd-launcher${exe}`),
        });
    }
}
