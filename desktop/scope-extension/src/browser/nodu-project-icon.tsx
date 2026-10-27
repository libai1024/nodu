// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { projectIconIdentity } from '../common/nodu-project-icon';
import { EspProjectFramework } from '../common/nodu-project-catalog';
import '../../style/project-icon.css';

/** Compact mark for editor chrome, where the full model is already shown alongside it. */
export function ChipMark({ tag }: { tag?: string }): React.ReactElement {
    const identity = projectIconIdentity(tag);
    const label = identity.vendor === 'unknown' ? '芯片' : `${identity.manufacturer}${identity.model ? ` · ${identity.model}` : ''}`;
    return <span className={`nodu-chip-mark nodu-project-icon--${identity.vendor}`} role="img" aria-label={label} title={label}/>;
}

/** Framework marks are bundled locally and accompany the visible framework name. */
export function FrameworkMark({ framework }: { framework: EspProjectFramework }): React.ReactElement {
    return <span className={`nodu-framework-mark nodu-framework-mark--${framework}`} aria-hidden="true"/>;
}

/** Shared identity for recent projects and examples; availability is a separate overlay. */
export function ProjectIcon({ tag, missing = false }: { tag?: string; missing?: boolean }): React.ReactElement {
    const identity = projectIconIdentity(tag);
    const label = `${identity.manufacturer}${identity.model ? ` · ${identity.model}` : ''}${missing ? ' · 找不到项目文件' : ''}`;
    return <span className={`nodu-project-icon nodu-project-icon--${identity.vendor}${missing ? ' is-missing' : ''}`}
        role="img" aria-label={label} title={label}>
        <span className="nodu-project-icon-plate" aria-hidden="true">
            {identity.vendor === 'unknown'
                ? <svg className="nodu-project-icon-folder" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7V5.5A1.5 1.5 0 0 1 4.5 4H9l2 3h8.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V7Z"/>
                    <path d="M3 9h18"/>
                </svg>
                : <span className="nodu-project-icon-logo"/>}
        </span>
        {identity.model && <span className="nodu-project-icon-model" aria-hidden="true">{identity.model}</span>}
        {missing && <svg className="nodu-project-icon-missing" aria-hidden="true" viewBox="0 0 16 16">
            <path d="M6.7 2.4a1.5 1.5 0 0 1 2.6 0l5.1 8.9a1.5 1.5 0 0 1-1.3 2.2H2.9a1.5 1.5 0 0 1-1.3-2.2Z" fill="currentColor"/>
            <path d="M8 5.4v3.4m0 2v.1" fill="none" stroke="var(--theia-editor-background)" strokeWidth="1.6" strokeLinecap="round"/>
        </svg>}
    </span>;
}
