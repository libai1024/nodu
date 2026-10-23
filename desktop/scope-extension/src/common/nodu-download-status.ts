// SPDX-License-Identifier: MIT
export interface DownloadStatus {
    building: boolean;
    flashing: boolean;
    awaitUser?: string;
    flashSteps: Record<string, string>;
    flashPercent?: number;
    buildProgress?: { done: number; total: number };
    task?: { text: string; tone: string };
}

/** Unknown totals remain indeterminate; completion is set only after a successful reply. */
export function taskProgress(state: DownloadStatus): number | undefined {
    if (state.awaitUser) { return undefined; }
    if (state.building) {
        const p = state.buildProgress;
        return p && p.total > 0 && Number.isFinite(p.done) ? Math.min(99, Math.max(0, Math.floor(p.done / p.total * 100))) : undefined;
    }
    if (state.flashing) {
        const order = ['identify', 'backup', 'program', 'verify', 'run'];
        const index = order.findIndex(step => state.flashSteps[step] === 'running');
        if (index < 0) {
            const done = order.reduce((last, step, i) => state.flashSteps[step] === 'done' ? i + 1 : last, 0);
            return Math.min(99, done / order.length * 100);
        }
        const fraction = Number.isFinite(state.flashPercent) ? Math.max(0, Math.min(100, state.flashPercent!)) / 100 : 0;
        return Math.min(99, Math.floor((index + fraction) / order.length * 100));
    }
    if (state.task?.tone === 'ok' && /^(编译成功|运行中|已请求运行)/.test(state.task.text)) { return 100; }
    return undefined;
}

/** Use actual stage progress, never present Flash capacity as download progress. */
export function downloadStatusText(method: string, state: DownloadStatus): string {
    const name = method === 'uart' ? '串口 ISP' : 'ST-LINK';
    let stage = '';
    if (state.building) { stage = '编译'; }
    else if (state.awaitUser === 'enterBoot') { stage = '等待芯片'; }
    else if (state.awaitUser === 'exitBoot') { stage = '等待复位'; }
    else if (state.flashing) {
        const active = Object.entries(state.flashSteps).filter(([, value]) => value === 'running').pop()?.[0];
        stage = ({ identify: '识别', backup: '备份', program: '写入', verify: '校验', run: '启动' } as Record<string, string>)[active || ''] || '下载中';

    } else if (state.task?.tone === 'error') { stage = '失败'; }
    else if (state.task?.text === '已停止') { stage = '已停止'; }
    else if (state.task?.tone === 'ok') { stage = state.task.text; }
    const percent = taskProgress(state);
    if (percent !== undefined) { stage += ` ${percent}%`; }
    else if (state.building) { stage = '配置工程'; }
    return stage ? `${name}  ${stage}` : name;
}
