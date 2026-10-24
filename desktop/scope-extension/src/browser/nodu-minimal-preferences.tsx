// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from 'react-dom';
import '../../style/minimal-preferences.css';

type PreferenceAction = () => void | Promise<void>;

export function MinimalThemeIcon({ theme }: { theme: 'light' | 'dark' }): React.ReactElement {
    return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {theme === 'light'
            ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></>
            : <path d="M20.5 13.1A8.5 8.5 0 1 1 10.9 3.5a6.5 6.5 0 0 0 9.6 9.6Z"/>}
    </svg>;
}

export interface NoduMinimalPreferencesProps {
    theme: 'light' | 'dark';
    onTheme(theme: 'light' | 'dark'): void | Promise<void>;
    mode: 'simple' | 'pro';
    onMode(mode: 'simple' | 'pro'): void | Promise<void>;
    fontSize: number;
    onFontSize(size: number): void | Promise<void>;
    autoSave: boolean;
    onAutoSave(enabled: boolean): void | Promise<void>;
    wordWrap: boolean;
    onWordWrap(enabled: boolean): void | Promise<void>;
    tabSize: number;
    onTabSize(size: number): void | Promise<void>;
    onAllSettings(): void;
    onOpen?(): void;
    scopeKey: string;
    layoutNode?: HTMLElement;
}

/** Open below the right-aligned trigger, keeping the whole card in the viewport. */
export function minimalPreferencesPosition(anchor: { right: number; bottom: number }, viewport: { width: number; height: number }, height: number): React.CSSProperties {
    const edge = 8;
    const width = Math.max(1, Math.min(264, viewport.width - edge * 2));
    const maxHeight = Math.max(1, viewport.height - edge * 2);
    return {
        left: Math.max(edge, Math.min(anchor.right - width, viewport.width - width - edge)),
        top: Math.max(edge, Math.min(anchor.bottom + 6, viewport.height - Math.min(height, maxHeight) - edge)),
        width,
        maxHeight
    };
}

