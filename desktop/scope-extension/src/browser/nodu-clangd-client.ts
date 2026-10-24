// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandService, CommandRegistry, DisposableCollection } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { NoduEmbeddedModel } from './nodu-embedded-model';
import { NoduDiagnostics } from './nodu-diagnostics';

const START = 'nodu.clangd.start';
const STOP = 'nodu.clangd.stop';
export const RESTART_EDITOR_SERVICE = 'nodu.editorService.restart';
const SOURCE = '编辑器服务';
const START_TIMEOUT_MS = 30_000;
interface ClangdSpec { command: string; args: string[]; sdk: string }
const missingHandler = (error: unknown): boolean => typeof error === 'object' && error !== null
    && 'code' in error && error.code === 'NO_ACTIVE_HANDLER';

/** Lifecycle only: upstream vscode-clangd handles LSP and Monaco integration. */
@injectable()
export class NoduClangdClient implements FrontendApplicationContribution, CommandContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(CommandRegistry) protected readonly registry!: CommandRegistry;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(NoduDiagnostics) protected readonly diagnostics!: NoduDiagnostics;
    private readonly subscriptions = new DisposableCollection();
    private generation = 0;
    private chain = Promise.resolve();
    private sdk = '';
    private version = '';
    private active = false;
    private stopped = false;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: RESTART_EDITOR_SERVICE, label: '重新启动编辑器服务', category: 'Nodu' }, {
            execute: () => this.schedule(this.model.project),
            isEnabled: () => !this.stopped && !!this.model.project?.toolkit.ok
        });
    }

    onStart(): void {
        this.subscriptions.push(this.model.onDidChangeProject(project => { void this.schedule(project); }));
        if (this.model.project) { void this.schedule(this.model.project); }
        this.subscriptions.push(this.editors.onCreated(widget => this.markReadOnly(widget)));
    }

    onStop(): void {
        this.stopped = true;
        this.generation++;
        this.subscriptions.dispose();
    }

    private markReadOnly(widget: import('@theia/editor/lib/browser/editor-widget').EditorWidget): void {
        const path = widget.editor.uri.path.fsPath().replace(/\\/g, '/');
        const sdk = this.sdk.replace(/\\/g, '/').replace(/\/$/, '');
        if (!sdk || !path.startsWith(sdk + '/')) { return; }
        MonacoEditor.get(widget)?.getControl().updateOptions({ readOnly: true,
            readOnlyMessage: { value: `这是 HAL ${this.version} 的源码，只读。请在工程中修改回调函数或 hal_conf.h。` } });
        if (!widget.title.label.includes('只读 · HAL')) { widget.title.label += ` · 只读 · HAL ${this.version}`; }
        widget.title.caption = `只读 · HAL ${this.version} · ${path}`;
    }

    private current(generation: number): boolean { return !this.stopped && generation === this.generation; }

    private async start(spec: ClangdSpec, generation: number): Promise<boolean> {
        const deadline = Date.now() + START_TIMEOUT_MS;
        let lastRegistrationError: unknown;
        while (this.current(generation)) {
            // The manifest's enabled bridge triggers Theia's normal onCommand activation.
            // Waiting for the plugin's RPC handler alone would deadlock a lazy extension.
            if (this.registry.getActiveHandler(START, spec)) {
                try { await this.commands.executeCommand(START, spec); return true; }
                catch (error) {
                    // A host reconnect can remove the bridge between checking and executing.
                    // Only this pre-execution failure is safe to retry automatically.
                    if (!missingHandler(error)) { throw error; }
                    if (!lastRegistrationError) { this.diagnostics.record(SOURCE, `启动命令 ${START} 在注册期间被撤销。`, error); }
                    lastRegistrationError = error;
                }
            }
            if (!this.current(generation)) { return false; }
            if (Date.now() >= deadline) {
                if (lastRegistrationError) { this.diagnostics.record(SOURCE, `启动命令 ${START} 最后一次注册错误。`, lastRegistrationError); }
                throw Object.assign(new Error('C/C++ 插件尚未就绪，请重试；若仍失败，请查看日志。', { cause: lastRegistrationError }),
                    { code: 'CLANGD_PLUGIN_NOT_READY', command: START });
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    }

    private schedule(project: ProjectStatus | undefined): Promise<void> {
        if (this.stopped) { return Promise.resolve(); }
        const generation = ++this.generation;
        const key = `${project?.path ?? ''}:startup`;
        let stage = '等待';
        this.chain = this.chain.then(async () => {
            if (!this.current(generation)) { return; }
            if (this.active) {
                stage = '停止旧会话';
                try { await this.commands.executeCommand(STOP); }
                catch (error) {
                    if (!missingHandler(error)) { throw error; }
                    this.diagnostics.record(SOURCE, '插件命令已撤销，等待重新注册。', error);
                }
                this.active = false;
            }
            if (!this.current(generation)) { return; }
            this.sdk = ''; this.version = '';
            if (!project?.toolkit.ok) { return; }
            this.diagnostics.record(SOURCE, '准备启动 C/C++ 服务。', { project: project.path });
            if (project.trusted) {
                stage = '生成工程配置';
                await this.model.call('configure', { path: project.path });
            }
            if (!this.current(generation)) { return; }
            stage = '读取工具配置';
            const spec = await this.model.call<ClangdSpec>('clangd', { path: project.path });
            if (!this.current(generation)) { return; }
            stage = '启动插件';
            if (!await this.start(spec, generation)) { return; }
            // Track even a superseded start so the next queued project stops that session.
            this.active = true;
            if (!this.current(generation)) { return; }
            this.sdk = spec.sdk;
            this.version = project.chip.sdk.version;
            this.editors.all.forEach(widget => this.markReadOnly(widget));
            this.diagnostics.resolve(SOURCE, key);
            this.diagnostics.record(SOURCE, 'C/C++ 服务已启动。', { project: project.path, command: spec.command });
        }).catch(error => {
            if (!this.current(generation)) { return; }
            this.diagnostics.report({ source: SOURCE, key, message: 'C/C++ 编辑器服务未启动', error,
                context: { project: project?.path ?? '', stage, command: stage === '停止旧会话' ? STOP : START },
                isCurrent: () => this.current(generation),
                retry: () => this.schedule(this.model.project) });
        });
        return this.chain;
    }
}
