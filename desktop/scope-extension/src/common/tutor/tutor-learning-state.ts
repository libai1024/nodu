// SPDX-License-Identifier: MIT
import { TutorCourseV2, TutorLearningProgress, migrateLegacyProgress } from './tutor-course';

export type TutorLearningAction =
    | { type: 'select' | 'manualCheck' | 'reopen' | 'viewReference'; stepId: string }
    | { type: 'decide'; stepId: string; optionId: string }
    | { type: 'setHint'; stepId: string; level: 0 | 1 | 2 }
    | { type: 'reset' };

export function emptyLearningProgress(): TutorLearningProgress {
    return { schema: 2, steps: {}, completionOrder: [], levels: {}, references: [], decisions: {}, log: [] };
}
const owns = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => canonicalLearningJson(a) === canonicalLearningJson(b);

export function canonicalLearningJson(value: unknown): string {
    const sort = (input: unknown): unknown => Array.isArray(input) ? input.map(sort) : record(input)
        ? Object.fromEntries(Object.keys(input).sort().map(key => [key, sort(input[key])])) : input;
    return JSON.stringify(sort(value));
}

/** The wire format cannot grant a verified result or retain unknown course steps. */
export function validateLearningProgress(raw: unknown, course: TutorCourseV2): TutorLearningProgress {
    const encoded = JSON.stringify(raw);
    if (!encoded || new TextEncoder().encode(encoded).length > 256 * 1024) { throw new Error('学习记录过大'); }
    const value: unknown = JSON.parse(encoded);
    if (!record(value) || value.schema !== 2 || Object.keys(value).some(key => !['schema', 'steps', 'completionOrder', 'current', 'levels', 'references', 'decisions', 'log'].includes(key))) {
        throw new Error('学习记录格式无效');
    }
    if (!record(value.steps) || !Array.isArray(value.completionOrder) || !record(value.levels) || !Array.isArray(value.references)
        || !record(value.decisions) || !Array.isArray(value.log)) { throw new Error('学习记录格式无效'); }
    const normalized = migrateLegacyProgress({
        completed: value.completionOrder, ...(owns(value, 'current') ? { current: value.current } : {}), levels: value.levels,
        references: value.references, decisions: value.decisions, log: value.log,
    }, course);
    // migrateLegacyProgress drops malformed fields; require a lossless round trip here.
    if (!same(value, normalized)) { throw new Error('学习记录包含无效状态'); }
    return normalized;
}

export function applyLearningAction(course: TutorCourseV2, current: TutorLearningProgress, raw: unknown, now: number): TutorLearningProgress {
    if (!record(raw) || typeof raw.type !== 'string') { throw new Error('学习操作无效'); }
    const fields: Record<string, string[]> = {
        select: ['stepId'], manualCheck: ['stepId'], reopen: ['stepId'], viewReference: ['stepId'],
        decide: ['stepId', 'optionId'], setHint: ['stepId', 'level'], reset: [],
    };
    if (!owns(fields, raw.type) || Object.keys(raw).sort().join() !== ['type', ...fields[raw.type]].sort().join()) { throw new Error('学习操作无效'); }
    const action = raw as TutorLearningAction;
    const progress = validateLearningProgress(current, course);
    const done = (id: string): boolean => owns(progress.steps, id);
    const available = (id: string): boolean => !!course.steps.find(step => step.id === id)?.dependsOn.every(dep => dep.mode === 'advisory' || done(dep.stepId));
    let stepId = '';
    if (action.type === 'reset') {
        const empty = emptyLearningProgress();
        empty.log.push({ at: now, step: '', event: 'reset' });
        return empty;
    }
    const step = course.steps.find(item => item.id === action.stepId);
    if (!step) { throw new Error('找不到课程步骤'); }
    stepId = step.id;
    switch (action.type) {
        case 'select':
            if (!available(stepId)) { throw new Error('请先完成前置步骤'); }
            progress.current = stepId;
            break;
        case 'manualCheck':
        case 'decide':
            if (!available(stepId)) { throw new Error('请先完成前置步骤'); }
            if (action.type === 'decide') {
                if (step.kind !== 'decide' || !step.options?.some(option => option.id === action.optionId && option.available)) { throw new Error('课程选项无效'); }
                progress.decisions = { ...progress.decisions, [stepId]: action.optionId };
            } else if (step.kind === 'decide') { throw new Error('请先选择课程方案'); }
            progress.steps = { ...progress.steps, [stepId]: { status: 'self-checked' } };
            if (!progress.completionOrder.includes(stepId)) { progress.completionOrder.push(stepId); }
            progress.current = course.steps.find(item => !done(item.id) && available(item.id))?.id;
            if (progress.current === undefined) { delete progress.current; }
            break;
        case 'reopen': {
            const affected = new Set([stepId]);
            let changed = true;
            while (changed) {
                changed = false;
                for (const item of course.steps) {
                    if (!affected.has(item.id) && item.dependsOn.some(dep => dep.mode === 'required' && affected.has(dep.stepId))) {
                        affected.add(item.id); changed = true;
                    }
                }
            }
            progress.steps = Object.fromEntries(Object.entries(progress.steps).filter(([id]) => !affected.has(id)));
            progress.completionOrder = progress.completionOrder.filter(id => !affected.has(id));
            progress.current = stepId;
            break;
        }
        case 'setHint':
            if (![0, 1, 2].includes(action.level) || !step.hints) { throw new Error('提示级别无效'); }
            progress.levels = { ...progress.levels, [stepId]: action.level };
            break;
        case 'viewReference':
            if (!step.hints?.reference) { throw new Error('当前步骤没有参考代码'); }
            progress.levels = { ...progress.levels, [stepId]: 3 };
            if (!progress.references.includes(stepId)) { progress.references.push(stepId); }
            break;
    }
    progress.log.push({ at: now, step: stepId, event: action.type });
    progress.log = progress.log.slice(-500);
    return validateLearningProgress(progress, course);
}
