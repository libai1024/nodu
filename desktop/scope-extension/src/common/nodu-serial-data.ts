// SPDX-License-Identifier: MIT
/** Serial bytes are transport chunks, never inferred packets or firmware commands. */
export type SerialFormat = 'text' | 'hex';
export type SerialEnding = 'none' | 'lf' | 'cr' | 'crlf';
export const SERIAL_ENDINGS: Record<SerialEnding, string> = { none: '', lf: '\n', cr: '\r', crlf: '\r\n' };
export const MAX_SERIAL_SEND = 64 * 1024;

export function parseSerialDraft(draft: string, format: SerialFormat, ending: SerialEnding): Uint8Array {
    let bytes: Uint8Array;
    if (format === 'hex') {
        // Only complete byte pairs; whitespace may separate bytes. Never append text line endings.
        const compact = draft.replace(/\s/g, '');
        if (!compact || compact.length % 2 || !/^[0-9a-f]+$/i.test(compact)) {
            throw new Error('HEX 需要完整字节对，例如 01 FF 0A；不能包含 0x 或非十六进制字符。');
        }
        bytes = Uint8Array.from(compact.match(/.{2}/g)!, pair => parseInt(pair, 16));
    } else {
        if (!draft) { throw new Error('请输入要发送的文本。'); }
        bytes = new TextEncoder().encode(draft + SERIAL_ENDINGS[ending]);
    }
    if (bytes.length > MAX_SERIAL_SEND) { throw new Error('一次最多发送 64 KiB。'); }
    return bytes;
}

export function serialHex(bytes: Uint8Array): string {
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
export function serialBase64(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) { binary += String.fromCharCode(byte); }
    return btoa(binary);
}
export function serialBytes(base64: string): Uint8Array {
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
}

/** Stateful decoding must keep unfinished UTF-8 characters between transport chunks. */
export class SerialTextDecoder {
    private decoder: TextDecoder;
    constructor(readonly encoding = 'utf-8') { this.decoder = new TextDecoder(encoding); }
    push(bytes: Uint8Array): string { return this.decoder.decode(bytes, { stream: true }); }
    finish(): string { const tail = this.decoder.decode(); this.decoder = new TextDecoder(this.encoding); return tail; }
}
