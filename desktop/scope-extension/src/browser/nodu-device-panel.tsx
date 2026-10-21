// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { NoduDeviceModel } from './nodu-device-client';
import { NoduBoardFiles } from './nodu-board-files';
import { MAIXPY_RELEASES_URL } from './nodu-file-docs';
import { NoduFirmwarePanel } from './nodu-firmware-panel';

interface Props { model: NoduDeviceModel; files: FileService; dialogs: FileDialogService; editors: EditorManager; showLogs: () => void; showBoardGuide?: () => void; compact?: boolean; }

/** Device controls retain their values when the shell changes density or layout. */
// Original MaixPy IDE 0.2.5 board menu order (see docs/0.1.3 evidence §2).
export const BOARD_IDS = [
    'Kendryte KD233',
    'Sipeed Maix Bit (old)',
    'Sipeed Maix Dock',
    'Sipeed Maix Go (open-ec & new CMSIS-DAP)',
    'Sipeed Maix Go (Old CMSIS-DAP)',
    'Sipeed Maixduino',
    'Sipeed Maix Bit (with Mic)',
    'M5StickV',
    'T-Watch',
];

export function NoduDevicePanel({ model, files, dialogs, editors, showLogs, showBoardGuide, compact = false }: Props): React.ReactElement {
    const [code, setCode] = React.useState('print("Hello, Nodu")');
    const state = model.state;
    const blocked = model.busy;
    const replOutput = model.logs.filter(log => log.stream !== 'system').slice(-12).map(log => log.text).join('').slice(-8000);

    return <div className="scope-device-panel">
        <section className="scope-device-section" aria-label="硬件设备">
            <div className="scope-section-heading"><h2><i className="codicon codicon-circuit-board" aria-hidden="true" />硬件设备</h2><span className={`scope-state ${model.connected ? 'scope-state-active' : ''}`} role="status"><i aria-hidden="true" />{model.statusLabel}</span></div>
            <div className="nodu-device-field"><label htmlFor="nodu-serial-port">串口</label><div className="nodu-input-action"><select id="nodu-serial-port" value={model.selectedPort} disabled={blocked || model.connected} onChange={event => model.selectPort(event.currentTarget.value)}><option value="">{model.ports.length ? '选择串口' : '扫描后选择串口'}</option>{model.ports.map(port => <option value={port.path} key={port.path}>{port.path} · {port.description}</option>)}</select><button className="theia-button secondary" disabled={blocked || model.connected} onClick={() => void model.scanPorts()} title="重新扫描本机串口"><i className="codicon codicon-refresh" aria-hidden="true" />扫描</button></div></div>
            <div className="nodu-device-field"><label htmlFor="nodu-board-profile">相机适配</label><select id="nodu-board-profile" value={model.boardProfile} disabled={blocked || model.connected} onChange={event => model.selectProfile(event.currentTarget.value as typeof model.boardProfile)}><option value="embedfire-cam-gc2145">野火 K210 CAM · GC2145</option><option value="generic-k210">通用 K210</option></select></div>
            <div className="nodu-device-field"><label htmlFor="nodu-board-id">连接复位方式</label><select id="nodu-board-id" value={model.boardId} disabled={blocked || model.connected} onChange={event => model.selectBoardId(Number(event.currentTarget.value))}>{BOARD_IDS.map((label, id) => <option value={id} key={id}>{label}</option>)}</select></div>
            <div className="scope-device-actions">{!model.connected && state.phase !== 'connecting' && <button className="theia-button" disabled={blocked || model.connected} onClick={() => void model.connect()}>连接</button>}{(model.connected || state.phase === 'connecting' || state.phase === 'error' || model.busy) && <button className="theia-button secondary" disabled={model.flashing} onClick={() => void model.disconnect()}>{state.phase === 'connecting' ? '取消' : '断开'}</button>}{!compact && <button className="theia-button secondary nodu-stop" disabled={!model.canStop} onClick={() => void model.stop()}><i className="codicon codicon-debug-stop" aria-hidden="true" />{model.busy || state.phase === 'error' ? '停止 / 取消' : '停止脚本'}</button>}{showBoardGuide && <button className="theia-button secondary" onClick={showBoardGuide} title="查看板端配置声明与引脚资料">认识开发板</button>}</div>
            {model.error && <div className="nodu-device-error" role="alert"><p>{model.error}</p><button className="scope-text-button" onClick={() => model.clearError()}>收起错误</button></div>}
            {(model.connected || state.firmware) && <details className="nodu-device-details"><summary>设备详情</summary><dl className="scope-device-details nodu-firmware"><div><dt>串口</dt><dd className="scope-mono">{state.port || '—'}</dd></div><div><dt>固件</dt><dd>{state.firmware ? <a className="nodu-firmware-link" href={MAIXPY_RELEASES_URL} target="_blank" rel="noopener noreferrer" title="最新固件发布说明（Sipeed MaixPy Releases）">{state.firmware}</a> : '—'}</dd></div><div><dt>架构</dt><dd>{state.architecture || '—'}</dd></div><div><dt>REPL / 文件 / 脚本 / 图像</dt><dd className="nodu-capabilities">{[state.capabilities.repl, state.capabilities.files, state.capabilities.script, state.capabilities.framebuffer].map((supported, index) => <span key={index} className={supported ? 'nodu-capability-yes' : ''} title={['REPL', '文件', 'RAM 脚本', '图像'][index]}>{supported ? '支持' : '不支持'}</span>)}</dd></div></dl></details>}
        </section>
        {/* Keep mounted while hidden so a flash in progress survives mode switches. */}
        {state.capabilities.firmware &&
            <div hidden={compact && !model.flashing}><NoduFirmwarePanel model={model} blocked={blocked} showLogs={compact ? undefined : showLogs} /></div>}
        <section aria-label="REPL 控制台" hidden={compact}>
            <div className="scope-section-heading"><h2>REPL</h2><button className="scope-text-button" onClick={showLogs}>设备日志</button></div>
            <label className="scope-visually-hidden" htmlFor="nodu-repl-code">REPL Python 代码</label>
            <textarea id="nodu-repl-code" className="nodu-code-input" value={code} onChange={event => setCode(event.currentTarget.value)} spellCheck={false} rows={3} disabled={!model.connected || !state.capabilities.repl || state.running || blocked} placeholder="输入 Python 代码" onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); if (model.connected && !blocked && !state.running && state.capabilities.repl) { void model.execute(code); } } }} />
            <div className="scope-device-actions"><button className="theia-button secondary" disabled={!model.connected || !state.capabilities.repl || state.running || blocked || !code.trim()} onClick={() => void model.execute(code)}>执行 REPL</button></div>
            {replOutput && <pre className="nodu-repl-output" aria-label="设备输出" tabIndex={0}>{replOutput}</pre>}
        </section>
        {/* Professional mode has the docked 开发板文件 view; keep this copy mounted (drafts survive mode switches) but out of sight. */}
        <div hidden={!compact}><NoduBoardFiles model={model} files={files} dialogs={dialogs} editors={editors} /></div>
    </div>;
}
