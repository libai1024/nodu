// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MonitorBytes } = require('../scope-extension/lib/common/nodu-monitor-bytes.js');
const { preferredMonitorPort } = require('../scope-extension/lib/common/nodu-monitor-ports.js');
const { encodeMonitorText } = require('../scope-extension/lib/node/nodu-monitor-encoding.js');

test('hotplug suggests the sole USB port without replacing the user or active port', () => {
    const virtual = { path: '/dev/cu.Bluetooth-Incoming-Port' };
    const usb = { path: '/dev/cu.usbserial-1', vid: 0x1a86 };
    assert.equal(preferredMonitorPort('', [virtual]), '');
    assert.equal(preferredMonitorPort('', [virtual, usb]), usb.path);
    assert.equal(preferredMonitorPort(usb.path, [virtual]), usb.path);
    assert.equal(preferredMonitorPort(usb.path, [virtual, usb]), usb.path);
    assert.equal(preferredMonitorPort(virtual.path, [virtual, usb]), virtual.path);
    assert.equal(preferredMonitorPort('', [usb, { ...usb, path: '/dev/cu.usbserial-2' }]), '');
});

test('hex display preserves actual wire bytes, including invalid text and line endings', () => {
    const bytes = new MonitorBytes();
    bytes.append(Uint8Array.of(0, 1, 10, 13, 127, 128, 255, 195, 40, 0, 126));
    assert.equal(bytes.hex(), '00 01 0a 0d 7f 80 ff c3 28 00 7e');
    bytes.clear();
    bytes.append(Uint8Array.of(0xd6, 0xd0, 0xce, 0xc4));
    assert.equal(bytes.hex(), 'd6 d0 ce c4');
    bytes.clear(); assert.equal(bytes.hex(), '');
});

test('raw receive buffer retains only its bounded newest bytes', () => {
    const bytes = new MonitorBytes(4);
    bytes.append(Uint8Array.of(1, 2, 3)); bytes.append(Uint8Array.of(4, 5));
    assert.equal(bytes.hex(), '02 03 04 05');
    bytes.append(Uint8Array.of(6, 7, 8, 9, 10, 11));
    assert.equal(bytes.hex(), '08 09 0a 0b');
});

test('send encoding produces exact UTF-8/GBK bytes and retains line endings', () => {
    const hex = (text, encoding) => Buffer.from(encodeMonitorText(text, encoding), 'base64').toString('hex');
    assert.equal(hex('中文\r\n', 'utf-8'), 'e4b8ade696870d0a');
    assert.equal(hex('中文\n', 'gbk'), 'd6d0cec40a');
    assert.equal(hex('abc', 'utf-8'), '616263');
    assert.throws(() => encodeMonitorText('😀', 'gbk'), /无法表示/);
    assert.throws(() => encodeMonitorText('abc', 'unknown'), /无效/);
    assert.throws(() => encodeMonitorText('x'.repeat(65537), 'utf-8'), /64 KB/);
});
