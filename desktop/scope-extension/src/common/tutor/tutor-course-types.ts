// SPDX-License-Identifier: MIT
import type { HintLevel, TutorCheckType, TutorHints, TutorLayer, TutorOption, TutorRule, TutorStepKind } from '../nodu-tutor-plan';

export interface TutorCourseTarget {
    mcu: string;
    sdkId: string;
    sdkDigest: string;
    template?: { id: string; revision: string; digest: string };
    wiringProfileId?: string;
    wiringDigest?: string;
}

interface RequirementBase { id: string; text: string; severity: 'required' | 'advisory'; }
export type TutorRequirement = RequirementBase & (
    | { type: 'manual'; legacyType?: TutorCheckType }
    | { type: 'compiles' }
    | { type: 'calls' | 'checksReturn'; anchorId: string; callee: string }
    | { type: 'noCallIn'; anchorId: string; callees: string[] }
    | { type: 'hostTest'; suiteId: string; suiteDigest: string }
    | { type: 'serialMatch'; captureProfileId: string; matcher: { kind: 'literal'; value: string } }
    | { type: 'review'; rubricId: string; rubricDigest: string }
);

export interface TutorCourseAnchor { id: string; path: string; symbol?: string; scope?: string; marker?: string; }
export interface TutorGuidanceFragment {
    id: string;
    anchorId: string;
    lines: string[];
    context: string;
    requiredSymbols: string[];
    citationIds: string[];
}
export interface TutorCourseStep {
    id: string;
    kind: TutorStepKind;
    title: string;
    goal: string;
    why: string;
    layer?: TutorLayer;
    dependsOn: { stepId: string; mode: 'required' | 'advisory' }[];
    anchors: TutorCourseAnchor[];
    requirements: TutorRequirement[];
    hints?: TutorHints;
    options?: TutorOption[];
    rules: string[];
    guidance?: TutorGuidanceFragment[];
}
export interface TutorDecisionRecord { stepId: string; optionId: string; }
export interface TutorCourseV2 {
    schema: 2;
    id: string;
    revision: number;
    contentHash: string;
    title: string;
    goal: string;
    target: TutorCourseTarget;
    source: 'course' | 'generated';
    course?: { id: string; version: string; digest: string };
    decisions: TutorDecisionRecord[];
    rules: TutorRule[];
    steps: TutorCourseStep[];
    legacy?: { schema: 1; board: string; sdk: string; version: number };
}
export type TutorCourseDraft = Omit<TutorCourseV2, 'contentHash'>;
export interface TutorCourseResult { course?: TutorCourseV2; errors: string[]; }
export interface TutorMigrationResult { draft?: TutorCourseDraft; errors: string[]; }
export type TutorValidationState = 'unchecked' | 'checking' | 'verified' | 'needs-work' | 'unknown' | 'stale' | 'self-checked';
export interface TutorLearningProgress {
    schema: 2;
    steps: Record<string, { status: 'self-checked' }>;
    completionOrder: string[];
    current?: string;
    levels: Record<string, HintLevel>;
    references: string[];
    decisions: Record<string, string>;
    log: { at: number; step: string; event: string }[];
}
