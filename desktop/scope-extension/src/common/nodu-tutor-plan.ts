// SPDX-License-Identifier: MIT
// Teaching plan model (docs/0.2/AI-TUTOR-DESIGN.md §3). T1 has no checker:
// contracts are shown to the student, and a step is completed by the
// student's own confirmation. Everything here is pure so node tests can run it.

export type TutorStepKind = 'decide' | 'implement' | 'test' | 'refactor';
export type TutorLayer = 'app' | 'driver' | 'bsp' | 'config';
export type HintLevel = 0 | 1 | 2 | 3;

/** L0 + L1 by default; L3 (reference) only on an explicit request. */
export const DEFAULT_HINT_LEVEL: HintLevel = 1;
export const REFERENCE_LEVEL: HintLevel = 3;
export const HINT_LEVEL_LABELS: readonly string[] = ['意图', 'API 与依据', '骨架', '参考实现'];
export const STEP_KIND_LABELS: Record<TutorStepKind, string> = { decide: '决定', implement: '实现', test: '测试', refactor: '改进' };
export const LAYER_LABELS: Record<TutorLayer, string> = { app: '应用层', driver: '驱动层', bsp: '板级', config: '配置' };
/** Passed implement/refactor steps after the last passed test that trigger a reminder. */
export const UNTESTED_REMINDER = 3;
/** Plan location inside a project; `.nodu/` is private runtime state and stays ignored. */
export const TUTOR_PLAN_PATH = '.nodu-tutor/plan.json';

const CHECK_TYPES = ['compiles', 'calls', 'checksReturn', 'noCallIn', 'hostTest', 'serialMatch', 'review', 'manual'] as const;
export type TutorCheckType = typeof CHECK_TYPES[number];
const STEP_ID = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_TEXT = 4000;

export interface TutorHints { intent: string; api: string; skeleton: string; reference: string; }
/** `file` is relative to the project root; the marker is always `TODO(<step id>)`. */
export interface TutorAnchor { file: string; }
/** T1 displays `text`; T2 adds structured fields per type for the checker. */
export interface TutorCheck { type: TutorCheckType; text: string; }
export interface TutorOption { id: string; label: string; available: boolean; note: string; }
/** Engineering practice card (§8), maintained with the course, cited by steps. */
export interface TutorRule { id: string; title: string; why: string; }

export interface TutorStep {
    id: string;
    kind: TutorStepKind;
    layer?: TutorLayer;
    title: string;
    goal: string;
    why: string;
    dependsOn: string[];
    anchor?: TutorAnchor;
    hints?: TutorHints;
    contract: TutorCheck[];
    options?: TutorOption[];
    /** Engineering practice cards this step introduces (§8). */
    rules: string[];
}

export interface TutorPlan {
    schema: 1;
    id: string;
    version: number;
    title: string;
    goal: string;
    board: string;
    sdk: string;
    source: 'course' | 'generated';
    rules: TutorRule[];
    steps: TutorStep[];
}

export interface TutorPlanResult { plan?: TutorPlan; errors: string[]; }

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Plans may write multi-line text as an array of lines for readability. */
function text(value: unknown, where: string, errors: string[], required = true): string {
    const joined = Array.isArray(value) && value.every(line => typeof line === 'string') ? value.join('\n') : value;
    if (typeof joined !== 'string' || (required && !joined.trim())) {
        if (required || joined !== undefined) { errors.push(`${where} 应为非空文本`); }
        return '';
    }
    if (joined.length > MAX_TEXT) { errors.push(`${where} 超过 ${MAX_TEXT} 字符`); }
    return joined;
}

/** Project-relative POSIX path only: the plan must not point outside the project. */
export function isSafeRelativePath(path: string): boolean {
    return !!path && !path.startsWith('/') && !/^[A-Za-z]:/.test(path) && !path.includes('\\') && !path.includes('\0')
        && path.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}

