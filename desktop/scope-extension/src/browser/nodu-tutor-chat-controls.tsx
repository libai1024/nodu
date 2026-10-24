// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { NoduTutorModel } from './nodu-tutor-model';

/** All chat menus use the same bounded overlay, outside the clipped composer. */
export function ChatPopover({ anchor, label, above, close, children }: {
    anchor: HTMLElement; label: string; above?: boolean; close(): void; children: React.ReactNode;
}): React.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) { return; }
        const place = (): void => {
            const rect = anchor.getBoundingClientRect(), width = Math.min(288, window.innerWidth - 16);
            node.style.width = `${width}px`;
            node.style.maxHeight = `${Math.max(120, window.innerHeight - 24)}px`;
            const height = node.getBoundingClientRect().height;
            const y = above ? rect.top - height - 6 : rect.bottom + 6;
            node.style.left = `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`;
            node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
        };
        place();
        (node.querySelector<HTMLElement>('input') ?? node.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? node.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? node).focus();
        const outside = (e: PointerEvent): void => { if (!node.contains(e.target as Node) && !anchor.contains(e.target as Node)) { close(); } };
        const observer = new ResizeObserver(place); observer.observe(node);
        document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place);
        return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); };
    }, [anchor, above, close]);
    React.useLayoutEffect(() => {
        const node = ref.current;
        // Switching from the attachment menu to its async file list removes the
        // focused menu item. Keep keyboard navigation inside the replacement.
        if (node && (document.activeElement === document.body || document.activeElement === anchor)) {
            (node.querySelector<HTMLElement>('input') ?? node.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? node).focus();
        }
    }, [children, anchor]);
    const dismiss = (): void => { close(); anchor.isConnected && anchor.focus(); };
    return createPortal(<div ref={ref} className="scope-widget nodu-ai-popover" tabIndex={-1} aria-label={label} role="menu" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
        if (e.key === 'Tab') { e.preventDefault(); dismiss(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || (e.target instanceof HTMLInputElement && !e.key.startsWith('Arrow'))) { return; }
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
        if (!items.length) { return; }
        e.preventDefault(); e.stopPropagation();
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
    }}>{children}</div>, document.body);
}

export function ModelPicker({ tutor, openSettings }: { tutor: NoduTutorModel; openSettings(anchor: HTMLElement): void }): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement>();
    const [search, setSearch] = React.useState(''), [error, setError] = React.useState('');
    const close = React.useCallback(() => { setAnchor(undefined); setSearch(''); setError(''); }, []);
    const settings = tutor.settings, selection = settings?.selection;
    const groups = (settings?.providers ?? []).filter(p => p.enabled && p.models.some(m => m.enabled));
    const total = groups.reduce((n, p) => n + p.models.filter(m => m.enabled).length, 0);
    const query = search.toLocaleLowerCase();
    const visible = groups.map(p => ({ ...p, models: p.models.filter(m => m.enabled && `${p.name} ${m.id}`.toLocaleLowerCase().includes(query)) })).filter(p => p.models.length);
    return <><button type="button" className="nodu-ai-model" aria-label="模型" aria-haspopup="menu" aria-expanded={!!anchor}
        title={tutor.busy ? '停止回复后可切换模型' : selection?.modelId ?? '选择模型'} onClick={e => { if (anchor) { close(); } else { setAnchor(e.currentTarget); } }}>
        <span>{selection?.modelId ?? '选择模型'}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
    </button>{anchor && <ChatPopover anchor={anchor} label="模型" above close={close}>
        {total > 8 && <input className="nodu-ai-menu-search" aria-label="搜索模型" placeholder="搜索模型" value={search} onChange={e => setSearch(e.target.value)}/>}
        <div className="nodu-ai-menu-scroll">{visible.map(p => <React.Fragment key={p.id}>
            <div className="nodu-ai-menu-group">{p.name}</div>{p.models.map(m => <button type="button" role="menuitemradio" aria-checked={selection?.providerId === p.id && selection.modelId === m.id}
                key={m.id} disabled={!!tutor.busy || tutor.conversationLoading} onClick={async () => { try { await tutor.selectModel({ providerId: p.id, modelId: m.id }); close(); anchor.focus(); } catch { setError('模型切换失败，请重试'); } }}>
                <span>{m.id}</span><i className={`codicon ${selection?.providerId === p.id && selection.modelId === m.id ? 'codicon-check' : ''}`} aria-hidden="true"/>
            </button>)}</React.Fragment>)}{!visible.length && <div className="nodu-ai-menu-empty">{search ? '没有匹配的模型' : '尚未配置模型'}</div>}</div>
        {error && <div className="nodu-ai-menu-empty" role="status">{error}</div>}
        {tutor.busy && <div className="nodu-ai-menu-empty">停止回复后可切换模型</div>}
        <div className="nodu-ai-menu-divider"/><button type="button" role="menuitem" onClick={() => { close(); openSettings(anchor); }}>管理模型<i className="codicon codicon-settings-gear" aria-hidden="true"/></button>
    </ChatPopover>}</>;
}

