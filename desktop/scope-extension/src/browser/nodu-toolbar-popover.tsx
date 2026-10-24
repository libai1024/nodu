// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from 'react-dom';

/** One mounted device form survives moving the toolbar between the rail and header. */
export function NoduToolbarPopover({ open, simple, compact = false, owner, children }: {
    open: boolean; simple: boolean; compact?: boolean; owner: HTMLElement; children: React.ReactNode;
}): React.ReactElement {
    const panel = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<React.CSSProperties>({ visibility: 'hidden' });
    React.useLayoutEffect(() => {
        if (!open) { return; }
        const update = (): void => {
            const anchor = owner.querySelector('.scope-device-chip')?.getBoundingClientRect();
            if (!anchor) { return; }
            const width = Math.min(compact ? 304 : 410, window.innerWidth - 16);
            const height = Math.min(panel.current?.offsetHeight || 600, window.innerHeight - 16);
            setPosition({ position: 'fixed', width, maxHeight: window.innerHeight - 16,
                left: Math.max(8, Math.min(simple ? anchor.right + 8 : anchor.left, window.innerWidth - width - 8)),
                top: Math.max(8, Math.min(simple ? anchor.top : anchor.bottom + 8, window.innerHeight - height - 8)) });
        };
        update();
        const observer = new ResizeObserver(update);
        if (panel.current) { observer.observe(panel.current); }
        window.addEventListener('resize', update);
        return () => { observer.disconnect(); window.removeEventListener('resize', update); };
    }, [open, simple, compact, owner]);
    const focused = React.useRef(false);
    React.useLayoutEffect(() => {
        if (!open) { focused.current = false; return; }
        if (!focused.current && position.visibility !== 'hidden') {
            panel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')?.focus({ preventScroll: true });
            focused.current = true;
        }
    }, [open, position]);
    const cycleFocus = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (!compact || event.key !== 'Tab' || event.defaultPrevented || !event.currentTarget.contains(event.target as Node)) { return; }
        const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), summary, [tabindex="0"]'))
            .filter(node => node.getClientRects().length && (node.getAttribute('type') !== 'radio' || (node as HTMLInputElement).checked));
        const first = controls[0], last = controls[controls.length - 1];
        if (!first) { return; }
        if (event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus({ preventScroll: true });
        }
    };
    return createPortal(<div ref={panel} id="scope-device-popover" className={`scope-device-popover scope-widget nodu-toolbar-device-popover${compact ? ' nodu-toolbar-device-compact' : ''}`}
        role="dialog" aria-label="设备设置" hidden={!open} style={position} onKeyDown={cycleFocus}>{children}</div>, document.body);
}
