// SPDX-License-Identifier: MIT
import * as React from '@theia/core/shared/react';
import { createPortal } from 'react-dom';
import type { TheiaDockPanel } from '@theia/core/lib/browser/shell/theia-dock-panel';

/** A single settings entry belongs to the main area, not to an editor group. */
export function NoduMinimalSettingsHost({ panel, children }: { panel: TheiaDockPanel; children: React.ReactNode }): React.ReactElement {
    React.useLayoutEffect(() => {
        const doc = panel.node.ownerDocument;
        const view = doc.defaultView;
        let reserved: HTMLElement | undefined;
        let frame: number | undefined;
        const place = (): void => {
            frame = undefined;
            const bounds = panel.node.getBoundingClientRect();
            const bars = Array.from(panel.tabBars(), bar => bar.node).filter(node => {
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0 && Math.abs(rect.top - bounds.top) < 3;
            });
            const next = bars.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
            if (next !== reserved) {
                reserved?.classList.remove('nodu-minimal-settings-tabbar');
                next?.classList.add('nodu-minimal-settings-tabbar');
                reserved = next;
            }
        };
        const schedule = (): void => {
            if (frame === undefined && view) { frame = view.requestAnimationFrame(place); }
        };
        const observer = new ResizeObserver(schedule);
        observer.observe(panel.node);
        panel.layoutModified.connect(schedule);
        place();
        return () => {
            observer.disconnect();
            panel.layoutModified.disconnect(schedule);
            if (frame !== undefined) { view?.cancelAnimationFrame(frame); }
            reserved?.classList.remove('nodu-minimal-settings-tabbar');
        };
    }, [panel]);
    return createPortal(<div className="nodu-minimal-settings-host">{children}</div>, panel.node);
}
