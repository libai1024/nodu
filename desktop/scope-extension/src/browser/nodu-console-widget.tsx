// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KeybindingRegistry, ReactWidget } from '@theia/core/lib/browser';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { CommandRegistry, CommandService } from '@theia/core/lib/common';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { NoduDeviceLog, NoduDeviceModel } from './nodu-device-client';
import { canBrowsePythonHistory, ConsoleBuffer, ConsoleMatch, ConsoleRecord, findConsoleMatches, shouldExecutePython } from './nodu-console-state';
import '../../style/console-panel.css';

type ConsoleView = 'output' | 'repl';
interface ReadingState {
    cutoff: number;
    follow: boolean;
    unread: number;
    scrollTop: number;
    findOpen: boolean;
    query: string;
    matchIndex: number;
}
interface WorkspaceConsoleState {
    output: ConsoleBuffer;
    repl: ConsoleBuffer;
    reading: Record<ConsoleView, ReadingState>;
    code: string;
    executing: boolean;
    history: string[];
    historyIndex: number | undefined;
    historyDraft: string;
    historySession: string;
}
const readingState = (): ReadingState => ({ cutoff: 0, follow: true, unread: 0, scrollTop: 0, findOpen: false, query: '', matchIndex: 0 });
const workspaceState = (output = new ConsoleBuffer()): WorkspaceConsoleState => ({
    output, repl: new ConsoleBuffer(), reading: { output: readingState(), repl: readingState() }, code: '', executing: false,
    history: [], historyIndex: undefined, historyDraft: '', historySession: ''
});

@injectable()
export class NoduConsoleWidget extends ReactWidget {
    static readonly ID = 'nodu:console';
    static readonly LABEL = '运行输出';
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings!: KeybindingRegistry;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    private view: ConsoleView = 'output';
    private active = workspaceState();
    private readonly workspaces = new Map<string, WorkspaceConsoleState>();
    private readonly output = React.createRef<HTMLPreElement>();
    private readonly input = React.createRef<HTMLTextAreaElement>();
    private readonly findInput = React.createRef<HTMLInputElement>();
    private frame: number | undefined;
    private restoreScroll = false;
    private sessionEpoch = 0;
    private wasConnected = false;
    private connectedPort = '';
    private feedback = '';

    @postConstruct()
    protected init(): void {
        this.id = NoduConsoleWidget.ID;
        this.title.label = NoduConsoleWidget.LABEL;
        this.title.iconClass = 'codicon codicon-terminal';
        this.title.closable = false;
        this.addClass('scope-widget');
        this.addClass('nodu-console-widget');
        // Theia resolves shortcuts on document capture, ahead of React events.
        const localContext = this.contextKeys.createScoped(this.node);
        localContext.createKey('nodu.consoleFocus', true);
        this.toDispose.push(localContext);
        this.toDispose.push(this.commandRegistry.registerCommand({ id: 'nodu.console.find', label: '在 K210 控制台中查找' }, {
            execute: () => this.openFind(),
            isEnabled: () => this.node.contains(this.node.ownerDocument.activeElement),
        }));
        this.toDispose.push(this.keybindings.registerKeybinding({ command: 'nodu.console.find', keybinding: 'ctrlcmd+f', when: 'nodu.consoleFocus' }));
        this.active = workspaceState(new ConsoleBuffer(this.device.logs, this.device.logSequence));
        this.workspaces.set(this.workspaceKey(), this.active);
        this.wasConnected = this.device.connected;
        this.connectedPort = this.device.state.port || '';
        this.toDispose.push(this.device.onDidLog(log => {
            this.active.output.append(log.text, log.stream, (log as NoduDeviceLog).clippedCharacters || 0);
            this.recordArrived(this.active, 'output');
        }));
        this.toDispose.push(this.device.onDidChange(() => {
            const port = this.device.state.port || '';
            if (this.device.connected && (!this.wasConnected || port !== this.connectedPort)) { this.sessionEpoch++; }
            this.wasConnected = this.device.connected;
            this.connectedPort = port;
            this.refresh();
        }));
        this.toDispose.push(this.workspace.onWorkspaceChanged(() => {
            this.saveScroll();
            const key = this.workspaceKey();
            let state = this.workspaces.get(key);
            if (!state) { state = workspaceState(); this.workspaces.set(key, state); }
            this.active = state;
            this.restoreScroll = true;
            this.feedback = '';
            this.refresh();
        }));
        this.update();
    }

