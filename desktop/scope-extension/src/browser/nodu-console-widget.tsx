// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser';
import { NoduDeviceModel } from './nodu-device-client';

@injectable()
export class NoduConsoleWidget extends ReactWidget {
    static readonly ID = 'nodu:console';
    static readonly LABEL = '控制台';
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    private code = 'print(42)';
    private readonly output = React.createRef<HTMLPreElement>();
    private followOutput = true;
    private clearedAt = 0;

    @postConstruct()
    protected init(): void {
        this.id = NoduConsoleWidget.ID;
        this.title.label = NoduConsoleWidget.LABEL;
        this.title.iconClass = 'codicon codicon-terminal';
        this.title.closable = false;
        this.addClass('scope-widget');
        this.addClass('nodu-console-widget');
        this.toDispose.push(this.device.onDidChange(() => {
            this.update();
            requestAnimationFrame(() => { if (!this.isDisposed && this.followOutput && this.output.current) { this.output.current.scrollTop = this.output.current.scrollHeight; } });
        }));
        this.update();
    }

    protected render(): React.ReactNode {
        const model = this.device;
        const disabled = !model.connected || !model.state.capabilities.repl || model.state.running || model.busy;
        // Clear is view-local: the shared log still feeds the pro output channel and popover.
        let logs = model.logs.filter(log => log.stream !== 'system' && log.time > this.clearedAt).slice(-200);
        let length = logs.reduce((sum, log) => sum + log.text.length, 0);
        while (logs.length && length > 100000) { length -= logs[0].text.length; logs = logs.slice(1); }
        const outputText = logs.map(log => log.text).join('');
        const rows = Math.min(4, Math.max(1, this.code.split('\n').length));
        const execute = (): void => { if (!disabled && this.code.trim()) { void model.execute(this.code); } };
        return <div className="nodu-console-content">
            {logs.length > 0 && <pre ref={this.output} className="nodu-console-output" tabIndex={0} aria-label="设备输出" onScroll={event => { const node = event.currentTarget; this.followOutput = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>{logs.map((log, index) => <span key={index} className={log.stream === 'stderr' ? 'nodu-console-stderr' : undefined}>{log.text}</span>)}</pre>}
            {model.error && !outputText.includes(model.error) && <p className="scope-error" role="alert">{model.error}</p>}
            <div className="nodu-console-input">
                <span aria-hidden="true">&gt;_</span>
                <textarea aria-label="REPL Python 代码" rows={rows} value={this.code} disabled={disabled} spellCheck={false}
                    onChange={event => { this.code = event.currentTarget.value; this.update(); }}
                    onKeyDown={event => { const native = event.nativeEvent as KeyboardEvent; if (event.key === 'Enter' && (native.isComposing || native.keyCode === 229)) { return; } if (event.key === 'Enter') { event.stopPropagation(); if (!event.shiftKey) { event.preventDefault(); execute(); } } }} />
                <button className="scope-action scope-toolbar-icon" aria-label="清空" title="清空" disabled={!logs.length} onClick={() => { this.clearedAt = Date.now(); this.update(); }}><i className="codicon codicon-clear-all" aria-hidden="true"/></button>
                <button className="scope-action scope-toolbar-icon" aria-label="执行" title="执行 · Enter" disabled={disabled || !this.code.trim()} onClick={execute}><i className="codicon codicon-play" aria-hidden="true"/></button>
            </div>
        </div>;
    }
}
