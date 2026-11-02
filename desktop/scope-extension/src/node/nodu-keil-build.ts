// SPDX-License-Identifier: MIT
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path';
import { BuildResult, Diagnostic, ProjectStatus } from '../common/nodu-embedded-protocol';
import { findKeil, generateKeil } from './nodu-keil-project';

export interface KeilBuildVerification {
    compatibility: 'passed';
    compilation: 'passed' | 'unavailable';
    targets: { name: string; warnings: number; log: string }[];
}
interface Host {
    request(method: string, args: Record<string, unknown>): Promise<unknown>;
    resources: string;
    signal: AbortSignal;
    progress(text: string): void;
    // Dependency seams also allow real-toolchain acceptance without starting a desktop.
    generate?: typeof generateKeil;
    compiler?: typeof verifyKeilCompilation;
}
const refused = (code: string, message: string, detail?: unknown): Error => Object.assign(new Error(message), { code, detail });
function checkCancelled(signal: AbortSignal): void { if (signal.aborted) throw refused('cancelled', '编译已停止。'); }

/** A normal Nodu build always checks the Keil contract, independently of idle autoSync. */
export async function buildWithKeil(project: ProjectStatus, clean: boolean, host: Host): Promise<BuildResult> {
    const root = await fs.realpath(project.path), state = join(root, '.nodu');
    await fs.mkdir(state, { recursive: true });
    const statePath = await fs.realpath(state), rel = relative(root, statePath);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw refused('keilPath', '工程状态目录不能指向工程外。');
    const lock = join(statePath, 'keil-check.lock'), token = randomUUID();
    const handle = await fs.open(lock, 'wx').catch(() => { throw refused('keilBusy', '另一窗口正在验证 Keil 工程。若上次异常退出，请关闭相关 Nodu/Keil 进程后删除 .nodu/keil-check.lock 再试。'); });
    try {
        await handle.writeFile(token);
        return await checkedBuild(project, clean, host, token);
    } finally { await handle.close(); await fs.rm(lock, { force: true }); }
}
async function checkedBuild(project: ProjectStatus, clean: boolean, host: Host, reservation: string): Promise<BuildResult> {
    checkCancelled(host.signal);
    host.progress('检查 Keil 共用工程');
    // Invalidate the old downloadable build before any compatibility check can fail.
    const configured = await host.request('configure', { path: project.path, force: true, invalidateCurrent: true }) as { ok: boolean; compileCommands: string; inputDigest: string; diagnostics?: Diagnostic[] };
    checkCancelled(host.signal);
    if (!configured.ok) throw refused('keilConfiguration', '工程配置失败，无法检查 Keil 兼容性。', { diagnostics: configured.diagnostics });
    if (!/^[a-f0-9]{64}$/.test(configured.inputDigest ?? '')) throw refused('versionMismatch', '嵌入式构建组件需要更新，未跳过 Keil 兼容检查。');
    const generated = await (host.generate ?? generateKeil)(project, configured.compileCommands, host.resources, reservation);
    checkCancelled(host.signal);
    const verification = await (host.compiler ?? verifyKeilCompilation)(generated.path, host.signal, host.progress);
    checkCancelled(host.signal);
    // Native build compares this digest under its build lock. Source changes during
    // generation/Keil compilation cannot validate a different GCC input revision.
    host.progress('Keil 兼容检查通过，开始本地编译');
    const result = await host.request('build', { path: project.path, clean, expectedInputDigest: configured.inputDigest }) as BuildResult;
    if (host.signal.aborted) {
        await host.request('configure', { path: project.path, invalidateCurrent: true }).catch(() => undefined);
        checkCancelled(host.signal);
    }
    return { ...result, keil: verification };
}

export function keilDiagnostics(text: string, projectFile: string): Diagnostic[] {
    return text.split(/\r?\n/).flatMap(line => {
        const m = /^\s*(.+?)\((\d+)(?:\s*,\s*(\d+))?\)\s*:\s*(error|warning)\s*:\s*(.*)$/i.exec(line);
        if (!m) return [];
        const absolute = resolve(dirname(projectFile), m[1].replace(/\\/g, '/'));
        return [{ source: 'compiler' as const, severity: m[4].toLowerCase() as 'error' | 'warning', file: m[1], absolute, line: Number(m[2]), column: Number(m[3] || 1), message: m[5] }];
    });
}
function decodeLog(bytes: Buffer): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { return new TextDecoder('gb18030').decode(bytes); }
}

