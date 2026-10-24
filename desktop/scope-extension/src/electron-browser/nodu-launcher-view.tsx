// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { ThemeService } from '@theia/core/lib/browser/theming';
import type { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { ExampleProject, NoduProjectsService, RecentProject } from '../common/nodu-launcher-protocol';
import { relativeTime } from '../common/nodu-launcher-util';
import { launcherProjectMonogram, launcherSearchMatch, nextLauncherIndex } from '../common/nodu-launcher-view-utils';
import { NoduBrand } from '../browser/scope-brand';
import type { NoduEmbeddedModel } from '../browser/nodu-embedded-model';
import { NewProjectForm } from '../browser/nodu-new-project';
import { SCOPE_LIGHT_THEME_ID, SCOPE_THEME_ID } from '../browser/scope-theme';

type LauncherView = 'projects' | 'examples' | 'create';

interface LauncherProps {
    projects: NoduProjectsService;
    open(path: string): Promise<void>;
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

export function Launcher({ projects, open, browse, themes, model, dialogs }: LauncherProps): React.ReactElement {
    const [view, setView] = React.useState<LauncherView>('projects');
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
    const [parentAttempt, setParentAttempt] = React.useState(0);
    const [error, setError] = React.useState('');
    const [recentError, setRecentError] = React.useState('');
    const [creating, setCreating] = React.useState(false);
    const creatingRef = React.useRef(false);
    const [exampleError, setExampleError] = React.useState('');
    const [exampleLoadError, setExampleLoadError] = React.useState('');
    const [themeType, setThemeType] = React.useState(themes.getCurrentTheme().type);
    const search = React.useRef<HTMLInputElement>(null);
    const newProject = React.useRef<HTMLButtonElement>(null);
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
        setParentLoading(true); setError('');
        void projects.projectsDir().then(parent => {
            if (mounted.current && generation === parentGeneration.current) { setParentLoading(false); setProjectParent(parent); }
        }).catch(err => {
            if (mounted.current && generation === parentGeneration.current) { setError(messageOf(err)); }
        }).finally(() => {
            if (mounted.current && generation === parentGeneration.current) { setParentLoading(false); }
        });
        return () => { parentGeneration.current++; };
    }, [view, projectParent, parentAttempt, projects]);

    const run = async (action: () => Promise<void>, label: string, trigger?: HTMLElement): Promise<void> => {
        if (pending.current) { return; }
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
        setView(next); setQuery(''); setError(''); setExampleError('');
        if (next !== 'create') { requestAnimationFrame(() => (search.current ?? newProject.current)?.focus()); }
    };
    const visible = rows.filter(row => launcherSearchMatch(row, query));
    const visibleExamples = examples.filter(example => launcherSearchMatch(example, query));
    const dark = themeType.toLowerCase().includes('dark');
    const busy = !!busyLabel;

    const focusProject = (index: number): void => {
        list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-project')[index]?.focus();
    };
    const onListKeyDown = (event: React.KeyboardEvent<HTMLUListElement>): void => {
        const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-project') ?? []);
        const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = nextLauncherIndex(current, event.key, buttons.length);
        if (next >= 0) { event.preventDefault(); focusProject(next); }
    };
    const removeRecent = (row: RecentProject, index: number): void => {
        const focusPath = visible[index + 1]?.path ?? visible[index - 1]?.path;
        void run(async () => {
            await projects.remove(row.path);
            const items = await projects.recent();
            if (mounted.current) { setRows(items); }
            requestAnimationFrame(() => {
                const buttons = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.nodu-launcher-project') ?? []);
                const next = buttons.find(button => button.dataset.projectPath === focusPath);
                (next ?? search.current)?.focus();
            });
        }, '正在更新最近项目…');
    };

    const renderProject = (row: RecentProject, index: number): React.ReactElement => {
        const monogram = launcherProjectMonogram(row.tag, row.name);
        return <li key={row.path} className={row.missing ? 'missing' : ''}>
            <button className="nodu-launcher-project" data-project-path={row.path} title={row.path}
                aria-disabled={busy || row.missing} onClick={() => { if (!row.missing) { void run(() => open(row.path), '正在打开项目…'); } }}>
                <span className="nodu-launcher-project-icon" aria-hidden="true">{monogram || <i className="codicon codicon-folder"/>}</span>
                <span className="nodu-launcher-project-info">
                    <span className="nodu-launcher-project-name"><strong>{row.name}</strong>{row.tag && !row.missing && <span className="nodu-launcher-tag">{row.tag}</span>}</span>
                    <span className="nodu-launcher-project-path">{row.path}</span>
                </span>
                <span className="nodu-launcher-meta">
                    {row.missing && <span className="nodu-launcher-missing-badge"><span className="nodu-launcher-missing-dot" aria-hidden="true"/>文件夹不存在</span>}
                    {!!row.lastOpened && <time>{relativeTime(row.lastOpened)}</time>}
                </span>
            </button>
            <button className="nodu-launcher-remove" title="从最近项目移除" aria-label={`从最近项目移除 ${row.name}`} disabled={busy}
                onClick={() => removeRecent(row, index)}><i className="codicon codicon-close" aria-hidden="true"/></button>
        </li>;
    };

    const renderExample = (example: ExampleProject): React.ReactElement => <li key={example.path}>
        <button type="button" className="nodu-launcher-example" aria-label={`使用参考项目 ${example.name}，创建独立副本`} disabled={busy}
            onClick={() => void run(async () => open(await projects.copyExample(example.path)), '正在创建参考项目…')}>
            <span className="nodu-launcher-example-icon" aria-hidden="true"><i className="codicon codicon-mortar-board"/></span>
            <span className="nodu-launcher-example-info">
                <span className="nodu-launcher-project-name"><strong>{example.name}</strong>{example.tag && <span className="nodu-launcher-tag">{example.tag}</span>}</span>
            </span>
            <span className="nodu-launcher-example-action">创建副本<i className="codicon codicon-chevron-right" aria-hidden="true"/></span>
        </button>
    </li>;

    const skeleton = (count: number): React.ReactElement => <ul className="nodu-launcher-list nodu-launcher-skeleton" aria-label="正在加载" role="status">
        {Array.from({ length: count }, (_, index) => <li key={index}><span/><div><i/><i/></div></li>)}
    </ul>;

    return <main className="nodu-launcher-content scope-widget" aria-label="Nodu 工作台" aria-busy={busy || creating || (view === 'projects' ? loading : view === 'examples' ? examplesLoading : parentLoading)}
        onKeyDown={event => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); search.current?.focus(); }
            if (event.key === 'Escape' && view === 'create' && !creatingRef.current) { event.preventDefault(); selectView('projects'); }
            if (event.key === 'Escape' && document.activeElement === search.current && query) { event.preventDefault(); setQuery(''); }
        }}>
        <div className="nodu-launcher-window-drag" aria-hidden="true"/>
        <aside className="nodu-launcher-nav">
            <div className="nodu-launcher-brand"><NoduBrand/></div>
            <nav className="nodu-launcher-navigation" aria-label="工作台导航">
                <button className="nodu-launcher-section" aria-current={view !== 'examples' ? 'page' : undefined} disabled={view === 'create' || busy}
                    onClick={() => selectView('projects')}><i className="codicon codicon-folder" aria-hidden="true"/><span>项目</span></button>
                <button className="nodu-launcher-section" aria-current={view === 'examples' ? 'page' : undefined} disabled={view === 'create' || busy}
                    onClick={() => selectView('examples')}><i className="codicon codicon-mortar-board" aria-hidden="true"/><span>参考项目</span></button>
            </nav>
            <div className="nodu-launcher-nav-footer">
                <button className="nodu-launcher-theme" title={dark ? '切换到浅色主题' : '切换到深色主题'}
                    aria-label={dark ? '切换到浅色主题' : '切换到深色主题'}
                    onClick={() => themes.setCurrentTheme(dark ? SCOPE_LIGHT_THEME_ID : SCOPE_THEME_ID)}>
                    <ThemeModeIcon dark={dark}/>
                </button>
            </div>
        </aside>
        {view === 'create' ? <section className="nodu-launcher-projects nodu-launcher-create" aria-label="新建项目">
            <header className="nodu-launcher-header nodu-launcher-create-header">
                <button className="nodu-launcher-back" aria-label="返回项目列表" disabled={creating} onClick={() => selectView('projects')}><i className="codicon codicon-chevron-left" aria-hidden="true"/>项目</button>
                <div className="nodu-launcher-heading"><h1>新建项目</h1></div>
            </header>
            {error && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{error}</span>
                <button onClick={() => setParentAttempt(value => value + 1)}>重试</button></div>}
            {parentLoading ? skeleton(2) : projectParent && <NewProjectForm model={model} dialogs={dialogs} parent={projectParent} family="stm32f103"
                onBusyChange={value => { creatingRef.current = value; setCreating(value); }}
                close={() => { creatingRef.current = false; setCreating(false); selectView('projects'); }} onCreated={project => { void run(() => open(project.path), '正在打开项目…'); }} />}
        </section> : <section className="nodu-launcher-projects" aria-label={view === 'projects' ? '项目' : '参考项目'}>
            <header className="nodu-launcher-header">
                <div className="nodu-launcher-heading"><h1>{view === 'projects' ? '项目' : '参考项目'}</h1>
                    {busyLabel ? <span className="nodu-launcher-busy" role="status"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/>{busyLabel}</span>
                        : view === 'projects' ? !loading && rows.length > 0 && <span className="nodu-launcher-count">{rows.length} 个项目</span>
                            : examplesLoaded && examples.length > 0 && <span className="nodu-launcher-count">{examples.length} 个参考项目</span>}
                </div>
                {view === 'projects' && rows.length > 0 && <div className="nodu-launcher-actions">
                    <button className="nodu-launcher-button secondary" disabled={busy} onClick={event => void run(browse, '正在打开项目…', event.currentTarget)}>
                        <i className="codicon codicon-folder-opened" aria-hidden="true"/>打开项目</button>
                    <button ref={newProject} className="nodu-launcher-button primary" disabled={busy} onClick={() => selectView('create')}>
                        <i className="codicon codicon-add" aria-hidden="true"/>新建项目</button>
                </div>}
            </header>
            {(view === 'examples' || rows.length > 0) && <div className="nodu-launcher-search">
                <i className="codicon codicon-search" aria-hidden="true"/>
                <input key={view} ref={search} autoFocus type="search" value={query} onChange={event => setQuery(event.currentTarget.value)}
                    placeholder={view === 'projects' ? '搜索项目' : '搜索参考项目'} aria-label={view === 'projects' ? '搜索项目' : '搜索参考项目'} />
                {query ? <button type="button" className="nodu-launcher-search-clear" aria-label="清除搜索" title="清除搜索"
                    onClick={() => { setQuery(''); search.current?.focus(); }}><i className="codicon codicon-close" aria-hidden="true"/></button>
                    : <kbd aria-hidden="true">{navigator.userAgent.includes('Mac') ? '⌘ F' : 'Ctrl F'}</kbd>}
            </div>}
            {view === 'projects' ? <>
                {recentError && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{recentError}</span>
                    <button disabled={busy} onClick={() => void refreshRecent(true)}>重试</button></div>}
                {loading && !rows.length ? skeleton(4) : visible.length > 0 && <ul ref={list} className="nodu-launcher-list" aria-label="最近项目" onKeyDown={onListKeyDown}>
                    {visible.map(renderProject)}
                </ul>}
                {!loading && !error && !recentError && (rows.length === 0 ? <div className="nodu-launcher-welcome">
                    <div className="nodu-launcher-start-actions">
                        <button ref={newProject} className="nodu-launcher-start-action" disabled={busy} onClick={() => selectView('create')}>
                            <i className="codicon codicon-add" aria-hidden="true"/><span>新建项目</span><i className="codicon codicon-chevron-right" aria-hidden="true"/></button>
                        <button className="nodu-launcher-start-action" disabled={busy} onClick={event => void run(browse, '正在打开项目…', event.currentTarget)}>
                            <i className="codicon codicon-folder-opened" aria-hidden="true"/><span>打开项目</span><i className="codicon codicon-chevron-right" aria-hidden="true"/></button>
                    </div>
                </div> : !visible.length && <div className="nodu-launcher-empty" role="status">
                    <i className="codicon codicon-search nodu-launcher-empty-icon" aria-hidden="true"/>
                    <h2>没有匹配的项目</h2>
                    <button className="nodu-launcher-button secondary" onClick={() => { setQuery(''); search.current?.focus(); }}>清除搜索</button>
                </div>)}
            </> : <>
                {exampleLoadError && <div className="nodu-launcher-error" role="alert"><i className="codicon codicon-warning" aria-hidden="true"/><span>{exampleLoadError}</span>
                    <button disabled={busy} onClick={() => { setExamplesLoaded(false); setExampleLoadError(''); setExampleAttempt(value => value + 1); }}>重试</button></div>}
                {examplesLoading && !examples.length ? skeleton(3) : visibleExamples.length > 0 && <ul className="nodu-launcher-list nodu-launcher-examples" aria-label="参考项目">
                    {visibleExamples.map(renderExample)}
                </ul>}
                {!examplesLoading && !visibleExamples.length && !exampleError && !exampleLoadError && <div className="nodu-launcher-empty" role="status">
                    <i className={`codicon ${query ? 'codicon-search' : 'codicon-book'} nodu-launcher-empty-icon`} aria-hidden="true"/>
                    <h2>{query ? '没有匹配的参考项目' : '暂无参考项目'}</h2>
                    {query && <button className="nodu-launcher-button secondary" onClick={() => { setQuery(''); search.current?.focus(); }}>清除搜索</button>}
                </div>}
            </>}
        </section>}
        {view !== 'create' && (error || exampleError) && <div className="nodu-launcher-notice" role="alert">
            <i className="codicon codicon-error" aria-hidden="true"/>
            <span>{error || exampleError}</span>
            <button type="button" aria-label="关闭" title="关闭" onClick={() => {
                setError(''); setExampleError('');
                requestAnimationFrame(() => (search.current ?? newProject.current)?.focus());
            }}><i className="codicon codicon-close" aria-hidden="true"/></button>
        </div>}
    </main>;
}
