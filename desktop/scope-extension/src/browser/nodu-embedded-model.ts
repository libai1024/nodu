// SPDX-License-Identifier: MIT
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { SerialTextDecoder, serialBase64, serialBytes } from '../common/nodu-serial-data';
import { Emitter } from '@theia/core/lib/common/event';
import { URI } from '@theia/core/lib/common/uri';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ContextKey, ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { Diagnostic as LspDiagnostic } from '@theia/core/shared/vscode-languageserver-protocol';
import {
    BackupRecord, BuildResult, CallOutcome, CatalogBoard, ChipIdentity, Diagnostic, EmbeddedClient, EmbeddedFailure,
    EmbeddedMethod, FlashResult, MonitorSnapshot, MonitorWriteResult, NODU_EMBEDDED_PATH, NoduEmbeddedService, PortInfo, ProbeInfo, ProjectStatus
} from '../common/nodu-embedded-protocol';

export type Tone = 'busy' | 'ok' | 'error' | 'warn';
export interface TaskStrip { text: string; tone: Tone; steps?: { id: string; label: string; state: string }[]; target?: 'problems' | 'output' | 'device' | 'monitor'; at: number }
export interface MonitorLine { text: string; kind: 'data' | 'separator' | 'system'; bytes?: Uint8Array; direction?: 'RX' | 'TX'; at: number }
export type PanelTab = 'problems' | 'monitor' | 'output';

/** Thrown by `call` with the sidecar's stable code and tool output. */
export class EmbeddedError extends Error {
    constructor(readonly failure: EmbeddedFailure) { super(failure.message); }
    get code(): string { return this.failure.code; }
}

const STEP_LABELS: Record<string, string> = { build: '编译', identify: '识别', backup: '备份出厂程序', program: '写入', verify: '校验', run: '运行' };
const MAX_LINES = 10_000;

