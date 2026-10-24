// SPDX-License-Identifier: MIT
// Desktop start-up like PyCharm / IntelliJ: a small launcher window instead of an empty
// workbench. A project path on the command line (or a second launch with one) opens that
// project directly; closing the last project window brings the launcher back.
import { existsSync, promises as fs, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, Event as ElectronEvent, WebContents } from '@theia/core/electron-shared/electron';
import { injectable } from '@theia/core/shared/inversify';
import { MaybePromise } from '@theia/core/lib/common/types';
import { isOSX } from '@theia/core/lib/common/os';
import { DEFAULT_WINDOW_HASH } from '@theia/core/lib/common/window';
import { ElectronMainApplication, ElectronMainCommandOptions } from '@theia/core/lib/electron-main/electron-main-application';
import { TheiaBrowserWindowOptions } from '@theia/core/lib/electron-main/theia-electron-window';
import { FrontendApplicationConfig } from '@theia/application-package/lib/application-props';
import { NODU_LAUNCHER_QUERY, NODU_REOPEN_LAST_PREF, NoduLauncherMain } from '../common/nodu-launcher-protocol';
import { parseJsonc, pathKey, projectFromWindowUrl } from '../common/nodu-launcher-util';

const LAUNCHER_SIZE = { width: 960, height: 680 };
/** Keep the launcher available if opening a project fails or stalls. */
const SHOW_TIMEOUT = 20000;
type LaunchArgs = ElectronMainCommandOptions['launchArgs'];

function whenShown(window: BrowserWindow): Promise<void> {
    if (window.isDestroyed()) { return Promise.reject(new Error('项目窗口已关闭。')); }
    if (window.isVisible()) { return Promise.resolve(); }
    return new Promise((done, reject) => {
        const cleanup = (): void => {
            clearTimeout(timer);
            window.removeListener('show', finish); window.removeListener('closed', failed);
        };
        const finish = (): void => { cleanup(); done(); };
        const failed = (): void => { cleanup(); reject(new Error('项目窗口未能打开。')); };
        const timer = setTimeout(failed, SHOW_TIMEOUT);
        window.once('show', finish);
        window.once('closed', failed);
    });
}

function realpathOr(fsPath: string): string {
    try { return realpathSync(fsPath); } catch { return fsPath; }
}

