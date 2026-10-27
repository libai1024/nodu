// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KeybindingRegistry, LabelProvider, ReactWidget } from '@theia/core/lib/browser';
import { CommandRegistry, Emitter, MessageService, URI } from '@theia/core/lib/common';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { ProblemManager } from '@theia/markers/lib/browser/problem/problem-manager';
import { collectProblems, countProblems, formatProblems, NoduProblem, NoduProblemCounts } from '../common/nodu-problems';
import '../../style/problems-panel.css';

/** One read-only view of build and language-service diagnostics. */
@injectable()
export class NoduProblemsPanel extends ReactWidget {
    static readonly ID = 'nodu:problems-panel';
    static readonly LABEL = '问题';
    @inject(ProblemManager) protected readonly manager!: ProblemManager;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(LabelProvider) protected readonly labels!: LabelProvider;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings!: KeybindingRegistry;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    private readonly changed = new Emitter<NoduProblemCounts>();
    readonly onDidChangeProblems = this.changed.event;
    private readonly filterRef = React.createRef<HTMLInputElement>();
    private readonly collapsed = new Set<string>();
    private readonly hiddenSeverities = new Set<number>();
    private items: NoduProblem[] = [];
    private query = '';
    private copied?: string;
    private copySequence = 0;
    private copyFeedback?: ReturnType<typeof setTimeout>;

    get counts(): NoduProblemCounts { return countProblems(this.items); }

    @postConstruct()
    protected init(): void {
        this.id = NoduProblemsPanel.ID;
        this.title.label = NoduProblemsPanel.LABEL;
        this.title.iconClass = 'codicon codicon-warning';
        this.title.closable = false;
        this.addClass('nodu-problems-panel');
        this.node.setAttribute('aria-label', '问题');
        this.toDispose.push(this.changed);
        this.toDispose.push(this.manager.onDidChangeMarkers(() => this.refresh()));
        this.toDispose.push(this.labels.onDidChange(() => this.update()));
        const context = this.contextKeys.createScoped(this.node);
        context.createKey('nodu.problemsPanelFocus', true);
        this.toDispose.push(context);
        this.toDispose.push({ dispose: () => { ++this.copySequence; if (this.copyFeedback) { clearTimeout(this.copyFeedback); } } });
        this.toDispose.push(this.commands.registerCommand({ id: 'nodu.problems.find', label: '筛选问题' }, {
            execute: () => { this.filterRef.current?.focus(); this.filterRef.current?.select(); },
            isEnabled: () => this.node.contains(this.node.ownerDocument.activeElement),
        }));
        this.toDispose.push(this.keybindings.registerKeybinding({ command: 'nodu.problems.find', keybinding: 'ctrlcmd+f', when: 'nodu.problemsPanelFocus' }));
        this.refresh();
    }

    private refresh(): void {
        this.items = collectProblems(this.manager.findMarkers());
        this.changed.fire(this.counts);
        this.update();
    }

    protected override onActivateRequest(message: import('@theia/core/shared/@lumino/messaging').Message): void {
        super.onActivateRequest(message);
        this.filterRef.current?.focus();
    }

    private severity(problem: NoduProblem): number {
        const severity = problem.diagnostic.severity;
        return severity === 1 || severity === 2 ? severity : 3;
    }

