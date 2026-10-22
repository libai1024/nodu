// SPDX-License-Identifier: MIT
import { Emitter } from '@theia/core/lib/common/event';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { RpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { LocalStorageService } from '@theia/core/lib/browser/storage-service';
import { BoardInspection, ConnectOptions, DeviceBackup, DeviceClient, DeviceFrame, DeviceLog, DeviceState, FirmwarePlan, FirmwareResult, NODU_DEVICE_PATH, NoduDeviceService, RecordingStatus, RemoteFile, SerialPortInfo } from '../common/nodu-device-protocol';
import { BOARD_DEFINITIONS } from '../common/nodu-board-data';
import { BoardPreset, RememberedBoard, presetById } from '../common/nodu-board-presets';

export const NODU_FILE_LIMIT = 2 * 1024 * 1024;

/** One RPC session is shared by the toolbar, both layouts and all device views. */
@injectable()
export class NoduDeviceModel implements DeviceClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    // Per-user store: StorageService is rebound to the workspace-scoped
    // WorkspaceStorageService, but the board choice must follow the user.
    @inject(LocalStorageService) protected readonly storage!: LocalStorageService;
    private readonly changed = new Emitter<void>();
    private readonly logged = new Emitter<DeviceLog>();
    readonly onDidChange = this.changed.event;
    readonly onDidLog = this.logged.event;
    private service!: RpcProxy<NoduDeviceService>;
    private readonly toDispose = new DisposableCollection();
    state: DeviceState = {
        phase: 'disconnected', busy: false, running: false, preview: false,
        flashCapacityVerified: false,
        capabilities: { repl: false, files: false, framebuffer: false, script: false, firmware: false }
    };
    ports: SerialPortInfo[] = [];
    entries: RemoteFile[] = [];
    directory = '/flash';
    selectedPort = '';
    boardProfile: ConnectOptions['boardProfile'] = 'embedfire-cam-gc2145';
    /** Original MaixPy IDE board id 0–8 (reset sequence); persisted locally. */
    boardId = 2;
    /** Last board + port connected from the simple-mode picker; per user. */
    remembered: RememberedBoard | undefined;
    frame: DeviceFrame | undefined;
    logs: DeviceLog[] = [];
    error = '';
    // Operation label that produced `error`; '' = backend/device-level fault.
    errorOperation = '';
    pending = '';
    plan: FirmwarePlan | undefined;
    backup: DeviceBackup | undefined;
    flashResult: FirmwareResult | undefined;
    /** Board-side config declaration; never a measured hardware identity. */
    boardInspection: BoardInspection | undefined;
    boardInspecting = false;
    private boardInspectionPort = '';
    private boardInspectionGeneration = 0;
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
            this.state = { ...this.state, phase: 'error', running: false, busy: false, preview: false, fps: undefined };
            this.frame = undefined;
            this.entries = [];
            this.clearBoardInspection();
            this.fail('设备服务连接', new Error('连接已中断，正在等待服务重新连接。'));
        }));
        void this.restoreSelection();
        void this.init();
    }

    /** Per-user board selection (original persisted /boardconfig.txt). */
    private async restoreSelection(): Promise<void> {
        const [savedId, savedProfile, savedBoard] = await Promise.all([
            this.storage.getData<number>('nodu.board-id').catch(() => undefined),
            this.storage.getData<string>('nodu.board-profile').catch(() => undefined),
            this.storage.getData<RememberedBoard>('nodu.simple-board').catch(() => undefined),
        ]);
        if (this.disposed) { return; }
        let changed = false;
        if (savedBoard && typeof savedBoard === 'object' && presetById(savedBoard.preset) && typeof savedBoard.port === 'string' && savedBoard.port.length <= 512
            && (savedBoard.serialNumber === undefined || typeof savedBoard.serialNumber === 'string')) {
            this.remembered = { preset: savedBoard.preset, port: savedBoard.port, ...(savedBoard.serialNumber ? { serialNumber: savedBoard.serialNumber } : {}) };
            // Shown on the toolbar chip; a scan replaces it when the port is gone.
            if (!this.selectedPort) { this.selectedPort = savedBoard.port; }
            changed = true;
        }
        if (typeof savedId === 'number' && Number.isInteger(savedId) && savedId >= 0 && savedId <= 8) {
            this.boardId = savedId;
            changed = true;
        } else {
            // Legacy pre-StorageService key; migrated on next persist.
            try {
                const raw = localStorage.getItem('nodu.board-id');
                const legacy = raw === null ? undefined : Number(raw);
                if (legacy !== undefined && Number.isInteger(legacy) && legacy >= 0 && legacy <= 8) { this.boardId = legacy; changed = true; }
            } catch { /* private mode */ }
        }
        if (savedProfile === 'embedfire-cam-gc2145' || savedProfile === 'generic-k210') { this.boardProfile = savedProfile; changed = true; }
        if (changed) { this.changed.fire(); }
    }

    private persistSelection(): void {
        void this.storage.setData('nodu.board-id', this.boardId);
        void this.storage.setData('nodu.board-profile', this.boardProfile);
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
    /** Toolbar caption: catalog label only for a declared match; never a measured identity. */
    get boardLabel(): string {
        if (!this.connected) { return this.rememberedPreset?.label ?? '选择开发板'; }
        if (this.boardInspection?.status === 'declared' && this.boardInspection.boardId) {
            const board = BOARD_DEFINITIONS.find(entry => entry.id === this.boardInspection!.boardId);
            if (board) { return board.label; }
        }
        return this.connectedPreset?.label ?? 'K210 · 未识别';
    }
    get rememberedPreset(): BoardPreset | undefined { return presetById(this.remembered?.preset); }
    /** The picker's board for this connection: same port, profile and reset id as remembered. */
    get connectedPreset(): BoardPreset | undefined {
        if (!this.connected || !this.remembered || this.remembered.port !== this.state.port) { return undefined; }
        const preset = presetById(this.remembered.preset);
        return preset && preset.profile === this.state.boardProfile && preset.boardId === this.state.boardId ? preset : undefined;
    }

    init(): Promise<void> {
        return this.opening ??= this.service.getState().then(state => this.onState(state)).catch(error => {
            this.fail('读取设备状态', error);
        }).finally(() => { this.opening = undefined; });
    }

    onState(state: DeviceState): void {
        if (this.disposed) { return; }
        const previousPort = this.state.port;
        this.state = state;
        if (!this.connected) { this.frame = undefined; this.entries = []; this.clearBoardInspection(); }
        // Any port change invalidates the declaration — including one that
        // arrives while the first inspection is still in flight.
        else if (state.port !== previousPort || (this.boardInspectionPort && state.port !== this.boardInspectionPort)) { this.clearBoardInspection(); }
        if (state.port) { this.selectedPort = state.port; }
        if ((state.boardProfile === 'embedfire-cam-gc2145' || state.boardProfile === 'generic-k210') && state.boardProfile !== this.boardProfile) { this.boardProfile = state.boardProfile; this.persistSelection(); }
        if (typeof state.boardId === 'number' && state.boardId !== this.boardId) { this.boardId = state.boardId; this.persistSelection(); }
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
    private clearBoardInspection(): void {
        this.boardInspectionGeneration++;
        this.boardInspection = undefined;
        this.boardInspecting = false;
        this.boardInspectionPort = '';
    }
    selectPort(port: string): void {
        if (this.selectedPort !== port) { this.backupCurrent = false; this.clearBoardInspection(); }
        this.selectedPort = port; this.changed.fire();
    }
    selectProfile(profile: ConnectOptions['boardProfile']): void { if (this.boardProfile !== profile) { this.backupCurrent = false; this.boardProfile = profile; this.persistSelection(); } this.changed.fire(); }
    selectBoardId(id: number): void {
        if (!Number.isInteger(id) || id < 0 || id > 8) { return; }
        this.boardId = id;
        this.persistSelection();
        this.changed.fire();
    }
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
            this.clearBoardInspection();
            this.onState(await this.service.connect({ port: this.selectedPort, boardProfile: this.boardProfile, boardId: this.boardId, protocol: 'ide' }));
            if (this.connected && !this.state.running && this.state.capabilities.files) {
                await this.readBoardInspection();
            }
        });
    }

    /**
     * Simple-mode picker: one click sets profile, reset id and port, then
     * connects. Only an explicit user choice ever calls this; the pick is
     * remembered only once the connection succeeded.
     */
    async connectPreset(preset: BoardPreset, port: SerialPortInfo): Promise<void> {
        if (this.connected || this.busy || this.flashing) { return; }
        this.selectProfile(preset.profile);
        this.selectBoardId(preset.boardId);
        this.selectPort(port.path);
        await this.connect();
        if (this.connected && this.state.port === port.path) {
            this.remembered = { preset: preset.id, port: port.path, ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}) };
            void this.storage.setData('nodu.simple-board', this.remembered);
            this.changed.fire();
        }
    }

    /** Read-only; failures surface in the inspection state, not device.error. */
    async inspectBoard(): Promise<void> {
        await this.perform('读取板端配置', () => this.readBoardInspection());
    }

    private async readBoardInspection(): Promise<void> {
        const generation = ++this.boardInspectionGeneration;
        const port = this.state.port || '';
        this.boardInspecting = true;
        this.changed.fire();
        try {
            const result = await this.service.inspectBoard();
            if (this.disposed || generation !== this.boardInspectionGeneration) { return; }
            if (this.connected && port && this.state.port === port) {
                this.boardInspection = result;
                this.boardInspectionPort = port;
            }
        } catch (error) {
            if (!this.disposed && generation === this.boardInspectionGeneration && this.connected && port && this.state.port === port) {
                this.boardInspection = { status: 'unavailable', source: '/flash/config.json', pins: {}, peripherals: {},
                    issues: [`读取板端配置失败：${error instanceof Error ? error.message : String(error)}`] };
                this.boardInspectionPort = port;
            }
        } finally {
            if (generation === this.boardInspectionGeneration) { this.boardInspecting = false; }
            if (!this.disposed) { this.changed.fire(); }
        }
    }

    async resetDevice(): Promise<void> {
        this.clearBoardInspection();
        await this.perform('复位设备', async () => { await this.service.resetDevice(); this.onState(await this.service.getState()); }, true);
    }

    async saveFile(name: string, data: string, confirmedStartup = false): Promise<boolean | undefined> {
        const written = await this.perform('写入板端文件', async () => {
            await this.service.saveFile(name, data, confirmedStartup);
            this.onState(await this.service.getState());
            this.note(`已写入板端 ${name}（默认存储）。`);
            return true;
        });
        // A listing already on screen (开发板文件) must not go stale; the write itself has succeeded.
        if (written && this.connected && this.entries.length) { await this.listFiles(this.directory); }
        return written;
    }

    /** Local formatting; the device is not involved. */
    async formatScript(code: string, stripComments: boolean, spacesToTabs: boolean): Promise<string | undefined> {
        return this.perform('格式化脚本', () => this.service.formatScript(code, stripComments, spacesToTabs));
    }

    async startRecording(fileUri?: string): Promise<boolean | undefined> {
        return this.perform('开始录像', async () => {
            await this.service.startRecording(fileUri);
            this.onState(await this.service.getState());
            return true;
        });
    }
    /** Finalize the recording; returns the counters or undefined on failure. */
    async stopRecording(): Promise<RecordingStatus | undefined> {
        return this.perform('结束录像', async () => {
            const status = await this.service.stopRecording();
            this.onState(await this.service.getState());
            this.note(`录像已保存到 ${status.path} · ${status.frames} 帧，${status.bytes} 字节。`);
            return status;
        });
    }
    // Media jobs run on their own sidecar, so they never mark the device busy.
    async convertVideo(inputUri: string, outputUri: string): Promise<boolean | undefined> {
        return this.mediaJob('转换视频', () => this.service.convertVideo(inputUri, outputUri));
    }
    async playVideo(inputUri: string): Promise<boolean | undefined> {
        return this.mediaJob('播放视频', () => this.service.playVideo(inputUri));
    }
    cancelMedia(): Promise<void> { return this.service.cancelMedia(); }
    private async mediaJob(label: string, task: () => Promise<void>): Promise<boolean | undefined> {
        try { await task(); return true; } catch (error) { this.fail(label, error); this.changed.fire(); return undefined; }
    }

    /** Bundled terminal binary path — Node-side lookup, no worker needed. */
    getTerminalExecutable(): Promise<string> {
        return this.service.getTerminalExecutable();
    }
    /** Launcher `-open_*_terminal` requests, consumed once per backend. */
    takeStartupTerminals(): Promise<string[][]> {
        return this.service.takeStartupTerminals();
    }

    async disconnect(): Promise<void> {
        if (this.flashing) { this.fail('断开设备', new Error('固件正在写入和验证，请保持 USB 连接，完成后再断开。')); return; }
        this.backupCurrent = false;
        // Invalidate at once so an in-flight inspection resolves stale.
        this.clearBoardInspection();
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
    async writeFile(path: string, bytes: Uint8Array, overwrite: boolean, confirmedStartup = false): Promise<boolean | undefined> {
        return this.perform('写入板端文件', async () => {
            this.backupCurrent = false;
            if (bytes.byteLength > NODU_FILE_LIMIT) { throw new Error('文件超过 2 MiB 限额。'); }
            let binary = '';
            for (let offset = 0; offset < bytes.length; offset += 0x8000) { binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)); }
            await this.service.writeFile(path, btoa(binary), overwrite, confirmedStartup);
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
