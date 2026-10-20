// SPDX-License-Identifier: MIT
// Pure parser coverage for common/nodu-board-info (run after npm run compile).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { inspectBoardConfig, boardPinSample } = require('../lib/common/nodu-board-info');
const { BOARD_DEFINITIONS } = require('../lib/common/nodu-board-data');

const embedfire = BOARD_DEFINITIONS.find(board => board.id === 'embedfire-cam-gc2145');

test('declared: real embedfire snapshot matches the catalog and extracts whitelisted peripherals', () => {
    // Committed fixture: byte-identical copy of the captured board snapshot.
    const text = readFileSync(join(__dirname, 'fixtures', 'board-config-embedfire.json'), 'utf-8');
    const result = inspectBoardConfig(text);
    assert.equal(result.status, 'declared');
    assert.equal(result.boardId, 'embedfire-cam-gc2145');
    assert.equal(result.declaredType, 'embedfire');
    assert.equal(result.configName, 'embedfire-k210');
    assert.deepEqual(result.pins, { USER_LED: 17, BOOT_KEY: 16 });
    assert.equal(result.peripherals.sensor.pin_clk, 25);
    assert.equal(result.peripherals.sensor.pin_sda, 24);
    assert.equal(result.peripherals.lcd.rst, 29);
    assert.equal(result.peripherals.sdcard.mosi, 7);
    // Firmware parameters are not physical IO and must not appear as pins.
    for (const section of Object.values(result.peripherals)) {
        assert.ok(!('i2c_num' in section) && !('reg_width' in section) && !('cs_gpio' in section));
    }
});

test('declared: each catalog board resolves its frozen declared type', () => {
    for (const board of BOARD_DEFINITIONS) {
        for (const type of board.declaredTypes) {
            const result = inspectBoardConfig(JSON.stringify({ type, board_info: board.pins }));
            assert.equal(result.status, 'declared', `${board.id} via type ${type}`);
            assert.equal(result.boardId, board.id);
        }
    }
});

test('unknown: missing identifiers and unlisted types stay unidentified', () => {
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { USER_LED: 17, BOOT_KEY: 16 } })).status, 'unknown');
    // Coincident LED assignments on an unknown type must not match the catalog.
    const coincident = inspectBoardConfig(JSON.stringify({ type: 'custom-board', board_info: { USER_LED: 17, BOOT_KEY: 16 } }));
    assert.equal(coincident.status, 'unknown');
    assert.equal(coincident.boardId, undefined);
    // Generic placeholder names do not assert a model.
    const generic = inspectBoardConfig(JSON.stringify({ type: 'embedfire', config_name: 'config.json' }));
    assert.equal(generic.status, 'declared');
    const placeholders = inspectBoardConfig(JSON.stringify({ type: 'template', config_name: 'config.json' }));
    assert.equal(placeholders.status, 'unknown');
});

test('conflict: identifiers pointing at different boards or divergent pins', () => {
    const across = inspectBoardConfig(JSON.stringify({ type: 'bit', config_name: 'embedfire-k210' }));
    assert.equal(across.status, 'conflict');
    assert.equal(across.boardId, undefined);
    const unknownPeer = inspectBoardConfig(JSON.stringify({ type: 'embedfire', config_name: 'my-own-build' }));
    assert.equal(unknownPeer.status, 'conflict');
    // Same declaration but a different IO on a catalog alias: pins kept for display, no model claimed.
    const diverged = inspectBoardConfig(JSON.stringify({ type: 'embedfire', board_info: { USER_LED: 18, BOOT_KEY: 16 } }));
    assert.equal(diverged.status, 'conflict');
    assert.equal(diverged.boardId, undefined);
    assert.equal(diverged.pins.USER_LED, 18);
});

test('invalid: malformed documents and pins', () => {
    assert.equal(inspectBoardConfig('').status, 'invalid');
    assert.equal(inspectBoardConfig('   ').status, 'invalid');
    assert.equal(inspectBoardConfig('not json').status, 'invalid');
    assert.equal(inspectBoardConfig('[]').status, 'invalid');
    assert.equal(inspectBoardConfig('42').status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: 'oops' })).status, 'invalid');
    for (const bad of [{ LED: 48 }, { LED: -1 }, { LED: 3.5 }, { LED: '16' }, { LED: true }, { LED: null }]) {
        const result = inspectBoardConfig(JSON.stringify({ board_info: bad }));
        assert.equal(result.status, 'invalid', JSON.stringify(bad));
        assert.deepEqual(result.pins, {}, 'bad pins never partially survive');
    }
});

test('invalid: dangerous or malformed alias names are rejected, not dropped', () => {
    for (const name of ['__proto__', 'constructor', 'prototype', '<img src=x>', 'a'.repeat(65), '9PIN']) {
        const result = inspectBoardConfig(JSON.stringify({ board_info: { [name]: 5, BOOT_KEY: 16 } }));
        assert.equal(result.status, 'invalid', name);
        assert.deepEqual(result.pins, {});
    }
});

