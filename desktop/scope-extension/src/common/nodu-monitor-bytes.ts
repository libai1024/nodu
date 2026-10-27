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

/** Display transcript with directions; the receive-only raw buffer remains independent. */
export class MonitorHexTranscript {
    private chunks: { direction: 'RX' | 'TX'; bytes: Uint8Array; used: number }[] = [];
    private length = 0;
    constructor(private readonly limit = 65_536) {}
    append(direction: 'RX' | 'TX', bytes: Uint8Array): void {
        if (!bytes.length) { return; }
        const chunk = bytes.subarray(Math.max(0, bytes.length - this.limit));
        // Coalesce small transport reads into bounded blocks, retaining direction changes.
        for (let offset = 0; offset < chunk.length;) {
            let block = this.chunks.at(-1);
            if (!block || block.direction !== direction || block.used === block.bytes.length) {
                block = { direction, bytes: new Uint8Array(256), used: 0 }; this.chunks.push(block);
            }
            const count = Math.min(block.bytes.length - block.used, chunk.length - offset);
            block.bytes.set(chunk.subarray(offset, offset + count), block.used);
            block.used += count; offset += count; this.length += count;
        }
        while (this.length > this.limit) {
            const first = this.chunks[0], remove = Math.min(first.used, this.length - this.limit);
            this.length -= remove;
            if (remove === first.used) { this.chunks.shift(); }
            else { first.bytes.copyWithin(0, remove, first.used); first.used -= remove; }
        }
    }
    clear(): void { this.chunks = []; this.length = 0; }
    hex(): string {
        return this.chunks.flatMap(chunk => {
            const rows: string[] = [];
            for (let i = 0; i < chunk.used; i += 16) {
                rows.push(`${chunk.direction} ${Array.from(chunk.bytes.subarray(i, Math.min(chunk.used, i + 16)), byte => byte.toString(16).padStart(2, '0')).join(' ')}`);
            }
            return rows;
        }).join('\n');
    }
}
