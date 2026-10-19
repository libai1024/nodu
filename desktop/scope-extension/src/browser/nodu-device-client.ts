// SPDX-License-Identifier: MIT
import { Emitter } from '@theia/core/lib/common/event';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ConnectOptions, DeviceBackup, DeviceClient, DeviceFrame, DeviceLog, DeviceState, FirmwarePlan, FirmwareResult, NODU_DEVICE_PATH, NoduDeviceService, RemoteFile, SerialPortInfo } from '../common/nodu-device-protocol';

export const NODU_FILE_LIMIT = 2 * 1024 * 1024;

/** One RPC session is shared by the toolbar, both layouts and all device views. */
@injectable()
export class NoduDeviceModel implements DeviceClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    private readonly changed = new Emitter<void>();
    private readonly logged = new Emitter<DeviceLog>();
    readonly onDidChange = this.changed.event;
    readonly onDidLog = this.logged.event;
    private service!: RpcProxy<NoduDeviceService>;
    private readonly toDispose = new DisposableCollection();
    state: DeviceState = {
        phase: 'disconnected', busy: false, running: false, preview: false,
        capabilities: { repl: false, files: false, framebuffer: false, script: false, firmware: false }
    };
    ports: SerialPortInfo[] = [];
    entries: RemoteFile[] = [];
    directory = '/flash';
    selectedPort = '';
    boardProfile: ConnectOptions['boardProfile'] = 'embedfire-cam-gc2145';
    frame: DeviceFrame | undefined;
    logs: DeviceLog[] = [];
    error = '';
    // Operation label that produced `error`; '' = backend/device-level fault.
    errorOperation = '';
    pending = '';
    plan: FirmwarePlan | undefined;
    backup: DeviceBackup | undefined;
    flashResult: FirmwareResult | undefined;
    private backupPort = '';
    private backupProfile = '';
    private backupCurrent = false;
    private disposed = false;
    private opening: Promise<void> | undefined;
    private pendingCount = 0;

    @postConstruct()
    protected initialize(): void {
        this.service = this.connections.createProxy<NoduDeviceService>(NODU_DEVICE_PATH, this);
        this.toDispose.push(this.service.onDidOpenConnection(() => { void this.init(); }));
        this.toDispose.push(this.service.onDidCloseConnection(() => {
            if (this.disposed) { return; }
            this.state = { ...this.state, phase: 'error', running: false, busy: false, preview: false };
            this.frame = undefined;
            this.entries = [];
            this.fail('设备服务连接', new Error('连接已中断，正在等待服务重新连接。'));
        }));
        void this.init();
    }

    get connected(): boolean { return this.state.phase === 'connected' || this.state.phase === 'running'; }
    get busy(): boolean { return this.state.busy || this.pendingCount > 0; }
    get flashing(): boolean { return this.pending === '烧写固件' || this.state.operation === 'flashFirmware'; }
    get canStop(): boolean { return !this.flashing && (this.connected || this.busy || (this.state.phase === 'error' && !!this.state.port)); }
    get verifiedBackup(): boolean { return !!this.backup?.verified && this.backup.flashCapacityVerified && !!this.plan && this.backup.flashBytes >= this.plan.sectorEnd && this.backupCurrent && this.backupPort === this.state.port && this.backupProfile === this.boardProfile; }
    get canFlash(): boolean { return !!this.plan?.ready && this.verifiedBackup && this.connected && !this.busy && !this.state.running; }
    get statusLabel(): string {
        if (this.pending || this.state.busy) { return this.pending || this.state.operation || '设备忙'; }
        return { disconnected: '未连接', connecting: '连接中', connected: '已连接', running: '脚本运行中', error: '连接异常' }[this.state.phase];
    }

    init(): Promise<void> {
        return this.opening ??= this.service.getState().then(state => this.onState(state)).catch(error => {
            this.fail('读取设备状态', error);
        }).finally(() => { this.opening = undefined; });
    }

    onState(state: DeviceState): void {
        if (this.disposed) { return; }
        this.state = state;
        if (!this.connected) { this.frame = undefined; this.entries = []; }
        if (state.port) { this.selectedPort = state.port; }
        if (state.boardProfile === 'embedfire-cam-gc2145' || state.boardProfile === 'generic-k210') { this.boardProfile = state.boardProfile; }
        // The worker also mirrors a failed operation's message into lastError;
        // when it repeats the error just recorded by fail(), keep its operation label.
        if (state.lastError && !this.error.endsWith(state.lastError)) { this.error = state.lastError; this.errorOperation = ''; }
        this.changed.fire();
    }

    onLog(log: DeviceLog): void {
        if (this.disposed) { return; }
        const text = log.text.slice(-32000);
        const bounded = { ...log, text: log.stream === 'system' && !text.endsWith('\n') ? `${text}\n` : text };
        this.logs.push(bounded);
        let length = this.logs.reduce((sum, item) => sum + item.text.length, 0);
        while (this.logs.length > 300 || length > 200000) { length -= this.logs.shift()!.text.length; }
        this.logged.fire(bounded);
        this.changed.fire();
    }

    onFrame(frame: DeviceFrame): void {
        if (this.disposed || frame.mime !== 'image/jpeg' || frame.data.length > 4 * 1024 * 1024) { return; }
        this.frame = frame;
        this.changed.fire();
    }

    clearError(): void { this.error = ''; this.errorOperation = ''; this.changed.fire(); }
    selectPort(port: string): void { if (this.selectedPort !== port) { this.backupCurrent = false; } this.selectedPort = port; this.changed.fire(); }
    selectProfile(profile: ConnectOptions['boardProfile']): void { if (this.boardProfile !== profile) { this.backupCurrent = false; } this.boardProfile = profile; this.changed.fire(); }
    reportError(action: string, error: unknown): void { this.fail(action, error); }
    note(text: string): void { this.onLog({ text: `${text}\n`, stream: 'system', time: Date.now() }); }

    async scanPorts(): Promise<void> {
        await this.perform('扫描串口', async () => {
            this.ports = await this.service.listPorts();
            if (!this.ports.some(port => port.path === this.selectedPort)) { this.selectedPort = this.ports[0]?.path || ''; }
        });
    }

    async connect(): Promise<void> {
        if (!this.selectedPort) { this.fail('连接设备', new Error('请先扫描并选择串口。')); return; }
        await this.perform('连接设备', async () => {
            this.backupCurrent = false;
            this.frame = undefined;
            this.entries = [];
            this.onState(await this.service.connect({ port: this.selectedPort, boardProfile: this.boardProfile }));
        });
    }

    async disconnect(): Promise<void> {
        if (this.flashing) { this.fail('断开设备', new Error('固件正在写入和验证，请保持 USB 连接，完成后再断开。')); return; }
        this.backupCurrent = false;
        await this.perform('断开设备', async () => { await this.service.disconnect(); this.onState(await this.service.getState()); }, true);
    }

    async execute(code: string): Promise<void> {
        if (!code.trim()) { return; }
        await this.perform('执行 REPL', async () => {
            this.backupCurrent = false;
            this.note(`REPL > ${code}`);
            // The service streams stdout/stderr through onLog; its return value is not echoed twice.
            await this.service.execute(code);
        });
    }

    async runScript(code: string, name: string): Promise<void> {
        await this.perform('发送脚本', async () => {
            this.backupCurrent = false;
            // Upload the current buffer to RAM, including unsaved changes.
            // The upload does not persist source files; the script can still perform I/O.
            this.note(`运行 ${name}`);
            await this.service.runScript(code);
        });
    }

    async stop(): Promise<void> {
        if (this.flashing) { this.fail('停止 / 取消', new Error('固件烧写不可取消。请保持 USB 连接，等待写入和验证完成。')); return; }
        await this.perform('停止 / 取消', () => this.service.stop(), true);
    }
    async listFiles(path = this.directory): Promise<void> {
        await this.perform('读取板端目录', async () => { const entries = await this.service.listFiles(path); this.directory = path; this.entries = entries; });
    }
    async readFile(path: string): Promise<Uint8Array | undefined> {
        return this.perform('读取板端文件', async () => {
            const result = await this.service.readFile(path);
            if (result.size > NODU_FILE_LIMIT || result.data.length > Math.ceil(NODU_FILE_LIMIT / 3) * 4) { throw new Error('文件超过 2 MiB 限额。'); }
            const binary = atob(result.data);
            if (binary.length !== result.size || binary.length > NODU_FILE_LIMIT) { throw new Error('板端文件长度校验失败。'); }
            return Uint8Array.from(binary, char => char.charCodeAt(0));
        });
    }
    async writeFile(path: string, bytes: Uint8Array, overwrite: boolean): Promise<boolean | undefined> {
        return this.perform('写入板端文件', async () => {
            this.backupCurrent = false;
            if (bytes.byteLength > NODU_FILE_LIMIT) { throw new Error('文件超过 2 MiB 限额。'); }
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 0x8000) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); }
            await this.service.writeFile(path, btoa(binary), overwrite);
            this.note(`已写入 ${path} · ${bytes.byteLength} 字节。`);
            return true;
        });
    }
    async startCamera(): Promise<void> { await this.perform('启动相机', () => this.service.startCamera()); }
    async setPreview(enabled: boolean): Promise<void> { await this.perform(enabled ? '开启预览' : '暂停预览', () => this.service.setPreview(enabled)); }

    async prepareFirmware(): Promise<void> {
        await this.perform('读取官方固件', async () => {
            this.plan = undefined;
            this.plan = await this.service.prepareFirmware();
            this.flashResult = undefined;
            if (!this.plan.ready) { throw new Error('官方固件尚未完成校验，请检查设备日志后重试。'); }
        });
    }

    async backupDevice(): Promise<void> {
        if (!this.plan?.ready || !this.connected || this.state.running) { this.fail('备份设备', new Error('请先读取官方固件，连接设备并停止脚本。')); return; }
        await this.perform('备份当前设备', async () => {
            this.backupCurrent = false;
            this.flashResult = undefined;
            const port = this.state.port || '';
            const profile = this.boardProfile;
            this.backup = await this.service.backupDevice();
            this.backupPort = port;
            this.backupProfile = profile;
            this.backupCurrent = this.backup.verified && this.backup.flashCapacityVerified && !!this.plan && this.backup.flashBytes >= this.plan.sectorEnd;
            if (!this.backup.flashCapacityVerified) { throw new Error('备份已保留，但 Flash 容量尚未实测确认，已阻止烧写。'); }
            if (!this.backup.verified || !this.plan || this.backup.flashBytes < this.plan.sectorEnd) { throw new Error('设备备份未通过验证，或未覆盖固件写入范围，已阻止烧写。'); }
        });
    }

    async flashFirmware(): Promise<void> {
        if (!this.canFlash) { this.fail('烧写固件', new Error('请先完成当前设备的完整备份与校验，再开始烧写。')); return; }
        const confirmedBackupDirectory = this.backup!.directory;
        await this.perform('烧写固件', async () => {
            this.flashResult = undefined;
            this.frame = undefined;
            this.flashResult = await this.service.flashFirmware(confirmedBackupDirectory);
            this.backupCurrent = false;
            if (!this.flashResult.verified) { throw new Error('固件验证未通过，请保留备份目录并检查设备日志。'); }
        });
    }

    private async perform<T>(label: string, task: () => Promise<T>, priority = false): Promise<T | undefined> {
        if (this.flashing) { this.fail(label, new Error('固件正在写入和验证，请保持 USB 连接并等待完成。')); return; }
        if (this.busy && !priority) { this.fail(label, new Error('设备正在处理其他操作；请稍候，或停止 / 取消当前操作。')); return; }
        this.pendingCount++;
        this.pending = label;
        this.error = '';
        this.errorOperation = '';
        this.changed.fire();
        try { return await task(); }
        catch (error) { this.fail(label, error); return undefined; }
        finally { this.pendingCount--; if (!this.pendingCount) { this.pending = ''; } if (!this.disposed) { this.changed.fire(); } }
    }

    private fail(action: string, error: unknown): void {
        this.error = `${action}失败：${error instanceof Error ? error.message : String(error)}`;
        this.errorOperation = action;
        this.onLog({ text: `${this.error}\n`, stream: 'stderr', time: Date.now() });
    }

    dispose(): void { this.disposed = true; this.toDispose.dispose(); this.changed.dispose(); this.logged.dispose(); }
}
