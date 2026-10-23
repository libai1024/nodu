// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { URI } from '@theia/core/lib/common/uri';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { MonitorSnapshot, logLine, monitorLog } from '../common/nodu-monitor-log';
import { CommandService, Emitter } from '@theia/core/lib/common';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { C_COMMANDS } from './nodu-embedded-commands';
import { Diagnostic } from '../common/nodu-embedded-protocol';
import { NoduEmbeddedModel, PanelTab, formatBytes } from './nodu-embedded-model';

const LINE_ENDINGS: Record<string, string> = { lf: '\n', crlf: '\r\n', none: '' };

/** Bottom panel for C projects: 问题 · 串口监视器 · 编译输出 (UI-DESIGN §7). */
@injectable()
export class NoduEmbeddedPanel extends ReactWidget {
    static readonly ID = 'nodu:c-panel';
    static readonly LABEL = '问题与输出';
    @inject(NoduEmbeddedModel) protected readonly model!: NoduEmbeddedModel;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(CommandService) protected readonly commands!: CommandService;
    private readonly monitorRef = React.createRef<HTMLPreElement>();
    private readonly outputRef = React.createRef<HTMLPreElement>();
    private follow = true;
    private draft = '';
    private lineEnding = 'crlf';
    private hex = false;
    private timestamps = false;
    private paused: MonitorSnapshot | undefined;
    private sending = false;
    private frame: number | undefined;

    @postConstruct()
    protected init(): void {
        this.id = NoduEmbeddedPanel.ID;
        this.title.label = NoduEmbeddedPanel.LABEL;
        this.title.iconClass = 'codicon codicon-output';
        this.title.closable = false;
        this.addClass('scope-widget');
        this.addClass('nodu-c-panel');
        this.toDispose.push(this.model.onDidChange(() => this.update()));
        this.toDispose.push(this.model.onDidChangeProject(() => { this.paused = undefined; this.follow = true; this.update(); }));
        const refreshPorts = (): void => {
            if (this.isVisible && this.model.panelTab === 'monitor' && !document.hidden) { void this.model.refreshPorts(); }
        };
        const portTimer = window.setInterval(refreshPorts, 2000);
        window.addEventListener('focus', refreshPorts);
        document.addEventListener('visibilitychange', refreshPorts);
        this.toDispose.push({ dispose: () => {
            window.clearInterval(portTimer); window.removeEventListener('focus', refreshPorts);
            document.removeEventListener('visibilitychange', refreshPorts);
        } });
        // Serial data arrives every 40 ms; repaint at most once per frame.
        this.toDispose.push(this.model.onDidMonitor(() => {
            if (this.paused) { return; }
            if (this.frame !== undefined) { return; }
            this.frame = requestAnimationFrame(() => { this.frame = undefined; this.update(); requestAnimationFrame(() => this.scroll()); });
        }));
        this.toDispose.push({ dispose: () => { if (this.frame !== undefined) { cancelAnimationFrame(this.frame); } } });
        this.update();
    }

    private scroll(): void {
        const node = this.model.panelTab === 'monitor' ? this.monitorRef.current : this.outputRef.current;
        if (node && this.follow && !(this.model.panelTab === 'monitor' && this.paused)) { node.scrollTop = node.scrollHeight; }
    }

    private async open(d: Diagnostic): Promise<void> {
        if (!d.absolute) { return; }
        const line = Math.max(0, (d.line ?? 1) - 1);
        const character = Math.max(0, (d.column ?? 1) - 1);
        await this.editors.open(URI.fromFilePath(this.model.toLocal(d.absolute)), { mode: 'activate', selection: { start: { line, character }, end: { line, character } } });
    }

