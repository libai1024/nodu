// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { NoduTutorModel } from './nodu-tutor-model';
import type { TutorMode } from '../common/tutor/tutor-ai-protocol';

export function conversationDay(time: number, now = new Date()): string {
    const date = new Date(time), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** A compact history picker leaves the current transcript and draft in view. */
export function ConversationHistory({ tutor, selected }: { tutor: NoduTutorModel; selected?(): void }): React.ReactElement {
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TutorMode | 'all'>('all');
    const [filtersOpen, setFiltersOpen] = React.useState(false);
    const searchRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { searchRef.current?.focus(); }, []);
    const entries = tutor.historyEntries.filter(c => (filter === 'all' || c.mode === filter) && `${c.title} ${c.preview}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    let previousDay = '';
    return <section className="nodu-chat-history" aria-label="历史对话列表">
        <div className="nodu-chat-history-search-row"><i className="codicon codicon-search" aria-hidden="true"/><input ref={searchRef} className="nodu-chat-history-search" aria-label="搜索历史对话" value={search} onChange={e => setSearch(e.target.value)}/><button type="button" className="nodu-ai-icon" role="menuitem" aria-label="筛选对话模式" title="筛选对话模式" aria-expanded={filtersOpen} aria-pressed={filter !== 'all'} onClick={() => setFiltersOpen(!filtersOpen)}><i className="codicon codicon-filter" aria-hidden="true"/></button></div>
        {filtersOpen && <div className="nodu-chat-history-filters" role="group" aria-label="对话模式">
            {([{ id: 'all', label: '全部', icon: 'list-flat' }, { id: 'ask', label: '提问', icon: 'comment-discussion' }, { id: 'teach', label: '教学', icon: 'mortar-board' }] as const).map(item =>
                <button key={item.id} type="button" role="menuitemradio" aria-checked={filter === item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/>{item.label}</button>)}
        </div>}
        <div className="nodu-chat-history-list">
            {entries.map(c => {
                const day = conversationDay(c.updatedAt), heading = day !== previousDay; previousDay = day;
                const active = c.id === tutor.activeConversationId && c.mode === tutor.mode;
                const title = c.title === '新对话' && c.hasDraft && c.preview ? c.preview : c.title;
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
