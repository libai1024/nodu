// SPDX-License-Identifier: MIT
/** Only complete readable lines count as application output after ROM ISP. */
export function hasMonitorStartupLine(lines: readonly string[]): boolean {
    return lines.some(line => line.trim().length > 0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\ufffd]/.test(line));
}

/** Preserve split multibyte characters; flush at port/encoding/run boundaries. */
export class MonitorDecoder {
    private decoder = new TextDecoder('utf-8');
    private encoding = 'utf-8';
    decode(bytes: Uint8Array, encoding: 'utf-8' | 'gbk'): string {
        let prefix = '';
        if (encoding !== this.encoding) {
            prefix = this.decoder.decode();
            this.decoder = new TextDecoder(encoding);
            this.encoding = encoding;
        }
        return prefix + this.decoder.decode(bytes, { stream: true });
    }
    finish(): string { return this.decoder.decode(); }
    clear(): void { this.decoder = new TextDecoder(this.encoding); }
}
