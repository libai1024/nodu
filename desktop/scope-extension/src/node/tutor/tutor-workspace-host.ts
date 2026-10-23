// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseJsonc } from 'jsonc-parser';
import type { TutorBuffer } from '../../common/tutor/tutor-ai-protocol';
import { TutorStorageConnection } from './tutor-storage-server';

/** Uses the existing Theia workspace-open lifecycle, never recent-workspace history as a grant. */
export class TutorWorkspaceHost {
    private current = '';
    private sequence = 0;
    private grants: { id: string; uri: string; root: string }[] = [];
    private pending: Promise<void> = Promise.resolve();
    constructor(private readonly storage: TutorStorageConnection, private readonly revokeChat: (id: string) => void) { }
    async select(uri: string): Promise<void> {
        if (typeof uri !== 'string' || uri.length > 8192) { throw new Error('工程地址无效'); }
        if (uri === this.current) { return this.pending; }
        this.current = uri;
        const sequence = ++this.sequence;
        for (const grant of this.grants) { this.storage.revokeWorkspace(grant.id); this.revokeChat(grant.id); }
        this.grants = [];
        this.pending = this.resolve(uri, sequence);
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