export function parseTutorPlan(source: string): TutorPlanResult {
    const errors: string[] = [];
    let raw: unknown;
    try { raw = JSON.parse(source); } catch (error) {
        return { errors: [`计划不是有效 JSON：${error instanceof Error ? error.message : String(error)}`] };
    }
    if (!isObject(raw)) { return { errors: ['计划顶层应为对象'] }; }
    if (raw.schema !== 1) { errors.push('schema 应为 1'); }
    const id = text(raw.id, 'id', errors);
    const title = text(raw.title, 'title', errors);
    const goal = text(raw.goal, 'goal', errors);
    const board = text(raw.board, 'board', errors);
    const sdk = text(raw.sdk, 'sdk', errors);
    const version = typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 0 ? raw.version : (errors.push('version 应为正整数'), 1);
    const source_ = raw.source === 'course' || raw.source === 'generated' ? raw.source : (errors.push('source 应为 course 或 generated'), 'course' as const);
    const rules: TutorRule[] = [];
    (Array.isArray(raw.rules) ? raw.rules : []).forEach((rule, index) => {
        const where = `rules[${index}]`;
        if (!isObject(rule) || typeof rule.id !== 'string' || !STEP_ID.test(rule.id)) { errors.push(`${where}.id 无效`); return; }
        if (rules.some(existing => existing.id === rule.id)) { errors.push(`${where}.id 重复：${rule.id}`); return; }
        rules.push({ id: rule.id, title: text(rule.title, `${where}.title`, errors), why: text(rule.why, `${where}.why`, errors) });
    });
    if (!Array.isArray(raw.steps) || !raw.steps.length) { errors.push('steps 应为非空数组'); return { errors }; }
    const seen = new Set<string>();
    const steps: TutorStep[] = [];
    raw.steps.forEach((entry, index) => {
        const where = `steps[${index}]`;
        if (!isObject(entry)) { errors.push(`${where} 应为对象`); return; }
        const step = parseStep(entry, where, seen, errors);
        if (step) { seen.add(step.id); steps.push(step); }
    });
    for (const step of steps) {
        for (const rule of step.rules) { if (!rules.some(card => card.id === rule)) { errors.push(`步骤 ${step.id} 引用了不存在的规则卡 ${rule}`); } }
    }
    return errors.length ? { errors } : { plan: { schema: 1, id, version, title, goal, board, sdk, source: source_, rules, steps }, errors };
}