/** Compile only: -j0 hides µVision; no flash/reset/debug command is ever issued. */
export async function runKeilTarget(executable: string, project: string, target: string, log: string, signal: AbortSignal, timeout = 180_000): Promise<{ warnings: number; log: string }> {
    checkCancelled(signal);
    await fs.mkdir(dirname(log), { recursive: true });
    await fs.rm(log, { force: true });
    const exitCode = await new Promise<number | null>((yes, no) => {
        const child = spawn(executable, ['-r', project, '-t', target, '-o', log, '-j0'], { cwd: dirname(project), windowsHide: true, stdio: 'ignore' });
        let interrupted: Error | undefined;
        const stop = (error: Error): void => {
            if (interrupted) return; interrupted = error;
            if (process.platform === 'win32' && child.pid) {
                // Terminate only this compiler process tree; wait for exit before releasing the build.
                const killer = spawn(join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
                killer.on('error', () => child.kill());
            } else child.kill('SIGKILL');
        };
        const abort = () => stop(refused('cancelled', 'Keil 验证已停止。'));
        const timer = setTimeout(() => stop(refused('keilTimeout', 'Keil 编译验证超时，请检查编译器、许可和构建日志。', { log })), timeout);
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        child.once('error', error => { cleanup(); no(error); });
        child.once('exit', code => { cleanup(); interrupted ? no(interrupted) : yes(code); });
    });
    checkCancelled(signal);
    const text = await fs.readFile(log).then(decodeLog, () => '');
    const summary = [...text.matchAll(/(\d+)\s+Error\(s\),\s*(\d+)\s+Warning\(s\)/gi)].at(-1);
    // Keil's documented exit 1 means warnings only; a fresh log must also prove success.
    if (![0, 1].includes(exitCode ?? -1) || !summary || Number(summary[1]) !== 0 || /Target not created/i.test(text)) {
        throw refused('keilCompile', `${target} 编译未通过，请修复后重新编译。`, { log, exitCode, output: text.slice(-16000), diagnostics: keilDiagnostics(text, project) });
    }
    return { warnings: Number(summary[2]), log };
}

export async function verifyKeilCompilation(project: string, signal: AbortSignal, progress: (text: string) => void): Promise<KeilBuildVerification> {
    const executable = await findKeil();
    checkCancelled(signal);
    if (!executable) return { compatibility: 'passed', compilation: 'unavailable', targets: [] };
    const arm = resolve(dirname(executable), '../ARM');
    const available: string[] = [];
    for (const [name, binary] of [['Nodu AC6', 'ARMCLANG/bin/armclang.exe'], ['Nodu AC5', 'ARMCC/bin/armcc.exe']]) {
        if (await fs.stat(join(arm, binary)).then(s => s.isFile(), () => false)) available.push(name);
    }
    if (!available.length) throw refused('keilCompilerMissing', '已检测到 Keil，但未找到可用的 Arm Compiler 5/6。请在 Keil 中安装或配置编译器。');
    const root = await fs.realpath(resolve(dirname(project), '..'));
    const state = join(root, '.nodu'); await fs.mkdir(state, { recursive: true });
    const actual = await fs.realpath(state), rel = relative(root, actual);
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) throw refused('keilPath', '构建日志目录不能指向工程外。');
    const run = await fs.mkdtemp(join(actual, 'keil-check-'));
    const targets: KeilBuildVerification['targets'] = [];
    for (const target of available) {
        progress(`Keil 实编验证：${target}`);
        const log = join(run, `${target.replace(/\s+/g, '-')}-${randomUUID()}.log`);
        const result = await runKeilTarget(executable, project, target, log, signal);
        targets.push({ name: target, ...result });
    }
    return { compatibility: 'passed', compilation: 'passed', targets };
}
