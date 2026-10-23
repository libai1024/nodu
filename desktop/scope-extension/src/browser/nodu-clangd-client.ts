// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandService, CommandRegistry } from '@theia/core/lib/common';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { NoduEmbeddedModel } from './nodu-embedded-model';

/** Lifecycle only: upstream vscode-clangd handles LSP and Monaco integration. */
@injectable()
export class NoduClangdClient implements FrontendApplicationContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(CommandRegistry) protected readonly registry!: CommandRegistry;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    private generation = 0;
    private chain = Promise.resolve();
    private sdk = '';
    private version = '';
    private active = false;

    onStart(): void {
        this.model.onDidChangeProject(project => this.schedule(project));
        if (this.model.project) { this.schedule(this.model.project); }
        this.editors.onCreated(widget => this.markReadOnly(widget));
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

    private schedule(project: ProjectStatus | undefined): void {
        const generation = ++this.generation;
        this.chain = this.chain.then(async () => {
            if (generation !== this.generation) { return; }
            if (this.active) { await this.commands.executeCommand('nodu.clangd.stop'); this.active = false; }
            this.sdk = '';
            if (!project?.toolkit.ok) { return; }
            if (project.trusted) { await this.model.call('configure', { path: project.path }); }
            if (generation !== this.generation) { return; }
            const spec = await this.model.call<{ command: string; args: string[]; sdk: string }>('clangd', { path: project.path });
            // The plugin host may still be deploying its bundled extensions.
            const deadline = Date.now() + 15_000;
            while (!this.registry.getCommand('nodu.clangd.start') && Date.now() < deadline) {
                await new Promise(resolve => setTimeout(resolve, 100));
                if (generation !== this.generation) { return; }
            }
            await this.commands.executeCommand('nodu.clangd.start', spec);
            this.active = true;
            this.sdk = spec.sdk;
            this.version = project.chip.sdk.version;
            this.editors.all.forEach(widget => this.markReadOnly(widget));
        }).catch(error => this.model.setTask(`编辑器服务未启动：${error instanceof Error ? error.message : String(error)}`, 'warn'));
    }
}
