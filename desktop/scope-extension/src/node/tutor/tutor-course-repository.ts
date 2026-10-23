// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseTutorPlan } from '../../common/nodu-tutor-plan';
import { StoredCourse, CourseMigrationPreview } from '../../common/tutor/tutor-storage-protocol';
export type { StoredCourse, CourseMigrationPreview } from '../../common/tutor/tutor-storage-protocol';
import {
    canonicalCourseContent, migrateLegacyCourse, parseCourse, TutorCourseTarget, TutorCourseV2,
} from '../../common/tutor/tutor-course';

const MAX_PLAN_BYTES = 512 * 1024;
const PLAN_DIRECTORY = '.nodu-tutor';
const PLAN_FILE = 'plan.json';
const PREVIEW_TTL_MS = 30 * 60 * 1000;
const MAX_PREVIEWS = 8;
const JOURNAL_FILE = '.migration.json';
interface MigrationJournal {
    schema: 1; id: string; pid: number; originalDigest: string; candidateDigest: string;
}

export type CourseRepositoryErrorCode = 'invalidSchema' | 'outOfScope' | 'revisionConflict' | 'storageUnavailable' | 'sourceMissing';
export class CourseRepositoryError extends Error {
    constructor(readonly code: CourseRepositoryErrorCode, message: string) { super(message); }
}

interface PendingMigration extends CourseMigrationPreview { createdAt: number; original: string }
const sha256 = (source: string): string => createHash('sha256').update(source, 'utf8').digest('hex');

/** Filesystem boundary for a workspace already authorized by the caller. No RPC or model tools. */
export class TutorCourseRepository {
    private static readonly writers = new Map<string, Promise<unknown>>();
    private readonly previews = new Map<string, PendingMigration>();
    private root?: string;

    constructor(private readonly authorizedRoot: string) { }

    async read(): Promise<StoredCourse> {
        return this.io(async () => this.serial(await this.workspaceRoot(), async () => {
            await this.recoverPending();
            return this.decode(await this.readSource());
        }));
    }

    async previewMigration(target: TutorCourseTarget): Promise<CourseMigrationPreview> {
        return this.io(async () => this.serial(await this.workspaceRoot(), async () => {
            await this.recoverPending();
            const original = await this.readSource();
            const source = this.decode(original);
            if (source.kind !== 'legacy') { throw new CourseRepositoryError('invalidSchema', '课程无需迁移'); }
            const result = migrateLegacyCourse(JSON.parse(original), target);
            if (!result.draft) { throw new CourseRepositoryError('invalidSchema', result.errors.join('；')); }
            const candidate = { ...result.draft, contentHash: sha256(canonicalCourseContent(result.draft)) };
            const parsed = parseCourse(candidate);
            if (!parsed.course) { throw new CourseRepositoryError('invalidSchema', parsed.errors.join('；')); }
            this.serialize(parsed.course);
            const now = Date.now();
            for (const [id, item] of this.previews) {
                if (now - item.createdAt > PREVIEW_TTL_MS) { this.previews.delete(id); }
            }
            if (this.previews.size >= MAX_PREVIEWS) { this.previews.delete(this.previews.keys().next().value!); }
            const preview: PendingMigration = {
                id: randomUUID(), sourceDigest: source.sourceDigest, course: parsed.course, original, createdAt: now,
            };
            this.previews.set(preview.id, preview);
            return this.publicPreview(preview);
        }));
    }

