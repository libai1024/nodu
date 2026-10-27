// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { collectProblems, countProblems, formatProblem, formatProblems } = require('../lib/common/nodu-problems');

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

test('copied problems retain one-based locations, full multiline messages, sources and diagnostic codes', () => {
    const input = marker('clangd', 1, 7, 'unknown identifier\n建议检查定义');
    input.data.code = 0;
    const [problem] = collectProblems([input, { ...input, owner: 'build', data: { ...input.data, source: 'build' } }]);
    assert.equal(formatProblem(problem, '/项目/src/main.c'), '/项目/src/main.c:8:2 [错误] unknown identifier\n建议检查定义\n来源：build、clangd · 代码：0');
    assert.equal(problem.diagnostic.message, input.data.message);
});

test('copying all diagnostics preserves order and empty collections never produce filler text', () => {
    const rows = collectProblems([marker('clangd', 2, 2, 'warning'), marker('build', 1, 5, 'error')]);
    assert.equal(formatProblems(rows, () => 'main.c'), 'main.c:6:2 [错误] error\n来源：build\n\nmain.c:3:2 [警告] warning\n来源：clangd');
    assert.equal(formatProblems([]), '');
    const info = { ...rows[0], sources: [], diagnostic: { ...rows[0].diagnostic, severity: undefined, code: undefined } };
    assert.equal(formatProblem(info), 'file:///project/main.c:6:2 [提示] error');
});
