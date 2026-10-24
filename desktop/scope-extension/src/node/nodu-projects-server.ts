// SPDX-License-Identifier: MIT
// Recent projects and examples for the desktop launcher. Nodu keeps its own list next to
// Theia's recentworkspace.json because Theia drops folders that no longer exist, while the
// launcher shows them greyed out as 找不到 until the user removes them.
import { constants, promises as fs } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { inject, injectable } from '@theia/core/shared/inversify';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { WorkspaceServer } from '@theia/workspace/lib/common/workspace-protocol';
import { ExampleProject, NoduProjectsService, RecentProject } from '../common/nodu-launcher-protocol';
import { mergeRecent, pathKey, projectTag, readmeSummary, StoredProject, touchRecent, uniqueName } from '../common/nodu-launcher-util';

const STORE = 'nodu-recent-projects.json';
const MAX_MANIFEST = 256 * 1024;
/** Build output and per-machine state never travel with a copied example. */
const SKIP_COPY = /[\\/](?:\.theia|\.nodu|build|__pycache__|\.DS_Store)$/;

async function readJson(file: string): Promise<unknown> {
    try {
        const stat = await fs.stat(file);
        if (!stat.isFile() || stat.size > MAX_MANIFEST) { return undefined; }
        return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch { return undefined; }
}

/** A transient read error must not erase a remembered project identity. */
async function folderIdentity(folder: string): Promise<{ known: boolean; tag?: string }> {
    const folderStat = await fs.stat(folder).catch(() => undefined);
    if (!folderStat?.isDirectory()) { return { known: false }; }
    const read = async (name: string): Promise<{ known: boolean; value?: unknown }> => {
        const file = join(folder, name); let observed = false;
        try {
            const before = await fs.lstat(file); observed = true;
            if (!before.isFile() || before.size > MAX_MANIFEST) { return { known: false }; }
            const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
            try {
                const opened = await handle.stat();
                if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > MAX_MANIFEST) { return { known: false }; }
                const bytes = Buffer.alloc(MAX_MANIFEST + 1); let length = 0;
                while (length < bytes.length) {
                    const part = await handle.read(bytes, length, bytes.length - length, length);
                    if (!part.bytesRead) { break; } length += part.bytesRead;
                }
                const after = await handle.stat(), current = await fs.lstat(file);
                if (length > MAX_MANIFEST || length !== after.size || !current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino
                    || current.size !== after.size || current.mtimeMs !== after.mtimeMs || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) { return { known: false }; }
                return { known: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))) };
            } finally { await handle.close(); }
        } catch (error) { return { known: !observed && (error as NodeJS.ErrnoException).code === 'ENOENT' }; }
    };
    const [nodu, board] = await Promise.all([read('nodu.json'), read('board.json')]);
    const current = await fs.stat(folder).catch(() => undefined);
    if (!current?.isDirectory() || current.dev !== folderStat.dev || current.ino !== folderStat.ino) { return { known: false }; }
    const noduTag = nodu.known ? projectTag({ nodu: nodu.value }) : undefined;
    return { known: nodu.known && (noduTag !== undefined || board.known),
        tag: noduTag ?? projectTag({ board: board.value }) };
}

async function folderTag(folder: string): Promise<string | undefined> {
    return (await folderIdentity(folder)).tag;
}

function requireAbsolute(fsPath: unknown): string {
    if (typeof fsPath !== 'string' || !isAbsolute(fsPath)) { throw new Error('需要项目的绝对路径。'); }
    return fsPath;
}

@injectable()
export class NoduProjectsServer implements NoduProjectsService {
    @inject(EnvVariablesServer) protected readonly env!: EnvVariablesServer;
    @inject(WorkspaceServer) protected readonly workspaces!: WorkspaceServer;
    /** Serializes store writes so two windows recording at once do not drop an entry. */
    private queue: Promise<unknown> = Promise.resolve();

    async recent(): Promise<RecentProject[]> {
        const [stored, roots] = await Promise.all([this.load(), this.workspaces.getRecentWorkspaces().catch(() => [] as string[])]);
        const merged = mergeRecent(stored, roots.map(uri => (uri.startsWith('file:') ? FileUri.fsPath(uri) : uri)));
        const tags = new Map<string, string | undefined>();
        const rows = await Promise.all(merged.map(async (item): Promise<RecentProject | undefined> => {
            const stat = await fs.stat(item.path).catch(() => undefined);
            // Theia also lists workspace files (untitled multi-root workspaces); Nodu projects are folders.
            if (stat && !stat.isDirectory()) { return undefined; }
            const identity = stat ? await folderIdentity(item.path) : { known: false };
            if (identity.known) { tags.set(pathKey(item.path), identity.tag); }
            return { path: item.path, name: basename(item.path) || item.path, lastOpened: item.lastOpened, missing: !stat,
                tag: identity.known ? identity.tag : item.tag };
        }));
        if (stored.some(item => tags.has(pathKey(item.path)) && item.tag !== tags.get(pathKey(item.path)))) {
            // Identity caching is optional. A read-only profile must still list projects.
            await this.update(current => current.map(item => {
                const key = pathKey(item.path), previous = stored.find(p => pathKey(p.path) === key);
                return tags.has(key) && previous && previous.tag === item.tag && previous.lastOpened === item.lastOpened
                    ? { ...item, tag: tags.get(key) } : item;
            })).catch(() => undefined);
        }
        return rows.filter((row): row is RecentProject => !!row);
    }

