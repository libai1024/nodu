// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { EmbeddedFailure } from '../common/nodu-embedded-protocol';
import { NoduEmbeddedModel, formatBytes } from './nodu-embedded-model';
import { NoduSelect } from './nodu-select';

type Confirm = (title: string, message: string, ok: string) => Promise<boolean>;

/** Ordered checks of the diagnosis card (UI-DESIGN §8.5); the failure marks the first one that failed. */
const CHECKS: Record<'stlink' | 'uart', { label: string; codes: string[] }[]> = {
    stlink: [
        { label: 'ST-LINK 已连接到电脑', codes: ['noProbe', 'probeBusy'] },
        { label: '开发板已供电', codes: ['noPower'] },
        { label: 'SWD 接线（SWDIO、SWCLK、GND）', codes: ['noTarget', 'haltFailed'] },
        { label: '芯片与工程的目标一致', codes: ['wrongChip', 'chipChanged', 'readProtected', 'tooLarge'] },
        { label: '写入与校验', codes: ['writeFailed', 'verifyFailed', 'backupFailed', 'tampered', 'openocd'] },
    ],
    uart: [
        { label: '选择了 USB 转串口', codes: ['noPort'] },
        { label: '串口可以打开（没有被占用）', codes: ['portOpen', 'portBusy'] },
        { label: '芯片进入串口引导模式（BOOT0 = 1 后按复位）', codes: ['romTimeout', 'romProtocol', 'romNack', 'romLost'] },
        { label: '芯片与工程的目标一致', codes: ['wrongChip', 'readProtected', 'tooLarge'] },
        { label: '写入与校验', codes: ['writeFailed', 'verifyFailed', 'backupFailed', 'tampered', 'stm32flash'] },
    ],
};

export function NoduDiagnosis({ failure, method, showOutput, dismiss }: { failure: EmbeddedFailure; method: 'stlink' | 'uart'; showOutput: () => void; dismiss: () => void }): React.ReactElement {
    const checks = CHECKS[method];
    const failed = checks.findIndex(check => check.codes.includes(failure.code));
    return <div className="nodu-c-diagnosis" role="alert">
        <p className="nodu-c-diagnosis-title"><i className="codicon codicon-error" aria-hidden="true"/>{failure.message}</p>
        {failed >= 0 && <ol className="nodu-c-checks">
            {checks.map((check, index) => {
                const state = index < failed ? 'ok' : index === failed ? 'failed' : 'pending';
                const icon = state === 'ok' ? 'pass' : state === 'failed' ? 'error' : 'circle-large-outline';
                const status = state === 'ok' ? '通过' : state === 'failed' ? '未通过' : '未检查';
                return <li key={check.label} className={`nodu-c-check-${state}`}>
                    <i className={`codicon codicon-${icon}`} aria-hidden="true"/><span>{check.label}</span><span className="scope-visually-hidden">{status}</span>
                </li>;
            })}
        </ol>}
        <div className="nodu-c-diagnosis-actions">
            <button className="scope-text-button" onClick={showOutput}>查看下载器原始输出</button>
            <button className="scope-text-button" onClick={dismiss}>收起</button>
        </div>
    </div>;
}

function Section({ title, icon, action, children, hidden }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode; hidden?: boolean }): React.ReactElement {
    return <section className="scope-device-section nodu-c-section" aria-label={title} hidden={hidden}>
        <div className="scope-section-heading"><h2><i className={`codicon codicon-${icon}`} aria-hidden="true"/>{title}</h2>{action}</div>
        {children}
    </section>;
}