    private async open(problem: NoduProblem): Promise<void> {
        try {
            await this.editors.open(new URI(problem.uri), { mode: 'activate', selection: problem.diagnostic.range });
        } catch (error) {
            void this.messages.error(`无法打开问题所在文件：${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async copy(problems: readonly NoduProblem[], key: string): Promise<void> {
        if (!problems.length) { return; }
        const text = formatProblems(problems, problem => this.labels.getLongName(new URI(problem.uri)));
        const sequence = ++this.copySequence;
        try {
            await this.clipboard.writeText(text);
            if (sequence !== this.copySequence || this.isDisposed) { return; }
            this.copied = key;
            if (this.copyFeedback) { clearTimeout(this.copyFeedback); }
            this.copyFeedback = setTimeout(() => { this.copied = undefined; this.copyFeedback = undefined; this.update(); }, 1500);
            this.update();
        } catch {
            if (sequence === this.copySequence && !this.isDisposed) { void this.messages.error('复制问题失败，请重试'); }
        }
    }

    private renderProblem(problem: NoduProblem): React.ReactNode {
        const severity = this.severity(problem);
        const label = severity === 1 ? '错误' : severity === 2 ? '警告' : '提示';
        const icon = severity === 1 ? 'error' : severity === 2 ? 'warning' : 'info';
        const start = problem.diagnostic.range.start;
        const position = `${start.line + 1}:${start.character + 1}`;
        const sources = problem.sources.join('、');
        return <li key={problem.key} className="nodu-problem-entry">
            <button className={`nodu-problem-row nodu-problem-severity-${severity}`} onClick={() => void this.open(problem)}
                title={`${sources ? `${sources} · ` : ''}${position}\n${problem.diagnostic.message}`}
                aria-label={`${label}：${problem.diagnostic.message}，第 ${start.line + 1} 行，第 ${start.character + 1} 列${sources ? `，来源：${sources}` : ''}`}>
                <i className={`codicon codicon-${icon}`} aria-hidden="true"/>
                <span className="nodu-problem-message">{problem.diagnostic.message}</span>
                <span className="nodu-problem-position">{position}</span>
            </button>
            <button type="button" className="nodu-problem-copy" aria-label="复制问题" title={this.copied === problem.key ? '已复制' : '复制问题'}
                onClick={() => void this.copy([problem], problem.key)}><i className={`codicon codicon-${this.copied === problem.key ? 'check' : 'copy'}`} aria-hidden="true"/></button>
        </li>;
    }

    protected render(): React.ReactNode {
        const query = this.query.trim().toLocaleLowerCase();
        const visible = this.items.filter(problem => !this.hiddenSeverities.has(this.severity(problem))
            && (!query || `${problem.uri}\n${problem.diagnostic.message}\n${problem.sources.join(' ')}`.toLocaleLowerCase().includes(query)));
        const groups = new Map<string, NoduProblem[]>();
        for (const problem of visible) { const list = groups.get(problem.uri) ?? []; list.push(problem); groups.set(problem.uri, list); }
        const counts = this.counts;
        return <div className="nodu-problems-content">
            <div className="nodu-problems-toolbar" role="toolbar" aria-label="筛选问题">
                <div className="nodu-problems-filter">
                    <i className="codicon codicon-filter" aria-hidden="true"/>
                    <input ref={this.filterRef} aria-label="筛选问题" placeholder="筛选问题" value={this.query}
                        onChange={event => { this.query = event.currentTarget.value; this.update(); }}
                        onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); this.query = ''; this.update(); } }}/>
                </div>
                {([{ severity: 1, icon: 'error', label: '错误', count: counts.errors },
                    { severity: 2, icon: 'warning', label: '警告', count: counts.warnings },
                    { severity: 3, icon: 'info', label: '提示', count: counts.infos }]).map(item =>
                    <button key={item.severity} className={`nodu-problem-filter-toggle nodu-problem-severity-${item.severity}`}
                        aria-label={`${item.label} ${item.count}`} title={`${this.hiddenSeverities.has(item.severity) ? '显示' : '隐藏'}${item.label}`}
                        aria-pressed={!this.hiddenSeverities.has(item.severity)} onClick={() => {
                            if (this.hiddenSeverities.has(item.severity)) { this.hiddenSeverities.delete(item.severity); }
                            else { this.hiddenSeverities.add(item.severity); }
                            this.update();
                        }}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/><span>{item.count}</span></button>)}
                <button type="button" className="nodu-problem-copy nodu-problems-copy-all" aria-label="复制全部问题" title={this.copied === 'all' ? '已复制全部问题' : '复制全部问题'} disabled={!this.items.length}
                    onClick={() => void this.copy(this.items, 'all')}><i className={`codicon codicon-${this.copied === 'all' ? 'check' : 'copy'}`} aria-hidden="true"/></button>
            </div>
            <div className="nodu-problems-list" tabIndex={0} aria-label="问题列表">
                {!visible.length ? <div className="nodu-problems-empty" role="status">
                    <i className={`codicon codicon-${this.items.length ? 'search' : 'check'}`} aria-hidden="true"/>
                    <span>{this.items.length ? '无匹配问题' : '没有问题'}</span>
                </div> : [...groups].map(([uriString, items], index) => {
                    const uri = new URI(uriString);
                    const expanded = !this.collapsed.has(uriString);
                    const groupId = `${this.id}-group-${index}`;
                    return <section className="nodu-problem-file" key={uriString}>
                        <button className="nodu-problem-file-header" title={this.labels.getLongName(uri)} aria-expanded={expanded} aria-controls={groupId}
                            onClick={() => { if (expanded) { this.collapsed.add(uriString); } else { this.collapsed.delete(uriString); } this.update(); }}>
                            <i className={`codicon codicon-chevron-${expanded ? 'down' : 'right'}`} aria-hidden="true"/>
                            <span className="nodu-problem-filename">{this.labels.getName(uri)}</span>
                            <span className="nodu-problem-directory">{this.labels.getLongName(uri.parent)}</span>
                            <span className="nodu-problem-file-count">{items.length}</span>
                        </button>
                        <ul id={groupId} hidden={!expanded}>{items.map(problem => this.renderProblem(problem))}</ul>
                    </section>;
                })}
            </div>
        </div>;
    }
}
