// SPDX-License-Identifier: MIT
import { MonitorBytes } from '../common/nodu-monitor-bytes';
import { preferredMonitorPort } from '../common/nodu-monitor-ports';
import { MonitorDecoder, hasMonitorStartupLine } from '../common/nodu-monitor-decoder';
import { MessageService } from '@theia/core/lib/common';
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
    EmbeddedMethod, FlashResult, NODU_EMBEDDED_PATH, NoduEmbeddedService, PortInfo, ProbeInfo, ProjectStatus
} from '../common/nodu-embedded-protocol';

export type Tone = 'busy' | 'ok' | 'error' | 'warn';
export interface TaskStrip { text: string; tone: Tone; steps?: { id: string; label: string; state: string }[]; target?: 'problems' | 'output' | 'device' | 'monitor'; at: number }
export interface MonitorLine { text: string; kind: 'data' | 'separator' | 'system'; at?: number }
export type PanelTab = 'problems' | 'monitor' | 'output';

/** Thrown by `call` with the sidecar's stable code and tool output. */
export class EmbeddedError extends Error {
    constructor(readonly failure: EmbeddedFailure) { super(failure.message); }
    get code(): string { return this.failure.code; }
}

const STEP_LABELS: Record<string, string> = { build: '编译', identify: '识别', backup: '首次备份', program: '写入', verify: '校验', run: '运行' };
const MAX_LINES = 10_000;

