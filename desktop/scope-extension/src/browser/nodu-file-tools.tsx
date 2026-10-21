// SPDX-License-Identifier: MIT
// Board file menu workflows: write the current editor to boot.py and send an
// arbitrary local file to the board's default storage. Both are confirmed
// operations; FILE_SAVE always overwrites and startup files get an extra
// warning before the request is sent.
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickInputService, QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { NODU_FILE_LIMIT, NoduDeviceModel } from './nodu-device-client';
import { TOOLS_MENU_GROUPS } from '../common/nodu-tools-menu';
import { boardFileNameProblem } from '../common/nodu-board-file-name';

const STARTUP_RE = /^(boot|main)\.py$/i;

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

@injectable()
export class NoduFileToolsContribution implements CommandContribution, MenuContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(QuickInputService) protected readonly quickInput!: QuickInputService;

    private filesUsable(): boolean {
        return this.device.connected && !this.device.busy
            && !this.device.state.running && !!this.device.state.capabilities.files;
    }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'scope.save-boot-script', label: '将打开的脚本保存到开发板的 boot.py', category: '见微 Nodu' }, {
            execute: () => this.saveBootScript().catch(error => this.messages.error(`写入 boot.py：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.filesUsable(),
        });
        registry.registerCommand({ id: 'scope.save-current-to-board', label: '将当前脚本保存到开发板', category: '见微 Nodu' }, {
            execute: () => this.saveCurrentToBoard().catch(error => this.messages.error(`保存到开发板：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.filesUsable(),
        });
        registry.registerCommand({ id: 'scope.send-file', label: '发送文件到开发板', category: '见微 Nodu' }, {
            execute: () => this.sendFile().catch(error => this.messages.error(`发送文件：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.filesUsable(),
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const group = [...MAIN_MENU_BAR, '5_scope', TOOLS_MENU_GROUPS.filesGroup];
        menus.registerMenuAction(group, { commandId: 'scope.save-boot-script', order: '0' });
        menus.registerMenuAction(group, { commandId: 'scope.send-file', order: '1' });
    }

    /** Abort when the device changed (disconnect/busy/different port) mid-dialog. */
    private async deviceUnchanged(port: string | undefined, what: string): Promise<boolean> {
        if (this.device.connected && !this.device.busy && !this.device.state.running
            && this.device.state.port === port) {
            return true;
        }
        await this.messages.info(`设备状态已变化，${what}已取消；请重试。`);
        return false;
    }

    /** Write the current editor buffer (unsaved included) to boot.py. */
    protected async saveBootScript(): Promise<void> {
        const widget = this.editors.currentEditor;
        const control = widget && MonacoEditor.get(widget)?.getControl();
        const model = control?.getModel();
        if (!widget || !control || !model) {
            await this.messages.info('请先打开要写入 boot.py 的 Python 文件。');
            return;
        }
        // Capture once: the buffer may be edited while dialogs are open.
        const port = this.device.state.port;
        const sourceName = widget.editor.uri.path.base || '当前脚本';
        const version = model.getVersionId();
        const code = model.getValue();
        if (!code.trim()) {
            await this.messages.info('当前代码为空，没有可写入的脚本。');
            return;
        }
        const choice = await this.quickPick.show([
            { label: '保留原样', description: '按当前缓冲区原样写入', id: 'keep' },
            { label: '去除注释并转换缩进', description: '去掉 # 注释，4 空格缩进转为制表符', id: 'format' },
            { label: '取消', id: 'cancel' },
        ] as { label: string; description?: string; id: 'keep' | 'format' | 'cancel' }[],
            { placeholder: '写入前是否格式化脚本' });
        if (!choice || choice.id === 'cancel') { return; }
        let data = code;
        if (choice.id === 'format') {
            const formatted = await this.device.formatScript(code, true, true);
            if (formatted === undefined) { return; }
            data = formatted;
        }
        // The editor buffer must be exactly what the user saw when they chose.
        if (control.getModel() !== model || model.isDisposed() || model.getVersionId() !== version) {
            await this.messages.info('编辑器内容已变化，请重试。');
            return;
        }
        const bytes = new TextEncoder().encode(data);
        if (bytes.length > NODU_FILE_LIMIT) {
            await this.messages.error('脚本超过 2 MiB 限额。');
            return;
        }
        const confirm = new ConfirmDialog({
            title: '写入 boot.py',
            msg: `将 ${sourceName}（${bytes.length} 字节）写入板端 boot.py。\n将覆盖开发板默认存储中的 boot.py；已挂载 SD 卡时固件通常写入 /sd。启动文件可能在下次开机执行。`,
            ok: '写入 boot.py', cancel: '取消',
        });
        if (!await confirm.open()) { return; }
        // Re-check after the confirm wait: the editor may have been closed or
        // edited, and the device may have changed or reconnected elsewhere.
        if (widget.isDisposed || control.getModel() !== model || model.isDisposed()
            || model.getVersionId() !== version) {
            await this.messages.info('编辑器内容已变化，请重试。');
            return;
        }
        if (!await this.deviceUnchanged(port, '写入 boot.py')) { return; }
        // The source buffer is never modified or saved by this command.
        const written = await this.device.saveFile('boot.py', toBase64(bytes), true);
        if (written === true) {
            await this.messages.info(`已将 ${sourceName} 写入板端 boot.py（默认存储）。`);
        }
    }

    /**
     * Save the current editor buffer (unsaved edits included) under a chosen
     * name in the board's default storage. Distinct from 运行 (RAM only) and
     * 设为开机脚本 (boot.py); the local file is never modified or saved.
     */
    protected async saveCurrentToBoard(): Promise<void> {
        const widget = this.editors.currentEditor;
        const control = widget && MonacoEditor.get(widget)?.getControl();
        const model = control?.getModel();
        if (!widget || !control || !model) {
            await this.messages.info('请先打开要保存到开发板的文件。');
            return;
        }
        const port = this.device.state.port;
        const version = model.getVersionId();
        const code = model.getValue();
        if (!code.trim()) {
            await this.messages.info('当前代码为空，没有可保存的内容。');
            return;
        }
        const name = (await this.quickInput.input({
            title: '保存到开发板',
            prompt: '开发板默认存储中的文件名；同名文件将被覆盖',
            value: widget.editor.uri.path.base || 'main.py',
            validateInput: async input => boardFileNameProblem(input),
        }))?.trim();
        if (!name) { return; }
        const bytes = new TextEncoder().encode(code);
        if (bytes.length > NODU_FILE_LIMIT) {
            await this.messages.error('文件超过 2 MiB 限额。');
            return;
        }
        const startup = STARTUP_RE.test(name);
        const confirm = new ConfirmDialog({
            title: '保存到开发板',
            msg: startup
                ? `将当前内容（${bytes.length} 字节）保存为板端 ${name}，同名文件将被覆盖。启动文件可能在下次开机执行。`
                : `将当前内容（${bytes.length} 字节）保存为板端 ${name}，同名文件将被覆盖。`,
            ok: startup ? '写入启动文件' : '保存', cancel: '取消',
        });
        if (!await confirm.open()) { return; }
        if (widget.isDisposed || control.getModel() !== model || model.isDisposed() || model.getVersionId() !== version) {
            await this.messages.info('编辑器内容已变化，请重试。');
            return;
        }
        if (!await this.deviceUnchanged(port, '保存到开发板')) { return; }
        const written = await this.device.saveFile(name, toBase64(bytes), startup);
        if (written === true) {
            await this.messages.info(`已保存到开发板 ${name}（默认存储）。`);
        }
    }

    /** Send any local file to the board's default storage (FILE_SAVE). */
    protected async sendFile(): Promise<void> {
        const port = this.device.state.port;
        const picked = await this.dialogs.showOpenDialog({
            title: '选择要发送到设备的文件（最多 2 MiB）', canSelectFiles: true,
            canSelectFolders: false, canSelectMany: false, openLabel: '发送文件',
        });
        const uri = Array.isArray(picked) ? picked[0] : picked;
        if (!uri) { return; }
        const name = uri.path.base;
        const content = await this.files.readFile(uri, { limits: { size: NODU_FILE_LIMIT } });
        const bytes = content.value.buffer;
        const startup = STARTUP_RE.test(name);
        // FILE_SAVE overwrites unconditionally; the user confirms that plus the
        // target (default storage, basename) before anything is sent.
        const confirm = new ConfirmDialog({
            title: '发送文件到设备',
            msg: startup
                ? `发送 ${name}（${bytes.length} 字节）到设备默认存储，同名文件将被覆盖。启动文件可能在下次开机执行。`
                : `发送 ${name}（${bytes.length} 字节）到设备默认存储，同名文件将被覆盖。`,
            ok: startup ? '写入启动文件' : '发送文件', cancel: '取消',
        });
        if (!await confirm.open()) { return; }
        if (!await this.deviceUnchanged(port, '发送文件')) { return; }
        const written = await this.device.saveFile(name, toBase64(bytes), startup);
        if (written === true) {
            await this.messages.info(`已写入 ${name}（默认存储）。`);
        }
    }
}
