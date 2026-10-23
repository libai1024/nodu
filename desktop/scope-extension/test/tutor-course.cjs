// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createHash } = require('node:crypto');
const Ajv = require('ajv');
const {
    parseCourse, migrateLegacyCourse, migrateLegacyProgress, canonicalCourseContent,
    isSafeCoursePath, COURSE_LIMIT_BYTES, TUTOR_COURSE_SCHEMA,
} = require('../lib/common/tutor/tutor-course');
const { parseTutorPlan } = require('../lib/common/nodu-tutor-plan');

const HASH = 'a'.repeat(64);
const target = () => ({ mcu: 'STM32F407ZGT6', sdkId: 'STM32CubeF4', sdkDigest: HASH });
const step = (id = 'A', extra = {}) => ({
    id, kind: 'implement', title: id, goal: '写入程序', why: '练习', dependsOn: [],
    anchors: [{ id: 'main', path: 'src/main.c', symbol: 'main' }],
    requirements: [{ id: 'manual', type: 'manual', text: '自查完成', severity: 'required' }], rules: [], ...extra,
});
const course = (extra = {}) => ({
    schema: 2, id: 'sht30', revision: 1, contentHash: HASH, title: '温湿度', goal: '读取传感器',
    target: target(), source: 'course', decisions: [], rules: [], steps: [step()], ...extra,
});
const clone = value => JSON.parse(JSON.stringify(value));
const reject = raw => {
    const result = parseCourse(raw);
    assert.equal(result.course, undefined, 'invalid course was accepted');
    assert.ok(result.errors.length, 'missing validation error');
    return result.errors.join('\n');
};
const accept = raw => {
    const result = parseCourse(raw);
    assert.deepEqual(result.errors, []);
    assert.ok(result.course);
    return result.course;
};
const legacyText = () => readFileSync(join(__dirname, '../../examples/stm32-sht30-tutor/.nodu-tutor/plan.json'), 'utf8');
const legacy = () => JSON.parse(legacyText());
const migrate = raw => {
    const result = migrateLegacyCourse(raw, target());
    assert.deepEqual(result.errors, []);
    assert.ok(result.draft);
    return result.draft;
};
const seal = draft => ({ ...draft, contentHash: createHash('sha256').update(canonicalCourseContent(draft)).digest('hex') });

test('schema 2 parses object and text without retaining input references', () => {
    const input = course();
    const result = accept(input);
    assert.deepEqual(accept(JSON.stringify(input)), input);
    assert.notEqual(result, input);
    result.steps[0].anchors[0].path = 'other.c';
    assert.equal(input.steps[0].anchors[0].path, 'src/main.c');
    assert.equal(accept(course({ contentHash: '0'.repeat(64) })).contentHash, '0'.repeat(64), 'hash truth belongs to the Node repository');
});

test('runtime and independent draft-07 validator agree on structural cases', () => {
    const structural = new Ajv({ allErrors: true }).compile(TUTOR_COURSE_SCHEMA);
    const fixtures = [
        [course(), true], [course({ schema: 1 }), false], [course({ revision: 0 }), false],
        [course({ revision: 1.5 }), false], [course({ revision: Number.MAX_SAFE_INTEGER + 1 }), false],
        [course({ contentHash: 'ABC' }), false], [course({ rogue: true }), false],
        [course({ title: ' \t ' }), false],
        [course({ title: '😀'.repeat(256) }), true], [course({ title: '😀'.repeat(257) }), false],
        [course({ steps: [step('A', { unexpected: 'x' })] }), false],
        [course({ target: { ...target(), board: 'some-board' } }), false],
        [course({ steps: [step('A', { requirements: [{ id: 'c', type: 'compiles', severity: 'required', text: 'build', command: 'rm -rf /' }] })] }), false],
    ];
    for (const [input, expected] of fixtures) {
        assert.equal(structural(input), expected, JSON.stringify(structural.errors));
        assert.equal(!!parseCourse(input).course, expected, JSON.stringify(input));
    }
});

