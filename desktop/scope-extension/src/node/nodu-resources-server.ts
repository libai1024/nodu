// SPDX-License-Identifier: MIT
// Backend service for the `nodu-resources` sidecar: startup resource reset
// (forced / stale / missing), remote version checks and the cancellable
// resource install with progress pushed to the frontend.
import { injectable } from '@theia/core/shared/inversify';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { BackendApplicationContribution } from '@theia/core/lib/node/backend-application';
import { InstallPhase, InstallProgress, NoduResourcesService, ResourcesClient, ResourcesReady, VersionCheck } from '../common/nodu-resources-protocol';
import { createRequire } from 'module';

const MAX_LINE = 2 * 1024 * 1024;
const VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** Compare `a` to `b` as x.y.z tuples; -1/0/1. */
function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i]) { return pa[i] < pb[i] ? -1 : 1; }
    }
    return 0;
}

@injectable()
export class NoduResourcesServer implements NoduResourcesService, BackendApplicationContribution {
    private readonly clients = new Set<ResourcesClient>();
    private readyPromise?: Promise<ResourcesReady>;
    private installer?: ChildProcessWithoutNullStreams;

    addClient(client: ResourcesClient): () => void {
        this.clients.add(client);
        return () => { this.clients.delete(client); };
    }
    private publish<K extends keyof ResourcesClient>(method: K, value: Parameters<ResourcesClient[K]>[0]): void {
        for (const client of this.clients) {
            try {
                Promise.resolve((client[method] as (arg: typeof value) => unknown)(value))
                    .catch(() => this.clients.delete(client));
            } catch { this.clients.delete(client); }
        }
    }

    /** Startup resource init runs once; `ready()` shares the same promise. */
    initialize(): void {
        void this.ready().catch(error => console.error('nodu-resources: init failed', error));
    }
    ready(): Promise<ResourcesReady> {
        return this.readyPromise ??= this.initResources();
    }
    onStop(): void {
        this.installer?.kill();
    }

