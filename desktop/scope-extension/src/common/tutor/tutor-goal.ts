// SPDX-License-Identifier: MIT
import type { TutorBuffer, TutorAnswer } from './tutor-ai-protocol';
import { isSafeCoursePath } from './tutor-course';

export interface TutorProjectContext { key: string; mcu: string; sdk: string; files: string[];
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
}
export interface TutorGoalRequest {
    id: string; workspaceId: string; revision: number;
    action: 'propose' | 'confirm' | 'pause' | 'resume' | 'cancel' | 'fragment' | 'check';
    prompt?: string; buffer?: TutorBuffer;
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
        || s.steps.some((step, n) => step.id !== `step-${n + 1}` || !text(step.title, 120) || !text(step.goal, 1200) || !isSafeCoursePath(step.path))
        || (s.status !== 'none' && (!text(s.goal, 6000) || !text(s.title, 120) || !s.steps.length))) { throw new Error('教学记录损坏'); }
    if (s.status !== 'none' && (!s.target || !text(s.target.mcu, 80) || !text(s.target.sdk, 80))) { throw new Error('教学目标记录损坏'); }
    if (s.feedback !== undefined && (typeof s.feedback !== 'string' || s.feedback.length > 12000)) { throw new Error('教学反馈记录损坏'); }
    if (s.fragment) {
        const { source, answer } = s.fragment, g = answer?.guidance;
        if (!source || !isSafeCoursePath(source.path) || typeof source.text !== 'string' || source.text.length > 32000 || source.text.includes('\0')
            || !Number.isSafeInteger(source.version) || source.version < 1 || !Number.isInteger(source.line) || source.line < 1 || source.line > source.text.split('\n').length
            || !answer || typeof answer.text !== 'string' || answer.text.length > 12000 || !Array.isArray(answer.annotations) || answer.annotations.length > 8
            || answer.annotations.some(a => !a || !Number.isInteger(a.startLine) || !Number.isInteger(a.endLine) || a.startLine < 1 || a.endLine < a.startLine
                || a.endLine > source.text.split('\n').length || typeof a.note !== 'string' || a.note.length > 600)
            || !g || g.anchorLine !== source.line || !Array.isArray(g.lines) || !g.lines.length || g.lines.length > 4 || !g.lines.some(line => typeof line === 'string' && line.trim())
            || g.lines.some(line => typeof line !== 'string' || line.length > 240 || /[\r\n\x00-\x08\x0b-\x1f]/.test(line))) { throw new Error('教学片段记录损坏'); }
    }
    return s;
}
