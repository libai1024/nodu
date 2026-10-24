// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { Emitter } from '@theia/core/lib/common';

@injectable()
export class ScopeLayoutState {
    private readonly changed = new Emitter<void>();
    readonly onDidChange = this.changed.event;
    mode: 'simple' | 'pro' = localStorage.getItem('scope.layout-mode') === 'pro' ? 'pro' : 'simple';
    project = '打开项目';
    projectPath = '';
    filesVisible = false;
    consoleVisible = false;
    visionVisible = false;
    /** The right side panel is expanded, whatever view it shows. */
    rightVisible = false;
    deviceOpen = false;

    setMode(mode: 'simple' | 'pro'): void {
        if (this.mode === mode) { return; }
        this.mode = mode;
        localStorage.setItem('scope.layout-mode', mode);
        this.changed.fire();
    }
    setProject(project: string, path = ''): void { if (this.project !== project || this.projectPath !== path) { this.project = project; this.projectPath = path; this.deviceOpen = false; this.changed.fire(); } }
    setDeviceOpen(open: boolean): void { if (this.deviceOpen !== open) { this.deviceOpen = open; this.changed.fire(); } }
    setPanels(filesVisible: boolean, consoleVisible: boolean, visionVisible: boolean, rightVisible = false): void {
        if (this.filesVisible === filesVisible && this.consoleVisible === consoleVisible && this.visionVisible === visionVisible && this.rightVisible === rightVisible) { return; }
        Object.assign(this, { filesVisible, consoleVisible, visionVisible, rightVisible });
        this.changed.fire();
    }
}
