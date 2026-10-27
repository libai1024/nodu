// SPDX-License-Identifier: MIT
import type { TutorContext } from './tutor-context';
import type { TutorBuffer, TutorAnswer } from './tutor-ai-protocol';
import type { TutorLocalCheck } from './tutor-local-check';
import { isSafeCoursePath } from './tutor-course';

export interface TutorProjectContext { key: string; mcu: string; sdk: string; files: string[];
    arduino?: { profile: string; fqbn: string; coreVersion: string; libraries: { name: string; version: string; direct: boolean }[] };
    localCheck?: TutorLocalCheck;
    declarations?: { path: string; text: string }[];
    build?: { status: 'current' | 'stale' | 'none' | 'unavailable'; scope: 'saved-project'; bundle?: string; currentBufferSaved?: boolean;
        runtime?: { download: { bundle: string; method: string; completedAt: number; running: boolean | null; uid: string };
            serial?: { port: string; baud: number; observedAt: number; text: string; association: 'user-selected-port' } };
    };
}
export interface TutorGoalStep { id: string; title: string; goal: string; path: string; }
export interface TutorGoalState {
    revision: number; status: 'none' | 'draft' | 'active' | 'paused' | 'cancelled' | 'complete';
    goal?: string; title?: string; target?: { mcu: string; sdk: string }; steps: TutorGoalStep[]; current: number;
    fragment?: { source: TutorBuffer; answer: TutorAnswer };
    feedback?: string;
    removed?: { step: TutorGoalStep; index: number };
    verdict?: 'ok' | 'needs-work' | 'context';
}
export interface TutorGoalRequest {
    id: string; workspaceId: string; revision: number;
    action: 'propose' | 'confirm' | 'pause' | 'resume' | 'cancel' | 'fragment' | 'check' | 'add' | 'remove' | 'undo-remove';
    stepId?: string;
    prompt?: string; buffer?: TutorBuffer; contexts?: TutorContext[]; placement?: 'suggest';
}
export type TutorGoalResult = { ok: true; state: TutorGoalState; presentation?: { source: TutorBuffer; answer: TutorAnswer } } | { ok: false; error: string; cancelled?: boolean };
export const emptyGoal = (): TutorGoalState => ({ revision: 0, status: 'none', steps: [], current: 0 });
export function parseGoalPlan(raw: string, files: readonly string[]): { title: string; steps: TutorGoalStep[] } {
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (!value || Object.keys(value).some(k => !['title','steps'].includes(k)) || !text(value.title, 120)
        || !Array.isArray(value.steps) || !value.steps.length || value.steps.length > 24) { throw new Error('教学计划格式无效'); }
    const steps = value.steps.map((step: Record<string, unknown>, index: number) => {
        if (!step || Object.keys(step).some(k => !['title','goal','path'].includes(k)) || !text(step.title, 120) || !text(step.goal, 1200)
            || typeof step.path !== 'string' || !isSafeCoursePath(step.path) || !files.includes(step.path)) { throw new Error('计划必须引用当前工程的代码文件'); }
        return { id: `step-${index + 1}`, title: step.title as string, goal: step.goal as string, path: step.path };
    });
    return { title: value.title, steps };
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && !value.includes('\0'); }
export function validateGoalState(value: unknown): TutorGoalState {
    const s = value as TutorGoalState;
    if (!s || !Number.isSafeInteger(s.revision) || s.revision < 0 || !['none','draft','active','paused','cancelled','complete'].includes(s.status)
        || !Array.isArray(s.steps) || s.steps.length > 24 || !Number.isInteger(s.current) || s.current < 0 || s.current > s.steps.length
        || new Set(s.steps.map(step => step?.id)).size !== s.steps.length
        || s.steps.some(step => !step || typeof step.id !== 'string' || !/^[\w-]{1,80}$/.test(step.id) || !text(step.title, 120) || !text(step.goal, 1200) || typeof step.path !== 'string' || !isSafeCoursePath(step.path))
        || (s.status !== 'none' && (!text(s.goal, 6000) || !text(s.title, 120) || !s.steps.length))) { throw new Error('教学记录损坏'); }
    if ((s.status === 'none' && (s.steps.length !== 0 || s.current !== 0 || s.fragment !== undefined))
        || (s.status === 'draft' && (s.current !== 0 || s.fragment !== undefined))
        || (['active', 'paused'].includes(s.status) && s.current >= s.steps.length)
        || (s.status === 'complete' && (s.current !== s.steps.length || s.fragment !== undefined))
        || (s.status === 'cancelled' && s.fragment !== undefined)) { throw new Error('教学步骤状态损坏'); }
    if (s.status !== 'none' && (!s.target || !text(s.target.mcu, 80) || !text(s.target.sdk, 80))) { throw new Error('教学目标记录损坏'); }
    if (s.verdict !== undefined && !['ok', 'needs-work', 'context'].includes(s.verdict)) { throw new Error('教学检查记录损坏'); }
    if (s.removed) {
        const r = s.removed, step = r.step;
        if (!Number.isInteger(r.index) || r.index < s.current || r.index > s.steps.length || !step
            || typeof step.id !== 'string' || !/^[\w-]{1,80}$/.test(step.id) || s.steps.some(s => s.id === step.id)
            || !text(step.title, 120) || !text(step.goal, 1200) || typeof step.path !== 'string' || !isSafeCoursePath(step.path)) { throw new Error('已删除步骤记录损坏'); }
    }
    if (s.feedback !== undefined && (typeof s.feedback !== 'string' || s.feedback.length > 12000)) { throw new Error('教学反馈记录损坏'); }
    if (s.fragment) {
        const { source, answer } = s.fragment, g = answer?.guidance;
        if (!source || typeof source.path !== 'string' || !isSafeCoursePath(source.path) || source.path !== s.steps[s.current]?.path || typeof source.text !== 'string' || source.text.length > 32000 || source.text.includes('\0')
            || !Number.isSafeInteger(source.version) || source.version < 1 || !Number.isInteger(source.line) || source.line < 1 || source.line > source.text.split('\n').length
            || !answer || typeof answer.text !== 'string' || answer.text.length > 12000 || !Array.isArray(answer.annotations) || answer.annotations.length > 8
            || answer.annotations.some(a => !a || !Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine
                || a.endLine > source.text.split('\n').length || typeof a.note !== 'string' || a.note.length > 600)
            || !g || g.anchorLine !== source.line || !Array.isArray(g.lines) || !g.lines.length || g.lines.length > 4 || !g.lines.some(line => typeof line === 'string' && line.trim())
            || g.lines.some(line => typeof line !== 'string' || line.length > 240 || /[\r\n\x00-\x08\x0b-\x1f]/.test(line))) { throw new Error('教学片段记录损坏'); }
    }
    return s;
}
