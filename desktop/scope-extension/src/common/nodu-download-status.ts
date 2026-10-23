// SPDX-License-Identifier: MIT
export interface DownloadStatus {
    building: boolean;
    flashing: boolean;
    awaitUser?: string;
    flashSteps: Record<string, string>;
    flashPercent?: number;
    task?: { text: string; tone: string };
}

/** Use actual stage progress, never present Flash capacity as download progress. */
export function downloadStatusText(method: string, state: DownloadStatus): string {
    const name = method === 'uart' ? '串口 ISP' : 'ST-LINK';
    let stage = '';
    if (state.building) { stage = '编译中'; }
    else if (state.awaitUser === 'enterBoot') { stage = '等待芯片'; }
    else if (state.awaitUser === 'exitBoot') { stage = '等待复位'; }
    else if (state.flashing) {
        const active = Object.entries(state.flashSteps).filter(([, value]) => value === 'running').pop()?.[0];
        stage = ({ identify: '识别', backup: '备份', program: '写入', verify: '校验', run: '启动' } as Record<string, string>)[active || ''] || '下载中';
        if (Number.isFinite(state.flashPercent) && active) { stage += ` ${Math.round(Math.max(0, Math.min(100, state.flashPercent!)))}%`; }
    } else if (state.task?.tone === 'error') { stage = '失败'; }
    else if (state.task?.text === '已停止') { stage = '已停止'; }
    return stage ? `${name}  ${stage}` : name;
}
