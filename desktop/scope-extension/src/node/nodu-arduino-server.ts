// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { StringDecoder } from 'node:string_decoder';
import { ArduinoBuildRequest, ArduinoBuildResult, ArduinoClient, NoduArduinoService, ArduinoProjectInfo, ArduinoBoard, ArduinoBoardOption,
    ArduinoConfigureRequest, ArduinoPort, ArduinoUploadRequest, ArduinoUploadResult, ArduinoPhase } from '../common/nodu-arduino-protocol';
import { ArduinoLibraryChange, ArduinoLibraryChangeResult, ArduinoLibraryQuery, ArduinoLibraryList } from '../common/nodu-arduino-libraries-protocol';
import { ArduinoLibraryContext, listArduinoLibraries, changeArduinoLibrary, prepareBundledArduinoLibraries } from './nodu-arduino-libraries';
import { boardCatalog, catalogBoards, catalogOptions, configureArduinoProject, inspectArduinoProject } from './nodu-arduino-boards';
import { arduinoResources } from './nodu-arduino-paths';
import { NoduEmbeddedServer } from './nodu-embedded-server';
import { PortInfo } from '../common/nodu-embedded-protocol';
import { executeArduinoUpload, readArduinoFlashPlan, ArduinoUploadTarget } from './nodu-arduino-upload';
import { installArduinoCli } from './nodu-arduino-toolchain';
import { arduinoInitializationErrors, arduinoOfflineRoot, seedArduinoOfflineBundle } from './nodu-arduino-offline';
import { createSourceProject, parseProjectRequest } from './nodu-project-generator';
import { arduinoDiagnostics, arduinoInputDigest, readArduinoProject } from './nodu-arduino-project';

interface Operation { id: string; cancelled: boolean; child?: ChildProcess; abort?: AbortController; finished?: Promise<void> }
interface Environment { home: string; config: string; env: NodeJS.ProcessEnv }
interface Built { path: string; directory: string; digest: string; artifacts: string; fqbn: string }

