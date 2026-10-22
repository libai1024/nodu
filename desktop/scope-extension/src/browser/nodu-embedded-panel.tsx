// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { URI } from '@theia/core/lib/common/uri';
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
    private readonly monitorRef = React.createRef<HTMLPreElement>();
    private readonly outputRef = React.createRef<HTMLPreElement>();
    private follow = true;
    private draft = '';
    private lineEnding = 'crlf';
    private hex = false;
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
        // Serial data arrives every 40 ms; repaint at most once per frame.
        this.toDispose.push(this.model.onDidMonitor(() => {
            if (this.frame !== undefined) { return; }
            this.frame = requestAnimationFrame(() => { this.frame = undefined; this.update(); requestAnimationFrame(() => this.scroll()); });
        }));
        this.toDispose.push({ dispose: () => { if (this.frame !== undefined) { cancelAnimationFrame(this.frame); } } });
        this.update();
    }

    private scroll(): void {
        const node = this.model.panelTab === 'monitor' ? this.monitorRef.current : this.outputRef.current;
        if (node && this.follow) { node.scrollTop = node.scrollHeight; }
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
            onClick={() => { this.model.panelTab = id; this.follow = true; this.update(); requestAnimationFrame(() => this.scroll()); }}>
            {label}{badge ? <span className="nodu-c-badge" aria-label={`${badge} 个错误`}>{badge}</span> : null}
        </button>;
    }

    protected render(): React.ReactNode {
        const model = this.model;
        const errors = model.errors.length;
        return <div className="nodu-c-panel-content">
            <div className="nodu-c-panel-bar">
                <div role="tablist" aria-label="问题与输出" className="nodu-c-tabs">
                    {this.tab('problems', '问题', errors)}
                    {this.tab('monitor', '串口监视器')}
                    {this.tab('output', '编译输出')}
                </div>
                <span className="nodu-c-panel-actions">{this.actions()}</span>
            </div>
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
                <button className="scope-action scope-toolbar-icon" aria-pressed={this.hex} aria-label="十六进制显示" title="十六进制显示" onClick={() => { this.hex = !this.hex; this.update(); }}><i className="codicon codicon-symbol-numeric" aria-hidden="true"/></button>
                <button className="scope-action scope-toolbar-icon" aria-label="复制输出" title="复制输出" onClick={() => void this.clipboard.writeText(model.monitorLines.map(l => l.text).join('\n'))}><i className="codicon codicon-copy" aria-hidden="true"/></button>
                <button className="scope-action scope-toolbar-icon" aria-label="清空" title="清空" onClick={() => model.clearMonitor()}><i className="codicon codicon-clear-all" aria-hidden="true"/></button>
            </>;
        }
        if (model.panelTab === 'output') {
            return <button className="scope-action scope-toolbar-icon" aria-label="复制输出" title="复制输出" onClick={() => void this.clipboard.writeText(model.output.join('\n'))}><i className="codicon codicon-copy" aria-hidden="true"/></button>;
        }
        return null;
    }

    private problems(): React.ReactNode {
        const build = this.model.lastBuild;
        if (!build) { return <p className="nodu-c-empty">还没有编译。按 ⌘B / Ctrl+B 编译，或点工具栏的“编译”。</p>; }
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
            return <div>{capacity}<p className="nodu-c-empty">{build.ok ? '没有错误或警告。' : '编译失败，但没有可定位的错误。打开“编译输出”查看原文。'}</p></div>;
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

    private monitor(): React.ReactNode {
        const model = this.model;
        const project = model.project;
        const state = model.monitor;
        const toHex = (text: string): string => Array.from(new TextEncoder().encode(text)).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const send = (): void => {
            if (!this.draft) { return; }
            void model.sendMonitor(this.draft + (LINE_ENDINGS[this.lineEnding] ?? ''));
            this.draft = '';
            this.update();
        };
        const status = state.state === 'open' ? `已连接 · ${state.port.replace('/dev/', '')} · ${state.baud}`
            : state.state === 'disconnected' ? '开发板已断开，重新插上后自动连接'
            : state.state === 'lent' ? '串口暂时交给下载使用' : model.monitorPort ? '未打开' : '没有选择串口';
        return <div className="nodu-c-monitor">
            <div className="nodu-c-monitor-bar">
                <span className={`nodu-c-monitor-state nodu-c-monitor-${state.state}`} role="status"><span className="scope-status-dot" aria-hidden="true"/>{status}</span>
                <select aria-label="串口" value={model.monitorPort} onChange={event => model.setMonitorPort(event.currentTarget.value)}>
                    <option value="">选择串口</option>
                    {model.ports.map(port => <option key={port.path} value={port.path}>{port.path.replace('/dev/', '')}</option>)}
                </select>
                <select aria-label="波特率" value={project?.manifest.monitor?.baud ?? 115200} onChange={event => void model.setOption('monitorBaud', Number(event.currentTarget.value))}>
                    {[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map(b => <option key={b} value={b}>{b}</option>)}
                </select>
                <select aria-label="编码" value={project?.manifest.monitor?.encoding ?? 'utf-8'} onChange={event => void model.setOption('monitorEncoding', event.currentTarget.value)}>
                    <option value="utf-8">UTF-8</option><option value="gbk">GBK</option>
                </select>
                <button className="theia-button secondary" disabled={!model.monitorPort} onClick={() => void model.toggleMonitor()}>{state.open ? '关闭' : '打开'}</button>
            </div>
            <pre ref={this.monitorRef} className="nodu-c-log nodu-c-monitor-log" tabIndex={0} aria-label="串口输出" aria-live="off" onScroll={this.onScroll}>
                {model.monitorLines.map((line, index) => <div key={index} className={`nodu-c-line-${line.kind}`}>{this.hex && line.kind === 'data' ? toHex(line.text) : line.text}</div>)}
                {model.monitorPartial && <div className="nodu-c-line-data">{this.hex ? toHex(model.monitorPartial) : model.monitorPartial}</div>}
            </pre>
            <div className="nodu-c-monitor-input">
                <input aria-label="发送到串口" placeholder="发送到开发板" value={this.draft} disabled={state.state !== 'open'}
                    onChange={event => { this.draft = event.currentTarget.value; this.update(); }}
                    onKeyDown={event => { if (event.key === 'Enter' && !(event.nativeEvent as KeyboardEvent).isComposing) { event.preventDefault(); send(); } }}/>
                <select aria-label="行尾" value={this.lineEnding} onChange={event => { this.lineEnding = event.currentTarget.value; this.update(); }}>
                    <option value="crlf">CR LF</option><option value="lf">LF</option><option value="none">无</option>
                </select>
                <button className="theia-button secondary" disabled={state.state !== 'open' || !this.draft} onClick={send}>发送</button>
            </div>
        </div>;
    }
}
