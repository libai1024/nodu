// SPDX-License-Identifier: MIT
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { ArduinoBoard, ArduinoBoardOption, ArduinoClient, ArduinoConfigureRequest, ArduinoEvent, ArduinoPort, ArduinoProjectInfo, NODU_ARDUINO_PATH, NoduArduinoService } from '../common/nodu-arduino-protocol';
import { NoduEmbeddedModel } from './nodu-embedded-model';

export type ArduinoOperation = 'build' | 'upload' | 'flash' | 'prepare' | 'libraries' | 'export';

/** Per-window Arduino configuration, sharing the existing project, task and serial surfaces. */
@injectable()
export class NoduArduinoModel implements ArduinoClient {
    @inject(WebSocketConnectionProvider) protected readonly connections!: WebSocketConnectionProvider;
    @inject(NoduEmbeddedModel) readonly embedded!: NoduEmbeddedModel;
    service!: NoduArduinoService;
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    private readonly output = new Emitter<ArduinoEvent>();
    readonly onDidOutput = this.output.event;
    private scope = '';
    private refreshSequence = 0;
    private configureSequence = 0;
    generation = 0;
    project?: ArduinoProjectInfo;
    boards: ArduinoBoard[] = [];
    options: ArduinoBoardOption[] = [];
    ports: ArduinoPort[] = [];
    loading = false;
    configuring = false;
    error = '';
    operation?: ArduinoOperation;
    operationLabel = '';
    libraryRevision = 0;
    buildToken?: string;
    simulationReady = false;
    simulationError = '';
    builtRevision = -1;

    get path(): string { return this.embedded.isArduino ? this.embedded.espPath : ''; }
    get busy(): boolean { return this.configuring || !!this.operation || this.embedded.busy; }
    get selectedPort(): string { return this.project?.port ?? ''; }
    get boardName(): string { return this.project?.boardName || this.embedded.espChip.toUpperCase(); }
    get canFlash(): boolean { return !!this.buildToken && this.builtRevision === this.embedded.sourceGeneration && !this.embedded.diagnosticsStale; }
    fire(): void { this.changed.fire(); }
    @postConstruct()
    protected init(): void {
        this.service = this.connections.createProxy<NoduArduinoService>(NODU_ARDUINO_PATH, this);
        this.embedded.arduinoMonitor = {
            save: monitor => this.configure({ monitor }).then(() => undefined),
            selectPort: port => this.configure({ monitor: { port } }).then(() => undefined),
            ports: async () => {
                await this.refreshPorts();
                return this.ports.map(port => ({ path: port.path, description: port.label ?? '', vid: port.vid, pid: port.pid, serial_number: port.serialNumber }));
            },
            busy: () => this.configuring || this.operation === 'upload' || this.operation === 'flash',
        };
        this.embedded.onDidChange(() => this.observeProject()); this.observeProject();
    }
    onArduinoOutput(event: ArduinoEvent): void { this.output.fire(event); }
    private observeProject(): void {
        const scope = `${this.embedded.projectGeneration}:${this.path}`;
        if (scope === this.scope) { return; }
        this.scope = scope; ++this.generation; ++this.refreshSequence; ++this.configureSequence;
        this.project = undefined; this.boards = []; this.options = []; this.ports = []; this.error = '';
        this.loading = false; this.configuring = false; this.buildToken = undefined; this.builtRevision = -1; this.simulationReady = false; this.simulationError = '';
        this.embedded.arduinoMonitorConfig = { baud: 115200, encoding: 'utf-8' };
        if (this.path) { this.embedded.monitorPort = ''; void this.refresh(); }
        this.fire();
    }
    async refresh(): Promise<void> {
        const path = this.path, generation = this.generation, sequence = ++this.refreshSequence;
        if (!path) { return; }
        const current = (): boolean => this.path === path && this.generation === generation && this.refreshSequence === sequence;
        this.loading = true; this.error = ''; this.fire();
        try {
            const project = await this.service.inspect(path);
            if (!current()) { return; }
            this.project = project;
            await this.embedded.applyArduinoMonitorSettings(project.monitor, project.port);
            if (!current()) { return; }
            const results = await Promise.allSettled([this.service.boards(path), this.service.boardOptions(path), this.refreshPorts()]);
            if (!current()) { return; }
            if (results[0].status === 'fulfilled') { this.boards = results[0].value; }
            if (results[1].status === 'fulfilled') { this.options = results[1].value; }
            for (const result of results) { if (result.status === 'rejected' && project.ready) { this.error = result.reason instanceof Error ? result.reason.message : String(result.reason); break; } }
        } catch (cause) { if (current()) { this.error = cause instanceof Error ? cause.message : String(cause); } }
        finally { if (current()) { this.loading = false; this.fire(); this.embedded.fire(); } }
    }
    async refreshPorts(): Promise<void> {
        const generation = this.generation, path = this.path;
        if (!path) { return; }
        const ports = await this.service.ports();
        if (generation !== this.generation || path !== this.path) { return; }
        this.ports = ports;
        this.embedded.ports = ports.map(port => ({ path: port.path, description: port.label ?? '', vid: port.vid, pid: port.pid, serial_number: port.serialNumber }));
        this.fire();
    }
    async configure(change: Omit<ArduinoConfigureRequest, 'path'>): Promise<boolean> {
        if (!this.path || this.busy || this.loading || this.embedded.monitorBusy) { return false; }
        const path = this.path, generation = this.generation, sequence = ++this.configureSequence;
        const current = (): boolean => path === this.path && generation === this.generation && sequence === this.configureSequence;
        this.configuring = true; this.error = ''; this.fire(); this.embedded.fire();
        try {
            const project = await this.service.configure({ path, ...change });
            if (!current()) { return false; }
            this.project = project;
            if (change.fqbn || change.options) { this.buildToken = undefined; this.builtRevision = -1; this.simulationReady = false; this.simulationError = ''; this.embedded.sourceChanged(path + '/sketch.yaml', true); }
            await this.embedded.applyArduinoMonitorSettings(project.monitor, project.port);
            if (!current()) { return false; }
            if (change.fqbn || change.options) {
                const options = await this.service.boardOptions(path);
                if (!current()) { return false; } this.options = options;
            }
            return true;
        } catch (cause) {
            if (current()) { this.error = cause instanceof Error ? cause.message : String(cause); this.embedded.monitorError = this.error; }
            return false;
        } finally { if (current()) { this.configuring = false; this.fire(); this.embedded.fire(); } }
    }
}