    private tab(id: PanelTab, label: string, badge?: number): React.ReactNode {
        const selected = this.model.panelTab === id;
        return <button role="tab" id={`nodu-c-tab-${id}`} aria-selected={selected} aria-controls={`nodu-c-pane-${id}`} tabIndex={selected ? 0 : -1}
            className={`nodu-c-tab${selected ? ' nodu-c-tab-on' : ''}`}
            onKeyDown={event => {
                const tabs: PanelTab[] = ['problems', 'monitor', 'output'];
                const index = tabs.indexOf(id);
                const next = event.key === 'ArrowRight' ? tabs[(index + 1) % 3] : event.key === 'ArrowLeft' ? tabs[(index + 2) % 3]
                    : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[2] : undefined;
                if (next) { event.preventDefault(); this.model.panelTab = next; this.update(); requestAnimationFrame(() => this.node.querySelector<HTMLButtonElement>(`#nodu-c-tab-${next}`)?.focus()); }
            }}
            onClick={() => { this.model.panelTab = id; if (id === 'monitor') { void this.model.refreshPorts(); } this.follow = true; this.update(); requestAnimationFrame(() => this.scroll()); }}>
            {label}{badge ? <span className="nodu-c-badge" aria-label={`${badge} 个错误`}>{badge}</span> : null}
        </button>;
    }

    /** Set when the bottom panel hosts this widget; its header then provides the page tabs and actions. */
    private hosted = false;
    private readonly chromeChanged = new Emitter<void>();
    readonly onDidChangeChrome = this.chromeChanged.event;
    protected override onUpdateRequest(msg: Message): void {
        super.onUpdateRequest(msg);
        this.chromeChanged.fire();
    }
    headerActions(): React.ReactNode { return this.actions(); }
    setView(view: PanelTab): void {
        this.hosted = true;
        if (this.model.panelTab !== view) { this.model.panelTab = view; this.follow = true; }
        if (view === 'monitor') { void this.model.refreshPorts(); }
        this.update();
        requestAnimationFrame(() => this.scroll());
    }

    protected render(): React.ReactNode {
        const model = this.model;
        const errors = model.errors.length;
        return <div className={`nodu-c-panel-content${this.hosted ? ' nodu-c-hosted' : ''}`}>
            {!this.hosted && <div className="nodu-c-panel-bar">
                <div role="tablist" aria-label="问题与输出" className="nodu-c-tabs">
                    {this.tab('problems', '问题', errors)}
                    {this.tab('monitor', '串口监视器')}
                    {this.tab('output', '编译输出')}
                </div>
                <span className="nodu-c-panel-actions">{this.actions()}</span>
            </div>}
            <div className="nodu-c-pane" id={`nodu-c-pane-${model.panelTab}`} role="tabpanel" aria-labelledby={`nodu-c-tab-${model.panelTab}`}>
                {model.panelTab === 'problems' && this.problems()}
                {model.panelTab === 'monitor' && this.monitor()}
                {model.panelTab === 'output' && <pre ref={this.outputRef} className="nodu-c-log" tabIndex={0} aria-label="编译与下载输出" onScroll={this.onScroll}>{model.output.join('\n')}</pre>}
            </div>
        </div>;
    }

    private readonly onScroll = (event: React.UIEvent<HTMLPreElement>): void => {
        const node = event.currentTarget;
        this.follow = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
    };

    private actions(): React.ReactNode {
        const model = this.model;
        if (model.panelTab === 'monitor') {
            return <>
                {this.hosted && <div className="nodu-c-monitor-conn">{this.connection()}</div>}
                {this.hosted && <span className="nodu-panel-divider" aria-hidden="true"/>}
                <button className="nodu-panel-icon" aria-pressed={this.timestamps} aria-label="时间戳" title="时间戳" disabled={this.hex} onClick={() => { this.timestamps = !this.timestamps; this.update(); }}><i className="codicon codicon-history" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-pressed={!!this.paused} aria-label={this.paused ? '继续显示' : '暂停显示'} title={this.paused ? '继续显示' : '暂停显示，继续接收'} onClick={() => { this.paused = this.paused ? undefined : this.snapshot(); this.follow = !this.paused; this.update(); requestAnimationFrame(() => this.scroll()); }}><i className={`codicon codicon-${this.paused ? 'play' : 'debug-pause'}`} aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-pressed={this.hex} aria-label="十六进制显示" title="十六进制显示" onClick={() => { this.hex = !this.hex; this.update(); }}><i className="codicon codicon-symbol-numeric" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label="保存日志" title="保存日志" onClick={() => void this.saveLog()}><i className="codicon codicon-save" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label="复制输出" title="复制输出" onClick={() => void this.clipboard.writeText(monitorLog(this.snapshot(), this.hex, this.timestamps))}><i className="codicon codicon-copy" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label="清空" title="清空" onClick={() => { model.clearMonitor(); if (this.paused) { this.paused = { lines: [], partial: '', hex: '' }; } this.update(); }}><i className="codicon codicon-clear-all" aria-hidden="true"/></button>
            </>;
        }
        if (model.panelTab === 'output') {
            return <><button className="nodu-panel-icon" aria-label="打开产物目录" title="打开 BIN/HEX 所在目录" onClick={() => void this.commands.executeCommand(C_COMMANDS.openBuildLocation)}><i className="codicon codicon-folder-opened" aria-hidden="true"/></button>
                <button className="nodu-panel-icon" aria-label="复制输出" title="复制输出" onClick={() => void this.clipboard.writeText(model.output.join('\n'))}><i className="codicon codicon-copy" aria-hidden="true"/></button></>;
        }
        return null;
    }

