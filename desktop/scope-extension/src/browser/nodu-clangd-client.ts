// SPDX-License-Identifier: MIT
import * as monaco from '@theia/monaco-editor-core';
import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { URI } from '@theia/core/lib/common/uri';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { Diagnostic as LspDiagnostic } from '@theia/core/shared/vscode-languageserver-protocol';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { NoduEmbeddedModel } from './nodu-embedded-model';

type Json = Record<string, unknown>;
interface LspPosition { line: number; character: number }
interface LspRange { start: LspPosition; end: LspPosition }

const K = monaco.languages.CompletionItemKind;
/** LSP CompletionItemKind (1-based) → Monaco. */
const KINDS: Record<number, monaco.languages.CompletionItemKind> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field, 6: K.Variable, 7: K.Class, 8: K.Interface,
    9: K.Module, 10: K.Property, 11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet, 16: K.Color,
    17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember, 21: K.Constant, 22: K.Struct, 23: K.Event,
    24: K.Operator, 25: K.TypeParameter,
};

const toRange = (r: LspRange): monaco.IRange => new monaco.Range(r.start.line + 1, r.start.character + 1, r.end.line + 1, r.end.character + 1);
const toPosition = (p: monaco.Position): LspPosition => ({ line: p.lineNumber - 1, character: p.column - 1 });
const markdown = (value: unknown): monaco.IMarkdownString | undefined => {
    if (!value) { return undefined; }
    if (typeof value === 'string') { return { value }; }
    const v = value as { value?: string };
    return v.value ? { value: v.value } : undefined;
};

/**
 * Minimal clangd client (FUNCTIONAL-DESIGN §6.1, option B): completion, hover,
 * go-to-definition, signature help and live diagnostics for C files of the
 * open STM32 project. clangd reads compile_commands.json and never runs CMake.
 * HAL sources under the toolkit SDK open read-only (E4).
 */
@injectable()
export class NoduClangdClient implements FrontendApplicationContribution {
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(ProblemManager) protected readonly problems!: ProblemManager;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    private readonly session = new DisposableCollection();
    private readonly pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
    private readonly opened = new Map<string, { model: monaco.editor.ITextModel; timer?: ReturnType<typeof setTimeout> }>();
    private readonly diagnosed = new Set<string>();
    private sequence = 0;
    private ready: Promise<void> | undefined;
    private project: ProjectStatus | undefined;
    private sdk = '';
    private triggers: string[] = ['.', '>', ':', '(', ','];

    onStart(): void {
        this.model.onClangdMessage(message => this.receive(message));
        this.model.onDidChangeProject(project => void this.restart(project));
        if (this.model.project) { void this.restart(this.model.project); }
        this.editors.onCreated(widget => this.markReadOnly(widget.editor.uri.path.fsPath(), MonacoEditor.get(widget)));
    }

    private markReadOnly(path: string, editor: MonacoEditor | undefined): void {
        if (!editor || !this.sdk || !path.startsWith(this.sdk)) { return; }
        const version = this.project?.chip.sdk.version ?? '';
        editor.getControl().updateOptions({ readOnly: true, readOnlyMessage: { value: `这是 HAL ${version} 的源码，只读。需要改变 HAL 的行为时，在工程里实现回调函数或修改 hal_conf.h。` } });
    }

    private async restart(project: ProjectStatus | undefined): Promise<void> {
        await this.stop();
        this.project = project;
        if (!project || !project.toolkit.ok) { return; }
        // The compilation database comes from CMake configure; only trusted projects run it.
        if (project.trusted) { await this.model.call('configure', { path: project.path }).catch(() => undefined); }
        if (this.project !== project) { return; }
        this.ready = this.start(project);
        await this.ready.catch(() => { this.ready = undefined; });
    }

    private async start(project: ProjectStatus): Promise<void> {
        const { sdk } = await this.model.rpc.clangdStart(project.path);
        this.sdk = sdk;
        const result = await this.request('initialize', {
            processId: null, rootUri: URI.fromFilePath(project.path).toString(), workspaceFolders: null,
            capabilities: {
                textDocument: {
                    synchronization: { didSave: false, dynamicRegistration: false },
                    completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
                    hover: { contentFormat: ['markdown', 'plaintext'] },
                    signatureHelp: { signatureInformation: { documentationFormat: ['markdown', 'plaintext'], parameterInformation: { labelOffsetSupport: true } } },
                    definition: {}, publishDiagnostics: { relatedInformation: false },
                },
                offsetEncoding: ['utf-16'],
            },
            initializationOptions: { clangdFileStatus: false },
        }, true) as { capabilities?: { completionProvider?: { triggerCharacters?: string[] } } };
        this.triggers = result?.capabilities?.completionProvider?.triggerCharacters ?? this.triggers;
        this.notify('initialized', {});
        this.registerProviders();
        for (const model of monaco.editor.getModels()) { this.track(model); }
        this.session.push(monaco.editor.onDidCreateModel(model => this.track(model)));
        this.session.push(monaco.editor.onWillDisposeModel(model => this.untrack(model)));
        this.session.push(monaco.editor.onDidChangeModelLanguage(({ model }) => { this.untrack(model); this.track(model); }));
    }

