// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from '@theia/core/shared/react-dom';
import type { NoduTutorModel } from './nodu-tutor-model';

/** All chat menus use the same bounded overlay, outside the clipped composer. */
export function ChatPopover({ anchor, label, above, width = 'content', minWidth = 144, align = 'end', layer = 'chat', close, children }: {
    anchor: HTMLElement; label: string; above?: boolean; width?: number | 'content'; minWidth?: number; align?: 'start' | 'end'; layer?: 'chat' | 'settings'; close(): void; children: React.ReactNode;
}): React.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const node = ref.current;
        if (!node) { return; }
        const place = (): void => {
            const rect = anchor.getBoundingClientRect(), availableWidth = Math.max(0, window.innerWidth - 16);
            // Short actions fit their contents; names and paths can grow up to 288px.
            node.style.minWidth = `${Math.min(typeof width === 'number' ? width : minWidth, availableWidth)}px`;
            node.style.maxWidth = `${Math.min(typeof width === 'number' ? width : 288, availableWidth)}px`;
            node.style.width = typeof width === 'number' ? `${Math.min(width, availableWidth)}px` : 'max-content';
            node.style.maxHeight = `${Math.max(120, window.innerHeight - 24)}px`;
            const { width: boundedWidth, height } = node.getBoundingClientRect();
            const y = above ? rect.top - height - 6 : rect.bottom + 6;
            const x = align === 'start' ? rect.left : rect.right - boundedWidth;
            node.style.left = `${Math.max(8, Math.min(x, window.innerWidth - boundedWidth - 8))}px`;
            node.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
        };
        place();
        (node.querySelector<HTMLElement>('input') ?? node.querySelector<HTMLElement>('[aria-checked="true"]:not(:disabled)') ?? node.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? node).focus();
        const outside = (e: PointerEvent): void => { if (!node.contains(e.target as Node) && !anchor.contains(e.target as Node)) { close(); } };
        const observer = new ResizeObserver(place); observer.observe(node);
        document.addEventListener('pointerdown', outside, true); window.addEventListener('resize', place);
        return () => { observer.disconnect(); document.removeEventListener('pointerdown', outside, true); window.removeEventListener('resize', place); };
    }, [anchor, above, width, minWidth, align, close]);
    React.useLayoutEffect(() => {
        const node = ref.current;
        // Switching from the attachment menu to its async file list removes the
        // focused menu item. Keep keyboard navigation inside the replacement.
        if (node && (document.activeElement === document.body || document.activeElement === anchor)) {
            (node.querySelector<HTMLElement>('input') ?? node.querySelector<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? node).focus();
        }
    }, [children, anchor]);
    const dismiss = (): void => { close(); anchor.isConnected && anchor.focus(); };
    return createPortal(<div ref={ref} className={`nodu-ai-popover${layer === 'settings' ? ' nodu-ai-popover-settings' : ''}`} tabIndex={-1} aria-label={label} role="menu" onKeyDown={e => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
        // Portal events still bubble through React's parent dialog. It must not
        // process this Tab again after focus has returned to the menu trigger.
        if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); dismiss(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || (e.target instanceof HTMLInputElement && !e.key.startsWith('Arrow'))) { return; }
        const items = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not(:disabled)') ?? []);
        if (!items.length) { return; }
        e.preventDefault(); e.stopPropagation();
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : current < 0 ? (e.key === 'ArrowDown' ? 0 : items.length - 1) : (current + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        items[next].focus();
    }}>{children}</div>, document.body);
}

const CHAT_MODES = [
    { value: 'teach', label: '教学', icon: 'mortar-board' },
    { value: 'ask', label: '提问', icon: 'comment-discussion' },
] as const;

/** Mode, model and context menus share the same app-rendered overlay. */
export function ModePicker({ tutor }: { tutor: NoduTutorModel }): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement>();
    const close = React.useCallback(() => setAnchor(undefined), []);
    const disabled = !!tutor.busy || tutor.conversationLoading;
    const current = CHAT_MODES.find(mode => mode.value === tutor.mode)!;
    return <><button type="button" className="nodu-ai-mode-select" aria-label="对话模式" aria-haspopup="menu" aria-expanded={!!anchor}
        title={`对话模式：${current.label}`} disabled={disabled}
        onClick={e => { if (!disabled) { setAnchor(anchor ? undefined : e.currentTarget); } }}
        onKeyDown={e => {
            if (!disabled && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                e.preventDefault(); e.stopPropagation(); setAnchor(e.currentTarget);
            }
        }}><i className={`codicon codicon-${current.icon}`} aria-hidden="true"/><span>{current.label}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
    </button>{anchor && <ChatPopover anchor={anchor} label="对话模式" above width={112} align="start" close={close}>
        {CHAT_MODES.map(mode => <button key={mode.value} type="button" role="menuitemradio" aria-checked={tutor.mode === mode.value} disabled={disabled}
            onClick={() => { if (disabled) { return; } tutor.setMode(mode.value); close(); if (anchor.isConnected) { anchor.focus(); } }}>
            <span className="nodu-ai-menu-option-label"><i className={`codicon codicon-${mode.icon}`} aria-hidden="true"/><span>{mode.label}</span></span>
            <i className={`codicon ${tutor.mode === mode.value ? 'codicon-check' : ''}`} aria-hidden="true"/>
        </button>)}
    </ChatPopover>}</>;
}

