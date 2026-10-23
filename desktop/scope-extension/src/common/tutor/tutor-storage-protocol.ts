// SPDX-License-Identifier: MIT
import type { TutorPlan } from '../nodu-tutor-plan';
import type { TutorCourseTarget, TutorCourseV2, TutorLearningProgress } from './tutor-course';
import type { TutorLearningAction } from './tutor-learning-state';

export type StoredCourse =
    | { kind: 'legacy'; sourceDigest: string; plan: TutorPlan }
    | { kind: 'course'; sourceDigest: string; course: TutorCourseV2 };
export interface CourseMigrationPreview { id: string; sourceDigest: string; course: TutorCourseV2; }
export interface TutorProgressSnapshot {
    sequence: number; planHash: string; planRevision: number;
    progress: TutorLearningProgress; legacyImported: boolean;
}
export interface TutorProgressEvent extends TutorProgressSnapshot {
    schema: 1;
    kind: 'course' | 'action' | 'legacyImport' | 'recovered';
    requestId: string; fingerprint: string; previousHash: string; checksum: string;
}
export interface TutorProgressUpdate { snapshot: TutorProgressSnapshot; events?: TutorProgressEvent[] }
export interface TutorSessionSnapshot {
    sessionId: string;
    plan: StoredCourse | { kind: 'none' };
    learning?: TutorProgressUpdate;
}
export type TutorStorageOutcome<T> = { ok: true; value: T } | {
    ok: false; error: { code: 'invalidSchema' | 'outOfScope' | 'revisionConflict' | 'storageUnavailable' | 'sourceMissing'; message: string };
};
export interface TutorStorageClient { onDidChange(event: { sessionId: string; sequence: number }): void | Promise<void>; }

/** Only opaque handles issued by the host may cross this interface. */
export interface TutorStorageService {
    openSession(workspaceId: string): Promise<TutorStorageOutcome<TutorSessionSnapshot>>;
    getSnapshot(sessionId: string, afterSequence?: number): Promise<TutorStorageOutcome<TutorSessionSnapshot>>;
    closeSession(sessionId: string): Promise<TutorStorageOutcome<void>>;
    previewMigration(sessionId: string, target: TutorCourseTarget): Promise<TutorStorageOutcome<CourseMigrationPreview>>;
    acceptMigration(sessionId: string, previewId: string, sourceDigest: string): Promise<TutorStorageOutcome<TutorSessionSnapshot>>;
    recordAction(sessionId: string, expectedSequence: number, expectedHash: string, requestId: string, action: TutorLearningAction): Promise<TutorStorageOutcome<TutorProgressSnapshot>>;
    importLegacyProgress(sessionId: string, expectedSequence: number, expectedHash: string, requestId: string, progress: unknown): Promise<TutorStorageOutcome<TutorProgressSnapshot>>;
}
