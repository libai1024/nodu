// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { openBuildLocation } from './nodu-build-location';
import { dirname, isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { CallOutcome, EMBEDDED_METHODS, EmbeddedClient, EmbeddedMethod, NoduEmbeddedService } from '../common/nodu-embedded-protocol';
import { encodeMonitorText } from './nodu-monitor-encoding';
import { createSourceProject, parseProjectRequest } from './nodu-project-generator';
import { TutorRuntimeEvidence } from './tutor/tutor-runtime-evidence';
import { createDaxinProject } from './nodu-daxin-project';

const MAX_REQUEST = 1024 * 1024;
/** Node-side backstops; the sidecar enforces the real per-step limits. */
const TIMEOUTS: Partial<Record<EmbeddedMethod, number>> = {
    configure: 180_000, build: 660_000, identify: 40_000, reset: 40_000,
    flash: 900_000, restore: 900_000, checkToolkit: 400_000, createProject: 60_000,
};

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }

/**
 * One `nodu-embedded` sidecar per backend, started on first use so K210-only
 * sessions never start it (K3). The bundled vscode-clangd plugin owns the language server lifecycle.
 */
@injectable()
export class NoduEmbeddedServer implements NoduEmbeddedService, BackendApplicationContribution {
    readonly teachingEvidence = new TutorRuntimeEvidence();
    private sidecar?: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private readonly pending = new Map<number, Pending>();
    private readonly clients = new Set<EmbeddedClient>();

    addClient(client: EmbeddedClient): () => void {
        this.clients.add(client);
        return () => { this.clients.delete(client); };
    }

    private publish(event: string, data: unknown): void {
        this.teachingEvidence.event(event, data);
        for (const client of this.clients) {
            try { Promise.resolve(client.onEvent(event, data)).catch(() => this.clients.delete(client)); } catch { this.clients.delete(client); }
        }
    }

    private extensionDir(): string {
        return dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'));
    }

    private platformDir(): string {
        return process.platform === 'win32' ? `win32-${process.arch}` : process.platform;
    }

    private binary(): string {
        if (process.env.NODU_EMBEDDED_BIN) { return process.env.NODU_EMBEDDED_BIN; }
        const exe = process.platform === 'win32' ? 'nodu-embedded.exe' : 'nodu-embedded';
        const packaged = join(this.extensionDir(), 'resources', 'bin', `${process.platform}-${process.arch}`, exe);
        return existsSync(packaged) ? packaged : join(this.extensionDir(), '..', 'native', 'target', 'release', exe);
    }

    /** Env override → toolkit inside the installer → development `.tools` (TOOLKIT-DISTRIBUTION §4). */
    private toolkitRoot(): string {
        if (process.env.NODU_STM32_TOOLKIT) { return process.env.NODU_STM32_TOOLKIT; }
        const packaged = join(this.extensionDir(), 'resources', 'toolkits', 'stm32', this.platformDir());
        return existsSync(join(packaged, 'toolkit.json')) ? packaged : join(this.extensionDir(), '..', '.tools', 'stm32', this.platformDir());
    }

    private dataDir(): string {
        if (process.env.NODU_EMBEDDED_HOME) { return process.env.NODU_EMBEDDED_HOME; }
        return process.platform === 'win32' && process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Nodu') : join(homedir(), '.nodu');
    }