    touch(fsPath: string): Promise<void> {
        const path = requireAbsolute(fsPath);
        return this.update(async stored => {
            const identity = await folderIdentity(path);
            return touchRecent(stored, path, Date.now()).map(item =>
                pathKey(item.path) === pathKey(path) && identity.known ? { ...item, tag: identity.tag } : item);
        });
    }

    async remove(fsPath: string): Promise<void> {
        const path = requireAbsolute(fsPath);
        await this.update(stored => stored.filter(item => pathKey(item.path) !== pathKey(path)));
        await this.workspaces.removeRecentWorkspace(FileUri.create(path).toString()).catch(() => undefined);
    }

    async examples(): Promise<ExampleProject[]> {
        const root = await this.examplesDir();
        if (!root) { return []; }
        const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
        const examples = await Promise.all(entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(async entry => {
            const path = join(root, entry.name);
            const { title, summary } = readmeSummary(await fs.readFile(join(path, 'README.md'), 'utf8').catch(() => ''));
            return { path, name: entry.name === 'board-api' ? 'K210 板端接口' : title || entry.name, summary, tag: await folderTag(path) };
        }));
        return examples.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }

    async copyExample(examplePath: string): Promise<string> {
        const root = await this.examplesDir();
        const source = await fs.realpath(requireAbsolute(examplePath)).catch(() => undefined);
        if (!root || !source || dirname(source) !== root) { throw new Error('只能复制内置示例。'); }
        const parent = await this.projectsDir();
        const taken = new Set(await fs.readdir(parent).catch(() => [] as string[]));
        for (let attempt = 0; attempt < 1000; attempt++) {
            const name = uniqueName(basename(source), candidate => taken.has(candidate));
            const target = join(parent, name);
            try { await fs.mkdir(target); }
            catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') { taken.add(name); continue; }
                throw error;
            }
            try {
                for (const entry of await fs.readdir(source)) {
                    await fs.cp(join(source, entry), join(target, entry), { recursive: true, errorOnExist: true, force: false,
                        filter: async path => !SKIP_COPY.test(path) && !(await fs.lstat(path)).isSymbolicLink() });
                }
                return target;
            } catch (error) {
                // Only this invocation owns the newly reserved target folder.
                await fs.rm(target, { recursive: true, force: true });
                throw error;
            }
        }
        throw new Error('无法创建示例副本。');
    }

    async projectsDir(): Promise<string> {
        // The Electron main process sets this from app.getPath('documents'), which follows folder redirection.
        const dir = process.env.NODU_PROJECTS_DIR || join(homedir(), 'Documents', 'Nodu');
        await fs.mkdir(dir, { recursive: true });
        return dir;
    }

    /** Shipped example projects: `desktop/examples` beside the extension, or NODU_EXAMPLES_DIR. */
    protected async examplesDir(): Promise<string | undefined> {
        const extension = this.extensionDirectory();
        const candidates = process.env.NODU_EXAMPLES_DIR ? [process.env.NODU_EXAMPLES_DIR]
            : [join(extension, 'resources/project-examples'), join(extension, '..', 'examples')];
        for (const dir of candidates) {
            const real = await fs.realpath(dir).catch(() => undefined);
            if (real && (await fs.stat(real)).isDirectory()) { return real; }
        }
        return undefined;
    }

    protected extensionDirectory(): string { return dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json')); }

    private async storeFile(): Promise<string> {
        return join(FileUri.fsPath(await this.env.getConfigDirUri()), STORE);
    }

    private async load(): Promise<StoredProject[]> {
        const data = await readJson(await this.storeFile()) as { projects?: unknown } | undefined;
        const list: unknown[] = Array.isArray(data?.projects) ? data.projects : [];
        return list.flatMap(item => {
            const { path, lastOpened, tag } = (item ?? {}) as { path?: unknown; lastOpened?: unknown; tag?: unknown };
            return typeof path === 'string' && isAbsolute(path) ? [{ path, lastOpened: typeof lastOpened === 'number' && Number.isFinite(lastOpened) ? lastOpened : undefined,
                tag: typeof tag === 'string' && !/[\u0000-\u001f]/.test(tag) ? tag.trim().slice(0, 16) || undefined : undefined }] : [];
        });
    }

    private update(change: (stored: StoredProject[]) => StoredProject[] | Promise<StoredProject[]>): Promise<void> {
        const run = this.queue.then(async () => {
            const file = await this.storeFile();
            const next = await change(await this.load());
            await fs.mkdir(dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await fs.writeFile(temporary, JSON.stringify({ projects: next }, null, 2) + '\n');
            await fs.rename(temporary, file);
        });
        this.queue = run.catch(() => undefined);
        return run;
    }
}
