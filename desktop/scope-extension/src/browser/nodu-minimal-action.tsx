// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from 'react-dom';
import { MinimalAction, MinimalActionGesture, MinimalFanGeometry,
    MINIMAL_ACTION_LABELS, minimalFanGeometry } from './nodu-minimal-action-state';
import '../../style/minimal-action.css';

export type { MinimalAction } from './nodu-minimal-action-state';

export interface NoduMinimalActionProps {
    action: MinimalAction;
    onSelect(action: MinimalAction): void;
    onExecute(): void;
    onStop(): void;
    busy: boolean;
    disabled?: boolean;
    allowSelection: boolean;
    scopeKey: string;
    stopLabel?: string;
    stopDisabled?: boolean;
}

export function ActionIcon({ action, stop = false, play = false }: {
    action: MinimalAction; stop?: boolean; play?: boolean;
}): React.ReactElement {
    const hammer = <>
        <path d="M12.45 3.45 20.55 11.55Q21 12 20.55 12.45L16.45 16.55Q16 17 15.55 16.55L7.45 8.45Q7 8 7.45 7.55L11.55 3.45Q12 3 12.45 3.45Z" vectorEffect="non-scaling-stroke" />
        <path d="M10 11 3.45 17.55Q3 18 3.45 18.45L5.55 20.55Q6 21 6.45 20.55L13 14" vectorEffect="non-scaling-stroke" />
    </>;
    return <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {stop ? <rect x="6" y="6" width="12" height="12" rx="2" />
            : play || action === 'build-flash' ? <path d="M8.15 4.7 19.1 11.45Q20 12 19.1 12.55L8.15 19.3Q7 20 7 18.65V5.35Q7 4 8.15 4.7Z" />
                : action === 'build' ? hammer
                    : <path d="M12 3v12m-4-4 4 4 4-4M4 15v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />}
    </svg>;
}

interface OpenFan { geometry: MinimalFanGeometry; scopeKey: string; }

export function NoduMinimalAction(props: NoduMinimalActionProps): React.ReactElement {
    const trigger = React.useRef<HTMLButtonElement>(null);
    const menu = React.useRef<HTMLDivElement>(null);
    const menuOwnedFocus = React.useRef(false);
    const previousScope = React.useRef(props.scopeKey);
    const current = React.useRef(props);
    current.current = props;
    const [fan, setFan] = React.useState<OpenFan>();
    const fanRef = React.useRef(fan);
    fanRef.current = fan;
    const pressScope = React.useRef(props.scopeKey);
    const gesture = React.useRef<MinimalActionGesture | undefined>(undefined);
    const menuId = React.useId();

    const close = React.useCallback((restoreFocus = false): void => {
        setFan(undefined);
        fanRef.current = undefined;
        menuOwnedFocus.current = false;
        if (restoreFocus && trigger.current?.isConnected && !trigger.current.disabled) { trigger.current.focus({ preventScroll: true }); }
    }, []);

    const open = React.useCallback((): void => {
        const p = current.current;
        if (!p.allowSelection || p.busy || p.disabled || !trigger.current || p.scopeKey !== pressScope.current) { return; }
        const rect = trigger.current.getBoundingClientRect();
        const geometry = minimalFanGeometry(rect.left + rect.width / 2, rect.top + rect.height / 2,
            window.innerWidth, window.innerHeight);
        if (geometry) { setFan({ geometry, scopeKey: p.scopeKey }); }
    }, []);

    if (!gesture.current) { gesture.current = new MinimalActionGesture(open); }

    React.useLayoutEffect(() => {
        gesture.current?.cancel();
        const sameScope = previousScope.current === props.scopeKey;
        previousScope.current = props.scopeKey;
        close(sameScope && menuOwnedFocus.current);
    }, [props.scopeKey, props.busy, props.disabled, props.stopDisabled, props.allowSelection, close]);

    React.useEffect(() => {
        const cancel = (event?: Event): void => {
            gesture.current?.cancel();
            close(event?.type === 'resize' && menuOwnedFocus.current);
        };
        window.addEventListener('blur', cancel);
        window.addEventListener('resize', cancel);
        const hide = (): void => { if (document.hidden) { cancel(); } };
        document.addEventListener('visibilitychange', hide);
        return () => {
            gesture.current?.cancel();
            window.removeEventListener('blur', cancel);
            window.removeEventListener('resize', cancel);
            document.removeEventListener('visibilitychange', hide);
        };
    }, [close]);

    React.useLayoutEffect(() => {
        if (!fan) { return; }
        const selected = menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]');
        selected?.focus({ preventScroll: true });
    }, [fan]);

    React.useEffect(() => {
        if (!fan) { return; }
        const outside = (event: PointerEvent): void => {
            if (event.target instanceof Node && !menu.current?.contains(event.target) && !trigger.current?.contains(event.target)) {
                gesture.current?.cancel(); close();
            }
        };
        const escape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); }
        };
        document.addEventListener('pointerdown', outside, true);
        document.addEventListener('keydown', escape, true);
        return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
    }, [fan, close]);

    const title = props.busy ? props.stopDisabled ? '操作进行中' : props.stopLabel || '取消操作'
        : props.allowSelection ? `${MINIMAL_ACTION_LABELS[props.action]}（长按或右键选择）` : '运行当前代码';
    const visible = fan && fan.scopeKey === props.scopeKey && !props.busy && !props.disabled && props.allowSelection;
    return <>
        <button ref={trigger} type="button" className={`nodu-minimal-action${props.busy ? ' busy' : ''}${visible ? ' open' : ''}`}
            data-action={props.allowSelection && props.action !== 'build-flash' ? props.action : 'run'}
            data-state={props.busy ? 'busy' : props.disabled ? 'disabled' : 'idle'}
            disabled={Boolean(props.busy ? props.stopDisabled : props.disabled)} title={title} aria-label={title}
            aria-haspopup={props.allowSelection ? 'menu' : undefined} aria-expanded={props.allowSelection ? Boolean(visible) : undefined}
            aria-controls={visible ? menuId : undefined} aria-keyshortcuts={props.allowSelection ? 'Shift+F10' : undefined}
            onPointerDown={event => {
                if (event.button !== 0) { return; }
                if (fanRef.current) { gesture.current?.cancel(); close(); return; }
                pressScope.current = current.current.scopeKey;
                gesture.current?.begin(event.pointerId, event.clientX, event.clientY, props.allowSelection && !props.busy && !props.disabled);
                event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={event => gesture.current?.move(event.pointerId, event.clientX, event.clientY)}
            onPointerUp={event => gesture.current?.release(event.pointerId)}
            onPointerCancel={() => gesture.current?.cancel()}
            onLostPointerCapture={event => gesture.current?.lostCapture(event.pointerId)}
            onClick={event => {
                if (gesture.current?.consumeClick(event.detail)) { return; }
                if (fanRef.current) { close(true); return; }
                if (current.current.busy) { if (!current.current.stopDisabled) { current.current.onStop(); } }
                else if (!current.current.disabled) { current.current.onExecute(); }
            }}
            onContextMenu={event => {
                if (!props.allowSelection) { return; }
                event.preventDefault();
                gesture.current?.cancel();
                pressScope.current = current.current.scopeKey;
                open();
            }}
            onKeyDown={event => {
                if (props.allowSelection && ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu'
                    || event.key === 'ArrowRight' || event.key === 'ArrowUp')) {
                    event.preventDefault();
                    pressScope.current = current.current.scopeKey;
                    open();
                } else if (event.key === 'Enter' || event.key === ' ') {
                    // Keyboard activation starts a new explicit action, independent of a cancelled pointer.
                    gesture.current?.consumeClick();
                }
            }}>
            <ActionIcon action={props.action} stop={props.busy} play={!props.allowSelection} />
        </button>
        {visible && createPortal(<div id={menuId} ref={menu} className="nodu-minimal-fan" role="menu" aria-label="选择操作"
            style={{ left: fan.geometry.left, top: fan.geometry.top, width: fan.geometry.size, height: fan.geometry.size }}
            onFocusCapture={() => { menuOwnedFocus.current = true; }}
            onBlurCapture={event => {
                if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
                    menuOwnedFocus.current = false;
                }
            }}
            onKeyDown={event => {
                const items = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') || []);
                const active = items.findIndex(item => item === document.activeElement);
                let next: number | undefined;
                if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { next = (active + 1) % items.length; }
                else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { next = (active + items.length - 1) % items.length; }
                else if (event.key === 'Home') { next = 0; }
                else if (event.key === 'End') { next = items.length - 1; }
                else if (event.key === 'Tab') { event.preventDefault(); close(true); }
                if (next !== undefined) { event.preventDefault(); items[next]?.focus(); }
            }}>
            {fan.geometry.items.map(item => <button key={item.action} type="button" role="menuitemradio"
                className="nodu-minimal-fan-circle" aria-label={MINIMAL_ACTION_LABELS[item.action]}
                aria-checked={props.action === item.action} title={MINIMAL_ACTION_LABELS[item.action]} tabIndex={-1}
                style={{ left: item.left, top: item.top }} onClick={() => {
                    const p = current.current;
                    if (p.scopeKey !== fan.scopeKey || p.busy || p.disabled || !p.allowSelection) { close(); return; }
                    p.onSelect(item.action);
                    close(true);
                }}>
                <ActionIcon action={item.action} />
            </button>)}
        </div>, document.body)}
    </>;
}