    private async stop(): Promise<void> {
        this.ready = undefined;
        this.session.dispose();
        for (const entry of this.opened.values()) { clearTimeout(entry.timer); }
        this.opened.clear();
        for (const uri of this.diagnosed) { this.problems.setMarkers(new URI(uri), 'clangd', []); }
        this.diagnosed.clear();
        for (const item of this.pending.values()) { item.reject(new Error('clangd stopped')); }
        this.pending.clear();
        await this.model.rpc.clangdStop().catch(() => undefined);
    }

    // ── JSON-RPC ──
    private send(message: Json): void { void this.model.rpc.clangdSend(JSON.stringify({ jsonrpc: '2.0', ...message })); }
    private notify(method: string, params: unknown): void { this.send({ method, params }); }

    private async request(method: string, params: unknown, starting = false): Promise<unknown> {
        if (!starting) { await this.ready; }
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.send({ id, method, params });
            setTimeout(() => { if (this.pending.delete(id)) { reject(new Error(`clangd ${method} timeout`)); } }, starting ? 30_000 : 10_000);
        });
    }

    private receive(text: string): void {
        let message: { id?: number | string; method?: string; params?: Json; result?: unknown; error?: { message: string } };
        try { message = JSON.parse(text); } catch { return; }
        if (message.method && message.id !== undefined) {
            // Server-to-client requests (workDoneProgress/create, configuration): accept with null.
            this.send({ id: message.id, result: null });
        } else if (message.method === 'textDocument/publishDiagnostics' && message.params) {
            this.publish(message.params as { uri: string; diagnostics: LspDiagnostic[] });
        } else if (typeof message.id === 'number') {
            const item = this.pending.get(message.id);
            if (!item) { return; }
            this.pending.delete(message.id);
            if (message.error) { item.reject(new Error(message.error.message)); } else { item.resolve(message.result); }
        }
    }

    /** Monaco model URI → the canonical file URI clangd knows from compile_commands.json. */
    private lspUri(model: monaco.editor.ITextModel): string {
        return URI.fromFilePath(this.model.toCanonical(model.uri.fsPath)).toString();
    }

    private localUri(uri: string): URI {
        return URI.fromFilePath(this.model.toLocal(new URI(uri).path.fsPath()));
    }

    private publish({ uri, diagnostics }: { uri: string; diagnostics: LspDiagnostic[] }): void {
        const target = this.localUri(uri);
        if (this.sdk && target.path.fsPath().startsWith(this.sdk)) { return; }
        this.problems.setMarkers(target, 'clangd', diagnostics.map(d => ({ ...d, source: 'clangd 实时检查' })));
        if (diagnostics.length) { this.diagnosed.add(target.toString()); } else { this.diagnosed.delete(target.toString()); }
    }

    // ── document sync (full text, debounced) ──
    private wanted(model: monaco.editor.ITextModel): boolean {
        if (model.getLanguageId() !== 'c' || model.uri.scheme !== 'file' || !this.project) { return false; }
        const path = this.model.toCanonical(model.uri.fsPath);
        return path.startsWith(this.project.path) || (!!this.sdk && path.startsWith(this.sdk));
    }

    private track(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        if (this.opened.has(uri) || !this.wanted(model)) { return; }
        this.opened.set(uri, { model });
        this.notify('textDocument/didOpen', { textDocument: { uri: this.lspUri(model), languageId: 'c', version: model.getVersionId(), text: model.getValue() } });
        const listener = model.onDidChangeContent(() => {
            const entry = this.opened.get(uri);
            if (!entry) { listener.dispose(); return; }
            clearTimeout(entry.timer);
            entry.timer = setTimeout(() => this.flush(uri), 200);
        });
        this.session.push(listener);
    }

    private flush(uri: string): void {
        const entry = this.opened.get(uri);
        if (!entry || entry.model.isDisposed()) { return; }
        clearTimeout(entry.timer);
        entry.timer = undefined;
        this.notify('textDocument/didChange', { textDocument: { uri: this.lspUri(entry.model), version: entry.model.getVersionId() }, contentChanges: [{ text: entry.model.getValue() }] });
    }

    private untrack(model: monaco.editor.ITextModel): void {
        const uri = model.uri.toString();
        const entry = this.opened.get(uri);
        if (!entry) { return; }
        clearTimeout(entry.timer);
        this.opened.delete(uri);
        this.notify('textDocument/didClose', { textDocument: { uri: this.lspUri(model) } });
    }

    private position(model: monaco.editor.ITextModel, position: monaco.Position): Json | undefined {
        const uri = model.uri.toString();
        if (!this.opened.has(uri)) { return undefined; }
        this.flush(uri);
        return { textDocument: { uri: this.lspUri(model) }, position: toPosition(position) };
    }

    // ── language features ──
    private registerProviders(): void {
        this.session.push(monaco.languages.registerCompletionItemProvider('c', {
            triggerCharacters: this.triggers,
            provideCompletionItems: async (model, position) => {
                const params = this.position(model, position);
                if (!params) { return { suggestions: [] }; }
                const result = await this.request('textDocument/completion', params).catch(() => undefined) as { isIncomplete?: boolean; items?: Json[] } | Json[] | undefined;
                const items = (Array.isArray(result) ? result : result?.items ?? []) as {
                    label: string; kind?: number; detail?: string; documentation?: unknown; insertText?: string; insertTextFormat?: number;
                    filterText?: string; sortText?: string; textEdit?: { range?: LspRange; newText: string } }[];
                const word = model.getWordUntilPosition(position);
                const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
                return {
                    incomplete: !Array.isArray(result) && !!result?.isIncomplete,
                    suggestions: items.slice(0, 200).map(item => ({
                        label: item.label.trim(), kind: KINDS[item.kind ?? 1] ?? K.Text, detail: item.detail, documentation: markdown(item.documentation),
                        insertText: item.textEdit?.newText ?? item.insertText ?? item.label.trim(),
                        insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
                        filterText: item.filterText, sortText: item.sortText,
                        range: item.textEdit?.range ? toRange(item.textEdit.range) : fallback,
                    })),
                };
            },
        }));
        this.session.push(monaco.languages.registerHoverProvider('c', {
            provideHover: async (model, position) => {
                const params = this.position(model, position);
                if (!params) { return undefined; }
                const hover = await this.request('textDocument/hover', params).catch(() => undefined) as { contents?: unknown; range?: LspRange } | null | undefined;
                const contents = Array.isArray(hover?.contents) ? hover.contents.map(markdown) : [markdown(hover?.contents)];
                const list = contents.filter((c): c is monaco.IMarkdownString => !!c);
                return list.length ? { contents: list, range: hover?.range ? toRange(hover.range) : undefined } : undefined;
            },
        }));
        this.session.push(monaco.languages.registerDefinitionProvider('c', {
            provideDefinition: async (model, position) => {
                const params = this.position(model, position);
                if (!params) { return undefined; }
                type Location = { uri?: string; targetUri?: string; range?: LspRange; targetSelectionRange?: LspRange };
                const result = await this.request('textDocument/definition', params).catch(() => undefined) as Location[] | Location | null | undefined;
                const list: Location[] = Array.isArray(result) ? result : result ? [result] : [];
                return list.filter(l => (l.uri || l.targetUri) && (l.range || l.targetSelectionRange)).map(l => ({
                    uri: monaco.Uri.parse(this.localUri((l.uri || l.targetUri)!).toString()), range: toRange((l.targetSelectionRange || l.range)!),
                }));
            },
        }));
        this.session.push(monaco.languages.registerSignatureHelpProvider('c', {
            signatureHelpTriggerCharacters: ['(', ','],
            provideSignatureHelp: async (model, position) => {
                const params = this.position(model, position);
                if (!params) { return undefined; }
                const help = await this.request('textDocument/signatureHelp', params).catch(() => undefined) as {
                    signatures?: { label: string; documentation?: unknown; parameters?: { label: string | [number, number]; documentation?: unknown }[] }[];
                    activeSignature?: number; activeParameter?: number } | null | undefined;
                if (!help?.signatures?.length) { return undefined; }
                return {
                    value: {
                        activeSignature: help.activeSignature ?? 0, activeParameter: help.activeParameter ?? 0,
                        signatures: help.signatures.map(s => ({ label: s.label, documentation: markdown(s.documentation),
                            parameters: (s.parameters ?? []).map(p => ({ label: p.label, documentation: markdown(p.documentation) })) })),
                    },
                    dispose: () => undefined,
                };
            },
        }));
    }
}
