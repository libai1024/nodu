// SPDX-License-Identifier: MIT
// Threshold editor command: snapshots a device frame or opens an image file,
// runs the same WASM threshold tooling as the vision panel, and writes the
// final tuple back only into an unchanged, valid selected tuple.
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { ConfirmDialog, DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import URI from '@theia/core/lib/common/uri';
import { ClipboardService } from '@theia/core/lib/browser/clipboard-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { EditorWidget } from '@theia/editor/lib/browser/editor-widget';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import * as monaco from '@theia/monaco-editor-core';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { DeviceFrame } from '../common/nodu-device-protocol';
import { NoduDeviceModel } from './nodu-device-client';
import { NoduImageToolState } from './nodu-image-state';
import { NoduImageTools } from './nodu-image-tools';
import { MAX_IMAGE_FILE_BYTES, orbInfo } from './nodu-imaging';
import { copyImageParameters } from './nodu-image-clipboard';
import { parseThresholdTuple, thresholdTargetDead, thresholdWritebackAllowed } from './nodu-threshold-edit';
import { NoduKeypointsDialog, OrbDoc } from './nodu-keypoints-editor';
import { NoduAprilTagDialog } from './nodu-apriltag-generator';
import { pickBinaryFile } from './nodu-vision-files';
import { BinaryBuffer } from '@theia/core/lib/common/buffer';
import { NETWORK_MODELS } from '../../resources/models/model-data';

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
    }
    return btoa(binary);
}

interface CapturedTarget {
    widget: EditorWidget;
    control: monaco.editor.IStandaloneCodeEditor;
    model: monaco.editor.ITextModel;
    version: number;
    range: monaco.IRange;
    text: string;
}

interface ToolDeps { files: FileService; dialogs: FileDialogService; clipboard: ClipboardService; }

export class NoduThresholdDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps,
        private readonly frame: DeviceFrame,
        readonly tools: NoduImageToolState,
        private readonly deps: ToolDeps) {
        super(props);
        this.node.classList.add('nodu-threshold-dialog');
        this.contentNode.classList.add('scope-widget');
        this.appendAcceptButton('完成');
    }

    get value(): undefined { return undefined; }

    protected render(): React.ReactNode {
        return <NoduImageTools frame={this.frame} tools={this.tools} files={this.deps.files} dialogs={this.deps.dialogs} clipboard={this.deps.clipboard} thresholdOnly />;
    }
}

