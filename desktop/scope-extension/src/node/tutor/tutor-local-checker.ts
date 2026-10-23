// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { TutorBuffer } from '../../common/tutor/tutor-ai-protocol';
import { TutorLocalCheck, TutorLocalRule } from '../../common/tutor/tutor-local-check';

/** One bounded, cancellable read-only process per snapshot. No shell and no project cwd. */
export class TutorLocalChecker {
    private active = 0;
    constructor(private readonly executable = process.env.NODU_TUTOR_CHECKER_BIN ?? join(dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json')), 'resources/bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'nodu-tutor.exe' : 'nodu-tutor')) { }
    async inspect(buffer: TutorBuffer, rules: TutorLocalRule[] = [], signal?: AbortSignal): Promise<TutorLocalCheck> {
        const sourceDigest = createHash('sha256').update(buffer.text).digest('hex');
        const unavailable = (note: string): TutorLocalCheck => ({ schema: 1, sourceDigest, syntax: 'unavailable', errorLines: [], findings: [], note });
        if (!/\.(c|h)$/i.test(buffer.path)) { return unavailable('本地结构检查仅支持 C 文件'); }
        if (buffer.text.length > 32000 || !Array.isArray(rules) || rules.length > 32 || rules.some(r => !r || Object.keys(r).some(k => !['id','kind','function','callee'].includes(k))
            || !['calls','noCallIn','checksReturn'].includes(r.kind) || typeof r.id !== 'string' || !r.id.length || r.id.length > 80
            || typeof r.function !== 'string' || typeof r.callee !== 'string' || !/^[A-Za-z_]\w{0,79}$/.test(r.function) || !/^[A-Za-z_]\w{0,79}$/.test(r.callee))) { return unavailable('检查请求无效'); }
        if (signal?.aborted) { return unavailable('检查已取消'); }
        if (!existsSync(this.executable)) { return unavailable('本地检查器尚未安装'); }
        if (this.active >= 2) { return unavailable('本地检查正在进行'); }
        this.active++;
        try {
            return await new Promise(resolve => {
                let finished = false, output = '', size = 0;
                const child = spawn(this.executable, [], { stdio: ['pipe','pipe','pipe'], windowsHide: true, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot } });
                const finish = (result: TutorLocalCheck): void => {
                    if (finished) { return; } finished = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
                    child.kill('SIGKILL'); resolve(result);
                };
                const abort = (): void => finish(unavailable('检查已取消'));
                const timer = setTimeout(() => { child.kill('SIGKILL'); finish(unavailable('本地检查超时')); }, 1500);
                signal?.addEventListener('abort', abort, { once: true });
                child.on('error', () => finish(unavailable('本地检查器不可用')));
                child.stdin.on('error', () => finish(unavailable('本地检查器连接中断')));
                child.stdout.setEncoding('utf8');
                child.stdout.on('data', (chunk: string) => {
                    size += Buffer.byteLength(chunk);
                    if (size > 32000) { finish(unavailable('检查结果超过限制')); } else { output += chunk; }
                });
                child.stderr.on('data', () => { /* Native errors never echo code into model context. */ });
                child.on('close', code => {
                    try {
                        const r = JSON.parse(output) as TutorLocalCheck;
                        if (code !== 0 || r.schema !== 1 || r.sourceDigest !== sourceDigest || !['valid','incomplete'].includes(r.syntax)
                            || !Array.isArray(r.errorLines) || r.errorLines.length > 16 || r.errorLines.some(n => !Number.isInteger(n) || n < 1 || n > buffer.text.split('\n').length)
                            || !Array.isArray(r.findings) || r.findings.length !== rules.length || r.findings.some((f,i) => f.id !== rules[i].id || !['verified','needs-work','unknown'].includes(f.verdict)
                                || typeof f.note !== 'string' || f.note.length > 300 || f.line != null && (!Number.isInteger(f.line) || f.line < 1 || f.line > buffer.text.split('\n').length))) { throw new Error(); }
                        finish(r);
                    } catch { finish(unavailable('本地检查结果无效')); }
                });
                if (signal?.aborted) { abort(); return; }
                child.stdin.end(JSON.stringify({ source: buffer.text, rules }));
            });
        } finally { this.active--; }
    }
}
