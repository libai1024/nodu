// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import type { ThemeService } from '@theia/core/lib/browser/theming';
import type { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import { NODU_REOPEN_LAST_PREF } from '../common/nodu-launcher-protocol';
import { SCOPE_LIGHT_THEME_ID, SCOPE_THEME_ID } from '../browser/scope-theme';

export interface LauncherMenuState { x: number; y: number; items: Array<{ label: string; disabled?: boolean; run(): void }> }

export function RowMenu({ state, close }: { state: LauncherMenuState; close(): void }): React.ReactElement {
    const ref = React.useRef<HTMLDivElement>(null);
    React.useLayoutEffect(() => {
        const menu = ref.current;
        if (!menu) { return; }
        const { width, height } = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(4, Math.min(state.x, window.innerWidth - width - 4))}px`;
        menu.style.top = `${Math.max(4, Math.min(state.y, window.innerHeight - height - 4))}px`;
        menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    }, [state]);
    React.useEffect(() => {
        const outside = (event: MouseEvent): void => { if (!ref.current?.contains(event.target as Node)) { close(); } };
        window.addEventListener('mousedown', outside, true); window.addEventListener('blur', close);
        return () => { window.removeEventListener('mousedown', outside, true); window.removeEventListener('blur', close); };
    }, [close]);
    return <div ref={ref} className="nodu-launcher-menu" role="menu" onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
        if (event.key === 'Tab') { close(); return; }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { return; }
        const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        if (!items.length) { return; }
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
            : event.key === 'ArrowDown' ? (index + 1) % items.length : (index <= 0 ? items.length - 1 : index - 1);
        items[next].focus(); event.preventDefault();
    }}>
        {state.items.map(item => <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
            onClick={() => { if (!item.disabled) { close(); item.run(); } }}>{item.label}</button>)}
    </div>;
}

export function SettingsPage({ themes, preferences, onError }: {
    themes: ThemeService; preferences?: PreferenceService; onError(message: string): void;
}): React.ReactElement {
    const isDark = (): boolean => themes.getCurrentTheme().type.toLowerCase().includes('dark');
    const [dark, setDark] = React.useState(isDark);
    const [reopen, setReopen] = React.useState(false);
    const [loading, setLoading] = React.useState(true);
    const [saving, setSaving] = React.useState(false);
    const pending = React.useRef(false);
    const mounted = React.useRef(true);
    const report = React.useRef(onError);
    report.current = onError;
    React.useEffect(() => {
        const listener = themes.onDidColorThemeChange(() => setDark(isDark()));
        return () => listener.dispose();
    }, [themes]);
    React.useEffect(() => {
        mounted.current = true;
        setLoading(true);
        if (!preferences) { setLoading(false); return () => { mounted.current = false; }; }
        const read = (): void => { if (mounted.current && !pending.current) { setReopen(preferences.get<boolean>(NODU_REOPEN_LAST_PREF, false)); } };
        const listener = preferences.onPreferencesChanged?.(changes => { if (NODU_REOPEN_LAST_PREF in changes) { read(); } });
        void preferences.ready.then(() => { if (mounted.current) { read(); setLoading(false); } }).catch(error => {
            if (mounted.current) { setLoading(false); report.current(error instanceof Error ? error.message : String(error)); }
        });
        return () => { mounted.current = false; listener?.dispose(); };
    }, [preferences]);
    const changeReopen = async (value: boolean): Promise<void> => {
        if (!preferences || loading || pending.current) { return; }
        pending.current = true; setSaving(true);
        try {
            await preferences.set(NODU_REOPEN_LAST_PREF, value, PreferenceScope.User);
            if (mounted.current) { setReopen(value); }
        } catch (error) {
            if (mounted.current) { report.current(error instanceof Error ? error.message : String(error)); }
        } finally { pending.current = false; if (mounted.current) { setSaving(false); } }
    };
    return <section className="nodu-launcher-page nodu-launcher-settings" aria-label="设置" aria-busy={loading || saving}>
        <header className="nodu-launcher-head"><h1>设置</h1></header>
        <div className="nodu-launcher-card">
            <div className="nodu-launcher-field">
                <div className="nodu-launcher-field-label"><strong>外观</strong></div>
                <div className="nodu-launcher-segment" role="group" aria-label="外观">
                    <button type="button" aria-pressed={dark} onClick={() => themes.setCurrentTheme(SCOPE_THEME_ID)}>深色</button>
                    <button type="button" aria-pressed={!dark} onClick={() => themes.setCurrentTheme(SCOPE_LIGHT_THEME_ID)}>浅色</button>
                </div>
            </div>
            <div className="nodu-launcher-field">
                <div className="nodu-launcher-field-label"><strong>启动</strong></div>
                <label className="nodu-launcher-switch">
                    <input type="checkbox" checked={reopen} disabled={loading || saving || !preferences}
                        onChange={event => void changeReopen(event.currentTarget.checked)}/><span aria-hidden="true"/>
                    <span className="nodu-launcher-switch-text">启动时重新打开上次的项目</span>
                </label>
            </div>
        </div>
    </section>;
}