    private problems(): React.ReactNode {
        const build = this.model.lastBuild;
        if (!build) { return <p className="nodu-c-empty">尚未编译</p>; }
        const flash = build.capacity?.FLASH;
        const ram = build.capacity?.RAM;
        const capacity = flash && ram ? <div className="nodu-c-capacity" aria-label="容量">
            {[['Flash', flash], ['RAM', ram]].map(([name, region]) => {
                const r = region as { used: number; size: number; percent: number };
                return <div key={name as string} className={`nodu-c-meter${r.percent > 90 ? ' nodu-c-meter-high' : ''}`}>
                    <span>{name as string}</span>
                    <span className="nodu-c-meter-bar" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(r.percent)} aria-label={`${name as string} 已用 ${r.percent.toFixed(1)}%`}><span style={{ width: `${Math.min(100, r.percent)}%` }}/></span>
                    <span>{formatBytes(r.used)} / {formatBytes(r.size)}（{r.percent.toFixed(1)}%）</span>
                </div>;
            })}
        </div> : null;
        if (!build.diagnostics.length) {
            return <div>{this.model.diagnosticsStale && <p className="nodu-c-stale" role="status">已过期</p>}{capacity}<p className="nodu-c-empty">{build.ok ? '没有错误或警告。' : '编译失败，请查看编译输出。'}</p></div>;
        }
        return <div className={this.model.diagnosticsStale ? 'nodu-c-diagnostics-stale' : ''}>
            {this.model.diagnosticsStale && <p className="nodu-c-stale" role="status">已过期</p>}
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
                    <p className="nodu-c-problem-raw">{d.inSdk ? '来自 HAL：' : ''}编译器原文：{d.message}</p>
                    {d.notes?.map((note, i) => <p key={i} className="nodu-c-problem-raw">↳ {note.file}:{note.line} {note.message}</p>)}
                </li>)}
            </ul>
        </div>;
    }

    private monitor(): React.ReactNode {
        const model = this.model;
        const project = model.project;
        const state = model.monitor;
        const snapshot = this.snapshot();
        const canSend = state.state === 'open' && !model.monitorBusy && !model.flashing && model.awaitUser !== 'exitBoot';
        const send = async (): Promise<void> => {
            if (!this.draft || this.sending || !canSend) { return; }
            const draft = this.draft;
            this.sending = true; this.update();
            const sent = await model.sendMonitor(draft + (LINE_ENDINGS[this.lineEnding] ?? ''));
            if (sent && this.draft === draft) { this.draft = ''; }
            this.sending = false; this.update();
        };
        return <div className="nodu-c-monitor">
            {/* Hosted: shown only when the panel is too narrow for the header row (CSS container query). */}
            <div className={`nodu-c-monitor-bar${this.hosted ? ' nodu-c-monitor-bar-hosted' : ''}`}>{this.connection()}</div>
            {model.monitorError && <div className="nodu-c-monitor-error" role="alert">{model.monitorError}</div>}
            <pre ref={this.monitorRef} className="nodu-c-log nodu-c-monitor-log" tabIndex={0} aria-label="串口输出" aria-live="off" onScroll={this.onScroll}>
                {this.hex ? snapshot.hex : <>
                    {snapshot.lines.map((line, index) => <div key={index} className={`nodu-c-line-${line.kind}`}>{logLine(line, this.timestamps)}</div>)}
                    {snapshot.partial && <div className="nodu-c-line-data">{logLine({ text: snapshot.partial, kind: 'data', at: snapshot.partialAt }, this.timestamps)}</div>}
                </>}
            </pre>
            <div className="nodu-c-monitor-input">
                <input aria-label="发送到串口" placeholder="发送到开发板" value={this.draft} disabled={!canSend || this.sending}
                    onChange={event => { this.draft = event.currentTarget.value; this.update(); }}
                    onKeyDown={event => { if (event.key === 'Enter' && !(event.nativeEvent as KeyboardEvent).isComposing) { event.preventDefault(); void send(); } }}/>
                <select aria-label="行尾" value={this.lineEnding} onChange={event => { this.lineEnding = event.currentTarget.value; this.update(); }}>
                    <option value="crlf">CR LF</option><option value="lf">LF</option><option value="none">无</option>
                </select>
                <button className="theia-button secondary" disabled={!canSend || !this.draft || this.sending} onClick={() => void send()}>发送</button>
            </div>
        </div>;
    }

    /** Port, baud, encoding and open/close; in the bottom panel these sit in its header row. */
    private connection(): React.ReactNode {
        const model = this.model;
        const project = model.project;
        const state = model.monitor;
        const status = state.state === 'open' ? '已连接'
            : state.state === 'disconnected' ? '等待重连'
            : state.state === 'lent' ? '下载中' : '未连接';
        return <>
                <span className={`nodu-c-monitor-state nodu-c-monitor-${state.state}`} role="status" title={status}><span className="scope-status-dot" aria-hidden="true"/><span className="nodu-c-monitor-label">{status}</span></span>
            <select aria-label="串口" disabled={model.monitorBusy || model.flashing || state.state === 'lent'} value={model.monitorPort} onChange={event => model.setMonitorPort(event.currentTarget.value)}>
                <option value="">选择串口</option>
                {model.monitorPort && !model.ports.some(port => port.path === model.monitorPort) && <option value={model.monitorPort}>{model.monitorPort.replace('/dev/', '')}（未连接）</option>}
                {model.ports.map(port => <option key={port.path} value={port.path}>{port.path.replace('/dev/', '')}</option>)}
            </select>
            <select aria-label="波特率" disabled={model.monitorBusy || model.flashing || state.state === 'lent'} value={project?.manifest.monitor?.baud ?? 115200} onChange={event => void model.setOption('monitorBaud', Number(event.currentTarget.value))}>
                {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <select aria-label="编码" value={project?.manifest.monitor?.encoding ?? 'utf-8'} onChange={event => void model.setOption('monitorEncoding', event.currentTarget.value)}>
                <option value="utf-8">UTF-8</option><option value="gbk">GBK</option>
            </select>
            <button className="theia-button secondary" aria-busy={model.monitorBusy} disabled={!model.monitorPort || model.monitorBusy || model.flashing || state.state === 'lent'} onClick={() => void model.toggleMonitor()}>{state.open ? '关闭' : '打开'}</button>
        </>;
    }

    private snapshot(): MonitorSnapshot {
        return this.paused ?? { lines: [...this.model.monitorLines], partial: this.model.monitorPartial,
            partialAt: this.model.monitorPartialAt, hex: this.model.monitorBytes.hex() };
    }

    private async saveLog(): Promise<void> {
        const text = monitorLog(this.snapshot(), this.hex, this.timestamps);
        try {
            const uri = await this.dialogs.showSaveDialog({ title: '保存串口日志', saveLabel: '保存', inputValue: `serial-${new Date().toISOString().replace(/[:.]/g, '-')}.log` });
            if (uri) { await this.files.writeFile(uri, BinaryBuffer.fromString(text)); }
        } catch (error) { this.model.monitorError = `保存失败：${error instanceof Error ? error.message : String(error)}`; this.update(); }
    }
}
