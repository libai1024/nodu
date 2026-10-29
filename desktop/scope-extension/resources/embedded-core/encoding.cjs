// SPDX-License-Identifier: MIT
// Encode only representable GBK characters; never replace them with '?' silently.
let gbk;
function encode(text, encoding) {
  if (typeof text !== 'string' || text.length > 65536) throw new Error('发送文本过大或无效。');
  if (encoding === 'utf-8') return Buffer.from(text, 'utf8');
  if (encoding !== 'gbk') throw new Error('不支持的发送编码。');
  if (!gbk) {
    gbk = new Map(); const decoder = new TextDecoder('gbk', { fatal: true });
    for (let byte = 0; byte <= 0x80; byte++) { try { gbk.set(decoder.decode(Uint8Array.of(byte)), [byte]); } catch {} }
    for (let first = 0x81; first <= 0xfe; first++) for (let second = 0x40; second <= 0xfe; second++) {
      if (second === 0x7f) continue;
      try { const character = decoder.decode(Uint8Array.of(first, second)); if ([...character].length === 1 && !gbk.has(character)) gbk.set(character, [first, second]); } catch {}
    }
  }
  const bytes = [];
  for (const character of text) { const encoded = gbk.get(character); if (!encoded) throw new Error('文本包含 GBK 无法表示的字符，请选择 UTF-8 或 HEX。'); bytes.push(...encoded); }
  return Buffer.from(bytes);
}
module.exports = { encode };
