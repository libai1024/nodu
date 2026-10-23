// SPDX-License-Identifier: MIT
import { parseTutorPlan, TutorPlan } from '../nodu-tutor-plan';
import { CourseJsonSchema, TUTOR_COURSE_SCHEMA, TUTOR_LEGACY_COURSE_SCHEMA, TUTOR_TARGET_SCHEMA } from './tutor-course-schema';
import {
    TutorCourseDraft, TutorCourseResult, TutorCourseTarget, TutorCourseV2, TutorLearningProgress, TutorMigrationResult,
} from './tutor-course-types';
export * from './tutor-course-types';
export { TUTOR_COURSE_SCHEMA } from './tutor-course-schema';

export const COURSE_LIMIT_BYTES = 512 * 1024;
const ERROR_LIMIT = 20;
const has = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function readJson(raw: unknown, omitUndefinedProperties = false): { value?: unknown; errors: string[] } {
    try {
        if (typeof raw === 'string') {
            if (new TextEncoder().encode(raw).length > COURSE_LIMIT_BYTES) { return { errors: ['课程超过大小限制'] }; }
            raw = JSON.parse(raw);
        }
        let count = 0;
        const active = new Set<object>();
        const visit = (value: unknown, depth: number): void => {
            if (++count > 50000 || depth > 32) { throw new Error('课程结构超过限制'); }
            if (typeof value === 'number' && !Number.isFinite(value)) { throw new Error('课程包含无效数字'); }
            if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) { return; }
            if (!Array.isArray(value) && !record(value)) { throw new Error('课程应为 JSON 数据'); }
            if (active.has(value as object)) { throw new Error('课程包含循环对象'); }
            active.add(value as object);
            for (const item of Object.values(value as object)) {
                if (omitUndefinedProperties && !Array.isArray(value) && item === undefined) { continue; }
                visit(item, depth + 1);
            }
            active.delete(value as object);
        };
        visit(raw, 0);
        const encoded = JSON.stringify(raw);
        if (new TextEncoder().encode(encoded).length > COURSE_LIMIT_BYTES) { return { errors: ['课程超过大小限制'] }; }
        return { value: JSON.parse(encoded), errors: [] };
    } catch (error) {
        return { errors: [error instanceof Error ? error.message : '课程不是有效 JSON'] };
    }
}

/** Executes only the draft-07 keywords used by the exported course schema. */
function validate(schema: CourseJsonSchema, value: unknown, at: string, errors: string[]): void {
    const fail = (message: string): void => { if (errors.length < ERROR_LIMIT) { errors.push(`${at} ${message}`); } };
    if (errors.length >= ERROR_LIMIT) { return; }
    if (schema.oneOf) {
        const matches = schema.oneOf.filter(branch => { const failures: string[] = []; validate(branch, value, at, failures); return !failures.length; });
        if (matches.length !== 1) { fail('不匹配支持的条件类型'); }
        return;
    }
    if (has(schema, 'const') && value !== schema.const) { fail(`应为 ${schema.const}`); }
    if (schema.enum && !schema.enum.includes(value as string)) { fail('取值无效'); }
    if (schema.type === 'object') {
        if (!record(value)) { fail('应为对象'); return; }
        const props = schema.properties ?? {};
        for (const key of schema.required ?? []) { if (!has(value, key)) { fail(`缺少 ${key}`); } }
        for (const key of Object.keys(value)) {
            if (!has(props, key)) { if (schema.additionalProperties === false) { fail(`包含未知字段 ${key}`); } }
            else { validate(props[key], value[key], `${at}.${key}`, errors); }
        }
    } else if (schema.type === 'array') {
        if (!Array.isArray(value)) { fail('应为数组'); return; }
        if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) { fail('条目数量超出限制'); return; }
        if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) { fail('包含重复项'); }
        if (schema.items) { value.forEach((item, index) => validate(schema.items!, item, `${at}[${index}]`, errors)); }
    } else if (schema.type === 'string') {
        if (typeof value !== 'string') { fail('应为文本'); return; }
        const length = Array.from(value).length;
        if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) { fail('文本长度超出限制'); }
        if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) { fail('格式无效'); }
    } else if (schema.type === 'integer') {
        if (typeof value !== 'number' || !Number.isInteger(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) { fail('应为范围内整数'); }
    } else if (schema.type === 'boolean' && typeof value !== 'boolean') { fail('应为布尔值'); }
}

