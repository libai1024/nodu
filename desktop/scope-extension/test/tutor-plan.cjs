// SPDX-License-Identifier: MIT
// Pure coverage for common/nodu-tutor-plan and the bundled SHT30 course
// (run after npm run compile).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const {
    parseTutorPlan, findMarkerLines, hintRegionEnd, regionText, hintSections, maxHintLevel,
    stepStates, nextStepId, untestedStreak, testReminders, isSafeRelativePath, TUTOR_PLAN_PATH,
} = require('../lib/common/nodu-tutor-plan');

const COURSE = join(__dirname, '..', '..', 'examples', 'stm32-sht30-tutor');
const coursePlan = () => {
    const result = parseTutorPlan(readFileSync(join(COURSE, TUTOR_PLAN_PATH), 'utf-8'));
    assert.deepEqual(result.errors, []);
    return result.plan;
};

const minimal = (steps, extra = {}) => JSON.stringify({
    schema: 1, id: 'p', version: 1, title: 't', goal: 'g', board: 'b', sdk: 's', source: 'course', rules: [], steps, ...extra,
});
const implement = (id, deps = [], extra = {}) => ({
    id, kind: 'implement', title: id, goal: 'g', why: 'w', dependsOn: deps, anchor: { file: 'a.c' },
    hints: { intent: 'i', api: 'a', skeleton: 's', reference: 'r' }, contract: [{ type: 'compiles', text: 'c' }], ...extra,
});
const testStep = (id, deps = []) => ({ id, kind: 'test', title: id, goal: 'g', why: 'w', dependsOn: deps, contract: [{ type: 'manual', text: 'c' }] });

test('bundled course parses and every anchor has exactly one marker in the starter project', () => {
    const plan = coursePlan();
    assert.equal(plan.steps[0].kind, 'decide');
    for (const step of plan.steps) {
        if (!step.anchor) { continue; }
        const lines = readFileSync(join(COURSE, step.anchor.file), 'utf-8').split('\n');
        assert.equal(findMarkerLines(lines, step.id).length, 1, `${step.id} in ${step.anchor.file}`);
        // Nothing is pre-written for the step: the marker is followed by a blank line or the end of
        // the file. (The last marker's region may run into existing code such as main().)
        const next = lines[findMarkerLines(lines, step.id)[0]];
        assert.ok(next === undefined || !next.trim(), `${step.id}: ${next}`);
    }
    // Only the decision is open at the start; nothing can be skipped to.
    const states = stepStates(plan, new Set());
    assert.equal(nextStepId(states), 'S0');
    assert.deepEqual(states.filter(state => state.status === 'available').map(state => state.step.id), ['S0']);
});

test('bundled course: every implement step authors the reference, and L3 only appears at level 3', () => {
    for (const step of coursePlan().steps.filter(step => step.kind === 'implement' || step.kind === 'refactor')) {
        assert.equal(maxHintLevel(step), 3, step.id);
        assert.deepEqual(hintSections(step, 1).map(section => section.level), [0, 1], step.id);
        assert.ok(!hintSections(step, 2).some(section => section.level === 3), step.id);
        assert.equal(hintSections(step, 3).at(-1).level, 3, step.id);
    }
});

test('rejects unsafe anchors, forward or unknown dependencies, duplicates and unknown rule cards', () => {
    for (const file of ['/etc/passwd', '../x.c', 'a/../../x.c', 'C:/x.c', 'a\\b.c', './a.c', '']) {
        assert.equal(isSafeRelativePath(file), false, file);
        assert.match(parseTutorPlan(minimal([implement('A', [], { anchor: { file } })])).errors.join(), /相对路径/, file);
    }
    assert.ok(isSafeRelativePath('app/app.c'));
    assert.match(parseTutorPlan(minimal([implement('A', ['B']), implement('B')])).errors.join(), /依赖的 B/);
    assert.match(parseTutorPlan(minimal([implement('A'), implement('A')])).errors.join(), /重复/);
    assert.match(parseTutorPlan(minimal([implement('A', [], { rules: ['nope'] })])).errors.join(), /规则卡 nope/);
    assert.match(parseTutorPlan(minimal([implement('A', [], { hints: undefined })])).errors.join(), /anchor 与 hints/);
    assert.match(parseTutorPlan(minimal([implement('A', [], { contract: [] })])).errors.join(), /完成条件/);
    assert.match(parseTutorPlan('{').errors.join(), /JSON/);
    assert.equal(parseTutorPlan(minimal([implement('A')], { schema: 2 })).plan, undefined);
});

