// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry } from '@theia/core/lib/common';
import { ApplicationShell, KeybindingContribution, KeybindingRegistry, WidgetManager } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ARDUINO_COMMANDS, ArduinoBuildResult, ArduinoEvent, ArduinoPhase } from '../common/nodu-arduino-protocol';
import { ArduinoLibraryChange } from '../common/nodu-arduino-libraries-protocol';
import { NoduEmbeddedModel } from './nodu-embedded-model';
import { NoduArduinoModel, ArduinoOperation } from './nodu-arduino-model';
import { NoduBottomPanelWidget } from './nodu-bottom-panel';

export const ARDUINO_FLASH_COMMAND = 'nodu.arduino.flash';
const LIBRARY_CHANGE_COMMAND = 'nodu.arduino.library.change';
interface Operation { id: string; path: string; generation: number; kind: ArduinoOperation; cancelled: boolean; sourceChanged: boolean; writing: boolean; revision?: number }
const PHASE_LABELS: Record<ArduinoPhase, string> = { preparing: '正在准备工具', compiling: '正在编译', uploading: '正在烧录', verifying: '正在校验', restoring: '正在恢复串口' };

/** Save, compile and upload use one operation identity and the existing task/output UI. */
@injectable()
export class NoduArduinoContribution implements CommandContribution, KeybindingContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(NoduArduinoModel) protected readonly arduino!: NoduArduinoModel;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(WidgetManager) protected readonly widgets!: WidgetManager;
    @inject(ApplicationShell) protected readonly shell!: ApplicationShell;
    private active?: Operation;
    registerCommands(registry: CommandRegistry): void {
        const add = (id: string, label: string, kind: ArduinoOperation, enabled = (): boolean => true): void => {
            registry.registerCommand({ id, label }, { execute: () => this.run(kind), isEnabled: () => this.model.isArduino && !this.arduino.busy && !this.arduino.loading && !this.active && enabled(), isVisible: () => this.model.isArduino });
        };
        add(ARDUINO_COMMANDS.build, 'Arduino: 编译', 'build');
        add(ARDUINO_COMMANDS.upload, 'Arduino: 运行（编译并烧录）', 'upload', () => !!this.arduino.selectedPort);
        add(ARDUINO_FLASH_COMMAND, 'Arduino: 烧录已编译程序', 'flash', () => this.arduino.canFlash && !!this.arduino.selectedPort);
        add(ARDUINO_COMMANDS.prepare, 'Arduino: 准备工具', 'prepare');
        registry.registerCommand({ id: LIBRARY_CHANGE_COMMAND, label: 'Arduino: 修改项目库' }, {
            execute: (change: Omit<ArduinoLibraryChange, 'operationId'>) => this.run('libraries', change),
            isEnabled: () => this.model.isArduino && !this.arduino.busy && !this.arduino.loading && !this.active, isVisible: () => false,
        });
        registry.registerCommand({ id: ARDUINO_COMMANDS.stop, label: 'Arduino: 停止' }, { execute: () => this.stop(), isEnabled: () => !!this.active, isVisible: () => this.model.isArduino });
    }
    registerKeybindings(registry: KeybindingRegistry): void {
        registry.registerKeybinding({ command: ARDUINO_COMMANDS.build, keybinding: 'ctrlcmd+b', when: 'nodu.arduinoProject' });
        registry.registerKeybinding({ command: ARDUINO_COMMANDS.upload, keybinding: 'ctrlcmd+r', when: 'nodu.arduinoProject && !terminalFocus' });
    }
    async stop(): Promise<void> {
        const operation = this.active; if (!operation || operation.cancelled) { return; }
        operation.cancelled = true;
        try { await this.arduino.service.cancel(operation.id); }
        catch (cause) { if (this.current(operation)) { this.model.appendOutput(cause instanceof Error ? cause.message : String(cause)); this.model.fire(); } }
    }
    private current(operation: Operation): boolean { return this.active === operation && operation.path === this.arduino.path && operation.generation === this.model.projectGeneration; }
    private inProject(file: string, path: string): boolean { return file === path || file.startsWith(path + '/') || file.startsWith(path + '\\'); }
    private unsaved(path: string): boolean { return this.editors.all.some(editor => !editor.isDisposed && editor.saveable.dirty && this.inProject(editor.editor.uri.path.fsPath(), path)); }
    private onOutput(operation: Operation, event: ArduinoEvent): void {
        if (!this.current(operation) || event.operationId !== operation.id || event.path !== operation.path) { return; }
        if (event.phase === 'uploading' || event.phase === 'verifying' || event.phase === 'restoring') { operation.writing = true; }
        if (event.phase) { this.model.setTask(PHASE_LABELS[event.phase], 'busy', { target: 'output' }); }
        if (event.line) { this.model.appendOutput(event.line); }
        this.model.fire(); this.arduino.fire();
    }
    private setBuild(operation: Operation, result: ArduinoBuildResult, started: number): boolean {
        const stale = !!result.stale || operation.sourceChanged || this.unsaved(operation.path);
        this.model.lastBuild = { ok: result.ok && !stale, buildId: operation.id, stale, diagnostics: result.diagnostics,
            errors: result.diagnostics.filter(d => d.severity === 'error').length, warnings: result.diagnostics.filter(d => d.severity === 'warning').length, ms: Date.now() - started };
        this.model.diagnosticsStale = stale; this.model.setDiagnostics(stale ? [] : result.diagnostics);
        this.arduino.buildToken = result.ok && !stale ? result.buildToken : undefined;
        this.arduino.builtRevision = result.ok && !stale ? this.model.sourceGeneration : -1;
        if (result.error) { this.model.appendOutput(result.error); }
        return result.ok && !stale;
    }
    async compile(): Promise<void> { return this.run('build'); }
    async run(kind: ArduinoOperation, change?: Omit<ArduinoLibraryChange, 'operationId'>): Promise<void> {
        if (!this.model.isArduino || this.arduino.busy || this.active || this.arduino.loading) { return; }
        const path = this.arduino.path, port = this.arduino.selectedPort;
        if (change && change.path !== path) { return; }
        if ((kind === 'upload' || kind === 'flash') && !port) { this.arduino.error = '请选择串口。'; this.arduino.fire(); return; }
        if (kind === 'flash' && (!this.arduino.canFlash || this.unsaved(path))) { this.model.setTask('代码已修改，请重新编译', 'warn', { target: 'output' }); return; }
        const operation: Operation = { id: `arduino-${Date.now()}-${Math.random().toString(36).slice(2)}`, path, generation: this.model.projectGeneration, kind, cancelled: false, sourceChanged: false, writing: false };
        this.active = operation; this.arduino.operation = kind; this.arduino.error = '';
        this.arduino.operationLabel = kind === 'libraries' && change ? `${change.action === 'remove' ? '正在移除' : '正在安装'} ${change.name}` : kind === 'prepare' ? '正在准备工具' : kind === 'flash' ? '正在烧录' : '正在编译';
        this.model.building = kind !== 'flash'; this.model.flashing = kind === 'upload' || kind === 'flash';
        this.model.output.length = 0;
        if (kind === 'build' || kind === 'upload') { this.model.lastBuild = undefined; this.model.setDiagnostics([]); this.arduino.buildToken = undefined; }
        this.model.setTask(this.arduino.operationLabel, 'busy', { target: 'output' }); this.arduino.fire();
        const output = this.arduino.onDidOutput(event => this.onOutput(operation, event));
        const changed = this.model.onDidChange(() => {
            if (!this.current(operation)) { void this.stop(); return; }
            if (operation.revision !== undefined && operation.revision !== this.model.sourceGeneration) {
                operation.sourceChanged = true;
                if ((kind === 'upload' || kind === 'flash') && !operation.writing) { void this.stop(); }
            }
        });
        try {
            const panel = await this.widgets.getOrCreateWidget<NoduBottomPanelWidget>(NoduBottomPanelWidget.ID);
            if (!this.current(operation)) { return; }
            if (!this.shell.getAreaFor(panel)) { this.shell.addWidget(panel, { area: 'bottom' }); }
            panel.showEmbedded('output'); await this.shell.revealWidget(panel.id);
            if (!this.current(operation)) { return; }
            if (kind !== 'flash') {
                for (const editor of this.editors.all) {
                    if (!this.current(operation) || operation.cancelled) { return; }
                    if (!editor.isDisposed && editor.saveable.dirty && this.inProject(editor.editor.uri.path.fsPath(), path)) { await editor.saveable.save(); }
                }
            }
            if (!this.current(operation)) { return; }
            if (this.unsaved(path)) { throw new Error('工程存在未保存的修改。'); }
            operation.revision = this.model.sourceGeneration;
            if (operation.cancelled) { this.model.setTask('已停止', 'warn', { target: 'output' }); return; }
            if (kind === 'libraries' && change) {
                const result = await this.arduino.service.changeLibrary({ ...change, operationId: operation.id });
                if (!this.current(operation)) { return; }
                if (result.error) { throw new Error(result.error); }
                this.arduino.buildToken = undefined; this.arduino.libraryRevision++;
                this.model.setTask(result.cancelled ? '已停止' : result.ok ? change.action === 'remove' ? '已移除' : '已安装' : '库操作失败', result.cancelled ? 'warn' : result.ok ? 'ok' : 'error', { target: 'output' });
                return;
            }
            if (kind === 'prepare') {
                const result = await this.arduino.service.prepare({ path, operationId: operation.id });
                if (!this.current(operation)) { return; }
                if (result.cancelled || operation.cancelled) { this.model.setTask('已停止', 'warn', { target: 'output' }); return; }
                if (!result.ok) { throw new Error(result.error || '工具准备失败。'); }
                this.arduino.libraryRevision++; await this.arduino.refresh();
                if (!this.current(operation)) { return; }
                this.model.setTask(operation.cancelled ? '已停止' : '工具已就绪', operation.cancelled ? 'warn' : 'ok', { target: 'output' }); return;
            }
            if (kind !== 'flash') {
                const started = Date.now(), refreshEnvironment = !this.arduino.project?.ready;
                // Compile prepares its own dependencies. A separate preparation pass would duplicate first-use work
                // and turn source preprocessing errors into environment failures without editor diagnostics.
                const result = await this.arduino.service.compile({ path, operationId: operation.id });
                if (!this.current(operation)) { return; }
                const usable = this.setBuild(operation, result, started);
                if (refreshEnvironment && !operation.cancelled && !result.cancelled) {
                    this.arduino.libraryRevision++;
                    try { await this.arduino.refresh(); }
                    catch (cause) {
                        if (this.current(operation)) { this.model.appendOutput(`环境状态更新失败：${cause instanceof Error ? cause.message : String(cause)}`); }
                    }
                    if (!this.current(operation)) { return; }
                }
                if (kind === 'build' || !usable || operation.cancelled) {
                    const label = result.cancelled || operation.cancelled ? operation.sourceChanged ? '代码已修改，已停止' : '已停止' : !usable && (result.stale || operation.sourceChanged || this.unsaved(path)) ? '代码已修改，请重新编译' : result.ok ? '编译完成' : '编译失败';
                    this.model.setTask(label, result.cancelled || operation.cancelled || result.stale || operation.sourceChanged ? 'warn' : usable ? 'ok' : 'error', { target: result.diagnostics.length ? 'problems' : 'output' });
                    return;
                }
            }
            if (!this.current(operation) || operation.cancelled || operation.sourceChanged || this.unsaved(path)) { return; }
            if (!this.arduino.buildToken) { throw new Error('没有可烧录的编译产物。'); }
            this.model.building = false; this.model.setTask('正在烧录', 'busy', { target: 'output' });
            const result = await this.arduino.service.upload({ path, port, operationId: operation.id, buildToken: this.arduino.buildToken });
            if (!this.current(operation)) { return; }
            await this.model.syncArduinoMonitor();
            if (!this.current(operation)) { return; }
            const stale = result.stale || operation.sourceChanged || this.unsaved(path);
            if (result.error) { this.model.appendOutput(result.error); }
            this.model.setTask(result.cancelled ? '已停止' : result.ok ? stale ? '烧录完成 · 代码已修改' : '烧录完成' : result.stale ? '代码已修改，请重新编译' : '烧录失败', result.cancelled || stale ? 'warn' : result.ok ? 'ok' : 'error', { target: 'output' });
            if (stale) { this.arduino.buildToken = undefined; }
        } catch (cause) {
            if (this.current(operation)) { const message = cause instanceof Error ? cause.message : String(cause); this.arduino.error = message; this.model.appendOutput(message); this.model.setTask(operation.cancelled ? '已停止' : '操作失败', operation.cancelled ? 'warn' : 'error', { target: 'output' }); }
        } finally {
            output.dispose(); changed.dispose();
            if (this.active === operation) { this.active = undefined; this.arduino.operation = undefined; this.arduino.operationLabel = ''; this.model.building = false; this.model.flashing = false; this.model.fire(); this.arduino.fire(); }
        }
    }
}
