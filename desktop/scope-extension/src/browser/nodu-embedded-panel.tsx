// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { KeybindingRegistry, ReactWidget } from '@theia/core/lib/browser';
import { CommandRegistry } from '@theia/core/lib/common/command';
import { ContextKeyService } from '@theia/core/lib/browser/context-key-service';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { URI } from '@theia/core/lib/common/uri';
import { Diagnostic } from '../common/nodu-embedded-protocol';
import { parseSerialDraft, serialHex, SerialEnding, SerialFormat } from '../common/nodu-serial-data';
import { NoduEmbeddedModel, PanelTab, MonitorLine, formatBytes } from './nodu-embedded-model';
import '../../style/embedded-panel.css';

/** Content only: the workbench owns platform navigation and the real shell terminal. */
@injectable()
export class NoduEmbeddedPanel extends ReactWidget {
    static readonly ID = 'nodu:c-panel';
    static readonly LABEL = '构建与下载';
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(CommandRegistry) protected readonly commandRegistry!: CommandRegistry;
    @inject(KeybindingRegistry) protected readonly keybindings!: KeybindingRegistry;
    @inject(ContextKeyService) protected readonly contextKeys!: ContextKeyService;
    private readonly logRef = React.createRef<HTMLDivElement>();
    private readonly searchRef = React.createRef<HTMLInputElement>();
    private follow = true;
    private draft = '';
    private lineEnding: SerialEnding = 'none';
    private receiveFormat: SerialFormat = 'text';
    private sendFormat: SerialFormat = 'text';
    private sendError = '';
    private query = '';
    private searching = false;
    private matchIndex = -1;
    private frame: number | undefined;
    private draftProject = '';
    private readonly projectDrafts = new Map<string, string>();
    private currentView: PanelTab = 'output';
    private readonly readingState = new Map<PanelTab, { follow: boolean; query: string; searching: boolean; scrollTop: number }>();

    @postConstruct()
    protected init(): void {
        this.id = NoduEmbeddedPanel.ID;
        this.title.label = NoduEmbeddedPanel.LABEL;
        this.title.iconClass = 'codicon codicon-output';
        this.title.closable = false;
        this.addClass('scope-widget');
        this.addClass('nodu-c-panel');
        // Theia handles keys on document capture, before React or node listeners.
        // A DOM-scoped key makes this command win over the editor's global Find.
        const localContext = this.contextKeys.createScoped(this.node);
        localContext.createKey('nodu.embeddedPanelFocus', true);
        this.toDispose.push(localContext);
        this.toDispose.push(this.commandRegistry.registerCommand({ id: 'nodu.c.find-panel', label: '在 STM32 面板中查找' }, {
            execute: () => this.openSearch(),
            isEnabled: () => this.node.contains(this.node.ownerDocument.activeElement),
        }));
        this.toDispose.push(this.keybindings.registerKeybinding({ command: 'nodu.c.find-panel', keybinding: 'ctrlcmd+f', when: 'nodu.embeddedPanelFocus' }));
        const repaint = (): void => {
            if (this.frame !== undefined) { return; }
            this.frame = requestAnimationFrame(() => { this.frame = undefined; this.update(); requestAnimationFrame(() => this.scroll()); });
        };
        this.toDispose.push(this.model.onDidChange(repaint));
        this.toDispose.push(this.model.onDidMonitor(repaint));
        this.currentView = this.model.panelTab;
        this.draftProject = this.model.project?.path || '';
        this.toDispose.push(this.model.onDidChangeProject(project => {
            this.projectDrafts.set(this.draftProject, this.draft);
            this.draftProject = project?.path || '';
            this.draft = this.projectDrafts.get(this.draftProject) || '';
            this.sendError = ''; repaint();
        }));
        this.toDispose.push({ dispose: () => { if (this.frame !== undefined) { cancelAnimationFrame(this.frame); } } });
        this.update();
    }