export function ChatHeader({ tutor, clear }: { tutor: NoduTutorModel; clear(): Promise<void> }): React.ReactElement {
    const [menu, setMenu] = React.useState<{ kind: 'history' | 'more'; anchor: HTMLElement }>();
    const [search, setSearch] = React.useState('');
    const close = React.useCallback(() => { setMenu(undefined); setSearch(''); }, []);
    const toggle = (kind: 'history' | 'more', anchor: HTMLElement): void => { if (menu?.kind === kind) { close(); } else { setMenu({ kind, anchor }); } };
    const conversations = tutor.conversations ?? [];
    return <div className="nodu-ai-titlebar">
        <button type="button" className="nodu-ai-icon" aria-label="新对话" title="新对话" disabled={!!tutor.busy || tutor.conversationLoading} onClick={() => void tutor.newConversation()}><i className="codicon codicon-add" aria-hidden="true"/></button>
        <button type="button" className="nodu-ai-icon" aria-label="历史对话" title="历史对话" aria-haspopup="menu" aria-expanded={menu?.kind === 'history'} onClick={e => toggle('history', e.currentTarget)}><i className="codicon codicon-history" aria-hidden="true"/></button>
        <button type="button" className="nodu-ai-icon" aria-label="对话操作" title="对话操作" aria-haspopup="menu" aria-expanded={menu?.kind === 'more'} onClick={e => toggle('more', e.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
        {menu && <ChatPopover anchor={menu.anchor} label={menu.kind === 'history' ? '历史对话' : '对话操作'} close={close}>
            {menu.kind === 'history' ? <>
                {conversations.length > 8 && <input className="nodu-ai-menu-search" aria-label="搜索对话" placeholder="搜索对话" value={search} onChange={e => setSearch(e.target.value)}/>}
                <div className="nodu-ai-menu-scroll">{conversations.filter(c => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(c =>
                    <button type="button" role="menuitemradio" aria-checked={c.id === tutor.activeConversationId} key={c.id} disabled={!!tutor.busy || tutor.conversationLoading} title={c.title}
                        onClick={() => { const anchor = menu.anchor; close(); anchor.focus(); void tutor.selectConversation(c.id); }}><span>{c.title}</span><i className={`codicon ${c.id === tutor.activeConversationId ? 'codicon-check' : ''}`} aria-hidden="true"/></button>)}
                    {!conversations.some(c => c.title.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <div className="nodu-ai-menu-empty">{search ? '没有匹配的对话' : '暂无历史对话'}</div>}
                </div>
            </> : <button type="button" role="menuitem" disabled={!!tutor.busy || tutor.conversationLoading || !tutor.messages[tutor.mode].length} onClick={() => { const anchor = menu.anchor; close(); anchor.focus(); void clear(); }}>清空当前对话<i className="codicon codicon-clear-all" aria-hidden="true"/></button>}
        </ChatPopover>}
    </div>;
}