test('metadata slots and D arrays in board_info', () => {
    const result = inspectBoardConfig(JSON.stringify({ board_info: { pin_num: 4, pin_name: ['a', 'b'], D: [4, 5, 21], BOOT_KEY: 16 } }));
    assert.deepEqual(result.pins, { D0: 4, D1: 5, D2: 21, BOOT_KEY: 16 });
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { D: [4, 'x'] } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { D: 4 } })).status, 'invalid');
    // D list bound and metadata shape checks.
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { D: new Array(49).fill(4) } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { pin_num: 49 } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { pin_num: -1 } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { pin_num: 3.5 } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { pin_name: 'abc' } })).status, 'invalid');
    assert.equal(inspectBoardConfig(JSON.stringify({ board_info: { pin_name: ['a', 3] } })).status, 'invalid');
});

test('invalid: D array and literal alias collisions in both key orders', () => {
    // JSON key order decides which write wins under silent overwrite; both
    // orders must instead be rejected.
    const dFirst = inspectBoardConfig(JSON.stringify({ type: 'embedfire', board_info: { D: [4], D0: 5, BOOT_KEY: 16 } }));
    assert.equal(dFirst.status, 'invalid');
    assert.deepEqual(dFirst.pins, {});
    const literalFirst = inspectBoardConfig(JSON.stringify({ type: 'embedfire', board_info: { D0: 5, D: [4], BOOT_KEY: 16 } }));
    assert.equal(literalFirst.status, 'invalid');
    assert.deepEqual(literalFirst.pins, {});
    // An agreeing duplicate declaration is harmless.
    const agreeing = inspectBoardConfig(JSON.stringify({ board_info: { D: [4], D0: 4 } }));
    assert.equal(agreeing.status, 'unknown');
    assert.equal(agreeing.pins.D0, 4);
});

test('invalid: documents beyond the 16 KiB byte limit', () => {
    const big = JSON.stringify({ type: 'embedfire', padding: 'x'.repeat(17000) });
    assert.equal(inspectBoardConfig(big).status, 'invalid');
    // UTF-8 multi-byte counts as bytes, not characters.
    const wide = JSON.stringify({ type: 'embedfire', padding: '见'.repeat(6000) });
    assert.equal(inspectBoardConfig(wide).status, 'invalid');
});

test('invalid: malformed identifiers and peripherals reject the document', () => {
    const longType = inspectBoardConfig(JSON.stringify({ type: 'x'.repeat(81) }));
    assert.equal(longType.status, 'invalid');
    assert.ok(longType.issues.length > 0);
    // A malformed identifier must not combine with a valid sibling into declared.
    for (const doc of [
        { type: 7, config_name: 'embedfire-k210' },
        { type: 'embedfire', config_name: 42 },
        { type: 'x'.repeat(81), config_name: 'embedfire-k210' },
    ]) {
        const result = inspectBoardConfig(JSON.stringify({ ...doc, board_info: { USER_LED: 17, BOOT_KEY: 16 } }));
        assert.equal(result.status, 'invalid', JSON.stringify(doc));
        assert.equal(result.boardId, undefined);
        assert.deepEqual(result.pins, {});
    }
    // A malformed whitelisted peripheral value or non-object section fails the
    // whole inspection rather than being silently omitted — and drops any
    // already-validated pins/peripherals too.
    const badValue = inspectBoardConfig(JSON.stringify({ type: 'embedfire',
        board_info: { USER_LED: 17, BOOT_KEY: 16 },
        sensor: { pin_clk: 25, pin_sda: 24 }, lcd: { rst: 99 } }));
    assert.equal(badValue.status, 'invalid');
    assert.deepEqual(badValue.pins, {});
    assert.deepEqual(badValue.peripherals, {});
    const badSection = inspectBoardConfig(JSON.stringify({ type: 'embedfire',
        board_info: { USER_LED: 17, BOOT_KEY: 16 },
        sensor: { pin_clk: 25, pin_sda: 24 }, lcd: 'wired' }));
    assert.equal(badSection.status, 'invalid');
    assert.deepEqual(badSection.pins, {});
    assert.deepEqual(badSection.peripherals, {});
});

test('boardPinSample emits the unified helper lookup', () => {
    assert.equal(boardPinSample('USER_LED'), 'import nodu_board\nprint(nodu_board.pin("USER_LED"))');
    assert.equal(boardPinSample('D0'), 'import nodu_board\nprint(nodu_board.pin("D0"))');
    // Names are JSON-quoted so the snippet stays a plain string literal.
    assert.equal(boardPinSample('we"ird'), 'import nodu_board\nprint(nodu_board.pin("we\\"ird"))');
});
