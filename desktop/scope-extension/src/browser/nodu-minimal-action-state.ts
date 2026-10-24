// SPDX-License-Identifier: MIT
export type MinimalAction = 'build' | 'build-flash' | 'flash';

export const MINIMAL_ACTIONS: readonly MinimalAction[] = ['build', 'flash', 'build-flash'];
export const MINIMAL_ACTION_LABELS: Record<MinimalAction, string> = {
    build: '编译', 'build-flash': '运行（编译并烧录）', flash: '烧录',
};

/** A long press only reveals choices; it never chooses or executes an action. */
export class MinimalActionGesture {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private pointer: { id: number; x: number; y: number; at: number; allowSelection: boolean; opened: boolean } | undefined;
    private suppressClick = false;

    constructor(private readonly open: () => void, private readonly delay = 500,
        private readonly schedule: typeof setTimeout = setTimeout,
        private readonly unschedule: typeof clearTimeout = clearTimeout,
        private readonly now: () => number = () => performance.now()) {}

    begin(id: number, x: number, y: number, allowSelection: boolean): void {
        this.clearTimer();
        this.pointer = { id, x, y, at: this.now(), allowSelection, opened: false };
        this.suppressClick = false;
        if (allowSelection) {
            this.timer = this.schedule(() => {
                this.timer = undefined;
                if (!this.pointer) { return; }
                this.pointer.opened = true;
                this.suppressClick = true;
                this.open();
            }, this.delay);
        }
    }

    move(id: number, x: number, y: number): void {
        if (this.pointer?.id === id && Math.hypot(x - this.pointer.x, y - this.pointer.y) > 10) {
            this.cancel();
        }
    }

    release(id: number): void {
        if (this.pointer?.id !== id) { return; }
        const press = this.pointer;
        this.clearTimer();
        this.pointer = undefined;
        // A busy renderer can deliver pointer-up before the overdue timeout callback.
        if (press.allowSelection && !press.opened && this.now() - press.at >= this.delay) {
            this.suppressClick = true;
            this.open();
        }
    }

    lostCapture(id: number): void {
        if (this.pointer?.id === id) { this.cancel(); }
    }

    cancel(): void {
        this.clearTimer();
        this.pointer = undefined;
        this.suppressClick = true;
    }

    consumeClick(detail = 1): boolean {
        // Assistive technology and keyboard activation can emit click without pointerdown.
        // It starts an explicit action rather than inheriting a cancelled pointer gesture.
        if (detail === 0) {
            this.clearTimer();
            this.pointer = undefined;
            this.suppressClick = false;
            return false;
        }
        const suppressed = this.suppressClick;
        this.suppressClick = false;
        return suppressed;
    }

    private clearTimer(): void {
        if (this.timer !== undefined) { this.unschedule(this.timer); this.timer = undefined; }
    }
}

export interface MinimalFanItem {
    action: MinimalAction;
    left: number;
    top: number;
}

export interface MinimalFanGeometry {
    left: number; top: number; size: number; radius: number; items: MinimalFanItem[];
}

/** Keep the original button as the centre. Never shift the fan away from its trigger. */
export function minimalFanGeometry(centerX: number, centerY: number, viewportWidth: number,
    viewportHeight: number): MinimalFanGeometry | undefined {
    const halfButton = 22, margin = 4;
    if (![centerX, centerY, viewportWidth, viewportHeight].every(Number.isFinite)
        || centerX - halfButton < 0 || centerY + halfButton > viewportHeight - margin) { return undefined; }
    const radius = Math.min(76, viewportWidth - centerX - halfButton - margin, centerY - halfButton - margin);
    // Preserve full 44px targets and a gap between circles, even in a short window.
    if (radius < 64) { return undefined; }
    const items = MINIMAL_ACTIONS.map((action, index) => {
        const degrees = -90 + index * 45;
        const radians = degrees * Math.PI / 180;
        return {
            action,
            left: Math.max(0, radius * Math.cos(radians)),
            top: Math.max(0, radius + radius * Math.sin(radians)),
        };
    });
    return { left: centerX - halfButton, top: centerY - radius - halfButton, size: radius + 44, radius, items };
}
