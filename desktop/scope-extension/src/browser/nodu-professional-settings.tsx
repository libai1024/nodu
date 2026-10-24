// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createRoot, Root } from '@theia/core/shared/react-dom/client';
import { inject, injectable } from '@theia/core/shared/inversify';
import { CommandService, DisposableCollection, Emitter, MessageService } from '@theia/core/lib/common';
import { PreferenceService } from '@theia/core/lib/common/preferences/preference-service';
import { PreferenceScope } from '@theia/core/lib/common/preferences/preference-scope';
import { getThemeMode } from '@theia/core/lib/common/theme';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { EditorManager } from '@theia/editor/lib/browser';
import { ScopeLayoutState } from './scope-layout-state';
import { SCOPE_LIGHT_THEME_ID, SCOPE_THEME_ID } from './scope-theme';
import { NoduTutorModel } from './nodu-tutor-model';
import { AISettingsPanel } from './nodu-ai-provider-settings';
import { MinimalThemeIcon, NoduMinimalPreferencesProps } from './nodu-minimal-preferences';
import '../../style/professional-settings.css';

export type ProfessionalSettingsPage = 'general' | 'ai';
type SettingsValues = Pick<NoduMinimalPreferencesProps, 'theme' | 'onTheme' | 'mode' | 'onMode' | 'fontSize' | 'onFontSize' | 'autoSave' | 'onAutoSave' | 'wordWrap' | 'onWordWrap' | 'tabSize' | 'onTabSize'>;
interface ProfessionalSettingsProps extends SettingsValues {
    tutor: NoduTutorModel;
    page: ProfessionalSettingsPage;
    onPage(page: ProfessionalSettingsPage): void;
    close(): void;
    allSettings(): void;
}