    /** The shared bottom-panel container owns navigation; changing views has no device side effects. */
    setView(view: ConsoleView): void {
        if (view === this.view) { if (this.reading.follow) { this.reading.unread = 0; } this.refresh(); return; }
        this.saveScroll();
        this.view = view;
        this.title.label = view === 'output' ? '运行输出' : 'Python 交互';
        if (this.reading.follow) { this.reading.unread = 0; }
        this.restoreScroll = true;
        this.feedback = '';
        this.refresh();
    }

    private workspaceKey(): string { return this.workspace.workspace?.resource.toString() || 'empty-workspace'; }
    private get reading(): ReadingState { return this.active.reading[this.view]; }
    private records(): ConsoleRecord[] { return this.active[this.view].records.filter(record => record.sequence > this.reading.cutoff); }
    private saveScroll(): void { if (this.output.current) { this.reading.scrollTop = this.output.current.scrollTop; } }

    private refresh(): void {
        if (this.isDisposed) { return; }
        this.update();
        if (this.frame !== undefined) { return; }
        this.frame = requestAnimationFrame(() => {
            this.frame = undefined;
            const node = this.output.current;
            if (node) {
                if (this.reading.follow) { node.scrollTop = node.scrollHeight; }
                else if (this.restoreScroll) { node.scrollTop = this.reading.scrollTop; }
            }
            this.restoreScroll = false;
        });
    }

    private recordArrived(state: WorkspaceConsoleState, view: ConsoleView): void {
        const reading = state.reading[view];
        if (state !== this.active || view !== this.view || !this.isVisible || !reading.follow) { reading.unread++; }
        if (state === this.active) { this.refresh(); }
    }

    private followLatest(): void {
        this.reading.follow = true;
        this.reading.unread = 0;
        this.refresh();
    }

    private clearDisplay(): void {
        this.reading.cutoff = this.active[this.view].sequence;
        this.reading.unread = 0;
        this.reading.matchIndex = 0;
        this.reading.scrollTop = 0;
        this.feedback = '';
        this.refresh();
    }

    private async copyOutput(): Promise<void> {
        try { await this.clipboard.writeText(this.records().map(record => record.text).join('')); }
        catch (error) { this.feedback = `复制失败：${error instanceof Error ? error.message : String(error)}`; this.refresh(); }
    }

    private toggleFind(): void {
        if (!this.reading.findOpen) { this.openFind(); return; }
        this.reading.findOpen = false;
        this.refresh();
    }

