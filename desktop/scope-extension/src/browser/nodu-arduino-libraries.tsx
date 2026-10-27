// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { CommandRegistry, CommandService } from '@theia/core/lib/common';
import { ReactWidget, FrontendApplicationContribution } from '@theia/core/lib/browser';
import { AbstractViewContribution } from '@theia/core/lib/browser/shell/view-contribution';
import { ArduinoLibraryChange, ArduinoLibraryFilter, ArduinoLibraryItem, ArduinoLibraryList } from '../common/nodu-arduino-libraries-protocol';
import { NoduArduinoModel } from './nodu-arduino-model';
import { NoduSelect } from './nodu-select';
import '../../style/arduino.css';

export const ARDUINO_LIBRARY_COMMAND = 'nodu.arduino.libraries';
export const ARDUINO_LIBRARY_CHANGE = 'nodu.arduino.library.change';

function LibraryEntry({ item, busy, change }: { item: ArduinoLibraryItem; busy: boolean; change: (item: ArduinoLibraryItem, action: ArduinoLibraryChange['action'], version?: string) => void }): React.ReactElement {
    const [version, setVersion] = React.useState(item.installedVersion ?? item.bundledVersion ?? item.latestVersion);
    React.useEffect(() => { setVersion(item.installedVersion ?? item.bundledVersion ?? item.latestVersion); }, [item.name, item.installedVersion, item.bundledVersion, item.latestVersion]);
    const versions = [...new Set([version, ...item.versions].filter(Boolean))];
    const changed = !!item.installedVersion && version !== item.installedVersion;
    const update = !!item.installedVersion && !changed && item.updateAvailable;
    return <li className="nodu-library-entry">
        <div className="nodu-library-heading"><strong>{item.name}</strong>{item.core && <span className="nodu-library-badge">内置</span>}{item.installedVersion && !item.core && <span className="nodu-library-badge">{item.installedVersion}</span>}</div>
        <div className="nodu-library-author">{item.author}</div>
        {item.summary && <p className="nodu-library-summary" title={item.summary}>{item.summary}</p>}
        {!item.core && <div className="nodu-library-actions">
            <NoduSelect aria-label={`${item.name} 版本`} value={version || ''} options={versions.map(value => ({ value, label: value }))} disabled={busy || !item.compatible} onChange={setVersion}/>
            <button className="theia-button secondary" disabled={busy || !item.compatible || !version || (!!item.installedVersion && !changed && !update)}
                title={update ? `更新到 ${item.latestVersion}` : undefined}
                onClick={() => change(item, item.installedVersion ? 'update' : 'add', update ? item.latestVersion : version)}>{item.installedVersion ? changed ? '应用' : update ? '更新' : '已安装' : '安装'}</button>
            {item.installedVersion && <button className="nodu-library-remove" aria-label={`移除 ${item.name}`} title="从项目移除" disabled={busy} onClick={() => change(item, 'remove')}><i className="codicon codicon-trash" aria-hidden="true"/></button>}
            {!item.compatible && <span className="nodu-library-unsupported">不兼容</span>}
        </div>}
    </li>;
}

