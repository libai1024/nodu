// SPDX-License-Identifier: MIT
/** Retire an Electron-owned backend after its desktop parent exits. */
interface ParentWatch {
    electron?: string;
    parentPid?: number;
    currentParent?: () => number;
    probe?: (pid: number) => void;
    gracefulStop?: () => void;
    schedule?: typeof setInterval;
    clear?: typeof clearInterval;
}
export function superviseDesktopParent(options: ParentWatch = {}): () => void {
    const electron = options.electron ?? process.versions.electron;
    if (!electron) { return () => {}; }
    const parent = options.parentPid ?? process.ppid;
    const current = options.currentParent ?? (() => process.ppid);
    const probe = options.probe ?? (pid => { process.kill(pid, 0); });
    // Theia's SIGTERM handler awaits contribution cleanup. The independent
    // shared coordinator remains responsible for outstanding board writes.
    const stop = options.gracefulStop ?? (() => { process.kill(process.pid, 'SIGTERM'); });
    if (parent < 2) { stop(); return () => {}; }
    const clear = options.clear ?? clearInterval;
    let stopping = false;
    const timer = (options.schedule ?? setInterval)(() => {
        if (stopping) { return; }
        let gone = current() !== parent;
        if (!gone) {
            try { probe(parent); } catch (error) { gone = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
        }
        if (gone) { stopping = true; clear(timer); stop(); }
    }, 500);
    timer.unref();
    return () => { stopping = true; clear(timer); };
}