export function isSafeCoursePath(path: string): boolean {
    return !!path && path.length <= 240 && !path.startsWith('/') && !/[\\:\x00-\x1f\x7f]/.test(path)
        && !/%[a-f\d]{2}/i.test(path) && path.split('/').every(part => !!part && part !== '.' && part !== '..'
            && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

/** Validates structure and references. The Node repository verifies the content digest. */
export function parseCourse(raw: unknown): TutorCourseResult {
    const parsed = readJson(raw);
    if (parsed.errors.length) { return { errors: parsed.errors }; }
    const errors: string[] = [];
    validate(TUTOR_COURSE_SCHEMA, parsed.value, 'course', errors);
    if (errors.length) { return { errors }; }
    const course = parsed.value as TutorCourseV2;
    const fail = (message: string): void => { if (errors.length < ERROR_LIMIT) { errors.push(message); } };
    const unique = (items: { id: string }[], name: string): void => {
        if (new Set(items.map(item => item.id)).size !== items.length) { fail(`${name} id 重复`); }
    };
    unique(course.steps, 'steps'); unique(course.rules, 'rules');
    const steps = new Map(course.steps.map(step => [step.id, step]));
    const rules = new Set(course.rules.map(rule => rule.id));
    for (const step of course.steps) {
        unique(step.anchors, `${step.id}.anchors`); unique(step.requirements, `${step.id}.requirements`);
        unique(step.options ?? [], `${step.id}.options`); unique(step.guidance ?? [], `${step.id}.guidance`);
        if (new Set(step.dependsOn.map(dep => dep.stepId)).size !== step.dependsOn.length) { fail(`${step.id} 依赖重复`); }
        for (const dep of step.dependsOn) { if (!steps.has(dep.stepId)) { fail(`${step.id} 引用了不存在的步骤 ${dep.stepId}`); } }
        for (const id of step.rules) { if (!rules.has(id)) { fail(`${step.id} 引用了不存在的规则 ${id}`); } }
        const anchors = new Set(step.anchors.map(anchor => anchor.id));
        for (const anchor of step.anchors) { if (!isSafeCoursePath(anchor.path)) { fail(`${step.id} 包含不安全的相对路径`); } }
        for (const requirement of step.requirements) {
            if ('anchorId' in requirement && !anchors.has(requirement.anchorId)) { fail(`${step.id} 条件引用了不存在的锚点`); }
        }
        for (const fragment of step.guidance ?? []) {
            if (!anchors.has(fragment.anchorId)) { fail(`${step.id} 跟写引用了不存在的锚点`); }
            if (!fragment.lines.some(line => line.trim())) { fail(`${step.id} 跟写代码不能为空`); }
        }
        if (step.kind === 'decide' && !step.options?.some(option => option.available)) { fail(`${step.id} 需要可选方案`); }
        if (step.kind !== 'decide' && step.options) { fail(`${step.id} 非决定步骤不能包含 options`); }
        if (step.kind !== 'decide' && !step.requirements.length) { fail(`${step.id} 需要完成条件`); }
    }
    const visiting = new Set<string>(); const visited = new Set<string>();
    const visit = (id: string): void => {
        if (visiting.has(id)) { fail(`步骤依赖包含循环 ${id}`); return; }
        if (visited.has(id) || !steps.has(id)) { return; }
        visiting.add(id);
        for (const dep of steps.get(id)!.dependsOn) { visit(dep.stepId); }
        visiting.delete(id); visited.add(id);
    };
    for (const id of steps.keys()) { visit(id); }
    const decided = new Set<string>();
    for (const decision of course.decisions) {
        if (decided.has(decision.stepId)) { fail(`决定 ${decision.stepId} 重复`); }
        decided.add(decision.stepId);
        const step = steps.get(decision.stepId);
        if (step?.kind !== 'decide' || !step.options?.some(option => option.id === decision.optionId && option.available)) { fail(`决定 ${decision.stepId} 引用无效方案`); }
    }
    if (!!course.target.wiringProfileId !== !!course.target.wiringDigest) { fail('接线配置必须同时包含 id 与摘要'); }
    return errors.length ? { errors } : { course, errors };
}

/** Sorts object keys, preserves array order, and omits only the root contentHash. */
export function canonicalCourseContent(course: TutorCourseV2 | TutorCourseDraft): string {
    const parsed = readJson(course);
    if (parsed.errors.length) { throw new Error(parsed.errors[0]); }
    if (!record(parsed.value)) { throw new Error('课程应为对象'); }
    const sort = (value: unknown): unknown => Array.isArray(value) ? value.map(sort) : record(value)
        ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])])) : value;
    const copy = parsed.value;
    delete copy.contentHash;
    return JSON.stringify(sort(copy));
}

