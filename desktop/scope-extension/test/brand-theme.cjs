// SPDX-License-Identifier: MIT
// Brand v2 theme maps: every value is a valid colour, both themes cover the same IDs, nothing
// from the superseded v1 palette survives, and the key text / control pairs meet WCAG targets.
// Run after `npm run compile` (reads lib/). No DOM or Theia runtime needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { workbenchColors, editorTokenRules, scopeColorDefaults, alpha, mix } = require('../lib/browser/nodu-theme-colors');
const { NODU_COLORS } = require('../lib/browser/nodu-brand');
const tokens = require(path.join(__dirname, '../../../brand/src/tokens.cjs'));

const HEX = /^#[0-9A-F]{6}([0-9A-F]{2})?$/i;
const opaque = hex => hex.slice(0, 7);

test('generated IDE tokens match the brand source', () => {
    for (const theme of ['dark', 'light']) {
        assert.deepEqual({ ...NODU_COLORS[theme] }, tokens.resolve(theme), `${theme} tokens drifted; run node brand/scripts/build.cjs`);
    }
});

test('both themes define the same colour IDs, all valid hex', () => {
    const dark = workbenchColors('dark'), light = workbenchColors('light');
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
    for (const [id, value] of [...Object.entries(dark), ...Object.entries(light)]) {
        assert.match(value, HEX, `${id} = ${value}`);
    }
    for (const theme of ['dark', 'light']) {
        for (const rule of editorTokenRules(theme)) assert.match(rule.settings.foreground, HEX);
    }
    for (const color of scopeColorDefaults()) {
        for (const value of Object.values(color.defaults)) assert.match(value, HEX, `${color.id} = ${value}`);
    }
});

test('no superseded colour (v1, or the v2.0 warm-paper light theme) remains in the theme', () => {
    const legacy = new Set(tokens.legacy.map(h => h.toUpperCase()));
    for (const theme of ['dark', 'light']) {
        for (const [id, value] of Object.entries(workbenchColors(theme))) {
            assert.ok(!legacy.has(opaque(value).toUpperCase()), `${theme} ${id} uses legacy ${value}`);
        }
    }
});

test('key pairs meet WCAG targets in both themes', () => {
    const pairs = [
        ['foreground', 'editor.background', 4.5], ['foreground', 'sideBar.background', 4.5], ['foreground', 'statusBar.background', 4.5],
        ['descriptionForeground', 'editor.background', 4.5], ['descriptionForeground', 'sideBar.background', 4.5],
        ['textLink.foreground', 'editor.background', 4.5], ['button.foreground', 'button.background', 4.5],
        ['button.foreground', 'button.hoverBackground', 4.5], ['activityBarBadge.foreground', 'activityBarBadge.background', 4.5],
        ['list.activeSelectionForeground', 'list.activeSelectionBackground', 4.5], ['menu.foreground', 'menu.background', 4.5],
        ['errorForeground', 'editor.background', 4.5], ['tab.inactiveForeground', 'tab.inactiveBackground', 4.5],
        ['focusBorder', 'editor.background', 3], ['input.border', 'input.background', 3], ['tab.activeBorderTop', 'editor.background', 3]
    ];
    for (const theme of ['dark', 'light']) {
        const c = workbenchColors(theme);
        for (const [fg, bg, min] of pairs) {
            const value = tokens.contrast(opaque(c[fg]), opaque(c[bg]));
            assert.ok(value >= min, `${theme}: ${fg} on ${bg} is ${value.toFixed(2)}:1 < ${min}`);
        }
    }
});

test('colour helpers', () => {
    assert.equal(alpha('#2F5BFF', 0.5), '#2F5BFF80');
    assert.equal(mix('#FFFFFF', '#000000', 0.5), '#808080');
    assert.equal(mix('#2F5BFF', '#181B21', 0.24), tokens.mix('#2F5BFF', '#181B21', 0.24));
});