export function ArduinoLibraries({ model, commands }: { model: NoduArduinoModel; commands: CommandService }): React.ReactElement {
    const [query, setQuery] = React.useState(''), [filter, setFilter] = React.useState<ArduinoLibraryFilter>('all');
    const [result, setResult] = React.useState<ArduinoLibraryList>({ items: [], total: 0 });
    const [loading, setLoading] = React.useState(true), [error, setError] = React.useState('');
    const sequence = React.useRef(0), mounted = React.useRef(true), resultScope = React.useRef('');
    const generation = model.generation, path = model.path;
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; ++sequence.current; }; }, []);
    const search = React.useCallback(async (refresh = false, append = false): Promise<void> => {
        const request = ++sequence.current;
        if (!path) { setResult({ items: [], total: 0 }); setLoading(false); return; }
        setLoading(true); setError('');
        try {
            const response = await model.service.listLibraries({ path, query: query.trim(), filter, refresh, offset: append ? result.items.length : 0, limit: 40 });
            if (!mounted.current || sequence.current !== request || model.generation !== generation) { return; }
            setResult(previous => append ? { ...response, items: [...previous.items, ...response.items] } : response); setError(response.error ?? '');
        } catch (cause) {
            if (mounted.current && sequence.current === request && model.generation === generation) { setError(cause instanceof Error ? cause.message : String(cause)); }
        } finally { if (mounted.current && sequence.current === request) { setLoading(false); } }
    }, [model, path, query, filter, generation, result.items.length]);
    React.useEffect(() => {
        ++sequence.current; setLoading(!!path); setError('');
        const scope = JSON.stringify([path, generation, query, filter]);
        if (scope !== resultScope.current) { resultScope.current = scope; setResult({ items: [], total: 0 }); }
        const timer = setTimeout(() => void search(), query ? 200 : 0);
        return () => { clearTimeout(timer); ++sequence.current; };
    }, [path, generation, query, filter, model.libraryRevision]);
    const change = (item: ArduinoLibraryItem, action: ArduinoLibraryChange['action'], version?: string): void => {
        if (model.busy || !path) { return; }
        void commands.executeCommand(ARDUINO_LIBRARY_CHANGE, { path, name: item.name, action, version }).catch(cause => {
            if (mounted.current && model.generation === generation) { setError(cause instanceof Error ? cause.message : String(cause)); }
        });
    };
    return <section className="nodu-arduino-libraries" aria-label="库管理" aria-busy={loading || model.operation === 'libraries'}>
        <div className="nodu-library-search"><i className="codicon codicon-search" aria-hidden="true"/><input aria-label="搜索库" placeholder="搜索库" value={query} onChange={event => setQuery(event.currentTarget.value)} onKeyDown={event => { if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); setQuery(''); } }}/></div>
        <div className="nodu-library-filters"><NoduSelect aria-label="筛选库" value={filter} onChange={value => setFilter(value as ArduinoLibraryFilter)} options={[{ value: 'all', label: '全部' }, { value: 'installed', label: '已安装' }, { value: 'bundled', label: '内置' }, { value: 'updates', label: '可更新' }]}/>
            <button className="nodu-arduino-icon" title="刷新库索引" aria-label="刷新库索引" disabled={loading || model.busy || !path} onClick={() => void search(true)}><i className={`codicon codicon-${loading ? 'loading codicon-modifier-spin' : 'refresh'}`} aria-hidden="true"/></button>
        </div>
        {(error || model.error) && <div className="nodu-arduino-error" role="alert"><span>{error || model.error}</span>{error ? <button onClick={() => void search()}>重试</button> : <button aria-label="关闭错误" onClick={() => { model.error = ''; model.fire(); }}><i className="codicon codicon-close" aria-hidden="true"/></button>}</div>}
        {model.operation === 'libraries' && <div className="nodu-library-progress" role="status"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/><span>{model.operationLabel}</span><button className="nodu-arduino-icon" aria-label="停止库操作" onClick={() => void commands.executeCommand('nodu.arduino.stop')}><i className="codicon codicon-debug-stop" aria-hidden="true"/></button></div>}
        <ul className="nodu-library-list">{result.items.map(item => <LibraryEntry key={item.name} item={item} busy={model.busy} change={change}/>)}</ul>
        {!loading && !result.items.length && !error && <div className="nodu-library-empty" role="status">{path ? '没有匹配的库' : '未打开 Arduino 项目'}</div>}
        {loading && !result.items.length && <div className="nodu-library-empty" role="status" aria-label="正在读取库"><i className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"/></div>}
        {result.items.length < result.total && <button className="nodu-library-more" disabled={loading} onClick={() => void search(false, true)}>加载更多</button>}
    </section>;
}

@injectable()
export class NoduArduinoLibrariesWidget extends ReactWidget {
    static readonly ID = 'nodu:arduino-libraries';
    static readonly LABEL = '库管理';
    @inject(NoduArduinoModel) protected readonly model!: NoduArduinoModel;
    @inject(CommandService) protected readonly commands!: CommandService;
    @postConstruct()
    protected init(): void {
        this.id = NoduArduinoLibrariesWidget.ID; this.title.label = NoduArduinoLibrariesWidget.LABEL;
        this.title.iconClass = 'codicon codicon-library'; this.title.closable = true; this.addClass('nodu-arduino-library-widget');
        this.toDispose.push(this.model.onDidChange(() => this.update())); this.update();
    }
    protected render(): React.ReactNode { return <ArduinoLibraries model={this.model} commands={this.commands}/>; }
    protected override onActivateRequest(message: import('@theia/core/shared/@lumino/messaging').Message): void { super.onActivateRequest(message); this.node.querySelector<HTMLInputElement>('input')?.focus(); }
}

@injectable()
export class NoduArduinoLibrariesContribution extends AbstractViewContribution<NoduArduinoLibrariesWidget> implements FrontendApplicationContribution {
    @inject(NoduArduinoModel) protected readonly model!: NoduArduinoModel;
    constructor() { super({ widgetId: NoduArduinoLibrariesWidget.ID, widgetName: NoduArduinoLibrariesWidget.LABEL, defaultWidgetOptions: { area: 'left', rank: 300 } }); }
    override registerCommands(commands: CommandRegistry): void {
        commands.registerCommand({ id: ARDUINO_LIBRARY_COMMAND, label: 'Arduino: 库管理', iconClass: 'codicon codicon-library' }, {
            execute: () => this.openView({ activate: true, reveal: true }), isVisible: () => !!this.model.path, isEnabled: () => !!this.model.path,
        });
    }
    onStart(): void {
        let path = '';
        this.model.onDidChange(() => {
            if (path === this.model.path) { return; } path = this.model.path;
            if (path) { void this.openView({ activate: false, reveal: false }); }
            else { this.tryGetWidget()?.close(); }
        });
        if (this.model.path) { path = this.model.path; void this.openView({ activate: false, reveal: false }); }
    }
}