    async acceptMigration(id: string, expectedSourceDigest: string, assertAllowed: () => void = () => undefined): Promise<StoredCourse> {
        return this.io(async () => {
            const root = await this.workspaceRoot();
            return this.serial(root, async () => {
                assertAllowed();
                await this.recoverPending();
                const preview = this.previews.get(id);
                if (!preview || preview.sourceDigest !== expectedSourceDigest || Date.now() - preview.createdAt > PREVIEW_TTL_MS) {
                    throw new CourseRepositoryError('revisionConflict', '迁移预览已失效');
                }
                const original = await this.readSource();
                if (sha256(original) !== expectedSourceDigest) {
                    throw new CourseRepositoryError('revisionConflict', '教学计划已修改，请重新预览');
                }
                assertAllowed();
                const directory = await this.planDirectory();
                const backups = join(directory, 'backups');
                await this.ensureDirectory(backups);
                const backup = join(backups, `schema1-${expectedSourceDigest}.json`);
                await this.backup(backup, original);
                await this.flushDirectory(directory);
                const source = this.serialize(preview.course);
                const transactionId = randomUUID();
                const temporary = join(directory, `.plan-${transactionId}.tmp`);
                const plan = join(directory, PLAN_FILE);
                const displaced = join(backups, `recovery-${transactionId}.json`);
                let moved = false;
                let journalWritten = false;
                try {
                    await this.writeNew(temporary, source);
                    await this.publishJournal(directory, {
                        schema: 1, id: transactionId, pid: process.pid,
                        originalDigest: expectedSourceDigest, candidateDigest: sha256(source),
                    });
                    journalWritten = true;
                    // Include edits made while preparing the backup in the compare-and-swap.
                    if (sha256(await this.readSource()) !== expectedSourceDigest) {
                        throw new CourseRepositoryError('revisionConflict', '教学计划已修改，请重新预览');
                    }
                    assertAllowed();
                    // Preserve the actual displaced file, including a late external editor save.
                    await fs.rename(plan, displaced);
                    moved = true;
                    await this.flushDirectory(backups);
                    if (sha256(await this.readFile(displaced)) !== expectedSourceDigest) {
                        throw new CourseRepositoryError('revisionConflict', '教学计划已修改，请重新预览');
                    }
                    // Exclusive publication must not overwrite a file recreated by another writer.
                    try { await fs.link(temporary, plan); } catch (error) {
                        if (this.isCode(error, 'EEXIST')) { throw new CourseRepositoryError('revisionConflict', '教学计划已修改，请重新预览'); }
                        throw error;
                    }
                    await this.flushDirectory(directory);
                    await this.finishJournal(directory, transactionId);
                } catch (error) {
                    if (moved) {
                        // Restore only when the destination is still absent. Keep recovery data.
                        await fs.link(displaced, plan).catch(restoreError => {
                            if (!this.isCode(restoreError, 'EEXIST')) { throw restoreError; }
                        });
                        await this.flushDirectory(directory);
                    }
                    if (journalWritten) { await this.recoverPending(); }
                    throw error;
                } finally {
                    await fs.unlink(temporary).catch(error => { if (!this.isCode(error, 'ENOENT')) { throw error; } });
                }
                this.previews.delete(id);
                return this.decode(source);
            });
        });
    }

    private async publishJournal(directory: string, journal: MigrationJournal): Promise<void> {
        const temporary = join(directory, `.journal-${journal.id}.tmp`);
        try {
            await this.writeNew(temporary, JSON.stringify(journal));
            try { await fs.link(temporary, join(directory, JOURNAL_FILE)); } catch (error) {
                if (this.isCode(error, 'EEXIST')) { throw new CourseRepositoryError('revisionConflict', '课程迁移正在处理'); }
                throw error;
            }
            await this.flushDirectory(directory);
        } finally { await fs.unlink(temporary).catch(error => { if (!this.isCode(error, 'ENOENT')) { throw error; } }); }
    }

