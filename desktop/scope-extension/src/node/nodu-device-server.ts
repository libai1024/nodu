// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectOptions, DeviceBackup, DeviceClient, DeviceFileData, DeviceFrame, DeviceLog, DeviceState, FirmwarePlan, FirmwareResult, NoduDeviceService, RemoteFile, SerialPortInfo } from '../common/nodu-device-protocol';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const initialState = (): DeviceState => ({ phase: 'disconnected', busy: false, running: false, preview: false,
    capabilities: { repl: false, files: false, framebuffer: false, script: false, firmware: false } });
const MAX_BYTES = 2 * 1024 * 1024;

/** One worker and serial session per backend; the worker also locks the OS port across backends. */
@injectable()
export class NoduDeviceServer implements NoduDeviceService, BackendApplicationContribution {
    private worker?: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private state = initialState();
    private readonly clients = new Set<DeviceClient>();
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
    private idleTimer?: ReturnType<typeof setTimeout>;
    private backupDirectory?: string;
    private connectionEpoch = 0;
    private flashTask?: Promise<FirmwareResult>;

    addClient(client: DeviceClient): () => void {
        clearTimeout(this.idleTimer);
        this.clients.add(client);
        return () => {
            this.clients.delete(client);
            if (!this.clients.size) {
                this.scheduleIdleCleanup();
            }
        };
    }
    private scheduleIdleCleanup(): void {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            if (this.clients.size) { return; }
            // A refresh must never kill a writer simply because its RPC
            // client vanished. Keep the owner alive through verification.
            if (this.flashTask || this.state.operation === 'flashFirmware') { this.scheduleIdleCleanup(); return; }
            void this.disconnect().catch(() => {
                if (this.flashTask || this.state.operation === 'flashFirmware') { this.scheduleIdleCleanup(); }
                else { this.shutdown(); }
            });
        }, 5000);
    }
    private publish(method: keyof DeviceClient, value: DeviceState | DeviceLog | DeviceFrame): void {
        for (const client of this.clients) {
            try { Promise.resolve((client[method] as (arg: typeof value) => unknown)(value)).catch(() => this.clients.delete(client)); } catch { this.clients.delete(client); }
        }
    }
    private deviceBinary(): string {
        // 1. explicit override, 2. packaged sidecar, 3. dev build.
        if (process.env.NODU_DEVICE_BIN) { return process.env.NODU_DEVICE_BIN; }
        const extensionDir = dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'));
        const exe = process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device';
        const packaged = join(extensionDir, 'resources', 'bin', `${process.platform}-${process.arch}`, exe);
        if (existsSync(packaged)) { return packaged; }
        return join(extensionDir, '..', 'native', 'target', 'release', exe);
    }
    private ensureWorker(): ChildProcessWithoutNullStreams {
        if (this.worker) { return this.worker; }
        const mock = process.env.NODU_DEVICE_MOCK === '1';
        const worker = spawn(this.deviceBinary(), mock ? ['--mock'] : [], {
            stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
        });
        this.worker = worker;
        const reader = createInterface({ input: worker.stdout });
        reader.on('line', line => {
            if (line.length > MAX_BYTES * 2) { this.failWorker(new Error('设备返回的数据超过限制。')); return; }
            try {
                const message = JSON.parse(line);
                if (typeof message.id === 'number') {
                    const item = this.pending.get(message.id);
                    if (!item) { return; }
                    clearTimeout(item.timer); this.pending.delete(message.id);
                    if (message.error) { item.reject(new Error(String(message.error))); } else { item.resolve(message.result); }
                } else if (message.event === 'state') {
                    this.state = message.data; this.publish('onState', this.state);
                } else if (message.event === 'log') {
                    this.publish('onLog', message.data);
                } else if (message.event === 'frame') {
                    this.publish('onFrame', message.data);
                }
            } catch (error) {
                this.publish('onLog', { text: `设备服务响应无法解析：${String(error)}`, stream: 'system', time: Date.now() });
            }
        });
        worker.stderr.on('data', data => this.publish('onLog', { text: String(data).slice(0, 8000), stream: 'stderr', time: Date.now() }));
        worker.on('error', error => this.failWorker(new Error(`设备服务启动失败：${error.message}。开发者请运行 npm run build:native。`), worker));
        worker.on('exit', (code, signal) => {
            reader.close();
            if (this.worker === worker) { this.failWorker(new Error(`设备服务已退出（${signal || code}）。开发者请运行 npm run build:native 重新构建设备服务。`), worker); }
        });
        return worker;
    }
    private failWorker(error: Error, source?: ChildProcessWithoutNullStreams): void {
        if (source && this.worker !== source) { return; }
        this.connectionEpoch++;
        const worker = this.worker; this.worker = undefined;
        worker?.kill();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
        this.pending.clear();
        this.state = { ...initialState(), phase: 'error', lastError: error.message };
        this.publish('onState', this.state);
    }
    private request<T>(method: string, args: object = {}, timeout = 45000): Promise<T> {
        if (this.flashTask) { return Promise.reject(new Error('固件正在写入或验证，请保持连接并等待完成。')); }
        if (this.pending.size && method !== 'stop' && method !== 'disconnect') {
            return Promise.reject(new Error('设备正在处理其他操作；请稍候，或停止 / 取消当前操作。'));
        }
        const worker = this.ensureWorker();
        const id = ++this.sequence;
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id); reject(new Error(`设备操作超时：${method}。连接已释放，请重新连接。`));
                this.failWorker(new Error(`设备操作超时：${method}；会话已释放。`));
            }, timeout);
            this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
            worker.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => {
                if (error) { this.failWorker(new Error(`设备服务写入失败：${error.message}`), worker); }
            });
        });
    }
    private validatePath(path: string, writing = false): void {
        if (typeof path !== 'string' || path.length > 512 || !/^\/(flash|sd)(\/|$)/.test(path) || /[\x00-\x1f]/.test(path) || path.split('/').includes('..')) {
            throw new Error('请选择 /flash 或 /sd 内的有效设备路径。');
        }
        if (writing && /\/(boot|main)\.py$/i.test(path)) { throw new Error('此阶段保护 boot.py 和 main.py；请另存为独立脚本。'); }
    }
    private validateCode(code: string): void {
        if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code, 'utf8') > 256 * 1024 || code.includes('\0')) { throw new Error('脚本须为非空文本，大小不超过 256 KiB。'); }
    }
    getState(): Promise<DeviceState> { return Promise.resolve(this.state); }
    listPorts(): Promise<SerialPortInfo[]> { return this.request('listPorts'); }
    async connect(options: ConnectOptions): Promise<DeviceState> {
        if (!options || typeof options.port !== 'string' || !options.port.trim() || options.port.length > 512 || /[\x00-\x1f]/.test(options.port)) { return Promise.reject(new Error('请选择有效串口。')); }
        if (!['embedfire-cam-gc2145', 'generic-k210'].includes(options.boardProfile) || (options.baud && options.baud !== 115200)) { return Promise.reject(new Error('请选择受支持的 K210 板型，REPL 波特率为 115200。')); }
        const epoch = ++this.connectionEpoch;
        const ports = await this.listPorts();
        if (epoch !== this.connectionEpoch) { throw new Error('连接已取消。'); }
        if (!ports.some(port => port.path === options.port)) { throw new Error('所选串口已不在设备列表，请刷新后重试。'); }
        return this.request('connect', options, 60000);
    }
    async disconnect(): Promise<void> {
        if (this.flashTask) { throw new Error('固件正在写入或验证，请保持连接并等待完成。'); }
        this.connectionEpoch++;
        if (this.worker) { await this.request('disconnect', {}, 45000); }
    }
    execute(code: string): Promise<string> { this.validateCode(code); return this.request('execute', { code }, 180000); }
    runScript(code: string): Promise<void> { this.validateCode(code); return this.request('runScript', { code }, 180000); }
    stop(): Promise<void> { this.connectionEpoch++; return this.request('stop', {}, 45000); }
    listFiles(path: string): Promise<RemoteFile[]> { this.validatePath(path); return this.request('listFiles', { path }); }
    readFile(path: string): Promise<DeviceFileData> { this.validatePath(path); return this.request('readFile', { path }, 910000); }
    writeFile(path: string, data: string, overwrite: boolean): Promise<void> {
        this.validatePath(path, true);
        if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, 'base64').length > MAX_BYTES) { throw new Error('上传文件须为有效数据且不超过 2 MiB。'); }
        return this.request('writeFile', { path, data, overwrite: overwrite === true }, 910000);
    }
    setPreview(enabled: boolean): Promise<void> { return this.request('setPreview', { enabled: enabled === true }); }
    startCamera(): Promise<void> { return this.request('startCamera', {}, 60000); }
    prepareFirmware(): Promise<FirmwarePlan> {
        const sourceFile = '/opt/homebrew/share/maixpy-k210/firmware/maixpy_v0.6.3_2_gd8901fd22.bin';
        return this.request('prepareFirmware', { cacheDir: join(homedir(), '.nodu', 'firmware'),
            ...(existsSync(sourceFile) ? { sourceFile } : {}) }, 180000);
    }
    async backupDevice(): Promise<DeviceBackup> {
        const directory = join(homedir(), '.nodu', 'backups', new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8));
        const backup = await this.request<DeviceBackup>('backupDevice', { backupDir: directory }, 3600000);
        if (!backup.verified || !backup.flashCapacityVerified) { throw new Error('设备备份或实际 Flash 容量未通过校验，不能烧写。'); }
        this.backupDirectory = backup.directory;
        return backup;
    }
    flashFirmware(confirmedBackupDirectory: string): Promise<FirmwareResult> {
        if (this.flashTask) { return Promise.reject(new Error('固件烧写与验证正在进行，请保持连接。')); }
        if (!this.backupDirectory) { return Promise.reject(new Error('请先完成当前设备的备份与校验。')); }
        if (confirmedBackupDirectory !== this.backupDirectory) { return Promise.reject(new Error('当前备份已变更，请重新读取并确认当前设备的备份。')); }
        const task = this.request<FirmwareResult>('flashFirmware', { backupDir: this.backupDirectory }, 900000);
        this.flashTask = task;
        void task.finally(() => { this.flashTask = undefined; }).catch(() => undefined);
        return task;
    }
    async onStop(): Promise<void> {
        if (this.flashTask) { await this.flashTask.catch(() => undefined); }
        try { await this.disconnect(); } catch { /* An unavailable worker still needs releasing. */ }
        finally { this.shutdown(); }
    }
    private shutdown(): void {
        this.connectionEpoch++;
        clearTimeout(this.idleTimer);
        const worker = this.worker; this.worker = undefined;
        worker?.stdin.end();
        worker?.kill();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('设备服务已关闭。')); }
        this.pending.clear(); this.state = initialState();
    }
}
