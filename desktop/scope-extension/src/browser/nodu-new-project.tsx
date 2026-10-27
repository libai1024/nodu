// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import { ESP_PROJECT_FRAMEWORKS, EspProjectFramework, PROJECT_CHIPS, PROJECT_FAMILIES, ProjectFamily, projectTemplates, validProjectName } from '../common/nodu-project-catalog';
import { EmbeddedError, NoduEmbeddedModel } from './nodu-embedded-model';
import { ChipMark, FrameworkMark } from './nodu-project-icon';
import { NoduSelect } from './nodu-select';
import '../../style/new-project.css';

interface Deps { model: NoduEmbeddedModel; dialogs: FileDialogService; parent: string; family?: ProjectFamily; onBusyChange?: (busy: boolean) => void; onCreated: (project: { path: string }) => void }

export class NoduNewProjectDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps, private readonly deps: Deps) {
        super(props);
        this.node.classList.add('nodu-new-project-dialog');
        this.contentNode.classList.add('nodu-new-project-content');
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
    const [framework, setFramework] = React.useState<EspProjectFramework>('arduino');
    const frameworkButtons = React.useRef<(HTMLButtonElement | null)[]>([]);
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
    const templates = projectTemplates(family, chipId, framework);
    const chips = PROJECT_CHIPS.filter(chip => chip.family === family);
    const switchFamily = (next: ProjectFamily): void => {
        setFamily(next); setChipId(PROJECT_CHIPS.find(c => c.family === next)!.id); setError('');
        if (!projectTemplates(next, undefined, framework).some(t => t.id === templateId)) { setTemplateId('empty'); }
        if (!nameEdited) { setName(`hello-${next}`); }
    };
    const switchFramework = (next: EspProjectFramework): void => {
        if (pending.current) { return; }
        setFramework(next); setError('');
        if (!projectTemplates(family, chipId, next).some(t => t.id === templateId)) { setTemplateId('empty'); }
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
            const project = await model.call<{ path: string }>('createWorkspace', { parent, name, chip: chipId, template: templateId, ...(family === 'esp32' ? { framework } : {}) });
            if (mounted.current) { close(); onCreated(project); }
        } catch (e) {
            if (mounted.current) { setError(e instanceof EmbeddedError || e instanceof Error ? e.message : String(e)); }
        } finally { changeBusy(false); }
    };

    return <form className="nodu-new-project" onSubmit={event => { event.preventDefault(); void create(); }} aria-busy={busy}>
        <div className="nodu-np-body">
            <nav className="nodu-np-families" aria-label="芯片系列">
                <div className="nodu-np-group-title">芯片系列</div>
                <button type="button" className={`nodu-np-family nodu-np-root${family === 'k210' ? ' nodu-np-selected' : ''}`} aria-pressed={family === 'k210'} disabled={busy} onClick={() => switchFamily('k210')}>
                    <span aria-hidden="true"/><ChipMark tag="K210"/><span>K210</span>
                </button>
                <button type="button" className={`nodu-np-family nodu-np-group${expanded.stm32 ? ' is-open' : ''}`} aria-expanded={expanded.stm32} aria-controls="nodu-stm32-families" disabled={busy} onClick={() => setExpanded(value => ({ ...value, stm32: !value.stm32 }))}>
                    <i className={`codicon codicon-chevron-${expanded.stm32 ? 'down' : 'right'}`} aria-hidden="true"/><ChipMark tag="STM32"/><span>STM32</span>
                </button>
                <div className="nodu-np-children" id="nodu-stm32-families" hidden={!expanded.stm32}>
                    {PROJECT_FAMILIES.filter(item => item.id.startsWith('stm32')).map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${family === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={family === item.id} disabled={busy} onClick={() => switchFamily(item.id)}><span>{item.name}</span></button>)}
                </div>
                <button type="button" className={`nodu-np-family nodu-np-group${expanded.esp32 ? ' is-open' : ''}`} aria-expanded={expanded.esp32} aria-controls="nodu-esp32-chips" disabled={busy} onClick={() => setExpanded(value => ({ ...value, esp32: !value.esp32 }))}>
                    <i className={`codicon codicon-chevron-${expanded.esp32 ? 'down' : 'right'}`} aria-hidden="true"/><ChipMark tag="ESP32"/><span>ESP32</span>
                </button>
                <div className="nodu-np-children" id="nodu-esp32-chips" hidden={!expanded.esp32}>
                    {PROJECT_CHIPS.filter(item => item.family === 'esp32').map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${chipId === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={chipId === item.id} disabled={busy} onClick={() => { switchFamily('esp32'); setChipId(item.id); }}><span>{item.name}</span></button>)}
                </div>
            </nav>
            <div className="nodu-np-fields">
                {family === 'esp32' && <div className="nodu-np-control">
                    <span className="nodu-np-label" id="nodu-project-framework-label">开发框架</span>
                    <div className="nodu-np-frameworks" role="radiogroup" aria-labelledby="nodu-project-framework-label">
                        {ESP_PROJECT_FRAMEWORKS.map((item, index) => <button key={item.id} type="button" role="radio"
                            ref={button => { frameworkButtons.current[index] = button; }}
                            className={`nodu-np-framework${framework === item.id ? ' is-selected' : ''}`}
                            aria-checked={framework === item.id} tabIndex={framework === item.id ? 0 : -1} disabled={busy}
                            onClick={() => switchFramework(item.id)} onKeyDown={event => {
                                if (busy || event.nativeEvent.isComposing || event.keyCode === 229) { return; }
                                const delta = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
                                if (!delta && event.key !== 'Home' && event.key !== 'End') { return; }
                                event.preventDefault(); event.stopPropagation();
                                const next = event.key === 'Home' ? 0 : event.key === 'End' ? ESP_PROJECT_FRAMEWORKS.length - 1 : (index + delta + ESP_PROJECT_FRAMEWORKS.length) % ESP_PROJECT_FRAMEWORKS.length;
                                switchFramework(ESP_PROJECT_FRAMEWORKS[next].id); frameworkButtons.current[next]?.focus();
                            }}><FrameworkMark framework={item.id}/><span>{item.name}</span></button>)}
                    </div>
                </div>}
                <div className="nodu-np-control">
                    <label className="nodu-np-label" htmlFor="nodu-project-name">名称</label>
                    <input id="nodu-project-name" value={name} disabled={busy} onChange={event => { setName(event.currentTarget.value); setNameEdited(true); setError(''); }}
                        onBlur={() => setNameTouched(true)} aria-invalid={nameTouched && !nameOk} aria-describedby={nameTouched && !nameOk ? 'nodu-name-error' : undefined} spellCheck={false} autoFocus />
                    {nameTouched && !nameOk && <p id="nodu-name-error" className="nodu-np-invalid" role="alert">以字母开头，限 40 位字母、数字、- 或 _，避开系统保留名称。</p>}
                </div>
                <div className="nodu-np-control">
                    <label className="nodu-np-label" htmlFor="nodu-project-parent">位置</label>
                    <div className="nodu-np-location"><input id="nodu-project-parent" value={parent} disabled={busy} onChange={event => { setParent(event.currentTarget.value); setError(''); }} spellCheck={false} />
                        <button type="button" className="nodu-np-browse" aria-label="浏览项目位置" title="浏览" disabled={busy} onClick={() => void choose()}><i className="codicon codicon-folder-opened" aria-hidden="true"/></button>
                    </div>
                </div>
                <div className="nodu-np-row">
                    {chips.length > 1 && <div className="nodu-np-control">
                        <label className="nodu-np-label" htmlFor="nodu-project-chip">型号</label>
                        <NoduSelect id="nodu-project-chip" aria-label="型号" value={chipId} disabled={busy}
                            onChange={value => { setChipId(value); setError(''); }} options={chips.map(c => ({ value: c.id, label: c.name }))}/>
                    </div>}
                    <div className="nodu-np-control">
                        <label className="nodu-np-label" htmlFor="nodu-project-template">模板</label>
                        <NoduSelect id="nodu-project-template" aria-label="模板" value={templateId} disabled={busy}
                            onChange={value => { setTemplateId(value); setError(''); }} options={templates.map(t => ({ value: t.id, label: t.name }))}/>
                    </div>
                </div>
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
