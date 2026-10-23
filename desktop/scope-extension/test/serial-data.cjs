// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseSerialDraft, serialHex, serialBytes, serialBase64, SerialTextDecoder } = require('../lib/common/nodu-serial-data');
test('HEX preserves non-text bytes and ignores text line endings', () => {
    const bytes = parseSerialDraft('00 FF 80 0a', 'hex', 'crlf');
    assert.deepEqual([...bytes], [0, 255, 128, 10]);
    assert.equal(serialHex(serialBytes(serialBase64(bytes))), '00 FF 80 0A');
    for (const text of ['F', '0xFF', 'GG', '']) { assert.throws(() => parseSerialDraft(text, 'hex', 'none')); }
});
test('TEXT applies precisely the selected ending and UTF-8 bytes', () => {
    for (const [ending, suffix] of Object.entries({ none: '', lf: '\n', cr: '\r', crlf: '\r\n' })) {
        assert.equal(new TextDecoder().decode(parseSerialDraft('状态', 'text', ending)), '状态' + suffix);
    }
    assert.throws(() => parseSerialDraft('a'.repeat(65537), 'text', 'none'));
});
test('stream decoder retains split UTF-8 and resets at disconnect', () => {
    const decoder = new SerialTextDecoder();
    const bytes = new TextEncoder().encode('状态');
    assert.equal(decoder.push(bytes.slice(0, 2)), '');
    assert.equal(decoder.push(bytes.slice(2, 4)), '状');
    assert.equal(decoder.push(bytes.slice(4)), '态');
    decoder.push(Uint8Array.of(0xe4));
    assert.equal(decoder.finish(), '\ufffd');
    assert.equal(decoder.push(Uint8Array.of(65)), 'A');
});