export function NoduMinimalPreferences(props: NoduMinimalPreferencesProps): React.ReactElement {
    const id = React.useId();
    const trigger = React.useRef<HTMLButtonElement>(null);
    const panel = React.useRef<HTMLDivElement>(null);
    const scope = React.useRef(props.scopeKey);
    scope.current = props.scopeKey;
    const alive = React.useRef(true);
    const pending = React.useRef(false);
    const generation = React.useRef(0);
    const focused = React.useRef(false);
    const [openScope, setOpenScope] = React.useState<string>();
    const [busy, setBusy] = React.useState(false);
    const [error, setError] = React.useState(false);
    const [position, setPosition] = React.useState<React.CSSProperties>();
    const visible = openScope === props.scopeKey;
    const fontSize = Math.min(40, Math.max(8, Number.isFinite(props.fontSize) ? Math.round(props.fontSize) : 14));

    const close = (restoreFocus = true): void => {
        generation.current++;
        focused.current = false;
        setOpenScope(undefined);
        setError(false);
        if (restoreFocus) { trigger.current?.focus({ preventScroll: true }); }
    };

    const show = (): void => {
        generation.current++;
        focused.current = false;
        setError(false);
        setPosition(undefined);
        setOpenScope(props.scopeKey);
        try { props.onOpen?.(); } catch { setError(true); }
    };

    const perform = async (action: PreferenceAction, closeAfter = false): Promise<void> => {
        // A synchronous ref also protects the interval before React renders disabled state.
        if (pending.current || !visible) { return; }
        pending.current = true;
        setBusy(true);
        setError(false);
        const owner = props.scopeKey;
        const version = generation.current;
        try {
            await action();
            if (alive.current && scope.current === owner && generation.current === version && closeAfter) { close(); }
        } catch {
            if (alive.current && scope.current === owner && generation.current === version) { setError(true); }
        } finally {
            pending.current = false;
            if (alive.current) { setBusy(false); }
        }
    };

    React.useEffect(() => {
        alive.current = true;
        return () => { alive.current = false; generation.current++; };
    }, []);

    React.useEffect(() => {
        generation.current++;
        focused.current = false;
        setOpenScope(undefined);
        setError(false);
    }, [props.scopeKey]);

    React.useLayoutEffect(() => {
        if (!visible || !trigger.current || !panel.current) { return; }
        const doc = trigger.current.ownerDocument;
        const view = doc.defaultView;
        const place = (): void => {
            if (!trigger.current || !panel.current) { return; }
            setPosition(minimalPreferencesPosition(trigger.current.getBoundingClientRect(), {
                width: doc.documentElement.clientWidth || view?.innerWidth || 1024,
                height: doc.documentElement.clientHeight || view?.innerHeight || 768
            }, panel.current.scrollHeight));
        };
        place();
        const observer = new ResizeObserver(place);
        observer.observe(trigger.current);
        if (props.layoutNode) { observer.observe(props.layoutNode); }
        view?.addEventListener('resize', place);
        doc.addEventListener('scroll', place, true);
        return () => { observer.disconnect(); view?.removeEventListener('resize', place); doc.removeEventListener('scroll', place, true); };
    }, [visible, error, props.layoutNode]);

    React.useLayoutEffect(() => {
        if (!visible || !position || !panel.current || focused.current) { return; }
        // The first commit measures a hidden card. Focus only after its visible
        // position is committed, otherwise the browser keeps focus on the gear.
        const first = panel.current.querySelector<HTMLButtonElement>('button[aria-pressed="true"], button');
        first?.focus({ preventScroll: true });
        focused.current = panel.current.contains(panel.current.ownerDocument.activeElement);
    }, [visible, position]);

    React.useEffect(() => {
        if (!visible || !trigger.current) { return; }
        const doc = trigger.current.ownerDocument;
        const outside = (event: Event): void => {
            const target = event.target as Node | null;
            if (target && !trigger.current?.contains(target) && !panel.current?.contains(target)) { close(false); }
        };
        doc.addEventListener('pointerdown', outside, true);
        return () => doc.removeEventListener('pointerdown', outside, true);
    }, [visible]);

    const keyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (event.nativeEvent.isComposing || event.keyCode === 229) { return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key !== 'Tab' || !panel.current) { return; }
        const controls = Array.from(panel.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]'));
        const first = controls[0], last = controls[controls.length - 1];
        const active = panel.current.ownerDocument.activeElement;
        if (!first) { event.preventDefault(); panel.current.focus(); }
        else if (event.shiftKey && (active === first || !panel.current.contains(active))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (active === last || !panel.current.contains(active))) { event.preventDefault(); first.focus(); }
        event.stopPropagation();
    };

    const segment = (label: string, selected: boolean, action: PreferenceAction, icon?: 'light' | 'dark'): React.ReactElement =>
        <button type="button" aria-label={label} title={label} aria-pressed={selected} aria-disabled={busy || undefined}
            onClick={() => { if (!selected) { void perform(action); } }}>
            {icon ? <MinimalThemeIcon theme={icon}/> : label}
        </button>;
    const toggle = (label: string, value: boolean, action: PreferenceAction): React.ReactElement =>
        <button type="button" className="nodu-minimal-preferences-toggle" role="switch" aria-label={label}
            aria-checked={value} aria-disabled={busy || undefined} onClick={() => { void perform(action); }}><span/></button>;

    return <>
        <button type="button" className="nodu-minimal-preferences-trigger" ref={trigger}
            aria-label="设置" title="设置" aria-haspopup="dialog" aria-expanded={visible}
            aria-controls={visible ? id : undefined}
            onClick={() => visible ? close() : show()}
            onKeyDown={event => {
                if (['ArrowRight', 'ArrowDown'].includes(event.key)) { event.preventDefault(); event.stopPropagation(); if (!visible) { show(); } }
                else if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); }
            }}><i className="codicon codicon-settings-gear" aria-hidden="true"/></button>
        {visible && trigger.current && createPortal(
            <div id={id} ref={panel} role="dialog" aria-label="设置" tabIndex={-1}
                className="nodu-minimal-preferences" aria-busy={busy}
                style={position ? { ...position, visibility: 'visible' } : { left: 0, top: 0, visibility: 'hidden' }} onKeyDown={keyboard}>
                <div className="nodu-minimal-preferences-row"><span>主题</span><div className="nodu-minimal-preferences-segments">
                    {segment('明亮', props.theme === 'light', () => props.onTheme('light'), 'light')}
                    {segment('暗色', props.theme === 'dark', () => props.onTheme('dark'), 'dark')}
                </div></div>
                <div className="nodu-minimal-preferences-row"><span>模式</span><div className="nodu-minimal-preferences-segments">
                    {segment('极简', props.mode === 'simple', () => props.onMode('simple'))}
                    {segment('专业', props.mode === 'pro', () => props.onMode('pro'))}
                </div></div>
                <div className="nodu-minimal-preferences-row"><span>字号</span><div className="nodu-minimal-preferences-stepper">
                    <button type="button" aria-label="减小字号" disabled={fontSize <= 8} aria-disabled={busy || undefined} onClick={() => { void perform(() => props.onFontSize(Math.max(8, fontSize - 1))); }}><i className="codicon codicon-remove" aria-hidden="true"/></button>
                    <output aria-label="字号">{fontSize}</output>
                    <button type="button" aria-label="增大字号" disabled={fontSize >= 40} aria-disabled={busy || undefined} onClick={() => { void perform(() => props.onFontSize(Math.min(40, fontSize + 1))); }}><i className="codicon codicon-add" aria-hidden="true"/></button>
                </div></div>
                <div className="nodu-minimal-preferences-row"><span>自动保存</span>{toggle('自动保存', props.autoSave, () => props.onAutoSave(!props.autoSave))}</div>
                <div className="nodu-minimal-preferences-row"><span>自动换行</span>{toggle('自动换行', props.wordWrap, () => props.onWordWrap(!props.wordWrap))}</div>
                <div className="nodu-minimal-preferences-row"><span>缩进</span><div className="nodu-minimal-preferences-segments">
                    {[2, 4, 8].map(size => <React.Fragment key={size}>{segment(String(size), props.tabSize === size, () => props.onTabSize(size))}</React.Fragment>)}
                </div></div>
                {error && <div className="nodu-minimal-preferences-error" role="alert">设置未保存，请重试</div>}
                <button type="button" className="nodu-minimal-preferences-all" aria-disabled={busy || undefined}
                    onClick={() => { void perform(props.onAllSettings, true); }}>全部设置<i className="codicon codicon-chevron-right" aria-hidden="true"/></button>
            </div>, trigger.current.ownerDocument.body
        )}
    </>;
}
