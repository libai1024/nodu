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
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
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
    @inject(EditorManager) protected readonly editors!: EditorManager;
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
    private monitorPortExplicit = false;
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
    private preparingFlash = false;
    private downloadIntent = 0;
    private activeDownloadIntent: number | undefined;
    private cancelledFlashRun = '';
    private stopFailure: EmbeddedFailure | undefined;
    private deviceRevision = 0;
    private probeRefresh = 0;
    private backupRefresh = 0;
    private identityProbe = '';
    private identityPort = '';
    private flashIncludesBuild = true;
    private optionSaveQueue: Promise<void> = Promise.resolve();
    private optionSaveCount = 0;
    private optionErrorTask: TaskStrip | undefined;
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
        const savedPort = localStorage.getItem('nodu.stm32.monitor-port');
        this.monitorPort = savedPort || '';
        this.monitorPortExplicit = savedPort !== null;
    }

    get isC(): boolean { return !!this.project; }
    get busy(): boolean { return this.building || this.flashing || this.identifying || this.preparingFlash || this.savingOptions; }
    get savingOptions(): boolean { return this.optionSaveCount > 0; }
    get projectGeneration(): number { return this.detection; }
    get backupScope(): 'device' | 'history' { return this.identity?.uid ? 'device' : 'history'; }
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
        const targetChanged = this.hasTargetChanged(project);
        this.localRoot = root?.path.fsPath() ?? '';
        this.project = project;
        this.isEsp = !!espChip; this.espChip = espChip;
        this.espProjectKey.set(this.isEsp);
        this.cProjectKey.set(!!project);
        if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
        if (switched) { this.buildId = ''; this.runId = ''; this.cancelledFlashRun = ''; this.awaitUser = undefined; this.lastFlash = undefined; this.clearMarkers(); this.lastBuild = undefined; this.diagnosticsStale = false; this.projectChanged.fire(project); }
        if (project) { void this.refreshDevices(); void this.syncMonitor(); }
        this.fire();
    }

    async reload(): Promise<void> {
        if (!this.project) { return; }
        const old = this.project, generation = this.detection;
        const updated = await this.call<ProjectStatus>('openProject', { path: old.path });
        if (generation !== this.detection || this.project?.path !== old.path) { return; }
        const targetChanged = this.hasTargetChanged(updated);
        this.project = updated;
        if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
        this.fire();
    }

    setTask(text: string, tone: Tone, extra: Partial<TaskStrip> = {}): void {
        this.task = { text, tone, at: Date.now(), ...extra };
        this.fire();
    }

    private steps(method: string): { id: string; label: string; state: string }[] {
        const order = [...(this.flashIncludesBuild ? ['build'] : []), 'identify', ...(this.flashSteps.backup ? ['backup'] : []), 'program', 'verify', ...(method === 'uart' ? [] : ['run'])];
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
                if (d.path === this.project?.path && this.activeDownloadIntent !== undefined && this.activeDownloadIntent !== this.downloadIntent) {
                    this.cancelledFlashRun = String(d.runId);
                    break;
                }
                if (d.path === this.project?.path && d.runId !== this.cancelledFlashRun && (this.activeDownloadIntent === undefined || this.activeDownloadIntent === this.downloadIntent)) {
                    this.runId = String(d.runId); this.flashSteps = {}; this.flashPercent = undefined; this.romDetected = false;
                    this.awaitUser = undefined; this.bootOutputSeen = false;
                    this.appendOutput(`── 下载，${(d.erase as { label?: string })?.label ?? ''}，${new Date().toLocaleTimeString()} ──`);
                }
                break;
            case 'flash.step':
                if (d.runId === this.runId) {
                    if (d.state === 'running') {
                        for (const step of Object.keys(this.flashSteps)) { if (step !== d.step && this.flashSteps[step] === 'running') { this.flashSteps[step] = 'done'; } }
                    }
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
                if (d.runId === this.runId || (d.runId === this.cancelledFlashRun && this.activeDownloadIntent !== undefined)) {
                    this.romDetected = true;
                    if (d.runId === this.runId) { this.awaitUser = undefined; this.fire(); }
                }
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

    private projectInputPath(path: string, root = this.project?.path): string | undefined {
        if (!root) { return undefined; }
        const canonical = this.toCanonical(path).replace(/\\/g, '/');
        const normalizedRoot = root.replace(/\\/g, '/');
        if (!canonical.startsWith(normalizedRoot + '/')) { return undefined; }
        const relative = canonical.slice(normalizedRoot.length + 1);
        // Match the sidecar's build-input exclusions; custom CMake may read non-C resources.
        if (/^(build|\.nodu|\.cache|\.git|\.theia|\.vscode)\//.test(relative) || /(^|\/)\.DS_Store$/.test(relative)) { return undefined; }
        if (this.project?.manifest.build?.adapter === 'dacir-directory-v1' && /^(\.studio|runs)\//.test(relative)) { return undefined; }
        return relative;
    }

    private isProjectSource(path: string): boolean {
        const relative = this.projectInputPath(path);
        return relative !== undefined && /\.(c|h|cpp|hpp|s|ld|cmake)$|(^|\/)(CMakeLists\.txt|CMakePresets\.json|nodu\.json)$/i.test(relative);
    }

    hasUnsavedSources(path = this.project?.path): boolean {
        return (this.editors?.all ?? []).some(widget => !widget.isDisposed && widget.saveable.dirty
            && this.projectInputPath(widget.editor.uri.path.fsPath(), path) !== undefined);
    }

    sourceChanged(path: string, fromEditor = false): void {
        if (!this.isProjectSource(path)) { return; }
        if (fromEditor) { this.sourceRevision++; }
        if (this.lastBuild) { this.diagnosticsStale = true; this.clearMarkers(); }
        this.fire();
    }

    // ── device lists ──
    private hasTargetChanged(project: ProjectStatus | undefined): boolean {
        return project?.path !== this.project?.path || project?.flashMethod !== this.project?.flashMethod
            || JSON.stringify(project?.manifest.target) !== JSON.stringify(this.project?.manifest.target);
    }

    private deviceContext() {
        const project = this.project;
        return { generation: this.detection, revision: this.deviceRevision, path: project?.path,
            target: JSON.stringify(project?.manifest.target), method: project?.flashMethod,
            probe: this.probe, port: project?.flashMethod === 'uart' ? this.monitorPort : '' };
    }

    private sameDeviceContext(context: ReturnType<NoduEmbeddedModel['deviceContext']>): boolean {
        const current = this.deviceContext();
        return Object.keys(current).every(key => current[key as keyof typeof current] === context[key as keyof typeof context]);
    }

    private clearDeviceIdentity(): void {
        this.deviceRevision++;
        this.identity = undefined;
        this.identityProbe = ''; this.identityPort = '';
        this.backups = []; this.lastFlash = undefined;
    }

    private rememberIdentity(identity: ChipIdentity): void {
        if (this.identity?.uid !== identity.uid || this.identity?.deviceId !== identity.deviceId) { this.backups = []; }
        this.identity = identity;
        const actualProbe = (identity as ChipIdentity & { probeId?: string }).probeId;
        this.identityProbe = identity.method === 'stlink' ? actualProbe || this.probe
            || (this.probes.length === 1 ? this.probes[0].id || this.probes[0].serial : '') : '';
        this.identityPort = identity.method === 'uart' ? this.monitorPort : '';
    }

    setProbe(probe: string): void {
        if (probe === this.probe || this.busy || this.awaitUser) { return; }
        this.probe = probe;
        this.clearDeviceIdentity(); this.fire();
        void this.loadBackups();
    }

    async refreshDevices(): Promise<void> {
        const request = ++this.probeRefresh, generation = this.detection;
        await Promise.all([this.refreshPorts(), this.call<ProbeInfo[]>('listProbes').then(probes => {
            if (request !== this.probeRefresh || generation !== this.detection) { return; }
            const previous = this.probes;
            this.probes = probes;
            const present = (selector: string): boolean => probes.some(p => (p.id || p.serial) === selector || p.serial === selector);
            const changed = JSON.stringify(previous.map(p => p.id || p.serial).sort()) !== JSON.stringify(probes.map(p => p.id || p.serial).sort());
            if (this.identity?.method === 'stlink' && (this.identityProbe ? !present(this.identityProbe) : changed)) {
                this.clearDeviceIdentity(); void this.loadBackups();
            }
            // Retain an explicit missing probe. The backend must reject it instead
            // of silently redirecting the next download to a different chip.
            this.fire();
        }).catch(() => undefined)]);
    }

    private isSystemPort(path: string, ports: PortInfo[] = this.ports): boolean {
        if (/(?:^|[/\\])(?:cu\.|tty\.)?(?:Bluetooth[^/\\]*|debug-console|wlan-debug)$/i.test(path)) { return true; }
        const port = ports.find(candidate => candidate.path === path);
        return port?.vid === undefined && /^(?:BluetoothPort|Bluetooth|Debug console)$/i.test(port?.description ?? '');
    }

    private selectableMonitorPort(port: string, ports: PortInfo[] = this.ports): string {
        return !this.monitorPortExplicit && this.isSystemPort(port, ports) ? '' : port;
    }

    refreshPorts(): Promise<void> {
        if (this.portRefresh) { return this.portRefresh; }
        this.portRefresh = this.call<PortInfo[]>('listPorts').then(ports => {
            const next = this.monitorPortExplicit && !this.monitorPort ? '' : preferredMonitorPort(this.selectableMonitorPort(this.monitorPort, ports), ports.filter(port => !this.isSystemPort(port.path, ports)));
            const changed = JSON.stringify(ports) !== JSON.stringify(this.ports) || next !== this.monitorPort;
            const targetChanged = this.identity?.method === 'uart' && (next !== this.monitorPort || (this.identityPort && !ports.some(port => port.path === this.identityPort)));
            this.ports = ports; this.monitorPort = next;
            if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
            if (changed) { this.fire(); }
        }).catch(() => undefined).finally(() => { this.portRefresh = undefined; });
        return this.portRefresh;
    }

    async loadBackups(): Promise<void> {
        const context = this.deviceContext(), identity = this.identity, request = ++this.backupRefresh;
        if (!this.project) { this.backups = []; this.fire(); return; }
        const current = (): boolean => request === this.backupRefresh && this.sameDeviceContext(context) && identity === this.identity;
        try {
            const backups = await this.call<BackupRecord[]>('listBackups', identity?.uid ? { uid: identity.uid } : {});
            if (!current()) { return; }
            this.backups = identity?.uid ? backups.filter(backup => backup.uid === identity.uid && backup.deviceId === identity.deviceId) : backups;
        } catch { if (!current()) { return; } this.backups = []; }
        this.fire();
    }

    setMonitorPort(port: string): void {
        if (this.flashing || this.identifying || this.preparingFlash || this.monitorBusy || this.awaitUser) { return; }
        const targetChanged = this.project?.flashMethod === 'uart' && port !== this.monitorPort;
        if (targetChanged) { this.clearDeviceIdentity(); }
        this.monitorPortExplicit = true;
        this.monitorPort = port; localStorage.setItem('nodu.stm32.monitor-port', port); this.monitorError = ''; this.fire();
        if (targetChanged) { void this.loadBackups(); }
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
        if (!project || this.busy) { return undefined; }
        const generation = this.detection;
        const sourceRevision = this.sourceRevision;
        this.building = true;
        this.lastError = undefined;
        this.buildProgress = undefined;
        this.setTask('编译中', 'busy', { target: 'output' });
        try {
            const result = await this.call<BuildResult>('build', { path: project.path, clean });
            if (generation !== this.detection || this.project?.path !== project.path) { return undefined; }
            result.stale = !!result.stale || sourceRevision !== this.sourceRevision;
            this.lastBuild = result;
            this.diagnosticsStale = !!result.stale;
            if (this.diagnosticsStale) { this.clearMarkers(); } else { this.setDiagnostics(result.diagnostics); }
            if (!result.ok) {
                const counts = result.errors ? `${result.errors} 个错误${result.warnings ? `，${result.warnings} 个警告` : ''}` : '工程配置失败';
                this.appendOutput(`编译失败：${counts}`);
                this.settle(counts, 'error', { target: 'problems' });
            } else if (result.stale) {
                this.appendOutput('编译结果已过期，请重新编译。');
                this.settle('编译期间有文件被修改，这次结果已过期。再编译一次。', 'warn', { target: 'output' });
            } else {
                const label = result.warnings ? `编译成功（${result.warnings} 个警告）` : '编译成功';
                this.appendOutput(label);
                this.settle(label, 'ok', { target: result.warnings ? 'problems' : 'output' });
            }
            await this.reload().catch(() => undefined);
            return result;
        } catch (error) {
            if (generation !== this.detection || this.project?.path !== project.path) { return undefined; }
            if (error instanceof EmbeddedError && error.code === 'untrusted') { throw error; }
            this.appendOutput(error instanceof EmbeddedError && error.code === 'cancelled' ? '编译已停止' : `编译失败：${error instanceof Error ? error.message : String(error)}`);
            this.fail(error, '编译');
            return undefined;
        } finally {
            this.building = false;
            this.buildProgress = undefined;
            this.fire();
        }
    }

    /** Compile the saved project, then download the resulting bundle. */
    async run(compatibleConfirmed = false): Promise<boolean> {
        const project = this.project;
        if (!project || this.busy) { return false; }
        const context = { generation: this.detection, intent: ++this.downloadIntent, revision: this.sourceRevision };
        this.awaitUser = undefined;
        const built = await this.build();
        if (!built?.ok || built.stale || !built.artifact || !this.isDownloadCurrent(project, context)) { return false; }
        return this.flashBundle(this.project!, built.artifact.bundleSha256, compatibleConfirmed, context, true);
    }

    /** Download only a current saved build. Never invokes the compiler. */
    async flashCurrent(compatibleConfirmed = false): Promise<boolean> {
        const project = this.project;
        if (!project || this.busy) { return false; }
        const context = { generation: this.detection, intent: ++this.downloadIntent, revision: this.sourceRevision };
        this.preparingFlash = true;
        this.lastError = undefined;
        this.awaitUser = undefined;
        this.flashIncludesBuild = false;
        this.setTask('检查编译产物', 'busy', { target: 'output' });
        try {
            this.checkDownloadSources(project, context.revision);
            const current = await this.call<ProjectStatus>('openProject', { path: project.path });
            if (!this.isDownloadCurrent(project, context)) { return false; }
            this.checkDownloadSources(project, context.revision);
            if (current.path !== project.path) { throw new EmbeddedError({ code: 'projectChanged', message: '工程位置已改变，请重新打开工程。' }); }
            this.project = current;
            if (!current.currentBuild?.bundle) { throw new EmbeddedError({ code: 'noBuild', message: '还没有成功编译的程序。先编译。' }); }
            if (current.buildStale) { throw new EmbeddedError({ code: 'staleBuild', message: '编译之后文件有修改。重新编译后再烧写。' }); }
            return await this.flashBundle(current, current.currentBuild.bundle, compatibleConfirmed, context, false);
        } catch (error) {
            if (this.isDownloadCurrent(project, context)) { this.fail(error, '烧写'); }
            return false;
        } finally {
            this.preparingFlash = false;
            this.fire();
        }
    }

    private isDownloadCurrent(project: ProjectStatus, context: { generation: number; intent: number }): boolean {
        return context.generation === this.detection && context.intent === this.downloadIntent && this.project?.path === project.path;
    }

    private checkDownloadSources(project: ProjectStatus, revision: number): void {
        if (this.hasUnsavedSources(project.path)) { throw new EmbeddedError({ code: 'unsavedSources', message: '工程有未保存的文件，先保存并编译。' }); }
        if (revision !== this.sourceRevision) { throw new EmbeddedError({ code: 'staleBuild', message: '准备烧写期间代码有修改。重新编译后再烧写。' }); }
    }

    private async flashBundle(project: ProjectStatus, bundle: string, compatibleConfirmed: boolean,
        context: { generation: number; intent: number; revision: number }, compiled: boolean): Promise<boolean> {
        if (!this.isDownloadCurrent(project, context)) { return false; }
        const method = project.flashMethod;
        const port = method === 'uart' ? this.selectableMonitorPort(this.monitorPort) : '';
        const probe = this.probe;
        this.flashing = true;
        this.activeDownloadIntent = context.intent;
        this.runId = '';
        this.romDetected = false;
        this.bootOutputSeen = false;
        let restoreBootOnCancel = false;
        this.flashIncludesBuild = compiled;
        this.flashSteps = {};
        this.lastError = undefined;
        try {
            this.checkDownloadSources(project, context.revision);
            if (method === 'uart' && !port) { throw new EmbeddedError({ code: 'noPort', message: '串口下载需要先在设备弹层中选择 USB 转串口。' }); }
            // ST-LINK leaves the serial port free: catch startup output before the flash RPC.
            if (method === 'stlink') { await this.ensureMonitor().catch(() => undefined); }
            if (!this.isDownloadCurrent(project, context)) { return false; }
            this.checkDownloadSources(project, context.revision);
            this.runCount += 1;
            this.pushMonitor(`── 运行 #${this.runCount}，${new Date().toLocaleTimeString()}，${bundle.slice(0, 7)} ──`, 'separator');
            this.setTask('识别芯片', 'busy', { steps: this.steps(method), target: 'output' });
            const result = await this.call<FlashResult>('flash', { path: project.path, bundle, compatibleConfirmed, method, probe: probe || undefined, port: port || undefined });
            restoreBootOnCancel = result.needsBootRestore;
            if (!this.isDownloadCurrent(project, context)) { return false; }
            this.lastFlash = result;
            this.rememberIdentity({ ...result.identity, matches: null, hasBackup: true });
            if (result.backup) { this.appendOutput(`已保存首次备份：${result.backup.id}（${formatBytes(result.backup.bytes)}）`); }
            if (result.needsBootRestore) {
                await this.ensureMonitor().catch(error => {
                    if (this.isDownloadCurrent(project, context)) { this.monitorError = error instanceof Error ? error.message : String(error); }
                });
                if (!this.isDownloadCurrent(project, context)) { return false; }
                this.awaitUser = this.bootOutputSeen ? undefined : 'exitBoot';
                this.setTask(this.bootOutputSeen ? '运行中' : '等待复位', this.bootOutputSeen ? 'ok' : 'warn', { target: 'monitor' });
            } else {
                if (result.autoBoot) { await this.ensureMonitor().catch(() => undefined); }
                if (!this.isDownloadCurrent(project, context)) { return false; }
                const running = result.running === false ? '程序没有运行（心跳未变化）' : result.autoBoot ? '已请求运行' : '运行中';
                this.settle(running, result.running === false ? 'warn' : 'ok', { target: 'monitor' });
            }
            void this.loadBackups();
            return true;
        } catch (error) {
            if (!this.isDownloadCurrent(project, context)) {
                // A real write/verification failure remains relevant after a stop request,
                // but a result belonging to another workspace must never affect its UI.
                if (this.activeDownloadIntent === context.intent && context.generation === this.detection && this.project?.path === project.path
                    && !(error instanceof EmbeddedError && error.code === 'cancelled')) { this.fail(error, '下载'); }
                return false;
            }
            this.awaitUser = method === 'uart' && this.romDetected && !project.manifest.flash?.autoBoot?.enabled ? 'exitBoot' : undefined;
            this.fail(error, '下载');
            return false;
        } finally {
            if (this.activeDownloadIntent === context.intent) {
                if (context.intent !== this.downloadIntent && context.generation === this.detection && this.project?.path === project.path) {
                    // Invalidating a request suppresses its ordinary catch path. Always
                    // settle its BOOT wait once the device worker actually finishes.
                    this.awaitUser = method === 'uart' && (restoreBootOnCancel || this.romDetected)
                        && !project.manifest.flash?.autoBoot?.enabled ? 'exitBoot' : undefined;
                    if (!this.lastError) { this.settle(this.awaitUser ? '已停止，等待恢复 BOOT' : '已停止', 'warn', { target: this.awaitUser ? 'monitor' : 'output' }); }
                }
                this.activeDownloadIntent = undefined;
                this.flashing = false;
                this.fire();
            }
        }
    }

    async stop(): Promise<void> {
        if (this.lastError === this.stopFailure) { this.lastError = undefined; }
        this.stopFailure = undefined;
        const generation = this.detection, path = this.project?.path;
        const intent = ++this.downloadIntent;
        const current = (): boolean => generation === this.detection && path === this.project?.path && intent === this.downloadIntent;
        const deviceActive = this.flashing || this.identifying;
        // Already queued events must not recreate the old enterBoot prompt.
        if (this.flashing || this.awaitUser) {
            if (this.runId) { this.cancelledFlashRun = this.runId; }
            this.runId = '';
        }
        if (this.preparingFlash && !this.flashing) { this.settle('已停止', 'warn'); }
        try {
            if (this.building) { await this.call('cancel', { queue: 'build' }); }
            if (!current()) { return; }
            if (deviceActive) {
                const writing = this.flashSteps.program === 'running' || this.flashSteps.verify === 'running';
                await this.call('cancel', { queue: 'device' });
                if (!current()) { return; }
                if (this.awaitUser === 'enterBoot') { this.awaitUser = undefined; }
                if (!this.lastError) {
                    this.settle(this.flashing && writing ? '写入完成后停止' : this.flashing || this.identifying ? '正在停止'
                        : this.awaitUser === 'exitBoot' ? '已停止，等待恢复 BOOT' : '已停止', 'warn');
                }
            } else if (this.awaitUser) {
                // Dismiss a finished guide, including a stale wait from an older renderer.
                this.awaitUser = undefined;
                this.settle('已停止', 'warn');
            }
        } catch (error) {
            if (current()) { this.fail(error, '停止'); this.stopFailure = this.lastError; }
        }
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
            if (status.open && status.port && !this.monitorPortExplicit) {
                const next = this.selectableMonitorPort(status.port);
                const targetChanged = this.project?.flashMethod === 'uart' && next !== this.monitorPort;
                this.monitorPort = next;
                if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
            }
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
        this.clearDeviceIdentity();
        const context = this.deviceContext(), intent = this.downloadIntent;
        const current = (): boolean => this.sameDeviceContext(context) && intent === this.downloadIntent;
        this.identifying = true;
        this.lastError = undefined;
        this.fire();
        try {
            const identity = await this.call<ChipIdentity>('identify', { path: context.path, probe: context.probe || undefined });
            if (!current()) { return; }
            this.rememberIdentity(identity);
            await this.loadBackups();
        } catch (error) {
            if (!current()) { return; }
            this.clearDeviceIdentity();
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
        const project = this.project;
        if (!project) { return; }
        const path = project.path, generation = this.detection;
        const current = (): boolean => this.detection === generation && this.project?.path === path;
        const allowed = (): boolean => {
            if (this.building || this.flashing || this.identifying || this.preparingFlash) {
                this.fail(new EmbeddedError({ code: 'busy', message: '当前操作结束后再修改设置。' }), '保存设置');
                return false;
            }
            if (key === 'flashMethod' && this.awaitUser) {
                this.fail(new EmbeddedError({ code: 'awaitBoot', message: '完成 BOOT 引导后再切换下载方式。' }), '保存设置');
                return false;
            }
            return true;
        };
        if (!allowed()) { return; }
        this.optionSaveCount++;
        this.fire();
        const save = async (): Promise<void> => {
            if (!current() || !allowed()) { return; }
            this.lastError = undefined;
            if (this.task === this.optionErrorTask) { this.task = undefined; }
            this.optionErrorTask = undefined;
            this.fire();
            try {
                const updated = await this.call<ProjectStatus>('setProjectOption', { path, key, value });
                if (!current()) { return; }
                if (updated.path !== path) { throw new EmbeddedError({ code: 'projectChanged', message: '工程位置已改变，请重新打开工程。' }); }
                const targetChanged = this.hasTargetChanged(updated);
                this.project = updated;
                if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
                if (key === 'preset') { this.projectChanged.fire(updated); }
                this.fire();
                if (key === 'monitorBaud' && this.monitor.open && current()) {
                    await this.changeMonitor(async () => { if (current()) { await this.openSelectedMonitor(); } });
                }
            } catch (error) {
                if (current()) { this.fail(error, '保存设置'); this.optionErrorTask = this.task; }
            }
        };
        // Serialize writes themselves, not just UI responses: a late earlier write must
        // not restore an obsolete selection on disk or erase another option's change.
        const pending = this.optionSaveQueue.then(save, save).finally(() => {
            this.optionSaveCount--;
            this.fire();
        });
        this.optionSaveQueue = pending;
        await pending;
    }

    settingsChanged(project: ProjectStatus): void {
        const targetChanged = this.hasTargetChanged(project);
        this.project = project;
        if (targetChanged) { this.clearDeviceIdentity(); void this.loadBackups(); }
        this.sourceChanged(`${project.path}/nodu.json`); this.projectChanged.fire(project); this.fire();
    }

    async restore(backup: BackupRecord, compatibleConfirmed = false): Promise<void> {
        const project = this.project;
        if (!project || this.busy) { return; }
        const context = this.deviceContext();
        this.awaitUser = undefined;
        this.flashing = true;
        this.flashSteps = {};
        this.setTask('恢复备份', 'busy', { steps: this.steps(project.flashMethod) });
        try {
            const result = await this.call<FlashResult>('restore', { path: project.path, backup: backup.id, compatibleConfirmed, probe: this.probe || undefined, port: this.monitorPort || undefined });
            if (!this.sameDeviceContext(context)) { return; }
            this.rememberIdentity({ ...result.identity, matches: null, hasBackup: true });
            if (project.flashMethod === 'uart') {
                await this.ensureMonitor().catch(() => undefined);
                if (!this.sameDeviceContext(context)) { return; }
                this.awaitUser = result.needsBootRestore && !this.bootOutputSeen ? 'exitBoot' : undefined;
            }
            this.settle(this.awaitUser ? '已恢复，等待复位' : '已恢复，读回一致', this.awaitUser ? 'warn' : 'ok');
            // The restored program is not this project's build.
            this.lastFlash = undefined;
            void this.loadBackups();
        } catch (error) {
            if (!this.sameDeviceContext(context)) { return; }
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
