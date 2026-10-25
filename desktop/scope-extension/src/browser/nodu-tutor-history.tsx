// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { NoduTutorModel } from './nodu-tutor-model';
import type { TutorMode } from '../common/tutor/tutor-ai-protocol';

export function conversationDay(time: number, now = new Date()): string {
    const date = new Date(time), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    return date >= today ? '今天' : date >= yesterday ? '昨天' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
}

/** History is a navigable view of this project's conversations, not a long action menu. */
export function ConversationHistory({ tutor }: { tutor: NoduTutorModel }): React.ReactElement {
    const [search, setSearch] = React.useState('');
    const [filter, setFilter] = React.useState<TutorMode | 'all'>('all');
    const searchRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => { searchRef.current?.focus(); }, []);
    const entries = tutor.historyEntries.filter(c => (filter === 'all' || c.mode === filter) && `${c.title} ${c.preview}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
    let previousDay = '';
    return <section className="nodu-chat-history" aria-label="历史对话" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); tutor.showHistory(false); }
    }}>
        <div className="nodu-chat-history-search-row"><i className="codicon codicon-search" aria-hidden="true"/><input ref={searchRef} className="nodu-chat-history-search" aria-label="搜索历史对话" value={search} onChange={e => setSearch(e.target.value)}/><button type="button" className="nodu-ai-icon" aria-label="返回当前对话" title="返回当前对话" onClick={() => tutor.showHistory(false)}><i className="codicon codicon-close" aria-hidden="true"/></button></div>
        <div className="nodu-chat-history-filters" role="group" aria-label="筛选对话模式">
            {([{ id: 'all', label: '全部', icon: 'list-flat' }, { id: 'ask', label: '提问', icon: 'comment-discussion' }, { id: 'teach', label: '教学', icon: 'mortar-board' }] as const).map(item =>
                <button key={item.id} type="button" aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}><i className={`codicon codicon-${item.icon}`} aria-hidden="true"/>{item.label}</button>)}
        </div>
        <div className="nodu-chat-history-list">
            {entries.map(c => {
                const day = conversationDay(c.updatedAt), heading = day !== previousDay; previousDay = day;
                const active = c.id === tutor.activeConversationId && c.mode === tutor.mode;
                return <React.Fragment key={c.id}>{heading && <h3>{day}</h3>}
                    <button type="button" className="nodu-chat-history-item" aria-current={active ? 'true' : undefined} title={c.title} disabled={!!tutor.busy || tutor.conversationLoading}
                        onClick={() => void tutor.selectConversation(c.id, c.mode)}>
                        <span className="nodu-chat-history-title"><i className={`codicon codicon-${c.mode === 'teach' ? 'mortar-board' : 'comment-discussion'}`} aria-hidden="true"/><span>{c.title}</span>{active && <i className="codicon codicon-check" aria-label="当前对话"/>}</span>
                        <span className="nodu-chat-history-preview">{c.preview}</span>
                        <span className="nodu-chat-history-meta"><span>{c.mode === 'teach' ? '教学' : '提问'}{c.hasDraft ? ' · 草稿' : ''}</span><time dateTime={new Date(c.updatedAt).toISOString()}>{new Date(c.updatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time></span>
                    </button></React.Fragment>;
            })}
            {!entries.length && <p className="nodu-chat-history-empty">{search ? '无结果' : ''}</p>}
        </div>

    </section>;
}
