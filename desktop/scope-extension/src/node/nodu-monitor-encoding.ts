// SPDX-License-Identifier: MIT
import * as iconv from 'iconv-lite';
export function encodeMonitorText(text: unknown, encoding: unknown): string {
    if (typeof text !== 'string' || (encoding !== 'utf-8' && encoding !== 'gbk')) { throw new Error('串口文本或编码无效。'); }
    const bytes = iconv.encode(text, encoding);
    if (bytes.length > 65_536) { throw new Error('单次发送不能超过 64 KB。'); }
    if (iconv.decode(bytes, encoding) !== text) { throw new Error('所选编码无法表示这些字符，请改用 UTF-8。'); }
    return bytes.toString('base64');
}