    private ensureSidecar(): ChildProcessWithoutNullStreams {
        if (this.sidecar) { return this.sidecar; }
        const child = spawn(this.binary(), ['--resources', join(this.extensionDir(), 'resources', 'stm32'),
            '--toolkit', this.toolkitRoot(), '--data-dir', this.dataDir()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.sidecar = child;
        const reader = createInterface({ input: child.stdout });
        reader.on('line', line => {
            let message: { id?: unknown; result?: unknown; error?: string; code?: string; detail?: unknown; event?: string; data?: unknown };
            try { message = JSON.parse(line); } catch { return; }
            if (typeof message.id === 'number') {
                const item = this.pending.get(message.id);
                if (!item) { return; }
                clearTimeout(item.timer); this.pending.delete(message.id);
                if (message.error !== undefined) {
                    // Keep the stable code and tool output for the diagnosis card.
                    item.reject(Object.assign(new Error(message.error), { code: message.code, detail: message.detail }));
                } else { item.resolve(message.result); }
            } else if (typeof message.event === 'string') {
                this.publish(message.event, message.data);
            }
        });
        child.stderr.on('data', data => this.publish('service.log', { text: String(data).slice(0, 8000) }));
        child.on('error', error => this.failSidecar(child, `STM32 服务启动失败：${error.message}。开发者请运行 npm run build:native。`));
        child.on('exit', code => { reader.close(); this.failSidecar(child, `STM32 服务已退出（${code}）。`); });
        return child;
    }

    private failSidecar(child: ChildProcessWithoutNullStreams, message: string): void {
        if (this.sidecar !== child) { return; }
        this.sidecar = undefined;
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(Object.assign(new Error(message), { code: 'service' })); }
        this.pending.clear();
        this.publish('service.state', { running: false, message });
    }

    private request(method: string, args: Record<string, unknown>, timeout = 30_000): Promise<unknown> {
        const child = this.ensureSidecar();
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(Object.assign(new Error(`STM32 服务没有在 ${Math.round(timeout / 1000)} 秒内完成 ${method}。`), { code: 'timeout' }));
            }, timeout);
            this.pending.set(id, { resolve, reject, timer });
            child.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => {
                if (error) { this.failSidecar(child, `STM32 服务写入失败：${error.message}`); }
            });
        });
    }

    async call(method: EmbeddedMethod, args: Record<string, unknown>): Promise<CallOutcome> {
        const refuse = (message: string): CallOutcome => ({ ok: false, error: { message, code: 'badRequest' } });
        if (!EMBEDDED_METHODS.includes(method)) { return refuse(`不支持的方法 ${String(method)}`); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) { return refuse('参数必须是对象。'); }
        if (JSON.stringify(args).length > MAX_REQUEST) { return refuse('请求太大。'); }
        for (const key of ['path', 'parent', 'destination']) {
            const value = args[key];
            if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))) { return refuse(`${key} 必须是绝对路径。`); }
        }
        try {
            if (method === 'openBuildLocation') {
                if (typeof args.path !== 'string') { return refuse('缺少工程路径。'); }
                return { ok: true, result: await openBuildLocation(args.path) };
            }
            if (method === 'createWorkspace') {
                const request = parseProjectRequest(args);
                if (request.template.startsWith('dacir-')) {
                    const project = await createDaxinProject(request, join(this.extensionDir(), 'resources/daxin'));
                    // Same trust policy as built-in projects. Failure leaves the complete
                    // project usable; its first build will use the existing trust prompt.
                    try { await this.request('trustProject', { path: project.path }); } catch { /* optional trust registration */ }
                    return { ok: true, result: project };
                }
                if (request.chip.pack) {
                    return { ok: true, result: await this.request('createProject', { parent: request.parent, name: request.name,
                        board: request.chip.pack, template: request.template === 'hello' ? 'uart-hello' : 'empty', method: 'stlink' }, TIMEOUTS.createProject) };
                }
                return { ok: true, result: await createSourceProject(request) };
            }
            if (method === 'writeMonitor' && args.text !== undefined) {
                args = { data: encodeMonitorText(args.text, args.encoding) };
            }
            const result = await this.request(method, args, TIMEOUTS[method]);
            this.teachingEvidence.result(method, args, result);
            return { ok: true, result };
        } catch (error) {
            const e = error as Error & { code?: string; detail?: unknown };
            return { ok: false, error: { message: e.message, code: e.code || 'service', detail: e.detail } };
        }
    }

    homeDirectory(): Promise<string> { return Promise.resolve(homedir()); }

    onStop(): void {
        const child = this.sidecar;
        this.sidecar = undefined;
        // Closing stdin makes the sidecar end its tool processes and release locks.
        child?.stdin.end();
        if (child) { setTimeout(() => child.kill(), 2000).unref(); }
    }
}
