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
        const output = model.logs.filter(log => log.stream !== 'system').slice(-200).map(log => log.text).join('').slice(-100000);
        const execute = (): void => { if (!disabled && this.code.trim()) { void model.execute(this.code); } };
        return <div className="nodu-console-content">
            {output && <pre ref={this.output} className="nodu-console-output" tabIndex={0} aria-label="设备输出" onScroll={event => { const node = event.currentTarget; this.followOutput = node.scrollHeight - node.scrollTop - node.clientHeight < 24; }}>{output}</pre>}
            {model.error && !output.includes(model.error) && <p className="scope-error" role="alert">{model.error}</p>}
            <div className="nodu-console-input">
                <span aria-hidden="true">&gt;_</span>
                <textarea aria-label="REPL Python 代码" rows={1} value={this.code} disabled={disabled} spellCheck={false}
                    onChange={event => { this.code = event.currentTarget.value; this.update(); }}
                    onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); execute(); } }} />
                <button className="theia-button secondary" disabled={disabled || !this.code.trim()} onClick={execute}>执行</button>
            </div>
        </div>;
    }
}
