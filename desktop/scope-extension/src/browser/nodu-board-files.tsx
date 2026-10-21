// SPDX-License-Identifier: MIT
// Board-side file browser shared by the device popover (simple mode) and the
// 开发板文件 view next to the local file tree (professional mode). Local
// files stay in Theia's explorer; everything here lives on the board.
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { Message } from '@theia/core/shared/@lumino/messaging';
import { CommandService } from '@theia/core/lib/common';
import { ReactWidget } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { NODU_FILE_LIMIT, NoduDeviceModel } from './nodu-device-client';

interface Props { model: NoduDeviceModel; files: FileService; dialogs: FileDialogService; editors: EditorManager; }

export function NoduBoardFiles({ model, files, dialogs, editors }: Props): React.ReactElement {
    const [directory, setDirectory] = React.useState(model.directory);
    const [remotePath, setRemotePath] = React.useState('/flash/nodu_example.py');
    const [overwrite, setOverwrite] = React.useState(false);
    const [localBusy, setLocalBusy] = React.useState(false);
    const state = model.state;
    const canUseFiles = model.connected && state.capabilities.files && !state.running && !model.busy && !localBusy;
    // Two views (device popover, docked tab) share one listing; keep each input on the directory shown.
    React.useEffect(() => { setDirectory(model.directory); }, [model.directory]);
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

    return <section className="nodu-board-files" aria-label="板端文件">
        <div className="scope-section-heading"><h2>板端文件</h2><span className="scope-muted">单文件 ≤ 2 MiB</span></div>
        <div className="nodu-input-action"><input value={directory} onChange={event => setDirectory(event.currentTarget.value)} disabled={!canUseFiles} placeholder="/flash" aria-label="板端目录" /><button className="theia-button secondary" disabled={!canUseFiles || !directory.trim()} onClick={() => void model.listFiles(directory.trim())}>列出目录</button></div>
        <ul className="nodu-file-list" aria-label={`板端目录 ${model.directory}`}>{model.entries.map(entry => <li key={entry.path}><button disabled={!canUseFiles} onClick={() => { if (entry.directory) { setDirectory(entry.path); void model.listFiles(entry.path); } else { setRemotePath(entry.path); } }} title={entry.path}><i className={`codicon codicon-${entry.directory ? 'folder' : 'file'}`} aria-hidden="true" /><span>{entry.name}</span><span className="scope-muted">{entry.directory ? '目录' : `${entry.size} B`}</span></button></li>)}</ul>
        <label className="nodu-device-field">文件路径<input value={remotePath} onChange={event => setRemotePath(event.currentTarget.value)} disabled={!canUseFiles} placeholder="/flash/nodu_example.py" /></label>
        <label className="scope-check nodu-overwrite"><input type="checkbox" checked={overwrite} onChange={event => setOverwrite(event.currentTarget.checked)} disabled={!canUseFiles} />覆盖同名文件</label>
        <div className="scope-device-actions"><button className="theia-button secondary" disabled={!canUseFiles || !remotePath.trim()} onClick={() => void transfer('read')}>读取到电脑…</button><button className="theia-button secondary" disabled={!canUseFiles || !remotePath.trim()} onClick={() => void transfer('write')}>从电脑写入…</button></div>
        {/* Startup-file protection and transfer errors remain enforced by the worker. */}
    </section>;
}

/** Professional-mode 开发板文件 view, docked beside the local explorer. */
@injectable()
export class NoduBoardFilesWidget extends ReactWidget {
    static readonly ID = 'nodu:board-files';
    static readonly LABEL = '开发板文件';
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(CommandService) protected readonly commands!: CommandService;
    private listedThisConnection = false;

    @postConstruct()
    protected init(): void {
        this.id = NoduBoardFilesWidget.ID;
        this.title.label = NoduBoardFilesWidget.LABEL;
        this.title.caption = '开发板上的文件（与电脑上的项目文件分开）';
        this.title.iconClass = 'codicon codicon-circuit-board';
        this.title.closable = true;
        this.addClass('scope-widget');
        this.addClass('nodu-board-files-widget');
        this.toDispose.push(this.device.onDidChange(() => {
            if (!this.device.connected) { this.listedThisConnection = false; } else { this.listOncePerConnection(); }
            this.update();
        }));
        this.update();
    }

    // The board can connect while this tab sits behind the explorer; list when it is shown.
    protected override onAfterShow(msg: Message): void {
        super.onAfterShow(msg);
        this.listOncePerConnection();
    }

    /**
     * List the current directory once per connection, while this tab is visible and the board idle.
     * connect() reports the new state while still busy, so this runs again on every change event
     * until the board is idle; a failed listing is not retried (the error is already shown).
     */
    private listOncePerConnection(): void {
        const { device } = this;
        if (this.listedThisConnection || !this.isVisible || !device.connected || !device.state.capabilities.files
            || device.busy || device.state.running) { return; }
        this.listedThisConnection = true;
        if (!device.entries.length) { void device.listFiles(device.directory); }
    }

    protected render(): React.ReactNode {
        if (!this.device.connected) {
            return <div className="nodu-preview-empty"><i className="codicon codicon-plug" aria-hidden="true" /><strong>未连接设备</strong><button className="theia-button" onClick={() => void this.commands.executeCommand('scope.show-devices')}>连接设备</button></div>;
        }
        return <NoduBoardFiles model={this.device} files={this.files} dialogs={this.dialogs} editors={this.editors} />;
    }
}

@injectable()
export class NoduBoardFilesContribution extends AbstractViewContribution<NoduBoardFilesWidget> {
    constructor() {
        super({ widgetId: NoduBoardFilesWidget.ID, widgetName: NoduBoardFilesWidget.LABEL,
            defaultWidgetOptions: { area: 'left', rank: 150 }, toggleCommandId: 'scope.board-files' });
    }
}
