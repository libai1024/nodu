// SPDX-License-Identifier: MIT
import { Disposable, DisposableCollection } from '@theia/core/lib/common';
import type { ApplicationShell } from '@theia/core/lib/browser';
import type { TerminalService } from '@theia/terminal/lib/browser/base/terminal-service';
import type { TerminalWidget } from '@theia/terminal/lib/browser/base/terminal-widget';
import type { TerminalWidgetImpl } from '@theia/terminal/lib/browser/terminal-widget-impl';
import type { NoduTutorModel } from './nodu-tutor-model';
import '../../style/tutor-terminal-selection.css';

/** A selection action leaves xterm's input, clipboard and selection handlers intact. */
export class TutorTerminalSelectionAction implements Disposable {
    private readonly disposables = new DisposableCollection();
    private readonly terminalDisposables = new DisposableCollection();
    private readonly button: HTMLButtonElement;
    private terminal?: TerminalWidget;
    private selecting = false;
    private disposed = false;

    constructor(private readonly terminals: TerminalService, private readonly shell: ApplicationShell,
        private readonly tutor: NoduTutorModel, private readonly quote: (id: string) => Promise<void>, shortcut: string) {
        this.button = document.createElement('button');
        this.button.type = 'button';
        this.button.className = 'nodu-terminal-selection-action';
        this.button.hidden = true;
        this.button.setAttribute('aria-label', '添加到对话');
        const label = document.createElement('span'), keys = document.createElement('kbd');
        label.textContent = '添加到对话'; keys.textContent = shortcut;
        this.button.append(label, keys);
        document.body.append(this.button);
        this.button.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
        this.button.addEventListener('click', () => {
            const terminal = this.terminal;
            if (terminal && this.available(terminal)) { this.hide(); void this.quote(terminal.id); }
        });
        this.disposables.push(terminals.onDidChangeCurrentTerminal(() => this.attach()));
        this.disposables.push(shell.onDidChangeActiveWidget(() => this.attach()));
        this.disposables.push(tutor.onDidChange(() => this.render()));
        const pointerUp = (): void => { if (this.selecting) { this.selecting = false; this.render(); } };
        document.addEventListener('pointerup', pointerUp);
        document.addEventListener('pointercancel', pointerUp);
        window.addEventListener('resize', this.render);
        this.disposables.push(Disposable.create(() => {
            document.removeEventListener('pointerup', pointerUp);
            document.removeEventListener('pointercancel', pointerUp);
            window.removeEventListener('resize', this.render);
            this.button.remove();
        }));
        this.attach();
    }

    private attach(): void {
        if (this.disposed) { return; }
        const terminal = this.terminals.currentTerminal;
        if (terminal === this.terminal) { this.render(); return; }
        this.terminalDisposables.dispose(); this.hide(); this.selecting = false;
        this.terminal = terminal;
        if (!terminal || terminal.isDisposed) { return; }
        const xterm = (terminal as Partial<Pick<TerminalWidgetImpl, 'getTerminal'>>).getTerminal?.();
        if (!xterm) { return; }
        this.terminalDisposables.push(xterm.onSelectionChange(this.render));
        this.terminalDisposables.push(xterm.onScroll(this.render));
        this.terminalDisposables.push(xterm.onResize(this.render));
        this.terminalDisposables.push(terminal.onOutput(this.render));
        this.terminalDisposables.push(terminal.onDidOpen(this.render));
        const pointerDown = (event: PointerEvent): void => { if (event.button === 0) { this.selecting = true; this.hide(); } };
        terminal.node.addEventListener('pointerdown', pointerDown, { passive: true });
        const closed = (): void => { this.hide(); this.terminalDisposables.dispose(); this.terminal = undefined; };
        terminal.disposed.connect(closed);
        const resize = new ResizeObserver(this.render); resize.observe(terminal.node);
        this.terminalDisposables.push(Disposable.create(() => {
            terminal.node.removeEventListener('pointerdown', pointerDown);
            terminal.disposed.disconnect(closed);
            resize.disconnect();
        }));
        this.render();
    }

    private available(terminal: TerminalWidget): boolean {
        return !this.disposed && !terminal.isDisposed && terminal.isVisible
            && (this.shell.activeWidget === terminal || document.activeElement === this.button)
            && this.tutor.enabled && !!this.tutor.workspaceId && !!terminal.getSelection().trim();
    }

    private hide(): void { this.button.hidden = true; }

    private readonly render = (): void => {
        const terminal = this.terminal;
        if (!terminal || this.selecting || !this.available(terminal)) { this.hide(); return; }
        const xterm = (terminal as Partial<Pick<TerminalWidgetImpl, 'getTerminal'>>).getTerminal?.();
        const selection = xterm?.getSelectionPosition(), screen = terminal.node.querySelector<HTMLElement>('.xterm-screen');
        if (!xterm || !selection || !screen || !xterm.rows || !xterm.cols) { this.hide(); return; }
        const bounds = screen.getBoundingClientRect(), viewport = xterm.buffer.active.viewportY;
        const endRow = selection.end.y - (selection.end.x === 0 ? 1 : 0);
        if (!bounds.width || !bounds.height || endRow < viewport || selection.start.y >= viewport + xterm.rows) { this.hide(); return; }
        const row = Math.min(endRow - viewport, xterm.rows - 1);
        const column = endRow >= viewport + xterm.rows || selection.end.x === 0 ? xterm.cols : selection.end.x;
        const x = bounds.left + column * bounds.width / xterm.cols;
        const top = bounds.top + row * bounds.height / xterm.rows;
        const bottom = top + bounds.height / xterm.rows;
        this.button.hidden = false;
        const { width, height } = this.button.getBoundingClientRect();
        const left = Math.max(8, Math.min(Math.max(bounds.left, x - width), bounds.right - width, window.innerWidth - width - 8));
        const y = top - height - 6 >= bounds.top ? top - height - 6 : bottom + 6;
        this.button.style.left = `${left}px`;
        this.button.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    };

    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;
        this.terminalDisposables.dispose(); this.disposables.dispose(); this.terminal = undefined;
    }
}
