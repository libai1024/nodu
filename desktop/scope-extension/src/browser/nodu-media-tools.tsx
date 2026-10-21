// SPDX-License-Identifier: MIT
// Video tools: record the framebuffer to an OpenMV ImageWriter .bin stream,
// transcode recordings/videos with the bundled ffmpeg, and play them back
// with the bundled ffplay. Recording starts at once into a temp .bin on the
// device worker; on stop the user picks where to save it (MP4 by default).
// Conversion/playback run on a separate media sidecar, never the serial port.
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, MenuContribution, MenuModelRegistry, MAIN_MENU_BAR, URI } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { QuickPickService } from '@theia/core/lib/common/quick-pick-service';
import { ProgressService } from '@theia/core/lib/common/progress-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileStat } from '@theia/filesystem/lib/common/files';
import { WorkspaceService } from '@theia/workspace/lib/browser/workspace-service';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { NoduDeviceModel } from './nodu-device-client';
import { TOOLS_MENU_GROUPS } from '../common/nodu-tools-menu';

const VIDEO_INPUT_EXT = /\.(mp4|avi|mjpeg|bin)$/i;

@injectable()
export class NoduMediaToolsContribution implements CommandContribution, MenuContribution {
    @inject(FileDialogService) protected readonly dialogs!: FileDialogService;
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(QuickPickService) protected readonly quickPick!: QuickPickService;
    @inject(ProgressService) protected readonly progress!: ProgressService;
    @inject(NoduDeviceModel) protected readonly device!: NoduDeviceModel;
    @inject(FileService) protected readonly files!: FileService;
    @inject(WorkspaceService) protected readonly workspace!: WorkspaceService;
    @inject(EnvVariablesServer) protected readonly env!: EnvVariablesServer;

    /** True while a convert/play job is in flight; backs the cancel command. */
    private mediaJob = false;