/** STM32 HAL project state for this window (FUNCTIONAL-DESIGN §10.3). */
@injectable()
export class NoduEmbeddedModel implements EmbeddedClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(ProblemManager) protected readonly problems!: ProblemManager;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    private service!: NoduEmbeddedService;
    private readonly changed = new Emitter<void>();
    private readonly monitorChanged = new Emitter<void>();
    private readonly clangdMessage = new Emitter<string>();
    private readonly projectChanged = new Emitter<ProjectStatus | undefined>();
    readonly onDidChange = this.changed.event;
    readonly onDidMonitor = this.monitorChanged.event;
    readonly onClangdMessage = this.clangdMessage.event;
    readonly onDidChangeProject = this.projectChanged.event;
    private cProjectKey!: ContextKey<boolean>;

    project: ProjectStatus | undefined;
    building = false;
    buildProgress: { done: number; total: number; file: string } | undefined;
    lastBuild: BuildResult | undefined;
    flashing = false;
    flashSteps: Record<string, string> = {};
    flashPercent: number | undefined;
    awaitUser: 'enterBoot' | 'exitBoot' | undefined;
    romDetected = false;
    lastFlash: FlashResult | undefined;
    lastError: EmbeddedFailure | undefined;
    task: TaskStrip | undefined;
    identity: ChipIdentity | undefined;
    identifying = false;
    probes: ProbeInfo[] = [];
    ports: PortInfo[] = [];
    backups: BackupRecord[] = [];
    probe = '';
    monitorPort = '';
    monitor: MonitorSnapshot = { open: false, port: '', baud: 115200, state: 'closed' };
    monitorBusy = false;
    monitorSending = false;
    monitorSendError = '';
    private readonly monitorOwner = crypto.randomUUID();
    private monitorBytes = 0;
    monitorTrimmed = false;
    readonly monitorLines: MonitorLine[] = [];
    readonly output: string[] = [];
    panelTab: PanelTab = 'output';
    runCount = 0;
    private decoder = new SerialTextDecoder();
    private buildId = '';
    private runId = '';
    private markerUris = new Set<string>();
    /** Workspace root as the editor sees it; the sidecar reports the canonical (symlink-free) path. */
    private localRoot = '';
    private projectEpoch = 0;
    private monitorOpenEpoch = -1;

    toLocal(path: string): string {
        const root = this.project?.path;
        return root && this.localRoot && this.localRoot !== root && path.startsWith(root) ? this.localRoot + path.slice(root.length) : path;
    }

    toCanonical(path: string): string {
        const root = this.project?.path;
        return root && this.localRoot && this.localRoot !== root && path.startsWith(this.localRoot) ? root + path.slice(this.localRoot.length) : path;
    }

    @postConstruct()
    protected init(): void {
        this.cProjectKey = this.contextKeys.createKey<boolean>('nodu.cProject', false);
        this.service = this.connections.createProxy<NoduEmbeddedService>(NODU_EMBEDDED_PATH, this);
        this.workspace.onWorkspaceChanged(roots => void this.detect(roots[0]?.resource));
        void this.workspace.roots.then(roots => this.detect(roots[0]?.resource));
        this.monitorPort = localStorage.getItem('nodu.stm32.monitor-port') || '';
    }

    get isC(): boolean { return !!this.project; }
    get busy(): boolean { return this.building || this.flashing || this.identifying; }
    get errors(): Diagnostic[] { return this.lastBuild?.diagnostics.filter(d => d.severity === 'error') ?? []; }
    get rpc(): NoduEmbeddedService { return this.service; }

    fire(): void { this.changed.fire(); }

    async call<T>(method: EmbeddedMethod, args: Record<string, unknown> = {}): Promise<T> {
        const outcome: CallOutcome = await this.service.call(method, args);
        if (!outcome.ok) { throw new EmbeddedError(outcome.error); }
        return outcome.result as T;
    }

    /** A folder is a C project when its nodu.json says `kind: stm32-hal`. */
    async detect(root: URI | undefined): Promise<void> {
        const epoch = ++this.projectEpoch;
        let project: ProjectStatus | undefined;
        if (root) {
            try {
                const manifest = root.resolve('nodu.json');
                if (await this.files.exists(manifest)) {
                    const text = (await this.files.read(manifest)).value;
                    if ((JSON.parse(text) as { kind?: string }).kind === 'stm32-hal') {
                        project = await this.call<ProjectStatus>('openProject', { path: root.path.fsPath() });
                    }
                }
            } catch (error) {
                if (epoch !== this.projectEpoch) { return; }
                this.setTask(`STM32 工程无法打开：${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        }
        if (epoch !== this.projectEpoch) { return; }
        const switched = project?.path !== this.project?.path;
        this.localRoot = root?.path.fsPath() ?? '';
        this.project = project;
        this.cProjectKey.set(!!project);
        if (switched) {
            this.clearMarkers(); this.lastBuild = undefined; this.identity = undefined;
            this.output.length = 0; this.buildId = ''; this.runId = '';
            // A project switch cannot inherit permission to send on a prior session.
            if (this.monitor.open && this.monitor.session) {
                void this.call('closeMonitor', { owner: this.monitorOwner, session: this.monitor.session }).catch(() => undefined);
                this.monitor = { ...this.monitor, open: false, state: 'closed' };
                this.pushMonitor('工程已切换；串口需要手动连接。', 'system');
            }
            this.projectChanged.fire(project);
        }
        if (project) { void this.refreshDevices(); }
        this.fire();
    }

    async reload(): Promise<void> {
        const project = this.project, epoch = this.projectEpoch;
        if (!project) { return; }
        const next = await this.call<ProjectStatus>('openProject', { path: project.path });
        if (epoch !== this.projectEpoch) { return; }
        this.project = next; this.fire();
    }

    setTask(text: string, tone: Tone, extra: Partial<TaskStrip> = {}): void {
        this.task = { text, tone, at: Date.now(), ...extra };
        this.fire();
    }

    private steps(method: string): { id: string; label: string; state: string }[] {
        const order = ['build', 'identify', ...(this.flashSteps.backup ? ['backup'] : []), 'program', 'verify', ...(method === 'uart' ? [] : ['run'])];
        return order.map(id => ({ id, label: STEP_LABELS[id], state: id === 'build' ? 'done' : this.flashSteps[id] || 'pending' }));
    }

    // ── events from the sidecar (all windows receive them; filter by our ids) ──
    onEvent(event: string, data: unknown): void {
        const d = (data ?? {}) as Record<string, unknown>;
        switch (event) {
            case 'build.started':
                if (d.path === this.project?.path) { this.buildId = String(d.buildId); this.output.length = 0; this.appendOutput(`── 编译 · ${new Date().toLocaleTimeString()} ──`); }
                break;
            case 'build.progress':
                if (d.buildId === this.buildId) {
                    this.buildProgress = { done: Number(d.done), total: Number(d.total), file: String(d.file || '') };
                    const label = d.phase === 'configure' ? '配置工程' : `编译中 · ${this.buildProgress.file || '…'}`;
                    this.setTask(this.buildProgress.total ? `${label} ${this.buildProgress.done}/${this.buildProgress.total}` : label, 'busy', { target: 'output' });
                }
                break;
            case 'build.output':
                if (d.buildId === this.buildId) { this.appendOutput(String(d.line)); }
                break;
            case 'flash.started':
                if (d.path === this.project?.path) {
                    this.runId = String(d.runId); this.flashSteps = {}; this.flashPercent = undefined; this.romDetected = false;
                    this.appendOutput(`── 下载 · ${(d.erase as { label?: string })?.label ?? ''} · ${new Date().toLocaleTimeString()} ──`);
                }
                break;
            case 'flash.step':
                if (d.runId === this.runId) {
                    this.flashSteps[String(d.step)] = String(d.state); this.flashPercent = undefined;
                    if (d.step !== 'identify' || d.state === 'done') { this.awaitUser = this.awaitUser === 'enterBoot' ? undefined : this.awaitUser; }
                    this.setTask(this.stepText(), 'busy', { steps: this.steps(this.project?.flashMethod || 'stlink'), target: 'output' });
                }
                break;
            case 'flash.progress':
                if (d.runId === this.runId) { this.flashPercent = Number(d.percent); this.setTask(this.stepText(), 'busy', { steps: this.steps(this.project?.flashMethod || 'stlink'), target: 'output' }); }
                break;
            case 'flash.output':
                if (d.runId === this.runId) { this.appendOutput(String(d.line)); }
                break;
            case 'flash.awaitUser':
                if (d.runId === this.runId) { this.awaitUser = d.kind === 'exitBoot' ? 'exitBoot' : 'enterBoot'; this.fire(); }
                break;
            case 'flash.detected':
                if (d.runId === this.runId) { this.romDetected = true; this.fire(); }
                break;
            case 'monitor.state': {
                if (d.owner !== this.monitorOwner) { break; }
                const port = String(d.port || '');
                const state = String(d.state) as MonitorSnapshot['state'];
                if (state === 'open' && this.monitorOpenEpoch !== this.projectEpoch) { break; }
                if (state !== 'open' && this.monitor.session && d.session && d.session !== this.monitor.session) { break; }
                if (state !== 'open') { this.finishDecoder(); }
                this.monitor = { open: state === 'open', port, baud: Number(d.baud || this.monitor.baud), state,
                    session: d.session as string | undefined, owner: this.monitorOwner, message: d.message as string | undefined };
                if (d.message) { this.pushMonitor(String(d.message), 'system'); }
                this.fire();
                break;
            }
            case 'monitor.data':
                if (this.monitor.open && d.port === this.monitor.port && d.session === this.monitor.session) {
                    this.decode(String(d.data || ''));
                }
                break;
            case 'service.state':
                if (d.running === false) {
                    this.building = false; this.flashing = false;
                    this.finishDecoder();
                    this.monitor = { ...this.monitor, open: false, state: 'disconnected', message: '服务已停止，请手动重新连接。' };
                    this.setTask(String(d.message || 'STM32 服务已停止'), 'error');
                }
                break;
        }
    }

    onClangd(message: string): void { this.clangdMessage.fire(message); }

    private stepText(): string {
        const active = Object.entries(this.flashSteps).filter(([, s]) => s === 'running').map(([id]) => id).pop();
        if (!active) { return '下载中'; }
        const percent = this.flashPercent !== undefined ? ` ${Math.round(this.flashPercent)}%` : '';
        return `${STEP_LABELS[active] || active}${percent}${active === 'program' ? ' · 勿断电' : ''}`;
    }

    appendOutput(line: string): void {
        this.output.push(line);
        if (this.output.length > 4000) { this.output.splice(0, this.output.length - 4000); }
    }

    // ── markers ──
    private clearMarkers(): void {
        for (const uri of this.markerUris) { this.problems.setMarkers(new URI(uri), 'nodu-build', []); }
        this.markerUris.clear();
    }

    setDiagnostics(diagnostics: Diagnostic[]): void {
        this.clearMarkers();
        const byFile = new Map<string, LspDiagnostic[]>();
        for (const d of diagnostics) {
            if (!d.absolute || !d.line) { continue; }
            const uri = URI.fromFilePath(this.toLocal(d.absolute)).toString();
            const line = Math.max(0, d.line - 1);
            const character = Math.max(0, (d.column || 1) - 1);
            const message = d.explanation ? `${d.explanation.title}\n${d.explanation.explain}\n改法：${d.explanation.fix}\n\n编译器原文：${d.message}` : d.message;
            const list = byFile.get(uri) ?? [];
            list.push({ range: { start: { line, character }, end: { line, character } }, severity: d.severity === 'error' ? 1 : 2, message, source: 'Nodu 编译', code: d.explanation?.rule });
            byFile.set(uri, list);
        }
        for (const [uri, list] of byFile) { this.problems.setMarkers(new URI(uri), 'nodu-build', list); this.markerUris.add(uri); }
    }

    // ── serial monitor ──
    private decode(base64: string): void {
        try {
            const bytes = serialBytes(base64);
            this.addMonitorRecord({ bytes, text: this.decoder.push(bytes), direction: 'RX', kind: 'data', at: Date.now() });
        } catch { this.pushMonitor('收到的数据格式无效。', 'system'); }
    }

    private finishDecoder(): void {
        const tail = this.decoder.finish();
        if (tail) {
            const last = [...this.monitorLines].reverse().find(line => line.direction === 'RX' && line.bytes);
            if (last) { last.text += tail; this.monitorChanged.fire(); }
        }
    }

    private addMonitorRecord(record: MonitorLine): void {
        this.monitorLines.push(record);
        this.monitorBytes += record.bytes?.length ?? record.text.length * 2;
        while (this.monitorLines.length > MAX_LINES || this.monitorBytes > 1024 * 1024) {
            const removed = this.monitorLines.shift()!;
            this.monitorBytes -= removed.bytes?.length ?? removed.text.length * 2;
            this.monitorTrimmed = true;
        }
        this.monitorChanged.fire();
    }

    pushMonitor(text: string, kind: MonitorLine['kind']): void {
        this.addMonitorRecord({ text, kind, at: Date.now() });
    }

    clearMonitor(): void {
        this.monitorLines.length = 0; this.monitorBytes = 0; this.monitorTrimmed = false;
        this.decoder = new SerialTextDecoder(this.project?.manifest.monitor?.encoding === 'gbk' ? 'gbk' : 'utf-8');
        this.monitorChanged.fire();
    }

    /** Re-render retained raw RX bytes with a fresh stream decoder after an encoding change. */
    private redecodeMonitor(): void {
        this.decoder = new SerialTextDecoder(this.project?.manifest.monitor?.encoding === 'gbk' ? 'gbk' : 'utf-8');
        for (const line of this.monitorLines) {
            if (line.direction === 'RX' && line.bytes) { line.text = this.decoder.push(line.bytes); }
            else if (line.kind !== 'data') { this.decoder.finish(); }
        }
        this.monitorChanged.fire();
    }

    // ── device lists ──
    async refreshDevices(): Promise<void> {
        try {
            const [probes, ports] = await Promise.all([this.call<ProbeInfo[]>('listProbes'), this.call<PortInfo[]>('listPorts')]);
            this.probes = probes;
            this.ports = ports;
            if (this.probe && !probes.some(p => p.serial === this.probe)) { this.probe = ''; }
        } catch { /* the toolbar shows "未检测到" */ }
        this.fire();
    }

    async loadBackups(): Promise<void> {
        try { this.backups = await this.call<BackupRecord[]>('listBackups', this.identity?.uid ? { uid: this.identity.uid } : {}); } catch { this.backups = []; }
        this.fire();
    }

    setMonitorPort(port: string): void {
        if (this.monitor.open || this.monitorBusy || this.monitor.state === 'lent') { return; }
        this.monitorPort = port; localStorage.setItem('nodu.stm32.monitor-port', port); this.fire();
    }

    catalog(): Promise<{ boards: CatalogBoard[] }> { return this.call('catalog'); }

    // ── actions ──
    panelVisible = false;
    diagnosisOpen = false;
    private fadeTimer: ReturnType<typeof setTimeout> | undefined;

    /** Successful results fade after 4 s (UI-DESIGN §3.5); errors stay until the next task. */
    private settle(text: string, tone: Tone, extra: Partial<TaskStrip> = {}): void {
        this.setTask(text, tone, extra);
        clearTimeout(this.fadeTimer);
        if (tone === 'ok') {
            const task = this.task;
            this.fadeTimer = setTimeout(() => { if (this.task === task) { this.task = undefined; this.fire(); } }, 4000);
        }
    }

    fail(error: unknown, what: string): void {
        const failure: EmbeddedFailure = error instanceof EmbeddedError ? error.failure : { message: error instanceof Error ? error.message : String(error), code: 'error' };
        this.lastError = failure;
        if (failure.code === 'cancelled') { this.settle('已停止', 'warn'); return; }
        const output = (failure.detail as { output?: string } | undefined)?.output;
        if (output) { for (const line of output.split('\n')) { this.appendOutput(line); } }
        this.settle(`${what}失败 · ${failure.message}`, 'error', { target: 'device' });
    }

    async build(clean = false): Promise<BuildResult | undefined> {
        const project = this.project, epoch = this.projectEpoch;
        if (!project || this.building || this.flashing) { return undefined; }
        this.building = true;
        this.lastError = undefined;
        this.buildProgress = undefined;
        this.setTask('编译中', 'busy', { target: 'output' });
        try {
            const result = await this.call<BuildResult>('build', { path: project.path, clean });
            if (epoch !== this.projectEpoch) { return undefined; }
            this.lastBuild = result;
            this.setDiagnostics(result.diagnostics);
            if (!result.ok) {
                const counts = result.errors ? `${result.errors} 个错误${result.warnings ? ` · ${result.warnings} 个警告` : ''}` : '工程配置失败';
                this.settle(counts, 'error', { target: 'problems' });
            } else if (result.stale) {
                this.settle('编译期间有文件被修改，这次结果已过期。再编译一次。', 'warn', { target: 'output' });
            } else {
                const flash = result.capacity?.FLASH;
                const size = flash ? ` · Flash ${formatBytes(flash.used)} / ${formatBytes(flash.size)}` : '';
                const warn = result.warnings ? ` · ${result.warnings} 个警告` : '';
                this.settle(`编译成功${size}${warn} · ${(result.ms / 1000).toFixed(1)} s`, 'ok', { target: result.warnings ? 'problems' : 'output' });
            }
            await this.reload().catch(() => undefined);
            return result;
        } catch (error) {
            if (epoch !== this.projectEpoch) { return undefined; }
            if (error instanceof EmbeddedError && error.code === 'untrusted') { throw error; }
            this.fail(error, '编译');
            return undefined;
        } finally {
            this.building = false;
            this.buildProgress = undefined;
            this.fire();
        }
    }

    /** Build and download. UART monitoring is an independent, manual action. */
    async run(): Promise<boolean> {
        const project = this.project, epoch = this.projectEpoch;
        if (!project || this.busy) { return false; }
        const method = project.flashMethod, selectedPort = this.monitorPort, probe = this.probe;
        const targetUnchanged = (): boolean => epoch === this.projectEpoch && this.project?.flashMethod === method && this.monitorPort === selectedPort && this.probe === probe;
        const built = await this.build();
        if (!targetUnchanged() || !built?.ok || built.stale || !built.artifact) { return false; }
        const port = method === 'uart' ? selectedPort : '';
        if (method === 'uart' && !port) {
            this.settle('串口下载需要先选择串口', 'error', { target: 'device' });
            this.lastError = { code: 'noPort', message: '串口下载需要先在设备弹层中选择 USB 转串口。' };
            return false;
        }
        const releaseMonitor = await this.confirmMonitorRelease(method, port);
        if (releaseMonitor === undefined || !targetUnchanged()) { return false; }
        this.flashing = true;
        this.flashSteps = {};
        this.lastError = undefined;
        this.setTask('识别开发板', 'busy', { steps: this.steps(method), target: 'output' });
        try {
            const result = await this.call<FlashResult>('flash', { path: project.path, bundle: built.artifact.bundleSha256, method, probe: probe || undefined, port: port || undefined, releaseMonitor, monitorOwner: this.monitorOwner, monitorSession: this.monitor.session });
            if (epoch !== this.projectEpoch) { return false; }
            this.lastFlash = result;
            this.identity = { ...result.identity, matches: null, hasBackup: true };
            if (result.backup) { this.appendOutput(`已备份出厂程序：${result.backup.id}（${formatBytes(result.backup.bytes)}）`); }
            if (result.needsBootRestore) {
                this.awaitUser = 'exitBoot';
                this.settle('已写入并校验 · 把 BOOT0 接回 0，再按复位键', 'ok', { target: 'output' });
            } else {
                const running = result.running === true ? '运行状态已确认' : result.running === false ? '程序没有运行（心跳未变化）' : '下载完成 · 运行状态未确认';
                this.settle(`${running}${this.monitor.open ? ' · 串口已连接' : ''} · 写入 ${result.erase.label}`, result.running === false ? 'warn' : 'ok', { target: 'output' });
            }
            void this.loadBackups();
            return true;
        } catch (error) {
            if (epoch !== this.projectEpoch) { return false; }
            this.fail(error, '下载');
            return false;
        } finally {
            this.flashing = false;
            this.fire();
        }
    }

    async stop(): Promise<void> {
        if (this.building) { await this.call('cancel', { queue: 'build' }).catch(() => undefined); }
        if (this.flashing || this.identifying) {
            const writing = this.flashSteps.program === 'running' || this.flashSteps.verify === 'running';
            await this.call('cancel', { queue: 'device' }).catch(() => undefined);
            if (writing) { this.setTask('写入完成后停止', 'warn'); }
        }
        if (this.awaitUser === 'exitBoot') { this.awaitUser = undefined; this.fire(); }
    }

    /** User acknowledgement only: no assertion that firmware ran, and no serial side effect. */
    async finishBoot(): Promise<void> {
        this.awaitUser = undefined;
        this.settle('已确认恢复 BOOT 配置并复位 · 串口监视请手动连接', 'ok', { target: 'output' });
    }

    private async confirmMonitorRelease(method: string, port: string): Promise<boolean | undefined> {
        if (method !== 'uart' || !this.monitor.open || this.monitor.port !== port) { return false; }
        const session = this.monitor.session;
        const yes = await new ConfirmDialog({ title: '将串口交给下载',
            msg: `${port} 正在监视。继续会断开监视并暂停发送；日志和输入保留。下载后恢复 BOOT 配置并复位，再手动连接串口。`,
            ok: '断开并下载', cancel: '取消' }).open();
        return yes === true && session === this.monitor.session && this.monitor.open ? true : undefined;
    }

    /** Called only by an explicit Connect action. */
    async ensureMonitor(): Promise<void> {
        const port = this.monitorPort, epoch = this.projectEpoch;
        if (!this.project || !port || this.monitor.open || this.monitorBusy || this.monitor.state === 'lent' || this.awaitUser === 'exitBoot') { return; }
        this.monitorBusy = true;
        this.monitorOpenEpoch = epoch;
        this.monitorSendError = '';
        this.monitor = { ...this.monitor, port, session: undefined, state: 'connecting', message: undefined };
        this.fire();
        try {
            this.finishDecoder();
            this.decoder = new SerialTextDecoder(this.project.manifest.monitor?.encoding === 'gbk' ? 'gbk' : 'utf-8');
            const status = await this.call<MonitorSnapshot>('openMonitor', { port, baud: this.project.manifest.monitor?.baud ?? 115200, owner: this.monitorOwner });
            if (epoch !== this.projectEpoch) {
                if (status.session) { await this.call('closeMonitor', { owner: this.monitorOwner, session: status.session }).catch(() => undefined); }
                this.monitor = { ...this.monitor, open: false, state: 'closed' };
                return;
            }
            // A disconnect event may have overtaken the RPC response.
            if (this.monitor.state === 'connecting' || this.monitor.state === 'open') {
                this.monitor = { ...status, state: status.open ? 'open' : 'disconnected' };
            }
            if (this.monitor.open) { this.pushMonitor(`已连接 ${port} · ${status.baud}`, 'system'); }
        } catch (error) {
            this.monitor = { ...this.monitor, open: false, state: 'disconnected', message: error instanceof Error ? error.message : String(error) };
            this.pushMonitor(this.monitor.message!, 'system');
        } finally { this.monitorBusy = false; this.fire(); }
    }

    async toggleMonitor(): Promise<void> {
        if (this.monitorBusy || this.monitor.state === 'lent') { return; }
        if (!this.monitor.open) { await this.ensureMonitor(); return; }
        this.monitorBusy = true; this.fire();
        try { await this.call('closeMonitor', { owner: this.monitorOwner, session: this.monitor.session }); this.finishDecoder(); this.monitor = { ...this.monitor, open: false, state: 'closed' }; }
        catch (error) { this.fail(error, '断开串口'); }
        finally { this.monitorBusy = false; this.fire(); }
    }

    async sendMonitorBytes(bytes: Uint8Array): Promise<boolean> {
        if (!this.monitor.open || this.monitorSending || this.monitorBusy || this.monitorOpenEpoch !== this.projectEpoch) { return false; }
        if (!bytes.length || bytes.length > 64 * 1024) { this.monitorSendError = '一次发送 1–65536 字节。'; this.fire(); return false; }
        this.monitorSending = true; this.monitorSendError = ''; this.fire();
        try {
            const result = await this.call<MonitorWriteResult>('writeMonitor', { data: serialBase64(bytes), owner: this.monitorOwner, session: this.monitor.session });
            if (result.sent !== bytes.length) { throw new Error('写入长度未确认，请检查设备状态后再决定是否重试。'); }
            this.addMonitorRecord({ text: new TextDecoder().decode(bytes), bytes: bytes.slice(), direction: 'TX', kind: 'data', at: Date.now() });
            return true;
        } catch (error) {
            this.monitorSendError = `${error instanceof Error ? error.message : String(error)} 可能已发送部分字节；输入已保留，不会自动重试。`;
            return false;
        } finally { this.monitorSending = false; this.fire(); }
    }

    async sendMonitor(text: string): Promise<boolean> { return this.sendMonitorBytes(new TextEncoder().encode(text)); }

    async identify(): Promise<void> {
        if (!this.project || this.busy || this.project.flashMethod !== 'stlink') { return; }
        this.identifying = true;
        this.lastError = undefined;
        this.fire();
        try {
            this.identity = await this.call<ChipIdentity>('identify', { path: this.project.path, probe: this.probe || undefined });
            await this.loadBackups();
        } catch (error) {
            this.identity = undefined;
            this.fail(error, '识别');
        } finally {
            this.identifying = false;
            this.fire();
        }
    }

    async reset(): Promise<void> {
        if (!this.project || this.busy) { return; }
        try {
            await this.call('reset', { path: this.project.path, probe: this.probe || undefined });
            this.settle('已复位开发板', 'ok');
        } catch (error) { this.fail(error, '复位'); }
    }

    async setOption(key: string, value: unknown): Promise<void> {
        const project = this.project, epoch = this.projectEpoch;
        if (!project || (key === 'monitorBaud' && (this.monitor.open || this.monitorBusy))) { return; }
        try { const next = await this.call<ProjectStatus>('setProjectOption', { path: project.path, key, value }); if (epoch !== this.projectEpoch) { return; } this.project = next; if (key === 'monitorEncoding') { this.redecodeMonitor(); } this.fire(); } catch (error) { this.fail(error, '保存设置'); }
    }

    async restore(backup: BackupRecord): Promise<void> {
        const project = this.project, epoch = this.projectEpoch;
        const port = this.monitorPort, probe = this.probe;
        if (!project || this.busy) { return; }
        const releaseMonitor = await this.confirmMonitorRelease(project.flashMethod, this.monitorPort);
        if (releaseMonitor === undefined || epoch !== this.projectEpoch || port !== this.monitorPort || probe !== this.probe || project.flashMethod !== this.project?.flashMethod) { return; }
        this.flashing = true;
        this.flashSteps = {};
        this.setTask('恢复备份', 'busy', { steps: this.steps(project.flashMethod) });
        try {
            const result = await this.call<FlashResult>('restore', { path: project.path, backup: backup.id, method: project.flashMethod, probe: probe || undefined, port: port || undefined, releaseMonitor, monitorOwner: this.monitorOwner, monitorSession: this.monitor.session });
            if (epoch !== this.projectEpoch) { return; }
            if (result.needsBootRestore) { this.awaitUser = 'exitBoot'; }
            this.settle(`已恢复 ${backup.createdAt.slice(0, 10)} 的备份，读回一致${result.needsBootRestore ? ' · 恢复 BOOT 配置并复位后手动连接串口' : ''}`, 'ok', { target: 'output' });
            // The restored program is not this project's build.
            this.lastFlash = undefined;
        } catch (error) {
            if (epoch !== this.projectEpoch) { return; }
            this.fail(error, '恢复');
        } finally {
            this.flashing = false;
            this.fire();
        }
    }
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) { return `${(bytes / 1024 / 1024).toFixed(bytes % (1024 * 1024) ? 1 : 0)} MB`; }
    if (bytes >= 1024) { return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`; }
    return `${bytes} B`;
}