function parseStep(entry: Json, where: string, earlier: Set<string>, errors: string[]): TutorStep | undefined {
    const id = typeof entry.id === 'string' && STEP_ID.test(entry.id) ? entry.id : '';
    if (!id) { errors.push(`${where}.id 应为字母开头的短标识`); return undefined; }
    if (earlier.has(id)) { errors.push(`${where}.id 重复：${id}`); return undefined; }
    const at = `步骤 ${id}`;
    const kind = typeof entry.kind === 'string' && entry.kind in STEP_KIND_LABELS ? entry.kind as TutorStepKind : undefined;
    if (!kind) { errors.push(`${at}.kind 无效`); return undefined; }
    const layer = entry.layer === undefined ? undefined : typeof entry.layer === 'string' && entry.layer in LAYER_LABELS ? entry.layer as TutorLayer : (errors.push(`${at}.layer 无效`), undefined);
    const dependsOn = Array.isArray(entry.dependsOn) ? entry.dependsOn.filter((dep): dep is string => typeof dep === 'string') : [];
    // Dependencies must point backwards, which also rules out cycles.
    for (const dep of dependsOn) { if (!earlier.has(dep)) { errors.push(`${at} 依赖的 ${dep} 不存在或不在它之前`); } }
    let anchor: TutorAnchor | undefined;
    if (entry.anchor !== undefined) {
        const file = isObject(entry.anchor) && typeof entry.anchor.file === 'string' ? entry.anchor.file : '';
        if (isSafeRelativePath(file)) { anchor = { file }; } else { errors.push(`${at}.anchor.file 应为工程内相对路径`); }
    }
    let hints: TutorHints | undefined;
    if (entry.hints !== undefined) {
        const h = isObject(entry.hints) ? entry.hints : {};
        hints = {
            intent: text(h.intent, `${at}.hints.intent`, errors),
            api: text(h.api, `${at}.hints.api`, errors),
            skeleton: text(h.skeleton, `${at}.hints.skeleton`, errors, kind !== 'test'),
            reference: text(h.reference, `${at}.hints.reference`, errors, kind !== 'test'),
        };
    }
    // Steps without an anchor (manual tests) still show their hints in the panel.
    if ((kind === 'implement' || kind === 'refactor') && (!anchor || !hints)) { errors.push(`${at} 需要 anchor 与 hints`); }
    const contract: TutorCheck[] = [];
    (Array.isArray(entry.contract) ? entry.contract : []).forEach((check, index) => {
        const type = isObject(check) && (CHECK_TYPES as readonly unknown[]).includes(check.type) ? check.type as TutorCheckType : undefined;
        if (!type || !isObject(check)) { errors.push(`${at}.contract[${index}].type 无效`); return; }
        contract.push({ type, text: text(check.text, `${at}.contract[${index}].text`, errors) });
    });
    if (kind !== 'decide' && !contract.length) { errors.push(`${at} 需要至少一个完成条件`); }
    let options: TutorOption[] | undefined;
    if (kind === 'decide') {
        options = (Array.isArray(entry.options) ? entry.options : []).filter(isObject).map((option, index) => ({
            id: text(option.id, `${at}.options[${index}].id`, errors),
            label: text(option.label, `${at}.options[${index}].label`, errors),
            available: option.available !== false,
            note: text(option.note, `${at}.options[${index}].note`, errors, false),
        }));
        if (!options.some(option => option.available)) { errors.push(`${at} 需要至少一个可选方案`); }
    }
    const rules = Array.isArray(entry.rules) ? entry.rules.filter((rule): rule is string => typeof rule === 'string') : [];
    return {
        id, kind, layer, dependsOn, anchor, hints, contract, options, rules,
        title: text(entry.title, `${at}.title`, errors),
        goal: text(entry.goal, `${at}.goal`, errors),
        why: text(entry.why, `${at}.why`, errors),
    };
}

export const markerFor = (stepId: string): string => `TODO(${stepId})`;

/** 1-based line numbers carrying this step's marker; `TODO(S1)` never matches `TODO(S10)`. */
export function findMarkerLines(lines: readonly string[], stepId: string): number[] {
    const marker = markerFor(stepId);
    const result: number[] = [];
    lines.forEach((line, index) => {
        const at = line.indexOf(marker);
        if (at >= 0 && (at === 0 || !/\w/.test(line[at - 1]))) { result.push(index + 1); }
    });
    return result;
}

const TOP_LEVEL_MARKER = /^(\/\*|\/\/)\s*TODO\([A-Za-z][\w-]*\)/;

/**
 * Last line of the region where the student writes this step's code: up to
 * the next top-level (column 1) step marker, or the end of the file. A step
 * may span several functions, so closing braces do not end the region.
 */
export function hintRegionEnd(lines: readonly string[], markerLine: number): number {
    for (let line = markerLine + 1; line <= lines.length; line++) {
        if (TOP_LEVEL_MARKER.test(lines[line - 1])) { return line - 1; }
    }
    return lines.length;
}

/**
 * Text the student has written for this step. The hint collapses once this
 * differs from the text seen when the hint appeared, which also works for the
 * last marker in a file, whose region runs into existing code such as main().
 */
export function regionText(lines: readonly string[], markerLine: number): string {
    return lines.slice(markerLine, hintRegionEnd(lines, markerLine)).map(line => line.trimEnd()).join('\n').trim();
}

export interface HintSection { level: HintLevel; label: string; text: string; }

/** Sections shown at `level`; levels the step does not author are skipped. */
export function hintSections(step: TutorStep, level: HintLevel): HintSection[] {
    if (!step.hints) { return []; }
    const fields: (keyof TutorHints)[] = ['intent', 'api', 'skeleton', 'reference'];
    return fields.slice(0, level + 1).map((field, index) => ({ level: index as HintLevel, label: HINT_LEVEL_LABELS[index], text: step.hints![field] }))
        .filter(section => !!section.text);
}