    /** Restart recovery rolls back only an absent destination; external saves always win. */
    private async recoverPending(): Promise<void> {
        const directory = await this.planDirectory();
        let source: string;
        try { source = await this.readFile(join(directory, JOURNAL_FILE)); }
        catch (error) { if (this.isCode(error, 'ENOENT')) { return; } throw error; }
        let raw: unknown;
        try { raw = JSON.parse(source); } catch { throw new CourseRepositoryError('storageUnavailable', '课程恢复记录损坏'); }
        const j = raw as Partial<MigrationJournal> | null;
        if (!j || typeof j !== 'object' || Object.keys(j).sort().join() !== 'candidateDigest,id,originalDigest,pid,schema'
            || j.schema !== 1 || typeof j.id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(j.id)
            || !Number.isSafeInteger(j.pid) || j.pid! <= 0
            || typeof j.originalDigest !== 'string' || !/^[a-f0-9]{64}$/.test(j.originalDigest)
            || typeof j.candidateDigest !== 'string' || !/^[a-f0-9]{64}$/.test(j.candidateDigest)) {
            throw new CourseRepositoryError('storageUnavailable', '课程恢复记录无效');
        }
        if (j.pid !== process.pid) {
            try { process.kill(j.pid!, 0); throw new CourseRepositoryError('storageUnavailable', '另一进程正在迁移课程'); }
            catch (error) { if (!this.isCode(error, 'ESRCH')) { throw error; } }
        }
        const plan = join(directory, PLAN_FILE);
        try { await this.readFile(plan); } catch (error) {
            if (!this.isCode(error, 'ENOENT')) { throw error; }
            const backups = join(directory, 'backups');
            await this.ensureDirectory(backups);
            const recovery = join(backups, `recovery-${j.id}.json`);
            // Validate the actual displaced file without inferring it from an older backup.
            try { await this.readFile(recovery); } catch { throw new CourseRepositoryError('storageUnavailable', '课程恢复文件缺失或损坏'); }
            await fs.link(recovery, plan).catch(linkError => { if (!this.isCode(linkError, 'EEXIST')) { throw linkError; } });
        }
        await this.flushDirectory(directory);
        await this.finishJournal(directory, j.id);
    }

    private async finishJournal(directory: string, id: string): Promise<void> {
        await fs.unlink(join(directory, `.plan-${id}.tmp`)).catch(error => { if (!this.isCode(error, 'ENOENT')) { throw error; } });
        await fs.unlink(join(directory, JOURNAL_FILE));
        await this.flushDirectory(directory);
    }

    private publicPreview(preview: PendingMigration): CourseMigrationPreview {
        return { id: preview.id, sourceDigest: preview.sourceDigest, course: structuredClone(preview.course) };
    }

    private serialize(course: TutorCourseV2): string {
        const source = `${JSON.stringify(course, null, 2)}\n`;
        if (Buffer.byteLength(source, 'utf8') > MAX_PLAN_BYTES) { throw new CourseRepositoryError('invalidSchema', '迁移后的教学计划过大'); }
        return source;
    }

    private decode(source: string): StoredCourse {
        let raw: unknown;
        try { raw = JSON.parse(source); } catch { throw new CourseRepositoryError('invalidSchema', '教学计划不是有效 JSON'); }
        const sourceDigest = sha256(source);
        if (raw && typeof raw === 'object' && 'schema' in raw && raw.schema === 1) {
            const legacy = parseTutorPlan(source);
            if (!legacy.plan) { throw new CourseRepositoryError('invalidSchema', legacy.errors.join('；')); }
            return { kind: 'legacy', sourceDigest, plan: legacy.plan };
        }
        const parsed = parseCourse(raw);
        if (!parsed.course) { throw new CourseRepositoryError('invalidSchema', parsed.errors.join('；')); }
        if (parsed.course.contentHash !== sha256(canonicalCourseContent(parsed.course))) {
            throw new CourseRepositoryError('invalidSchema', '教学计划摘要不匹配');
        }
        return { kind: 'course', sourceDigest, course: parsed.course };
    }

    private async workspaceRoot(): Promise<string> {
        if (!this.root) {
            const root = await fs.realpath(this.authorizedRoot);
            if (!(await fs.stat(root)).isDirectory()) { throw new CourseRepositoryError('outOfScope', '工程目录无效'); }
            this.root = root;
        }
        return this.root;
    }

