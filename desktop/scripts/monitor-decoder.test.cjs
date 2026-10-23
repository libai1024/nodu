// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MonitorDecoder, hasMonitorStartupLine } = require('../scope-extension/lib/common/nodu-monitor-decoder.js');
test('ROM noise is not treated as application startup output', () => {
    assert.equal(hasMonitorStartupLine([]), false);
    assert.equal(hasMonitorStartupLine(['', '  ', '\x1f', '\ufffd', '\x00READY']), false);
    assert.equal(hasMonitorStartupLine(['NODU UART READY\r']), true);
    assert.equal(hasMonitorStartupLine(['中文串口测试']), true);
    const decoder = new MonitorDecoder();
    const partial = decoder.decode(new TextEncoder().encode('READY'), 'utf-8');
    const lines = partial.split(/\r?\n/); lines.pop();
    assert.equal(hasMonitorStartupLine(lines), false);
});
test('UTF-8 and GBK survive byte boundaries; invalid/incomplete bytes use replacement', () => {
    const d = new MonitorDecoder();
    assert.equal(d.decode(Uint8Array.of(0xe4, 0xb8), 'utf-8'), '');
    assert.equal(d.decode(Uint8Array.of(0xad, 10), 'utf-8'), '中\n');
    assert.equal(d.decode(Uint8Array.of(0xd6), 'gbk'), '');
    assert.equal(d.decode(Uint8Array.of(0xd0, 0xce, 0xc4), 'gbk'), '中文');
    assert.equal(d.decode(Uint8Array.of(0xff), 'utf-8'), '�');
    assert.equal(d.decode(Uint8Array.of(0xe4), 'utf-8'), '');
    assert.equal(d.finish(), '�');
    assert.equal(d.decode(Uint8Array.of(65), 'utf-8'), 'A');
});
test('changing encoding flushes incomplete bytes; clear discards previous stream', () => {
    const d = new MonitorDecoder(); d.decode(Uint8Array.of(0xe4), 'utf-8');
    assert.equal(d.decode(Uint8Array.of(65), 'gbk'), '�A');
    d.decode(Uint8Array.of(0xd6), 'gbk'); d.clear();
    assert.equal(d.decode(Uint8Array.of(65), 'gbk'), 'A');
});