    public setView(view: PanelTab): void {
        if (view === this.currentView) { return; }
        this.readingState.set(this.currentView, { follow: this.follow, query: this.query, searching: this.searching, scrollTop: this.logRef.current?.scrollTop || 0 });
        this.currentView = view;
        this.model.panelTab = view;
        const saved = this.readingState.get(view);
        this.follow = saved?.follow ?? true;
        this.query = saved?.query ?? ''; this.searching = saved?.searching ?? false; this.matchIndex = -1;
        this.model.fire();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            if (this.currentView === view && this.logRef.current) { this.logRef.current.scrollTop = saved?.follow === false ? saved.scrollTop : this.logRef.current.scrollHeight; }
        }));
    }

    private scroll(): void {
        const node = this.logRef.current;
        if (node && this.follow) { node.scrollTop = node.scrollHeight; }
    }

    private readonly onScroll = (event: React.UIEvent<HTMLDivElement>): void => {
        const node = event.currentTarget;
        const following = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
        if (following !== this.follow) { this.follow = following; this.update(); }
    };

    private async open(d: Diagnostic): Promise<void> {
        if (!d.absolute) { return; }
        const line = Math.max(0, (d.line ?? 1) - 1);
        const character = Math.max(0, (d.column ?? 1) - 1);
        await this.editors.open(URI.fromFilePath(this.model.toLocal(d.absolute)), { mode: 'activate', selection: { start: { line, character }, end: { line, character } } });
    }

    private icon(name: string, label: string, action: () => void, pressed?: boolean): React.ReactNode {
        return <button className="nodu-ep-icon" title={label} aria-label={label} aria-pressed={pressed} onClick={action}>
            <i className={`codicon codicon-${name}`} aria-hidden="true"/>
        </button>;
    }

    private text(line: MonitorLine): string {
        return this.receiveFormat === 'hex' && line.bytes ? serialHex(line.bytes) : line.text;
    }

    private highlight(text: string): React.ReactNode {
        if (!this.query) { return text; }
        const lower = text.toLocaleLowerCase(), needle = this.query.toLocaleLowerCase();
        const parts: React.ReactNode[] = [];
        let start = 0, index = lower.indexOf(needle);
        while (index >= 0) {
            parts.push(text.slice(start, index), <mark key={index}>{text.slice(index, index + needle.length)}</mark>);
            start = index + needle.length; index = lower.indexOf(needle, start);
        }
        parts.push(text.slice(start)); return parts;
    }

    private searchCount(): number {
        if (!this.query) { return 0; }
        const needle = this.query.toLocaleLowerCase();
        const lines = this.model.panelTab === 'monitor' ? this.model.monitorLines.map(line => this.text(line))
            : this.model.panelTab === 'output' ? this.model.output : [];
        let count = 0;
        for (const line of lines) {
            const text = line.toLocaleLowerCase();
            let index = text.indexOf(needle);
            while (index >= 0) { count++; index = text.indexOf(needle, index + needle.length); }
        }
        return count;
    }

    private openSearch(): void {
        this.searching = true;
        this.update();
        requestAnimationFrame(() => requestAnimationFrame(() => {
            this.searchRef.current?.focus(); this.searchRef.current?.select();
        }));
    }

    private closeSearch(): void {
        this.searching = false; this.query = ''; this.matchIndex = -1;
        this.update();
        requestAnimationFrame(() => this.logRef.current?.focus());
    }

    private readonly onPanelKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        const native = event.nativeEvent as KeyboardEvent;
        if (native.isComposing || native.keyCode === 229) { return; }
        if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'f') {
            event.preventDefault(); event.stopPropagation(); this.openSearch();
        } else if (event.key === 'Escape' && this.searching) {
            event.preventDefault(); event.stopPropagation(); this.closeSearch();
        }
    };

    private readonly onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
        const native = event.nativeEvent as KeyboardEvent;
        if (native.isComposing || native.keyCode === 229 || event.key !== 'Enter') { return; }
        event.preventDefault(); event.stopPropagation(); this.findNext(event.shiftKey ? -1 : 1);
    };

    private findNext(direction = 1): void {
        const marks = this.logRef.current?.querySelectorAll('mark');
        if (!marks?.length) { return; }
        this.follow = false;
        this.matchIndex = this.matchIndex < 0 ? (direction < 0 ? marks.length - 1 : 0)
            : (this.matchIndex + direction + marks.length) % marks.length;
        marks.forEach((mark, index) => {
            mark.setAttribute('aria-current', String(index === this.matchIndex));
            mark.style.outline = index === this.matchIndex ? '1px solid var(--theia-focusBorder)' : '';
        });
        marks[this.matchIndex].scrollIntoView({ block: 'center' });
        this.update();
    }

    private readingActions(serial: boolean): React.ReactNode {
        const text = serial ? this.model.monitorLines.map(line => `${new Date(line.at).toLocaleTimeString()} ${line.direction || 'SYS'} ${this.text(line)}`).join('\n') : this.model.output.join('\n');
        return <div className="nodu-ep-actions">
            {this.icon('search', '查找', () => { this.searching = !this.searching; if (!this.searching) { this.query = ''; } this.update(); }, this.searching)}
            {this.icon('arrow-down', this.follow ? '正在跟随最新输出' : '跟随最新输出', () => { this.follow = !this.follow; this.update(); requestAnimationFrame(() => this.scroll()); }, this.follow)}
            {this.icon('copy', '复制当前显示格式的全部输出', () => void this.clipboard.writeText(text))}
            {this.icon('clear-all', '清空显示', () => { if (serial) { this.model.clearMonitor(); } else { this.model.output.length = 0; this.model.fire(); } })}
        </div>;
    }

    protected render(): React.ReactNode {
        const serial = this.model.panelTab === 'monitor';
        const matches = this.searching ? this.searchCount() : 0;
        return <div className="nodu-ep" aria-label={serial ? '串口监视' : '构建与下载'} onKeyDownCapture={this.onPanelKeyDown}>
            {serial ? this.monitorContext() : this.buildContext()}
            {this.searching && <div className="nodu-ep-search">
                <input ref={this.searchRef} autoFocus aria-label="查找输出" placeholder="查找输出" value={this.query} onChange={event => { this.query = event.currentTarget.value; this.matchIndex = -1; this.update(); }}
                    onKeyDown={this.onSearchKeyDown}/>
                <span role="status" aria-label={`${matches} 个匹配`}>{matches ? `${Math.min(this.matchIndex + 1, matches)} / ${matches}` : '0 / 0'}</span>
                <button className="nodu-ep-icon" disabled={!matches} aria-label="上一个匹配" title="上一个匹配（Shift+Enter）" onClick={() => this.findNext(-1)}><i className="codicon codicon-arrow-up" aria-hidden="true"/></button>
                <button className="nodu-ep-icon" disabled={!matches} aria-label="下一个匹配" title="下一个匹配（Enter）" onClick={() => this.findNext()}><i className="codicon codicon-arrow-down" aria-hidden="true"/></button>
                <button className="nodu-ep-icon" aria-label="关闭查找" title="关闭查找（Escape）" onClick={() => this.closeSearch()}><i className="codicon codicon-close" aria-hidden="true"/></button>
            </div>}
            {serial ? this.monitorBody() : this.buildBody()}
            {serial && this.sendBar()}
        </div>;
    }

    private buildContext(): React.ReactNode {
        const model = this.model;
        return <div className="nodu-ep-context">
            <div className="nodu-ep-segment" aria-label="构建内容">
                <button aria-pressed={model.panelTab === 'output'} onClick={() => this.setView('output')}>输出</button>
                <button aria-pressed={model.panelTab === 'problems'} onClick={() => this.setView('problems')}>诊断{model.errors.length ? ` ${model.errors.length}` : ''}</button>
            </div>
            <span className="nodu-ep-context-note">{model.busy && <i className="codicon codicon-loading codicon-modifier-spin" role="status" aria-label={model.task?.text || '处理中'} title={model.task?.text}/>}</span>
            {this.readingActions(false)}
        </div>;
    }

    private buildBody(): React.ReactNode {
        const model = this.model;
        return <>
            {model.awaitUser === 'exitBoot' && <div className="nodu-ep-notice" role="status"><span>请恢复 BOOT 配置并复位。</span><button onClick={() => void model.finishBoot()}>已恢复并复位</button></div>}
            {model.panelTab === 'problems' ? <div className="nodu-ep-diagnostics">{this.problems()}</div> :
                <div ref={this.logRef} className="nodu-ep-log" tabIndex={0} aria-label="构建与下载输出" onScroll={this.onScroll}>
                    {model.output.map((line, index) => <div key={index}>{this.highlight(line) || '\u00a0'}</div>)}
                </div>}
        </>;
    }

    private monitorContext(): React.ReactNode {
        const model = this.model;
        const locked = model.monitor.open || model.monitorBusy || model.monitor.state === 'lent';
        const available = model.ports.some(port => port.path === model.monitorPort);
        const connection = model.monitorBusy ? '正在连接' : model.monitor.open ? '已连接' : model.monitor.state === 'lent' ? '下载占用' : '未连接';
        const action = model.monitor.open ? '断开串口' : '连接串口';
        return <div className="nodu-ep-context nodu-ep-serial-context">
            <div className="nodu-ep-connection-controls">
            <select className="nodu-ep-port" aria-label="手动选择串口" value={model.monitorPort} disabled={locked} onChange={event => model.setMonitorPort(event.currentTarget.value)}>
                <option value="">选择串口</option>
                {model.monitorPort && !available && <option value={model.monitorPort}>{model.monitorPort.replace('/dev/', '')} · 未检测到</option>}
                {model.ports.map(port => <option key={port.path} value={port.path}>{port.description ? `${port.description} · ` : ''}{port.path.replace('/dev/', '')}</option>)}
            </select>
            {this.icon('refresh', '刷新串口列表', () => void model.refreshDevices())}
            <select className="nodu-ep-baud" aria-label="波特率" value={model.project?.manifest.monitor?.baud ?? 115200} disabled={locked}
                onChange={event => void model.setOption('monitorBaud', Number(event.currentTarget.value))}>
                {Array.from(new Set([9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, model.project?.manifest.monitor?.baud ?? 115200])).sort((a, b) => a - b).map(baud => <option key={baud} value={baud}>{baud}</option>)}
            </select>
            <button className={`nodu-ep-icon ${model.monitor.open ? '' : 'nodu-ep-primary'}`} aria-label={action} title={action} disabled={model.monitorBusy || model.monitor.state === 'lent' || (!model.monitor.open && (!model.monitorPort || model.awaitUser === 'exitBoot'))}
                onClick={() => void model.toggleMonitor()}><i className={`codicon codicon-${model.monitorBusy ? 'loading codicon-modifier-spin' : model.monitor.open ? 'debug-disconnect' : 'plug'}`} aria-hidden="true"/></button>
            </div>
            <div className="nodu-ep-serial-status-tools">
            <span className={`nodu-ep-state nodu-ep-state-${model.monitor.state}`} role="status" aria-label={connection} title={model.monitor.message || connection}><i className={`codicon codicon-${model.monitor.open ? 'circle-filled' : model.monitor.state === 'lent' ? 'lock' : 'circle-outline'}`} aria-hidden="true"/></span>
            <div className="nodu-ep-monitor-desktop">{this.monitorDisplayOptions()}{this.readingActions(true)}</div>
            <details className="nodu-ep-monitor-more">
                <summary title="串口显示与阅读选项" aria-label="串口显示与阅读选项"><i className="codicon codicon-ellipsis" aria-hidden="true"/></summary>
                <div className="nodu-ep-monitor-menu">{this.monitorDisplayOptions()}{this.readingActions(true)}</div>
            </details>
            </div>
        </div>;
    }

    private monitorDisplayOptions(): React.ReactNode {
        const model = this.model;
        return <div className="nodu-ep-display-options">
            <div className="nodu-ep-segment" aria-label="接收显示格式">
                <button aria-pressed={this.receiveFormat === 'text'} onClick={() => { this.receiveFormat = 'text'; this.update(); }}>TEXT</button>
                <button aria-pressed={this.receiveFormat === 'hex'} onClick={() => { this.receiveFormat = 'hex'; this.update(); }}>HEX</button>
            </div>
            <select aria-label="接收文本编码" title="接收文本编码；文本发送使用 UTF-8" value={model.project?.manifest.monitor?.encoding ?? 'utf-8'} disabled={this.receiveFormat === 'hex'} onChange={event => void model.setOption('monitorEncoding', event.currentTarget.value)}>
                <option value="utf-8">UTF-8</option><option value="gbk">GBK</option>
            </select>
        </div>;
    }

    private monitorBody(): React.ReactNode {
        const model = this.model;
        const notice = model.awaitUser === 'exitBoot' ? '请恢复 BOOT 配置并复位，然后在“构建与下载”中确认。'
            : model.monitor.state === 'lent' ? '串口正用于下载。'
            : model.monitor.message;
        return <>
            {notice && <div className="nodu-ep-notice" role="status">{notice}</div>}
            <div ref={this.logRef} className="nodu-ep-log nodu-ep-serial-log" tabIndex={0} aria-label="串口收发记录" aria-live="off" onScroll={this.onScroll}>
                {model.monitorTrimmed && <div className="nodu-ep-retention">已移除较早记录，保留最近 1 MiB / 10,000 条。</div>}
                {model.monitorLines.map((line, index) => <div key={index} className={`nodu-ep-record nodu-ep-record-${line.direction || 'SYS'}`}>
                    <span className="nodu-ep-time">{new Date(line.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                    <span className="nodu-ep-direction" title={line.direction === 'TX' ? '主机写入成功，不代表设备已经执行' : undefined}>{line.direction || 'SYS'}</span>
                    <span className="nodu-ep-data">{this.highlight(this.text(line))}</span>
                </div>)}
            </div>
        </>;
    }

    private async send(): Promise<void> {
        if (this.model.monitorSending) { return; }
        const draft = this.draft, project = this.draftProject;
        try {
            const bytes = parseSerialDraft(draft, this.sendFormat, this.lineEnding);
            this.sendError = '';
            const sent = await this.model.sendMonitorBytes(bytes);
            if (sent && this.draftProject === project && this.draft === draft) { this.draft = ''; }
        } catch (error) { this.sendError = error instanceof Error ? error.message : String(error); }
        this.update();
    }

    private sendBar(): React.ReactNode {
        const model = this.model;
        const error = this.sendError || model.monitorSendError;
        return <>
            {error && <div className="nodu-ep-send-error" role="alert">{error}</div>}
            <div className="nodu-ep-send">
                <select aria-label="发送格式" value={this.sendFormat} onChange={event => { this.sendFormat = event.currentTarget.value as SerialFormat; this.sendError = ''; this.update(); }}>
                    <option value="text">TEXT</option><option value="hex">HEX</option>
                </select>
                <textarea rows={Math.min(4, this.draft.split('\n').length)} aria-label="发送到串口" value={this.draft} placeholder={this.sendFormat === 'hex' ? '01 FF 0A' : '固件命令…'} title="Enter 发送；Shift+Enter 换行；文本使用 UTF-8" disabled={model.monitorSending}
                    onChange={event => { this.draft = event.currentTarget.value; this.sendError = ''; this.update(); }}
                    onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !(event.nativeEvent as KeyboardEvent).isComposing && model.monitor.open) { event.preventDefault(); void this.send(); } }}/>
                <select aria-label="发送行尾" title={this.sendFormat === 'hex' ? 'HEX 仅发送输入字节，不追加文本行尾' : '发送行尾'} value={this.sendFormat === 'hex' ? 'none' : this.lineEnding} disabled={this.sendFormat === 'hex'} onChange={event => { this.lineEnding = event.currentTarget.value as SerialEnding; this.update(); }}>
                    <option value="none">无行尾</option><option value="lf">LF</option><option value="cr">CR</option><option value="crlf">CR LF</option>
                </select>
                <button className="nodu-ep-primary nodu-ep-send-action" aria-label="发送" title="发送（Enter）" disabled={!model.monitor.open || model.monitorBusy || model.monitorSending || !this.draft} onClick={() => void this.send()}><i className={`codicon codicon-${model.monitorSending ? 'loading codicon-modifier-spin' : 'send'}`} aria-hidden="true"/></button>
            </div>
        </>;
    }

    private problems(): React.ReactNode {
        const build = this.model.lastBuild;
        if (!build) { return null; }
        const flash = build.capacity?.FLASH;
        const ram = build.capacity?.RAM;
        const capacity = flash && ram ? <div className="nodu-c-capacity" aria-label="容量">
            {[['Flash', flash], ['RAM', ram]].map(([name, region]) => {
                const r = region as { used: number; size: number; percent: number };
                return <div key={name as string} className={`nodu-c-meter${r.percent > 90 ? ' nodu-c-meter-high' : ''}`}>
                    <span>{name as string}</span>
                    <span className="nodu-c-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.percent)} aria-label={`${name as string} 已用 ${r.percent.toFixed(1)}%`}><span style={{ width: `${Math.min(100, r.percent)}%` }}/></span>
                    <span>{formatBytes(r.used)} / {formatBytes(r.size)} · {r.percent.toFixed(1)}%</span>
                </div>;
            })}
        </div> : null;
        if (!build.diagnostics.length) {
            return <div>{capacity}<p className="nodu-c-empty">{build.ok ? '没有错误或警告。' : '编译失败，但没有可定位的错误。切换到“输出”查看原文。'}</p></div>;
        }
        return <div>
            {capacity}
            <ul className="nodu-c-problems" aria-label="编译问题">
                {build.diagnostics.map((d, index) => <li key={index} className={`nodu-c-problem nodu-c-${d.severity}`}>
                    <button className="nodu-c-problem-head" onClick={() => void this.open(d)} disabled={!d.absolute}>
                        <i className={`codicon codicon-${d.severity === 'error' ? 'error' : 'warning'}`} aria-label={d.severity === 'error' ? '错误' : '警告'}/>
                        <span className="nodu-c-problem-title">{d.explanation?.title ?? d.message}</span>
                        {d.file && <span className="nodu-c-problem-where">{d.file}{d.line ? `:${d.line}` : ''}{d.column ? `:${d.column}` : ''}</span>}
                    </button>
                    {d.explanation && <div className="nodu-c-problem-body">
                        <p>{d.explanation.explain}</p>
                        <p><strong>改法：</strong>{d.explanation.fix}</p>
                    </div>}
                    <p className="nodu-c-problem-raw">{d.inSdk ? '来自 HAL，通常由工程代码的用法引起 · ' : ''}编译器原文：{d.message}</p>
                    {d.notes?.map((note, i) => <p key={i} className="nodu-c-problem-raw">↳ {note.file}:{note.line} {note.message}</p>)}
                </li>)}
            </ul>
        </div>;
    }

}
