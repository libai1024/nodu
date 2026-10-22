// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';
import { URI } from '@theia/core/lib/common/uri';
import { CatalogBoard, ProjectStatus } from '../common/nodu-embedded-protocol';
import { EmbeddedError, NoduEmbeddedModel } from './nodu-embedded-model';

interface Deps { model: NoduEmbeddedModel; dialogs: FileDialogService; parent: string; boards: CatalogBoard[]; onCreated: (project: ProjectStatus) => void }

const NAME_RULE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;

/** New STM32 project: board, template, name and location (UI-DESIGN §5.2). */
export class NoduNewProjectDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps, private readonly deps: Deps) {
        super(props);
        this.node.classList.add('nodu-new-project-dialog');
        this.contentNode.classList.add('scope-widget');
    }

    get value(): undefined { return undefined; }

    protected render(): React.ReactNode {
        return <NewProjectForm {...this.deps} close={() => this.close()} />;
    }
}

function NewProjectForm({ model, dialogs, parent: initialParent, boards, onCreated, close }: Deps & { close: () => void }): React.ReactElement {
    const [boardId, setBoardId] = React.useState(boards[0]?.reference ?? '');
    const board = boards.find(b => b.reference === boardId) ?? boards[0];
    const [templateId, setTemplateId] = React.useState('uart-hello');
    const template = board?.templates.find(t => t.id === templateId) ?? board?.templates.find(t => t.available);
    const [name, setName] = React.useState('hello-stm32');
    const [parent, setParent] = React.useState(initialParent);
    const [method, setMethod] = React.useState<'stlink' | 'uart'>('stlink');
    const [ledPort, setLedPort] = React.useState('C');
    const [ledPin, setLedPin] = React.useState(13);
    const [activeLow, setActiveLow] = React.useState(true);
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const needsLed = !!template?.needsInput.includes('led');
    const nameOk = NAME_RULE.test(name);

    const choose = async (): Promise<void> => {
        const picked = await dialogs.showOpenDialog({ title: '选择工程位置', canSelectFolders: true, canSelectFiles: false, openLabel: '选择' });
        const uri = Array.isArray(picked) ? picked[0] : picked;
        if (uri) { setParent(uri.path.fsPath()); }
    };
    const create = async (): Promise<void> => {
        if (!board || !template || !nameOk || busy) { return; }
        setBusy(true);
        setError('');
        try {
            const project = await model.call<ProjectStatus>('createProject', {
                parent, name, board: board.reference, template: template.id, method,
                ...(needsLed ? { led: { port: ledPort, pin: ledPin, activeLow } } : {}),
            });
            close();
            onCreated(project);
        } catch (e) {
            setError(e instanceof EmbeddedError ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (!board) { return <p className="scope-error">没有可用的板卡包。</p>; }
    const pins = Array.from({ length: 16 }, (_, i) => i);
    return <form className="nodu-new-project" onSubmit={event => { event.preventDefault(); void create(); }}>
        <div className="nodu-np-columns">
            <fieldset className="nodu-np-column">
                <legend>开发板</legend>
                {boards.map(b => <label key={b.reference} className={`nodu-np-option${b.reference === board.reference ? ' nodu-np-selected' : ''}`}>
                    <input type="radio" name="nodu-np-board" checked={b.reference === board.reference} onChange={() => setBoardId(b.reference)} />
                    <span className="nodu-np-option-title">{b.name}</span>
                    <span className="nodu-np-option-meta">{b.chipName} · {b.core} · {b.flashKiB} KB Flash · {b.ramKiB} KB RAM</span>
                </label>)}
                {board.description && <p className="nodu-np-note">{board.description}</p>}
            </fieldset>
            <fieldset className="nodu-np-column">
                <legend>模板</legend>
                {board.templates.map(t => <label key={t.id} className={`nodu-np-option${t.id === template?.id ? ' nodu-np-selected' : ''}${t.available ? '' : ' nodu-np-disabled'}`}>
                    <input type="radio" name="nodu-np-template" disabled={!t.available} checked={t.id === template?.id} onChange={() => setTemplateId(t.id)} />
                    <span className="nodu-np-option-title">{t.name}</span>
                    <span className="nodu-np-option-meta">{t.description}</span>
                </label>)}
                {needsLed && <div className="nodu-np-led" role="group" aria-label="LED 引脚">
                    <p className="nodu-np-note">{template?.reason}</p>
                    <div className="nodu-np-row">
                        <label>端口<select value={ledPort} onChange={event => setLedPort(event.currentTarget.value)}>
                            {(board.gpioPorts || 'ABC').split('').map(p => <option key={p} value={p}>GPIO{p}</option>)}</select></label>
                        <label>引脚<select value={ledPin} onChange={event => setLedPin(Number(event.currentTarget.value))}>
                            {pins.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
                        <label className="nodu-np-check"><input type="checkbox" checked={activeLow} onChange={event => setActiveLow(event.currentTarget.checked)} />低电平点亮</label>
                    </div>
                    <p className="nodu-np-muted">将使用 P{ledPort}{ledPin}，写在 Board/board.h，之后可以修改。</p>
                </div>}
            </fieldset>
            <fieldset className="nodu-np-column">
                <legend>工程</legend>
                <label className="nodu-np-field">名称
                    <input value={name} onChange={event => setName(event.currentTarget.value)} aria-invalid={!nameOk} aria-describedby="nodu-np-name-rule" spellCheck={false} autoFocus />
                </label>
                <p id="nodu-np-name-rule" className={nameOk ? 'nodu-np-muted' : 'nodu-np-invalid'}>英文字母开头，可用字母、数字、- 和 _，最多 40 个字符。</p>
                <div className="nodu-np-field">位置
                    <div className="nodu-input-action"><input value={parent} readOnly aria-label="工程位置" title={parent} /><button type="button" className="theia-button secondary" onClick={() => void choose()}>选择…</button></div>
                </div>
                <p className="nodu-np-muted">将创建 {parent.replace(/[\\/]$/, '')}/{nameOk ? name : '…'}</p>
                <div className="nodu-np-field" role="radiogroup" aria-label="下载方式">下载方式
                    <label className="nodu-np-check"><input type="radio" name="nodu-np-method" checked={method === 'stlink'} onChange={() => setMethod('stlink')} />ST-LINK（SWD）</label>
                    <label className="nodu-np-check"><input type="radio" name="nodu-np-method" checked={method === 'uart'} onChange={() => setMethod('uart')} />串口（ISP）</label>
                </div>
            </fieldset>
        </div>
        {error && <p className="scope-error" role="alert">{error}</p>}
        <div className="nodu-np-actions">
            <button type="button" className="theia-button secondary" onClick={close}>取消</button>
            <button type="submit" className="theia-button main" disabled={!nameOk || !template || busy}>{busy ? '正在创建…' : '创建'}</button>
        </div>
    </form>;
}

export function parentOf(uri: URI | undefined, home: string): string {
    return uri ? uri.parent.path.fsPath() : home;
}
