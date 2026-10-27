// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, CommandService, DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { WebSocketConnectionProvider } from '@theia/core/lib/browser/messaging/ws-connection-provider';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { ARDUINO_LANGUAGE_COMMANDS, NODU_ARDUINO_LANGUAGE_PATH, NoduArduinoLanguageService } from '../common/nodu-arduino-language-protocol';
import { NoduArduinoModel } from './nodu-arduino-model';
import { NoduDiagnostics } from './nodu-diagnostics';

/** A dedicated Arduino client prevents the STM32 language service from claiming .ino documents. */
@injectable()
export class NoduArduinoLanguageClient implements FrontendApplicationContribution, CommandContribution {
    @inject(NoduArduinoModel) protected readonly model!: NoduArduinoModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(CommandRegistry) protected readonly registry!: CommandRegistry;
    @inject(WebSocketConnectionProvider) protected readonly connection!: WebSocketConnectionProvider;
    @inject(FileService) protected readonly files!: FileService;
    @inject(NoduDiagnostics) protected readonly diagnostics!: NoduDiagnostics;
    private readonly subscriptions = new DisposableCollection();
    private service!: NoduArduinoLanguageService;
    private state = '';
    private generation = 0;
    private active = false;
    private stopped = false;
    private chain = Promise.resolve();
    private refreshTimer?: ReturnType<typeof setTimeout>;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: ARDUINO_LANGUAGE_COMMANDS.restart, label: '重新启动 Arduino 编辑器服务' }, {
            execute: () => this.schedule(), isEnabled: () => !!this.model.path && !!this.model.project?.ready && !this.model.busy });
    }
    onStart(): void {
        this.service = this.connection.createProxy<NoduArduinoLanguageService>(NODU_ARDUINO_LANGUAGE_PATH);
        this.subscriptions.push(this.model.onDidChange(() => this.observe()));
        this.subscriptions.push(this.files.onDidFilesChange(event => {
            if (!this.model.path || !event.changes.some(change => change.resource.path.fsPath().replace(/\\/g, '/') === `${this.model.path.replace(/\\/g, '/')}/sketch.yaml`)) { return; }
            clearTimeout(this.refreshTimer); this.refreshTimer = setTimeout(() => { if (!this.model.busy) { void this.schedule(); } else { this.state = ''; } }, 500);
        }));
        this.observe();
    }
    private observe(): void {
        if (this.model.busy) { return; }
        const next = `${this.model.path}:${this.model.project?.ready}:${this.model.project?.fqbn}:${this.model.libraryRevision}`;
        if (next === this.state) { return; } this.state = next; void this.schedule();
    }
    private current(generation: number): boolean { return !this.stopped && generation === this.generation; }
    private schedule(): Promise<void> {
        const generation = ++this.generation, path = this.model.path, ready = this.model.project?.ready;
        this.chain = this.chain.then(async () => {
            if (!this.current(generation)) { return; }
            if (this.active) { await this.commands.executeCommand(ARDUINO_LANGUAGE_COMMANDS.stop); this.active = false; }
            if (!path || !ready || !this.current(generation)) { return; }
            const spec = await this.service.spec({ path });
            if (!this.current(generation) || this.model.path !== path) { return; }
            if (!spec.ok) { throw new Error(spec.error || 'Arduino 编辑器环境尚未准备完成。'); }
            const deadline = Date.now() + 30_000;
            while (this.current(generation) && !this.registry.getActiveHandler(ARDUINO_LANGUAGE_COMMANDS.start, spec)) {
                if (Date.now() >= deadline) { throw new Error('Arduino 编辑器插件尚未就绪。'); }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            if (!this.current(generation)) { return; }
            await this.commands.executeCommand(ARDUINO_LANGUAGE_COMMANDS.start, spec); this.active = true;
            if (this.current(generation)) { this.diagnostics.resolve('Arduino 编辑器', path); }
        }).catch(error => {
            if (!this.current(generation)) { return; }
            this.diagnostics.report({ source: 'Arduino 编辑器', key: path, message: 'Arduino 编辑器服务未启动', error,
                context: { path }, isCurrent: () => this.current(generation), retry: () => this.schedule() });
        });
        return this.chain;
    }
    onStop(): void {
        this.stopped = true; ++this.generation; clearTimeout(this.refreshTimer); this.subscriptions.dispose();
        void this.chain.then(() => this.active ? this.commands.executeCommand(ARDUINO_LANGUAGE_COMMANDS.stop) : undefined).catch(() => undefined);
    }
}
