// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { NoduDeviceModel } from './nodu-device-client';

function address(value: number): string { return `0x${value.toString(16).toUpperCase().padStart(6, '0')}`; }

/** The checkbox belongs to the device recovery workflow and is tied to the displayed backup. */
export function NoduFirmwarePanel({ model, blocked, showLogs }: { model: NoduDeviceModel; blocked: boolean; showLogs?: () => void }): React.ReactElement {
    const [acceptedDirectory, setAcceptedDirectory] = React.useState('');
    const [copiedDirectory, setCopiedDirectory] = React.useState('');
    const { plan, backup, flashResult, state } = model;
    const backupVerified = !!backup?.verified && backup.flashCapacityVerified && !!plan && backup.flashBytes >= plan.sectorEnd;
    const accepted = !!backup?.directory && model.verifiedBackup && acceptedDirectory === backup.directory;
    const firmwareBusy = model.flashing || state.operation === 'prepareFirmware' || state.operation === 'backupDevice' || ['读取官方固件', '备份当前设备'].includes(model.pending);
    const progress = state.progress;
    const measuredProgress = !!progress && Number.isFinite(progress.completed) && Number.isFinite(progress.total) && progress.total > 0 && progress.completed >= 0 && progress.completed <= progress.total && Number.isFinite(progress.percent) && progress.percent >= 0 && progress.percent <= 100;
    const copyBackup = async (): Promise<void> => {
        if (!backup) { return; }
        try { await navigator.clipboard.writeText(backup.directory); setCopiedDirectory(backup.directory); }
        catch (error) { model.reportError('复制备份路径', new Error('请选中备份目录文本，按 Ctrl+C / ⌘C 复制。')); }
    };

    return <section className="nodu-firmware-section" aria-label="固件与恢复">
        <details className="nodu-firmware-disclosure">
            <summary>固件与恢复</summary>
            <div className="nodu-firmware-step">
                <div className="scope-device-actions"><button className="theia-button secondary" disabled={blocked || model.flashing} onClick={() => void model.prepareFirmware()}>读取官方固件</button>{plan && <span className={plan.ready ? 'nodu-capability-yes' : 'scope-muted'}>{plan.ready ? '已校验' : '未就绪'}</span>}</div>
                {plan && <details className="nodu-device-details"><summary>镜像详情</summary><dl className="scope-device-details nodu-firmware-metadata">
                    <div><dt>版本</dt><dd>{plan.version}</dd></div>
                    <div><dt>镜像大小</dt><dd>{plan.size.toLocaleString()} 字节</dd></div>
                    {/* Image bytes include the boot header and digest; this is not an ISP erase boundary. */}
                    <div><dt>镜像写入范围</dt><dd className="scope-mono">{address(plan.address)} – {address(plan.address + plan.writeBytes)}<span className="scope-muted">（末地址不含）</span></dd></div>
                    <div><dt>计划写入</dt><dd>{plan.writeBytes.toLocaleString()} 字节</dd></div>
                    <div className="nodu-metadata-full"><dt>SHA-256</dt><dd><code>{plan.sha256}</code></dd></div>
                    <div className="nodu-metadata-full"><dt>官方来源</dt><dd><a href={plan.url} target="_blank" rel="noopener noreferrer">{plan.url}</a></dd></div>
                </dl></details>}
            </div>
            <div className="nodu-firmware-step">
                {/* A complete chip/file snapshot remains required by the existing recovery gate. */}
                <div className="scope-device-actions"><button className="theia-button secondary" disabled={!plan?.ready || !model.connected || state.running || blocked} onClick={() => { setAcceptedDirectory(''); setCopiedDirectory(''); void model.backupDevice(); }}>备份并验证</button>{backup && <span className={backupVerified ? 'nodu-capability-yes' : 'scope-muted'}>{backupVerified ? '已验证' : '验证未通过'}</span>}</div>
                {backup && <details className="nodu-device-details"><summary>备份详情</summary>
                    <dl className="scope-device-details nodu-firmware-metadata">
                        <div><dt>Flash 容量</dt><dd>{backup.flashCapacityVerified ? `${backup.flashBytes.toLocaleString()} 字节` : '未核实'}</dd></div>
                        <div><dt>JEDEC ID</dt><dd className="scope-mono">{backup.flashJedecId || '—'}</dd></div>
                        {backup.physicalBoardEvidence && <div className="nodu-metadata-full"><dt>板型</dt><dd>{backup.physicalBoardEvidence}</dd></div>}
                        <div><dt>用户文件</dt><dd>{backup.files} 个</dd></div>
                        <div><dt>创建时间</dt><dd>{new Date(backup.createdAt).toLocaleString('zh-CN', { hour12: false })}</dd></div>
                        <div className="nodu-metadata-full"><dt>Flash SHA-256</dt><dd><code>{backup.flashSha256}</code></dd></div>
                    </dl>
                    <label className="nodu-device-field" htmlFor="nodu-backup-directory">备份目录</label><div className="nodu-input-action"><input id="nodu-backup-directory" className="scope-mono" value={backup.directory} readOnly onFocus={event => event.currentTarget.select()} /><button className="theia-button secondary" onClick={() => void copyBackup()}>{copiedDirectory === backup.directory ? '已复制' : '复制路径'}</button></div>
                </details>}
            </div>
            <div className="nodu-firmware-step">
                <label className="scope-check nodu-flash-acknowledgement"><input type="checkbox" checked={accepted} disabled={!model.verifiedBackup || blocked || model.flashing} onChange={event => setAcceptedDirectory(event.currentTarget.checked ? backup?.directory || '' : '')} />确认重写固件，已保留备份</label>
                <div className="scope-device-actions"><button className="theia-button" disabled={!model.canFlash || !accepted || blocked} onClick={() => { setAcceptedDirectory(''); void model.flashFirmware(); }}>烧写并验证</button>{flashResult && <span className={flashResult.verified ? 'nodu-capability-yes' : 'scope-error'}>{flashResult.verified ? '验证通过' : '验证失败'}</span>}</div>
                {flashResult && <details className="nodu-device-details"><summary>烧写详情</summary><dl className="scope-device-details nodu-firmware-metadata"><div><dt>固件</dt><dd>{flashResult.firmware}</dd></div><div className="nodu-metadata-full"><dt>SHA-256</dt><dd><code>{flashResult.sha256}</code></dd></div><div className="nodu-metadata-full"><dt>恢复备份</dt><dd>{flashResult.backupDirectory}</dd></div></dl></details>}
            </div>
            {firmwareBusy && <div className="nodu-firmware-progress" role="status">{measuredProgress && <span>{progress!.percent.toFixed(1)}%</span>}<progress max={measuredProgress ? progress!.total : undefined} value={measuredProgress ? progress!.completed : undefined} aria-label="设备操作进度" /></div>}
            {/* Errors remain visible once in the parent device panel; logs use the shared Output view. */}
            {showLogs && <div className="scope-device-actions"><button className="scope-text-button" onClick={showLogs}>设备日志</button></div>}
        </details>
    </section>;
}