export function migrateLegacyCourse(raw: unknown, target: TutorCourseTarget): TutorMigrationResult {
    const parsed = readJson(raw, true); if (parsed.errors.length) { return { errors: parsed.errors }; }
    const targetData = readJson(target); if (targetData.errors.length) { return { errors: targetData.errors }; }
    const errors: string[] = [];
    validate(TUTOR_TARGET_SCHEMA, targetData.value, 'target', errors);
    validate(TUTOR_LEGACY_COURSE_SCHEMA, parsed.value, 'legacy', errors);
    if (errors.length) { return { errors }; }
    const legacySteps = (parsed.value as { steps: { kind: string; options?: unknown }[] }).steps;
    if (legacySteps.some(step => step.kind !== 'decide' && step.options !== undefined)) { return { errors: ['旧课程的非决定步骤不能包含 options'] }; }
    const legacy = parseTutorPlan(JSON.stringify(parsed.value));
    if (!legacy.plan) { return { errors: legacy.errors }; }
    const plan: TutorPlan = legacy.plan;
    const kinds = new Map(plan.steps.map(step => [step.id, step.kind]));
    const draft: TutorCourseDraft = {
        schema: 2, id: plan.id, revision: plan.version, title: plan.title, goal: plan.goal,
        target: targetData.value as TutorCourseTarget, source: plan.source, decisions: [], rules: plan.rules,
        legacy: { schema: 1, board: plan.board, sdk: plan.sdk, version: plan.version },
        steps: plan.steps.map(step => ({
            id: step.id, kind: step.kind, title: step.title, goal: step.goal, why: step.why,
            ...(step.layer ? { layer: step.layer } : {}),
            dependsOn: step.dependsOn.map(stepId => ({ stepId, mode: kinds.get(stepId) === 'test' ? 'advisory' as const : 'required' as const })),
            anchors: step.anchor ? [{ id: 'legacy', path: step.anchor.file, marker: `TODO(${step.id})` }] : [],
            requirements: step.contract.map((check, index) => ({ id: `check-${index + 1}`, type: 'manual' as const, text: check.text, severity: 'required' as const, legacyType: check.type })),
            ...(step.hints ? { hints: step.hints } : {}), ...(step.options ? { options: step.options } : {}), rules: step.rules,
        })),
    };
    const validated = parseCourse({ ...draft, contentHash: '0'.repeat(64) });
    return validated.errors.length ? { errors: validated.errors } : { draft, errors: [] };
}

export function migrateLegacyProgress(raw: unknown, course: TutorCourseV2 | TutorCourseDraft): TutorLearningProgress {
    const progress: TutorLearningProgress = { schema: 2, steps: {}, completionOrder: [], levels: {}, references: [], decisions: {}, log: [] };
    const parsed = readJson(raw); const value = parsed.value;
    if (parsed.errors.length || !record(value)) { return progress; }
    const ids = new Set(course.steps.map(step => step.id));
    const keepIds = (items: unknown): string[] => Array.isArray(items) ? [...new Set(items.filter((id): id is string => typeof id === 'string' && ids.has(id)))] : [];
    progress.completionOrder = keepIds(value.completed);
    progress.steps = Object.fromEntries(progress.completionOrder.map(id => [id, { status: 'self-checked' as const }]));
    if (typeof value.current === 'string' && ids.has(value.current)) { progress.current = value.current; }
    if (record(value.levels)) {
        progress.levels = Object.fromEntries(Object.entries(value.levels).filter(([id, level]) => ids.has(id) && [0, 1, 2, 3].includes(level as number))) as TutorLearningProgress['levels'];
    }
    progress.references = keepIds(value.references);
    if (record(value.decisions)) {
        progress.decisions = Object.fromEntries(Object.entries(value.decisions).filter((entry): entry is [string, string] => {
            const [id, optionId] = entry;
            return typeof optionId === 'string' && course.steps.some(step => step.id === id
                && step.kind === 'decide' && step.options?.some(option => option.id === optionId && option.available));
        }));
    }
    if (Array.isArray(value.log)) {
        progress.log = value.log.filter((item): item is TutorLearningProgress['log'][number] => record(item) && typeof item.at === 'number'
            && Number.isSafeInteger(item.at) && item.at >= 0 && typeof item.step === 'string' && (item.step === '' || ids.has(item.step))
            && typeof item.event === 'string' && item.event.length <= 256).slice(-500).map(({ at, step, event }) => ({ at, step, event }));
    }
    return progress;
}
