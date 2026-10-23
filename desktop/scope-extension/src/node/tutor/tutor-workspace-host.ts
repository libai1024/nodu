// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TutorProgressStore } from './tutor-progress-store';
import type { TutorProjectContext } from '../../common/tutor/tutor-goal';
import { TutorLocalChecker } from './tutor-local-checker';
import { parse as parseJsonc } from 'jsonc-parser';
import type { TutorBuffer } from '../../common/tutor/tutor-ai-protocol';
import { TutorStorageConnection } from './tutor-storage-server';

/** Uses the existing Theia workspace-open lifecycle, never recent-workspace history as a grant. */
export class TutorWorkspaceHost {
    private readonly checker = new TutorLocalChecker();
    private current = '';
    private sequence = 0;
    private grants: { id: string; uri: string; root: string }[] = [];
    private pending: Promise<void> = Promise.resolve();
    constructor(private readonly storage: TutorStorageConnection, private readonly revokeChat: (id: string) => void,
        /** Tells the window its grants changed, so it never has to race the workspace-open RPC. */
        private readonly changed: () => void = () => undefined,
        private readonly buildStatus?: (root: string) => Promise<NonNullable<TutorProjectContext['build']>>) { }
    async select(uri: string): Promise<void> {
        if (typeof uri !== 'string' || uri.length > 8192) { throw new Error('工程地址无效'); }
        if (uri === this.current) { return this.pending; }
        this.current = uri;
        const sequence = ++this.sequence;
        for (const grant of this.grants) { this.storage.revokeWorkspace(grant.id); this.revokeChat(grant.id); }
        this.grants = [];
        this.pending = this.resolve(uri, sequence).finally(() => { if (sequence === this.sequence) { this.changed(); } });
        return this.pending;
    }
    private async resolve(uri: string, sequence: number): Promise<void> {
        if (!uri) { return; }
        const url = new URL(uri);
        if (url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost')) { return; }
        const location = fileURLToPath(url);
        const stat = await fs.lstat(location);
        if (stat.isSymbolicLink()) { throw new Error('教学工程不支持符号链接入口'); }
        let roots = [location];
        if (stat.isFile()) {
            if (stat.size > 512 * 1024 || !/\.(theia-workspace|code-workspace)$/i.test(location)) { return; }
            const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW);
            let workspace;
            try { workspace = parseJsonc(await file.readFile('utf8')); } finally { await file.close(); }
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
            const id = await this.storage.authorizeWorkspace(root);
            if (sequence !== this.sequence) { this.storage.revokeWorkspace(id); return; }
            if (!this.grants.some(g => g.id === id)) { this.grants.push({ id, root, uri: pathToFileURL(candidate).href }); }
        }
    }
    async list(): Promise<{ id: string; uri: string }[]> { await this.pending; return this.grants.map(({ id, uri }) => ({ id, uri })); }
    async context(id: string, buffer?: TutorBuffer): Promise<TutorProjectContext> {
        await this.authorize(id, buffer);
        const grant = this.grants.find(g => g.id === id)!;
        const files: string[] = [];
        let visited = 0, pathBytes = 0;
        const walk = async (relative: string, depth: number): Promise<void> => {
            if (depth > 5 || visited > 3000 || files.length >= 200 || pathBytes >= 8000) { return; }
            for (const entry of await fs.readdir(path.join(grant.root, relative), { withFileTypes: true })) {
                if (++visited > 3000 || files.length >= 200 || pathBytes >= 8000) { break; }
                if (entry.name.startsWith('.') || /^(node_modules|build|target|Drivers|Middlewares|vendor)$/i.test(entry.name) || entry.isSymbolicLink()) { continue; }
                const name = relative ? `${relative}/${entry.name}` : entry.name;
                if (entry.isDirectory()) { await walk(name, depth + 1); }
                else if (entry.isFile() && /\.(c|h|cpp|hpp|cc)$/i.test(name) && name.length <= 240) { files.push(name); pathBytes += name.length; }
            }
        };
        await walk('', 0);
        let mcu = '未知', sdk = '未知';
        try {
            const file = await fs.open(path.join(grant.root, 'nodu.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            try {
                if ((await file.stat()).size <= 32000) {
                    const data = JSON.parse(await file.readFile('utf8'));
                    if (typeof data?.target?.mcu === 'string') { mcu = data.target.mcu.slice(0, 80); }
                    if (typeof data?.sdk === 'string') { sdk = data.sdk.slice(0, 80); }
                }
            } finally { await file.close(); }
        } catch { /* Missing metadata is explicitly unknown, never inferred from a board name. */ }
        const declarations: { path: string; text: string }[] = [];
        if (buffer) {
            const names = new Set(['main.h', 'board.h', ...Array.from(buffer.text.matchAll(/^\s*#\s*include\s*"([^"]+)"/gm), m => m[1])]);
            let budget = 8000;
            for (const relative of files.filter(f => /\.h$/i.test(f) && (names.has(f) || names.has(path.basename(f)))).slice(0, 8)) {
                await this.authorize(id, { path: relative, text: '', version: 1, line: 1 });
                const file = await fs.open(path.join(grant.root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
                try {
                    if ((await file.stat()).size > budget) { continue; }
                    const text = await file.readFile('utf8');
                    budget -= text.length; declarations.push({ path: relative, text });
                } finally { await file.close(); }
            }
        }
        let build: TutorProjectContext['build'];
        if (mcu !== '未知' && this.buildStatus) {
            try { build = await this.buildStatus(grant.root); }
            catch { build = { status: 'unavailable', scope: 'saved-project' }; }
            if (!buffer) { delete build.runtime; }
            if (buffer) {
                const file = await fs.open(path.join(grant.root, buffer.path), constants.O_RDONLY | constants.O_NOFOLLOW);
                try { build.currentBufferSaved = (await file.stat()).size <= 32000 && await file.readFile('utf8') === buffer.text; }
                finally { await file.close(); }
                if (!build.currentBufferSaved) { delete build.runtime; }
            }
        }
        const localCheck = buffer ? await this.checker.inspect(buffer) : undefined;
        if (!this.grants.includes(grant)) { throw new Error('工程授权已失效'); }
        return { key: await TutorProgressStore.projectKey(grant.root), mcu, sdk, files: files.sort(),
            ...(localCheck ? { localCheck } : {}), ...(declarations.length ? { declarations } : {}), ...(build ? { build } : {}) };
    }
    async reference(id: string, relative: string, line: number): Promise<{ path: string; line: number }> {
        await this.authorize(id, { path: relative, text: '', version: 1, line: 1 });
        const grant = this.grants.find(g => g.id === id)!;
        const file = await fs.open(path.join(grant.root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            if ((await file.stat()).size > 32000) { throw new Error('教学代码文件超过32 KB'); }
            const text = await file.readFile('utf8');
            if (!Number.isInteger(line) || line < 1 || line > text.split('\n').length) { throw new Error('代码行号无效'); }
            await this.authorize(id, { path: relative, text, version: 1, line });
            return { path: relative, line };
        } finally { await file.close(); }
    }
    async authorize(id: string, buffer?: TutorBuffer): Promise<void> {
        await this.pending;
        const grant = this.grants.find(g => g.id === id);
        if (!grant) { throw new Error('工程授权已失效'); }
        if (buffer === undefined) { return; }
        if (!buffer || Object.keys(buffer).some(k => !['path','text','version','line'].includes(k)) || typeof buffer.path !== 'string' || !buffer.path
            || buffer.path.length > 1024 || buffer.path.includes('\\') || buffer.path.includes('\0') || buffer.path.split('/').some(p => p === '..' || p === '.' || p === '')
            || path.isAbsolute(buffer.path) || !/\.(c|h|cpp|hpp|cc)$/i.test(buffer.path)
            || typeof buffer.text !== 'string' || buffer.text.length > 32000 || buffer.text.includes('\0')
            || !Number.isSafeInteger(buffer.version) || buffer.version < 1 || !Number.isInteger(buffer.line) || buffer.line < 1 || buffer.line > buffer.text.split('\n').length) { throw new Error('代码上下文无效或超过 32 KB'); }
        const target = path.resolve(grant.root, buffer.path);
        const real = await fs.realpath(target);
        if (real !== target || !real.startsWith(grant.root + path.sep) || !(await fs.stat(real)).isFile()) { throw new Error('代码上下文不在当前工程'); }
        if (!this.grants.includes(grant)) { throw new Error('工程授权已失效'); }
    }
    dispose(): void { ++this.sequence; for (const g of this.grants) { this.revokeChat(g.id); } this.grants = []; this.storage.dispose(); }
}
