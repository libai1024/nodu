// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectProblems, countProblems } = require('../lib/common/nodu-problems');

function marker(owner, severity, line, message, uri = 'file:///project/main.c', end = 2) {
    return { owner, uri, data: { severity, message, source: owner,
        range: { start: { line, character: 1 }, end: { line, character: end } } } };
}

test('duplicate reports share one row and count, keeping owners and the strongest original range', () => {
    const warning = marker('language', 2, 3, 'unknown value', undefined, 9);
    const error = marker('build', 1, 3, 'unknown value', undefined, 7);
    const original = JSON.stringify([warning, error]);
    const rows = collectProblems([warning, error, error]);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].sources, ['build', 'language']);
    assert.equal(rows[0].diagnostic, error.data);
    assert.equal(rows[0].diagnostic.range.end.character, 7);
    assert.deepEqual(countProblems(rows), { errors: 1, warnings: 0, infos: 0, total: 1 });
    assert.equal(JSON.stringify([warning, error]), original);
});

test('same message at another file or position remains distinct; hints and missing severity stay visible', () => {
    const rows = collectProblems([
        marker('build', 1, 0, 'failure'), marker('build', 1, 1, 'failure'),
        marker('build', 1, 0, 'failure', 'file:///other/main.c'), marker('language', 4, 2, 'hint'),
        marker('language', undefined, 3, 'notice'), marker('language', 2, 4, 'warning')
    ]);
    assert.equal(rows.length, 6);
    assert.deepEqual(countProblems(rows), { errors: 3, warnings: 1, infos: 2, total: 6 });
    assert.equal(rows[0].diagnostic.severity, 1);
    assert.equal(rows.at(-1).diagnostic.severity, 4);
});
