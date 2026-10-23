// SPDX-License-Identifier: MIT
/** Bounded wire bytes, independent of text decoding and newline normalization. */
export class MonitorBytes {
    private bytes = new Uint8Array();
    constructor(private readonly limit = 65_536) {}
    append(chunk: Uint8Array): void {
        const keep = Math.min(this.bytes.length, Math.max(0, this.limit - chunk.length));
        const tail = chunk.subarray(Math.max(0, chunk.length - this.limit));
        const next = new Uint8Array(keep + tail.length);
        next.set(this.bytes.subarray(this.bytes.length - keep)); next.set(tail, keep); this.bytes = next;
    }
    clear(): void { this.bytes = new Uint8Array(); }
    hex(): string {
        const rows: string[] = [];
        for (let i = 0; i < this.bytes.length; i += 16) {
            rows.push(Array.from(this.bytes.subarray(i, i + 16), b => b.toString(16).padStart(2, '0')).join(' '));
        }
        return rows.join('\n');
    }
}