/** STM32 HAL project state for this window (FUNCTIONAL-DESIGN §10.3). */
@injectable()
export class NoduEmbeddedModel implements EmbeddedClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(ProblemManager) protected readonly problems!: ProblemManager;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    private service!: NoduEmbeddedService;
    private readonly changed = new Emitter<void>();
    private readonly monitorChanged = new Emitter<void>();
    private readonly projectChanged = new Emitter<ProjectStatus | undefined>();
    readonly onDidChange = this.changed.event;
    readonly onDidMonitor = this.monitorChanged.event;
    readonly onDidChangeProject = this.projectChanged.event;
    private cProjectKey!: ContextKey<boolean>;
    private espProjectKey!: ContextKey<boolean>;
    isEsp = false;
    espChip = '';

    project: ProjectStatus | undefined;
    building = false;
    buildProgress: { done: number; total: number; file: string } | undefined;
    lastBuild: BuildResult | undefined;
    diagnosticsStale = false;
    private sourceRevision = 0;
    flashing = false;
    flashSteps: Record<string, string> = {};
    flashPercent: number | undefined;
    awaitUser: 'enterBoot' | 'exitBoot' | undefined;
    romDetected = false;
    private bootOutputSeen = false;
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
    monitor = { open: false, port: '', baud: 115200, state: 'closed', message: '' as string | undefined };
    readonly monitorLines: MonitorLine[] = [];
    readonly output: string[] = [];
    panelTab: PanelTab = 'problems';
    runCount = 0;
    readonly monitorBytes = new MonitorBytes();
    monitorError = '';
    monitorBusy = false;
    private portRefresh: Promise<void> | undefined;
    private partial = '';
    monitorPartialAt: number | undefined;
    private readonly decoder = new MonitorDecoder();
    private buildId = '';
    private runId = '';
    private markerUris = new Set<string>();
    /** Workspace root as the editor sees it; the sidecar reports the canonical (symlink-free) path. */
    private detection = 0;
    private readonly externalAsked = new Set<string>();
    private localRoot = '';

    toLocal(path: string): string {
        const root = this.project?.path;
        return root && this.localRoot && this.localRoot !== root && (path === root || path.startsWith(root + '/') || path.startsWith(root + '\\')) ? this.localRoot + path.slice(root.length) : path;
    }

    toCanonical(path: string): string {
        const root = this.project?.path;
        return root && this.localRoot && this.localRoot !== root && (path === this.localRoot || path.startsWith(this.localRoot + '/') || path.startsWith(this.localRoot + '\\')) ? root + path.slice(this.localRoot.length) : path;
    }

    @postConstruct()
    protected init(): void {
        this.cProjectKey = this.contextKeys.createKey<boolean>('nodu.cProject', false);
        this.espProjectKey = this.contextKeys.createKey<boolean>('nodu.espProject', false);
        this.service = this.connections.createProxy<NoduEmbeddedService>(NODU_EMBEDDED_PATH, this);
        this.workspace.onWorkspaceChanged(roots => void this.detect(roots[0]?.resource));
        void this.workspace.roots.then(roots => this.detect(roots[0]?.resource));
        this.monitorPort = localStorage.getItem('nodu.stm32.monitor-port') || '';
    }

    get isC(): boolean { return !!this.project; }
    get busy(): boolean { return this.building || this.flashing || this.identifying; }
    get errors(): Diagnostic[] { return this.diagnosticsStale ? [] : this.lastBuild?.diagnostics.filter(d => d.severity === 'error') ?? []; }
    get rpc(): NoduEmbeddedService { return this.service; }

    fire(): void { this.changed.fire(); }

    async call<T>(method: EmbeddedMethod, args: Record<string, unknown> = {}): Promise<T> {
        const outcome: CallOutcome = await this.service.call(method, args);
        if (!outcome.ok) { throw new EmbeddedError(outcome.error); }
        return outcome.result as T;
    }

    /** A folder is a C project when its nodu.json says `kind: stm32-hal`. */
    async detect(root: URI | undefined): Promise<void> {
        const generation = ++this.detection;
        let project: ProjectStatus | undefined;
        let espChip = '';
        if (root) {
            try {
                const manifest = root.resolve('nodu.json');
                if (await this.files.exists(manifest)) {
                    const text = (await this.files.read(manifest)).value;
                    const metadata = JSON.parse(text) as { kind?: string; target?: { mcu?: string } };
                    if (metadata.kind === 'esp-idf') { espChip = metadata.target?.mcu || 'esp32'; }
                    if (metadata.kind === 'stm32-hal') {
                        project = await this.call<ProjectStatus>('openProject', { path: root.path.fsPath() });
                    }
                } else if (await this.files.exists(root.resolve('CMakeLists.txt')) && !this.externalAsked.has(root.toString())) {
                    this.externalAsked.add(root.toString());
                    const detected = await this.call<{ board: string | null } | null>('detectExternal', { path: root.path.fsPath() });
                    if (detected && generation === this.detection) {
                        let board = detected.board;
                        if (!board) {
                            const boards = (await this.catalog()).boards.filter(b => b.id.startsWith('chip-'));
                            const choice = await this.messages.info('检测到 CubeMX 工程，请确认芯片型号。仅在与硬件一致时选择。', ...boards.map(b => b.chipName));
                            board = boards.find(b => b.chipName === choice)?.reference ?? null;
                        }
                        if (board && await this.messages.info('作为 STM32 工程打开？编译前会单独确认信任。', '作为 STM32 工程打开') && generation === this.detection) {
                            project = await this.call<ProjectStatus>('importExternal', { path: root.path.fsPath(), board });
                        }
                    }
                }
            } catch (error) {
                this.setTask(`STM32 工程无法打开：${error instanceof Error ? error.message : String(error)}`, 'error');
            }
        }
        if (generation !== this.detection) { return; }
        const switched = project?.path !== this.project?.path;
        this.localRoot = root?.path.fsPath() ?? '';
        this.project = project;
        this.isEsp = !!espChip; this.espChip = espChip;
        this.espProjectKey.set(this.isEsp);
        this.cProjectKey.set(!!project);
        if (switched) { this.clearMarkers(); this.lastBuild = undefined; this.diagnosticsStale = false; this.identity = undefined; this.projectChanged.fire(project); }
        if (project) { void this.refreshDevices(); void this.syncMonitor(); }
        this.fire();
    }

    async reload(): Promise<void> {
        if (!this.project) { return; }
        const old = this.project;
        this.project = await this.call<ProjectStatus>('openProject', { path: old.path });
        this.fire();
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
                if (d.path === this.project?.path) { this.buildId = String(d.buildId); this.output.length = 0; this.appendOutput(`── 编译，${new Date().toLocaleTimeString()} ──`); }
                break;
            case 'build.progress':
                if (d.buildId === this.buildId) {
                    this.buildProgress = { done: Number(d.done), total: Number(d.total), file: String(d.file || '') };
                    const label = d.phase === 'configure' ? '配置工程' : '编译中';
                    this.setTask(this.buildProgress.total ? `${label} ${this.buildProgress.done}/${this.buildProgress.total}` : label, 'busy', { target: 'output' });
                }
                break;
            case 'build.output':
                if (d.buildId === this.buildId) { this.appendOutput(String(d.line)); }
                break;
            case 'flash.started':
                if (d.path === this.project?.path) {
                    this.runId = String(d.runId); this.flashSteps = {}; this.flashPercent = undefined; this.romDetected = false;
                    this.awaitUser = undefined; this.bootOutputSeen = false;
                    this.appendOutput(`── 下载，${(d.erase as { label?: string })?.label ?? ''}，${new Date().toLocaleTimeString()} ──`);
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
                if (d.runId === this.runId) { this.romDetected = true; this.awaitUser = undefined; this.fire(); }
                break;
            case 'monitor.state':
                this.monitor = { open: d.state === 'open' || d.state === 'disconnected' || d.state === 'lent', port: String(d.port || ''), baud: Number(d.baud || this.monitor.baud), state: String(d.state), message: d.message as string | undefined };
                if (d.state === 'closed' || d.state === 'disconnected' || d.state === 'lent') { this.partial += this.decoder.finish(); }
                if (d.state === 'closed') { this.monitor.open = false; }
                if (d.message) { this.pushMonitor(String(d.message), 'system'); }
                this.fire();
                break;
            case 'monitor.data':

                if (!d.port || d.port === this.monitor.port) { this.decode(String(d.data || '')); }
                break;
            case 'service.state':
                if (d.running === false) { this.building = false; this.flashing = false; this.setTask(String(d.message || 'STM32 服务已停止'), 'error'); }
                break;
        }
    }


    private stepText(): string {
        const active = Object.entries(this.flashSteps).filter(([, s]) => s === 'running').map(([id]) => id).pop();
        if (!active) { return '下载中'; }
        const percent = this.flashPercent !== undefined ? ` ${Math.round(this.flashPercent)}%` : '';
        return `${STEP_LABELS[active] || active}${percent}${active === 'program' ? '，勿断电' : ''}`;
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
        if (!this.partial) { this.monitorPartialAt = Date.now(); }
        const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
        this.monitorBytes.append(bytes);
        const encoding = this.project?.manifest.monitor?.encoding === 'gbk' ? 'gbk' : 'utf-8';
        const text = this.partial + this.decoder.decode(bytes, encoding);
        const lines = text.split(/\r?\n/);
        this.partial = lines.pop() ?? '';
        for (const line of lines) { this.pushMonitor(line.replace(/\r/g, ''), 'data', false); }
        if (this.awaitUser === 'exitBoot' && hasMonitorStartupLine(lines)) {
            this.bootOutputSeen = true;
            this.awaitUser = undefined;
            this.settle('运行中', 'ok', { target: 'monitor' });
        }
        while (this.partial.length > 16_384) { this.pushMonitor(this.partial.slice(0, 16_384), 'data', false); this.partial = this.partial.slice(16_384); }
        this.monitorChanged.fire();
    }

    get monitorPartial(): string { return this.partial; }

    pushMonitor(text: string, kind: MonitorLine['kind'], notify = true): void {
        if (kind !== 'data') { this.partial += this.decoder.finish(); }
        if (kind !== 'data' && this.partial) { this.monitorLines.push({ text: this.partial, kind: 'data', at: this.monitorPartialAt }); this.partial = ''; }
        this.monitorLines.push({ text, kind, at: Date.now() });
        if (this.monitorLines.length > MAX_LINES) { this.monitorLines.splice(0, this.monitorLines.length - MAX_LINES); }
        if (notify) { this.monitorChanged.fire(); }
    }

    clearMonitor(): void { this.monitorLines.length = 0; this.partial = ''; this.monitorPartialAt = undefined; this.decoder.clear(); this.monitorBytes.clear(); this.monitorChanged.fire(); }

    sourceChanged(path: string, fromEditor = false): void {
        const root = this.project?.path;
        if (!root) { return; }
        const canonical = this.toCanonical(path).replace(/\\/g, '/');
        if (!canonical.startsWith(root.replace(/\\/g, '/') + '/')) { return; }
        const relative = canonical.slice(root.length + 1);
        if (/^(build|\.nodu|\.git)\//.test(relative) || !/\.(c|h|cpp|hpp|s|ld|cmake)$|(^|\/)(CMakeLists\.txt|CMakePresets\.json|nodu\.json)$/i.test(relative)) { return; }
        if (fromEditor) { this.sourceRevision++; }
        if (this.lastBuild) { this.diagnosticsStale = true; this.clearMarkers(); }
        this.fire();
    }

    // ── device lists ──
    async refreshDevices(): Promise<void> {
        await Promise.all([this.refreshPorts(), this.call<ProbeInfo[]>('listProbes').then(probes => {
            this.probes = probes;
            if (this.probe && !probes.some(p => p.serial === this.probe)) { this.probe = ''; }
            this.fire();
        }).catch(() => undefined)]);
    }

    refreshPorts(): Promise<void> {
        if (this.portRefresh) { return this.portRefresh; }
        this.portRefresh = this.call<PortInfo[]>('listPorts').then(ports => {
            const next = preferredMonitorPort(this.monitorPort, ports);
            const changed = JSON.stringify(ports) !== JSON.stringify(this.ports) || next !== this.monitorPort;
            this.ports = ports;
            this.monitorPort = next;
            if (changed) { this.fire(); }
        }).catch(() => undefined).finally(() => { this.portRefresh = undefined; });
        return this.portRefresh;
    }

    async loadBackups(): Promise<void> {
        try { this.backups = await this.call<BackupRecord[]>('listBackups', this.identity?.uid ? { uid: this.identity.uid } : {}); } catch { this.backups = []; }
        this.fire();
    }

    setMonitorPort(port: string): void {
        this.monitorPort = port; localStorage.setItem('nodu.stm32.monitor-port', port); this.monitorError = ''; this.fire();
        if (this.monitor.open) { void this.changeMonitor(() => port ? this.openSelectedMonitor() : this.call('closeMonitor')); }
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
        if (failure.code === 'cancelled') { this.lastError = undefined; this.settle('已停止', 'warn'); return; }
        const output = (failure.detail as { output?: string } | undefined)?.output;
        if (output) { for (const line of output.split('\n')) { this.appendOutput(line); } }
        this.settle(`${what}失败：${failure.message}`, 'error', { target: 'device' });
    }

    async build(clean = false): Promise<BuildResult | undefined> {
        const project = this.project;
        if (!project || this.building || this.flashing) { return undefined; }
        const sourceRevision = this.sourceRevision;
        this.building = true;
        this.lastError = undefined;
        this.buildProgress = undefined;
        this.setTask('编译中', 'busy', { target: 'output' });
        try {
            const result = await this.call<BuildResult>('build', { path: project.path, clean });
            result.stale = !!result.stale || sourceRevision !== this.sourceRevision;
            this.lastBuild = result;
            this.diagnosticsStale = !!result.stale;
            if (this.diagnosticsStale) { this.clearMarkers(); } else { this.setDiagnostics(result.diagnostics); }
            if (!result.ok) {
                const counts = result.errors ? `${result.errors} 个错误${result.warnings ? `，${result.warnings} 个警告` : ''}` : '工程配置失败';
                this.settle(counts, 'error', { target: 'problems' });
            } else if (result.stale) {
                this.settle('编译期间有文件被修改，这次结果已过期。再编译一次。', 'warn', { target: 'output' });
            } else {
                const label = result.warnings ? `编译成功（${result.warnings} 个警告）` : '编译成功';
                this.settle(label, 'ok', { target: result.warnings ? 'problems' : 'output' });
            }
            await this.reload().catch(() => undefined);
            return result;
        } catch (error) {
            if (error instanceof EmbeddedError && error.code === 'untrusted') { throw error; }
            this.fail(error, '编译');
            return undefined;
        } finally {
            this.building = false;
            this.buildProgress = undefined;
            this.fire();
        }
    }

    /** 运行: build if needed, download, start, show serial output (F1). */
    async run(compatibleConfirmed = false): Promise<boolean> {
        const project = this.project;
        if (!project || this.busy) { return false; }
        this.awaitUser = undefined;
        const built = await this.build();
        if (!built?.ok || built.stale || !built.artifact) { return false; }
        const method = this.project?.flashMethod ?? project.flashMethod;
        const port = method === 'uart' ? this.monitorPort : '';
        if (method === 'uart' && !port) {
            this.settle('串口下载需要先选择串口', 'error', { target: 'device' });
            this.lastError = { code: 'noPort', message: '串口下载需要先在设备弹层中选择 USB 转串口。' };
            return false;
        }
        // ST-LINK leaves the serial port free: open the monitor first to catch the first lines.
        if (method === 'stlink') { await this.ensureMonitor().catch(() => undefined); }
        this.runCount += 1;
        this.pushMonitor(`── 运行 #${this.runCount}，${new Date().toLocaleTimeString()}，${built.artifact.bundleSha256.slice(0, 7)} ──`, 'separator');
        this.flashing = true;
        this.flashSteps = {};
        this.lastError = undefined;
        this.setTask('识别开发板', 'busy', { steps: this.steps(method), target: 'output' });
        try {
            const result = await this.call<FlashResult>('flash', { path: project.path, bundle: built.artifact.bundleSha256, compatibleConfirmed, method, probe: this.probe || undefined, port: port || undefined });
            this.lastFlash = result;
            this.identity = { ...result.identity, matches: null, hasBackup: true };
            if (result.backup) { this.appendOutput(`已保存首次备份：${result.backup.id}（${formatBytes(result.backup.bytes)}）`); }
            if (result.needsBootRestore) {
                await this.ensureMonitor().catch(error => { this.monitorError = error instanceof Error ? error.message : String(error); });
                this.awaitUser = this.bootOutputSeen ? undefined : 'exitBoot';
                this.setTask(this.bootOutputSeen ? '运行中' : '等待复位', this.bootOutputSeen ? 'ok' : 'warn', { target: 'monitor' });
            } else {
                if (result.autoBoot) { await this.ensureMonitor().catch(() => undefined); }
                const running = result.running === false ? '程序没有运行（心跳未变化）' : result.autoBoot ? '已请求运行' : '运行中';
                this.settle(running, result.running === false ? 'warn' : 'ok', { target: 'monitor' });
            }
            void this.loadBackups();
            return true;
        } catch (error) {
            this.awaitUser = method === 'uart' && this.romDetected && !project.manifest.flash?.autoBoot?.enabled ? 'exitBoot' : undefined;
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

    /** The user moved BOOT0 back and pressed reset (serial ISP, page 2 of the guide). */
    async finishBoot(): Promise<void> {
        try {
            await this.ensureMonitor();
            this.awaitUser = undefined;
            this.settle('串口已打开', 'ok', { target: 'monitor' });
        } catch (error) { this.fail(error, '打开串口'); }
    }

    private async syncMonitor(): Promise<void> {
        try {
            const status = await this.call<{ open: boolean; port?: string; baud?: number; state?: string }>('monitorStatus');
            this.monitor = { open: status.open, port: status.port || '', baud: status.baud || 115200, state: status.state || (status.open ? 'open' : 'closed'), message: undefined };
            if (status.open && status.port) { this.monitorPort = status.port; }
            this.fire();
        } catch { /* The next user action reports an unavailable service. */ }
    }

    private async openSelectedMonitor(): Promise<void> {
        await this.call('openMonitor', { path: this.project?.path, port: this.monitorPort, baud: this.project?.manifest.monitor?.baud ?? 115200 });
    }

    private async changeMonitor(action: () => Promise<unknown>): Promise<void> {
        if (this.monitorBusy) { return; }
        this.monitorBusy = true; this.monitorError = ''; this.fire();
        try { await action(); } catch (error) { this.monitorError = error instanceof Error ? error.message : String(error); }
        finally { await this.syncMonitor(); this.monitorBusy = false; this.fire(); }
    }

    async ensureMonitor(): Promise<void> {
        const baud = this.project?.manifest.monitor?.baud ?? 115200;
        if (!this.project || !this.monitorPort || (this.monitor.open && this.monitor.port === this.monitorPort && this.monitor.baud === baud)) { return; }
        await this.openSelectedMonitor();
    }

    async toggleMonitor(): Promise<void> {
        await this.changeMonitor(() => this.monitor.open ? this.call('closeMonitor') : this.openSelectedMonitor());
    }

    async sendMonitor(text: string): Promise<boolean> {
        if (this.flashing || this.awaitUser === 'exitBoot') { return false; }
        try {
            await this.call('writeMonitor', { text, encoding: this.project?.manifest.monitor?.encoding ?? 'utf-8' });
            this.monitorError = ''; this.fire(); return true;
        } catch (error) { this.monitorError = error instanceof Error ? error.message : String(error); this.fire(); return false; }
    }

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
        if (!this.project) { return; }
        const path = this.project.path;
        const save = async (): Promise<void> => {
            this.project = await this.call<ProjectStatus>('setProjectOption', { path, key, value });
            if (key === 'preset') { this.projectChanged.fire(this.project); }
            this.fire();
        };
        if (key === 'monitorBaud' && this.monitor.open) {
            await this.changeMonitor(async () => { await save(); await this.openSelectedMonitor(); });
        } else {
            try { await save(); } catch (error) { this.fail(error, '保存设置'); }
        }
    }

    settingsChanged(project: ProjectStatus): void {
        this.project = project; this.sourceChanged(`${project.path}/nodu.json`); this.projectChanged.fire(project); this.fire();
    }

    async restore(backup: BackupRecord, compatibleConfirmed = false): Promise<void> {
        const project = this.project;
        if (!project || this.busy) { return; }
        this.awaitUser = undefined;
        this.flashing = true;
        this.flashSteps = {};
        this.setTask('恢复备份', 'busy', { steps: this.steps(project.flashMethod) });
        try {
            const result = await this.call<FlashResult>('restore', { path: project.path, backup: backup.id, compatibleConfirmed, probe: this.probe || undefined, port: this.monitorPort || undefined });
            this.identity = { ...result.identity, matches: null, hasBackup: true };
            if (project.flashMethod === 'uart') {
                await this.ensureMonitor().catch(() => undefined);
                this.awaitUser = result.needsBootRestore && !this.bootOutputSeen ? 'exitBoot' : undefined;
            }
            this.settle(this.awaitUser ? '已恢复，等待复位' : '已恢复，读回一致', this.awaitUser ? 'warn' : 'ok');
            // The restored program is not this project's build.
            this.lastFlash = undefined;
        } catch (error) {
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