test('rejects unknown keys at every structured boundary', () => {
    const mutations = [
        input => { input.target.template = { id: 'dacir', revision: '1', digest: HASH, extra: true }; },
        input => { input.steps[0].anchors[0].extra = true; },
        input => { input.steps[0].dependsOn = [{ stepId: 'A', mode: 'required', extra: true }]; },
        input => { input.steps[0].requirements[0].extra = true; },
        input => { input.steps[0].hints = { intent: 'i', api: 'a', skeleton: 's', reference: 'r', extra: true }; },
        input => { input.course = { id: 'sht30', version: '1', digest: HASH, extra: true }; },
        input => { input.legacy = { schema: 1, board: 'legacy', sdk: 'old', version: 1, extra: true }; },
    ];
    for (const change of mutations) { const input = course(); change(input); reject(input); }
    reject(JSON.parse(JSON.stringify(course()).replace('"schema":2', '"__proto__":{"pwn":true},"schema":2')));
    assert.equal({}.pwn, undefined);
});

test('accepts forward DAG dependencies and rejects unknown, duplicate and cyclic dependencies', () => {
    accept(course({ steps: [step('A', { dependsOn: [{ stepId: 'B', mode: 'required' }] }), step('B')] }));
    accept(course({ steps: [step('A', { dependsOn: [{ stepId: 'B', mode: 'advisory' }] }), step('B')] }));
    assert.match(reject(course({ steps: [step('A', { dependsOn: [{ stepId: 'missing', mode: 'required' }] })] })), /不存在/);
    assert.match(reject(course({ steps: [step('A', { dependsOn: [{ stepId: 'A', mode: 'required' }] })] })), /循环/);
    for (const mode of ['required', 'advisory']) {
        assert.match(reject(course({ steps: [
            step('A', { dependsOn: [{ stepId: 'B', mode }] }), step('B', { dependsOn: [{ stepId: 'A', mode }] }),
        ] })), /循环/);
    }
    assert.match(reject(course({ steps: [step('A', { dependsOn: [
        { stepId: 'B', mode: 'required' }, { stepId: 'B', mode: 'advisory' },
    ] }), step('B')] })), /重复/);
    reject(course({ steps: [step('A'), step('A')] }));
    reject(course({ steps: [step('A', { anchors: [{ id: 'main', path: 'a.c' }, { id: 'main', path: 'b.c' }] })] }));
    reject(course({ steps: [step('A', { requirements: [...step().requirements, ...step().requirements] })] }));
});

test('paths remain project relative on POSIX and Windows', () => {
    for (const path of ['src/main.c', '配置/main.c', '.nodu-tutor/plan.json', 'src/a_b-1.h']) {
        assert.equal(isSafeCoursePath(path), true, path);
        accept(course({ steps: [step('A', { anchors: [{ id: 'main', path }] })] }));
    }
    for (const path of ['', '/tmp/a.c', '//host/a.c', '../a.c', 'src/../../a.c', './main.c', 'src//a.c', 'src/',
        'C:/a.c', 'C:a.c', 'src\\a.c', 'src/a\0.c', 'src/a\n.c', 'src/a\x7f.c', 'src/.', 'src/..', 'src/a. /b.c',
        'src/a.c ', 'src/a.c.', 'src/%2e%2e/a.c', 'src/%252e/a.c', 'CON', 'src/con.h', 'AUX.c', 'lpt1', 'x'.repeat(241)]) {
        assert.equal(isSafeCoursePath(path), false, JSON.stringify(path));
        reject(course({ steps: [step('A', { anchors: [{ id: 'main', path }] })] }));
    }
});