test('decide steps need an available option', () => {
    const decide = options => ({ id: 'D', kind: 'decide', title: 't', goal: 'g', why: 'w', options });
    assert.match(parseTutorPlan(minimal([decide([{ id: 'x', label: 'X', available: false }])])).errors.join(), /可选方案/);
    assert.deepEqual(parseTutorPlan(minimal([decide([{ id: 'x', label: 'X' }])])).errors, []);
});

test('markers: S1 never matches S10, and duplicates are reported', () => {
    const lines = ['/* TODO(S10) a */', '', '/* TODO(S1) b */', 'x', '// TODO(S1) again', 'XTODO(S2)'];
    assert.deepEqual(findMarkerLines(lines, 'S10'), [1]);
    assert.deepEqual(findMarkerLines(lines, 'S1'), [3, 5]);
    assert.deepEqual(findMarkerLines(lines, 'S2'), []);
});

test('hint region runs to the next top-level marker; indented markers stay inside', () => {
    const lines = [
        '/* TODO(S1) a */', 'void f(void)', '{', '    /* TODO(S9) nested */', '}', '',
        '/* TODO(S2) b */', 'int x;',
    ];
    assert.equal(hintRegionEnd(lines, 1), 6);
    assert.equal(hintRegionEnd(lines, 7), 8);
    assert.equal(regionText(lines, 7), 'int x;');
    assert.equal(regionText(['/* TODO(S1) */', '   ', ''], 1), '');
});

test('test dependencies only flag 上游未验证; implementation dependencies lock', () => {
    const { plan } = parseTutorPlan(minimal([implement('A'), testStep('T', ['A']), implement('B', ['A', 'T']), implement('C', ['B'])]));
    let states = stepStates(plan, new Set(['A']));
    const byId = id => states.find(state => state.step.id === id);
    assert.equal(byId('B').status, 'available');
    assert.equal(byId('B').unverified, true);
    // The flag carries downstream until the test is done.
    assert.equal(byId('C').status, 'locked');
    states = stepStates(plan, new Set(['A', 'B']));
    assert.equal(byId('C').unverified, true);
    states = stepStates(plan, new Set(['A', 'T', 'B']));
    assert.equal(byId('C').unverified, false);
    assert.equal(nextStepId(states), 'C');
});

test('reminders: a step with a direct test, a finished layer, and an untested streak', () => {
    const plan = coursePlan();
    assert.deepEqual(testReminders(plan, ['S0', 'S1']), []);
    // S5 has its own test S6.
    assert.deepEqual(testReminders(plan, ['S0', 'S1', 'S5']).map(reminder => reminder.stepId), ['S6']);
    assert.equal(untestedStreak(plan, ['S0', 'S1', 'S2', 'S5', 'S8']), 4);
    assert.equal(untestedStreak(plan, ['S0', 'S1', 'S5', 'S6', 'S8']), 1);
    // S2 has no direct test and finishes no layer with a test, so only the streak fires.
    const streak = testReminders(plan, ['S0', 'S1', 'S5', 'S8', 'S2']);
    assert.deepEqual(streak.map(reminder => reminder.stepId), ['S6']);
    assert.match(streak[0].text, /连续完成 4 个步骤/);
    // One reminder per test: the finished config layer and the streak both point at S4 or S6, never twice.
    const many = testReminders(plan, ['S0', 'S1', 'S2', 'S3', 'S5']);
    assert.equal(new Set(many.map(reminder => reminder.stepId)).size, many.length);
    // Once tested, the reminder goes away.
    assert.ok(!testReminders(plan, ['S0', 'S1', 'S5', 'S6']).some(reminder => reminder.stepId === 'S6'));
});
