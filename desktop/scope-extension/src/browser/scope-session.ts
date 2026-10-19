import { Emitter, Event } from '@theia/core/lib/common/event';
import { injectable } from '@theia/core/shared/inversify';

export type ScopeThreshold = [number, number, number, number, number, number];
export type ScopeTarget = 'green-shapes' | 'single-shape' | 'empty-scene';

export interface ScopeSnapshot {
    readonly running: boolean;
    readonly frame: number;
    readonly threshold: ScopeThreshold;
    readonly overlay: boolean;
    readonly selectedTarget: ScopeTarget;
}

export interface SyntheticObject {
    readonly id: number;
    readonly kind: 'rectangle' | 'circle';
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly lab: readonly [number, number, number];
    readonly color: string;
}

export const SCOPE_DEFAULT_THRESHOLD: ScopeThreshold = [25, 85, -65, -15, -10, 50];
export const SCOPE_DEMO_TARGETS: ReadonlyArray<{ id: ScopeTarget; label: string; description: string }> = [
    { id: 'green-shapes', label: '双色块测试', description: '矩形与圆形，检查阈值与检测叠加。' },
    { id: 'single-shape', label: '单目标测试', description: '保留移动矩形，观察逐帧坐标。' },
    { id: 'empty-scene', label: '空场景测试', description: '查看无目标时的预览和结果状态。' }
];

/** Geometry and LAB metadata are authored samples, not camera or algorithm output. */
export function syntheticObjects(snapshot: ScopeSnapshot): SyntheticObject[] {
    if (snapshot.selectedTarget === 'empty-scene') {
        return [];
    }
    const offset = Math.round(Math.sin((snapshot.frame - 42) / 19) * 12);
    const objects: SyntheticObject[] = [{
        id: 1, kind: 'rectangle', x: 65 + offset, y: 86, width: 72, height: 64,
        lab: [58, -42, 29], color: '#4f8e59'
    }];
    if (snapshot.selectedTarget === 'green-shapes') {
        objects.push({ id: 2, kind: 'circle', x: 203, y: 109, width: 64, height: 64, lab: [68, -32, 33], color: '#4c9768' });
    }
    return objects;
}

export function syntheticDetections(snapshot: ScopeSnapshot): SyntheticObject[] {
    return syntheticObjects(snapshot).filter(object => object.lab.every((value, channel) =>
        value >= snapshot.threshold[channel * 2] && value <= snapshot.threshold[channel * 2 + 1]
    ));
}

/** Shared local demonstration state. It never opens a device or runs project Python. */
@injectable()
export class ScopeSession {
    private readonly changeEmitter = new Emitter<void>();
    private readonly logEmitter = new Emitter<string>();
    readonly onDidChange: Event<void> = this.changeEmitter.event;
    readonly onDidLog: Event<string> = this.logEmitter.event;
    private state: ScopeSnapshot = {
        running: false, frame: 42, threshold: [...SCOPE_DEFAULT_THRESHOLD],
        overlay: true, selectedTarget: 'green-shapes'
    };
    private interval: ReturnType<typeof setInterval> | undefined;
    private disposed = false;
    private logLines: string[] = [];
    private ticks = 0;

    get snapshot(): ScopeSnapshot { return { ...this.state, threshold: [...this.state.threshold] }; }
    get running(): boolean { return this.state.running; }
    get frame(): number { return this.state.frame; }
    get threshold(): ScopeThreshold { return [...this.state.threshold]; }
    get overlay(): boolean { return this.state.overlay; }
    get selectedTarget(): ScopeTarget { return this.state.selectedTarget; }
    get detectionCount(): number { return syntheticDetections(this.state).length; }
    get logs(): readonly string[] { return [...this.logLines]; }

    toggleRun(): void {
        if (this.disposed) { return; }
        if (this.state.running) {
            this.stopTimer();
            this.state = { ...this.state, running: false };
            this.log(`示例已暂停 · #${this.frame}`);
        } else {
            this.state = { ...this.state, running: true };
            this.log('示例播放中');
            this.interval = setInterval(() => {
                if (this.disposed) { return; }
                this.state = { ...this.state, frame: this.state.frame % 90 + 1 };
                this.changeEmitter.fire();
                if (++this.ticks % 15 === 0) {
                    this.log(`示例 #${String(this.frame).padStart(3, '0')} · ${this.detectionCount} 个目标`);
                }
            }, 200);
        }
        this.changeEmitter.fire();
    }

    setThreshold(index: number, value: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0 || index > 5 || !Number.isFinite(value)) { return; }
        const next: ScopeThreshold = [...this.state.threshold];
        const channelMin = index < 2 ? 0 : -128;
        const channelMax = index < 2 ? 100 : 127;
        const bounded = Math.max(channelMin, Math.min(channelMax, Math.round(value)));
        next[index] = index % 2 === 0 ? Math.min(bounded, next[index + 1]) : Math.max(bounded, next[index - 1]);
        if (next[index] === this.state.threshold[index]) { return; }
        this.state = { ...this.state, threshold: next };
        this.changeEmitter.fire();
    }

    resetThresholds(): void {
        if (this.disposed) { return; }
        this.state = { ...this.state, threshold: [...SCOPE_DEFAULT_THRESHOLD] };
        this.log('示例阈值已重置');
        this.changeEmitter.fire();
    }

    setOverlay(overlay: boolean): void {
        if (this.disposed || overlay === this.state.overlay) { return; }
        this.state = { ...this.state, overlay };
        this.changeEmitter.fire();
    }

    setFrame(frame: number): void {
        if (this.disposed || !Number.isFinite(frame)) { return; }
        const next = Math.max(1, Math.min(90, Math.round(frame)));
        if (this.state.running) {
            this.stopTimer();
            this.log('示例已暂停');
        }
        this.state = { ...this.state, running: false, frame: next };
        this.changeEmitter.fire();
    }

    setTarget(target: ScopeTarget): void {
        if (this.disposed || !SCOPE_DEMO_TARGETS.some(item => item.id === target) || target === this.selectedTarget) { return; }
        this.state = { ...this.state, selectedTarget: target, frame: 42 };
        this.log(`示例：${SCOPE_DEMO_TARGETS.find(item => item.id === target)!.label}`);
        this.changeEmitter.fire();
    }

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.stopTimer();
        this.state = { ...this.state, running: false };
        this.changeEmitter.dispose();
        this.logEmitter.dispose();
    }

    private log(message: string): void {
        const line = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`;
        this.logLines = [...this.logLines.slice(-79), line];
        this.logEmitter.fire(line);
    }

    private stopTimer(): void {
        if (this.interval !== undefined) {
            clearInterval(this.interval);
            this.interval = undefined;
        }
    }
}
