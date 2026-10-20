// SPDX-License-Identifier: MIT
// Resource/update sidecar service (nodu-resources). The frontend reaches
// it over JSON-RPC like the device service; install progress is pushed via
// the client callback interface.
export const NoduResourcesService = Symbol('NoduResourcesService');
export const NODU_RESOURCES_PATH = '/services/nodu-resources';

export interface InstallProgress { downloaded: number; total: number | null; }
export type InstallPhase = 'downloading' | 'installing';

export interface ResourcesClient {
    onInstallProgress(progress: InstallProgress): void;
    onInstallPhase(phase: InstallPhase): void;
}

export interface VersionCheck { latest: string; newer: boolean; }
export interface ResourcesReady { examplesDir: string; }

export interface NoduResourcesService {
    /** Resolved after the startup resource init; always answers. */
    ready(): Promise<ResourcesReady>;
    checkVersion(url: string): Promise<VersionCheck>;
    checkResources(url: string): Promise<VersionCheck>;
    installResources(template: string, version: string, requireSha256: boolean): Promise<void>;
    cancelInstall(): Promise<void>;
}