/** Highest level this step actually authors (test steps may stop at L1). */
export function maxHintLevel(step: TutorStep): HintLevel {
    if (!step.hints) { return 0; }
    return step.hints.reference ? 3 : step.hints.skeleton ? 2 : 1;
}

export type StepStatus = 'locked' | 'available' | 'passed';
export interface StepState { step: TutorStep; status: StepStatus; /** An upstream test step has not passed. */ unverified: boolean; }

/**
 * Non-test dependencies gate a step; unpassed test dependencies only mark it
 * 上游未验证, so a skipped test never blocks the student from writing on.
 */
export function stepStates(plan: TutorPlan, done: ReadonlySet<string>): StepState[] {
    const byId = new Map(plan.steps.map(step => [step.id, step]));
    const unverified = new Map<string, boolean>();
    return plan.steps.map(step => {
        const deps = step.dependsOn.map(id => byId.get(id)!).filter(Boolean);
        const locked = deps.some(dep => dep.kind !== 'test' && !done.has(dep.id));
        const flag = deps.some(dep => (dep.kind === 'test' && !done.has(dep.id)) || unverified.get(dep.id));
        unverified.set(step.id, flag);
        return { step, status: done.has(step.id) ? 'passed' : locked ? 'locked' : 'available', unverified: flag };
    });
}

/** First available step that is not passed, in plan order. */
export function nextStepId(states: readonly StepState[]): string | undefined {
    return states.find(state => state.status === 'available')?.step.id;
}

/** Implement/refactor steps completed (in completion order) since the last completed test. */
export function untestedStreak(plan: TutorPlan, completionOrder: readonly string[]): number {
    const kinds = new Map(plan.steps.map(step => [step.id, step.kind]));
    let streak = 0;
    for (const id of completionOrder) {
        const kind = kinds.get(id);
        if (kind === 'test') { streak = 0; } else if (kind === 'implement' || kind === 'refactor') { streak++; }
    }
    return streak;
}

export interface TestReminder { stepId: string; text: string; }

/**
 * Reminders shown in the step panel (§7): a finished layer with an open test,
 * or several implementation steps in a row without any test. A test is only
 * suggested once its own non-test prerequisites are done.
 */
export function testReminders(plan: TutorPlan, completionOrder: readonly string[]): TestReminder[] {
    const done = new Set(completionOrder);
    const states = new Map(stepStates(plan, done).map(state => [state.step.id, state]));
    const openTests = plan.steps.filter(step => step.kind === 'test' && states.get(step.id)?.status === 'available');
    const reminders: TestReminder[] = [];
    const add = (step: TutorStep, text: string): void => {
        if (!reminders.some(reminder => reminder.stepId === step.id)) { reminders.push({ stepId: step.id, text }); }
    };
    const kinds = new Map(plan.steps.map(step => [step.id, step.kind]));
    const last = [...completionOrder].reverse().find(id => kinds.get(id) === 'implement' || kinds.get(id) === 'refactor');
    const direct = last ? openTests.find(step => step.dependsOn.includes(last)) : undefined;
    if (last && direct) { add(direct, `${last} 写完了，先用 ${direct.id}「${direct.title}」验证`); }
    for (const layer of Object.keys(LAYER_LABELS) as TutorLayer[]) {
        const members = plan.steps.filter(step => step.layer === layer && step.kind === 'implement');
        if (!members.length || !members.every(step => done.has(step.id))) { continue; }
        const test = openTests.find(step => step.dependsOn.some(id => members.some(member => member.id === id)));
        if (test) { add(test, `${LAYER_LABELS[layer]}已经写完，先做 ${test.id}「${test.title}」再往下`); }
    }
    const streak = untestedStreak(plan, completionOrder);
    if (streak >= UNTESTED_REMINDER && openTests.length) {
        add(openTests[0], `已连续完成 ${streak} 个步骤还没有测试，建议先做 ${openTests[0].id}「${openTests[0].title}」`);
    }
    return reminders;
}
