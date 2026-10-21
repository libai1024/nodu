// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { ConnectOptions, DeviceBackup, DeviceClient, DeviceFileData, DeviceFrame, DeviceLog, DeviceState, FirmwarePlan, FirmwareResult, NoduDeviceService, RecordingStatus, RemoteFile, SerialPortInfo } from '../common/nodu-device-protocol';
import { BOARD_CONFIG_MAX_BYTES, BoardInspection, inspectBoardConfig } from '../common/nodu-board-info';
import URI from '@theia/core/lib/common/uri';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { isAbsolute } from 'path';
import { randomUUID } from 'crypto';
import { createRequire } from 'module';

const initialState = (): DeviceState => ({ phase: 'disconnected', busy: false, running: false, preview: false,
    flashCapacityVerified: false,
    capabilities: { repl: false, files: false, framebuffer: false, script: false, firmware: false } });
const MAX_BYTES = 2 * 1024 * 1024;

/** One worker and serial session per backend; the worker also locks the OS port across backends. */
@injectable()
export class NoduDeviceServer implements NoduDeviceService, BackendApplicationContribution {
    private worker?: ChildProcessWithoutNullStreams;
    private sequence = 0;
    private state = initialState();
    private readonly clients = new Set<DeviceClient>();
    private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
    private idleTimer?: ReturnType<typeof setTimeout>;
    private backupDirectory?: string;
    private connectionEpoch = 0;
    private flashTask?: Promise<FirmwareResult>;
    /** Short-lived second sidecar for convert/play: host-only work that must not wait for the camera script. */
    private mediaWorker?: ChildProcessWithoutNullStreams;

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
        return this.resourceBinary('nodu-device');
    }
    private resourceBinary(name: string): string {
        const extensionDir = dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'));
        const exe = process.platform === 'win32' ? `${name}.exe` : name;
        const packaged = join(extensionDir, 'resources', 'bin', `${process.platform}-${process.arch}`, exe);
        if (existsSync(packaged)) { return packaged; }
        return join(extensionDir, '..', 'native', 'target', 'release', exe);
    }
    /** Path of the bundled terminal binary; frontends never choose the binary. */
    getTerminalExecutable(): Promise<string> {
        if (process.env.NODU_TERMINAL_BIN) { return Promise.resolve(process.env.NODU_TERMINAL_BIN); }
        return Promise.resolve(this.resourceBinary('nodu-terminal'));
    }
    /**
     * `NODU_STARTUP_TERMINALS` (launcher `-open_*_terminal` flags): a JSON
     * array of argument arrays, consumed exactly once per backend so a
     * reconnected frontend does not reopen them.
     */
    private startupTerminalsConsumed = false;
    takeStartupTerminals(): Promise<string[][]> {
        if (this.startupTerminalsConsumed) { return Promise.resolve([]); }
        this.startupTerminalsConsumed = true;
        const raw = process.env.NODU_STARTUP_TERMINALS;
        // Bound the raw payload before parsing: at most 16 entries of 16
        // 512-byte arguments, so anything past ~140 KB is invalid anyway.
        if (!raw || raw.length > 140_000) { return Promise.resolve([]); }
        try {
            const parsed: unknown = JSON.parse(raw);
            if (!Array.isArray(parsed) || parsed.length > 16) { return Promise.resolve([]); }
            const clean: string[][] = [];
            for (const entry of parsed) {
                if (!Array.isArray(entry) || entry.length === 0 || entry.length > 16
                    || !entry.every(a => typeof a === 'string' && a.length <= 512 && !a.includes('\0'))) {
                    return Promise.resolve([]);
                }
                clean.push(entry.slice());
            }
            return Promise.resolve(clean);
        } catch { return Promise.resolve([]); }
    }
    /** Original `-override_read_*_timeout` flags, forwarded after validation. */
    private static timeoutArg(envName: string, flag: string): string[] {
        const raw = process.env[envName];
        if (raw === undefined) { return []; }
        const ms = Number(raw);
        if (!Number.isInteger(ms) || ms < 1 || ms > 60000) {
            process.stderr.write(`nodu-device: ignoring invalid ${envName}=${raw} (1-60000 ms expected)\n`);
            return [];
        }
        return [flag, String(ms)];
    }
    private ensureWorker(): ChildProcessWithoutNullStreams {
        if (this.worker) { return this.worker; }
        const mock = process.env.NODU_DEVICE_MOCK === '1';
        const args = [
            ...(mock ? ['--mock'] : []),
            ...NoduDeviceServer.timeoutArg('NODU_READ_TIMEOUT_MS', '-override_read_timeout'),
            ...NoduDeviceServer.timeoutArg('NODU_READ_STALL_TIMEOUT_MS', '-override_read_stall_timeout'),
        ];
        const worker = spawn(this.deviceBinary(), args, {
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
            // The Rust worker bounds the entire flash operation. A Node
            // deadline must not kill it between programming and read-back.
            const timer = method === 'flashFirmware' ? undefined : setTimeout(() => {
                this.pending.delete(id); reject(new Error(`设备操作超时：${method}。连接已释放，请重新连接。`));
                this.failWorker(new Error(`设备操作超时：${method}；会话已释放。`));
            }, timeout);
            this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
            worker.stdin.write(JSON.stringify({ id, method, args }) + '\n', error => {
                if (error) { this.failWorker(new Error(`设备服务写入失败：${error.message}`), worker); }
            });
        });
    }
    private validatePath(path: string, writing = false, confirmedStartup = false): void {
        if (typeof path !== 'string' || path.length > 512 || !/^\/(flash|sd)(\/|$)/.test(path) || /[\x00-\x1f]/.test(path) || path.split('/').includes('..')) {
            throw new Error('请选择 /flash 或 /sd 内的有效设备路径。');
        }
        if (writing && !confirmedStartup && /\/(boot|main)\.py$/i.test(path)) { throw new Error('保护启动文件：写入 boot.py/main.py 需要显式确认。'); }
    }
    private validateCode(code: string): void {
        if (typeof code !== 'string' || !code.trim() || Buffer.byteLength(code, 'utf8') > 256 * 1024 || code.includes('\0')) { throw new Error('脚本须为非空文本，大小不超过 256 KiB。'); }
    }
    getState(): Promise<DeviceState> { return Promise.resolve(this.state); }
    listPorts(): Promise<SerialPortInfo[]> { return this.request('listPorts'); }
    async connect(options: ConnectOptions): Promise<DeviceState> {
        if (!options || typeof options.port !== 'string' || !options.port.trim() || options.port.length > 512 || /[\x00-\x1f]/.test(options.port)) { return Promise.reject(new Error('请选择有效串口。')); }
        if (!['embedfire-cam-gc2145', 'generic-k210'].includes(options.boardProfile) || (options.baud && options.baud !== 115200)) { return Promise.reject(new Error('请选择受支持的 K210 板型，REPL 波特率为 115200。')); }
        if (options.protocol !== undefined && !['ide', 'raw'].includes(options.protocol)) { return Promise.reject(new Error('连接协议必须为 ide 或 raw。')); }
        if (options.boardId !== undefined && (!Number.isInteger(options.boardId) || options.boardId < 0 || options.boardId > 8)) { return Promise.reject(new Error('连接板型编号必须为 0–8 的整数。')); }
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
    writeFile(path: string, data: string, overwrite: boolean, confirmedStartup = false): Promise<void> {
        this.validatePath(path, true, confirmedStartup === true);
        if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, 'base64').length > MAX_BYTES) { throw new Error('上传文件须为有效数据且不超过 2 MiB。'); }
        return this.request('writeFile', { path, data, overwrite: overwrite === true, confirmedStartup: confirmedStartup === true }, 910000);
    }
    formatScript(code: string, stripComments: boolean, spacesToTabs: boolean): Promise<string> {
        this.validateCode(code);
        return this.request('formatScript', { code, stripComments: stripComments === true, spacesToTabs: spacesToTabs === true });
    }
    setPreview(enabled: boolean): Promise<void> { return this.request('setPreview', { enabled: enabled === true }); }
    startCamera(): Promise<void> { return this.request('startCamera', {}, 60000); }
    saveFile(name: string, data: string, confirmedStartup = false): Promise<void> {
        if (typeof name !== 'string' || !name || name.length > 512 || /\0|\\|\.\./.test(name)) { throw new Error('板端文件名无效。'); }
        const base = name.split('/').pop() || name;
        if (/^(boot|main)\.py$/i.test(base) && confirmedStartup !== true) { throw new Error('写入 boot.py/main.py 需要显式确认启动文件。'); }
        if (typeof data !== 'string' || data.length > Math.ceil(MAX_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) || Buffer.from(data, 'base64').length > MAX_BYTES) { throw new Error('上传文件须为有效数据且不超过 2 MiB。'); }
        return this.request('saveFile', { name, data, confirmedStartup: confirmedStartup === true }, 600000);
    }
    resetDevice(): Promise<void> { return this.request('resetDevice', {}, 15000); }
    private mediaPath(uri: string, what: string): string {
        if (typeof uri !== 'string' || !/^file:\/\//i.test(uri)) {
            throw new Error(`${what}须为 file:// 本地路径。`);
        }
        let fsPath: string;
        try {
            let parsed = new URI(uri);
            if (parsed.scheme !== 'file') { throw new Error('scheme'); }
            // Local files only: a host authority (UNC/share) or URI
            // query/fragment does not denote a local filesystem path.
            const authority = parsed.authority;
            if (authority && authority.toLowerCase() !== 'localhost') { throw new Error('authority'); }
            if (parsed.query || parsed.fragment) { throw new Error('query'); }
            if (authority) { parsed = parsed.withAuthority(''); }
            fsPath = FileUri.fsPath(parsed);
        } catch { throw new Error(`${what}须为 file:// 本地路径。`); }
        if (!fsPath || !isAbsolute(fsPath) || fsPath.includes('\0') || Buffer.byteLength(fsPath, 'utf8') > 4096) {
            throw new Error(`${what}须为不超过 4096 字节的绝对本地路径。`);
        }
        return fsPath;
    }
    /** Without a target the raw stream goes to a fresh file under the OS temp directory. */
    startRecording(fileUri?: string): Promise<RecordingStatus> {
        const path = fileUri === undefined ? NoduDeviceServer.tempRecordingPath() : this.mediaPath(fileUri, '录像目标');
        if (!/\.bin$/i.test(path)) { throw new Error('录像目标须为 .bin 文件。'); }
        return this.request('startRecording', { path });
    }
    private static tempRecordingPath(): string {
        const directory = join(tmpdir(), 'nodu-recordings');
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        const now = new Date(), two = (n: number): string => String(n).padStart(2, '0');
        const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
        return join(directory, `nodu-${stamp}-${randomUUID().slice(0, 8)}.bin`);
    }
    stopRecording(): Promise<RecordingStatus> { return this.request('stopRecording'); }
    convertVideo(inputUri: string, outputUri: string): Promise<void> {
        const input = this.mediaPath(inputUri, '输入视频');
        const output = this.mediaPath(outputUri, '输出视频');
        if (!/\.(mp4|avi|mjpeg)$/i.test(output)) { throw new Error('输出须为 .mp4、.avi 或 .mjpeg 文件。'); }
        return this.mediaRequest('convertVideo', { input, output });
    }
    playVideo(inputUri: string): Promise<void> {
        const input = this.mediaPath(inputUri, '输入视频');
        return this.mediaRequest('playVideo', { input });
    }
    /** Cancels the convert/play job: the sidecar kills ffmpeg/ffplay on stop, then exits on stdin EOF. */
    cancelMedia(): Promise<void> {
        const worker = this.mediaWorker;
        if (worker && !worker.stdin.writableEnded) { worker.stdin.write(JSON.stringify({ id: 2, method: 'stop', args: {} }) + '\n'); }
        return Promise.resolve();
    }
    /**
     * Runs one media request on its own sidecar process. It never opens a
     * serial port, so it can convert while the camera script runs or a
     * recording is still being written by the device worker.
     */
    private mediaRequest(method: 'convertVideo' | 'playVideo', args: object): Promise<void> {
        if (this.mediaWorker) { return Promise.reject(new Error('已有视频任务在进行；请等待完成或取消。')); }
        const worker = spawn(this.deviceBinary(), [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.mediaWorker = worker;
        return new Promise<void>((resolve, reject) => {
            let settled = false;
            const settle = (error?: Error): void => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                if (this.mediaWorker === worker) { this.mediaWorker = undefined; }
                if (!worker.stdin.writableEnded) { worker.stdin.end(); }
                if (error) { reject(error); } else { resolve(); }
            };
            const timer = setTimeout(() => { void this.cancelMedia(); settle(new Error('视频任务超时，已取消。')); }, 910000);
            const reader = createInterface({ input: worker.stdout });
            reader.on('line', line => {
                try {
                    const message = JSON.parse(line);
                    if (message.id === 1) { settle(message.error ? new Error(String(message.error)) : undefined); }
                } catch { /* State/log events of the media sidecar are not forwarded. */ }
            });
            worker.stderr.on('data', data => this.publish('onLog', { text: String(data).slice(0, 8000), stream: 'stderr', time: Date.now() }));
            worker.on('error', error => settle(new Error(`视频服务启动失败：${error.message}`)));
            worker.on('exit', (code, signal) => { reader.close(); settle(new Error(`视频服务已退出（${signal || code}）。`)); });
            worker.stdin.write(JSON.stringify({ id: 1, method, args }) + '\n');
        });
    }
    /** Reads the declared board config; never writes, resets or probes hardware. */
    async inspectBoard(): Promise<BoardInspection> {
        const source = '/flash/config.json' as const;
        const unavailable = (issue: string): BoardInspection => ({ status: 'unavailable', source, pins: {}, peripherals: {}, issues: [issue] });
        const invalid = (issue: string): BoardInspection => ({ status: 'invalid', source, pins: {}, peripherals: {}, issues: [issue] });
        if (this.state.phase !== 'connected' || this.state.running || this.state.busy || !this.state.capabilities.files) {
            return unavailable('需要已连接、空闲且支持板端文件的设备，才能读取配置声明。');
        }
        const epoch = this.connectionEpoch;
        const port = this.state.port;
        const stillCurrent = (): boolean =>
            epoch === this.connectionEpoch && !!port && this.state.port === port
            && this.state.phase === 'connected' && !this.state.running && !this.state.busy;
        try {
            const files = await this.request<RemoteFile[]>('listFiles', { path: '/flash' });
            if (!stillCurrent()) { return unavailable('连接状态已变化，本次检查结果已放弃。'); }
            const entry = files.find(file => file.name === 'config.json');
            if (!entry) { return { status: 'missing', source, pins: {}, peripherals: {}, issues: ['板端未找到 /flash/config.json，未声明板型。'] }; }
            if (entry.directory) { return invalid('config.json 是目录，未读取。'); }
            if (!Number.isInteger(entry.size) || entry.size < 0) { return invalid('config.json 目录大小字段无效。'); }
            if (entry.size > BOARD_CONFIG_MAX_BYTES) { return invalid('config.json 超过 16 KiB 上限，未读取。'); }
            const data = await this.request<DeviceFileData>('readFile', { path: '/flash/config.json' }, 45000);
            if (!stillCurrent()) { return unavailable('连接状态已变化，本次检查结果已放弃。'); }
            // Buffer.from() silently ignores junk bytes, so the payload's
            // canonical alphabet, padding and encoded cap are checked first.
            if (!data || typeof data.data !== 'string'
                || data.data.length > Math.ceil(BOARD_CONFIG_MAX_BYTES / 3) * 4
                || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data.data)
                || !Number.isInteger(data.size) || data.size < 0) {
                return invalid('config.json 读取响应格式无效，未采用。');
            }
            if (data.size !== entry.size) { return unavailable('config.json 在读取期间发生变化，已放弃本次结果。'); }
            const bytes = Buffer.from(data.data, 'base64');
            if (bytes.length !== data.size) { return invalid('config.json 读取结果长度与声明不符，未采用。'); }
            let text: string;
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
            catch { return invalid('config.json 不是有效的 UTF-8 文本。'); }
            return inspectBoardConfig(text);
        } catch (error) {
            return unavailable(`读取板端配置失败：${error instanceof Error ? error.message : String(error)}`);
        }
    }
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
        const task = this.request<FirmwareResult>('flashFirmware', { backupDir: this.backupDirectory });
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
        void this.cancelMedia();
        this.mediaWorker?.stdin.end();
        clearTimeout(this.idleTimer);
        const worker = this.worker; this.worker = undefined;
        worker?.stdin.end();
        worker?.kill();
        for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('设备服务已关闭。')); }
        this.pending.clear(); this.state = initialState();
    }
}