/** One modal surface; provider/key editing stays owned by AISettingsPanel. */
export function ProfessionalSettingsDialog(props: ProfessionalSettingsProps): React.ReactElement {
    const id = React.useId(), dialog = React.useRef<HTMLDivElement>(null);
    const alive = React.useRef(true), pending = React.useRef(false);
    const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(false);
    const fontSize = Math.min(40, Math.max(8, Number.isFinite(props.fontSize) ? Math.round(props.fontSize) : 14));
    React.useLayoutEffect(() => {
        alive.current = true;
        dialog.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
        return () => { alive.current = false; };
    }, []);
    const perform = async (action: () => void | Promise<void>): Promise<void> => {
        if (pending.current) { return; }
        pending.current = true; setBusy(true); setError(false);
        try { await action(); } catch { if (alive.current) { setError(true); } }
        finally { pending.current = false; if (alive.current) { setBusy(false); } }
    };
    const segment = (label: string, selected: boolean, action: () => void | Promise<void>, icon?: 'light' | 'dark'): React.ReactElement =>
        <button type="button" aria-label={label} title={label} aria-pressed={selected} aria-disabled={busy || undefined}
            onClick={() => { if (!selected) { void perform(action); } }}>{icon ? <><MinimalThemeIcon theme={icon}/><span>{label}</span></> : label}</button>;
    const toggle = (label: string, checked: boolean, action: () => void | Promise<void>): React.ReactElement =>
        <button type="button" className="nodu-minimal-preferences-toggle" role="switch" aria-label={label} aria-checked={checked}
            aria-disabled={busy || undefined} onClick={() => { void perform(action); }}><span/></button>;
    const keyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
        if (event.nativeEvent.isComposing || event.keyCode === 229 || event.defaultPrevented) { return; }
        // A nested model dialog owns its own Escape and Tab cycle.
        if (event.target instanceof Element && event.target.closest('[role="dialog"]') !== dialog.current) { return; }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); props.close(); return; }
        if (event.key !== 'Tab' || !dialog.current) { return; }
        const controls = Array.from(dialog.current.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), [tabindex="0"]'))
            .filter(control => !control.closest('[hidden]'));
        const first = controls[0], last = controls.at(-1), active = dialog.current.ownerDocument.activeElement;
        if (!first) { event.preventDefault(); dialog.current.focus(); }
        else if (event.shiftKey && (active === first || !dialog.current.contains(active))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) { event.preventDefault(); first.focus(); }
        event.stopPropagation();
    };
    const tab = (page: ProfessionalSettingsPage, label: string): React.ReactElement => <button type="button" role="tab" id={`${id}-${page}-tab`}
        aria-selected={props.page === page} aria-controls={`${id}-${page}`} tabIndex={props.page === page ? 0 : -1}
        onClick={() => props.onPage(page)} onKeyDown={event => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) { return; }
            event.preventDefault(); event.stopPropagation();
            const next = event.key === 'Home' ? 'general' : event.key === 'End' ? 'ai' : page === 'general' ? 'ai' : 'general';
            props.onPage(next);
            dialog.current?.querySelector<HTMLElement>(`[id="${id}-${next}-tab"]`)?.focus();
        }}><i className={`codicon codicon-${page === 'general' ? 'settings-gear' : 'sparkle'}`} aria-hidden="true"/><span>{label}</span></button>;
    return <div className="nodu-professional-settings-backdrop" onPointerDown={event => { if (event.target === event.currentTarget) { event.preventDefault(); props.close(); } }}>
        <div ref={dialog} className="scope-widget nodu-professional-settings" role="dialog" aria-modal="true" aria-label="设置" tabIndex={-1} onKeyDown={keyboard}>
            <div className="nodu-professional-settings-title"><h2>设置</h2></div>
            <header className="nodu-professional-settings-header"><button type="button" className="nodu-ai-icon" title="关闭 Esc" aria-label="关闭设置" onClick={props.close}><i className="codicon codicon-close" aria-hidden="true"/></button></header>
            <div className="nodu-professional-settings-tabs" role="tablist" aria-orientation="vertical" aria-label="设置分类">{tab('general', '通用')}{tab('ai', 'AI')}</div>
            <section id={`${id}-general`} role="tabpanel" aria-labelledby={`${id}-general-tab`} hidden={props.page !== 'general'} className="nodu-professional-settings-general" aria-busy={busy}>
                <div className="nodu-professional-settings-group">
                <div className="nodu-minimal-preferences-row nodu-professional-settings-theme"><span>主题</span><div className="nodu-minimal-preferences-segments">
                    {segment('明亮', props.theme === 'light', () => props.onTheme('light'), 'light')}{segment('暗色', props.theme === 'dark', () => props.onTheme('dark'), 'dark')}
                </div></div>
                <div className="nodu-minimal-preferences-row"><span>模式</span><div className="nodu-minimal-preferences-segments">
                    {segment('极简', props.mode === 'simple', () => props.onMode('simple'))}{segment('专业', props.mode === 'pro', () => props.onMode('pro'))}
                </div></div>
                </div>
                <div className="nodu-professional-settings-group">
                <div className="nodu-minimal-preferences-row"><span>字号</span><div className="nodu-minimal-preferences-stepper">
                    <button type="button" aria-label="减小字号" disabled={fontSize <= 8} aria-disabled={busy || undefined} onClick={() => void perform(() => props.onFontSize(fontSize - 1))}><i className="codicon codicon-remove" aria-hidden="true"/></button>
                    <output aria-label="字号">{fontSize}</output>
                    <button type="button" aria-label="增大字号" disabled={fontSize >= 40} aria-disabled={busy || undefined} onClick={() => void perform(() => props.onFontSize(fontSize + 1))}><i className="codicon codicon-add" aria-hidden="true"/></button>
                </div></div>
                <div className="nodu-minimal-preferences-row"><span>自动保存</span>{toggle('自动保存', props.autoSave, () => props.onAutoSave(!props.autoSave))}</div>
                <div className="nodu-minimal-preferences-row"><span>自动换行</span>{toggle('自动换行', props.wordWrap, () => props.onWordWrap(!props.wordWrap))}</div>
                <div className="nodu-minimal-preferences-row"><span>缩进</span><div className="nodu-minimal-preferences-segments">
                    {[2, 4, 8].map(size => <React.Fragment key={size}>{segment(String(size), props.tabSize === size, () => props.onTabSize(size))}</React.Fragment>)}
                </div></div>
                </div>
                {error && <div className="nodu-minimal-preferences-error" role="alert">设置未保存，请重试</div>}
                <button type="button" className="nodu-minimal-preferences-all" onClick={props.allSettings}>全部设置<i className="codicon codicon-chevron-right" aria-hidden="true"/></button>
            </section>
            <section id={`${id}-ai`} role="tabpanel" aria-labelledby={`${id}-ai-tab`} hidden={props.page !== 'ai'} className="nodu-professional-settings-ai">
                <AISettingsPanel tutor={props.tutor} visible={props.page === 'ai'}/>
                <div className="nodu-professional-settings-ai-footer"><span title="完成一行后，将当前文件发送给所选模型进行检查">逐行 AI 检查</span>
                    {toggle('逐行 AI 检查', props.tutor.autoReview, () => props.tutor.setDisplay('autoReview', !props.tutor.autoReview))}</div>
            </section>
        </div>
    </div>;
}