/** Device popover for STM32 projects (UI-DESIGN §4). */
export function NoduCDevicePanel({ model, simple, confirm, showOutput }: { model: NoduEmbeddedModel; simple: boolean; confirm: Confirm; showOutput: () => void }): React.ReactElement | null {
    const project = model.project;
    if (!project) { return null; }
    const method = project.flashMethod;
    const identity = model.identity;
    const locked = model.busy;
    const uart = project.board.debugUart;
    const portOptions = model.ports.map(port => ({
        value: port.path,
        label: `${port.path.replace('/dev/', '')}${port.description && port.description !== port.path ? ` · ${port.description}` : ''}`,
    }));
    const probeOptions = !model.probes.length
        ? [{ value: '', label: '未检测到 ST-LINK' }]
        : model.probes.length === 1
            ? [{ value: '', label: `${model.probes[0].model}${model.probes[0].serial ? ` · ${model.probes[0].serial.slice(0, 12)}` : ''}` }]
            : [{ value: '', label: '请选择下载器' }, ...model.probes.map(probe => ({
                value: probe.serial,
                label: `${probe.model} · ${probe.serial ? probe.serial.slice(0, 12) : '无序列号'}`,
            }))];
    const restore = async (id: string): Promise<void> => {
        const backup = model.backups.find(b => b.id === id);
        if (!backup) { return; }
        const ok = await confirm('恢复备份', `把 ${backup.createdAt.replace('T', ' ').slice(0, 16)} 的备份（${formatBytes(backup.bytes)}）整片写回芯片。当前的程序会被覆盖。`, '恢复');
        if (ok) { await model.restore(backup); }
    };
    return <div className="scope-device-panel nodu-c-device">
        <Section title="开发板" icon="circuit-board">
            <p className="nodu-c-strong">{project.board.name}</p>
            <p className="nodu-c-muted">{project.chip.name} · {project.chip.core} · {formatBytes(project.chip.flash.size)} Flash · {formatBytes(project.chip.ram.size)} RAM</p>
        </Section>
        <Section title="下载方式" icon="cloud-upload" action={<button className="scope-action scope-toolbar-icon" aria-label="刷新下载器与串口" title="刷新" disabled={locked} onClick={() => void model.refreshDevices()}><i className="codicon codicon-refresh" aria-hidden="true"/></button>}>
            <div className="nodu-c-radio" role="radiogroup" aria-label="下载方式">
                {(['stlink', 'uart'] as const).map(value => <label key={value}>
                    <input type="radio" name="nodu-c-method" checked={method === value} disabled={locked} onChange={() => void model.setOption('flashMethod', value)}/>
                    {value === 'stlink' ? 'ST-LINK（SWD）' : '串口（ISP）'}
                </label>)}
            </div>
            {method === 'stlink' ? <div className="nodu-device-field">
                <label htmlFor="nodu-c-probe">下载器</label>
                <NoduSelect id="nodu-c-probe" aria-label="下载器" value={model.probe} disabled={locked} options={probeOptions} onChange={value => { model.probe = value; model.fire(); }}/>
            </div> : <div className="nodu-device-field">
                <label htmlFor="nodu-c-isp-port">串口</label>
                <NoduSelect id="nodu-c-isp-port" aria-label="ISP 串口" value={model.monitorPort} disabled={locked} options={[{ value: '', label: '选择 USB 转串口' }, ...portOptions]} onChange={value => model.setMonitorPort(value)}/>
            </div>}
            {model.probes.some(p => p.driver === 'missing') && <p className="nodu-c-warn">检测到 ST-LINK，但 Windows 没有为它安装驱动。从 st.com 下载 STSW-LINK009 驱动并安装后重新插拔。</p>}
            {method === 'uart' && project.board.boot?.note && <p className="nodu-c-muted">{project.board.boot.note}</p>}
        </Section>
        {method === 'stlink' && <Section title="串口监视器" icon="output">
            <div className="nodu-device-field">
                <label htmlFor="nodu-c-monitor-port">串口</label>
                <NoduSelect id="nodu-c-monitor-port" aria-label="监视器串口" value={model.monitorPort} disabled={locked || model.monitor.open || model.monitorBusy} options={[{ value: '', label: '选择串口（手动连接）' }, ...portOptions]} onChange={value => model.setMonitorPort(value)}/>
            </div>
            {uart && <p className="nodu-c-muted">{uart.instance}：TX {uart.tx}，RX {uart.rx} · {uart.via}</p>}
        </Section>}
        <Section title="芯片" icon="chip" action={method === 'stlink' ? <span className="nodu-c-inline-actions">
            <button className="theia-button secondary" disabled={locked} onClick={() => void model.identify()}>{model.identifying ? '识别中…' : '识别'}</button>
            <button className="theia-button secondary" disabled={locked} onClick={() => void model.reset()}>复位</button>
        </span> : undefined}>
            {identity ? identity.matches
                ? <p className="nodu-c-error-text">{identity.matches}</p>
                : <p className="nodu-c-ok-text"><i className="codicon codicon-pass" aria-hidden="true"/>{identity.deviceName ?? project.chip.name} · 设备 ID {identity.deviceIdHex} · {identity.flashKiB} KB
                    {identity.uid && <span className="nodu-c-muted nodu-c-block">唯一 ID {identity.uid.slice(0, 12)}…{identity.voltage ? ` · 目标电压 ${identity.voltage.toFixed(2)} V` : ''}</span>}</p>
                : <p className="nodu-c-muted">{method === 'stlink' ? '每次运行前自动核对芯片。也可以点“识别”检查接线。' : '串口方式在下载时核对芯片。'}</p>}
        </Section>
        {model.lastError && !model.busy && <NoduDiagnosis failure={model.lastError} method={method} showOutput={showOutput} dismiss={() => { model.lastError = undefined; model.fire(); }}/>}
        <Section title="备份与恢复" icon="history" hidden={simple && !model.backups.length}>
            {model.backups.length ? <ul className="nodu-c-backups">
                {model.backups.slice(0, simple ? 3 : 10).map(backup => <li key={backup.id}>
                    <span>{backup.factory ? '出厂程序' : '备份'} · {backup.createdAt.replace('T', ' ').slice(0, 16)} · {formatBytes(backup.bytes)}</span>
                    <button className="scope-text-button" disabled={locked} onClick={() => void restore(backup.id)}>恢复…</button>
                </li>)}
            </ul> : <p className="nodu-c-muted">第一次写入某颗芯片前，Nodu 会先备份整片 Flash。</p>}
        </Section>
        <Section title="STM32 工具包" icon="tools" hidden={simple}>
            <p className={project.toolkit.ok ? 'nodu-c-muted' : 'nodu-c-error-text'}>{project.toolkit.ok ? `${project.toolkit.version} · 已检查` : project.toolkit.message}</p>
        </Section>
    </div>;
}
