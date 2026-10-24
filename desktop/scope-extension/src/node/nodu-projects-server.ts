// SPDX-License-Identifier: MIT
// Recent projects and examples for the desktop launcher. Nodu keeps its own list next to
// Theia's recentworkspace.json because Theia drops folders that no longer exist, while the
// launcher shows them greyed out as 找不到 until the user removes them.
import { promises as fs } from 'node:fs';
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

async function folderTag(folder: string): Promise<string | undefined> {
    return projectTag({ nodu: await readJson(join(folder, 'nodu.json')), board: await readJson(join(folder, 'board.json')) });
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
        const rows = await Promise.all(merged.map(async (item): Promise<RecentProject | undefined> => {
            const stat = await fs.stat(item.path).catch(() => undefined);
            // Theia also lists workspace files (untitled multi-root workspaces); Nodu projects are folders.
            if (stat && !stat.isDirectory()) { return undefined; }
            return { path: item.path, name: basename(item.path) || item.path, lastOpened: item.lastOpened, missing: !stat,
                tag: stat ? await folderTag(item.path) : undefined };
        }));
        return rows.filter((row): row is RecentProject => !!row);
    }

    touch(fsPath: string): Promise<void> {
        const path = requireAbsolute(fsPath);
        return this.update(stored => touchRecent(stored, path, Date.now()));
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
            const { path, lastOpened } = (item ?? {}) as { path?: unknown; lastOpened?: unknown };
            return typeof path === 'string' && isAbsolute(path) ? [{ path, lastOpened: typeof lastOpened === 'number' ? lastOpened : undefined }] : [];
        });
    }

    private update(change: (stored: StoredProject[]) => StoredProject[]): Promise<void> {
        const run = this.queue.then(async () => {
            const file = await this.storeFile();
            const next = change(await this.load());
            await fs.mkdir(dirname(file), { recursive: true });
            const temporary = `${file}.${process.pid}.tmp`;
            await fs.writeFile(temporary, JSON.stringify({ projects: next }, null, 2) + '\n');
            await fs.rename(temporary, file);
        });
        this.queue = run.catch(() => undefined);
        return run;
    }
}
