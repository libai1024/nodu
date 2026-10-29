// SPDX-License-Identifier: MIT
import type { ProjectStatus } from './nodu-embedded-protocol';

export interface KeilStatus {
    supported: boolean;
    generated: boolean;
    autoSync: boolean;
    canOpen: boolean;
    projectFile?: string;
    reason?: string;
}
export interface KeilResult { path: string; changed: boolean; created: boolean }

export function supportsKeil(project: ProjectStatus | undefined): boolean {
    return !!project && project.chip.id === 'STM32F103C8Tx' && !project.manifest.build?.external && !project.manifest.build?.adapter;
}

/** Source contents are shared; only structure/configuration changes need project regeneration. */
export function affectsKeil(relative: string, structureChanged: boolean): boolean {
    const path = relative.replace(/\\/g, '/');
    if (/^(MDK-ARM|build|\.nodu|\.git|\.cache|\.theia|\.vscode)(\/|$)/i.test(path)) { return false; }
    return /(^|\/)(nodu\.json|CMakeLists\.txt|CMakePresets\.json|stm32f1xx_hal_conf\.h)$|\.cmake$/i.test(path)
        || (structureChanged && /^(App|Board|Core)(\/|$)/.test(path));
}
