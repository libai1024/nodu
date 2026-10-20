// SPDX-License-Identifier: MIT
// Startup update flow (original OpenMV IDE parity): optional version check
// opens the download page; optional resource check installs a package with
// cancellable download progress, an install phase, then a restart prompt.
// Everything is off unless `nodu.update.enabled` and the URLs are set.
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { DisposableCollection, URI } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceSchema } from '@theia/core/lib/common/preferences/preference-schema';
import { Progress } from '@theia/core/lib/common/message-service-protocol';
import { ProgressService } from '@theia/core/lib/common/progress-service';
import { FrontendApplicationContribution } from '@theia/core/lib/browser';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import { ConfirmDialog } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { environment } from '@theia/application-package/lib/environment';
import { NoduResources } from './nodu-resources-client';

export const NODU_UPDATE_SCHEMA: PreferenceSchema = {
    title: 'Nodu 更新',
    properties: {
        'nodu.update.enabled': {
            type: 'boolean', default: false,
            description: '启动时检查 Nodu 版本与资源更新。',
        },
        'nodu.update.versionUrl': {
            type: 'string', default: '',
            description: 'Nodu 最新版本号地址（响应正文为 x.y.z）。',
        },
        'nodu.update.downloadPageUrl': {
            type: 'string', default: '',
            description: '有新版本时打开的下载页面。',
        },
        'nodu.update.resourcesVersionUrl': {
            type: 'string', default: '',
            description: '资源包最新版本号地址（响应正文为 x.y.z）。',
        },
        'nodu.update.resourcesUrlTemplate': {
            type: 'string', default: '',
            description: '资源包下载地址模板；%1 %2 %3 分别替换为主/次/修订版本号。',
        },
        'nodu.update.requireSha256': {
            type: 'boolean', default: true,
            description: '下载资源包时校验同名的 .sha256 校验和文件。',
        },
    },
};

const fmtBytes = (n: number): string =>
    n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;

/** Modal single-button message box, the original `包更新` dialog. */
class UpdateMessageDialog extends ReactDialog<void> {
    constructor(props: DialogProps, private readonly text: string) {
        super(props);
        this.appendAcceptButton('确定');
    }
    get value(): void { return undefined; }
    protected render(): React.ReactNode {
        return <p>{this.text}</p>;
    }
}

@injectable()
export class NoduUpdateContribution implements FrontendApplicationContribution {
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(NoduResources) protected readonly resources!: NoduResources;
    @inject(OpenerService) protected readonly opener!: OpenerService;
    @inject(ProgressService) protected readonly progressService!: ProgressService;

    onStart(): void {
        // Non-blocking: checks run after startup; failures only log.
        void this.checkUpdates().catch(error => console.error('nodu update check failed', error));
    }

    private pref<T>(key: string, fallback: T): T {
        return this.preferences.get<T>(key, fallback) ?? fallback;
    }

    private async checkUpdates(): Promise<void> {
        if (!this.pref('nodu.update.enabled', false)) { return; }
        const versionUrl = this.pref('nodu.update.versionUrl', '');
        const downloadPage = this.pref('nodu.update.downloadPageUrl', '');
        const resourcesVersionUrl = this.pref('nodu.update.resourcesVersionUrl', '');
        const resourcesTemplate = this.pref('nodu.update.resourcesUrlTemplate', '');
        if (versionUrl && downloadPage) { void this.checkIde(versionUrl, downloadPage); }
        if (resourcesVersionUrl && resourcesTemplate) { void this.checkResources(resourcesVersionUrl, resourcesTemplate); }
    }

    private async checkIde(versionUrl: string, downloadPage: string): Promise<void> {
        try {
            const result = await this.resources.checkVersion(versionUrl);
            if (!result.newer) { return; }
            const confirmed = await new ConfirmDialog({
                title: '有可用更新',
                msg: `Nodu 新版本 (${result.latest}) 可供下载。`,
                ok: '下载',
                cancel: '取消',
            }).open();
            if (confirmed === true) {
                await open(this.opener, new URI(downloadPage));
            }
        } catch (error) {
            console.error('nodu version check failed', error);
        }
    }

