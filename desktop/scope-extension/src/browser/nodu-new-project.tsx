// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import { PROJECT_CHIPS, PROJECT_FAMILIES, ProjectFamily, projectTemplates, validProjectName } from '../common/nodu-project-catalog';
import { EmbeddedError, NoduEmbeddedModel } from './nodu-embedded-model';

interface Deps { model: NoduEmbeddedModel; dialogs: FileDialogService; parent: string; family?: ProjectFamily; onBusyChange?: (busy: boolean) => void; onCreated: (project: { path: string }) => void }

export class NoduNewProjectDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps, private readonly deps: Deps) {
        super(props);
        this.node.classList.add('nodu-new-project-dialog');
        this.contentNode.classList.add('scope-widget');
    }
    get value(): undefined { return undefined; }
    protected render(): React.ReactNode { return <NewProjectForm {...this.deps} close={() => this.close()} />; }
    // React's form owns submission; Theia's dialog-wide Enter handler must not swallow it.
    protected handleEnter(event: KeyboardEvent): boolean { return false; }
}

export function NewProjectForm({ model, dialogs, parent: initialParent, family: initialFamily = 'k210', onCreated, close, onBusyChange }: Deps & { close: () => void }): React.ReactElement {
    const [family, setFamily] = React.useState<ProjectFamily>(initialFamily);
    const [chipId, setChipId] = React.useState(PROJECT_CHIPS.find(c => c.family === initialFamily)!.id);
    const [expanded, setExpanded] = React.useState({ stm32: initialFamily.startsWith('stm32'), esp32: initialFamily === 'esp32' });
    const [templateId, setTemplateId] = React.useState('empty');
    const [name, setName] = React.useState(`hello-${initialFamily}`);
    const [nameEdited, setNameEdited] = React.useState(false);
    const [parent, setParent] = React.useState(initialParent);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const pending = React.useRef(false);
    const mounted = React.useRef(true);
    React.useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const changeBusy = (value: boolean): void => { pending.current = value; if (mounted.current) { setBusy(value); onBusyChange?.(value); } };
    const [nameTouched, setNameTouched] = React.useState(false);
    const nameOk = validProjectName(name);
    const templates = projectTemplates(family, chipId);
    const switchFamily = (next: ProjectFamily): void => {
        setFamily(next); setChipId(PROJECT_CHIPS.find(c => c.family === next)!.id); setError('');
        if (!projectTemplates(next).some(t => t.id === templateId)) { setTemplateId('empty'); }
        if (!nameEdited) { setName(`hello-${next}`); }
    };
    const choose = async (): Promise<void> => {
        if (pending.current) { return; }
        changeBusy(true);
        try {
            const picked = await dialogs.showOpenDialog({ title: '项目位置', canSelectFolders: true, canSelectFiles: false, openLabel: '选择' });
            const uri = Array.isArray(picked) ? picked[0] : picked;
            if (mounted.current && uri) { setParent(uri.path.fsPath()); setError(''); }
        } catch (e) { if (mounted.current) { setError(e instanceof Error ? e.message : String(e)); } }
        finally { changeBusy(false); }
    };
    const create = async (): Promise<void> => {
        if (!nameOk || !parent.trim() || pending.current) { return; }
        changeBusy(true); setError('');
        try {
            const project = await model.call<{ path: string }>('createWorkspace', { parent, name, chip: chipId, template: templateId });
            if (mounted.current) { close(); onCreated(project); }
        } catch (e) {
            if (mounted.current) { setError(e instanceof EmbeddedError || e instanceof Error ? e.message : String(e)); }
        } finally { changeBusy(false); }
    };

    return <form className="nodu-new-project" onSubmit={event => { event.preventDefault(); void create(); }} aria-busy={busy}>
        <div className="nodu-np-body">
            <nav className="nodu-np-families" aria-label="芯片系列">
                <button type="button" className={`nodu-np-family nodu-np-root${family === 'k210' ? ' nodu-np-selected' : ''}`} aria-pressed={family === 'k210'} disabled={busy} onClick={() => switchFamily('k210')}>
                    <i className="codicon codicon-circuit-board" aria-hidden="true"/><span>K210</span>
                </button>
                <button type="button" className="nodu-np-family nodu-np-group" aria-expanded={expanded.stm32} aria-controls="nodu-stm32-families" disabled={busy} onClick={() => setExpanded(value => ({ ...value, stm32: !value.stm32 }))}>
                    <i className={`codicon codicon-chevron-${expanded.stm32 ? 'down' : 'right'}`} aria-hidden="true"/><i className="codicon codicon-circuit-board" aria-hidden="true"/><span>STM32</span>
                </button>
                <div id="nodu-stm32-families" hidden={!expanded.stm32}>
                    {PROJECT_FAMILIES.filter(item => item.id.startsWith('stm32')).map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${family === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={family === item.id} disabled={busy} onClick={() => switchFamily(item.id)}>{item.name}</button>)}
                </div>
                <button type="button" className="nodu-np-family nodu-np-group" aria-expanded={expanded.esp32} aria-controls="nodu-esp32-chips" disabled={busy} onClick={() => setExpanded(value => ({ ...value, esp32: !value.esp32 }))}>
                    <i className={`codicon codicon-chevron-${expanded.esp32 ? 'down' : 'right'}`} aria-hidden="true"/><i className="codicon codicon-circuit-board" aria-hidden="true"/><span>ESP32</span>
                </button>
                <div id="nodu-esp32-chips" hidden={!expanded.esp32}>
                    {PROJECT_CHIPS.filter(item => item.family === 'esp32').map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${chipId === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={chipId === item.id} disabled={busy} onClick={() => { switchFamily('esp32'); setChipId(item.id); }}>{item.name}</button>)}
                </div>
            </nav>
            <div className="nodu-np-fields">
                <label className="nodu-np-field" htmlFor="nodu-project-name">名称</label>
                <div><input id="nodu-project-name" value={name} disabled={busy} onChange={event => { setName(event.currentTarget.value); setNameEdited(true); setError(''); }}
                    onBlur={() => setNameTouched(true)} aria-invalid={nameTouched && !nameOk} aria-describedby={nameTouched && !nameOk ? 'nodu-name-error' : undefined} spellCheck={false} autoFocus />
                    {nameTouched && !nameOk && <p id="nodu-name-error" className="nodu-np-invalid" role="alert">以字母开头，限 40 位字母、数字、- 或 _，避开系统保留名称。</p>}
                </div>
                <label className="nodu-np-field" htmlFor="nodu-project-parent">位置</label>
                <div className="nodu-np-location"><input id="nodu-project-parent" value={parent} disabled={busy} onChange={event => { setParent(event.currentTarget.value); setError(''); }} spellCheck={false} />
                    <button type="button" className="nodu-np-browse" aria-label="浏览项目位置" title="浏览" disabled={busy} onClick={() => void choose()}><i className="codicon codicon-folder-opened" aria-hidden="true"/></button>
                </div>
                <label className="nodu-np-field" htmlFor="nodu-project-chip">型号</label>
                <select id="nodu-project-chip" value={chipId} disabled={busy} onChange={event => { setChipId(event.currentTarget.value); setError(''); }}>
                    {PROJECT_CHIPS.filter(c => c.family === family).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <label className="nodu-np-field" htmlFor="nodu-project-template">模板</label>
                <select id="nodu-project-template" value={templateId} disabled={busy} onChange={event => { setTemplateId(event.currentTarget.value); setError(''); }}>
                    {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
                {error && <p className="nodu-np-error scope-error" role="alert">{error}</p>}
            </div>
        </div>
        <div className="nodu-np-actions">
            <button type="button" className="theia-button secondary" onClick={close} disabled={busy}>取消</button>
            <button type="submit" className="theia-button main" disabled={!nameOk || !parent.trim() || busy}>{busy ? '创建中…' : '创建项目'}</button>
        </div>
    </form>;
}

export function parentOf(uri: URI | undefined, home: string): string { return uri ? uri.parent.path.fsPath() : home; }