test('typed requirements have explicit parameters and cannot carry commands or regex', () => {
    const variants = [
        { type: 'manual', legacyType: 'compiles' }, { type: 'compiles' },
        { type: 'calls', anchorId: 'main', callee: 'HAL_Init' },
        { type: 'checksReturn', anchorId: 'main', callee: 'HAL_I2C_Mem_Read' },
        { type: 'noCallIn', anchorId: 'main', callees: ['HAL_Delay'] },
        { type: 'hostTest', suiteId: 'crc', suiteDigest: HASH },
        { type: 'serialMatch', captureProfileId: 'uart', matcher: { kind: 'literal', value: 'T=' } },
        { type: 'review', rubricId: 'layering', rubricDigest: HASH },
    ];
    for (const variant of variants) {
        const requirement = { id: 'check', text: '检查', severity: 'required', ...variant };
        accept(course({ steps: [step('A', { requirements: [requirement] })] }));
        reject(course({ steps: [step('A', { requirements: [{ ...requirement, command: 'tool' }] })] }));
    }
    for (const requirement of [
        { type: 'calls' }, { type: 'calls', anchorId: 'unknown', callee: 'main' },
        { type: 'calls', anchorId: 'main', callee: 'main();' }, { type: 'manual', legacyType: 'shell' },
        { type: 'serialMatch', captureProfileId: 'uart', matcher: { kind: 'regex', value: '.*' } },
        { type: 'hostTest', suiteId: '../test', suiteDigest: HASH }, { type: 'runShell', command: 'echo ok' },
    ]) { reject(course({ steps: [step('A', { requirements: [{ id: 'check', text: '检查', severity: 'required', ...requirement }] })] })); }
});

test('rule and decision references must resolve without duplicate ids', () => {
    const decision = step('D', { kind: 'decide', requirements: [], options: [
        { id: 'a', label: 'SHT30', available: true, note: '' }, { id: 'b', label: 'DHT11', available: false, note: '' },
    ] });
    const input = course({ steps: [decision], decisions: [{ stepId: 'D', optionId: 'a' }] });
    accept(input);
    reject({ ...input, decisions: [{ stepId: 'D', optionId: 'b' }] });
    reject({ ...input, decisions: [{ stepId: 'D', optionId: 'absent' }] });
    reject({ ...input, decisions: [input.decisions[0], input.decisions[0]] });
    reject(course({ decisions: [{ stepId: 'A', optionId: 'a' }] }));
    reject(course({ steps: [step('A', { options: decision.options })] }));
    reject(course({ steps: [step('A', { rules: ['missing'] })] }));
    const rule = { id: 'check-return', title: '返回值', why: '处理错误' };
    accept(course({ rules: [rule], steps: [step('A', { rules: [rule.id] })] }));
    reject(course({ rules: [rule, rule] }));
    reject(course({ steps: [step('D', { kind: 'decide', requirements: [], options: [{ id: 'a', label: 'A', available: false, note: '' }] })] }));
    reject(course({ steps: [step('A', { requirements: [] })] }));
});

test('guidance is explicit code, has a known anchor and bounded individual lines', () => {
    const fragment = { id: 'init', anchorId: 'main', lines: ['HAL_Init();', '', '    _sensor_init();'], context: 'main body', requiredSymbols: ['HAL_Init', '_sensor_init'], citationIds: ['hal-doc'] };
    accept(course({ steps: [step('A', { guidance: [fragment] })] }));
    for (const extra of [{ anchorId: 'missing' }, { lines: [] }, { lines: [' ', ''] }, { lines: ['x\ny'] }, { lines: ['x\ry'] },
        { lines: ['x'.repeat(2001)] }, { lines: Array(257).fill('x;') }, { html: '<span>code</span>' }, { context: '' }]) {
        reject(course({ steps: [step('A', { guidance: [{ ...fragment, ...extra }] })] }));
    }
    reject(course({ steps: [step('A', { guidance: [fragment, fragment] })] }));
});

test('target needs explicit chip and pinned digests; wiring id and digest are paired', () => {
    for (const extra of [{ mcu: '' }, { sdkDigest: '' }, { board: 'legacy' }, { wiringProfileId: 'wiring' }, { wiringDigest: HASH }]) {
        reject(course({ target: { ...target(), ...extra } }));
    }
    accept(course({ target: { ...target(), wiringProfileId: 'wiring', wiringDigest: HASH } }));
});

