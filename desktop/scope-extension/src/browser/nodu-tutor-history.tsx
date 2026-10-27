// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { NoduTutorModel } from './nodu-tutor-model';
import '../../style/tutor-conversations.css';
import type { TutorMode } from '../common/tutor/tutor-ai-protocol';
import type { TutorHistoryEntry } from '../common/tutor/tutor-conversation';
import { ConversationActions } from './nodu-tutor-chat-controls';

export function conversationDay(time: number, now = new Date()): string {
    const date = new Date(time), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

export function conversationAge(time: number, now = Date.now()): string {
    const minutes = Math.max(0, Math.floor((now - time) / 60000));
    return minutes < 1 ? '刚刚' : minutes < 60 ? `${minutes}分` : minutes < 1440 ? `${Math.floor(minutes / 60)}时` : `${Math.floor(minutes / 1440)}天`;
}
export function conversationState(entry: TutorHistoryEntry): { icon: string; label: string } {
    if (entry.status === 'pending') { return { icon: 'loading codicon-modifier-spin', label: '正在回复' }; }
    if (entry.hasDraft) { return { icon: 'edit', label: '草稿' }; }
    if (entry.status === 'failed') { return { icon: 'error', label: '回复失败' }; }
    if (entry.status === 'stopped') { return { icon: 'debug-pause', label: '回复已停止' }; }
    return { icon: entry.mode === 'teach' ? 'mortar-board' : 'comment-discussion', label: entry.status === 'done' ? '已回复' : entry.mode === 'teach' ? '教学' : '提问' };
}
function visibleConversations(entries: readonly TutorHistoryEntry[], search: string, filter: TutorMode | 'all', archived = false, activeId?: string): TutorHistoryEntry[] {
    const query = search.trim().toLocaleLowerCase();
    return entries.filter(c => !!c.archived === archived && (!c.empty || c.id === activeId) && (filter === 'all' || c.mode === filter) && `${c.title} ${c.preview}`.toLocaleLowerCase().includes(query));
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
    const entries = visibleConversations(tutor.historyEntries, search, filter, false, tutor.activeConversationId);
    let previousDay = '';
    return <section className="nodu-chat-history" aria-label="历史对话列表">
        <div className="nodu-chat-history-search-row"><i className="codicon codicon-search" aria-hidden="true"/><input ref={searchRef} className="nodu-chat-history-search" aria-label="搜索历史对话" placeholder="搜索对话…" value={search} onChange={e => setSearch(e.target.value)}/><button type="button" className="nodu-ai-icon" role="menuitem" aria-label="筛选对话模式" title="筛选对话模式" aria-expanded={filtersOpen} aria-pressed={filter !== 'all'} onClick={() => setFiltersOpen(!filtersOpen)}><i className="codicon codicon-filter" aria-hidden="true"/></button></div>
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
            {!entries.length && <p className="nodu-chat-history-empty">{search ? '没有匹配的对话' : '暂无历史对话'}</p>}
        </div>

    </section>;
}


/** Persistent navigation is a sibling of the conversation, not a menu or another transcript. */
export function ConversationSidebar({ tutor, selected }: { tutor: NoduTutorModel; selected?(): void }): React.ReactElement {
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TutorMode | 'all'>('all');
    const [filtersOpen, setFiltersOpen] = React.useState(false);
    const [actionError, setActionError] = React.useState(''), [archived, setArchived] = React.useState(false);
    const [menu, setMenu] = React.useState<{ entry: TutorHistoryEntry; anchor: HTMLElement }>();
    const [, refreshTime] = React.useState(0);
    const list = React.useRef<HTMLDivElement>(null), searchRef = React.useRef<HTMLInputElement>(null);
    const operation = React.useRef(0), inFlight = React.useRef(false);
    React.useEffect(() => () => { ++operation.current; }, []);
    React.useEffect(() => { const timer = setInterval(() => refreshTime(value => value + 1), 60000); return () => clearInterval(timer); }, []);
    React.useEffect(() => { setMenu(undefined); setActionError(''); }, [tutor.workspaceId, tutor.activeConversationId]);
    const entries = visibleConversations(tutor.historyEntries, search, filter, archived, tutor.activeConversationId);
    const closeMenu = React.useCallback(() => setMenu(undefined), []);
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
            <input ref={searchRef} className="nodu-chat-sidebar-search" aria-label="搜索会话" placeholder="搜索对话…" value={search} onChange={e => setSearch(e.target.value)}
                onKeyDown={e => {
                    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focusRow(e.key); }
                    else if (e.key === 'Escape' && search) { e.preventDefault(); e.stopPropagation(); setSearch(''); }
                }}/>
            <button type="button" className="nodu-ai-icon" aria-label="筛选会话模式" title="筛选会话模式" aria-expanded={filtersOpen} aria-pressed={filter !== 'all'} onClick={() => setFiltersOpen(!filtersOpen)}><i className="codicon codicon-filter" aria-hidden="true"/></button>
        </div>
        {filtersOpen && <div className="nodu-chat-sidebar-filters" role="group" aria-label="对话模式">
            {modeFilters.map(item => <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/>{item.label}</button>)}
        </div>}
        <div className="nodu-chat-sidebar-actions"><button type="button" className="nodu-chat-sidebar-new" disabled={disabled} onClick={() => choose()}><i className="codicon codicon-add" aria-hidden="true"/>新对话</button>
            <button type="button" className="nodu-ai-icon" aria-label={archived ? '返回对话列表' : '查看已归档对话'} title={archived ? '返回对话列表' : '已归档对话'} aria-pressed={archived} onClick={() => { setArchived(!archived); setMenu(undefined); }}><i className={`codicon codicon-${archived ? 'arrow-left' : 'archive'}`} aria-hidden="true"/></button>
        </div>
        {archived && <div className="nodu-chat-sidebar-section">已归档</div>}
        <div ref={list} className="nodu-chat-sidebar-list">
            {entries.map(entry => {
                const day = conversationDay(entry.updatedAt), heading = day !== previousDay; previousDay = day;
                const active = entry.id === tutor.activeConversationId && entry.mode === tutor.mode, title = conversationTitle(entry), state = conversationState(entry), date = new Date(entry.updatedAt);
                return <React.Fragment key={entry.id}>{heading && <h3>{day}</h3>}
                    <div className="nodu-chat-sidebar-row" data-current={active || undefined} data-menu-open={menu?.entry.id === entry.id || undefined}>
                        <button type="button" className="nodu-chat-sidebar-item" aria-current={active ? 'true' : undefined} title={title} disabled={disabled}
                            onClick={() => choose(entry)} onKeyDown={e => {
                                if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) { e.preventDefault(); e.stopPropagation(); focusRow(e.key, e.currentTarget); }
                            }}>
                            <span className="nodu-chat-sidebar-title"><i className={`codicon codicon-${state.icon}`} aria-label={state.label} title={state.label}/><span>{title}</span></span>
                            <span className="nodu-chat-sidebar-meta"><span className="nodu-chat-sidebar-preview" title={`${entry.mode === 'teach' ? '教学' : '提问'} · ${state.label}${entry.preview ? ` · ${entry.preview}` : ''}`}>{entry.hasDraft ? `草稿${entry.preview !== title ? ` · ${entry.preview}` : ''}` : entry.status === 'failed' || entry.status === 'stopped' || entry.status === 'pending' ? state.label : entry.preview && entry.preview !== title ? entry.preview : state.label}</span><time dateTime={Number.isFinite(date.getTime()) ? date.toISOString() : undefined} title={date.toLocaleString('zh-CN')}>{conversationAge(entry.updatedAt)}</time></span>
                        </button>
                        <button type="button" className="nodu-ai-icon nodu-chat-sidebar-more" aria-label={`管理对话：${title}`} title="管理对话" aria-haspopup="menu" aria-expanded={menu?.entry.id === entry.id} disabled={disabled}
                            onClick={e => setMenu(menu?.entry.id === entry.id ? undefined : { entry, anchor: e.currentTarget })}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
                    </div>
                </React.Fragment>;
            })}
            {!entries.length && <p className="nodu-chat-sidebar-empty">{search ? '没有匹配的对话' : archived ? '暂无已归档对话' : filter !== 'all' ? '此模式下暂无对话' : '从新对话开始'}</p>}
        </div>
        {actionError && <div className="nodu-chat-sidebar-error" role="status">{actionError}</div>}
        {menu && <ConversationActions key={`${tutor.workspaceId}:${menu.entry.id}`} tutor={tutor} entry={menu.entry} anchor={menu.anchor} close={closeMenu} completed={() => searchRef.current?.focus()}/>}
    </aside>;
}
