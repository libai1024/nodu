// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { NoduArduinoModel } from './nodu-arduino-model';
import { NoduSelect } from './nodu-select';
import { FrameworkMark } from './nodu-project-icon';
import '../../style/arduino.css';

/** Arduino uses the same device popover and compact rows as the other targets. */
export function NoduArduinoDevicePanel({ model, open }: { model: NoduArduinoModel; open: boolean; exec(id: string): void }): React.ReactElement {
    const path = model.path, project = model.project;
    React.useEffect(() => {
        if (!open || !path) { return; }
        const refresh = (): void => { if (!document.hidden && !model.embedded.flashing) { void model.refreshPorts().catch(cause => { model.error = cause instanceof Error ? cause.message : String(cause); model.fire(); }); } };
        refresh(); const timer = setInterval(refresh, 2000); return () => clearInterval(timer);
    }, [open, path, model]);
    const locked = model.busy || model.loading || model.embedded.monitorBusy;
    const fqbn = project?.fqbn.split(':').slice(0, 3).join(':') ?? '';
    const boards = model.boards.map(board => ({ value: board.fqbn, label: board.name }));
    if (fqbn && !boards.some(board => board.value === fqbn)) { boards.unshift({ value: fqbn, label: project?.boardName || fqbn }); }
    const ports = model.ports.map(port => ({ value: port.path, label: port.path.replace(/^\/dev\//, ''), detail: port.label }));
    if (model.selectedPort && !ports.some(port => port.value === model.selectedPort)) { ports.unshift({ value: model.selectedPort, label: `${model.selectedPort.replace(/^\/dev\//, '')}（未连接）`, detail: '' }); }
    return <div className="nodu-c-device-compact nodu-arduino-device">
        <div className="nodu-c-compact-heading"><strong className="nodu-arduino-framework"><FrameworkMark framework="arduino"/>Arduino</strong><button className="scope-action scope-toolbar-icon" aria-label="刷新开发板与串口" title="刷新" disabled={locked} onClick={() => void model.refresh()}><i className={`codicon codicon-${model.loading ? 'loading codicon-modifier-spin' : 'refresh'}`} aria-hidden="true"/></button></div>
        <div className="nodu-c-compact-row"><label htmlFor="nodu-arduino-board">开发板</label><NoduSelect id="nodu-arduino-board" aria-label="开发板" value={fqbn} options={boards} disabled={locked || !project} onChange={value => void model.configure({ fqbn: value })}/></div>
        <div className="nodu-c-compact-row"><label htmlFor="nodu-arduino-port">串口</label><NoduSelect id="nodu-arduino-port" aria-label="烧录串口" value={model.selectedPort} options={[{ value: '', label: '选择串口' }, ...ports]} disabled={locked} onChange={value => void model.configure({ port: value })}/></div>
        {project && <div className="nodu-arduino-core"><span>Arduino-ESP32</span><span>{project.coreVersion}</span></div>}
        {!!model.options.length && <details className="nodu-arduino-advanced"><summary>高级参数</summary><div>{model.options.map(option => <div key={option.id} className="nodu-c-compact-row"><label htmlFor={`nodu-arduino-option-${option.id}`}>{option.label}</label><NoduSelect id={`nodu-arduino-option-${option.id}`} aria-label={option.label} value={option.value} options={option.values} disabled={locked} onChange={value => void model.configure({ options: { [option.id]: value } })}/></div>)}</div></details>}
        {model.error && <div className="nodu-arduino-error" role="alert"><span>{model.error}</span><button aria-label="关闭错误" onClick={() => { model.error = ''; model.fire(); }}><i className="codicon codicon-close" aria-hidden="true"/></button></div>}
    </div>;
}