test('bounded inputs reject invalid JSON, non-JSON values and resource exhaustion', () => {
    for (const raw of ['{', null, 2, undefined, new Date(), new Map(), () => {}, course({ revision: NaN }), course({ revision: Infinity }), course({ title: undefined })]) { reject(raw); }
    reject(' '.repeat(COURSE_LIMIT_BYTES + 1));
    reject(course({ goal: '😀'.repeat(COURSE_LIMIT_BYTES / 4) }));
    reject(course({ steps: Array.from({ length: 257 }, (_, i) => step(`S${i}`)) }));
    const cyclic = course(); cyclic.loop = cyclic; assert.match(reject(cyclic), /循环/);
    let deep = {}; for (let i = 0; i < 40; i++) { deep = { deep }; } assert.match(reject(deep), /结构/);
    assert.match(reject(Array(50001).fill(0)), /结构/);
    assert.throws(() => canonicalCourseContent(cyclic), /循环/);
    assert.throws(() => canonicalCourseContent(null), /对象/);
    assert.ok(parseCourse(Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`invalid${i}`, true]))).errors.length <= 20);
});

test('canonical content ignores only its hash and is stable across object key order', () => {
    const input = course();
    const reversed = value => Array.isArray(value) ? value.map(reversed) : value && typeof value === 'object'
        ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reversed(value[key])])) : value;
    const before = clone(input);
    assert.equal(canonicalCourseContent(input), canonicalCourseContent(reversed({ ...input, contentHash: 'b'.repeat(64) })));
    assert.deepEqual(input, before);
    assert.equal(canonicalCourseContent(input).includes('contentHash'), false);
    assert.notEqual(canonicalCourseContent(input), canonicalCourseContent(course({ target: { ...target(), sdkDigest: 'b'.repeat(64) } })));
    assert.notEqual(canonicalCourseContent(course({ steps: [step('A'), step('B')] })), canonicalCourseContent(course({ steps: [step('B'), step('A')] })));
    assert.equal(seal(input).contentHash.length, 64);
});

test('bundled SHT30 migration preserves authored content and never infers executable checks or chip', () => {
    const source = legacy(); const before = clone(source);
    const normalized = parseTutorPlan(legacyText()).plan;
    assert.ok(normalized);
    const result = migrate(source);
    assert.equal(result.contentHash, undefined);
    assert.deepEqual(result, migrate(legacyText()));
    assert.deepEqual(result, migrate(normalized), 'supports legacy parsed models with undefined optional fields');
    assert.deepEqual(source, before);
    assert.deepEqual(result.target, target());
    assert.equal(result.legacy.board, source.board);
    assert.equal(result.legacy.sdk, source.sdk);
    assert.equal(result.board, undefined);
    assert.deepEqual(result.rules, normalized.rules);
    for (let i = 0; i < result.steps.length; i++) {
        const next = result.steps[i]; const old = normalized.steps[i];
        assert.equal(next.goal, old.goal); assert.equal(next.why, old.why); assert.equal(next.layer, old.layer);
        assert.deepEqual(next.hints, old.hints); assert.deepEqual(next.options, old.options); assert.deepEqual(next.rules, old.rules);
        assert.equal(next.guidance, undefined, 'hints cannot silently become ghost code');
        assert.deepEqual(next.requirements.map(check => check.text), old.contract.map(check => check.text));
        assert.deepEqual(next.requirements.map(check => check.legacyType), old.contract.map(check => check.type));
        assert.ok(next.requirements.every(check => check.type === 'manual'));
        assert.deepEqual(next.dependsOn, old.dependsOn.map(stepId => ({ stepId, mode: normalized.steps.find(s => s.id === stepId).kind === 'test' ? 'advisory' : 'required' })));
    }
    accept(seal(result));
    assert.equal(migrateLegacyCourse(source, undefined).draft, undefined);
    assert.equal(migrateLegacyCourse(source, { mcu: source.board }).draft, undefined);
    const explicit = { ...target(), mcu: 'STM32F103C8T6' };
    assert.deepEqual(migrateLegacyCourse(source, explicit).draft.target, explicit, 'target is caller supplied; legacy board must not override it');
});

