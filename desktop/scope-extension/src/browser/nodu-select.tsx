// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from 'react-dom';

export interface NoduSelectOption {
    value: string | number;
    label: string;
    disabled?: boolean;
    detail?: string;
}

export interface NoduSelectProps {
    id?: string;
    className?: string;
    'aria-label': string;
    title?: string;
    disabled?: boolean;
    value: string | number;
    options: readonly NoduSelectOption[];
    onChange: (value: string) => void;
}

interface MenuPosition { left: number; top: number; width: number; maxHeight: number; }

/** A controlled select whose preview and popup belong to the workbench on every platform. */
export function NoduSelect(props: NoduSelectProps): React.ReactElement {
    const { options, disabled, value } = props;
    const instanceId = React.useId();
    const triggerId = props.id || instanceId;
    const listId = `${triggerId}-options`;
    const trigger = React.useRef<HTMLButtonElement>(null);
    const menu = React.useRef<HTMLDivElement>(null);
    const search = React.useRef({ text: '', at: 0 });
    const [open, setOpen] = React.useState(false);
    const [preview, setPreview] = React.useState<string>();
    const [position, setPosition] = React.useState<MenuPosition>();
    const selected = options.findIndex(option => String(option.value) === String(value));
    const enabled = options.map((option, index) => option.disabled ? -1 : index).filter(index => index >= 0);
    const previewIndex = options.findIndex(option => String(option.value) === preview && !option.disabled);
    const active = previewIndex >= 0 ? previewIndex : enabled.includes(selected) ? selected : enabled[0];
    const visible = open && !disabled && enabled.length > 0;
    const selectedLabel = options[selected]?.label ?? String(value);

    const close = (restoreFocus = false) => {
        setOpen(false);
        setPosition(undefined);
        search.current = { text: '', at: 0 };
        if (restoreFocus) { trigger.current?.focus({ preventScroll: true }); }
    };
    const show = () => {
        if (disabled || !enabled.length) { return; }
        setPreview(String(options[enabled.includes(selected) ? selected : enabled[0]].value));
        setPosition(undefined);
        search.current = { text: '', at: 0 };
        setOpen(true);
        trigger.current?.focus({ preventScroll: true });
    };
    const commit = (index: number) => {
        const option = options[index];
        if (disabled || !option || option.disabled) { return; }
        close(true);
        if (String(option.value) !== String(value)) { props.onChange(String(option.value)); }
    };

    React.useEffect(() => {
        if (disabled || !enabled.length) { setOpen(false); setPosition(undefined); }
    }, [disabled, enabled.length]);

    React.useLayoutEffect(() => {
        if (!visible || !trigger.current || !menu.current) { return; }
        const doc = trigger.current.ownerDocument;
        const view = doc.defaultView;
        const bounds = trigger.current.getBoundingClientRect();
        const viewportWidth = doc.documentElement.clientWidth || view?.innerWidth || 0;
        const viewportHeight = doc.documentElement.clientHeight || view?.innerHeight || 0;
        const edge = 8, gap = 4;
        const width = Math.max(1, Math.min(Math.max(bounds.width, menu.current.scrollWidth + 2), 480, viewportWidth - edge * 2));
        const desiredHeight = Math.min(280, menu.current.scrollHeight + 2);
        const below = Math.max(0, viewportHeight - bounds.bottom - gap - edge);
        const above = Math.max(0, bounds.top - gap - edge);
        const upwards = below < desiredHeight && above > below;
        const maxHeight = Math.min(280, upwards ? above : below);
        const height = Math.min(desiredHeight, maxHeight);
        setPosition({
            left: Math.max(edge, Math.min(bounds.left, viewportWidth - width - edge)),
            top: Math.max(edge, Math.min(upwards ? bounds.top - gap - height : bounds.bottom + gap, viewportHeight - height - edge)),
            width,
            maxHeight
        });
    }, [visible, options]);

    React.useLayoutEffect(() => {
        if (!visible || !menu.current || active === undefined) { return; }
        const item = menu.current.querySelector<HTMLElement>(`[data-option-index="${active}"]`);
        if (!item) { return; }
        const top = item.offsetTop, bottom = top + item.offsetHeight;
        if (top < menu.current.scrollTop) { menu.current.scrollTop = top; }
        else if (bottom > menu.current.scrollTop + menu.current.clientHeight) {
            menu.current.scrollTop = bottom - menu.current.clientHeight;
        }
    }, [visible, active, position]);

    React.useEffect(() => {
        if (!visible || !trigger.current) { return; }
        const doc = trigger.current.ownerDocument;
        const view = doc.defaultView;
        const dismiss = () => { setOpen(false); setPosition(undefined); };
        const outside = (event: Event) => {
            const target = event.target as Node | null;
            if (target && !trigger.current?.contains(target) && !menu.current?.contains(target)) { dismiss(); }
        };
        const scroll = (event: Event) => {
            // Only scrolling an anchor ancestor moves this popup. Output and terminal
            // siblings can keep streaming while the user is choosing an option.
            const target = event.target as Node | null;
            if (target && target !== menu.current && target.contains(trigger.current)) { dismiss(); }
        };
        doc.addEventListener('pointerdown', outside, true);
        doc.addEventListener('scroll', scroll, true);
        view?.addEventListener('resize', dismiss);
        // Lumino panel sash drags do not resize the window.
        const panel = trigger.current.closest('.lm-Widget') ?? trigger.current;
        let previous = panel.getBoundingClientRect();
        const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(() => {
            const next = panel.getBoundingClientRect();
            if (Math.abs(next.width - previous.width) > 1 || Math.abs(next.height - previous.height) > 1) { dismiss(); }
            previous = next;
        });
        observer?.observe(panel);
        return () => {
            doc.removeEventListener('pointerdown', outside, true);
            doc.removeEventListener('scroll', scroll, true);
            view?.removeEventListener('resize', dismiss);
            observer?.disconnect();
        };
    }, [visible]);

    const keyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) { return; }
        const key = event.key;
        if (key === 'Tab') { if (visible) { close(); } return; }
        if (key === 'Escape') {
            if (visible) { event.preventDefault(); event.stopPropagation(); close(true); }
            return;
        }
        if (!enabled.length) { return; }
        if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Enter', ' '].includes(key)) {
            event.preventDefault();
            event.stopPropagation();
            if (key === 'Enter' || key === ' ') {
                if (visible && active !== undefined) { commit(active); } else { show(); }
            } else if (key === 'Home' || key === 'End') {
                if (!visible) { show(); }
                setPreview(String(options[key === 'Home' ? enabled[0] : enabled[enabled.length - 1]].value));
            } else if (!visible) { show(); }
            else {
                const current = enabled.indexOf(active);
                const next = enabled[(current + (key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length];
                setPreview(String(options[next].value));
            }
            return;
        }
        if (key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) { return; }
        event.preventDefault();
        event.stopPropagation();
        const now = Date.now();
        const previous = now - search.current.at < 700 ? search.current.text : '';
        const character = key.toLocaleLowerCase();
        const text = previous === character ? character : previous + character;
        search.current = { text, at: now };
        const start = enabled.indexOf(visible ? active : selected);
        for (let offset = 1; offset <= enabled.length; offset++) {
            const index = enabled[(start + offset + enabled.length) % enabled.length];
            if (options[index].label.toLocaleLowerCase().startsWith(text)) {
                setPreview(String(options[index].value));
                if (!visible) { setPosition(undefined); setOpen(true); }
                break;
            }
        }
    };

    return <>
        <button ref={trigger} id={triggerId} type="button" role="combobox"
            className={`nodu-select${props.className ? ` ${props.className}` : ''}`}
            aria-label={props['aria-label']} aria-expanded={visible} aria-haspopup="listbox"
            aria-controls={visible ? listId : undefined} aria-activedescendant={visible && active !== undefined ? `${listId}-${active}` : undefined}
            disabled={disabled || !enabled.length} title={props.title ?? selectedLabel}
            onClick={() => visible ? close() : show()} onKeyDown={keyDown}
            onBlur={() => { if (visible) { close(); } }}>
            <span className="nodu-select-label">{selectedLabel}</span>
            <i className="codicon codicon-chevron-down nodu-select-chevron" aria-hidden="true"/>
        </button>
        {visible && trigger.current && createPortal(
            <div ref={menu} id={listId} role="listbox" aria-label={props['aria-label']}
                className="nodu-select-menu" data-nodu-select-trigger={triggerId}
                style={position ? { ...position, visibility: 'visible' } : { left: 0, top: 0, visibility: 'hidden' }}>
                {options.map((option, index) => <div id={`${listId}-${index}`} key={String(option.value)}
                    role="option" aria-selected={String(option.value) === String(value)} aria-disabled={option.disabled || undefined}
                    data-option-index={index} data-active={index === active || undefined}
                    className="nodu-select-option" title={option.detail ? `${option.label} · ${option.detail}` : option.label}
                    onMouseDown={event => event.preventDefault()}
                    onMouseMove={() => { if (!option.disabled) { setPreview(String(option.value)); } }}
                    onClick={() => commit(index)}>
                    <i className={`codicon ${String(option.value) === String(value) ? 'codicon-check' : ''} nodu-select-check`} aria-hidden="true"/>
                    <span className="nodu-select-option-label">{option.label}</span>
                    {option.detail && <span className="nodu-select-detail">{option.detail}</span>}
                </div>)}
            </div>, trigger.current.ownerDocument.body
        )}
    </>;
}