export function ModelPicker({ tutor, openSettings }: { tutor: NoduTutorModel; openSettings(anchor: HTMLElement): void }): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement>();
    const [search, setSearch] = React.useState(''), [error, setError] = React.useState('');
    const close = React.useCallback(() => { setAnchor(undefined); setSearch(''); setError(''); }, []);
    const settings = tutor.settings, selection = settings?.selection;
    const needsSetup = !!settings && !tutor.configured;
    const groups = (settings?.providers ?? []).filter(p => p.enabled && p.models.some(m => m.enabled));
    const total = groups.reduce((n, p) => n + p.models.filter(m => m.enabled).length, 0);
    const query = search.toLocaleLowerCase();
    const visible = groups.map(p => ({ ...p, models: p.models.filter(m => m.enabled && `${p.name} ${m.id}`.toLocaleLowerCase().includes(query)) })).filter(p => p.models.length);
    return <><button type="button" className="nodu-ai-model" aria-label="模型" aria-haspopup={needsSetup ? 'dialog' : 'menu'} aria-expanded={!!anchor}
        title={selection?.modelId ?? '选择模型'} onClick={e => { if (needsSetup) { openSettings(e.currentTarget); } else if (anchor) { close(); } else { setAnchor(e.currentTarget); } }}>
        <span>{needsSetup ? '配置模型' : selection?.modelId ?? '选择模型'}</span><i className="codicon codicon-chevron-down" aria-hidden="true"/>
    </button>{anchor && <ChatPopover anchor={anchor} label="模型" above width={total > 8 ? 288 : 'content'} minWidth={160} close={close}>
        {total > 8 && <input className="nodu-ai-menu-search" aria-label="搜索模型" value={search} onChange={e => setSearch(e.target.value)}/>}
        <div className="nodu-ai-menu-scroll">{visible.map(p => <React.Fragment key={p.id}>
            <div className="nodu-ai-menu-group">{p.name}</div>{p.models.map(m => <button type="button" role="menuitemradio" aria-checked={selection?.providerId === p.id && selection.modelId === m.id}
                key={m.id} disabled={!!tutor.busy || tutor.conversationLoading} onClick={async () => { try { await tutor.selectModel({ providerId: p.id, modelId: m.id }); close(); anchor.focus(); } catch { setError('模型切换失败，请重试'); } }}>
                <span>{m.id}</span><i className={`codicon ${selection?.providerId === p.id && selection.modelId === m.id ? 'codicon-check' : ''}`} aria-hidden="true"/>
            </button>)}</React.Fragment>)}{!visible.length && <div className="nodu-ai-menu-empty">{search ? '没有匹配的模型' : '尚未配置模型'}</div>}</div>
        {error && <div className="nodu-ai-menu-empty" role="status">{error}</div>}
        <div className="nodu-ai-menu-divider"/><button type="button" role="menuitem" onClick={() => { close(); openSettings(anchor); }}>管理模型<i className="codicon codicon-settings-gear" aria-hidden="true"/></button>
    </ChatPopover>}</>;
}

export function ChatHeader({ tutor, clear }: { tutor: NoduTutorModel; clear(): Promise<void> }): React.ReactElement {
    const [anchor, setAnchor] = React.useState<HTMLElement>();
    const close = React.useCallback(() => setAnchor(undefined), []);
    return <div className="nodu-ai-titlebar">
        <button type="button" className="nodu-ai-icon" aria-label="新对话" title="新对话" disabled={!!tutor.busy || tutor.conversationLoading} onClick={() => void tutor.newConversation()}><i className="codicon codicon-add" aria-hidden="true"/></button>
        <button type="button" className="nodu-ai-icon" aria-label="历史对话" title="历史对话" aria-pressed={tutor.historyOpen} onClick={() => tutor.showHistory(!tutor.historyOpen)}><i className="codicon codicon-history" aria-hidden="true"/></button>
        <button type="button" className="nodu-ai-icon" aria-label="对话操作" title="对话操作" aria-haspopup="menu" aria-expanded={!!anchor} onClick={e => setAnchor(anchor ? undefined : e.currentTarget)}><i className="codicon codicon-ellipsis" aria-hidden="true"/></button>
        {anchor && <ChatPopover anchor={anchor} label="对话操作" close={close}>
            <button type="button" role="menuitem" disabled={!!tutor.busy || tutor.conversationLoading || !tutor.messages[tutor.mode].length} onClick={() => { close(); anchor.focus(); void clear(); }}>清空当前对话<i className="codicon codicon-clear-all" aria-hidden="true"/></button>
        </ChatPopover>}
    </div>;
}
