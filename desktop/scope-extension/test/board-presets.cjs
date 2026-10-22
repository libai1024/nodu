// SPDX-License-Identifier: MIT
// Simple-mode board picker data (run after npm run compile).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BOARD_FAMILIES, BOARD_PRESETS, boardPorts, resolvePort, presetFor, presetsIn, shortPortName } = require('../lib/common/nodu-board-presets');
const { BOARD_MENU } = require('../lib/common/nodu-tools-menu');

test('every original board id is reachable and labels are unique', () => {
    const ids = new Set(BOARD_PRESETS.map(preset => preset.boardId));
    for (const entry of BOARD_MENU) { assert.ok(ids.has(entry.boardId), entry.label); }
    assert.equal(new Set(BOARD_PRESETS.map(preset => preset.id)).size, BOARD_PRESETS.length);
    assert.equal(new Set(BOARD_PRESETS.map(preset => preset.label)).size, BOARD_PRESETS.length);
    assert.equal(BOARD_PRESETS[0].profile, 'embedfire-cam-gc2145');
    assert.equal(presetFor('generic-k210', 2).id, 'maix-dock');
});

const mac = [
    { path: '/dev/cu.Bluetooth-Incoming-Port', description: 'PciPort' },
    { path: '/dev/tty.Bluetooth-Incoming-Port', description: 'PciPort' },
    { path: '/dev/cu.usbserial-3120', description: 'USB Serial', vid: 0x0403, pid: 0x6010, serialNumber: 'A1' },
    { path: '/dev/tty.usbserial-3120', description: 'USB Serial', vid: 0x0403, pid: 0x6010, serialNumber: 'A1' },
];

test('candidates keep USB serial devices only, one cu.* node per device', () => {
    assert.deepEqual(boardPorts(mac).map(port => port.path), ['/dev/cu.usbserial-3120']);
    assert.deepEqual(boardPorts([{ path: 'COM5', description: 'USB', vid: 1 }]).map(port => port.path), ['COM5']);
    assert.deepEqual(boardPorts([{ path: 'mock', description: 'Nodu mock board' }]).map(port => port.path), ['mock']);
});

test('port resolution: serial number, then path, then the only candidate; never a guess', () => {
    const two = [
        { path: '/dev/cu.usbserial-1', description: 'a', vid: 1, serialNumber: 'S1' },
        { path: '/dev/cu.usbserial-2', description: 'b', vid: 1, serialNumber: 'S2' },
    ];
    assert.equal(resolvePort(two, { preset: 'maix-dock', port: '/dev/cu.usbserial-1', serialNumber: 'S2' }).path, '/dev/cu.usbserial-2');
    assert.equal(resolvePort(two, { preset: 'maix-dock', port: '/dev/cu.usbserial-1' }).path, '/dev/cu.usbserial-1');
    assert.equal(resolvePort(two, { preset: 'maix-dock', port: '/dev/cu.gone' }), undefined);
    assert.equal(resolvePort(two, undefined), undefined);
    assert.equal(resolvePort([two[0]], undefined).path, '/dev/cu.usbserial-1');
    assert.equal(resolvePort([], undefined), undefined);
});

test('short port names', () => {
    assert.equal(shortPortName('/dev/cu.usbserial-3120'), 'cu.usbserial-3120');
    assert.equal(shortPortName('COM5'), 'COM5');
});

test('families: only K210 is pickable, every preset belongs to a listed family', () => {
    assert.deepEqual(BOARD_FAMILIES.map(family => family.id), ['k210', 'stm32', 'esp32']);
    assert.deepEqual(BOARD_FAMILIES.filter(family => family.available).map(family => family.id), ['k210']);
    for (const family of BOARD_FAMILIES) {
        assert.equal('family' in family, false, family.id);
        if (!family.available) { assert.ok(family.status, family.id); assert.equal(presetsIn(family.id).length, 0, family.id); }
    }
    assert.equal(presetsIn('k210').length, BOARD_PRESETS.length);
    const ids = new Set(BOARD_FAMILIES.map(family => family.id));
    for (const preset of BOARD_PRESETS) { assert.ok(ids.has(preset.family), preset.id); }
});
