// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TutorPureExecution, TutorPureUnit } from '../../common/tutor/tutor-local-check';

const types = `typedef unsigned char uint8_t;
typedef unsigned short uint16_t;
typedef struct { uint16_t temperature; uint16_t humidity; } sht30_raw_t;
typedef struct { float celsius; float percent_rh; } sht30_reading_t;`;
const crcHarness = `
static uint8_t expected_crc(const uint8_t *p, uint8_t n) {
    unsigned x=255;
    for(unsigned i=0;i<n;i++) { x^=p[i]; for(unsigned k=0;k<8;k++) x=((x&128)?(x*2)^49:x*2)&255; }
    return (uint8_t)x;
}
static int crc_checks(void) {
    int passed=0; uint8_t p[16];
    for(unsigned seed=0;seed<32;seed++) {
        for(unsigned i=0;i<16;i++) p[i]=(uint8_t)(seed*37+i*61);
        const uint8_t lengths[6]={0,1,2,4,8,16};
        for(unsigned i=0;i<6;i++) if(sht30_crc8(p,lengths[i])==expected_crc(p,lengths[i])) passed++;
    }
    const uint8_t known[2]={0xbe,0xef}; if(sht30_crc8(known,2)==0x92) passed++;
    return passed;
}`;
const convertHarness = `
static int near(float a, float b) { float d=a-b; return d<0.02f && d> -0.02f; }
static int convert_checks(void) {
    int passed=0;
    sht30_reading_t a=sht30_convert((sht30_raw_t){0,0});
    if(near(a.celsius,-45) && near(a.percent_rh,0)) passed++;
    a=sht30_convert((sht30_raw_t){65535,65535});
    if(near(a.celsius,130) && near(a.percent_rh,100)) passed++;
    a=sht30_convert((sht30_raw_t){32768,32768});
    if(near(a.celsius,42.501335f) && near(a.percent_rh,50.000763f)) passed++;
    return passed;
}`;
export function pureHarness(unit: TutorPureUnit): { source: string; total: number } {
    if (!unit || typeof unit.source !== 'string' || unit.source.length > 32000 || !Array.isArray(unit.functions)
        || !unit.functions.length || unit.functions.length > 2 || new Set(unit.functions).size !== unit.functions.length
        || unit.functions.some(n => !['sht30_crc8','sht30_convert'].includes(n))) { throw new Error('测试片段无效'); }
    // Defense in depth after native AST extraction. No include/embed/asm/attributes,
    // line continuations, digraphs or compiler builtins can reach the host compiler.
    const code = unit.source.replace(/^#define (SHT30_CRC_POLY|SHT30_CRC_INIT|SHT30_RAW_FULL_SCALE) [0-9a-fA-FxXuUlL.fF]+\n/gm, '');
    if (/[#\\\0]/.test(code) || code.includes('%:') || code.includes('??') || /\b(?:__\w*|asm|run_tests|expected_crc|crc_checks|convert_checks)\b/.test(code)) { throw new Error('此片段超出纯函数测试范围'); }
    const crc = unit.functions.includes('sht30_crc8'), convert = unit.functions.includes('sht30_convert');
    return { source: `${types}\n${unit.source}\n${crc ? crcHarness : ''}\n${convert ? convertHarness : ''}\nint run_tests(void){return ${crc ? 'crc_checks()' : '0'}+${convert ? 'convert_checks()' : '0'};}\n`, total: (crc ? 193 : 0) + (convert ? 3 : 0) };
}

/** Reject every import; no WASI/host functions, filesystem, networking or clock. */
export function verifyNoImports(wasm: Buffer): boolean {
    if (wasm.length > 256000 || !wasm.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) { return false; }
    let offset = 8;
    while (offset < wasm.length) {
        const id = wasm[offset++]; let size = 0, shift = 0, byte = 0;
        do { if (offset >= wasm.length || shift > 28) { return false; } byte = wasm[offset++]; size += (byte & 127) * 2 ** shift; shift += 7; } while (byte & 128);
        if (size > wasm.length - offset || id === 2) { return false; }
        offset += size;
    }
    return offset === wasm.length;
}
interface ProcessResult { code: number | null; output: string; reason?: string; }
export class TutorPureRunner {
    private static active = 0;
    constructor(private readonly root = process.env.NODU_TUTOR_WASI_DIR ?? join(dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json')), 'resources/wasi', `${process.platform}-${process.arch}`)) { }
    private run(executable: string, args: string[], cwd: string, signal?: AbortSignal): Promise<ProcessResult> {
        return new Promise(resolve => {
            let output = '', size = 0, reason: string | undefined, done = false;
            const child = spawn(executable, args, { cwd, detached: process.platform !== 'win32', windowsHide: true,
                env: { PATH: join(this.root, 'sdk/bin'), SystemRoot: process.env.SystemRoot, TMPDIR: cwd, TEMP: cwd, HOME: cwd }, stdio: ['ignore','pipe','pipe'] });
            const kill = (): void => { try { if (process.platform !== 'win32' && child.pid) { process.kill(-child.pid, 'SIGKILL'); } else { child.kill('SIGKILL'); } } catch { /* already exited */ } };
            const stop = (why: string): void => { reason ??= why; kill(); };
            const abort = (): void => stop('测试已取消');
            const timer = setTimeout(() => stop('测试超过时间限制'), 5000);
            const finish = (code: number | null): void => { if (done) { return; } done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); resolve({ code, output, reason }); };
            signal?.addEventListener('abort', abort, { once: true });
            for (const stream of [child.stdout, child.stderr]) { stream.on('data', (data: Buffer) => { size += data.length; if (size > 16000) { stop('测试输出超过限制'); } else { output += data.toString('utf8'); } }); }
            child.once('error', () => { reason = '测试工具不可用'; finish(null); });
            child.once('close', code => finish(code));
            if (signal?.aborted) { abort(); }
        });
    }
    async inspect(unit: TutorPureUnit, sourceDigest: string, signal?: AbortSignal): Promise<TutorPureExecution> {
        const result: TutorPureExecution = { suite: 'sht30-pure-v1', sourceDigest, status: 'unavailable', passed: 0, total: 0, note: '' };
        if (process.platform === 'win32') { return { ...result, note: '当前平台的纯函数进程隔离尚未启用' }; }
        if (signal?.aborted) { return { ...result, status: 'cancelled', note: '测试已取消' }; }
        if (TutorPureRunner.active >= 2) { return { ...result, note: '纯函数测试正在进行' }; }
        let directory: string | undefined;
        TutorPureRunner.active++;
        try {
            const harness = pureHarness(unit); result.total = harness.total;
            const clang = join(this.root, 'sdk/bin', 'clang'), runtime = join(this.root, 'runtime', 'wasmtime');
            await Promise.all([fs.access(clang), fs.access(runtime)]);
            directory = await fs.mkdtemp(join(tmpdir(), 'nodu-pure-')); await fs.chmod(directory, 0o700);
            const versions = await Promise.all([this.run(clang, ['--version'], directory, signal), this.run(runtime, ['--version'], directory, signal)]);
            if (versions.some(v => v.reason || v.code !== 0) || !versions[0].output.includes('clang version 23.1.0') || !/^wasmtime 50\.0\.0\b/.test(versions[1].output)) { throw new Error('纯函数工具版本不匹配'); }
            await fs.writeFile(join(directory, 'test.c'), harness.source, { mode: 0o600 });
            const compile = await this.run(clang, ['--target=wasm32-wasip1','-O0','-nostdlib','-nostdinc','-fno-builtin','-fno-stack-protector','-Werror','-Wl,--no-entry','-Wl,--export=run_tests','-Wl,--initial-memory=131072','-Wl,--max-memory=16777216','test.c','-o','test.wasm'], directory, signal);
            if (compile.reason) { throw new Error(compile.reason); }
            if (compile.code !== 0) { result.note = '纯函数无法独立编译，检查函数签名、常量或外部依赖'; return result; }
            if ((await fs.stat(join(directory, 'test.wasm'))).size > 256000) { throw new Error('测试模块超过限制'); }
            const wasm = await fs.readFile(join(directory, 'test.wasm'));
            if (!verifyNoImports(wasm)) { throw new Error('测试模块包含外部能力或超过限制'); }
            const run = await this.run(runtime, ['run','-W','fuel=2000000','-W','max-memory-size=16777216','--invoke','run_tests','test.wasm'], directory, signal);
            if (run.reason) { throw new Error(run.reason); }
            // The pinned CLI prints an invocation warning to stderr; only its one integer stdout result is accepted.
            const counts = run.output.split(/\r?\n/).filter(line => /^\d+$/.test(line));
            if (run.code !== 0) { return { ...result, status: 'failed', note: '纯函数执行失败或超过运行预算' }; }
            if (counts.length !== 1 || Number(counts[0]) > result.total) { throw new Error('纯函数测试结果无效'); }
            result.passed = Number(counts[0]); result.status = result.passed === result.total ? 'passed' : 'failed';
            result.note = `纯函数测试 ${result.passed}/${result.total}，不代表固件或传感器运行`;
            return result;
        } catch (error) {
            result.status = signal?.aborted ? 'cancelled' : 'unavailable';
            result.note = signal?.aborted ? '测试已取消' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? '纯函数测试工具尚未安装' : error instanceof Error ? error.message : '纯函数测试不可用';
            return result;
        } finally { TutorPureRunner.active--; if (directory) { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); } }
    }
}