    private openFind(): void {
        this.reading.findOpen = true;
        this.refresh();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.reading.findOpen) { this.findInput.current?.focus(); this.findInput.current?.select(); }
        }));
    }

    private searchResult(): ReturnType<typeof findConsoleMatches> {
        return findConsoleMatches(this.records().map(record => record.text).join(''), this.reading.findOpen ? this.reading.query : '');
    }

    private revealMatch(delta = 0): void {
        const { matches } = this.searchResult();
        if (!matches.length) { this.reading.matchIndex = 0; this.refresh(); return; }
        this.reading.matchIndex = (this.reading.matchIndex + delta + matches.length) % matches.length;
        this.reading.follow = false;
        this.refresh();
        requestAnimationFrame(() => {
            this.output.current?.querySelector<HTMLElement>(`[data-console-match="${this.reading.matchIndex}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
        });
    }

    private get executionBlocked(): string {
        if (this.active.executing) { return 'Python 执行中'; }
        if (!this.device.connected) { return this.device.state.phase === 'connecting' ? '开发板连接中' : '开发板未连接'; }
        if (!this.device.state.capabilities.repl) { return '当前设备不支持 Python 交互'; }
        if (this.device.state.running) { return '程序运行中，停止后可执行'; }
        if (this.device.busy) { return this.device.statusLabel || '设备忙'; }
        return '';
    }

    private ensureHistorySession(): void {
        const session = `${this.sessionEpoch}:${this.device.state.port || this.device.selectedPort}`;
        if (this.active.historySession !== session) {
            this.active.historySession = session;
            this.active.history = [];
            this.active.historyIndex = undefined;
            this.active.historyDraft = '';
        }
    }

    private async execute(): Promise<void> {
        if (this.executionBlocked || !this.active.code.trim()) { return; }
        this.ensureHistorySession();
        const state = this.active;
        const submitted = state.code;
        state.executing = true;
        state.historyIndex = undefined;
        if (state.history.at(-1) !== submitted) { state.history.push(submitted); }
        while (state.history.length > 50 || state.history.reduce((sum, value) => sum + value.length, 0) > 200000) { state.history.shift(); }
        state.repl.append(submitted.split('\n').map((line, index) => `${index ? '... ' : '>>> '}${line}`).join('\n') + '\n', 'command');
        this.recordArrived(state, 'repl');
        const submittedSequence = state.repl.sequence;
        try {
            const result = await this.device.execute(submitted);
            if (result === undefined) {
                state.repl.append(`${this.device.error || 'Python 执行未完成，请检查设备连接。'}\n`, 'stderr');
            } else {
                // The RPC result belongs to this command; generic device events do not.
                if (result) { state.repl.append(result.endsWith('\n') ? result : `${result}\n`, 'stdout'); }
                if (state.code === submitted) { state.code = ''; }
            }
        } catch (error) {
            state.repl.append(`${error instanceof Error ? error.message : String(error)}\n`, 'stderr');
        } finally {
            state.executing = false;
            if (state.repl.sequence > submittedSequence) { this.recordArrived(state, 'repl'); }
            else if (state === this.active) { this.refresh(); }
        }
    }

    private browseHistory(event: React.KeyboardEvent<HTMLTextAreaElement>, direction: 'previous' | 'next'): void {
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) { return; }
        const input = event.currentTarget;
        if (!canBrowsePythonHistory(this.active.code, input.selectionStart, input.selectionEnd, direction)) { return; }
        this.ensureHistorySession();
        const state = this.active;
        if (!state.history.length || (direction === 'next' && state.historyIndex === undefined)) { return; }
        event.preventDefault();
        event.stopPropagation();
        if (state.historyIndex === undefined) { state.historyDraft = state.code; state.historyIndex = state.history.length; }
        state.historyIndex = Math.max(0, Math.min(state.history.length, state.historyIndex + (direction === 'previous' ? -1 : 1)));
        state.code = state.historyIndex === state.history.length ? state.historyDraft : state.history[state.historyIndex];
        if (state.historyIndex === state.history.length) { state.historyIndex = undefined; }
        this.refresh();
        requestAnimationFrame(() => { this.input.current?.setSelectionRange(state.code.length, state.code.length); });
    }

    private onInputKey(event: React.KeyboardEvent<HTMLTextAreaElement>): void {
        const native = event.nativeEvent as KeyboardEvent;
        if (native.isComposing || native.keyCode === 229) { return; }
        if (event.key === 'Enter') {
            event.stopPropagation();
            if (shouldExecutePython(this.active.code, { ...event, isComposing: native.isComposing, keyCode: native.keyCode })) {
                event.preventDefault();
                void this.execute();
            }
        } else if (event.key === 'ArrowUp') { this.browseHistory(event, 'previous'); }
        else if (event.key === 'ArrowDown') { this.browseHistory(event, 'next'); }
    }

    private renderText(record: ConsoleRecord, offset: number, matches: ConsoleMatch[]): React.ReactNode {
        const pieces: React.ReactNode[] = [];
        let local = 0;
        matches.forEach((match, index) => {
            const start = Math.max(0, match.start - offset);
            const end = Math.min(record.text.length, match.end - offset);
            if (end <= 0 || start >= record.text.length || end <= start) { return; }
            if (start > local) { pieces.push(record.text.slice(local, start)); }
            pieces.push(<mark key={index} data-console-match={index} className={index === this.reading.matchIndex ? 'is-current' : undefined}>{record.text.slice(start, end)}</mark>);
            local = end;
        });
        pieces.push(record.text.slice(local));
        return <span key={record.sequence} className={`nodu-console-record is-${record.stream}`}>{pieces}</span>;
    }

    protected render(): React.ReactNode {
        const records = this.records();
        const reading = this.reading;
        const result = this.searchResult();
        const currentMatch = result.matches.length ? Math.min(reading.matchIndex + 1, result.matches.length) : 0;
        const buffer = this.active[this.view];
        const firstRetained = buffer.records[0]?.sequence ?? buffer.sequence + 1;
        const removed = Math.max(0, firstRetained - reading.cutoff - 1);
        const clipped = records.reduce((sum, record) => sum + record.clippedCharacters, 0);
        const connection = this.device.connected ? '已连接' : this.device.state.phase === 'connecting' ? '连接中' : this.device.state.phase === 'error' ? '连接异常' : '未连接';
        const busy = this.active.executing || this.device.busy || this.device.state.phase === 'connecting';
        const status = this.active.executing ? 'Python 执行中' : this.device.state.running ? '程序运行中' : busy ? this.device.statusLabel : '';
        const deviceStatus = [connection, this.device.state.port, status, this.device.state.phase === 'error' ? this.device.error : ''].filter(Boolean).join(' · ');
        const deviceIcon = this.device.state.phase === 'error' ? 'error' : busy ? 'loading codicon-modifier-spin' : 'plug';
        const truncation = [removed > 0 ? `${removed} 条较早输出已移出缓冲` : '', clipped > 0 ? `长输出已截断 ${clipped} 字符` : ''].filter(Boolean).join('；');
        const blocked = this.executionBlocked;
        const hasOutput = !!records.length;
        const menuAction = (action: () => void) => (event: React.MouseEvent<HTMLButtonElement>): void => {
            const details = event.currentTarget.closest('details');
            if (details) { details.open = false; }
            action();
        };
        let offset = 0;
        return <div className="nodu-console-page" data-console-view={this.view} onKeyDown={event => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); this.openFind(); }
            if (event.key === 'Escape' && reading.findOpen) { event.preventDefault(); event.stopPropagation(); reading.findOpen = false; this.refresh(); this.output.current?.focus(); }
        }}>
            <div className="nodu-console-context">
                <div className="nodu-console-identity">
                    <button type="button" className={`nodu-console-icon nodu-console-device${this.device.state.phase === 'error' ? ' is-error' : this.device.connected ? ' is-connected' : ''}`} aria-label={`选择开发板 · ${deviceStatus}`} title={`选择开发板 · ${deviceStatus}`} onClick={() => void this.commands.executeCommand('scope.show-devices')}><i className={`codicon codicon-${deviceIcon}`} aria-hidden="true"/></button>
                    <span className="nodu-console-sr-only" role="status" aria-live="polite">{deviceStatus}</span>
                    {this.device.state.running && !this.active.executing && <button type="button" className="nodu-console-icon" aria-label="停止程序" title="停止程序" disabled={!this.device.canStop} onClick={() => void this.commands.executeCommand('scope.stop-device')}><i className="codicon codicon-debug-stop" aria-hidden="true"/></button>}
                    {truncation && <span className="nodu-console-buffer-note" role="status" aria-label={truncation} title={truncation}><i className="codicon codicon-warning" aria-hidden="true"/></span>}
                </div>
                <div className="nodu-console-reading-actions">
                    <button type="button" className="nodu-console-icon direct-reading" onClick={() => this.toggleFind()} aria-label="查找输出" aria-pressed={reading.findOpen} title="查找输出 · Ctrl/⌘+F"><i className="codicon codicon-search" aria-hidden="true"/></button>
                    <button type="button" className="nodu-console-icon direct-reading" onClick={() => { if (reading.follow) { reading.follow = false; this.refresh(); } else { this.followLatest(); } }} aria-label="自动跟随输出" aria-pressed={reading.follow} title={reading.follow ? '关闭自动跟随' : '跟随最新输出'}><i className="codicon codicon-arrow-down" aria-hidden="true"/></button>
                    <button type="button" className="nodu-console-icon direct-clear" onClick={() => this.clearDisplay()} disabled={!hasOutput} aria-label="清空输出" title="清空输出"><i className="codicon codicon-clear-all" aria-hidden="true"/></button>
                    <details className="nodu-console-more">
                        <summary className="nodu-console-icon" aria-label="输出选项" title="输出选项"><i className="codicon codicon-ellipsis" aria-hidden="true"/></summary>
                        <div className="nodu-console-menu">
                            <button type="button" className="menu-reading" onClick={menuAction(() => this.toggleFind())}>查找输出</button>
                            <button type="button" className="menu-reading" onClick={menuAction(() => { reading.follow ? (reading.follow = false, this.refresh()) : this.followLatest(); })}>{reading.follow ? '关闭自动跟随' : '跟随最新输出'}</button>
                            <button type="button" onClick={menuAction(() => { void this.copyOutput(); })} disabled={!hasOutput}>复制当前页输出</button>
                            <button type="button" className="menu-clear" onClick={menuAction(() => this.clearDisplay())} disabled={!hasOutput}>清空显示</button>
                            {this.view === 'repl' && <button type="button" onClick={menuAction(() => { this.active.history = []; this.active.historyIndex = undefined; this.active.historyDraft = ''; this.refresh(); })} disabled={!this.active.history.length}>清除输入历史</button>}
                        </div>
                    </details>
                </div>
            </div>
            {reading.findOpen && <div className="nodu-console-find">
                <input ref={this.findInput} type="search" aria-label="查找当前页输出" placeholder="查找当前页输出" value={reading.query} onChange={event => { reading.query = event.currentTarget.value; reading.matchIndex = 0; this.revealMatch(); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); this.revealMatch(event.shiftKey ? -1 : 1); } }}/>
                <span className="nodu-console-find-count" role="status" aria-live="polite">{reading.query ? `${currentMatch}/${result.matches.length}${result.hasMore ? '+' : ''}` : ''}</span>
                <button type="button" className="nodu-console-icon" aria-label="上一个匹配" title="上一个匹配 · Shift+Enter" disabled={!result.matches.length} onClick={() => this.revealMatch(-1)}><i className="codicon codicon-arrow-up" aria-hidden="true"/></button>
                <button type="button" className="nodu-console-icon" aria-label="下一个匹配" title="下一个匹配 · Enter" disabled={!result.matches.length} onClick={() => this.revealMatch(1)}><i className="codicon codicon-arrow-down" aria-hidden="true"/></button>
                <button type="button" className="nodu-console-icon" aria-label="关闭查找" title="关闭查找 · Esc" onClick={() => this.toggleFind()}><i className="codicon codicon-close" aria-hidden="true"/></button>
            </div>}
            <div className="nodu-console-scroll-region">
                <pre key={this.view} ref={this.output} className="nodu-console-transcript" tabIndex={0} aria-label={this.view === 'output' ? '设备共享输出' : 'Python 命令与结果'} onScroll={event => {
                    const node = event.currentTarget;
                    const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 20;
                    reading.scrollTop = node.scrollTop;
                    if (atBottom && reading.unread) { reading.unread = 0; this.update(); }
                    // Programmatic search/navigation must not re-enable follow.
                    if (reading.follow && !atBottom) { reading.follow = false; this.update(); }
                    else if (atBottom && !reading.follow && !reading.findOpen && !this.restoreScroll) { reading.follow = true; this.update(); }
                }}>{records.map(record => { const rendered = this.renderText(record, offset, result.matches); offset += record.text.length; return rendered; })}</pre>
                {reading.unread > 0 && !reading.follow && <button type="button" className="nodu-console-unread" onClick={() => this.followLatest()} aria-label={`${reading.unread} 条新输出，跳到最新输出并恢复跟随`} title={`${reading.unread} 条新输出，跳到最新输出并恢复跟随`}><i className="codicon codicon-arrow-down" aria-hidden="true"/>{reading.unread}</button>}
            </div>
            {this.feedback && <div className="nodu-console-notice is-error" role="alert">{this.feedback}<button type="button" className="nodu-console-icon" aria-label="关闭错误提示" title="关闭错误提示" onClick={() => { this.feedback = ''; this.refresh(); }}><i className="codicon codicon-close" aria-hidden="true"/></button></div>}
            {this.view === 'repl' && <>
                <div className="nodu-console-composer">
                    <span className="nodu-console-prompt" aria-hidden="true">&gt;&gt;&gt;</span>
                    <textarea ref={this.input} aria-label="Python 代码" placeholder="输入 Python 代码…" rows={Math.min(4, Math.max(1, this.active.code.split('\n').length))} value={this.active.code} spellCheck={false} title="Enter 执行；Shift+Enter 换行；多行用 Ctrl/⌘+Enter 执行" onChange={event => { this.active.code = event.currentTarget.value; this.active.historyIndex = undefined; this.refresh(); }} onKeyDown={event => this.onInputKey(event)}/>
                    <button type="button" className="nodu-console-execute" disabled={!!blocked || !this.active.code.trim()} aria-label={blocked ? `执行 Python · ${blocked}` : '执行 Python'} title={blocked || '执行 Python · Enter（多行 Ctrl/⌘+Enter）'} onClick={() => void this.execute()}><i className={`codicon ${this.active.executing ? 'codicon-loading codicon-modifier-spin' : 'codicon-debug-start'}`} aria-hidden="true"/></button>
                </div>
            </>}
        </div>;
    }

    override dispose(): void {
        if (this.frame !== undefined) { cancelAnimationFrame(this.frame); }
        super.dispose();
    }

    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        if (this.reading.follow) { this.reading.unread = 0; }
        this.restoreScroll = true;
        this.refresh();
    }
}
