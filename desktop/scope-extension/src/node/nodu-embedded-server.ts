// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { openBuildLocation } from './nodu-build-location';
import { dirname, isAbsolute, join } from 'path';
import { createInterface } from 'readline';
import { createRequire } from 'module';
import { randomUUID } from 'crypto';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { CallOutcome, EMBEDDED_METHODS, EmbeddedClient, EmbeddedMethod, NoduEmbeddedService, PortInfo } from '../common/nodu-embedded-protocol';
import { encodeMonitorText } from './nodu-monitor-encoding';
import { createSourceProject, parseProjectRequest } from './nodu-project-generator';
import { TutorRuntimeEvidence } from './tutor/tutor-runtime-evidence';
import { createDaxinProject } from './nodu-daxin-project';
import { generateKeil, keilStatus, openKeil } from './nodu-keil-project';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { supportsKeil } from '../common/nodu-keil';

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
    private readonly keilJobs = new Set<string>();
    private readonly pending = new Map<number, Pending>();
    private readonly clients = new Set<EmbeddedClient>();
    private arduinoLease?: { token: string; port: string; restore: boolean; lost: boolean; onLost?: () => void };

    addClient(client: EmbeddedClient): () => void {
        this.clients.add(client);
        return () => { this.clients.delete(client); };
    }

    private publish(event: string, data: unknown): void {
        // Readiness can follow flash.started when the first request is a flash.
        // Only losing the service invalidates its current execution evidence.
        if (event !== 'service.state' || (data as { running?: boolean } | undefined)?.running !== true) {
            this.teachingEvidence.event(event, data);
        }
        for (const client of this.clients) {
            try { Promise.resolve(client.onEvent(event, data)).catch(() => this.clients.delete(client)); } catch { this.clients.delete(client); }
        }
    }

    private extensionDir(): string {
        const candidates = [join(__dirname, '../..'), join(__dirname, '../../../scope-extension'), join(__dirname, '../../scope-extension'),
            dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'))];
        return candidates.find(path => existsSync(join(path, 'resources/stm32')) && existsSync(join(path, 'resources/bin'))) ?? candidates[candidates.length - 1];
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
        let ready = false;
        const reader = createInterface({ input: child.stdout });
        reader.on('line', line => {
            // A failed process can still drain stdout after its replacement starts.
            if (this.sidecar !== child) { return; }
            let message: { id?: unknown; result?: unknown; error?: unknown; code?: string; detail?: unknown; event?: string; data?: unknown };
            try { message = JSON.parse(line); } catch { return; }
            if (!message || typeof message !== 'object' || Array.isArray(message)) { return; }
            if (typeof message.id === 'number') {
                const item = this.pending.get(message.id);
                if (!item) { return; }
                const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
                const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
                if (hasResult === hasError || (hasError && typeof message.error !== 'string')) { return; }
                clearTimeout(item.timer); this.pending.delete(message.id);
                // A correlated business refusal also proves that the RPC service is
                // alive. Spawn/logs/unsolicited events alone do not prove readiness.
                if (!ready) { ready = true; this.publish('service.state', { running: true }); }
                if (typeof message.error === 'string') {
                    // Keep the stable code and tool output for the diagnosis card.
                    item.reject(Object.assign(new Error(message.error), { code: message.code, detail: message.detail }));
                } else { item.resolve(message.result); }
            } else if (typeof message.event === 'string' && message.event !== 'service.state') {
                // Lifecycle state belongs to this adapter, not unsolicited output.
                this.publish(message.event, message.data);
            }
        });
        child.stderr.on('data', data => {
            if (this.sidecar === child) { this.publish('service.log', { text: String(data).slice(0, 8000) }); }
        });
        child.on('error', error => this.failSidecar(child, `STM32 服务启动失败：${error.message}。开发者请运行 npm run build:native。`));
        child.on('exit', code => { reader.close(); this.failSidecar(child, `STM32 服务已退出（${code}）。`); });
        return child;
    }

    private failSidecar(child: ChildProcessWithoutNullStreams, message: string): void {
        if (this.sidecar !== child) { return; }
        this.sidecar = undefined;
        if (this.arduinoLease) { this.arduinoLease.lost = true; this.arduinoLease.restore = false; this.arduinoLease.onLost?.(); }
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
        if (this.arduinoLease && ['openMonitor', 'closeMonitor', 'writeMonitor'].includes(method)) {
            if (method === 'closeMonitor') { this.arduinoLease.restore = false; }
            return { ok: false, error: { code: 'portBusy', message: '串口正在用于 Arduino 上传。' } };
        }
        for (const key of ['path', 'parent', 'destination']) {
            const value = args[key];
            if (value !== undefined && (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0'))) { return refuse(`${key} 必须是绝对路径。`); }
        }
        try {
            if (method === 'keilStatus' || method === 'generateKeil' || method === 'openKeil') {
                if (typeof args.path !== 'string') { return refuse('缺少工程路径。'); }
                const project = await this.request('openProject', { path: args.path }) as ProjectStatus;
                if (method === 'keilStatus') return { ok: true, result: await keilStatus(project) };
                if (method === 'openKeil') return { ok: true, result: await openKeil(project) };
                if (!supportsKeil(project)) throw Object.assign(new Error('目前支持 Nodu 原生 STM32F103C8T6 工程。'), { code: 'keilUnsupported' });
                if (this.keilJobs.has(project.path)) throw Object.assign(new Error('Keil 工程正在更新。'), { code: 'keilBusy' });
                this.keilJobs.add(project.path);
                try {
                    if (!project.trusted) throw Object.assign(new Error('请先信任当前工程，再生成 Keil 配置。'), { code: 'untrusted' });
                    const configured = await this.request('configure', { path: project.path, force: true }, TIMEOUTS.configure) as { ok: boolean; compileCommands: string };
                    if (!configured.ok) throw Object.assign(new Error('工程配置未通过，请先修复 Nodu 构建配置。'), { code: 'keilConfiguration' });
                    return { ok: true, result: await generateKeil(project, configured.compileCommands, join(this.extensionDir(), 'resources/stm32')) };
                } finally { this.keilJobs.delete(project.path); }
            }
            if (method === 'openMonitor' && args.arduino === true) {
                const ports = await this.request('listPorts', {}) as PortInfo[];
                const port = ports.find(item => item.path === args.port);
                // Native Espressif CDC needs DTR for Arduino's while (!Serial) readiness.
                args = { port: args.port, baud: args.baud, arduinoCdc: port?.vid === 0x303a };
            }
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
            if (method === 'writeMonitor' && typeof args.data === 'string') {
                return { ok: true, result: { ...(result as { sent: number }), data: args.data } };
            }
            return { ok: true, result };
        } catch (error) {
            const e = error as Error & { code?: string; detail?: unknown };
            return { ok: false, error: { message: e.message, code: e.code || 'service', detail: e.detail } };
        }
    }

    homeDirectory(): Promise<string> { return Promise.resolve(homedir()); }

    /** Only the Node Arduino service can borrow a port; the methods are absent from the public RPC facade. */
    async acquireArduinoPort(port: string): Promise<{ release(restore: boolean, canRestore?: () => boolean): Promise<{ restored: boolean; port?: string }>; onLost(callback: () => void): void }> {
        if (this.arduinoLease) { throw new Error('另一个 Arduino 上传正在使用串口。'); }
        const lease: NonNullable<NoduEmbeddedServer['arduinoLease']> = { token: randomUUID(), port, restore: true, lost: false }; this.arduinoLease = lease;
        let status: { wasOpen: boolean; baud: number };
        let identity: PortInfo | undefined;
        try {
            const ports = await this.request('listPorts', {}) as PortInfo[];
            identity = ports.find(item => item.path === port);
            if (!identity) { throw new Error('所选串口已断开，请重新选择。'); }
            status = await this.request('acquireExternalPort', { port, token: lease.token }) as typeof status;
        } catch (error) {
            await this.request('releaseExternalPort', { token: lease.token, restore: false }).catch(() => undefined);
            this.arduinoLease = undefined; throw error;
        }
        let released = false;
        return { onLost: callback => { lease.onLost = callback; if (lease.lost) { callback(); } }, release: async (restore: boolean, canRestore = () => true) => {
            if (released) { return { restored: false }; } released = true;
            let target: string | undefined;
            const allowed = (): boolean => restore && lease.restore && !lease.lost && canRestore();
            try {
                if (allowed() && status.wasOpen && identity?.serial_number) {
                    const deadline = Date.now() + 8000;
                    do {
                        const ports = await this.request('listPorts', {}) as PortInfo[];
                        const matches = ports.filter(item => item.serial_number === identity!.serial_number && item.vid === identity!.vid);
                        if (matches.length === 1) { target = matches[0].path; break; }
                        if (matches.length > 1) { break; }
                        await new Promise(resolve => setTimeout(resolve, 250));
                    } while (Date.now() < deadline && allowed());
                }
                await this.request('releaseExternalPort', { token: lease.token, restore: !!target && allowed(), port: target });
                if (target && !allowed()) { await this.request('closeMonitor', {}); }
                return { restored: !!target && allowed(), port: target };
            } finally {
                // Also drop a reservation after failed discovery or a disappearing device.
                await this.request('releaseExternalPort', { token: lease.token, restore: false }).catch(() => undefined);
                if (this.arduinoLease === lease) { this.arduinoLease = undefined; }
            }
        } };
    }

    onStop(): void {
        const child = this.sidecar;
        this.sidecar = undefined;
        // Closing stdin makes the sidecar end its tool processes and release locks.
        child?.stdin.end();
        if (child) { setTimeout(() => child.kill(), 2000).unref(); }
    }
}
