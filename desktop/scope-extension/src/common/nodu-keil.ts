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
    return !!project && ['STM32F103C8Tx', 'STM32F407ZGTx'].includes(project.chip?.id ?? '') && !project.manifest?.build?.sourceOnly && !project.manifest?.build?.external && (!project.manifest?.build?.adapter || project.manifest.build.adapter === 'nodu-hal-f103-72mhz-v1');
}

/** Source edits also rerun the C99 compatibility gate; unchanged output remains a no-op. */
export function affectsKeil(relative: string, structureChanged: boolean): boolean {
    const path = relative.replace(/\\/g, '/');
    if (/^(MDK-ARM|build|\.nodu|\.git|\.cache|\.theia|\.vscode)(\/|$)/i.test(path)) { return false; }
    return /\.ld$/i.test(path) || /(^|\/)(nodu\.json|CMakeLists\.txt|CMakePresets\.json|stm32f[14]xx_hal_conf\.h)$|\.cmake$/i.test(path)
        || /\.(?:c|h|s)$/i.test(path);
}
