// SPDX-License-Identifier: MIT
export interface LogLine { text: string; kind: string; at?: number }
export interface MonitorSnapshot { lines: LogLine[]; partial: string; partialAt?: number; hex: string }
export function timestamp(at: number): string {
    const d = new Date(at);
    return `${[d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}
export function logLine(line: LogLine, timestamps: boolean): string {
    return timestamps && line.kind === 'data' && line.at !== undefined ? `[${timestamp(line.at)}] ${line.text}` : line.text;
}
export function monitorLog(snapshot: MonitorSnapshot, hex: boolean, timestamps: boolean): string {
    if (hex) { return snapshot.hex; }
    return [...snapshot.lines.map(l => logLine(l, timestamps)), ...(snapshot.partial ? [logLine({ text: snapshot.partial, kind: 'data', at: snapshot.partialAt }, timestamps)] : [])].join('\n');
}
