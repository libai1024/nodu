// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { NoduTutorModel } from './nodu-tutor-model';
import { ChatPopover } from './nodu-tutor-chat-controls';
import '../../style/tutor-context.css';

interface ContextEntry { path: string; startLine: number; endLine: number; kind: 'file' | 'selection'; index?: number; }
export interface ContextPickerProps { tutor: NoduTutorModel; open(path: string, line: number): void | Promise<void>; }

/** Use the shortest suffix that still distinguishes same-name files. */
export function tutorContextLabel(path: string, paths: readonly string[]): string {
    const parts = path.split('/');
    for (let count = 1; count < parts.length; count++) {
        const suffix = parts.slice(-count).join('/');
        if (!paths.some(other => other !== path && other.split('/').slice(-count).join('/') === suffix)) { return suffix; }
    }
    return path;
}

export function ContextPicker({ tutor, open }: ContextPickerProps): React.ReactElement {
    const [menu, setMenu] = React.useState<{ anchor: HTMLElement; view: 'add' | 'files' | 'all' }>();
    const [files, setFiles] = React.useState<string[]>();
    const [search, setSearch] = React.useState('');
    const [working, setWorking] = React.useState(false);
    const [error, setError] = React.useState('');
    const mounted = React.useRef(true), sequence = React.useRef(0), pending = React.useRef(false);
    const currentMenu = React.useRef(menu); currentMenu.current = menu;
    const identity = `${tutor.workspaceId ?? ''}:${tutor.mode}`;
    const currentIdentity = React.useRef(identity); currentIdentity.current = identity;
    const close = React.useCallback(() => { setMenu(undefined); setSearch(''); }, []);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; sequence.current++; }; }, []);
    React.useEffect(() => {
        sequence.current++; pending.current = false; setWorking(false); setFiles(undefined); setError(''); close();
    }, [identity, close]);
    const allowed = (path: string): boolean => /\.(c|h|cpp|hpp|cc)$/i.test(path) || tutor.mode === 'ask' && /\.py$/i.test(path);
    const buffer = tutor.buffer;
    const current = buffer && tutor.currentContextIncluded && allowed(buffer.path)
        ? { kind: 'file' as const, path: buffer.path, startLine: 1, endLine: buffer.text.split('\n').length } : undefined;
    const entries: ContextEntry[] = [...(current ? [current] : []), ...tutor.pins.map((pin, index) => ({ ...pin, index }))];
    const paths = entries.map(entry => entry.path);
    const canCurrent = !!buffer && allowed(buffer.path), canSelection = canCurrent && !!buffer?.selection?.text;
    const disabled = working || !tutor.workspaceId || tutor.connectionState !== 'connected';

    const run = async (operation: () => Promise<boolean | string[]>, failure: string, complete?: (value: boolean | string[]) => void): Promise<void> => {
        if (pending.current) { return; }
        pending.current = true; setWorking(true); setError('');
        const generation = ++sequence.current, project = identity;
        try {
            const result = await operation();
            if (mounted.current && generation === sequence.current && project === currentIdentity.current) { complete?.(result); }
        } catch {
            if (mounted.current && generation === sequence.current && project === currentIdentity.current) { setError(failure); }
        } finally {
            if (mounted.current && generation === sequence.current && project === currentIdentity.current) { pending.current = false; setWorking(false); }
        }
    };
    const added = (value: boolean | string[]): void => {
        if (value === true && currentMenu.current === menu) { const anchor = menu?.anchor; close(); if (anchor?.isConnected) { anchor.focus(); } }
    };
    const addCurrent = (kind: 'file' | 'selection'): void => { void run(() => tutor.addCurrentContext(kind), '无法附带当前代码', added); };
    const listFiles = (): void => {
        setMenu(old => old ? { ...old, view: 'files' } : old); setSearch(''); setFiles(undefined);
        void run(() => tutor.listContextFiles(), '无法读取工程文件，请重试', value => { if (Array.isArray(value)) { setFiles(value); } });
    };
    const navigate = async (entry: ContextEntry): Promise<void> => {
        const project = identity;
        try { await open(entry.path, entry.startLine); }
        catch { if (mounted.current && project === currentIdentity.current) { setError(`无法打开 ${tutorContextLabel(entry.path, paths)}`); } }
    };
    const remove = (entry: ContextEntry): void => {
        if (entry.index === undefined) { tutor.setIncludeCode(false); }
        else { tutor.removeContext(entry.index); }
    };
    const label = (entry: ContextEntry): string => `${tutorContextLabel(entry.path, paths)}${entry.kind === 'selection' ? `:${entry.startLine}–${entry.endLine}` : ''}`;
    const renderChip = (entry: ContextEntry, inMenu = false): React.ReactElement => <span className="nodu-chat-context-chip" key={`${entry.index ?? 'current'}:${entry.path}`}>
        <button type="button" role={inMenu ? 'menuitem' : undefined} className="nodu-chat-context-open" title={`${entry.path}${entry.kind === 'selection' ? `:${entry.startLine}–${entry.endLine}` : ''}${entry.index === undefined ? '（当前文件）' : '（固定快照）'}`}
            aria-label={`打开 ${label(entry)}`} onClick={() => { if (inMenu) { close(); } void navigate(entry); }}>
            <i className={`codicon codicon-${entry.kind === 'selection' ? 'selection' : 'file-code'}`} aria-hidden="true"/><span>{label(entry)}</span>
        </button>
        <button type="button" role={inMenu ? 'menuitem' : undefined} className="nodu-chat-context-remove" aria-label={`移除 ${label(entry)}`} title="移除上下文"
            onClick={event => { event.stopPropagation(); remove(entry); }}><i className="codicon codicon-close" aria-hidden="true"/></button>
    </span>;
    const visibleFiles = (files ?? []).filter(path => path.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    return <div className="nodu-chat-context">
        <div className="nodu-ai-context-row nodu-chat-context-row">
            <button type="button" className="nodu-chat-context-add" title="添加代码上下文" aria-label="添加代码上下文" aria-haspopup="menu" aria-expanded={menu?.view === 'add' || menu?.view === 'files'}
                disabled={!tutor.workspaceId} onClick={event => { if (menu?.view === 'add') { close(); } else { setMenu({ anchor: event.currentTarget, view: 'add' }); setError(''); } }}>
                <i className="codicon codicon-add" aria-hidden="true"/>
            </button>
            {entries.slice(0, 2).map(entry => renderChip(entry))}
            {entries.length > 2 && <button type="button" className="nodu-chat-context-more" aria-label={`查看全部 ${entries.length} 项上下文`} aria-haspopup="menu" aria-expanded={menu?.view === 'all'}
                onClick={event => { if (menu?.view === 'all') { close(); } else { setMenu({ anchor: event.currentTarget, view: 'all' }); } }}>+{entries.length - 2}</button>}
        </div>
        {(error || tutor.contextError) && <div className="nodu-chat-context-error" role="status">{error || tutor.contextError}</div>}
        {menu && <ChatPopover anchor={menu.anchor} label={menu.view === 'all' ? '已附带的上下文' : '添加代码上下文'} above close={close}>
            {menu.view === 'add' ? <>
                <button type="button" role="menuitem" disabled={disabled || !canCurrent} onClick={() => addCurrent('file')}>固定当前文件<i className="codicon codicon-pin" aria-hidden="true"/></button>
                <button type="button" role="menuitem" disabled={disabled || !canSelection} onClick={() => addCurrent('selection')}>固定当前选区<i className="codicon codicon-selection" aria-hidden="true"/></button>
                <div className="nodu-ai-menu-divider"/>
                <button type="button" role="menuitem" disabled={disabled} onClick={listFiles}>从工程选择文件<i className="codicon codicon-folder" aria-hidden="true"/></button>
            </> : menu.view === 'files' ? <>
                <button type="button" role="menuitem" onClick={() => { setMenu({ ...menu, view: 'add' }); setSearch(''); }}><i className="codicon codicon-arrow-left" aria-hidden="true"/>返回</button>
                {(files?.length ?? 0) > 8 && <input className="nodu-ai-menu-search" aria-label="搜索工程文件" placeholder="搜索文件" value={search} onChange={event => setSearch(event.target.value)}/>}
                <div className="nodu-ai-menu-scroll">{visibleFiles.map(path => <button type="button" role="menuitem" key={path} title={path} disabled={disabled}
                    onClick={() => void run(() => tutor.addContextFile(path), '无法附带此文件', added)}><span>{path}</span></button>)}
                    {!files && working ? <div className="nodu-ai-menu-empty" role="status">读取工程文件…</div> : !visibleFiles.length && !working && <div className="nodu-ai-menu-empty">{search ? '没有匹配的文件' : files ? '没有可附带的代码文件' : '文件列表不可用'}</div>}
                </div>
                {!files && !working && <button type="button" role="menuitem" onClick={listFiles}>重新读取</button>}
            </> : <div className="nodu-chat-context-list">{entries.map(entry => <div key={`${entry.index ?? 'current'}:${entry.path}`}>{renderChip(entry, true)}</div>)}</div>}
        </ChatPopover>}
    </div>;
}
