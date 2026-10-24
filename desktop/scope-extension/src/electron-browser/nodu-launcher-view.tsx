// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { ThemeService } from '@theia/core/lib/browser/theming';
import type { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { ExampleProject, NoduProjectsService, RecentProject } from '../common/nodu-launcher-protocol';
import { relativeTime } from '../common/nodu-launcher-util';
import { launcherSearchMatch, nextLauncherIndex } from '../common/nodu-launcher-view-utils';
import type { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import type { ApplicationServer } from '@theia/core/lib/common/application-protocol';
import { ProjectIcon } from '../browser/nodu-project-icon';
import { SettingsPage, RowMenu, type LauncherMenuState } from './nodu-launcher-pages';
import { NoduBrand } from '../browser/scope-brand';
import type { NoduEmbeddedModel } from '../browser/nodu-embedded-model';
import { NewProjectForm } from '../browser/nodu-new-project';
import { SCOPE_LIGHT_THEME_ID, SCOPE_THEME_ID } from '../browser/scope-theme';

type LauncherView = 'projects' | 'examples' | 'create' | 'settings';

interface LauncherProps {
    projects: NoduProjectsService;
    open(path: string, keepLauncher?: boolean): Promise<void>;
    reveal?(path: string): Promise<void>;
    preferences?: PreferenceService;
    application?: Pick<ApplicationServer, 'getApplicationInfo'>;
    browse(): Promise<void>;
    themes: ThemeService;
    model: NoduEmbeddedModel;
    dialogs: FileDialogService;
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

function ThemeModeIcon({ dark }: { dark: boolean }): React.ReactElement {
    return <svg className="nodu-launcher-theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {dark ? <><circle cx="12" cy="12" r="4"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></>
            : <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>}
    </svg>;
}

export function Launcher({ projects, open, browse, themes, model, dialogs, preferences, reveal, application }: LauncherProps): React.ReactElement {
    const [view, setView] = React.useState<LauncherView>('projects');
    const [menu, setMenu] = React.useState<LauncherMenuState>();
    const menuAnchor = React.useRef<HTMLElement | undefined>(undefined);
    const [rows, setRows] = React.useState<RecentProject[]>([]);
    const [examples, setExamples] = React.useState<ExampleProject[]>([]);
    const [query, setQuery] = React.useState('');
    const [busyLabel, setBusyLabel] = React.useState('');
    const [loading, setLoading] = React.useState(true);
    const [examplesLoading, setExamplesLoading] = React.useState(false);
    const [examplesLoaded, setExamplesLoaded] = React.useState(false);
    const [exampleAttempt, setExampleAttempt] = React.useState(0);
    const [projectParent, setProjectParent] = React.useState('');
    const [parentLoading, setParentLoading] = React.useState(false);
    const [parentError, setParentError] = React.useState('');
    const [parentAttempt, setParentAttempt] = React.useState(0);
    const [error, setError] = React.useState('');
    const [recentError, setRecentError] = React.useState('');
    const [creating, setCreating] = React.useState(false);
    const creatingRef = React.useRef(false);
    const [exampleError, setExampleError] = React.useState('');
    const [exampleLoadError, setExampleLoadError] = React.useState('');
    const [themeType, setThemeType] = React.useState(themes.getCurrentTheme().type);
    const [version, setVersion] = React.useState('');
    const search = React.useRef<HTMLInputElement>(null);
    const newProject = React.useRef<HTMLButtonElement>(null);
    const navigation = React.useRef<Partial<Record<LauncherView, HTMLButtonElement | null>>>({});
    const list = React.useRef<HTMLUListElement>(null);
    const pending = React.useRef(false);
    const mounted = React.useRef(true);
    const recentGeneration = React.useRef(0);
    const examplesGeneration = React.useRef(0);
    const parentGeneration = React.useRef(0);
    const viewRef = React.useRef(view);
    viewRef.current = view;

    const refreshRecent = React.useCallback(async (showLoading = false): Promise<void> => {
        const generation = ++recentGeneration.current;
        if (showLoading) { setLoading(true); }
        try {
            const items = await projects.recent();
            if (mounted.current && generation === recentGeneration.current) { setRows(items); setRecentError(''); }
        } catch (err) {
            if (mounted.current && generation === recentGeneration.current) { setRecentError(messageOf(err)); }
        } finally {
            if (mounted.current && generation === recentGeneration.current) { setLoading(false); }
        }
    }, [projects]);

    React.useEffect(() => {
        mounted.current = true;
        const refresh = (): void => { if (!pending.current) { void refreshRecent(); } };
        void refreshRecent(true);
        window.addEventListener('focus', refresh);
        return () => {
            mounted.current = false;
            recentGeneration.current++;
            examplesGeneration.current++;
            parentGeneration.current++;
            window.removeEventListener('focus', refresh);
        };
    }, [refreshRecent]);

    React.useEffect(() => {
        const subscription = themes.onDidColorThemeChange(() => setThemeType(themes.getCurrentTheme().type));
        return () => subscription.dispose();
    }, [themes]);

    React.useEffect(() => {
        let active = true;
        setVersion('');
        void (async () => {
            try {
                const info = await application?.getApplicationInfo();
                if (active && typeof info?.version === 'string') { setVersion(info.version.trim()); }
            } catch { /* Version metadata does not block opening a project. */ }
        })();
        return () => { active = false; };
    }, [application]);

    React.useEffect(() => {
        if (view !== 'examples' || examplesLoaded) { return; }
        const generation = ++examplesGeneration.current;
        setExamplesLoading(true); setExampleLoadError('');
        void projects.examples().then(items => {
            if (mounted.current && generation === examplesGeneration.current) { setExamplesLoading(false); setExamples(items); setExamplesLoaded(true); }
        }).catch(err => {
            if (mounted.current && generation === examplesGeneration.current) { setExampleLoadError(messageOf(err)); }
        }).finally(() => {
            if (mounted.current && generation === examplesGeneration.current) { setExamplesLoading(false); }
        });
        return () => { examplesGeneration.current++; };
    }, [view, examplesLoaded, exampleAttempt, projects]);

    React.useEffect(() => {
        if (view !== 'create' || projectParent) { return; }
        const generation = ++parentGeneration.current;
        setParentLoading(true); setParentError('');
        void projects.projectsDir().then(parent => {
            if (mounted.current && generation === parentGeneration.current) { setParentLoading(false); setProjectParent(parent); }
        }).catch(err => {
            if (mounted.current && generation === parentGeneration.current) { setParentError(messageOf(err)); }
        }).finally(() => {
            if (mounted.current && generation === parentGeneration.current) { setParentLoading(false); }
        });
        return () => { parentGeneration.current++; };
    }, [view, projectParent, parentAttempt, projects]);

    const run = async (action: () => Promise<void>, label: string, trigger?: HTMLElement): Promise<void> => {
        if (pending.current || creatingRef.current || !mounted.current) { return; }
        const actionView = viewRef.current;
        pending.current = true; recentGeneration.current++; setLoading(false); setBusyLabel(label); setError(''); setExampleError('');
        try { await action(); }
        catch (err) {
            if (mounted.current) {
                const message = messageOf(err);
                if (actionView === 'examples') { setExampleError(message); } else { setError(message); }
            }
        } finally {
            pending.current = false;
            if (mounted.current) { setBusyLabel(''); }
            requestAnimationFrame(() => { if (trigger?.isConnected) { trigger.focus(); } });
        }
    };

    const selectView = (next: LauncherView): void => {
        if (pending.current || creatingRef.current) { return; }
        setView(next); setQuery(''); setError(''); setExampleError(''); setMenu(undefined);
        if (next !== 'create') { requestAnimationFrame(() => (search.current ?? newProject.current ?? navigation.current[next])?.focus()); }
    };
    const visible = rows.filter(row => launcherSearchMatch(row, query));
    const visibleExamples = examples.filter(example => launcherSearchMatch(example, query));
    const dark = themeType.toLowerCase().includes('dark');
    const busy = !!busyLabel;

    const focusProject = (index: number): void => {
        list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-row-open')[index]?.focus();
    };
    const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-row-open') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = nextLauncherIndex(current, event.key, buttons.length);
        if (next >= 0) { event.preventDefault(); focusProject(next); }
    };
    const removeRecent = (row: RecentProject, index: number): void => {
        const focusPath = visible[index + 1]?.path ?? visible[index - 1]?.path;
        void run(async () => {
            await projects.remove(row.path);
            if (!mounted.current) { return; }
            const items = await projects.recent();
            if (mounted.current) { setRows(items); }
            requestAnimationFrame(() => {
                const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-row-open') ?? []);
                const next = buttons.find(button => button.dataset.projectPath === focusPath);
                (next ?? search.current ?? newProject.current)?.focus();
            });
        }, '正在更新最近项目…');
    };

    const closeMenu = React.useCallback((): void => {
        const anchor = menuAnchor.current;
        menuAnchor.current = undefined;
        setMenu(undefined);
        if (anchor?.isConnected) { anchor.focus(); }
    }, []);
    const showMenu = (row: RecentProject, index: number, x: number, y: number, anchor: HTMLElement): void => {
        if (pending.current || creatingRef.current) { return; }
        menuAnchor.current = anchor;
        setMenu({ x, y, items: [
            { label: '在新窗口打开', disabled: row.missing, run: () => void run(async () => {
                await open(row.path, true);
                if (mounted.current) { await refreshRecent(); }
            }, '正在打开项目…', anchor) },
            ...(reveal ? [{ label: navigator.userAgent.includes('Mac') ? '在访达中显示' : '在文件管理器中显示', disabled: row.missing,
                run: () => void run(() => reveal(row.path), '正在打开文件夹…', anchor) }] : []),
            { label: '从列表移除', run: () => removeRecent(row, index) },
        ] });
    };
    const openRow = (row: RecentProject, trigger?: HTMLElement): void => {
        if (pending.current || creatingRef.current) { return; }
        if (row.missing) { setError(`找不到项目文件夹：${row.path}`); }
        else { void run(() => open(row.path), '正在打开项目…', trigger); }
    };
    const renderProject = (row: RecentProject, index: number): React.ReactElement => <li key={row.path}
        className={`nodu-launcher-row${row.missing ? ' is-missing' : ''}`}>
        <button type="button" className="nodu-launcher-row-open" data-project-path={row.path} title={row.path}
            disabled={busy} onClick={event => openRow(row, event?.currentTarget)}
            onContextMenu={event => { event.preventDefault(); showMenu(row, index, event.clientX, event.clientY, event.currentTarget); }}
            onKeyDown={event => {
                if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    const rect = event.currentTarget.getBoundingClientRect();
                    showMenu(row, index, rect.left + 24, rect.bottom, event.currentTarget); event.preventDefault();
                }
            }}>
            <ProjectIcon tag={row.tag} missing={row.missing}/>
            <span className="nodu-launcher-row-text"><strong>{row.name}</strong><span className="nodu-launcher-path">{row.path}</span></span>
            {row.missing ? <span className="nodu-launcher-tag is-missing">找不到</span>
                : row.tag ? <span className="nodu-launcher-tag">{row.tag}</span> : <span className="nodu-launcher-tag is-empty"/>}
            <span className="nodu-launcher-time">{row.lastOpened ? relativeTime(row.lastOpened) : ''}</span>
        </button>
        <button type="button" className="nodu-launcher-row-more" aria-label={`${row.name}：更多操作`} aria-haspopup="menu" title="更多操作" disabled={busy}
            onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); showMenu(row, index, rect.right - 180, rect.bottom + 2, event.currentTarget); }}>
            <i className="codicon codicon-ellipsis" aria-hidden="true"/>
        </button>
    </li>;
    const renderExample = (example: ExampleProject): React.ReactElement => <li key={example.path}>
        <button type="button" className="nodu-launcher-example" aria-label={`使用示例项目 ${example.name}，创建独立副本`} disabled={busy}
            onClick={event => void run(async () => {
                const copied = await projects.copyExample(example.path);
                if (mounted.current) { await open(copied); }
            }, '正在创建参考项目…', event?.currentTarget)}>
            <ProjectIcon tag={example.tag}/>
            <span className="nodu-launcher-row-text"><strong>{example.name}</strong></span>
            {example.tag && <span className="nodu-launcher-tag">{example.tag}</span>}
            <span className="nodu-launcher-example-action">创建副本</span>
        </button>
    </li>;
    const skeleton = (count: number): React.ReactElement => <ul className="nodu-launcher-list" aria-label="正在加载" role="status">
        {Array.from({ length: count }, (_, index) => <li key={index} className="nodu-launcher-skeleton"><span/><span/></li>)}
    </ul>;
    const nav = (id: LauncherView, icon: string, label: string): React.ReactElement => <button type="button"
        className={`nodu-launcher-nav-item${view === id ? ' is-current' : ''}`} title={label}
        ref={element => { navigation.current[id] = element; }}
        aria-current={view === id ? 'page' : undefined} disabled={busy || creating} onClick={() => selectView(id)}>
        <i className={`codicon codicon-${icon}`} aria-hidden="true"/><span>{label}</span>
    </button>;
    const isLoading = view === 'projects' ? loading : view === 'examples' ? examplesLoading : view === 'create' ? parentLoading : false;
    const emptyProjects = view === 'projects' && !loading && !recentError && rows.length === 0 && !query;
    return <main className="nodu-launcher scope-widget" aria-label="Nodu 工作台" aria-busy={busy || creating || isLoading}
        onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
            if (event.key === 'Escape' && view === 'create' && !creatingRef.current) { event.preventDefault(); selectView('projects'); }
            if (event.key === 'Escape' && document.activeElement === search.current && query) { event.preventDefault(); setQuery(''); }
        }}>
        <div className="nodu-launcher-window-drag" aria-hidden="true"/>
        <nav className="nodu-launcher-nav" aria-label="工作台导航">
            <div className="nodu-launcher-brand"><NoduBrand/>{version && <span className="nodu-launcher-version">{version}</span>}</div>
            <div className="nodu-launcher-nav-group">
                {nav('projects', 'history', '最近项目')}
                {nav('create', 'add', '新建项目')}
                <button type="button" className="nodu-launcher-nav-item" title="打开项目" disabled={busy || creating}
                    onClick={event => void run(browse, '正在打开项目…', event.currentTarget)}>
                    <i className="codicon codicon-folder-opened" aria-hidden="true"/><span>打开项目</span>
                </button>
                {nav('examples', 'book', '示例项目')}
            </div>
            <div className="nodu-launcher-nav-footer">
                {nav('settings', 'settings-gear', '设置')}
                <button type="button" className="nodu-launcher-theme" title={dark ? '切换到浅色主题' : '切换到深色主题'}
                    aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
                    onClick={() => themes.setCurrentTheme(dark ? SCOPE_LIGHT_THEME_ID : SCOPE_THEME_ID)}><ThemeModeIcon dark={dark}/></button>
            </div>
        </nav>
        <div className="nodu-launcher-main">
            {view === 'create' ? <section className="nodu-launcher-page nodu-launcher-new" aria-label="新建项目">
                <header className="nodu-launcher-head"><h1>新建项目</h1><div className="nodu-launcher-actions">
                    <button type="button" className="nodu-launcher-link" aria-label="返回项目列表" disabled={creating || busy} onClick={() => selectView('projects')}>
                        <i className="codicon codicon-chevron-left" aria-hidden="true"/>返回</button></div></header>
                {parentError && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{parentError}</span>
                    <button onClick={() => setParentAttempt(value => value + 1)}>重试</button></div>}
                {parentLoading ? skeleton(2) : projectParent && <div className="nodu-launcher-form">
                    <NewProjectForm model={model} dialogs={dialogs} parent={projectParent} family="stm32f103"
                        onBusyChange={value => { creatingRef.current = value; setCreating(value); }}
                        close={() => { creatingRef.current = false; setCreating(false); selectView('projects'); }}
                        onCreated={project => { creatingRef.current = false; setCreating(false); void run(() => open(project.path), '正在打开项目…'); }}/>
                </div>}
            </section> : view === 'settings' ? <SettingsPage themes={themes} preferences={preferences} onError={setError}/>
                : <section className="nodu-launcher-page" aria-label={view === 'projects' ? '最近项目' : '示例项目'}>
                    {!emptyProjects && <header className="nodu-launcher-head"><h1>{view === 'projects' ? '最近项目' : '示例项目'}</h1>
                        {!!(view === 'projects' ? rows.length : examples.length) && <span className="nodu-launcher-count">{view === 'projects' ? rows.length : examples.length} 个</span>}
                        {view === 'projects' && rows.length > 0 && <div className="nodu-launcher-actions">
                            <button type="button" className="nodu-launcher-button secondary" disabled={busy} onClick={event => void run(browse, '正在打开项目…', event.currentTarget)}>
                                <i className="codicon codicon-folder-opened" aria-hidden="true"/>打开</button>
                            <button type="button" ref={newProject} className="nodu-launcher-button primary" disabled={busy} onClick={() => selectView('create')}>
                                <i className="codicon codicon-add" aria-hidden="true"/>新建项目</button>
                        </div>}
                    </header>}
                    {(view === 'examples' || rows.length > 0 || query) && <div className="nodu-launcher-search">
                        <i className="codicon codicon-search" aria-hidden="true"/>
                        <input key={view} ref={search} autoFocus type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
                            placeholder={view === 'projects' ? '搜索项目' : '搜索示例项目'} aria-label={view === 'projects' ? '搜索项目' : '搜索示例项目'}
                            onKeyDown={event => {
                                if (view !== 'projects') { return; }
                                if (event.key === 'ArrowDown') { focusProject(0); event.preventDefault(); }
                                if (event.key === 'Enter' && visible.length === 1) { openRow(visible[0], event.currentTarget); event.preventDefault(); }
                            }}/>
                        {query ? <button type="button" className="nodu-launcher-search-clear" aria-label="清除搜索" title="清除搜索"
                            onClick={() => { setQuery(''); search.current?.focus(); }}><i className="codicon codicon-close" aria-hidden="true"/></button>
                            : <kbd aria-hidden="true">{navigator.userAgent.includes('Mac') ? '⌘ F' : 'Ctrl F'}</kbd>}
                    </div>}
                    {view === 'projects' ? <>
                        {recentError && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{recentError}</span>
                            <button disabled={busy} onClick={() => void refreshRecent(true)}>重试</button></div>}
                        {loading && !rows.length ? skeleton(4) : visible.length > 0 && <ul ref={list} className="nodu-launcher-list" aria-label="最近项目" onKeyDown={onListKeyDown}>{visible.map(renderProject)}</ul>}
                        {!loading && !recentError && (emptyProjects ? <div className="nodu-launcher-welcome">
                            <div className="nodu-launcher-welcome-body">
                                <h1>欢迎使用 Nodu</h1>
                                <p>新建项目，或打开已有工程。</p>
                                <div className="nodu-launcher-start">
                                    <button type="button" ref={newProject} className="nodu-launcher-start-action primary" disabled={busy} onClick={() => selectView('create')}>
                                        <span className="nodu-launcher-start-icon"><i className="codicon codicon-add" aria-hidden="true"/></span><span>新建项目</span></button>
                                    <button type="button" className="nodu-launcher-start-action" disabled={busy} onClick={event => void run(browse, '正在打开项目…', event.currentTarget)}>
                                        <span className="nodu-launcher-start-icon"><i className="codicon codicon-folder-opened" aria-hidden="true"/></span><span>打开项目</span></button>
                                    <button type="button" className="nodu-launcher-start-action" disabled={busy} onClick={() => selectView('examples')}>
                                        <span className="nodu-launcher-start-icon"><i className="codicon codicon-book" aria-hidden="true"/></span><span>示例项目</span></button>
                                </div>
                            </div>
                        </div> : !visible.length && <div className="nodu-launcher-empty" role="status"><p>没有匹配的项目</p>
                            <button type="button" className="nodu-launcher-button secondary" onClick={() => { setQuery(''); search.current?.focus(); }}>清除搜索</button></div>)}
                    </> : <>
                        {exampleLoadError && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{exampleLoadError}</span>
                            <button disabled={busy} onClick={() => { setExamplesLoaded(false); setExampleLoadError(''); setExampleAttempt(value => value + 1); }}>重试</button></div>}
                        {examplesLoading && !examples.length ? skeleton(3) : visibleExamples.length > 0 && <ul className="nodu-launcher-list nodu-launcher-examples" aria-label="示例项目">{visibleExamples.map(renderExample)}</ul>}
                        {!examplesLoading && !visibleExamples.length && !exampleLoadError && <div className="nodu-launcher-empty" role="status">
                            <p>{query ? '没有匹配的示例项目' : '暂无示例项目'}</p>
                            {query && <button type="button" className="nodu-launcher-button secondary" onClick={() => { setQuery(''); search.current?.focus(); }}>清除搜索</button>}
                        </div>}
                    </>}
                </section>}
            {busy && <span className="nodu-launcher-busy" role="status" aria-label={busyLabel}><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/></span>}
        </div>
        {(error || exampleError) && <div className="nodu-launcher-notice" role="alert">
            <i className="codicon codicon-error" aria-hidden="true"/><span>{error || exampleError}</span>
            <button type="button" className="nodu-launcher-notice-close" aria-label="关闭" title="关闭" onClick={() => {
                setError(''); setExampleError(''); requestAnimationFrame(() => (search.current ?? newProject.current ?? navigation.current[view])?.focus());
            }}><i className="codicon codicon-close" aria-hidden="true"/></button>
        </div>}
        {menu && <RowMenu state={menu} close={closeMenu}/>}
    </main>;
}