    private async planDirectory(): Promise<string> {
        const root = await this.workspaceRoot();
        const directory = join(root, PLAN_DIRECTORY);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(directory) !== directory) {
            throw new CourseRepositoryError('outOfScope', '教学计划目录无效');
        }
        return directory;
    }

    private async readSource(): Promise<string> {
        return this.readFile(join(await this.planDirectory(), PLAN_FILE));
    }

    private async readFile(path: string): Promise<string> {
        const before = await fs.lstat(path);
        if (!before.isFile() || before.isSymbolicLink()) { throw new CourseRepositoryError('outOfScope', '教学计划文件无效'); }
        const handle = await fs.open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        try {
            const stat = await handle.stat();
            if (!stat.isFile() || before.ino !== stat.ino || before.dev !== stat.dev) {
                throw new CourseRepositoryError('outOfScope', '教学计划文件已替换');
            }
            if (stat.size > MAX_PLAN_BYTES) { throw new CourseRepositoryError('invalidSchema', '教学计划过大'); }
            const bytes = Buffer.alloc(MAX_PLAN_BYTES + 1);
            let length = 0;
            while (length < bytes.length) {
                const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
                if (!bytesRead) { break; }
                length += bytesRead;
            }
            if (length > MAX_PLAN_BYTES) { throw new CourseRepositoryError('invalidSchema', '教学计划过大'); }
            try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)); }
            catch { throw new CourseRepositoryError('invalidSchema', '教学计划不是有效 UTF-8'); }
        } finally { await handle.close(); }
    }

    private async ensureDirectory(path: string): Promise<void> {
        try { await fs.mkdir(path, { mode: 0o700 }); } catch (error) { if (!this.isCode(error, 'EEXIST')) { throw error; } }
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(path) !== path) {
            throw new CourseRepositoryError('outOfScope', '教学备份目录无效');
        }
    }

    private async backup(path: string, source: string): Promise<void> {
        const temporary = join(dirname(path), `.backup-${randomUUID()}.tmp`);
        try {
            await this.writeNew(temporary, source);
            try { await fs.link(temporary, path); } catch (error) {
                if (!this.isCode(error, 'EEXIST')) { throw error; }
                if (await this.readFile(path) !== source) { throw new CourseRepositoryError('storageUnavailable', '教学备份内容不一致'); }
            }
            await this.flushDirectory(dirname(path));
        } finally {
            await fs.unlink(temporary).catch(error => { if (!this.isCode(error, 'ENOENT')) { throw error; } });
        }
    }

    private async writeNew(path: string, source: string): Promise<void> {
        const handle = await fs.open(path, 'wx', 0o600);
        try { await handle.writeFile(source, 'utf8'); await handle.sync(); } catch (error) {
            await handle.close();
            await fs.unlink(path).catch(() => undefined);
            throw error;
        }
        await handle.close();
    }

    private async flushDirectory(path: string): Promise<void> {
        if (process.platform === 'win32') { return; }
        const handle = await fs.open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }

    private async serial<T>(root: string, work: () => Promise<T>): Promise<T> {
        const previous = TutorCourseRepository.writers.get(root) ?? Promise.resolve();
        const next = previous.catch(() => undefined).then(work);
        TutorCourseRepository.writers.set(root, next);
        try { return await next; } finally {
            if (TutorCourseRepository.writers.get(root) === next) { TutorCourseRepository.writers.delete(root); }
        }
    }

    private isCode(error: unknown, code: string): boolean { return !!error && typeof error === 'object' && 'code' in error && error.code === code; }

    private async io<T>(work: () => Promise<T>): Promise<T> {
        try { return await work(); } catch (error) {
            if (error instanceof CourseRepositoryError) { throw error; }
            if (this.isCode(error, 'ENOENT')) { throw new CourseRepositoryError('sourceMissing', '找不到教学计划'); }
            throw new CourseRepositoryError('storageUnavailable', '无法读取或保存教学计划');
        }
    }
}
