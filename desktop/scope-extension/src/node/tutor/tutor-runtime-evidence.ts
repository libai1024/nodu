// SPDX-License-Identifier: MIT
export interface TutorRuntimeEvidenceSnapshot {
    download: { bundle: string; method: string; completedAt: number; running: boolean | null; uid: string };
    serial?: { port: string; baud: number; observedAt: number; text: string; association: 'user-selected-port' };
}
/** Observations only. No device control, no model-supplied evidence, no persisted serial history. */
export class TutorRuntimeEvidence {
    private readonly downloads = new Map<string, TutorRuntimeEvidenceSnapshot['download']>();
    private activeRun?: { root: string; id: string };
    private monitor?: { root: string; port: string; baud: number; open: boolean };
    private capture?: { root: string; observedAt: number; text: string };
    constructor(private readonly now: () => number = Date.now) { }
    event(event: string, data: unknown): void {
        const d = data as Record<string, unknown> | undefined;
        if (!d) { return; }
        if (event === 'flash.started' || event === 'service.state') {
            this.downloads.clear(); this.capture = undefined;
            this.activeRun = event === 'flash.started' && typeof d.path === 'string' && typeof d.runId === 'string' ? { root: d.path, id: d.runId } : undefined;
        }
        if (event === 'monitor.state') {
            this.capture = undefined;
            if (this.monitor) { this.monitor.open = d.port === this.monitor.port && d.state === 'open'; }
        }
        if (event !== 'monitor.data' || !this.monitor?.open || d.port !== this.monitor.port || typeof d.data !== 'string' || d.data.length > 6000) { return; }
        const download = this.downloads.get(this.monitor.root);
        if (!download || this.now() <= download.completedAt) { return; }
        const text = Buffer.from(d.data, 'base64').toString('utf8').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
        this.capture = { root: this.monitor.root, observedAt: this.now(), text: ((this.capture?.text ?? '') + text).slice(-2000) };
    }
    result(method: string, args: Record<string, unknown>, value: unknown): void {
        const result = value as Record<string, unknown> | undefined;
        if (method === 'closeMonitor') { this.monitor = undefined; this.capture = undefined; }
        if (method === 'openMonitor') {
            this.capture = undefined;
            this.monitor = typeof args.path === 'string' && typeof args.port === 'string' && result?.open === true
                ? { root: args.path, port: args.port, baud: Number(result.baud ?? args.baud ?? 115200), open: true } : undefined;
        }
        if (method !== 'flash' || result?.ok !== true || typeof args.path !== 'string' || typeof args.bundle !== 'string' || !/^[a-f0-9]{64}$/.test(args.bundle)) { return; }
        const uid = (result.identity as Record<string, unknown>)?.uid;
        if (typeof uid !== 'string' || this.activeRun?.root !== args.path || this.activeRun.id !== result.runId) { return; }
        this.downloads.set(args.path, { bundle: args.bundle, method: String(result.method), uid,
            completedAt: this.now(), running: result.running === true ? true : result.running === false ? false : null });
        while (this.downloads.size > 16) { this.downloads.delete(this.downloads.keys().next().value!); }
    }
    snapshot(root: string, bundle: string): TutorRuntimeEvidenceSnapshot | undefined {
        const download = this.downloads.get(root);
        if (!download || download.bundle !== bundle) { return; }
        const serial = this.monitor?.open && this.monitor.root === root && this.capture?.root === root
            && this.now() - this.capture.observedAt < 30000 ? { port: this.monitor.port, baud: this.monitor.baud,
                observedAt: this.capture.observedAt, text: this.capture.text, association: 'user-selected-port' as const } : undefined;
        return { download: { ...download }, ...(serial ? { serial } : {}) };
    }
}