/** Shared professional settings for the corner gear and every AI settings command. */
@injectable()
export class NoduProfessionalSettings {
    @inject(NoduTutorModel) protected readonly tutor!: NoduTutorModel;
    @inject(PreferenceService) protected readonly preferences!: PreferenceService;
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(ScopeLayoutState) protected readonly layout!: ScopeLayoutState;
    @inject(CommandService) protected readonly commands!: CommandService;
    @inject(EditorManager) protected readonly editors!: EditorManager;
    @inject(MessageService) protected readonly messages!: MessageService;
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    private host?: HTMLDivElement;
    private root?: Root;
    private listeners?: DisposableCollection;
    private anchor?: HTMLElement;
    private page: ProfessionalSettingsPage = 'general';
    private inert: { node: HTMLElement; previous: boolean }[] = [];
    get isOpen(): boolean { return !!this.host; }

    toggle(page: ProfessionalSettingsPage = 'general', anchor?: HTMLElement): void {
        if (this.host) { this.close(); } else { this.open(page, anchor); }
    }
    open(page: ProfessionalSettingsPage = 'general', anchor?: HTMLElement): void {
        if (this.layout.mode !== 'pro') { return; }
        this.page = page;
        if (this.host) { this.render(); return; }
        this.anchor = anchor ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
        this.layout.setDeviceOpen(false);
        const host = document.createElement('div');
        host.className = 'nodu-professional-settings-host';
        this.host = host; document.body.appendChild(host);
        // Prevent background controls from entering the modal keyboard/accessibility cycle.
        this.inert = Array.from(document.body.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== host)
            .map(node => { const previous = node.inert; node.inert = true; return { node, previous }; });
        this.root = createRoot(host);
        this.listeners = new DisposableCollection();
        const project = this.layout.projectPath;
        this.listeners.push(this.layout.onDidChange(() => { if (this.layout.mode !== 'pro' || this.layout.projectPath !== project) { this.close(false); } }));
        this.listeners.push(this.preferences.onPreferenceChanged(() => this.render()));
        this.listeners.push(this.themes.onDidColorThemeChange(() => this.render()));
        this.listeners.push(this.tutor.onDidChange(() => this.render()));
        this.render(); this.changed.fire();
        void this.tutor.refreshSettings();
    }
    close(restoreFocus = true): void {
        if (!this.host) { return; }
        this.listeners?.dispose(); this.listeners = undefined;
        this.root?.unmount(); this.root = undefined;
        this.host.remove(); this.host = undefined;
        for (const { node, previous } of this.inert) { node.inert = previous; }
        this.inert = [];
        const anchor = this.anchor; this.anchor = undefined;
        this.changed.fire();
        if (restoreFocus && anchor?.isConnected) { anchor.focus({ preventScroll: true }); }
    }
    private render(): void {
        if (!this.root) { return; }
        const preference = (key: string, value: unknown): Promise<void> => this.preferences.set(key, value, PreferenceScope.User);
        this.root.render(<ProfessionalSettingsDialog tutor={this.tutor} page={this.page} onPage={page => { this.page = page; this.render(); }} close={() => this.close()}
            theme={getThemeMode(this.themes.getCurrentTheme().type)} onTheme={theme => this.themes.setCurrentTheme(theme === 'light' ? SCOPE_LIGHT_THEME_ID : SCOPE_THEME_ID)}
            mode={this.layout.mode} onMode={async mode => { await this.commands.executeCommand(`scope.layout.${mode}`); this.editors.currentEditor?.activate(); }}
            fontSize={this.preferences.get<number>('editor.fontSize', 14)} onFontSize={value => preference('editor.fontSize', value)}
            autoSave={this.preferences.get<string>('files.autoSave', 'off') !== 'off'} onAutoSave={value => preference('files.autoSave', value ? 'afterDelay' : 'off')}
            wordWrap={this.preferences.get<string>('editor.wordWrap', 'off') !== 'off'} onWordWrap={value => preference('editor.wordWrap', value ? 'on' : 'off')}
            tabSize={this.preferences.get<number>('editor.tabSize', 4)} onTabSize={value => preference('editor.tabSize', value)}
            allSettings={() => { this.close(); void this.commands.executeCommand('preferences:open').catch(() => this.messages.error('无法打开全部设置')); }}/>);
    }
}
