// SPDX-License-Identifier: MIT
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { TutorCourseRepository, CourseRepositoryError } from './tutor-course-repository';
import { TutorProgressStore } from './tutor-progress-store';
import { TutorCourseTarget } from '../../common/tutor/tutor-course';
import { TutorLearningAction } from '../../common/tutor/tutor-learning-state';
import {
    TutorSessionSnapshot, TutorStorageClient, TutorStorageOutcome, TutorStorageService,
} from '../../common/tutor/tutor-storage-protocol';

interface WorkspaceGrant { id: string; projectKey: string; repository: TutorCourseRepository }
interface Session { id: string; grant: WorkspaceGrant }
export interface TutorStorageConnection {
    readonly service: TutorStorageService;
    /** Host-only capability grant; this method must never be installed on an RPC target. */
    authorizeWorkspace(authorizedRoot: string): Promise<string>;
    revokeWorkspace(workspaceId: string): void;
    dispose(): void;
}

/** Transport adapter with per-connection ownership; it never accepts renderer filesystem paths. */
export class TutorStorageServer {
    constructor(private readonly store: TutorProgressStore) { }

    connect(client: TutorStorageClient): TutorStorageConnection {
        const grants = new Map<string, WorkspaceGrant>();
        const sessions = new Map<string, Session>();
        let disposed = false;
        const session = (id: string): Session => {
            const value = !disposed && typeof id === 'string' ? sessions.get(id) : undefined;
            if (!value) { throw new CourseRepositoryError('outOfScope', '教学会话已失效'); }
            return value;
        };
        const outcome = async <T>(run: () => Promise<T>): Promise<TutorStorageOutcome<T>> => {
            try { return { ok: true, value: await run() }; }
            catch (error) {
                return { ok: false, error: error instanceof CourseRepositoryError
                    ? { code: error.code, message: error.message } : { code: 'storageUnavailable', message: '无法读取或保存学习记录' } };
            }
        };
        const snapshot = async (value: Session, afterSequence?: number): Promise<TutorSessionSnapshot> => {
            let plan;
            try { plan = await value.grant.repository.read(); }
            catch (error) {
                if (!(error instanceof CourseRepositoryError) || error.code !== 'sourceMissing') { throw error; }
                session(value.id);
                return { sessionId: value.id, plan: { kind: 'none' } };
            }
            session(value.id);
            const learning = plan.kind === 'course' ? await this.store.getSnapshot(value.grant.projectKey, plan.course, afterSequence, () => { session(value.id); }) : undefined;
            session(value.id);
            return { sessionId: value.id, plan, ...(learning ? { learning } : {}) };
        };
        const mutate = async (id: string, expectedSequence: number, expectedHash: string, requestId: string,
            input: { kind: 'action'; action: unknown } | { kind: 'legacyImport'; progress: unknown }) => {
            const value = session(id);
            const plan = await value.grant.repository.read();
            session(id);
            if (plan.kind !== 'course') { throw new CourseRepositoryError('invalidSchema', '请先迁移课程'); }
            return this.store.apply(value.grant.projectKey, plan.course, expectedSequence, expectedHash, requestId, input, () => { session(id); });
        };
        const remove = this.store.onChange((projectKey, sequence) => {
            for (const value of sessions.values()) {
                if (value.grant.projectKey !== projectKey || disposed) { continue; }
                try { Promise.resolve(client.onDidChange({ sessionId: value.id, sequence })).catch(() => undefined); }
                catch { /* Connection callbacks cannot change persisted state. */ }
            }
        });
        const methods: TutorStorageService = {
            openSession: workspaceId => outcome(async () => {
                const grant = !disposed && typeof workspaceId === 'string' ? grants.get(workspaceId) : undefined;
                if (!grant) { throw new CourseRepositoryError('outOfScope', '工程授权已失效'); }
                const existing = [...sessions.values()].find(value => value.grant === grant);
                if (existing) { return snapshot(existing); }
                if (sessions.size >= 16) { throw new CourseRepositoryError('outOfScope', '教学会话数量已达上限'); }
                const value = { id: randomUUID(), grant };
                sessions.set(value.id, value);
                try { return await snapshot(value); } catch (error) { sessions.delete(value.id); throw error; }
            }),
            getSnapshot: (id, afterSequence) => outcome(async () => {
                if (afterSequence !== undefined && (!Number.isSafeInteger(afterSequence) || afterSequence < 0)) { throw new CourseRepositoryError('invalidSchema', '事件序号无效'); }
                return snapshot(session(id), afterSequence);
            }),
            closeSession: id => outcome(async () => { session(id); sessions.delete(id); }),
            previewMigration: (id: string, target: TutorCourseTarget) => outcome(async () => {
                const value = session(id);
                const preview = await value.grant.repository.previewMigration(target);
                session(id);
                return preview;
            }),
            acceptMigration: (id, previewId, sourceDigest) => outcome(async () => {
                const value = session(id);
                await value.grant.repository.acceptMigration(previewId, sourceDigest, () => { session(id); });
                session(id);
                return snapshot(value);
            }),
            recordAction: (id: string, seq: number, planHash: string, requestId: string, action: TutorLearningAction) => outcome(() => mutate(id, seq, planHash, requestId, { kind: 'action', action })),
            importLegacyProgress: (id, seq, planHash, requestId, progress) => outcome(() => mutate(id, seq, planHash, requestId, { kind: 'legacyImport', progress })),
        };
        const facade = Object.create(null) as TutorStorageService;
        for (const key of Object.keys(methods) as (keyof TutorStorageService)[]) {
            Object.defineProperty(facade, key, { value: methods[key], enumerable: true });
        }
        return {
            service: Object.freeze(facade),
            authorizeWorkspace: async authorizedRoot => {
                if (disposed || grants.size >= 16) { throw new CourseRepositoryError('outOfScope', '工程授权已失效'); }
                const root = await fs.realpath(authorizedRoot);
                if (!(await fs.stat(root)).isDirectory()) { throw new CourseRepositoryError('outOfScope', '工程目录无效'); }
                const projectKey = await TutorProgressStore.projectKey(root);
                if (disposed) { throw new CourseRepositoryError('outOfScope', '工程授权已失效'); }
                const existing = [...grants.values()].find(grant => grant.projectKey === projectKey);
                if (existing) { return existing.id; }
                if (grants.size >= 16) { throw new CourseRepositoryError('outOfScope', '工程授权数量已达上限'); }
                const grant = { id: randomUUID(), projectKey, repository: new TutorCourseRepository(root) };
                grants.set(grant.id, grant);
                return grant.id;
            },
            revokeWorkspace: workspaceId => {
                grants.delete(workspaceId);
                for (const [id, value] of sessions) { if (value.grant.id === workspaceId) { sessions.delete(id); } }
            },
            dispose: () => { disposed = true; remove(); grants.clear(); sessions.clear(); },
        };
    }
}
