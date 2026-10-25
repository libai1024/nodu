// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { NoduTutorModel } from './nodu-tutor-model';
import '../../style/tutor-conversations.css';
import type { TutorMode } from '../common/tutor/tutor-ai-protocol';
import type { TutorHistoryEntry } from '../common/tutor/tutor-conversation';

export function conversationDay(time: number, now = new Date()): string {
    const date = new Date(time), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

function visibleConversations(entries: readonly TutorHistoryEntry[], search: string, filter: TutorMode | 'all'): TutorHistoryEntry[] {
    const query = search.trim().toLocaleLowerCase();
    return entries.filter(c => (filter === 'all' || c.mode === filter) && `${c.title} ${c.preview}`.toLocaleLowerCase().includes(query));
}
function conversationTitle(entry: TutorHistoryEntry): string {
    return entry.title === '新对话' && entry.hasDraft && entry.preview ? entry.preview : entry.title;
}
const modeFilters = [{ id: 'all', label: '全部', icon: 'list-flat' }, { id: 'ask', label: '提问', icon: 'comment-discussion' }, { id: 'teach', label: '教学', icon: 'mortar-board' }] as const;

/** A compact history picker leaves the current transcript and draft in view. */
export function ConversationHistory({ tutor, selected }: { tutor: NoduTutorModel; selected?(): void }): React.ReactElement {
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TutorMode | 'all'>('all');
    const [filtersOpen, setFiltersOpen] = React.useState(false);
    const searchRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { searchRef.current?.focus(); }, []);
    const entries = visibleConversations(tutor.historyEntries, search, filter);
    let previousDay = '';
    return <section className="nodu-chat-history" aria-label="历史对话列表">
        <div className="nodu-chat-history-search-row"><i className="codicon codicon-search" aria-hidden="true"/><input ref={searchRef} className="nodu-chat-history-search" aria-label="搜索历史对话" value={search} onChange={e => setSearch(e.target.value)}/><button type="button" className="nodu-ai-icon" role="menuitem" aria-label="筛选对话模式" title="筛选对话模式" aria-expanded={filtersOpen} aria-pressed={filter !== 'all'} onClick={() => setFiltersOpen(!filtersOpen)}><i className="codicon codicon-filter" aria-hidden="true"/></button></div>
        {filtersOpen && <div className="nodu-chat-history-filters" role="group" aria-label="对话模式">
            {modeFilters.map(item =>
                <button key={item.id} type="button" role="menuitemradio" aria-checked={filter === item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/>{item.label}</button>)}
        </div>}
        <div className="nodu-chat-history-list">
            {entries.map(c => {
                const day = conversationDay(c.updatedAt), heading = day !== previousDay; previousDay = day;
                const active = c.id === tutor.activeConversationId && c.mode === tutor.mode;
                const title = conversationTitle(c);
                return <React.Fragment key={c.id}>{heading && <h3>{day}</h3>}
                    <button type="button" role="menuitem" className="nodu-chat-history-item" aria-current={active ? 'true' : undefined} title={title} disabled={!!tutor.busy || tutor.conversationLoading}
                        onClick={async () => {
                            if (tutor.busy || tutor.conversationLoading) { return; }
                            await tutor.selectConversation(c.id, c.mode);
                            if (tutor.activeConversationId === c.id && tutor.mode === c.mode && !tutor.historyOpen) { selected?.(); }
                        }}>
                        <span className="nodu-chat-history-title"><i className={`codicon codicon-${c.hasDraft ? 'edit' : c.mode === 'teach' ? 'mortar-board' : 'comment-discussion'}`} aria-label={c.hasDraft ? '草稿' : undefined} aria-hidden={c.hasDraft ? undefined : true}/><span>{title}</span>{active && <i className="codicon codicon-check" aria-label="当前对话"/>}</span>
                    </button></React.Fragment>;
            })}
            {!entries.length && <p className="nodu-chat-history-empty">{search ? '无结果' : ''}</p>}
        </div>

    </section>;
}


/** Persistent navigation is a sibling of the conversation, not a menu or another transcript. */
export function ConversationSidebar({ tutor, selected }: { tutor: NoduTutorModel; selected?(): void }): React.ReactElement {
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TutorMode | 'all'>('all');
    const [filtersOpen, setFiltersOpen] = React.useState(false);
    const [actionError, setActionError] = React.useState('');
    const list = React.useRef<HTMLDivElement>(null);
    const operation = React.useRef(0), inFlight = React.useRef(false);
    React.useEffect(() => () => { ++operation.current; }, []);
    const entries = visibleConversations(tutor.historyEntries, search, filter);
    const disabled = !tutor.workspaceId || !!tutor.busy || tutor.conversationLoading;
    const focusRow = (key: string, current?: HTMLButtonElement): void => {
        const rows = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('.nodu-chat-sidebar-item:not(:disabled)') ?? []);
        if (!rows.length) { return; }
        const index = current ? rows.indexOf(current) : -1;
        const next = key === 'Home' ? 0 : key === 'End' ? rows.length - 1 : index < 0 ? (key === 'ArrowUp' ? rows.length - 1 : 0)
            : Math.max(0, Math.min(rows.length - 1, index + (key === 'ArrowDown' ? 1 : -1)));
        rows[next].focus();
    };
    const choose = async (entry?: TutorHistoryEntry): Promise<void> => {
        if (inFlight.current || !tutor.workspaceId || tutor.busy || tutor.conversationLoading) { return; }
        const workspace = tutor.workspaceId, mode = entry?.mode ?? tutor.mode, token = ++operation.current;
        inFlight.current = true; setActionError('');
        try {
            if (entry) { await tutor.selectConversation(entry.id, entry.mode); }
            else { await tutor.newConversation(); }
            if (token !== operation.current || workspace !== tutor.workspaceId || mode !== tutor.mode || tutor.conversationLoading || tutor.busy) { return; }
            const activated = entry ? tutor.activeConversationId === entry.id : !!tutor.activeConversationId && !tutor.messages[mode].length && !tutor.drafts[mode] && !tutor.pins.length;
            if (activated) { selected?.(); }
        } catch {
            if (token === operation.current && workspace === tutor.workspaceId) { setActionError(entry ? '无法打开对话' : '新建对话失败'); }
        } finally { inFlight.current = false; }
    };
    let previousDay = '';
    return <aside id="nodu-conversation-sidebar" className="nodu-chat-sidebar" aria-label="会话列表">
        <div className="nodu-chat-sidebar-search-row">
            <i className="codicon codicon-search" aria-hidden="true"/>
            <input className="nodu-chat-sidebar-search" aria-label="搜索会话" value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusRow(e.key); }
                    else if (e.key === 'Escape' && search) { e.preventDefault(); e.stopPropagation(); setSearch(''); }
                }}/>
            <button type="button" className="nodu-ai-icon" aria-label="筛选会话模式" title="筛选会话模式" aria-expanded={filtersOpen} aria-pressed={filter !== 'all'} onClick={() => setFiltersOpen(!filtersOpen)}><i className="codicon codicon-filter" aria-hidden="true"/></button>
        </div>
        {filtersOpen && <div className="nodu-chat-sidebar-filters" role="group" aria-label="对话模式">
            {modeFilters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/>{item.label}</button>)}
        </div>}
        <div className="nodu-chat-sidebar-actions"><button type="button" className="nodu-chat-sidebar-new" disabled={disabled} onClick={() => choose()}><i className="codicon codicon-add" aria-hidden="true"/>新对话</button></div>
        <div ref={list} className="nodu-chat-sidebar-list">
            {entries.map(entry => {
                const day = conversationDay(entry.updatedAt), heading = day !== previousDay; previousDay = day;
                const active = entry.id === tutor.activeConversationId && entry.mode === tutor.mode, title = conversationTitle(entry);
                return <React.Fragment key={entry.id}>{heading && <h3>{day}</h3>}
                    <button type="button" className="nodu-chat-sidebar-item" aria-current={active ? 'true' : undefined} title={title} disabled={disabled}
                        onClick={() => choose(entry)} onKeyDown={e => {
                            if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); focusRow(e.key, e.currentTarget); }
                        }}>
                        <span className="nodu-chat-sidebar-title"><i className={`codicon codicon-${entry.hasDraft ? 'edit' : entry.mode === 'teach' ? 'mortar-board' : 'comment-discussion'}`} aria-label={entry.hasDraft ? '草稿' : undefined} aria-hidden={entry.hasDraft ? undefined : true}/><span>{title}</span>{active && <i className="codicon codicon-check" aria-label="当前对话"/>}</span>
                        {entry.hasDraft && entry.preview && entry.preview !== title && <span className="nodu-chat-sidebar-preview">{entry.preview}</span>}
                    </button>
                </React.Fragment>;
            })}
            {!entries.length && search && <p className="nodu-chat-sidebar-empty">无结果</p>}
        </div>
        {actionError && <div className="nodu-chat-sidebar-error" role="status">{actionError}</div>}
    </aside>;
}
