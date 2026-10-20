// SPDX-License-Identifier: MIT
// File/help menu parity with MaixPy IDE 0.2.5: new-script template, the
// ~/Documents/Nodu folder (original used MaixPy), the bundled-examples
// submenu, upstream doc/forum links and the about dialog.
import * as React from '@theia/core/shared/react';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandContribution, CommandRegistry, Disposable, DisposableCollection, MenuContribution, MenuModelRegistry, URI } from '@theia/core/lib/common';
import { MessageService } from '@theia/core/lib/common/message-service';
import { EnvVariablesServer } from '@theia/core/lib/common/env-variables';
import { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { UntitledResourceResolver } from '@theia/core/lib/common/resource';
import { FileUri } from '@theia/core/lib/common/file-uri';
import { FrontendApplicationContribution, CommonCommands, CommonMenus } from '@theia/core/lib/browser';
import { OpenerService, open } from '@theia/core/lib/browser/opener-service';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { environment } from '@theia/application-package/lib/environment';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { EditorManager } from '@theia/editor/lib/browser/editor-manager';
import { MonacoEditor } from '@theia/monaco/lib/browser/monaco-editor';
import * as monaco from '@theia/monaco-editor-core';
import { NoduResources } from './nodu-resources-client';
import { buildExampleTree, MAX_EXAMPLE_DEPTH, MAX_EXAMPLE_FILES } from '../common/nodu-examples';
import { pushRecentFile, removeRecentFile, RECENT_FILES_MAX } from '../common/nodu-editor-menu';
import { LocalStorageService } from '@theia/core/lib/browser/storage-service';
import { isOSX } from '@theia/core/lib/common/os';

const MAIXPY_DOCS_URL = 'https://maixpy.sipeed.com/';
const MAIXPY_FORUM_URL = 'https://bbs.sipeed.com/';
const MAIXPY_EXAMPLES_URL = 'https://github.com/sipeed/MaixPy_scripts';
export const MAIXPY_RELEASES_URL = 'https://github.com/sipeed/MaixPy/releases';
const FALLBACK_VERSION = '0.1.4';

/** MaixPy IDE 0.2.5 new-file template, byte-identical to libOpenMV.dylib / af179e44. */
function newScriptTemplate(user: string): string {
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    return `# Untitled - By: ${user} - ${date}\n`
        + '\n'
        + 'import sensor, image, time\n'
        + '\n'
        + 'sensor.reset()\n'
        + 'sensor.set_pixformat(sensor.RGB565)\n'
        + 'sensor.set_framesize(sensor.QVGA)\n'
        + 'sensor.skip_frames(time = 2000)\n'
        + '\n'
        + 'clock = time.clock()\n'
        + '\n'
        + 'while(True):\n'
        + '    clock.tick()\n'
        + '    img = sensor.snapshot()\n'
        + '    print(clock.fps())\n';
}

/** Version plus the OpenMV MIT attribution line, in the app's dialog style. */
export class NoduAboutDialog extends ReactDialog<void> {
    constructor(props: DialogProps, private readonly version: string) {
        super(props);
        this.node.classList.add('nodu-about-dialog');
        this.contentNode.classList.add('scope-widget');
        this.appendAcceptButton('关闭');
    }

    get value(): void { return undefined; }

    protected render(): React.ReactNode {
        return <div className="nodu-about">
            <p className="nodu-about-name"><strong>见微 · Nodu</strong></p>
            <p>版本 {this.version}</p>
            <p className="scope-helper">K210 视觉开发工作台，基于 Eclipse Theia。</p>
            <p className="scope-helper">功能参考实现：OpenMV IDE 插件（openmv/qt-creator @ af179e44，MIT · © 2016 OpenMV, LLC）及 MaixPy IDE 0.2.5 公开行为，详见 THIRD-PARTY-NOTICES。</p>
        </div>;
    }
}

interface ExampleEntry { rel: string; uri: URI; }

@injectable()
export class NoduFileDocsContribution implements CommandContribution, MenuContribution, FrontendApplicationContribution {
    @inject(MessageService) protected readonly messages!: MessageService;
    @inject(OpenerService) protected readonly opener!: OpenerService;
    @inject(FileService) protected readonly files!: FileService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(EnvVariablesServer) protected readonly env!: EnvVariablesServer;
    @inject(ApplicationServer) protected readonly appServer!: ApplicationServer;
    @inject(UntitledResourceResolver) protected readonly untitled!: UntitledResourceResolver;
    @inject(NoduResources) protected readonly resources!: NoduResources;
    @inject(CommandRegistry) protected readonly commands!: CommandRegistry;
    @inject(MenuModelRegistry) protected readonly menus!: MenuModelRegistry;
    private examplesSubmenu?: Disposable;
    private readonly exampleDisposables = new DisposableCollection();
    private documentsDisposables = new DisposableCollection();
    private recentDisposables = new DisposableCollection();
    private readonly lifecycleDisposables = new DisposableCollection();
    private recentFiles: string[] = [];
    @inject(LocalStorageService) protected readonly storage!: LocalStorageService;

    registerCommands(registry: CommandRegistry): void {
        registry.registerCommand({ id: 'scope.new-script', label: '新建文件...', category: '见微 Nodu' }, {
            execute: () => this.newScript().catch(error => this.messages.error(`新建脚本：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.documents-folder', label: '文档文件夹', category: '见微 Nodu' }, {
            execute: () => this.documentsFolder().catch(error => this.messages.error(`文档文件夹：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.more-examples', label: '更多示例', category: '见微 Nodu' }, {
            execute: () => open(this.opener, new URI(MAIXPY_EXAMPLES_URL)).catch(error => this.messages.error(`更多示例：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.help-docs', label: 'MaixPy文档', category: '见微 Nodu' }, {
            execute: () => open(this.opener, new URI(MAIXPY_DOCS_URL)).catch(error => this.messages.error(`MaixPy文档：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.help-forum', label: 'MaixPy论坛', category: '见微 Nodu' }, {
            execute: () => open(this.opener, new URI(MAIXPY_FORUM_URL)).catch(error => this.messages.error(`MaixPy论坛：${error instanceof Error ? error.message : String(error)}`)),
        });
        registry.registerCommand({ id: 'scope.about', label: '关于 Nodu', category: '见微 Nodu' }, {
            execute: () => this.about().catch(error => this.messages.error(`关于：${error instanceof Error ? error.message : String(error)}`)),
        });
        // Placeholder row for an empty/missing documents folder (original
        // disables the item instead of hiding the submenu).
        registry.registerCommand({ id: 'scope.documents-folder.empty' }, {
            isEnabled: () => false,
            execute: () => undefined,
        });
        registry.registerCommand({ id: 'scope.recent-files.clear', label: '清除菜单', category: '见微 Nodu' }, {
            execute: () => this.clearRecentFiles().catch(error => this.messages.error(`最近的文件：${error instanceof Error ? error.message : String(error)}`)),
        });
    }

    registerMenus(menus: MenuModelRegistry): void {
        menus.registerMenuAction(CommonMenus.FILE_NEW_TEXT, { commandId: 'scope.new-script', order: '0' });
        const group = [...CommonMenus.FILE, '2z_nodu'];
        menus.registerSubmenu([...group, 'documents'], '文档文件夹', { sortString: '0' });
        this.examplesSubmenu = menus.registerSubmenu([...group, 'examples'], '示例', { sortString: '1' });
        menus.registerMenuAction(group, { commandId: 'scope.more-examples', order: '2' });
        menus.registerSubmenu([...group, 'recent'], '最近的文件', { sortString: '3' });
        menus.registerMenuAction(CommonMenus.HELP, { commandId: 'scope.help-docs', order: '0' });
        menus.registerMenuAction(CommonMenus.HELP, { commandId: 'scope.help-forum', order: '1' });
        menus.registerMenuAction(CommonMenus.HELP, { commandId: 'scope.about', order: '9' });
    }

    async onStart(): Promise<void> {
        // The stock Theia About slot becomes the Nodu product dialog.
        this.menus.unregisterMenuAction(CommonCommands.ABOUT_COMMAND.id, CommonMenus.HELP);
        void this.initRecentFiles();
        void this.initDocumentsMenu();
        await this.registerExamples().catch(() => { this.examplesSubmenu?.dispose(); this.examplesSubmenu = undefined; });
    }

    /** 文档文件夹 submenu content: .py under ~/Documents/Nodu (rules shared
     * with the examples tree), rebuilt on file-system changes underneath. */
    private async initDocumentsMenu(): Promise<void> {
        const home = await this.env.getHomeDirUri();
        const folder = new URI(home).resolve('Documents/Nodu');
        this.lifecycleDisposables.push(this.files.watch(folder, { recursive: true, excludes: [] }));
        this.lifecycleDisposables.push(this.files.onDidFilesChange(event => {
            if (event.contains(folder)) {
                void this.refreshDocumentsMenu().catch(() => undefined);
            }
        }));
        await this.refreshDocumentsMenu();
    }

    private async refreshDocumentsMenu(): Promise<void> {
        this.documentsDisposables.dispose();
        this.documentsDisposables = new DisposableCollection();
        const home = await this.env.getHomeDirUri();
        const folder = new URI(home).resolve('Documents/Nodu');
        const base = [...CommonMenus.FILE, '2z_nodu', 'documents'];
        const found = await this.collectExamples(folder).catch(() => [] as ExampleEntry[]);
        if (!found.length) {
            this.documentsDisposables.push(this.menus.registerMenuAction([...base, '0_empty'], {
                commandId: 'scope.documents-folder.empty',
                label: `将一些代码添加到“${FileUri.fsPath(folder)}”`,
            }));
        } else {
            const uriByRel = new Map(found.map(entry => [entry.rel, entry.uri]));
            const tree = buildExampleTree(found.map(entry => entry.rel));
            for (const submenu of tree.submenus) {
                this.documentsDisposables.push(this.menus.registerSubmenu(
                    [...base, ...submenu.segments],
                    submenu.segments[submenu.segments.length - 1],
                    { sortString: submenu.order }));
            }
            tree.files.forEach((file, index) => {
                const rel = [...file.dir, file.name].join('/');
                const uri = uriByRel.get(rel);
                if (!uri) { return; }
                const id = `scope.documents-file.${index}`;
                this.documentsDisposables.push(this.commands.registerCommand(
                    { id, label: `打开 ${rel}`, category: '见微 Nodu' },
                    { execute: () => open(this.opener, uri).catch(error => this.messages.error(`文档文件夹：${error instanceof Error ? error.message : String(error)}`)) }));
                this.documentsDisposables.push(this.menus.registerMenuAction(
                    file.dir.length ? [...base, ...file.dir] : [...base, '0_files'],
                    { commandId: id, label: file.name, order: file.order }));
            });
        }
        this.documentsDisposables.push(this.menus.registerMenuAction([...base, '9_open'], {
            commandId: 'scope.documents-folder',
            label: isOSX ? '在访达中打开' : '在文件管理器中打开',
        }));
    }

    /** 最近的文件: last 10 file:// editors, user-global via LocalStorage. */
    private async initRecentFiles(): Promise<void> {
        this.recentFiles = (await this.storage.getData<string[]>('nodu.recent-files', []) ?? [])
            .filter((item): item is string => typeof item === 'string')
            .slice(0, RECENT_FILES_MAX);
        this.lifecycleDisposables.push(this.editors.onCurrentEditorChanged(widget => {
            const uri = widget?.editor.uri;
            if (uri?.scheme === 'file') { void this.recordRecentFile(FileUri.fsPath(uri)); }
        }));
        const current = this.editors.currentEditor?.editor.uri;
        if (current?.scheme === 'file') { void this.recordRecentFile(FileUri.fsPath(current)); }
        await this.refreshRecentMenu();
    }

    private async recordRecentFile(path: string): Promise<void> {
        this.recentFiles = pushRecentFile(this.recentFiles, path);
        await this.storage.setData('nodu.recent-files', this.recentFiles);
        await this.refreshRecentMenu();
    }

    private async openRecentFile(path: string): Promise<void> {
        const uri = FileUri.create(path);
        if (!await this.files.exists(uri)) {
            await this.messages.info(`文件不存在：${path}`);
            this.recentFiles = removeRecentFile(this.recentFiles, path);
            await this.storage.setData('nodu.recent-files', this.recentFiles);
            await this.refreshRecentMenu();
            return;
        }
        await open(this.opener, uri);
    }

    private async clearRecentFiles(): Promise<void> {
        this.recentFiles = [];
        await this.storage.setData('nodu.recent-files', []);
        await this.refreshRecentMenu();
    }

    private async refreshRecentMenu(): Promise<void> {
        this.recentDisposables.dispose();
        this.recentDisposables = new DisposableCollection();
        const base = [...CommonMenus.FILE, '2z_nodu', 'recent'];
        this.recentFiles.forEach((path, index) => {
            const id = `scope.recent-file.${index}`;
            this.recentDisposables.push(this.commands.registerCommand(
                { id, label: `打开最近的文件 ${path}` },
                { execute: () => this.openRecentFile(path).catch(error => this.messages.error(`最近的文件：${error instanceof Error ? error.message : String(error)}`)) }));
            this.recentDisposables.push(this.menus.registerMenuAction(
                [...base, '0_items'], { commandId: id, label: path, order: index.toString().padStart(4, '0') }));
        });
        this.recentDisposables.push(this.menus.registerMenuAction(
            [...base, '1_clear'], { commandId: 'scope.recent-files.clear' }));
    }

    /** Examples come from the user resource dir (~/.nodu/resources) once the
     * backend has applied the bundled baseline; it falls back to the bundled
     * tree itself when the startup reset failed. */
    private async registerExamples(): Promise<void> {
        const { examplesDir } = await this.resources.ready();
        const found = await this.collectExamples(FileUri.create(examplesDir));
        if (!found.length) {
            this.examplesSubmenu?.dispose();
            this.examplesSubmenu = undefined;
            return;
        }
        const uriByRel = new Map(found.map(entry => [entry.rel, entry.uri]));
        const tree = buildExampleTree(found.map(entry => entry.rel));
        const examplesPath = [...CommonMenus.FILE, '2z_nodu', 'examples'];
        for (const submenu of tree.submenus) {
            this.exampleDisposables.push(this.menus.registerSubmenu(
                [...examplesPath, ...submenu.segments],
                submenu.segments[submenu.segments.length - 1],
                { sortString: submenu.order }));
        }
        tree.files.forEach((file, index) => {
            const rel = [...file.dir, file.name].join('/');
            const uri = uriByRel.get(rel);
            if (!uri) { return; }
            const id = `scope.example.${index}`;
            this.exampleDisposables.push(this.commands.registerCommand(
                { id, label: `打开示例 ${rel}`, category: '见微 Nodu' },
                { execute: () => this.openExample(uri).catch(error => this.messages.error(`示例：${error instanceof Error ? error.message : String(error)}`)) }));
            this.exampleDisposables.push(this.menus.registerMenuAction(
                file.dir.length ? [...examplesPath, ...file.dir] : examplesPath,
                { commandId: id, label: file.name, order: file.order }));
        });
    }

    private async collectExamples(base: URI): Promise<ExampleEntry[]> {
        const entries: ExampleEntry[] = [];
        const walk = async (dir: URI, rel: string, depth: number): Promise<void> => {
            if (depth > MAX_EXAMPLE_DEPTH || entries.length >= MAX_EXAMPLE_FILES) { return; }
            const stat = await this.files.resolve(dir).catch(() => undefined);
            for (const child of stat?.children ?? []) {
                if (entries.length >= MAX_EXAMPLE_FILES) { return; }
                if (child.name.startsWith('.') || child.name === '__pycache__') { continue; }
                if (child.isDirectory) { await walk(child.resource, rel ? `${rel}/${child.name}` : child.name, depth + 1); }
                else if (/\.py$/i.test(child.name)) { entries.push({ rel: rel ? `${rel}/${child.name}` : child.name, uri: child.resource }); }
            }
        };
        await walk(base, '', 0);
        return entries;
    }

    /** Examples open as new untitled documents (I3.1 打开为新文件), never for editing on disk. */
    protected async openExample(uri: URI): Promise<void> {
        const content = await this.files.readFile(uri);
        await this.openUntitled(new TextDecoder().decode(content.value.buffer), '.py');
    }

    protected async newScript(): Promise<void> {
        const user = (await this.env.getValue('USER'))?.value
            || (await this.env.getValue('USERNAME'))?.value
            || 'user';
        await this.openUntitled(newScriptTemplate(user), '.py');
    }

    private async openUntitled(content: string, extension: string): Promise<void> {
        const uri = this.untitled.createUntitledURI(extension);
        await this.untitled.createUntitledResource(content, extension, uri);
        const widget = await this.editors.open(uri, { mode: 'activate' });
        const model = MonacoEditor.get(widget)?.getControl()?.getModel();
        if (model && model.getLanguageId() !== 'python') {
            monaco.editor.setModelLanguage(model, 'python');
        }
    }

    protected async documentsFolder(): Promise<void> {
        const home = await this.env.getHomeDirUri();
        const folder = new URI(home).resolve('Documents/Nodu');
        if (!await this.files.exists(folder)) { await this.files.createFolder(folder); }
        if (environment.electron.is()) {
            await open(this.opener, folder, { openExternalApp: true });
            return;
        }
        await this.messages.info(`文档目录已就绪：${folder.path.toString()}`);
    }

    protected async about(): Promise<void> {
        const info = await this.appServer.getApplicationInfo().catch(() => undefined);
        const dialog = new NoduAboutDialog({ title: '关于 Nodu' }, info?.version || FALLBACK_VERSION);
        await dialog.open();
    }
}