test('migration rejects data that the old parser would silently discard', () => {
    const changes = [
        input => { input.extra = 'data'; }, input => { input.steps[0].extra = 'data'; },
        input => { input.rules = 'invalid'; }, input => { input.steps[0].dependsOn = [1]; },
        input => { input.steps[1].rules = [false]; }, input => { input.steps[0].options.push(1); },
        input => { input.steps[0].options[0].available = 'false'; }, input => { input.steps[0].options[0].command = 'run'; },
        input => { input.steps[1].hints.extra = 'data'; }, input => { input.steps[1].anchor.file = '../outside.c'; },
        input => { input.steps[1].contract[0].callee = 'guessed'; }, input => { input.steps[1].options = input.steps[0].options; },
        input => { input.steps[1].contract = [{ type: 'constructor', text: 'invalid' }]; },
    ];
    for (const change of changes) {
        const input = legacy(); change(input);
        const result = migrateLegacyCourse(input, target());
        assert.equal(result.draft, undefined); assert.ok(result.errors.length);
    }
});

test('all legacy step kinds remain self-checked, never verified or executable', () => {
    const draft = migrate(legacy());
    const kinds = new Set(draft.steps.map(s => s.kind));
    assert.deepEqual(kinds, new Set(['decide', 'implement', 'test', 'refactor']));
    const ids = draft.steps.map(s => s.id);
    const raw = {
        completed: [...ids, ids[0], 'missing'], current: ids[1], references: [ids[2], ids[2], 'missing'],
        levels: { [ids[0]]: 0, [ids[1]]: 3, [ids[2]]: 99, missing: 2 },
        decisions: { [ids[0]]: draft.steps[0].options.find(o => o.available).id, missing: 'a' },
        steps: Object.fromEntries(ids.map(id => [id, { status: 'verified' }])), verified: ids,
        log: [{ at: 10, step: ids[0], event: 'passed', extra: true }, { at: 11, step: '', event: 'session' }, { at: 12, step: 'missing', event: 'passed' }, { at: -1, step: ids[0], event: 'passed' }],
    };
    const before = clone(raw);
    const result = migrateLegacyProgress(raw, draft);
    assert.deepEqual(result.completionOrder, ids);
    assert.deepEqual(Object.keys(result.steps), ids);
    assert.ok(Object.values(result.steps).every(s => s.status === 'self-checked'));
    assert.equal(JSON.stringify(result).includes('verified'), false);
    assert.deepEqual(result.levels, { [ids[0]]: 0, [ids[1]]: 3 });
    assert.deepEqual(result.references, [ids[2]]);
    assert.deepEqual(result.decisions, { [ids[0]]: raw.decisions[ids[0]] });
    assert.deepEqual(result.log, [{ at: 10, step: ids[0], event: 'passed' }, { at: 11, step: '', event: 'session' }]);
    assert.deepEqual(raw, before);
    assert.deepEqual(result, migrateLegacyProgress(JSON.stringify(raw), draft));
    assert.deepEqual(migrateLegacyProgress({ steps: raw.steps, verified: ids }, draft).steps, {});
    assert.equal(migrateLegacyProgress({ current: 'missing' }, draft).current, undefined);
    assert.deepEqual(migrateLegacyProgress({ decisions: { [ids[0]]: draft.steps[0].options.find(o => !o.available).id } }, draft).decisions, {});
    assert.deepEqual(migrateLegacyProgress('{', draft).completionOrder, []);
    assert.equal(migrateLegacyProgress({ log: Array.from({ length: 510 }, (_, i) => ({ at: i, step: '', event: 'event' })) }, draft).log.length, 500);
});
