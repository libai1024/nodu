// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { NoduEmbeddedModel, formatBytes } from './nodu-embedded-model';
import { ProjectStatus } from '../common/nodu-embedded-protocol';
import { supportsKeil } from '../common/nodu-keil';

export class NoduProjectDialog extends ReactDialog<void> {
    constructor(title: string, private readonly view: (close: () => void) => React.ReactNode) {
        super({ title }); this.addClass('nodu-project-dialog');
        this.node.setAttribute('role', 'dialog'); this.node.setAttribute('aria-modal', 'true'); this.node.setAttribute('aria-label', title);
        this.closeCrossNode.setAttribute('role', 'button'); this.closeCrossNode.setAttribute('aria-label', '关闭'); this.closeCrossNode.tabIndex = 0;
        this.node.addEventListener('keydown', event => {
            if (event.key !== 'Tab') { return; }
            const targets = Array.from(this.node.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]')).filter(n => n.offsetParent !== null);
            const first = targets[0], last = targets[targets.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        });
        this.closeCrossNode.onkeydown = event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.close(); } };
    }
    get value(): void { return; }
    protected render(): React.ReactNode { return this.view(() => this.close()); }
    protected handleEnter(): boolean { return false; }
}

export function ModuleForm({ model, close, open }: { model: NoduEmbeddedModel; close(): void; open(path: string): Promise<unknown> }): React.ReactElement {
    const [name, setName] = React.useState(''); const [error, setError] = React.useState(''); const [busy, setBusy] = React.useState(false);
    const valid = /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name);
    const create = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault(); if (!valid || busy || !model.project) { return; }
        setBusy(true); setError('');
        try { const result = await model.call<{ source: string }>('createModule', { path: model.project.path, name }); model.sourceChanged(result.source); await open(result.source); close(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    return <form className="nodu-project-form" onSubmit={event => void create(event)}>
        <label className="nodu-project-field">模块名称<input autoFocus value={name} onChange={e => setName(e.currentTarget.value)} aria-label="模块名称" disabled={busy} /></label>
        {valid && <div className="nodu-module-paths"><span>App/{name}.c</span><span>App/{name}.h</span></div>}
        {error && <p role="alert" className="nodu-c-error-text">{error}</p>}
        <div className="nodu-project-actions"><button type="button" className="theia-button secondary" disabled={busy} onClick={close}>取消</button><button className="theia-button main" disabled={!valid || busy}>{busy ? '创建中…' : '创建'}</button></div>
    </form>;
}

export function ProjectSettings({ model, close }: { model: NoduEmbeddedModel; close(): void }): React.ReactElement {
    const project = model.project!;
    const [preset, setPreset] = React.useState(project.preset);
    const [printfFloat, setFloat] = React.useState(!!project.manifest.build?.printfFloat);
    const [keilAutoSync, setKeilAutoSync] = React.useState(project.manifest.keil?.autoSync === true);
    const supportsPrintfFloat = project.manifest.build?.adapter !== 'dacir-directory-v1';
    const [chipVendor, setVendor] = React.useState(project.manifest.target.vendor ?? 'st');
    const [autoBoot, setAutoBoot] = React.useState(project.manifest.flash?.autoBoot ?? { enabled: false, confirmed: false, boot0HighDtr: false, resetActiveRts: true });
    const autoSupported = project.chip.id === 'STM32F103C8Tx';
    const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState('');
    const save = async (event: React.FormEvent): Promise<void> => {
        event.preventDefault(); if (busy || model.busy) { return; } setBusy(true); setError('');
        try {
            const next = await model.call<ProjectStatus>('setProjectOptions', { path: project.path, options: { preset, ...(supportsPrintfFloat ? { printfFloat } : {}), ...(supportsKeil(project) ? { keilAutoSync } : {}), chipVendor, autoBoot } });
            model.settingsChanged(next); close();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    return <form className="nodu-project-form" onSubmit={event => void save(event)}>
        <label className="nodu-project-field">构建配置<select autoFocus value={preset} disabled={busy} onChange={e => setPreset(e.currentTarget.value)}><option value="debug">Debug</option><option value="release">Release</option></select></label>
        {supportsPrintfFloat && <label className="nodu-project-check"><input type="checkbox" checked={printfFloat} disabled={busy} onChange={e => setFloat(e.currentTarget.checked)} />printf 浮点支持（%f）</label>}
        <label className="nodu-project-field">芯片来源<select value={chipVendor} disabled={busy} onChange={e => setVendor(e.currentTarget.value as 'st' | 'compatible')}><option value="st">ST</option><option value="compatible">兼容芯片</option></select></label>
        {supportsKeil(project) && <div className="nodu-auto-boot-settings">
            <label className="nodu-project-check"><input type="checkbox" checked={keilAutoSync} disabled={busy} onChange={e => setKeilAutoSync(e.currentTarget.checked)} />自动维护 Keil 工程</label>
            <p>仅对此项目生效。新增文件或修改工程配置后自动更新；代码始终共用。关闭后仍可从文件菜单手动更新。</p>
            {model.keilError && <p role="alert" className="nodu-c-error-text">{model.keilError}</p>}
        </div>}
        {autoSupported && <>
            <label className="nodu-project-check"><input type="checkbox" checked={autoBoot.enabled} disabled={busy} onChange={e => setAutoBoot({ ...autoBoot, enabled: e.currentTarget.checked, confirmed: false })} />DTR/RTS 自动下载</label>
            {autoBoot.enabled && <div className="nodu-auto-boot-settings">
                <p>仅适用 STM32F103C8T6，尚待实物验证。DTR 控制 BOOT0，RTS 控制 NRST，BOOT1=0。需 3.3V 电平，BOOT0 不可同时固定接电源或地。</p>
                <label className="nodu-project-field">BOOT0=1 时 DTR<select value={String(autoBoot.boot0HighDtr)} onChange={e => setAutoBoot({ ...autoBoot, boot0HighDtr: e.currentTarget.value === 'true', confirmed: false })}><option value="false">未断言（false）</option><option value="true">已断言（true）</option></select></label>
                <label className="nodu-project-field">复位时 RTS<select value={String(autoBoot.resetActiveRts)} onChange={e => setAutoBoot({ ...autoBoot, resetActiveRts: e.currentTarget.value === 'true', confirmed: false })}><option value="true">已断言（true）</option><option value="false">未断言（false）</option></select></label>
                <label className="nodu-project-check"><input type="checkbox" checked={autoBoot.confirmed} onChange={e => setAutoBoot({ ...autoBoot, confirmed: e.currentTarget.checked })} />已按电路核对接线和信号极性</label>
            </div>}
        </>}
        {error && <p role="alert" className="nodu-c-error-text">{error}</p>}
        <div className="nodu-project-actions"><button type="button" className="theia-button secondary" disabled={busy} onClick={close}>取消</button><button className="theia-button main" disabled={busy || model.busy || (autoBoot.enabled && !autoBoot.confirmed)}>{busy ? '保存中…' : '保存'}</button></div>
    </form>;
}

interface ToolkitReport { ok: boolean; version: string; checkedAt: string; full?: boolean; problemCount: number; totalBytes: number; inventory: { id: string; version: string; license?: string; bytes: number; licenses: string[] }[]; missing: string[]; damaged: string[] }
export function ToolkitInfo({ model, close }: { model: NoduEmbeddedModel; close(): void }): React.ReactElement {
    const [report, setReport] = React.useState<ToolkitReport>(); const [busy, setBusy] = React.useState(false); const [error, setError] = React.useState('');
    const [license, setLicense] = React.useState<{ file: string; text: string }>();
    const check = async (full: boolean): Promise<void> => {
        setBusy(true); setError('');
        try { setReport(await model.call<ToolkitReport>('checkToolkit', { full })); await model.reload(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    React.useEffect(() => { void check(false); }, []);
    const readLicense = async (file: string): Promise<void> => {
        setBusy(true); setError('');
        try { setLicense({ file, ...(await model.call<{ text: string }>('readToolkitLicense', { file })) }); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
    };
    return <div className="nodu-project-form nodu-toolkit-info">
        {license ? <><button className="scope-text-button" onClick={() => setLicense(undefined)}>返回组件列表</button><p>{license.file}</p><pre tabIndex={0} aria-label="许可正文">{license.text}</pre></> : <>
            <div className="nodu-toolkit-summary"><span>{report?.version ?? 'STM32 工具包'}</span><span>{report ? formatBytes(report.inventory.reduce((sum, c) => sum + c.bytes, 0)) : ''}</span><span role="status">{busy ? '检查中…' : report ? report.ok ? '检查通过' : `${report.problemCount} 个异常` : ''}</span></div>
            {report && <table><thead><tr><th>组件</th><th>版本</th><th>占用</th><th>许可</th></tr></thead><tbody>{report.inventory.map(c => <tr key={c.id}><th scope="row">{c.id}</th><td>{c.version}</td><td>{formatBytes(c.bytes)}</td><td>{c.license && <span>{c.license}</span>}{c.licenses.length ? <select aria-label={`${c.id} 许可`} value="" disabled={busy} onChange={e => void readLicense(e.currentTarget.value)}><option value="">查看许可</option>{c.licenses.map(path => <option key={path} value={path}>{path}</option>)}</select> : !c.license && '未提供'}</td></tr>)}</tbody></table>}
            {report && !report.ok && <pre tabIndex={0}>{[...report.missing.map(f => `缺失 ${f}`), ...report.damaged.map(f => `损坏 ${f}`)].join('\n')}</pre>}
        </>}
        {error && <p role="alert" className="nodu-c-error-text">{error}</p>}
        <div className="nodu-project-actions">{!license && <button type="button" className="theia-button secondary" disabled={busy || model.busy} onClick={() => void check(true)}>完整检查</button>}<button autoFocus type="button" className="theia-button main" onClick={close}>关闭</button></div>
    </div>;
}
