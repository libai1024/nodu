// SPDX-License-Identifier: MIT
// Desktop launcher (a PyCharm-style start window): the protocol between the launcher
// frontend, the Electron main process and the backend recent-project store.

/** Query parameter that marks a window as the launcher; it boots without a workspace. */
export const NODU_LAUNCHER_QUERY = 'noduLauncher';
/** User setting read by the Electron main process at startup. */
export const NODU_REOPEN_LAST_PREF = 'nodu.startup.reopenLastProject';

export const NODU_LAUNCHER_MAIN_PATH = '/services/nodu-launcher-main';
export const NoduLauncherMain = Symbol('NoduLauncherMain');
/** Window management in the Electron main process. */
export interface NoduLauncherMain {
    /** Opens (or focuses) a project window, then closes the launcher unless `keepLauncher`. */
    openProject(fsPath: string, options?: { keepLauncher?: boolean }): Promise<void>;
    /** Shows (or focuses) the launcher. The renderer closes its own window through Theia. */
    showLauncher(): Promise<void>;
}

export const NODU_PROJECTS_PATH = '/services/nodu-projects';
export const NoduProjectsService = Symbol('NoduProjectsService');
export interface RecentProject { path: string; name: string; tag?: string; lastOpened?: number; missing: boolean }
export interface ExampleProject { path: string; name: string; tag?: string; summary?: string }
export interface NoduProjectsService {
    recent(): Promise<RecentProject[]>;
    /** Records that a project window opened this folder. */
    touch(fsPath: string): Promise<void>;
    remove(fsPath: string): Promise<void>;
    examples(): Promise<ExampleProject[]>;
    /** Copies an example into the projects folder (the shipped copy is never edited); returns the new path. */
    copyExample(examplePath: string): Promise<string>;
    /** Default parent for new projects (~/Documents/Nodu), created on demand. */
    projectsDir(): Promise<string>;
}
