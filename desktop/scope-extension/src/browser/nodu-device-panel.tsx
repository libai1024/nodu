// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { NODU_FILE_LIMIT, NoduDeviceModel } from './nodu-device-client';
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
    const [directory, setDirectory] = React.useState(model.directory);
    const [remotePath, setRemotePath] = React.useState('/flash/nodu_example.py');
    const [overwrite, setOverwrite] = React.useState(false);
    const [localBusy, setLocalBusy] = React.useState(false);
    const state = model.state;
    const blocked = model.busy || localBusy;
    const canUseFiles = model.connected && state.capabilities.files && !state.running && !blocked;
    const replOutput = model.logs.filter(log => log.stream !== 'system').slice(-12).map(log => log.text).join('').slice(-8000);
    const transfer = async (direction: 'read' | 'write'): Promise<void> => {
        setLocalBusy(true);
        model.clearError();
        try {
            if (!remotePath.trim() || !remotePath.startsWith('/')) { throw new Error('请输入以 / 开头的板端绝对路径。'); }
            if (direction === 'write') {
                const port = model.state.port;
                const uri = await dialogs.showOpenDialog({ title: '选择要写入板端的本地文件（最多 2 MiB）', canSelectFiles: true, canSelectFolders: false, canSelectMany: false, openLabel: '选择文件' });
                if (!uri) { return; }
                const content = await files.readFile(uri, { limits: { size: NODU_FILE_LIMIT } });
                const target = remotePath.trim();
                let confirmedStartup = false;
                if (/^(boot|main)\.py$/i.test(target.split('/').pop() || '')) {
                    const confirm = new ConfirmDialog({
                        title: '写入启动文件',
                        msg: `确定将所选文件写入 ${target}？启动文件可能在下次开机执行。`,
                        ok: '写入启动文件', cancel: '取消',
                    });
                    if (!await confirm.open()) { return; }
                    confirmedStartup = true;
                }
                // The device may have changed or reconnected to another board
                // while the pickers were open; never write to a different port.
                if (!model.connected || model.busy || model.state.running || model.state.port !== port) {
                    model.note('设备状态已变化，写入已取消；请重试。');
                    return;
                }
                const written = await model.writeFile(target, content.value.buffer, overwrite, confirmedStartup);
                if (written) { await model.listFiles(model.directory); }
            } else {
                const uri = await dialogs.showSaveDialog({ title: '将板端文件另存为新的本地文件', inputValue: remotePath.split('/').pop(), saveLabel: '读取并保存' });
                if (!uri) { return; }
                if (await files.exists(uri)) { throw new Error('本地文件已存在。请选择新文件名，以保留本地文件和未保存的编辑内容。'); }
                const data = await model.readFile(remotePath.trim());
                if (!data) { return; }
                await files.createFile(uri, BinaryBuffer.wrap(data), { overwrite: false });
                model.note(`已读取 ${remotePath} · ${data.length} 字节，保存至 ${uri.path.toString()}。`);
                // A binary download has succeeded even when it cannot be opened
                // as source text. Keep the current editor and dirty buffer intact.
                let text: string | undefined;
                try { text = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { /* Binary file. */ }
                if (text !== undefined && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
                    try { await editors.open(uri, { mode: 'activate' }); }
                    catch { model.note('文件已下载。编辑器未打开该文件，可从本地目录查看。'); }
                }
            }
        } catch (error) { model.reportError(direction === 'write' ? '写入板端文件' : '读取板端文件', error); }
        finally { setLocalBusy(false); }
    };

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
        <section aria-label="板端文件">
            <div className="scope-section-heading"><h2>板端文件</h2><span className="scope-muted">单文件 ≤ 2 MiB</span></div>
            <label className="scope-visually-hidden" htmlFor="nodu-remote-directory">板端目录</label><div className="nodu-input-action"><input id="nodu-remote-directory" value={directory} onChange={event => setDirectory(event.currentTarget.value)} disabled={!canUseFiles} placeholder="/flash" /><button className="theia-button secondary" disabled={!canUseFiles || !directory.trim()} onClick={() => void model.listFiles(directory.trim())}>列出目录</button></div>
            <ul className="nodu-file-list" aria-label={`板端目录 ${model.directory}`}>{model.entries.map(entry => <li key={entry.path}><button disabled={!canUseFiles} onClick={() => { if (entry.directory) { setDirectory(entry.path); void model.listFiles(entry.path); } else { setRemotePath(entry.path); } }} title={entry.path}><i className={`codicon codicon-${entry.directory ? 'folder' : 'file'}`} aria-hidden="true" /><span>{entry.name}</span><span className="scope-muted">{entry.directory ? '目录' : `${entry.size} B`}</span></button></li>)}</ul>
            <div className="nodu-device-field"><label htmlFor="nodu-remote-file">文件路径</label><input id="nodu-remote-file" value={remotePath} onChange={event => setRemotePath(event.currentTarget.value)} disabled={!canUseFiles} placeholder="/flash/nodu_example.py" /></div>
            <label className="scope-check nodu-overwrite"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.currentTarget.checked)} disabled={!canUseFiles} />覆盖同名文件</label>
            <div className="scope-device-actions"><button className="theia-button secondary" disabled={!canUseFiles || !remotePath.trim()} onClick={() => void transfer('read')}>读取到本地…</button><button className="theia-button secondary" disabled={!canUseFiles || !remotePath.trim()} onClick={() => void transfer('write')}>选择本地文件写入…</button></div>
            {/* Startup-file protection and transfer errors remain enforced by the worker. */}
        </section>
    </div>;
}