    private async checkResources(versionUrl: string, template: string): Promise<void> {
        try {
            const result = await this.resources.checkResources(versionUrl);
            if (!result.newer) { return; }
            const confirmed = await new ConfirmDialog({
                title: '有可用更新',
                msg: '有新的 Nodu 资源可用（例如示例、固件、文档等）。',
                ok: '安装',
                cancel: '取消',
            }).open();
            if (confirmed === true) {
                // The archive URL is what the original %1 error text quotes.
                const [major = '0', minor = '0', patch = '0'] = result.latest.split('.');
                const archiveUrl = template.replace('%1', major).replace('%2', minor).replace('%3', patch);
                await this.installResources(template, result.latest, archiveUrl);
            }
        } catch (error) {
            console.error('nodu resources check failed', error);
        }
    }

    /** Original wording: 网络请求失败“%1” / 无法打开资源文件“%1” / 错误：%1！ */
    private installErrorText(error: unknown, url: string): string | undefined {
        const message = error instanceof Error ? error.message : String(error);
        if (message === 'cancelled') { return undefined; }
        if (/network request failed/i.test(message)) {
            return `网络请求失败“${url}”`;
        }
        if (/archive|checksum|sha256|unsafe path|not a regular file|symlink/i.test(message)) {
            return `无法打开资源文件“${url}”`;
        }
        return message.replace(/[！!。.\s]+$/, '');
    }

    private async installResources(template: string, version: string, urlForErrors: string): Promise<void> {
        const requireSha256 = this.pref('nodu.update.requireSha256', true);
        const disposables = new DisposableCollection();
        // Kept as a promise: a fast install can finish before showProgress
        // resolves, so the handle must be awaited for cleanup either way.
        let installing: Promise<Progress> | undefined;
        const dismiss = (): void => {
            if (installing) { void installing.then(progress => progress.cancel()); }
        };
        let phase: 'downloading' | 'installing' = 'downloading';
        const download = await this.progressService.showProgress(
            { text: '正在下载…', options: { cancelable: true, location: 'notification' } },
            () => {
                // Cancellation is only meaningful while the sidecar still
                // polls stdin; afterwards closing it is a harmless no-op.
                void this.resources.cancelInstall();
            });
        disposables.push(this.resources.onDidInstallProgress(progress => {
            download.report({
                message: progress.total ? `${fmtBytes(progress.downloaded)} / ${fmtBytes(progress.total)}` : fmtBytes(progress.downloaded),
                ...(progress.total ? { work: { done: progress.downloaded, total: progress.total } } : {}),
            });
        }));
        disposables.push(this.resources.onDidInstallPhase(next => {
            if (next === 'installing' && phase === 'downloading') {
                phase = 'installing';
                download.cancel();
                installing = this.progressService.showProgress(
                    { text: '正在安装…', options: { cancelable: false, location: 'notification' } });
            }
        }));
        try {
            await this.resources.installResources(template, version, requireSha256);
            download.cancel();
            dismiss();
            await this.restartPrompt();
        } catch (error) {
            download.cancel();
            dismiss();
            const text = this.installErrorText(error, urlForErrors);
            if (text !== undefined) {
                await new UpdateMessageDialog({ title: '包更新' }, `错误：${text}！`).open();
            }
        } finally {
            disposables.dispose();
        }
    }

    /** Theia ships an Electron relaunch path (preload `restart()` →
     *  CHANNEL_RESTART → ElectronMainApplication.restart); in the browser
     *  build only the message is shown. */
    private async restartPrompt(): Promise<void> {
        const electronTheiaCore = environment.electron.is() && typeof window !== 'undefined'
            ? (window as unknown as { electronTheiaCore?: { restart?: () => void } }).electronTheiaCore
            : undefined;
        if (typeof electronTheiaCore?.restart === 'function') {
            const choice = await new ConfirmDialog({
                title: '包更新',
                msg: '安装成功！请重启 Nodu。',
                ok: '立即重启',
                cancel: '稍后',
            }).open();
            if (choice === true) { electronTheiaCore.restart(); }
            return;
        }
        await new UpdateMessageDialog({ title: '包更新' }, '安装成功！请重启 Nodu。').open();
    }
}
