// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { CallOutcome, EMBEDDED_METHODS, EmbeddedClient, EmbeddedMethod, NoduEmbeddedService } from '../common/nodu-embedded-protocol';

const MAX_REQUEST = 1024 * 1024;
const MAX_LSP_MESSAGE = 8 * 1024 * 1024;
/** Node-side backstops; the sidecar enforces the real per-step limits. */
const TIMEOUTS: Partial<Record<EmbeddedMethod, number>> = {
    configure: 180_000, build: 660_000, identify: 40_000, reset: 40_000,
    flash: 900_000, restore: 900_000, checkToolkit: 400_000, createProject: 60_000,
};

interface Pending { resolve(value: unknown): void; reject(error: Error): void; timer?: ReturnType<typeof setTimeout> }

/**
 * One `nodu-embedded` sidecar per backend, started on first use so K210-only
 * sessions never start it (K3). Also runs clangd for the open C project and
 * relays LSP messages; clangd only reads the compilation database (§6.2).
 */
@injectable()
export class NoduEmbeddedServer implements NoduEmbeddedService, BackendApplicationContribution {
    private sidecar?: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private readonly pending = new Map<number, Pending>();
    private readonly clients = new Set<EmbeddedClient>();
    private readonly clientMonitors = new Map<EmbeddedClient, { owner: string; session: string }>();
    private clangd?: ChildProcessWithoutNullStreams;
    private lspBuffer = Buffer.alloc(0);

    addClient(client: EmbeddedClient): () => void {
        this.clients.add(client);
        return () => this.removeClient(client);
    }

    private removeClient(client: EmbeddedClient): void {
        this.clients.delete(client);
        const monitor = this.clientMonitors.get(client);
        this.clientMonitors.delete(client);
        // Release only this connection's session; another window may already own a newer one.
        if (monitor) { void this.call('closeMonitor', monitor).catch(() => undefined); }
    }

    async callForClient(client: EmbeddedClient, method: EmbeddedMethod, args: Record<string, unknown>): Promise<CallOutcome> {
        const result = await this.call(method, args);
        if (method === 'openMonitor' && result.ok) {
            const state = result.result as { open?: boolean; owner?: string; session?: string };
            if (state.open && typeof state.owner === 'string' && typeof state.session === 'string') {
                const monitor = { owner: state.owner, session: state.session };
                if (this.clients.has(client)) { this.clientMonitors.set(client, monitor); }
                else { await this.call('closeMonitor', monitor).catch(() => undefined); }
            }
        } else if (method === 'closeMonitor' && result.ok && this.clientMonitors.get(client)?.session === args.session) {
            this.clientMonitors.delete(client);
        }
        return result;
    }

    private publish(event: string, data: unknown): void {
        for (const client of this.clients) {
            try { Promise.resolve(client.onEvent(event, data)).catch(() => this.removeClient(client)); } catch { this.removeClient(client); }
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
        for (const key of ['path', 'parent']) {
            const value = args[key];
            if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))) { return refuse(`${key} 必须是绝对路径。`); }
        }
        try {
            return { ok: true, result: await this.request(method, args, TIMEOUTS[method]) };
        } catch (error) {
            const e = error as Error & { code?: string; detail?: unknown };
            return { ok: false, error: { message: e.message, code: e.code || 'service', detail: e.detail } };
        }
    }

    homeDirectory(): Promise<string> { return Promise.resolve(homedir()); }

    async clangdStart(projectPath: string): Promise<{ sdk: string }> {
        if (typeof projectPath !== 'string' || !isAbsolute(projectPath)) { throw new Error('工程路径无效。'); }
        await this.clangdStop();
        const spec = await this.request('clangd', { path: projectPath }) as { command: string; args: string[]; cwd: string; env: Record<string, string>; sdk: string };
        const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.clangd = child;
        this.lspBuffer = Buffer.alloc(0);
        child.stdout.on('data', (chunk: Buffer) => this.readLsp(child, chunk));
        child.stderr.on('data', () => undefined);
        child.on('error', error => this.publish('clangd.state', { running: false, message: `clangd 启动失败：${error.message}` }));
        child.on('exit', code => { if (this.clangd === child) { this.clangd = undefined; this.publish('clangd.state', { running: false, message: `clangd 已退出（${code}）` }); } });
        this.publish('clangd.state', { running: true });
        return { sdk: spec.sdk };
    }

    /** `Content-Length` framing → one JSON string per message for the frontend. */
    private readLsp(child: ChildProcessWithoutNullStreams, chunk: Buffer): void {
        if (this.clangd !== child) { return; }
        this.lspBuffer = Buffer.concat([this.lspBuffer, chunk]);
        for (;;) {
            const headerEnd = this.lspBuffer.indexOf('\r\n\r\n');
            if (headerEnd < 0) { return; }
            const match = /Content-Length: (\d+)/i.exec(this.lspBuffer.subarray(0, headerEnd).toString('ascii'));
            const length = match ? Number(match[1]) : -1;
            if (length < 0 || length > MAX_LSP_MESSAGE) { child.kill(); return; }
            if (this.lspBuffer.length < headerEnd + 4 + length) { return; }
            const body = this.lspBuffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString('utf8');
            this.lspBuffer = this.lspBuffer.subarray(headerEnd + 4 + length);
            for (const client of this.clients) {
                try { Promise.resolve(client.onClangd(body)).catch(() => undefined); } catch { /* closed client */ }
            }
        }
    }

    async clangdSend(message: string): Promise<void> {
        if (typeof message !== 'string' || message.length > MAX_LSP_MESSAGE || !this.clangd) { return; }
        const body = Buffer.from(message, 'utf8');
        this.clangd.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]));
    }

    async clangdStop(): Promise<void> {
        const child = this.clangd;
        this.clangd = undefined;
        if (child) { child.stdin.end(); setTimeout(() => child.kill(), 500); }
    }

    onStop(): void {
        void this.clangdStop();
        const child = this.sidecar;
        this.sidecar = undefined;
        // Closing stdin makes the sidecar end its tool processes and release locks.
        child?.stdin.end();
        if (child) { setTimeout(() => child.kill(), 2000).unref(); }
    }
}
