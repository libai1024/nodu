// SPDX-License-Identifier: MIT
import { C_COMMANDS } from './nodu-embedded-commands';
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

export function NoduDiagnosis({ failure, method, showOutput, dismiss, compact = false }: { failure: EmbeddedFailure; method: 'stlink' | 'uart'; showOutput: () => void; dismiss: () => void; compact?: boolean }): React.ReactElement {
    const checks = CHECKS[method];
    const failed = checks.findIndex(check => check.codes.includes(failure.code));
    const checklist = failed >= 0 && <ol className="nodu-c-checks">
            {checks.map((check, index) => {
                const state = index < failed ? 'ok' : index === failed ? 'failed' : 'pending';
                const icon = state === 'ok' ? 'pass' : state === 'failed' ? 'error' : 'circle-large-outline';
                const status = state === 'ok' ? '通过' : state === 'failed' ? '未通过' : '未检查';
                return <li key={check.label} className={`nodu-c-check-${state}`}>
                    <i className={`codicon codicon-${icon}`} aria-hidden="true"/><span>{check.label}</span><span className="scope-visually-hidden">{status}</span>
                </li>;
            })}
        </ol>;
    return <div className={`nodu-c-diagnosis${compact ? ' nodu-c-diagnosis-compact' : ''}`} role="alert">
        <p className="nodu-c-diagnosis-title"><i className="codicon codicon-error" aria-hidden="true"/>{failure.message}</p>
        {compact && checklist ? <details><summary>排查详情</summary>{checklist}</details> : checklist}
        <div className="nodu-c-diagnosis-actions">
            <button className="scope-text-button" onClick={showOutput}>{compact ? '查看输出' : '查看下载器原始输出'}</button>
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
export function NoduCDevicePanel({ model, simple, confirm, showOutput, exec }: { model: NoduEmbeddedModel; simple: boolean; confirm: Confirm; showOutput: () => void; exec(id: string): void }): React.ReactElement | null {
    const methodFocus = React.useRef<{ input: HTMLInputElement; generation: number; path: string } | undefined>(undefined);
    React.useLayoutEffect(() => {
        const pending = methodFocus.current;
        if (!pending || model.savingOptions) { return; }
        methodFocus.current = undefined;
        const { input, generation, path } = pending;
        const doc = input.ownerDocument;
        if (input.isConnected && !input.disabled && model.projectGeneration === generation && model.project?.path === path
            && (doc.activeElement === doc.body || doc.activeElement === input)) {
            input.focus({ preventScroll: true });
        }
    });
    const project = model.project;
    if (!project) { return null; }
    const method = project.flashMethod;
    const identity = model.identity;
    const identityLabel = identity ? [identity.deviceName ?? project.chip.name, identity.deviceIdHex,
        identity.flashKiB != null ? `${identity.flashKiB} KB` : undefined].filter(Boolean).join('  ') : '';
    const locked = model.busy;
    const methodLocked = locked || !!model.awaitUser;
    const portOptions = [
        ...(model.monitorPort && !model.ports.some(port => port.path === model.monitorPort) ? [{ value: model.monitorPort, label: `${model.monitorPort.replace('/dev/', '')}（未连接）` }] : []),
        ...model.ports.map(port => ({ value: port.path, label: port.path.replace('/dev/', '') })),
    ];
    const probeOptions = [
        { value: '', label: !model.probes.length ? '未检测到 ST-LINK' : model.probes.length === 1 && !model.probe
            ? `${model.probes[0].model}（自动）` : '自动匹配目标芯片' },
        ...(model.probe && !model.probes.some(probe => (probe.id || probe.serial) === model.probe)
            ? [{ value: model.probe, label: `${model.probe}（未连接）` }] : []),
        ...model.probes.map(probe => ({ value: probe.id || probe.serial,
            label: `${probe.model}  ${probe.serial ? probe.serial.slice(-12) : `USB ${probe.location || '未知端口'}`}` })),
    ];
    const restore = async (id: string): Promise<void> => {
        const backup = model.backups.find(b => b.id === id);
        if (!backup) { return; }
        const generation = model.projectGeneration, probe = model.probe, port = model.monitorPort;
        const target = JSON.stringify(project.manifest.target);
        const current = (): boolean => model.projectGeneration === generation && model.project?.path === project.path
            && JSON.stringify(model.project.manifest.target) === target
            && model.project.flashMethod === method && model.probe === probe && model.monitorPort === port
            && !model.busy && !model.awaitUser;
        const ok = await confirm('恢复备份', `${backup.deviceName}（UID ${backup.uid}）\n把 ${backup.createdAt.replace('T', ' ').slice(0, 16)} 的备份（${formatBytes(backup.bytes)}）整片写回芯片。当前的程序会被覆盖。`, '恢复');
        if (ok && current()) {
            const compatible = project.manifest.target.vendor === 'compatible';
            if (compatible && !await confirm('兼容芯片恢复', '尚未验证该兼容芯片。继续恢复仍会核对设备 ID、容量、读保护和备份 UID。', '确认并恢复')) { return; }
            if (current()) { await model.restore(backup, compatible); }
        }
    };
    const selectMethod = (value: 'stlink' | 'uart', input?: HTMLInputElement): void => {
        if (methodLocked) { return; }
        methodFocus.current = input && input.ownerDocument.activeElement === input
            ? { input, generation: model.projectGeneration, path: project.path } : undefined;
        void model.setOption('flashMethod', value);
    };
    const methods = <div className={simple ? 'nodu-c-method-segments' : 'nodu-c-radio'} role="radiogroup" aria-label="下载方式" aria-busy={model.savingOptions || undefined}
        title={model.awaitUser ? '完成 BOOT 引导后可切换' : undefined}>
        {(['stlink', 'uart'] as const).map(value => <label key={value}>
            <input type="radio" name="nodu-c-method" checked={method === value} disabled={methodLocked} onChange={event => void selectMethod(value, event?.currentTarget)}/>
            <span>{simple ? (value === 'stlink' ? 'ST-LINK' : 'ISP') : (value === 'stlink' ? 'ST-LINK（SWD）' : '串口（ISP）')}</span>
        </label>)}
    </div>;
    const downloadPort = method === 'stlink'
        ? <NoduSelect id="nodu-c-probe" aria-label="下载器" value={model.probe} disabled={methodLocked} options={probeOptions} onChange={value => model.setProbe(value)}/>
        : <NoduSelect id="nodu-c-isp-port" aria-label="ISP 串口" value={model.monitorPort} disabled={methodLocked || model.monitorBusy} options={[{ value: '', label: '选择 USB 转串口' }, ...portOptions]} onChange={value => model.setMonitorPort(value)}/>;
    const monitorPort = <NoduSelect id="nodu-c-monitor-port" aria-label="监视器串口" value={model.monitorPort} disabled={methodLocked || model.monitorBusy} options={[{ value: '', label: '运行后不打开' }, ...portOptions]} onChange={value => model.setMonitorPort(value)}/>;
    const refresh = <button className="scope-action scope-toolbar-icon" aria-label="刷新下载器与串口" title="刷新" disabled={locked} onClick={() => void model.refreshDevices()}><i className="codicon codicon-refresh" aria-hidden="true"/></button>;
    const diagnostic = model.lastError && !model.busy && <NoduDiagnosis compact={simple} failure={model.lastError} method={method} showOutput={showOutput} dismiss={() => { model.lastError = undefined; model.fire(); }}/>;
    if (simple) {
        return <div className="nodu-c-device-compact">
            <div className="nodu-c-compact-heading"><strong title="工程目标芯片">{project.chip.name}</strong>{refresh}</div>
            <dl className="nodu-c-compact-specs">
                <div><dt className="scope-visually-hidden">内核</dt><dd>{project.chip.core}</dd></div>
                <div><dt>Flash</dt><dd>{formatBytes(project.chip.flash.size)}</dd></div>
                <div><dt>RAM</dt><dd>{formatBytes(project.chip.ram.size)}</dd></div>
            </dl>
            <div className="nodu-c-compact-row"><span>{model.savingOptions ? <span role="status">保存中</span> : '下载方式'}</span>{methods}</div>
            <div className="nodu-c-compact-row"><label htmlFor={method === 'stlink' ? 'nodu-c-probe' : 'nodu-c-isp-port'}>{method === 'stlink' ? '下载器' : 'ISP 串口'}</label>{downloadPort}</div>
            {method === 'stlink' && <div className="nodu-c-compact-row"><label htmlFor="nodu-c-monitor-port">监视串口</label>{monitorPort}</div>}
            {(identity || method === 'stlink' && model.probes.length > 0) && <div className="nodu-c-compact-row nodu-c-compact-target">
                <span className={identity?.matches ? 'nodu-c-error-text' : identity ? 'nodu-c-ok-text' : 'nodu-c-muted'}>
                    <i className={`codicon codicon-${identity?.matches ? 'warning' : identity ? 'pass' : 'circle-large-outline'}`} aria-hidden="true"/>
                    {identity?.matches ? '芯片不匹配' : identity ? '已识别' : '未识别'}
                </span>
                {method === 'stlink' && <div className="nodu-c-compact-actions">
                    <button disabled={locked} onClick={() => void model.identify()}>{model.identifying ? '识别中…' : '识别'}</button>
                    <button disabled={locked} onClick={() => void model.reset()}>复位</button>
                </div>}
            </div>}
            {identity && <p className={`nodu-c-compact-identity${identity.matches ? ' nodu-c-error-text' : ''}`}>
                {identity.matches || identityLabel}
            </p>}
            {model.probes.some(p => p.driver === 'missing') && <p className="nodu-c-compact-warning">ST-LINK 驱动未安装。请安装 STSW-LINK009 后重新连接。</p>}
            {diagnostic}
            {model.backups.length > 0 && <details className="nodu-c-compact-backups">
                <summary>{model.backupScope === 'device' ? '设备备份' : '历史备份'}<span>{model.backups.length}</span></summary>
                <ul>{model.backups.map(backup => <li key={backup.id}>
                    <div><span className="nodu-c-compact-backup-chip" title={`UID ${backup.uid}`}>{backup.deviceName} <span className="nodu-c-muted">{backup.uid?.slice(-8)}</span></span><span>{(backup.firstBackup ?? backup.factory) ? '首次备份' : '备份'} <span className="nodu-c-muted">{formatBytes(backup.bytes)}</span></span><time>{backup.createdAt.replace('T', ' ').slice(0, 16)}</time></div>
                    <button className="scope-text-button" disabled={methodLocked} onClick={() => void restore(backup.id)}>恢复…</button>
                </li>)}</ul>
            </details>}
            <button className="nodu-c-compact-settings" disabled={locked} onClick={() => exec(C_COMMANDS.projectSettings)}>工程设置<i className="codicon codicon-chevron-right" aria-hidden="true"/></button>
        </div>;
    }
    return <div className="scope-device-panel nodu-c-device">
        <Section title="目标芯片" icon="chip" action={<button className="scope-text-button" disabled={locked} onClick={() => exec(C_COMMANDS.projectSettings)}>设置…</button>}>
            <p className="nodu-c-strong">{project.chip.name}</p>
            <dl className="nodu-chip-spec"><dt>内核</dt><dd>{project.chip.core}</dd><dt>Flash</dt><dd>{formatBytes(project.chip.flash.size)}</dd><dt>RAM</dt><dd>{formatBytes(project.chip.ram.size)}</dd></dl>
        </Section>
        <Section title="下载方式" icon="cloud-upload" action={<span className="nodu-c-inline-actions">{model.savingOptions && <span role="status">保存中</span>}{refresh}</span>}>
            {methods}
            <div className="nodu-device-field"><label htmlFor={method === 'stlink' ? 'nodu-c-probe' : 'nodu-c-isp-port'}>{method === 'stlink' ? '下载器' : '串口'}</label>{downloadPort}</div>
            {model.probes.some(p => p.driver === 'missing') && <p className="nodu-c-warn">检测到 ST-LINK，但 Windows 没有为它安装驱动。从 st.com 下载 STSW-LINK009 驱动并安装后重新插拔。</p>}
        </Section>
        {method === 'stlink' && <Section title="串口监视器" icon="output">
            <div className="nodu-device-field">
                <label htmlFor="nodu-c-monitor-port">串口</label>
                {monitorPort}
            </div>
        </Section>}
        <Section title="芯片" icon="chip" action={method === 'stlink' ? <span className="nodu-c-inline-actions">
            <button className="theia-button secondary" disabled={locked} onClick={() => void model.identify()}>{model.identifying ? '识别中…' : '识别'}</button>
            <button className="theia-button secondary" disabled={locked} onClick={() => void model.reset()}>复位</button>
        </span> : undefined}>
            {identity ? identity.matches
                ? <p className="nodu-c-error-text">{identity.matches}</p>
                : <p className="nodu-c-ok-text"><i className="codicon codicon-pass" aria-hidden="true"/>{identityLabel}
</p>
                : <p className="nodu-c-muted">未识别</p>}
        </Section>
        {diagnostic}
        <Section title={model.backupScope === 'device' ? '设备备份' : '历史备份'} icon="history">
            {model.backups.length ? <ul className="nodu-c-backups">
                {model.backups.slice(0, 10).map(backup => <li key={backup.id}>
                    <span title={`UID ${backup.uid}`}>{backup.deviceName}  {(backup.firstBackup ?? backup.factory) ? '首次备份' : '备份'}  {backup.createdAt.replace('T', ' ').slice(0, 16)}  {formatBytes(backup.bytes)}</span>
                    <button className="scope-text-button" disabled={methodLocked} onClick={() => void restore(backup.id)}>恢复…</button>
                </li>)}
            </ul> : <p className="nodu-c-muted">暂无备份</p>}
        </Section>
        <Section title="STM32 工具包" icon="tools" action={<button className="scope-text-button" onClick={() => exec(C_COMMANDS.toolkitInfo)}>详情…</button>} hidden={simple}>
            <p className={project.toolkit.ok ? 'nodu-c-muted' : 'nodu-c-error-text'}>{project.toolkit.ok ? `${project.toolkit.version}  已检查` : project.toolkit.message}</p>
        </Section>
    </div>;
}