/** Cancels abandoned work on disconnect and keeps request ownership within one window. */
export function arduinoConnection(server: NoduArduinoServer, client: ArduinoClient): { service: NoduArduinoService; dispose(): void } {
    const owned = new Map<string, { id: string; release(): void; abort?: AbortController }>(); let closed = false;
    const service = Object.create(null) as NoduArduinoService;
    for (const method of ['boards', 'boardOptions', 'configure', 'ports'] as const) {
        (service as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => {
            if (closed) { throw new Error('Arduino 连接已关闭。'); }
            return (server[method] as (...values: unknown[]) => unknown).apply(server, args);
        };
    }
    service.inspect = async path => {
        if (closed) { throw new Error('Arduino 连接已关闭。'); }
        // Opening a project can now install the bundled environment. Track it like other owned work,
        // including while it is waiting for a different operation to release the shared CLI.
        const id = `inspect-${randomUUID()}`, abort = new AbortController();
        owned.set(id, { id, release() {}, abort });
        try { return await server.inspect(path, id, abort.signal); }
        finally { owned.delete(id); }
    };
    for (const method of ['compile', 'prepare', 'upload', 'changeLibrary', 'listLibraries'] as const) {
        (service as unknown as Record<string, unknown>)[method] = async (request: ArduinoBuildRequest) => {
            if (closed || !request || (request.operationId !== undefined && !/^[\w-]{1,100}$/.test(request.operationId))) {
                throw new Error('编译连接已关闭或请求无效。');
            }
            const externalId = request.operationId || `query-${randomUUID()}`;
            if (owned.has(externalId)) { throw new Error('重复的 Arduino 操作。'); }
            const id = `connection-${randomUUID()}`;
            const release = server.addClient({ onArduinoOutput: event => {
                if (!closed && event.operationId === id) { return client.onArduinoOutput({ ...event, operationId: externalId }); }
            } });
            owned.set(externalId, { id, release });
            try { return await (server[method] as (value: unknown) => Promise<unknown>).call(server, { ...request, operationId: id }); }
            finally { if (owned.get(externalId)?.id === id) { owned.delete(externalId); } release(); }
        };
    }
    service.cancel = async requestId => { const operation = owned.get(requestId); if (operation) { await server.cancel(operation.id); } };
    return { service, dispose: () => {
        closed = true;
        for (const operation of owned.values()) { operation.release(); operation.abort?.abort(); void server.cancel(operation.id); }
        owned.clear();
    } };
}

/** Arduino owns preprocessing, dependencies and build recipes. No shell commands are constructed. */
@injectable()
export class NoduArduinoServer implements NoduArduinoService {
    @inject(NoduEmbeddedServer) protected readonly embedded!: NoduEmbeddedServer;
    private readonly clients = new Set<ArduinoClient>();
    private readonly builds = new Map<string, Built>();
    private managedCli?: string;
    private active?: Operation;
    private baseEnvironment?: Promise<void>;
    addClient(client: ArduinoClient): () => void { this.clients.add(client); return () => { this.clients.delete(client); }; }
    protected directory(): string { return process.env.NODU_ARDUINO_HOME || join(homedir(), '.nodu', 'arduino'); }
    protected binary(): string {
        if (this.managedCli) { return this.managedCli; }
        if (process.env.NODU_ARDUINO_CLI) { return process.env.NODU_ARDUINO_CLI; }
        const extension = dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json'));
        const exe = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
        const bundled = join(extension, 'resources', 'bin', `${process.platform}-${process.arch}`, exe);
        if (existsSync(bundled)) { return bundled; }
        // GUI applications on macOS may not inherit Homebrew's PATH.
        if (process.platform === 'darwin') {
            for (const path of ['/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli']) { if (existsSync(path)) { return path; } }
        }
        return exe;
    }
    private output(request: ArduinoBuildRequest, line: string, phase?: ArduinoPhase): void {
        for (const client of this.clients) {
            try { Promise.resolve(client.onArduinoOutput({ operationId: request.operationId, path: request.path, line, phase })).catch(() => this.clients.delete(client)); }
            catch { this.clients.delete(client); }
        }
    }
    private async environment(): Promise<Environment> {
        await fs.mkdir(this.directory(), { recursive: true });
        // Canonical paths are essential: CLI profiles misclassify libraries when /tmp and /private/tmp are mixed.
        const home = await fs.realpath(this.directory()), config = join(home, 'arduino-cli.yaml');
        const contents = JSON.stringify({ directories: { data: join(home, 'data'), downloads: join(home, 'downloads'), user: join(home, 'user') },
            build_cache: { path: join(home, 'cache') }, library: { enable_unsafe_install: false } }) + '\n';
        // The language server also reads this configuration. Never expose a truncated file.
        if (await fs.readFile(config, 'utf8').catch(() => '') !== contents) {
            const temporary = `${config}.${randomUUID()}.tmp`;
            try { await fs.writeFile(temporary, contents, { flag: 'wx' }); await fs.rename(temporary, config); }
            finally { await fs.rm(temporary, { force: true }); }
        }
        return { home, config, env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ARDUINO_'))) };
    }
    private libraryContext(environment: Environment, operation?: Operation, request?: ArduinoBuildRequest): ArduinoLibraryContext {
        return { home: environment.home, resources: join(arduinoResources(), 'libraries'), cancelled: () => !!operation?.cancelled,
            run: (args, quiet = true) => {
                if (!operation || !request) { throw new Error('刷新库索引需要独立操作。'); }
                return this.run(operation, request, args, request.path, environment.config, environment.env, quiet);
            } };
    }
    async inspect(path: string, operationId = `base-${randomUUID()}`, signal?: AbortSignal): Promise<ArduinoProjectInfo> {
        signal?.throwIfAborted();
        await readArduinoProject(path);
        signal?.throwIfAborted();
        await this.initializeBundledEnvironment(path, operationId, signal);
        signal?.throwIfAborted();
        return inspectArduinoProject(this.directory(), path);
    }
    /** First open initializes only app-owned resources, without compiling/saving the user's source or taking focus. */
    private async initializeBundledEnvironment(path: string, operationId: string, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.baseEnvironment) { await this.baseEnvironment; signal?.throwIfAborted(); return; }
        const root = arduinoOfflineRoot();
        if (!process.env.NODU_ARDUINO_OFFLINE_BUNDLES && !existsSync(join(root, 'required.json'))
            && !existsSync(join(root, `${process.platform}-${process.arch}`, 'manifest.json'))) { return; }
        // A user operation may already have initialized this shared environment. Do not compete with its CLI.
        if (this.active) {
            if (this.active.finished) {
                await this.active.finished; signal?.throwIfAborted();
                return this.initializeBundledEnvironment(path, operationId, signal);
            }
            throw new Error('正在更新 Arduino 设置，请重试。');
        }
        signal?.throwIfAborted();
        const request = { path, operationId }, abort = (): void => { void this.cancel(operationId); };
        signal?.addEventListener('abort', abort, { once: true });
        const work = this.operation(request, async (operation, environment) => {
            await this.checkCli(operation, request, environment);
            await prepareBundledArduinoLibraries(this.libraryContext(environment, operation, request));
            const parent = join(environment.home, 'bootstrap'); await fs.mkdir(parent, { recursive: true });
            const scratch = await fs.mkdtemp(join(parent, 'environment-'));
            try {
                const project = await createSourceProject(parseProjectRequest({ parent: scratch, name: 'environment', chip: 'esp32c3', framework: 'arduino', template: 'hello' }));
                // The official profile installer expands the shipped tool archives and all 11 fixed libraries.
                // Both chips share this tool closure. Never fabricate a successful setup from boards.txt alone.
                const build = join(scratch, 'build');
                const result = await this.run(operation, { ...request, path: project.path }, ['compile', '--profile', 'nodu', '--only-compilation-database',
                    '--build-path', build, '--no-color', project.path], project.path, environment.config, { ...environment.env, LC_ALL: 'C', LANG: 'en_US.UTF-8' }, true);
                const errors = arduinoInitializationErrors(result.output);
                const database: unknown = await fs.readFile(join(build, 'compile_commands.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
                if (operation.cancelled || result.code !== 0 || errors.length || !Array.isArray(database) || !database.length) {
                    throw new Error(operation.cancelled ? '已停止' : `Arduino 内置环境初始化失败：${(errors.join('\n') || result.output || '未生成编译环境').slice(-2000)}`);
                }
            } finally { await fs.rm(scratch, { recursive: true, force: true }); }
        });
        this.baseEnvironment = work;
        try { await work; signal?.throwIfAborted(); }
        catch (error) { if (this.baseEnvironment === work) { this.baseEnvironment = undefined; } throw error; }
        finally { signal?.removeEventListener('abort', abort); }
    }
    async boards(path: string): Promise<ArduinoBoard[]> {
        const project = await readArduinoProject(path); return catalogBoards(await boardCatalog(this.directory(), project.coreVersion), project.chip);
    }
    async boardOptions(path: string, fqbn?: string): Promise<ArduinoBoardOption[]> {
        const project = await readArduinoProject(path); return catalogOptions(await boardCatalog(this.directory(), project.coreVersion), fqbn ?? project.fqbn, project.chip);
    }
    async configure(request: ArduinoConfigureRequest): Promise<ArduinoProjectInfo> {
        if (this.active) { throw new Error('当前操作结束后再修改工程设置。'); }
        const operation = { id: `configure-${randomUUID()}`, cancelled: false }; this.active = operation;
        try { return await configureArduinoProject(this.directory(), request); }
        finally { if (this.active === operation) { this.active = undefined; } }
    }
    async ports(): Promise<ArduinoPort[]> {
        const response = await this.embedded.call('listPorts', {});
        if (!response.ok) { throw new Error(response.error.message); }
        return (response.result as PortInfo[]).map(port => ({ path: port.path, label: port.description, serialNumber: port.serial_number, vid: port.vid, pid: port.pid }));
    }
    private async operation<T>(request: ArduinoBuildRequest, task: (operation: Operation, environment: Environment) => Promise<T>): Promise<T> {
        if (!request || typeof request.operationId !== 'string' || !/^[\w-]{1,100}$/.test(request.operationId)) { throw new Error('无效的 Arduino 请求。'); }
        if (this.active) { throw new Error('另一个 Arduino 操作正在进行。'); }
        let finish!: () => void;
        const operation: Operation = { id: request.operationId, cancelled: false, abort: new AbortController(), finished: new Promise<void>(resolve => { finish = resolve; }) }; this.active = operation;
        try { return await task(operation, await this.environment()); }
        finally { if (this.active === operation) { this.active = undefined; } finish(); }
    }
    private async checkCli(operation: Operation, request: ArduinoBuildRequest, environment: Environment): Promise<void> {
        const bundled = await seedArduinoOfflineBundle(environment.home, operation.abort!.signal, text => this.output(request, text, 'preparing'));
        if (bundled && !process.env.NODU_ARDUINO_CLI) {
            // A release always uses its own verified CLI; PATH/Homebrew cannot silently replace it.
            this.managedCli = await installArduinoCli(environment.home, operation.abort!.signal, text => this.output(request, text, 'preparing'), false);
        }
        const check = async (): Promise<boolean> => {
            try { const version = await this.run(operation, request, ['version', '--format', 'json'], request.path, environment.config, environment.env, true);
                return version.code === 0 && JSON.parse(version.output).VersionString === '1.5.1'; } catch { return false; }
        };
        if (await check()) { return; }
        if (operation.cancelled) { throw new Error('已停止'); }
        if (process.env.NODU_ARDUINO_CLI) { throw new Error('指定的 Arduino CLI 无效，需要 1.5.1。'); }
        this.managedCli = await installArduinoCli(environment.home, operation.abort!.signal, text => this.output(request, text, 'preparing'), !bundled);
        if (!await check()) { throw new Error('Arduino CLI 安装后未能启动，请重试准备环境。'); }
    }
    async listLibraries(request: ArduinoLibraryQuery): Promise<ArduinoLibraryList> {
        if (!request.refresh) { return listArduinoLibraries(this.libraryContext({ home: this.directory(), config: '', env: {} }), request); }
        return this.operation({ path: request.path, operationId: request.operationId || `libraries-${randomUUID()}` }, async (operation, environment) => {
            await this.checkCli(operation, { ...request, operationId: operation.id }, environment);
            return listArduinoLibraries(this.libraryContext(environment, operation, { ...request, operationId: operation.id }), request);
        });
    }
    async changeLibrary(request: ArduinoLibraryChange): Promise<ArduinoLibraryChangeResult> {
        try { return await this.operation(request, async (operation, environment) => {
            await this.checkCli(operation, request, environment);
            return changeArduinoLibrary(this.libraryContext(environment, operation, request), request);
        }); }
        catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    async prepare(request: ArduinoBuildRequest): Promise<ArduinoBuildResult> {
        try { return await this.operation(request, async (operation, environment): Promise<ArduinoBuildResult> => {
            try {
                const project = await readArduinoProject(request.path);
                this.output(request, '准备 Arduino 环境', 'preparing');
                await this.checkCli(operation, request, environment);
                await prepareBundledArduinoLibraries(this.libraryContext(environment, operation, request));
                const output = join(environment.home, 'prepare', createHash('sha256').update(project.path).digest('hex').slice(0, 24));
                await fs.mkdir(output, { recursive: true });
                await fs.rm(join(output, 'compile_commands.json'), { force: true });
                const result = await this.run(operation, request, ['compile', '--profile', project.profile, '--build-path', output,
                    '--only-compilation-database', '--no-color', project.path], project.path, environment.config, environment.env, false);
                const database: unknown = await fs.readFile(join(output, 'compile_commands.json'), 'utf8').then(text => JSON.parse(text)).catch(() => undefined);
                const failed = result.code !== 0 || arduinoInitializationErrors(result.output).length > 0 || !Array.isArray(database) || !database.length;
                return { ok: !failed && !operation.cancelled, cancelled: operation.cancelled,
                    diagnostics: arduinoDiagnostics(result.output, project.path), error: failed && !operation.cancelled ? '环境准备失败，请查看输出。' : undefined };
            } catch (error) { return { ok: false, cancelled: operation.cancelled, diagnostics: [], error: operation.cancelled ? undefined : error instanceof Error ? error.message : String(error) }; }
        }); } catch (error) { return { ok: false, diagnostics: [], error: error instanceof Error ? error.message : String(error) }; }
    }
    private async artifactDigest(path: string): Promise<string> {
        const hash = createHash('sha256');
        const names = (await fs.readdir(path)).filter(name => /\.(?:bin|elf)$/.test(name) || ['flash_args', 'build.options.json'].includes(name)).sort();
        if (!names.some(name => name.endsWith('.bin'))) { throw new Error('编译未生成固件文件。'); }
        for (const name of names) { const file = join(path, name), stat = await fs.lstat(file); if (!stat.isFile() || stat.size > 128 * 1024 * 1024) { throw new Error('构建产物无效。'); } hash.update(name); hash.update(await fs.readFile(file)); }
        return hash.digest('hex');
    }
    async compile(request: ArduinoBuildRequest): Promise<ArduinoBuildResult> {
        try { return await this.operation(request, async (operation, environment): Promise<ArduinoBuildResult> => {
            try {
                const project = await readArduinoProject(request.path), before = await arduinoInputDigest(project.path);
                catalogOptions(await boardCatalog(environment.home, project.coreVersion), project.fqbn, project.chip);
                for (const [token, built] of this.builds) { if (built.path === project.path) { this.builds.delete(token); } }
                const buildPath = join(environment.home, 'builds', createHash('sha256').update(project.path).digest('hex').slice(0, 24));
                await fs.mkdir(buildPath, { recursive: true });
                this.output(request, '准备 Arduino 环境', 'preparing');
                await this.checkCli(operation, request, environment);
                await prepareBundledArduinoLibraries(this.libraryContext(environment, operation, request));
                this.output(request, `Arduino · ${project.fqbn}`, 'compiling');
                const result = await this.run(operation, request, ['compile', '--profile', project.profile, '--build-path', buildPath, '--warnings', 'default', '--no-color', project.path], project.path, environment.config, environment.env, false);
                if (operation.cancelled) { return { ok: false, cancelled: true, diagnostics: [] }; }
                const failed = result.code !== 0 || arduinoInitializationErrors(result.output).length > 0;
                const stale = before !== await arduinoInputDigest(project.path);
                let buildToken: string | undefined;
                if (!failed && !stale) {
                    buildToken = randomUUID();
                    this.builds.set(buildToken, { path: project.path, directory: buildPath, digest: before, artifacts: await this.artifactDigest(buildPath), fqbn: project.fqbn });
                    if (this.builds.size > 32) { this.builds.delete(this.builds.keys().next().value!); }
                }
                return { ok: !failed && !stale, stale, diagnostics: arduinoDiagnostics(result.output, project.path), buildToken,
                    ...(!failed ? { buildPath } : {}), ...(stale ? { error: '编译期间工程已修改，请重新编译。' } : failed ? { error: '编译失败，请查看构建输出。' } : {}) };
            } catch (error) { return { ok: false, cancelled: operation.cancelled, diagnostics: [], error: operation.cancelled ? undefined : error instanceof Error ? error.message : String(error) }; }
        }); } catch (error) { return { ok: false, diagnostics: [], error: error instanceof Error ? error.message : String(error) }; }
    }
    protected uploadTarget(request: ArduinoUploadRequest): ArduinoUploadTarget {
        return { kind: 'serial', port: request.port, transport: 'uart' };
    }
    async upload(request: ArduinoUploadRequest): Promise<ArduinoUploadResult> {
        try { return await this.operation(request, async (operation, environment): Promise<ArduinoUploadResult> => {
            let lease: Awaited<ReturnType<NoduEmbeddedServer['acquireArduinoPort']>> | undefined;
            let restore = false; let result: ArduinoUploadResult;
            try {
                const project = await readArduinoProject(request.path), built = this.builds.get(request.buildToken);
                if (!['esp32c3', 'esp32s3'].includes(project.chip)) { throw new Error('当前上传仅支持已验收的 ESP32-S3 / ESP32-C3。'); }
                const current = async (): Promise<void> => {
                    if (operation.cancelled) { throw new Error('已停止'); }
                    if (!built || built.path !== project.path || built.fqbn !== project.fqbn || built.digest !== await arduinoInputDigest(project.path)
                        || built.artifacts !== await this.artifactDigest(built.directory)) { throw new Error('代码、配置或固件已改变，请重新编译。'); }
                };
                await current(); await this.checkCli(operation, request, environment);
                await readArduinoFlashPlan(built!.directory, { ...project, chip: project.chip as 'esp32c3' | 'esp32s3' });
                const target = this.uploadTarget(request);
                if (target.kind === 'serial') { lease = await this.embedded.acquireArduinoPort(request.port); lease.onLost(() => { void this.cancel(operation.id); }); }
                await current();
                const uploaded = await executeArduinoUpload({ project: { ...project, chip: project.chip as 'esp32c3' | 'esp32s3' }, buildPath: built!.directory,
                    cliPath: this.binary(), configPath: environment.config, target, isCancelled: () => operation.cancelled,
                    onStage: stage => { if (stage === 'upload' || stage === 'verify') { this.output(request, stage === 'upload' ? '正在烧录' : '正在校验', stage === 'upload' ? 'uploading' : 'verifying'); } },
                    run: (exe, args, cwd) => this.run(operation, request, args, cwd, environment.config, environment.env, false, exe, true) });
                restore = uploaded.ok && !operation.cancelled;
                const stale = built!.digest !== await arduinoInputDigest(project.path);
                result = { ok: uploaded.ok, cancelled: uploaded.cancelled, stale, error: uploaded.error };
            } catch (error) { result = { ok: false, cancelled: operation.cancelled, error: error instanceof Error ? error.message : String(error) }; }
            if (lease) {
                this.output(request, '恢复串口', 'restoring');
                try { const restored = await lease.release(restore, () => !operation.cancelled); result.monitorRestored = restored.restored; }
                catch (error) { this.output(request, `串口恢复失败：${error instanceof Error ? error.message : String(error)}`); }
            }
            if (operation.cancelled) { result.ok = false; result.cancelled = true; }
            return result;
        }); } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }
    private run(operation: Operation, request: ArduinoBuildRequest, args: string[], cwd: string, config: string,
        env: NodeJS.ProcessEnv, quiet: boolean, executable = this.binary(), raw = false): Promise<{ code: number; output: string }> {
        if (operation.cancelled) { return Promise.reject(new Error('已停止')); }
        return new Promise((resolve, reject) => {
            const child = spawn(executable, raw ? args : ['--config-file', config, ...args], { cwd, env, shell: false,
                detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            operation.child = child;
            let output = '', finished = false;
            const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
            const parts = ['', ''];
            const consume = (chunk: string, channel: number): void => {
                output = (output + chunk).slice(-8 * 1024 * 1024);
                parts[channel] += chunk;
                const lines = parts[channel].split(/\r\n|\r|\n/); parts[channel] = lines.pop()!.slice(-16_384);
                for (const line of lines) { if (line && !quiet) { this.output(request, line.slice(0, 16_384)); } }
            };
            child.stdout!.on('data', (bytes: Buffer) => consume(decoders[0].write(bytes), 0));
            child.stderr!.on('data', (bytes: Buffer) => consume(decoders[1].write(bytes), 1));
            const timer = setTimeout(() => { operation.cancelled = true; this.kill(child); }, 30 * 60_000);
            const done = (error?: Error, code = -1): void => {
                if (finished) { return; } finished = true; clearTimeout(timer);
                for (let i = 0; i < 2; i++) { consume(decoders[i].end(), i); if (parts[i] && !quiet) { this.output(request, parts[i]); } }
                operation.child = undefined;
                if (error) { reject(error); } else { resolve({ code, output }); }
            };
            child.once('error', error => done(error)); child.once('close', code => done(undefined, code ?? -1));
            if (operation.cancelled) { this.kill(child); }
        });
    }
    private kill(child: ChildProcess): void {
        if (!child.pid) { return; }
        if (process.platform === 'win32') { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true }).on('error', () => child.kill()); }
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
    }
    async cancel(operationId: string): Promise<void> {
        if (this.active?.id !== operationId) { return; }
        this.active.cancelled = true; if (this.active.child) { this.kill(this.active.child); }
        this.active.abort?.abort();
    }
    onStop(): void { if (this.active) { void this.cancel(this.active.id); } }
}
