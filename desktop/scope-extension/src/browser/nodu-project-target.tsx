// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { DialogProps } from '@theia/core/lib/browser/dialogs';
import { ReactDialog } from '@theia/core/lib/browser/dialogs/react-dialog';
import { PROJECT_CHIPS, PROJECT_FAMILIES, ProjectFamily } from '../common/nodu-project-catalog';
import { ChipMark } from './nodu-project-icon';
import '../../style/new-project.css';

/** The same dialog frame and chip tree serve creation and existing-project selection. */
export class NoduProjectFormDialog extends ReactDialog<undefined> {
    constructor(props: DialogProps, private readonly view: (close: () => void) => React.ReactNode) {
        super(props);
        this.node.classList.add('nodu-new-project-dialog');
        this.contentNode.classList.add('nodu-new-project-content');
        this.node.setAttribute('role', 'dialog');
        this.node.setAttribute('aria-modal', 'true');
        this.node.setAttribute('aria-label', props.title);
        this.closeCrossNode.setAttribute('role', 'button');
        this.closeCrossNode.setAttribute('aria-label', '关闭');
        this.closeCrossNode.tabIndex = 0;
        this.closeCrossNode.onkeydown = event => {
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); this.close(); }
        };
    }
    get value(): undefined { return undefined; }
    protected render(): React.ReactNode { return this.view(() => this.close()); }
    // The React form owns submission, including Enter inside a field.
    protected handleEnter(): boolean { return false; }
}

interface FamilyNavigationProps {
    id: string;
    family?: ProjectFamily;
    chipId?: string;
    expanded: { stm32: boolean; esp32: boolean };
    busy: boolean;
    families?: readonly ProjectFamily[];
    onSelect(family: ProjectFamily, chipId?: string): void;
    onExpand(group: 'stm32' | 'esp32'): void;
}
/** Pure rendering keeps family selection behavior controlled by the containing form. */
export function renderProjectFamilyNavigation({ id, family, chipId, expanded, busy, families = PROJECT_FAMILIES.map(f => f.id), onSelect, onExpand }: FamilyNavigationProps): React.ReactElement {
    return <nav className="nodu-np-families" aria-label="芯片系列">
        <div className="nodu-np-group-title">芯片系列</div>
        {families.includes('k210') && <button type="button" className={`nodu-np-family nodu-np-root${family === 'k210' ? ' nodu-np-selected' : ''}`} aria-pressed={family === 'k210'} disabled={busy} onClick={() => onSelect('k210')}>
            <span aria-hidden="true"/><ChipMark tag="K210"/><span>K210</span>
        </button>}
        {families.some(item => item.startsWith('stm32')) && <>
            <button type="button" className={`nodu-np-family nodu-np-group${expanded.stm32 ? ' is-open' : ''}`} aria-expanded={expanded.stm32} aria-controls={`${id}-stm32-families`} disabled={busy} onClick={() => onExpand('stm32')}>
                <i className={`codicon codicon-chevron-${expanded.stm32 ? 'down' : 'right'}`} aria-hidden="true"/><ChipMark tag="STM32"/><span>STM32</span>
            </button>
            <div className="nodu-np-children" id={`${id}-stm32-families`} hidden={!expanded.stm32}>
                {PROJECT_FAMILIES.filter(item => item.id.startsWith('stm32') && families.includes(item.id)).map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${family === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={family === item.id} disabled={busy} onClick={() => onSelect(item.id)}><span>{item.name}</span></button>)}
            </div>
        </>}
        {families.includes('esp32') && <>
            <button type="button" className={`nodu-np-family nodu-np-group${expanded.esp32 ? ' is-open' : ''}`} aria-expanded={expanded.esp32} aria-controls={`${id}-esp32-chips`} disabled={busy} onClick={() => onExpand('esp32')}>
                <i className={`codicon codicon-chevron-${expanded.esp32 ? 'down' : 'right'}`} aria-hidden="true"/><ChipMark tag="ESP32"/><span>ESP32</span>
            </button>
            <div className="nodu-np-children" id={`${id}-esp32-chips`} hidden={!expanded.esp32}>
                {PROJECT_CHIPS.filter(item => item.family === 'esp32').map(item => <button type="button" key={item.id} className={`nodu-np-family nodu-np-child${chipId === item.id ? ' nodu-np-selected' : ''}`} aria-pressed={chipId === item.id} disabled={busy} onClick={() => onSelect('esp32', item.id)}><span>{item.name}</span></button>)}
            </div>
        </>}
    </nav>;
}