@injectable()
export class NoduElectronMainApplication extends ElectronMainApplication implements NoduLauncherMain {
    protected override getDefaultOptions(): TheiaBrowserWindowOptions {
        const options = super.getDefaultOptions();
        return isOSX ? { ...options, titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 10 } } : options;
    }

    /** webContents ids of open launcher windows. */
    protected readonly launcherIds = new Set<number>();
    protected readonly launcherWindows = new WeakSet<BrowserWindow>();
    protected lastClosedWasLauncher = false;
    protected quitting = false;
    /** The project of a window being restarted (undefined: it was the launcher). */
    protected restartTarget?: string;

    override async start(config: FrontendApplicationConfig): Promise<void> {
        app.on('before-quit', () => { this.quitting = true; });
        if (!process.env.NODU_PROJECTS_DIR) {
            // Inherited by the backend; Documents follows the user's folder redirection.
            try { process.env.NODU_PROJECTS_DIR = join(app.getPath('documents'), 'Nodu'); } catch { /* backend falls back to ~/Documents/Nodu */ }
        }
        return super.start(config);
    }

    /** Theia shows a workbench window before the backend is up; the launcher decides what opens. */
    protected override showInitialWindow(urlToOpen: string | undefined): void {
        if (urlToOpen) { super.showInitialWindow(urlToOpen); }
    }

    protected override async handleMainCommand(options: ElectronMainCommandOptions): Promise<void> {
        if (options.claimed) { return super.handleMainCommand(options); }
        if (this.restarting) {
            const target = this.restartTarget;
            this.restartTarget = undefined;
            return target ? this.openProjectWindow(target) : this.showLauncher();
        }
        const project = options.file ? await this.projectFolder(resolve(options.cwd, options.file)) : undefined;
        if (project) { return this.openProjectWindow(project, { launchArgs: options.launchArgs }); }
        if (options.file) { console.error(`Nodu: not a project folder: ${options.file}`); }
        const last = !options.secondInstance && this.reopenLastEnabled() ? this.lastProject() : undefined;
        return last ? this.openProjectWindow(last, { launchArgs: options.launchArgs }) : this.showLauncher();
    }

    override async restart(webContents: WebContents): Promise<void> {
        this.restartTarget = this.launcherIds.has(webContents.id) ? undefined : projectFromWindowUrl(webContents.getURL(), NODU_LAUNCHER_QUERY);
        return super.restart(webContents);
    }

    override async createWindow(asyncOptions?: MaybePromise<TheiaBrowserWindowOptions>): Promise<BrowserWindow> {
        const window = await super.createWindow(asyncOptions);
        const id = window.webContents.id;
        window.once('closed', () => { this.lastClosedWasLauncher = this.launcherIds.delete(id); });
        return window;
    }

    /** Closing the last project returns to the launcher; closing the launcher quits. */
    protected override onWindowAllClosed(event: ElectronEvent): void {
        if (!this.restarting && !this.quitting && !this.lastClosedWasLauncher) {
            void this.showLauncher().catch(error => { console.error('Nodu: launcher failed', error); this.requestStop(); });
            return;
        }
        super.onWindowAllClosed(event);
    }

    /** The launcher's small size must not become the next project window's size. */
    protected override saveWindowState(electronWindow: BrowserWindow): void {
        if (electronWindow && this.launcherWindows.has(electronWindow)) { return; }
        super.saveWindowState(electronWindow);
    }

    async openProject(fsPath: string, options: { keepLauncher?: boolean } = {}): Promise<void> {
        const project = await this.projectFolder(fsPath);
        if (!project) { throw new Error('项目文件夹不存在。'); }
        return this.openProjectWindow(project, { keepLauncher: !!options.keepLauncher });
    }

    private pendingLauncher?: Promise<BrowserWindow>;

    async showLauncher(): Promise<void> {
        let launcher = this.firstLauncher();
        if (!launcher) {
            const pending = this.pendingLauncher ??= this.createLauncherWindow();
            try { launcher = await pending; } finally { if (this.pendingLauncher === pending) { this.pendingLauncher = undefined; } }
        }
        this.reveal(launcher);
    }

    protected async openProjectWindow(project: string, options: { keepLauncher?: boolean; launchArgs?: LaunchArgs } = {}): Promise<void> {
        let window = this.projectWindow(project);
        if (window) { this.reveal(window); } else { window = await this.openWindowWithWorkspace(project, options.launchArgs); }
        if (!options.keepLauncher && this.launcherIds.size) {
            await whenShown(window);
            for (const id of [...this.launcherIds]) { this.closeWindowById(id); }
        }
    }

    protected async createLauncherWindow(): Promise<BrowserWindow> {
        const { workArea } = this.getDisplayForNewWindow();
        // The welcome window has its own fixed geometry. On small displays fit it to
        // the available desktop without inheriting a maximized project's dimensions.
        const width = Math.min(LAUNCHER_SIZE.width, workArea.width);
        const height = Math.min(LAUNCHER_SIZE.height, workArea.height);
        const options: TheiaBrowserWindowOptions = {
            ...this.getDefaultTheiaWindowOptions(),
            width, height, minWidth: width, minHeight: height, maxWidth: width, maxHeight: height,
            resizable: false, frame: true, title: 'Nodu',
            titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 14 },
            x: Math.round(workArea.x + (workArea.width - width) / 2),
            y: Math.round(workArea.y + (workArea.height - height) / 2),
            isMaximized: false, isFullScreen: false, maximizable: false, fullscreenable: false,
        };
        const [uri, window] = await Promise.all([this.createWindowUri({ [NODU_LAUNCHER_QUERY]: '1' }), this.createWindow(options)]);
        this.launcherIds.add(window.webContents.id);
        this.launcherWindows.add(window);
        // `#!empty`: the launcher never loads (or records) a workspace.
        try { await window.loadURL(uri.withFragment(DEFAULT_WINDOW_HASH).toString(true)); }
        catch (error) { if (!window.isDestroyed()) { window.destroy(); } throw error; }
        return window;
    }

    protected firstLauncher(): BrowserWindow | undefined {
        for (const id of this.launcherIds) {
            const window = this.windows.get(id)?.window;
            if (window && !window.isDestroyed()) { return window; }
        }
        return undefined;
    }

    protected projectWindow(project: string): BrowserWindow | undefined {
        const key = pathKey(project);
        for (const [id, wrapper] of this.windows) {
            const window = wrapper.window;
            if (this.launcherIds.has(id) || window.isDestroyed()) { continue; }
            const open = projectFromWindowUrl(window.webContents.getURL(), NODU_LAUNCHER_QUERY);
            if (open && (pathKey(open) === key || pathKey(realpathOr(open)) === key)) { return window; }
        }
        return undefined;
    }

    protected reveal(window: BrowserWindow): void {
        if (window.isMinimized()) { window.restore(); }
        window.show();
        window.focus();
    }

    protected async projectFolder(fsPath: unknown): Promise<string | undefined> {
        if (typeof fsPath !== 'string' || !isAbsolute(fsPath)) { return undefined; }
        const real = await fs.realpath(fsPath).catch(() => undefined);
        return real && (await fs.stat(real).catch(() => undefined))?.isDirectory() ? real : undefined;
    }

    protected configDir(): string { return process.env.THEIA_CONFIG_DIR || join(homedir(), '.theia'); }

    /** Off by default: the launcher shows unless the user turned the setting on. */
    protected reopenLastEnabled(): boolean {
        try {
            const settings = parseJsonc(readFileSync(join(this.configDir(), 'settings.json'), 'utf8')) as Record<string, unknown> | null;
            return settings?.[NODU_REOPEN_LAST_PREF] === true;
        } catch { return false; }
    }

    /** The project Theia recorded last (recentworkspace.json, written when a project window opens or closes). */
    protected lastProject(): string | undefined {
        try {
            const data = parseJsonc(readFileSync(join(this.configDir(), 'recentworkspace.json'), 'utf8')) as { recentRoots?: unknown[] } | null;
            const first = data?.recentRoots?.[0];
            const path = typeof first === 'string' && first.startsWith('file:') ? fileURLToPath(first) : undefined;
            return path && existsSync(path) && statSync(path).isDirectory() ? path : undefined;
        } catch { return undefined; }
    }
}