    private extensionDir(): string {
        return dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'));
    }
    private resourcesBinary(): string {
        if (process.env.NODU_RESOURCES_BIN) { return process.env.NODU_RESOURCES_BIN; }
        const exe = process.platform === 'win32' ? 'nodu-resources.exe' : 'nodu-resources';
        const packaged = join(this.extensionDir(), 'resources', 'bin', `${process.platform}-${process.arch}`, exe);
        if (existsSync(packaged)) { return packaged; }
        return join(this.extensionDir(), '..', 'native', 'target', 'release', exe);
    }
    private bundledDir(): string {
        return process.env.NODU_RESOURCES_BUNDLED || join(this.extensionDir(), 'resources', 'nodu-resources');
    }
    /** `~/.nodu` — overridable for tests so no real user dir is touched. */
    private noduHome(): string {
        return process.env.NODU_RESOURCES_HOME || join(homedir(), '.nodu');
    }
    private resourcesDir(): string { return join(this.noduHome(), 'resources'); }
    private versionFile(): string { return join(this.noduHome(), 'resources-version.json'); }
    private appVersion(): string {
        const pkg = createRequire(__filename).resolve('@scope/studio-extension/package.json');
        const parsed: unknown = JSON.parse(readFileSync(pkg, 'utf8'));
        const version = (parsed as { version?: unknown }).version;
        if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) { return '0.0.0'; }
        return version;
    }
    /** Recorded resource version, or undefined when missing/malformed. */
    private recordedVersion(): string | undefined {
        try {
            const parsed: unknown = JSON.parse(readFileSync(this.versionFile(), 'utf8'));
            const record = parsed as { major?: unknown; minor?: unknown; patch?: unknown };
            if ([record.major, record.minor, record.patch].every(n => typeof n === 'number' && Number.isInteger(n) && n >= 0)) {
                return `${record.major}.${record.minor}.${record.patch}`;
            }
        } catch { /* missing/corrupt counts as uninstalled */ }
        return undefined;
    }

    /**
     * Original initResources: reset the user resource dir when the launcher
     * forced it (-update_resources), when no version was recorded, or when
     * the recorded version is older than the app. A reset failure falls back
     * to the bundled examples rather than losing the menu.
     */
    private async initResources(): Promise<ResourcesReady> {
        const bundledExamples = join(this.bundledDir(), 'examples');
        const userExamples = join(this.resourcesDir(), 'examples');
        try {
            const recorded = this.recordedVersion();
            const forced = process.env.NODU_UPDATE_RESOURCES === '1';
            const stale = !recorded || compareVersions(recorded, this.appVersion()) < 0;
            if (forced || stale) {
                mkdirSync(this.noduHome(), { recursive: true });
                await this.runSidecar([
                    'reset',
                    '--bundled', this.bundledDir(),
                    '--dest', this.resourcesDir(),
                    '--version', this.appVersion(),
                    '--version-file', this.versionFile(),
                ]);
            }
        } catch (error) {
            console.error('nodu-resources: startup reset failed; using bundled examples', error);
            return { examplesDir: bundledExamples };
        }
        return { examplesDir: existsSync(userExamples) ? userExamples : bundledExamples };
    }

    private validateUrl(url: unknown, what: string): asserts url is string {
        if (typeof url !== 'string' || !url || url.length > 2048 || url.includes('\0')) {
            throw new Error(`${what}须为不超过 2048 字节的 URL。`);
        }
    }
    private validateVersion(version: unknown): asserts version is string {
        if (typeof version !== 'string' || !VERSION_SHAPE.test(version)) {
            throw new Error('版本号须为 x.y.z 形式。');
        }
    }

    /** Spawn the sidecar and collect its final JSON line; no streaming. */
    private runSidecar(args: string[]): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            let child: ChildProcessWithoutNullStreams;
            try {
                child = spawn(this.resourcesBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            let last: Record<string, unknown> | undefined;
            let stderr = '';
            child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
            const reader = createInterface({ input: child.stdout });
            reader.on('line', line => {
                if (line.length > MAX_LINE) { return; }
                try { last = JSON.parse(line) as Record<string, unknown>; } catch { /* progress/non-json ignored */ }
            });
            child.on('error', error => {
                reader.close();
                reject(new Error(`资源服务启动失败：${error.message}。开发者请运行 npm run build:native。`));
            });
            child.on('exit', code => {
                reader.close();
                if (code === 0 && last && 'result' in last) { resolve(last); return; }
                const detail = typeof last?.error === 'string' ? last.error : stderr.trim() || `exit ${code}`;
                reject(new Error(detail));
            });
        });
    }

    async checkVersion(url: string): Promise<VersionCheck> {
        this.validateUrl(url, '更新地址');
        const result = await this.runSidecar(['check-version', '--url', url, '--current', this.appVersion()]);
        const inner = result.result as VersionCheck | undefined;
        if (!inner || typeof inner.latest !== 'string' || typeof inner.newer !== 'boolean') {
            throw new Error('更新检查返回了无效结果。');
        }
        return inner;
    }
    async checkResources(url: string): Promise<VersionCheck> {
        this.validateUrl(url, '资源版本地址');
        // The startup reset may still be running; reading the recorded
        // version early would compare against 0.0.0.
        await this.ready();
        const installed = this.recordedVersion() ?? '0.0.0';
        const result = await this.runSidecar(['check-resources', '--url', url, '--installed', installed]);
        const inner = result.result as VersionCheck | undefined;
        if (!inner || typeof inner.latest !== 'string' || typeof inner.newer !== 'boolean') {
            throw new Error('资源检查返回了无效结果。');
        }
        return inner;
    }

    /**
     * Download + install the resource package. The sidecar streams progress
     * and phase events, forwarded to every connected frontend; closing the
     * child's stdin is the cancellation channel.
     */
    async installResources(template: string, version: string, requireSha256: boolean): Promise<void> {
        this.validateUrl(template, '资源下载地址');
        this.validateVersion(version);
        // Wait out the startup reset so an install cannot race it for the
        // resources dir / version file.
        await this.ready();
        if (this.installer) { return Promise.reject(new Error('已有资源安装在进行中。')); }
        const args = [
            'install',
            '--url-template', template,
            '--version', version,
            '--dest', this.resourcesDir(),
            '--version-file', this.versionFile(),
            ...(requireSha256 ? ['--sha256'] : []),
        ];
        mkdirSync(this.noduHome(), { recursive: true });
        return new Promise<void>((resolve, reject) => {
            let child: ChildProcessWithoutNullStreams;
            try {
                child = spawn(this.resourcesBinary(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
                return;
            }
            this.installer = child;
            let lastError: string | undefined;
            let stderr = '';
            child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-4096); });
            const reader = createInterface({ input: child.stdout });
            reader.on('line', line => {
                if (line.length > MAX_LINE) { return; }
                let message: Record<string, unknown>;
                try { message = JSON.parse(line) as Record<string, unknown>; } catch { return; }
                if (message.event === 'progress' && typeof message.downloaded === 'number') {
                    const progress: InstallProgress = {
                        downloaded: message.downloaded,
                        total: typeof message.total === 'number' ? message.total : null,
                    };
                    this.publish('onInstallProgress', progress);
                } else if (message.event === 'phase' && (message.phase === 'downloading' || message.phase === 'installing')) {
                    this.publish('onInstallPhase', message.phase as InstallPhase);
                } else if (typeof message.error === 'string') {
                    lastError = message.error;
                }
            });
            const finish = (error?: Error): void => {
                if (this.installer === child) { this.installer = undefined; }
                reader.close();
                if (error) { reject(error); } else { resolve(); }
            };
            child.on('error', error => finish(new Error(`资源服务启动失败：${error.message}。开发者请运行 npm run build:native。`)));
            child.on('exit', code => {
                if (code === 0 && !lastError) { finish(); return; }
                finish(new Error(lastError || stderr.trim() || `资源安装失败（${code}）。`));
            });
        });
    }
    cancelInstall(): Promise<void> {
        // stdin EOF is the sidecar's cancellation signal; it cleans up the
        // temp file itself and reports {"error":"cancelled"}.
        try { this.installer?.stdin.end(); } catch { /* already gone */ }
        return Promise.resolve();
    }
}
