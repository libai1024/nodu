// SPDX-License-Identifier: MIT
import { TutorContext, validateTutorContexts } from '../../common/tutor/tutor-context';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TutorProgressStore } from './tutor-progress-store';
import type { TutorProjectContext } from '../../common/tutor/tutor-goal';
import { createHash } from 'node:crypto';
import { TutorPureExecution } from '../../common/tutor/tutor-local-check';
import { TutorLocalChecker } from './tutor-local-checker';
import { parse as parseJsonc } from 'jsonc-parser';
import type { TutorBuffer } from '../../common/tutor/tutor-ai-protocol';
import { TutorStorageConnection } from './tutor-storage-server';
import { readRegularFile } from './tutor-file-io';
import { readArduinoProject } from '../nodu-arduino-project';
import { readArduinoLibraryProfile } from '../nodu-arduino-libraries';

/** Uses the existing Theia workspace-open lifecycle, never recent-workspace history as a grant. */
export class TutorWorkspaceHost {
    private readonly checker = new TutorLocalChecker();
    private current: string | undefined = '';
    private executions = new Map<string, { result: TutorPureExecution; time: number }>();
    private sequence = 0;
    private grants: { id: string; uri: string; root: string; key: string }[] = [];
    private disposed = false;
    private pending: Promise<void> = Promise.resolve();
    constructor(private readonly storage: TutorStorageConnection, private readonly revokeChat: (id: string) => void,
        /** Tells the window its grants changed, so it never has to race the workspace-open RPC. */
        private readonly changed: () => void = () => undefined,
        private readonly buildStatus?: (root: string) => Promise<NonNullable<TutorProjectContext['build']>>) { }
    async select(uri: string): Promise<void> {
        if (this.disposed) { throw new Error('工程授权已失效'); }
        if (typeof uri !== 'string' || uri.length > 8192) { throw new Error('工程地址无效'); }
        if (uri === this.current) { return this.pending; }
        this.current = uri; this.executions.clear();
        const sequence = ++this.sequence;
        for (const grant of this.grants) { this.storage.revokeWorkspace(grant.id); this.revokeChat(grant.id); }
        this.grants = [];
        const previous = this.pending;
        this.pending = previous.catch(() => undefined).then(() => this.resolve(uri, sequence)).catch(error => {
            if (sequence === this.sequence) {
                for (const grant of this.grants) { this.storage.revokeWorkspace(grant.id); this.revokeChat(grant.id); }
                this.grants = []; this.current = undefined; this.executions.clear();
            }
            throw error;
        }).finally(() => { if (sequence === this.sequence) { this.changed(); } });
        return this.pending;
    }
    private async resolve(uri: string, sequence: number): Promise<void> {
        if (!uri || sequence !== this.sequence) { return; }
        const url = new URL(uri);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) { return; }
        const location = fileURLToPath(url);
        const stat = await fs.lstat(location);
        if (stat.isSymbolicLink()) { throw new Error('教学工程不支持符号链接入口'); }
        let roots = [location];
        if (stat.isFile()) {
            if (stat.size > 512 * 1024 || !/\.(theia-workspace|code-workspace)$/i.test(location)) { return; }
            const workspace = parseJsonc(await readRegularFile(location, 512 * 1024));
            if (!workspace || !Array.isArray(workspace.folders) || workspace.folders.length > 16) { throw new Error('工作区格式无效'); }
            roots = workspace.folders.map((folder: { path?: string; uri?: string }) => {
                if (typeof folder.path === 'string') { return path.resolve(path.dirname(location), folder.path); }
                if (typeof folder.uri === 'string') { return fileURLToPath(folder.uri); }
                throw new Error('工作区目录无效');
            });
        }
        for (const candidate of roots) {
            if (sequence !== this.sequence) { return; }
            const root = await fs.realpath(candidate);
            const key = await TutorProgressStore.projectKey(root);
            const id = await this.storage.authorizeWorkspace(root);
            if (sequence !== this.sequence) { this.storage.revokeWorkspace(id); return; }
            try { if (key !== await TutorProgressStore.projectKey(root)) { throw new Error('工程目录已改变，请重新打开'); } }
            catch (error) { this.storage.revokeWorkspace(id); throw error; }
            if (sequence !== this.sequence) { this.storage.revokeWorkspace(id); return; }
            if (!this.grants.some(g => g.id === id)) { this.grants.push({ id, root, key, uri: pathToFileURL(candidate).href }); }
        }
    }
    async list(): Promise<{ id: string; uri: string; projectKey: string }[]> {
        await this.pending;
        for (const grant of [...this.grants]) { await this.assertGrant(grant); }
        return this.grants.map(({ id, uri, key }) => ({ id, uri, projectKey: key }));
    }
    private async assertGrant(grant: { id: string; root: string; key: string }): Promise<void> {
        try {
            if (this.disposed || !this.grants.some(g => g === grant) || await TutorProgressStore.projectKey(grant.root) !== grant.key) { throw new Error(); }
        } catch {
            if (this.grants.some(g => g === grant)) {
                this.storage.revokeWorkspace(grant.id); this.revokeChat(grant.id);
                this.grants = this.grants.filter(g => g !== grant); this.current = undefined; this.executions.clear(); this.changed();
            }
            throw new Error('工程目录已改变或授权已失效，请重新打开');
        }
        if (!this.grants.some(g => g === grant)) { throw new Error('工程授权已失效'); }
    }
    private async readProjectFile(grant: { id: string; root: string; key: string }, relative: string, limit: number): Promise<string> {
        await this.assertGrant(grant);
        const target = path.join(grant.root, relative);
        if (await fs.realpath(target) !== target) { throw new Error('教学文件不在当前工程'); }
        const text = await readRegularFile(target, limit);
        if (await fs.realpath(target) !== target) { throw new Error('教学文件已改变'); }
        await this.assertGrant(grant);
        return text;
    }
    rememberExecution(id: string, buffer: TutorBuffer, result: TutorPureExecution): void {
        if (!this.grants.some(g => g.id === id) || result.sourceDigest !== createHash('sha256').update(buffer.text).digest('hex')) { return; }
        this.executions.set(`${id}:${buffer.path}`, { result, time: Date.now() });
        while (this.executions.size > 8) { this.executions.delete(this.executions.keys().next().value!); }
    }
    async context(id: string, buffer?: TutorBuffer, allowPython = false): Promise<TutorProjectContext> {
        await this.authorize(id, buffer, allowPython);
        const grant = this.grants.find(g => g.id === id)!;
        const files: string[] = [];
        let visited = 0, pathBytes = 0;
        const walk = async (relative: string, depth: number): Promise<void> => {
            if (depth > 5 || visited > 3000 || files.length >= 200 || pathBytes >= 8000) { return; }
            const directory = path.join(grant.root, relative);
            if (await fs.realpath(directory) !== directory) { throw new Error('工程目录已改变'); }
            for await (const entry of await fs.opendir(directory)) {
                if (++visited > 3000 || files.length >= 200 || pathBytes >= 8000) { break; }
                if (entry.name.startsWith('.') || /^(node_modules|build|target|Drivers|Middlewares|vendor|reference)$/i.test(entry.name) || entry.isSymbolicLink()) { continue; }
                const name = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory()) { await walk(name, depth + 1); }
                else if (entry.isFile() && (allowPython ? /\.(c|h|cpp|hpp|cc|py|ino)$/i : /\.(c|h|cpp|hpp|cc)$/i).test(name) && name.length <= 240) { files.push(name); pathBytes += name.length; }
            }
        };
        await walk('', 0);
        let mcu = '未知', sdk = '未知';
        try {
            const data = JSON.parse(await this.readProjectFile(grant, 'nodu.json', 32000));
            if (typeof data?.target?.mcu === 'string') { mcu = data.target.mcu.slice(0, 80); }
            if (typeof data?.sdk === 'string') { sdk = data.sdk.slice(0, 80); }
            else if (data?.kind === 'esp32-arduino') { sdk = 'Arduino'; }
        } catch { /* Missing metadata is explicitly unknown, never inferred from a board name. */ }
        let arduino: TutorProjectContext['arduino'];
        if (allowPython && sdk === 'Arduino') {
            try {
                const project = await readArduinoProject(grant.root), profile = await readArduinoLibraryProfile(grant.root);
                // Only structured build identity is attached, never raw local settings or credentials.
                arduino = { profile: project.profile, fqbn: project.fqbn, coreVersion: project.coreVersion,
                    libraries: profile.libraries.slice(0, 100).map(({ name, version, direct }) => ({ name, version, direct })) };
            } catch { /* An invalid profile stays unavailable; a question can still refer to the source file. */ }
        }
        const declarations: { path: string; text: string }[] = [];
        if (buffer && !/\.py$/i.test(buffer.path)) {
            const names = new Set(['main.h', 'board.h', ...Array.from(buffer.text.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm), m => m[1])]);
            let budget = 8000;
            for (const relative of files.filter(f => /\.h$/i.test(f) && (names.has(f) || names.has(path.basename(f)))).slice(0, 8)) {
                await this.authorize(id, { path: relative, text: '', version: 1, line: 1 });
                const stat = await fs.lstat(path.join(grant.root, relative));
                if (stat.size > budget) { continue; }
                const text = await this.readProjectFile(grant, relative, budget);
                budget -= Buffer.byteLength(text); declarations.push({ path: relative, text });
            }
        }
        let build: TutorProjectContext['build'];
        if (mcu !== '未知' && this.buildStatus) {
            try { build = await this.buildStatus(grant.root); }
            catch { build = { status: 'unavailable', scope: 'saved-project' }; }
            if (!buffer) { delete build.runtime; }
            if (buffer) {
                try { build.currentBufferSaved = await this.readProjectFile(grant, buffer.path, 32000) === buffer.text; }
                catch { build.currentBufferSaved = false; }
                if (!build.currentBufferSaved) { delete build.runtime; }
            }
        }
        const localCheck = buffer && !/\.(py|ino)$/i.test(buffer.path) ? await this.checker.inspect(buffer) : undefined;
        const execution = buffer ? this.executions.get(`${id}:${buffer.path}`) : undefined;
        if (localCheck && execution && execution.result.sourceDigest === localCheck.sourceDigest && Date.now() - execution.time < 60000) { localCheck.execution = execution.result; }
        await this.assertGrant(grant);
        return { key: grant.key, mcu, sdk, files: files.sort(), ...(arduino ? { arduino } : {}),
            ...(localCheck ? { localCheck } : {}), ...(declarations.length ? { declarations } : {}), ...(build ? { build } : {}) };
    }
    async reference(id: string, relative: string, line: number): Promise<{ path: string; line: number }> {
        await this.authorize(id, { path: relative, text: '', version: 1, line: 1 }, true);
        const grant = this.grants.find(g => g.id === id)!;
        const text = await this.readProjectFile(grant, relative, /\.py$/i.test(relative) ? 64 * 1024 : 32000);
        if (!Number.isInteger(line) || line < 1 || line > text.split('\n').length) { throw new Error('代码行号无效'); }
        await this.authorize(id, { path: relative, text: '', version: 1, line: 1 }, true);
        return { path: relative, line };
    }

    async contexts(id: string, mode: 'teach' | 'ask', input: TutorContext[]): Promise<TutorContext[]> {
        const contexts = validateTutorContexts(input, mode);
        // Terminal text is an explicitly attached snapshot, not a path to read or execute.
        for (const c of contexts) { if (c.kind !== 'terminal') { await this.authorize(id, { path: c.path, text: '', version: 1, line: 1 }, mode === 'ask'); } }
        await this.authorize(id); return contexts;
    }
    async readContext(id: string, relative: string): Promise<TutorContext> {
        await this.authorize(id, { path: relative, text: '', version: 1, line: 1 }, true);
        const grant = this.grants.find(g => g.id === id)!;
        const text = await this.readProjectFile(grant, relative, 64 * 1024);
        const context: TutorContext = { kind: 'file', path: relative, text, version: 1, startLine: 1, endLine: text.split('\n').length };
        return (await this.contexts(id, 'ask', [context]))[0];
    }
    async authorize(id: string, buffer?: TutorBuffer, allowPython = false): Promise<void> {
        await this.pending;
        const grant = this.grants.find(g => g.id === id);
        if (!grant) { throw new Error('工程授权已失效'); }
        await this.assertGrant(grant);
        if (buffer === undefined) { return; }
        if (!buffer || Object.keys(buffer).some(k => !['path','text','version','line'].includes(k)) || typeof buffer.path !== 'string' || !buffer.path
            || buffer.path.length > 1024 || buffer.path.includes('\\') || buffer.path.includes('\0') || buffer.path.split('/').some(p => p === '..' || p === '.' || p === '')
            || path.isAbsolute(buffer.path) || !(allowPython ? /\.(c|h|cpp|hpp|cc|py|ino)$/i : /\.(c|h|cpp|hpp|cc)$/i).test(buffer.path)
            || typeof buffer.text !== 'string' || buffer.text.length > 32000 || buffer.text.includes('\0')
            || !Number.isSafeInteger(buffer.version) || buffer.version < 1 || !Number.isInteger(buffer.line) || buffer.line < 1 || buffer.line > buffer.text.split('\n').length) { throw new Error('代码上下文无效或超过 32 KB'); }
        const target = path.resolve(grant.root, buffer.path);
        const real = await fs.realpath(target);
        if (real !== target || !real.startsWith(grant.root + path.sep) || !(await fs.stat(real)).isFile()) { throw new Error('代码上下文不在当前工程'); }
        await this.assertGrant(grant);
    }
    dispose(): void { this.disposed = true; ++this.sequence; for (const g of this.grants) { this.revokeChat(g.id); } this.grants = []; this.storage.dispose(); }
}