    private get recording(): boolean { return this.device.state.recording?.active === true; }
    private get canRecord(): boolean {
        return this.device.connected && !this.device.busy
            && this.device.state.capabilities.framebuffer === true
            && this.device.state.preview === true && !this.recording;
    }
    /** One convert/play job at a time; the camera and recording keep running meanwhile. */
    private get mediaIdle(): boolean { return !this.mediaJob; }

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'scope.start-recording', label: '开始录制', category: '见微 Nodu' }, {
            execute: () => this.startRecording().catch(error => this.messages.error(`开始录制：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.canRecord,
        });
        registry.registerCommand({ id: 'scope.stop-recording', label: '结束录制并保存…', category: '见微 Nodu' }, {
            execute: () => this.stopRecording().catch(error => this.messages.error(`结束录制：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.recording && !this.device.busy,
        });
        registry.registerCommand({ id: 'scope.convert-video', label: '转换视频文件', category: '见微 Nodu' }, {
            execute: () => this.convertVideo().catch(error => this.messages.error(`转换视频：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.mediaIdle,
        });
        registry.registerCommand({ id: 'scope.play-video', label: '播放视频文件', category: '见微 Nodu' }, {
            execute: () => this.playVideo().catch(error => this.messages.error(`播放视频：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.mediaIdle,
        });
        // Cancelling only applies to a media job in flight — recordings are
        // finalized with the dedicated 结束录制 command, never cancelled away.
        registry.registerCommand({ id: 'scope.cancel-media', label: '取消视频任务', category: '见微 Nodu' }, {
            execute: () => this.device.cancelMedia().catch(error => this.messages.error(`取消视频任务：${error instanceof Error ? error.message : String(error)}`)),
            isEnabled: () => this.mediaJob,
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        const video = [...MAIN_MENU_BAR, '5_scope', TOOLS_MENU_GROUPS.toolsGroup, TOOLS_MENU_GROUPS.videoSubmenu];
        menus.registerSubmenu(video, '视频工具', { sortString: '2' });
        menus.registerMenuAction(video, { commandId: 'scope.convert-video', order: 'a0' });
        menus.registerMenuAction(video, { commandId: 'scope.play-video', order: 'a1' });
        const extras = [...video, 'z_extras'];
        menus.registerMenuAction(extras, { commandId: 'scope.start-recording', order: '0' });
        menus.registerMenuAction(extras, { commandId: 'scope.stop-recording', order: '1' });
        menus.registerMenuAction(extras, { commandId: 'scope.cancel-media', order: '2' });
    }

    /** Append the extension to a picked path instead of treating it as a directory. */
    private static withExtension(uri: URI, ext: string): URI {
        const suffix = `.${ext}`;
        return uri.path.base.toLowerCase().endsWith(suffix)
            ? uri
            : uri.withPath(uri.path.toString() + suffix);
    }

    /** Run a convert/play job under a cancellable progress notification. */
    private async runMediaJob<T>(label: string, task: () => Promise<T>): Promise<T | undefined> {
        this.mediaJob = true;
        try {
            return await this.progress.withProgress(`${label}…`, 'notification', task, () => {
                if (this.mediaJob) { void this.device.cancelMedia(); }
            });
        } finally {
            this.mediaJob = false;
        }
    }

    /** Save dialogs open in the project folder, else the home folder — never the filesystem root. */
    private async defaultFolder(): Promise<FileStat | undefined> {
        const root = this.workspace.tryGetRoots()[0];
        if (root) { return root; }
        try { return await this.files.resolve(new URI(await this.env.getHomeDirUri())); } catch { return undefined; }
    }

    /** Start at once, like MaixPy IDE: frames go to a temp .bin until 结束录制. */
    protected async startRecording(): Promise<void> {
        await this.device.startRecording();
    }

    /** Finalize, then save as MP4 (default) or keep the raw OpenMV .bin. */
    protected async stopRecording(): Promise<void> {
        const status = await this.device.stopRecording();
        if (!status) { return; }
        const raw = FileUri.create(status.path);
        const seconds = (status.elapsedMs / 1000).toFixed(1);
        const now = new Date(), two = (n: number): string => String(n).padStart(2, '0');
        const name = `nodu-${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
        const picked = await this.dialogs.showSaveDialog({
            title: `保存录像（${status.frames} 帧，${seconds} 秒）`,
            saveLabel: '保存',
            filters: { 'MPEG-4 视频': ['mp4'], 'OpenMV 原始录像': ['bin'] },
            inputValue: `${name}.mp4`,
        }, await this.defaultFolder());
        if (!picked) {
            await this.messages.info(`录像未另存；原始录像保留在 ${status.path}。`);
            return;
        }
        const target = /\.bin$/i.test(picked.path.base) ? picked : NoduMediaToolsContribution.withExtension(picked, 'mp4');
        if (target.path.ext.toLowerCase() === '.bin') {
            // The dialog already confirmed any overwrite; a failed move leaves the raw file in place.
            try { await this.files.move(raw, target, { overwrite: true }); } catch (error) {
                await this.messages.warn(`无法写入 ${target.path.fsPath()}（${error instanceof Error ? error.message : String(error)}）；原始录像保留在 ${status.path}。`);
                return;
            }
            this.device.note(`录像已保存到 ${target.path.fsPath()}`);
            return;
        }
        // ffmpeg never overwrites: encode next to the raw stream, then move into place.
        const encoded = raw.parent.resolve(`${raw.path.name}.mp4`);
        const ok = await this.runMediaJob('正在保存 MP4', () => this.device.convertVideo(raw.toString(), encoded.toString()));
        if (ok !== true) {
            await this.messages.warn(`MP4 转换未完成；原始录像保留在 ${status.path}。`);
            return;
        }
        try {
            await this.files.move(encoded, target, { overwrite: true });
        } catch (error) {
            await this.messages.warn(`无法写入 ${target.path.fsPath()}（${error instanceof Error ? error.message : String(error)}）；MP4 保留在 ${encoded.path.fsPath()}。`);
            return;
        }
        await this.files.delete(raw).catch(() => undefined);
        this.device.note(`录像已保存到 ${target.path.fsPath()}`);
    }

    /** Convert any supported video or .bin stream; output must not exist. */
    protected async convertVideo(): Promise<void> {
        const picked = await this.dialogs.showOpenDialog({
            title: '选择要转换的视频（.bin / .mp4 / .avi / .mjpeg）',
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: '转换',
            filters: { '视频或录像流': ['bin', 'mp4', 'avi', 'mjpeg'] },
        });
        const input = Array.isArray(picked) ? picked[0] : picked;
        if (!input || !VIDEO_INPUT_EXT.test(input.path.base)) { return; }
        const format = await this.quickPick.show([
            { label: 'MP4（MPEG-4）', id: 'mp4' },
            { label: 'AVI（MPEG-4）', id: 'avi' },
            { label: 'MJPEG 流', id: 'mjpeg' },
        ] as { label: string; id: string }[], { placeholder: '选择输出格式' });
        if (!format) { return; }
        const target = await this.dialogs.showSaveDialog({
            title: `转换为 ${format.label}（输出文件不可已存在）`,
            saveLabel: '转换',
            inputValue: `${input.path.name}.${format.id}`,
        });
        if (!target) { return; }
        const uri = NoduMediaToolsContribution.withExtension(target, format.id);
        const ok = await this.runMediaJob('正在转换视频', () => this.device.convertVideo(input.toString(), uri.toString()));
        if (ok === true) { await this.messages.info(`已转换到 ${uri.path.base}。`); }
    }

    /** Play a video or .bin stream with the bundled ffplay. */
    protected async playVideo(): Promise<void> {
        const picked = await this.dialogs.showOpenDialog({
            title: '选择要播放的视频（.bin 会先转换为临时 MP4）',
            canSelectFiles: true, canSelectFolders: false, canSelectMany: false,
            openLabel: '播放',
            filters: { '视频或录像流': ['bin', 'mp4', 'avi', 'mjpeg'] },
        });
        const input = Array.isArray(picked) ? picked[0] : picked;
        if (!input || !VIDEO_INPUT_EXT.test(input.path.base)) { return; }
        const confirm = new ConfirmDialog({
            title: '播放视频',
            msg: `将使用内置播放器打开 ${input.path.base}。`,
            ok: '播放', cancel: '取消',
        });
        if (!await confirm.open()) { return; }
        await this.runMediaJob('正在播放视频', () => this.device.playVideo(input.toString()));
    }
}