@injectable()
export class NoduVisionToolsContribution implements CommandContribution, MenuContribution {
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(FileService) protected readonly files!: FileService;
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(ClipboardService) protected readonly clipboard!: ClipboardService;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(OpenerService) protected readonly opener!: OpenerService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'scope.threshold-editor', label: '阈值编辑器', category: '见微 Nodu' }, {
            execute: () => this.openThresholdEditor().catch(error => this.messages.error(`阈值编辑器：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.keypoints-editor', label: 'ORB 关键点编辑器', category: '见微 Nodu' }, {
            execute: () => this.openKeypointsEditor().catch(error => this.messages.error(`关键点编辑器：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.apriltag-generator', label: 'AprilTag 生成器', category: '见微 Nodu' }, {
            execute: () => this.openAprilTagGenerator().catch(error => this.messages.error(`AprilTag 生成器：${error instanceof Error ? error.message : String(error)}`)),
        });
        const searches: [string, string, string][] = [
            ['scope.qr-generator', '二维码生成器', 'https://www.google.com/search?q=qr+code+generator'],
            ['scope.datamatrix-generator', 'Data Matrix 生成器', 'https://www.google.com/search?q=data+matrix+generator'],
            ['scope.barcode-generator', '条码生成器', 'https://www.google.com/search?q=barcode+generator'],
        ];
        for (const [id, label, url] of searches) {
            registry.registerCommand({ id, label, category: '见微 Nodu' }, {
                execute: () => open(this.opener, new URI(url)).catch(error => this.messages.error(`${label}：${error instanceof Error ? error.message : String(error)}`)),
            });
        }
        registry.registerCommand({ id: 'scope.network-library', label: 'CNN 模型库', category: '见微 Nodu' }, {
            execute: () => this.networkLibrary().catch(error => this.messages.error(`CNN 模型库：${error instanceof Error ? error.message : String(error)}`)),
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const vision = [...MAIN_MENU_BAR, '5_scope', 'machine-vision'];
        menus.registerSubmenu(vision, '机器视觉');
        menus.registerMenuAction(vision, { commandId: 'scope.threshold-editor', order: '0' });
        menus.registerMenuAction(vision, { commandId: 'scope.keypoints-editor', order: '1' });
        menus.registerMenuAction(vision, { commandId: 'scope.apriltag-generator', order: '2' });
        menus.registerMenuAction(vision, { commandId: 'scope.qr-generator', order: '3' });
        menus.registerMenuAction(vision, { commandId: 'scope.datamatrix-generator', order: '4' });
        menus.registerMenuAction(vision, { commandId: 'scope.barcode-generator', order: '5' });
        menus.registerMenuAction(vision, { commandId: 'scope.network-library', order: '6' });
    }

    protected async openThresholdEditor(): Promise<void> {
        // Capture the editor target before any dialog can change focus/state.
        const widget = this.editors.currentEditor;
        const editor = widget ? MonacoEditor.get(widget) : undefined;
        const control = editor?.getControl();
        const model = control?.getModel();
        const selection = control?.getSelection();
        let captured: CapturedTarget | undefined;
        if (widget && editor && control && model && selection) {
            captured = {
                widget, control, model,
                version: model.getVersionId(),
                range: { startLineNumber: selection.startLineNumber, startColumn: selection.startColumn, endLineNumber: selection.endLineNumber, endColumn: selection.endColumn },
                text: model.getValueInRange(selection),
            };
        }
        const pick = await this.quickPick.show([
            { label: '帧缓冲', description: this.device.frame ? `当前设备帧 #${this.device.frame.sequence}` : '当前没有设备帧', id: 'frame' },
            { label: '图片文件', description: 'JPEG / PNG，不超过 8 MiB', id: 'file' },
        ] as { label: string; description: string; id: 'frame' | 'file' }[], { placeholder: '选择阈值分析的图像来源' });
        if (!pick) { return; }
        let frame: DeviceFrame | undefined;
        if (pick.id === 'frame') {
            // Snapshot: the dialog always analyzes this exact frame.
            frame = this.device.frame ? { ...this.device.frame } : undefined;
            if (!frame) {
                await this.messages.info('当前没有设备帧。请先连接设备并接收图像，或选择图片文件。');
                return;
            }
        } else {
            frame = await this.pickImageFile();
            if (!frame) { return; }
        }

        const tools = new NoduImageToolState();
        tools.mask = true;
        if (captured) {
            const parsed = parseThresholdTuple(captured.text);
            if (parsed?.length === 6) {
                tools.thresholdMode = 'lab';
                tools.threshold = parsed as [number, number, number, number, number, number];
            } else if (parsed?.length === 2) {
                tools.thresholdMode = 'gray';
                tools.grayThreshold = [parsed[0], parsed[1]];
            }
        }
        const dialog = new NoduThresholdDialog(Object.assign(new DialogProps(), { title: '阈值编辑器', maxWidth: 760 }), frame, tools, { files: this.files, dialogs: this.dialogs, clipboard: this.clipboard });
        await dialog.open();

        const bounds = tools.thresholdMode === 'lab' ? tools.threshold : tools.grayThreshold;
        const tuple = `(${bounds.join(', ')})`;
        if (!captured) {
            await this.offerCopy('没有可用的编辑器选区；文档未修改。', tuple);
            return;
        }
        if (thresholdTargetDead({
            widgetDisposed: captured.widget.isDisposed,
            modelDisposed: captured.model.isDisposed(),
            modelChanged: captured.control.getModel() !== captured.model,
        })) {
            await this.offerCopy('目标编辑器已关闭或文档已切换；文档未修改。', tuple);
            return;
        }
        if (!captured.text.trim() || !parseThresholdTuple(captured.text)) {
            await this.offerCopy('选中内容不是有效的阈值元组；文档未修改。', tuple);
            return;
        }
        const allowed = thresholdWritebackAllowed(
            { version: captured.version, rangeText: captured.text },
            {
                version: captured.model.getVersionId(),
                rangeText: captured.model.getValueInRange(captured.range),
                disposed: false,
                readOnly: captured.control.getOption(monaco.editor.EditorOption.readOnly),
            });
        if (!allowed) {
            await this.offerCopy('编辑器内容已变化或为只读；文档未修改。', tuple);
            return;
        }
        // Single undoable edit; the buffer itself is never saved implicitly.
        captured.control.pushUndoStop();
        const applied = captured.control.executeEdits('nodu.threshold-editor', [{ range: captured.range, text: tuple }]);
        captured.control.pushUndoStop();
        if (!applied) {
            await this.offerCopy('无法应用编辑器修改；文档未修改。', tuple);
        }
    }

    protected async offerCopy(reason: string, tuple: string): Promise<void> {
        const action = await this.messages.info(`${reason} 最终参数 ${tuple}`, '复制参数');
        if (action === '复制参数') {
            try {
                await copyImageParameters(this.clipboard, tuple);
            } catch (error) {
                await this.messages.error(`复制参数失败：${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    protected async openKeypointsEditor(): Promise<void> {
        const picked = await pickBinaryFile({ files: this.files, dialogs: this.dialogs }, {
            title: '打开 ORB 关键点文件', openLabel: '打开',
            filters: { 'ORB 关键点': ['orb'] }, maxBytes: 2 * 1024 * 1024, tooLarge: 'ORB 文件超过 2 MiB 上限。',
        });
        if (!picked) { return; }
        let doc: OrbDoc;
        try {
            doc = { bytes: picked.bytes, info: orbInfo(picked.bytes), name: picked.uri.path.base };
        } catch (error) {
            await this.messages.warn(`无法解析 ORB 文件：${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        const dialog = new NoduKeypointsDialog(
            Object.assign(new DialogProps(), { title: `ORB 关键点编辑器 — ${doc.name}`, maxWidth: 760 }),
            doc, { files: this.files, dialogs: this.dialogs });
        await dialog.open();
    }

    protected async openAprilTagGenerator(): Promise<void> {
        const dialog = new NoduAprilTagDialog(
            Object.assign(new DialogProps(), { title: 'AprilTag 生成器', maxWidth: 760 }),
            { files: this.files, dialogs: this.dialogs });
        await dialog.open();
    }

    /** Bundled OpenMV CMSIS-NN models: save locally or copy to the board. */
    protected async networkLibrary(): Promise<void> {
        const model = await this.quickPick.show(
            NETWORK_MODELS.map(entry => ({
                label: entry.label,
                description: `${entry.file} · ${entry.bytes} B · MIT · ${entry.repository}`,
                id: entry.id,
            })),
            { placeholder: '选择神经网络模型' },
        );
        if (!model) { return; }
        const entry = NETWORK_MODELS.find(item => item.id === model.id);
        if (!entry) { return; }
        const action = await this.quickPick.show([
            { label: '保存到本地…', id: 'local' },
            { label: '复制到设备默认存储…', id: 'device' },
        ] as { label: string; id: string }[], { placeholder: `${entry.label} · ${entry.bytes} 字节` });
        if (!action) { return; }
        await this.messages.warn('OpenMV CMSIS-NN 格式，不能在 K210 上执行。');
        const bytes = Uint8Array.from(atob(entry.dataBase64), char => char.charCodeAt(0));
        if (action.id === 'local') {
            const target = await this.dialogs.showSaveDialog({
                title: `保存 ${entry.label} 模型（不可覆盖已有文件）`,
                inputValue: entry.file, saveLabel: '保存',
            });
            if (!target) { return; }
            try {
                await this.files.createFile(target, BinaryBuffer.wrap(bytes), { overwrite: false });
            } catch (error) {
                await this.messages.error(`保存模型失败：${error instanceof Error ? error.message : String(error)}`);
                return;
            }
            await this.messages.info(`已保存 ${entry.file} 到本地。`);
            return;
        }
        // Nodu enhancement: the original IDE only offered a mounted-disk
        // copy; here the serial FILE_SAVE path writes the model to the
        // board's default storage after an explicit overwrite confirmation.
        if (!this.device.connected || this.device.busy || this.device.state.running
            || !this.device.state.capabilities.files) {
            await this.messages.info('请先连接设备并等待空闲，再复制模型到板端存储。');
            return;
        }
        const port = this.device.state.port;
        const confirm = new ConfirmDialog({
            title: '复制模型到设备',
            msg: `将 ${entry.file}（${entry.bytes} 字节）复制到设备默认存储，同名文件将被覆盖。`,
            ok: '复制到设备', cancel: '取消',
        });
        if (!await confirm.open()) { return; }
        if (!this.device.connected || this.device.busy || this.device.state.running
            || this.device.state.port !== port) {
            await this.messages.info('设备状态已变化，复制已取消；请重试。');
            return;
        }
        const written = await this.device.saveFile(entry.file, toBase64(bytes), false);
        if (written === true) {
            await this.messages.info(`已复制 ${entry.file} 到设备默认存储。`);
        }
    }

    protected async pickImageFile(): Promise<DeviceFrame | undefined> {
        const uri = await this.dialogs.showOpenDialog({
            title: '选择图像文件', canSelectFiles: true, canSelectFolders: false,
            canSelectMany: false, openLabel: '选择图像',
            filters: { '图像 (JPEG/PNG)': ['jpg', 'jpeg', 'png'] },
        });
        const picked = Array.isArray(uri) ? uri[0] : uri;
        if (!picked) { return undefined; }
        const stat = await this.files.resolve(picked);
        if (stat.size !== undefined && stat.size > MAX_IMAGE_FILE_BYTES) {
            await this.messages.warn('图像文件超过 8 MiB 上限。');
            return undefined;
        }
        const content = await this.files.readFile(picked, { limits: { size: MAX_IMAGE_FILE_BYTES } });
        const bytes = content.value.buffer;
        if (bytes.length > MAX_IMAGE_FILE_BYTES) {
            await this.messages.warn('图像文件超过 8 MiB 上限。');
            return undefined;
        }
        const mime = picked.path.base.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        // Dimensions are not known until decode; the image tools enforce the
        // pixel cap on the decoded raster.
        return { mime, data: toBase64(bytes), width: 0, height: 0, sequence: 0, time: Date.now() };
    }
}
