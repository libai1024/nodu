// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TutorCourseV2, TutorLearningProgress, canonicalCourseContent, migrateLegacyProgress, parseCourse } from '../../common/tutor/tutor-course';
import { applyLearningAction, canonicalLearningJson, emptyLearningProgress, validateLearningProgress } from '../../common/tutor/tutor-learning-state';
import { CourseRepositoryError } from './tutor-course-repository';
import { TutorProgressSnapshot, TutorProgressEvent, TutorProgressUpdate } from '../../common/tutor/tutor-storage-protocol';
export type { TutorProgressSnapshot, TutorProgressEvent, TutorProgressUpdate } from '../../common/tutor/tutor-storage-protocol';

const HASH = /^[a-f0-9]{64}$/;
const MAX_ROW = 512 * 1024;
const MAX_LOG = 100 * 1024 * 1024;
const HISTORY_LIMIT = 256;
const hash = (text: string): string => createHash('sha256').update(text).digest('hex');
const code = (error: unknown, expected: string): boolean => !!error && typeof error === 'object' && 'code' in error && error.code === expected;
const failure = (message: string): CourseRepositoryError => new CourseRepositoryError('storageUnavailable', message);

interface Replay { events: TutorProgressEvent[]; last?: TutorProgressEvent; tail: boolean; bytes: number }

/** Durable local learning records. No renderer, course editing, model or hardware dependency. */
export class TutorProgressStore {
    private static readonly queues = new Map<string, Promise<unknown>>();
    private readonly listeners = new Set<(projectKey: string, sequence: number) => void>();
    constructor(private readonly dataRoot: string) { }

    static async projectKey(authorizedRoot: string): Promise<string> {
        const root = await fs.realpath(authorizedRoot);
        const identity = await fs.stat(root, { bigint: true });
        if (!identity.isDirectory()) { throw new CourseRepositoryError('outOfScope', '工程目录无效'); }
        return hash(`${root}\0${identity.dev}:${identity.ino}`);
    }

    onChange(listener: (projectKey: string, sequence: number) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async getSnapshot(projectKey: string, course: TutorCourseV2, afterSequence?: number, assertAllowed: () => void = () => undefined): Promise<TutorProgressUpdate> {
        course = this.checkedCourse(course);
        return this.access(projectKey, async directory => {
            assertAllowed();
            const replay = await this.prepare(directory, projectKey, course, assertAllowed);
            const snapshot = this.snapshot(replay.last!);
            const events = afterSequence !== undefined && Number.isSafeInteger(afterSequence) && afterSequence >= 0
                && afterSequence <= snapshot.sequence && afterSequence >= (replay.events[0]?.sequence ?? 1) - 1
                ? replay.events.filter(event => event.sequence > afterSequence) : undefined;
            return structuredClone({ snapshot, ...(events ? { events } : {}) });
        });
    }

    async apply(projectKey: string, course: TutorCourseV2, expectedSequence: number, expectedHash: string, requestId: string,
        input: { kind: 'action'; action: unknown } | { kind: 'legacyImport'; progress: unknown }, assertAllowed: () => void = () => undefined): Promise<TutorProgressSnapshot> {
        course = this.checkedCourse(course);
        if (!Number.isSafeInteger(expectedSequence) || expectedSequence < 0 || typeof expectedHash !== 'string' || !HASH.test(expectedHash)
            || typeof requestId !== 'string' || !/^[A-Za-z0-9_-]{8,96}$/.test(requestId)) {
            throw new CourseRepositoryError('invalidSchema', '学习请求格式无效');
        }
        let fingerprint: string;
        try {
            const body = JSON.stringify({ expectedSequence, expectedHash, input });
            if (Buffer.byteLength(body) > MAX_ROW) { throw new Error(); }
            const detached = JSON.parse(body);
            fingerprint = hash(canonicalLearningJson(detached));
            input = detached.input;
        } catch { throw new CourseRepositoryError('invalidSchema', '学习请求过大或格式无效'); }
        return this.access(projectKey, async directory => {
            assertAllowed();
            const replay = await this.prepare(directory, projectKey, course, assertAllowed);
            const state = replay.last!;
            const previous = replay.events.find(event => event.requestId === requestId);
            if (previous) {
                if (previous.fingerprint !== fingerprint) { throw new CourseRepositoryError('revisionConflict', '重复请求的内容不同'); }
                return structuredClone(this.snapshot(state));
            }
            if (state.sequence !== expectedSequence || state.planHash !== expectedHash) {
                throw new CourseRepositoryError('revisionConflict', '学习记录已更新，请重新加载');
            }
            let progress: TutorLearningProgress;
            try {
                if (input.kind === 'legacyImport') {
                    if (state.legacyImported || state.progress.log.length || state.progress.completionOrder.length) {
                        throw new CourseRepositoryError('revisionConflict', '已有学习记录，不能覆盖导入');
                    }
                    const legacy = input.progress as Record<string, unknown> | null;
                    if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy) || !Array.isArray(legacy.completed)
                        || Object.keys(legacy).some(key => !['completed', 'current', 'levels', 'references', 'decisions', 'log'].includes(key))) {
                        throw new Error('旧学习记录格式无效');
                    }
                    // Keep the source record in the client until this durable operation succeeds.
                    progress = validateLearningProgress(migrateLegacyProgress(input.progress, course), course);
                } else if (input.kind === 'action') {
                    progress = applyLearningAction(course, state.progress, input.action, Date.now());
                } else { throw new Error('学习操作无效'); }
            } catch (error) {
                if (error instanceof CourseRepositoryError) { throw error; }
                throw new CourseRepositoryError('invalidSchema', error instanceof Error ? error.message : '学习操作无效');
            }
            const event = this.event(replay, course, progress, input.kind, requestId, fingerprint,
                state.legacyImported || input.kind === 'legacyImport');
            assertAllowed();
            await this.append(directory, event);
            this.publish(projectKey, event.sequence);
            return structuredClone(this.snapshot(event));
        });
    }

    private async prepare(directory: string, projectKey: string, course: TutorCourseV2, assertAllowed: () => void): Promise<Replay> {
        await this.preserveCourse(directory, course);
        const replay = await this.replay(directory);
        if (!replay.last || replay.last.planHash !== course.contentHash) {
            assertAllowed();
            const event = this.event(replay, course, emptyLearningProgress(), 'course', '', '', false);
            await this.append(directory, event);
            this.remember(replay, event);
            this.publish(projectKey, event.sequence);
        }
        if (replay.tail) {
            assertAllowed();
            const last = replay.last!;
            const event = this.event(replay, course, last.progress, 'recovered', '', '', last.legacyImported);
            await this.append(directory, event);
            this.remember(replay, event);
            this.publish(projectKey, event.sequence);
        }
        // The journal is authoritative; an interrupted projection write is reconstructible.
        await this.checkpoint(directory, replay.last!).catch(() => undefined);
        return replay;
    }

    private checkedCourse(course: TutorCourseV2): TutorCourseV2 {
        const parsed = parseCourse(course);
        if (!parsed.course || hash(canonicalCourseContent(parsed.course)) !== parsed.course.contentHash) {
            throw new CourseRepositoryError('invalidSchema', '课程摘要无效');
        }
        return parsed.course;
    }

    private event(replay: Replay, course: TutorCourseV2, progress: TutorLearningProgress, kind: TutorProgressEvent['kind'],
        requestId: string, fingerprint: string, legacyImported: boolean): TutorProgressEvent {
        const data = { schema: 1 as const, sequence: (replay.last?.sequence ?? 0) + 1, planHash: course.contentHash,
            planRevision: course.revision, progress, legacyImported, kind, requestId, fingerprint, previousHash: replay.last?.checksum ?? '' };
        return { ...data, checksum: hash(canonicalLearningJson(data)) };
    }

    private snapshot(event: TutorProgressEvent): TutorProgressSnapshot {
        return { sequence: event.sequence, planHash: event.planHash, planRevision: event.planRevision,
            progress: event.progress, legacyImported: event.legacyImported };
    }
    private remember(replay: Replay, event: TutorProgressEvent): void {
        replay.last = event;
        replay.events.push(event);
        if (replay.events.length > HISTORY_LIMIT) { replay.events.shift(); }
    }
    private publish(projectKey: string, sequence: number): void {
        for (const listener of this.listeners) { try { listener(projectKey, sequence); } catch { /* A view cannot roll back a durable write. */ } }
    }

    private async replay(directory: string): Promise<Replay> {
        const result: Replay = { events: [], tail: false, bytes: 0 };
        const path = join(directory, 'events.jsonl');
        let handle: fs.FileHandle;
        try { handle = await this.openRegular(path, constants.O_RDWR); }
        catch (error) { if (code(error, 'ENOENT')) { await this.checkProjection(directory, result); return result; } throw error; }
        const courses = new Map<string, TutorCourseV2>();
        let pending = Buffer.alloc(0);
        let consumed = 0;
        try {
            if ((await handle.stat()).size > MAX_LOG) { throw failure('学习记录已达容量上限'); }
            const block = Buffer.alloc(64 * 1024);
            for (;;) {
                const { bytesRead } = await handle.read(block, 0, block.length, null);
                if (!bytesRead) { break; }
                result.bytes += bytesRead;
                if (result.bytes > MAX_LOG) { throw failure('学习记录已达容量上限'); }
                pending = Buffer.concat([pending, block.subarray(0, bytesRead)]);
                let end: number;
                while ((end = pending.indexOf(10)) >= 0) {
                    if (end > MAX_ROW) { throw failure('学习记录条目过大'); }
                    const row = pending.subarray(0, end);
                    pending = pending.subarray(end + 1);
                    let event: TutorProgressEvent;
                    try { event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row)); }
                    catch { throw failure('学习记录中间条目损坏'); }
                    const fields = ['schema', 'sequence', 'planHash', 'planRevision', 'progress', 'legacyImported', 'kind', 'requestId', 'fingerprint', 'previousHash', 'checksum'];
                    if (!event || Object.keys(event).sort().join() !== fields.sort().join() || event.schema !== 1
                        || event.sequence !== (result.last?.sequence ?? 0) + 1 || typeof event.planHash !== 'string' || !HASH.test(event.planHash)
                        || typeof event.checksum !== 'string' || event.previousHash !== (result.last?.checksum ?? '')
                        || typeof event.legacyImported !== 'boolean' || !['course', 'action', 'legacyImport', 'recovered'].includes(event.kind)
                        || typeof event.requestId !== 'string' || typeof event.fingerprint !== 'string') { throw failure('学习记录顺序或格式损坏'); }
                    const { checksum, ...data } = event;
                    if (hash(canonicalLearningJson(data)) !== checksum) { throw failure('学习记录校验失败'); }
                    let course = courses.get(event.planHash);
                    if (!course) {
                        const parsed = parseCourse(await this.readText(join(directory, 'plans', `${event.planHash}.json`), MAX_ROW));
                        course = parsed.course;
                        if (!course || course.contentHash !== event.planHash || hash(canonicalCourseContent(course)) !== event.planHash) { throw failure('课程历史损坏'); }
                        courses.set(event.planHash, course);
                    }
                    if (event.planRevision !== course.revision) { throw failure('课程历史版本不匹配'); }
                    try { event.progress = validateLearningProgress(event.progress, course); } catch { throw failure('学习记录状态损坏'); }
                    this.remember(result, event);
                    consumed += end + 1;
                }
                if (pending.length > MAX_ROW) { throw failure('学习记录条目过大'); }
            }
            await this.checkProjection(directory, result);
            if (pending.length) {
                await handle.truncate(consumed);
                await handle.sync();
                result.tail = true;
                result.bytes = consumed;
            }
        } finally { await handle.close(); }
        return result;
    }

    private async checkProjection(directory: string, replay: Replay): Promise<void> {
        let raw: unknown;
        try { raw = JSON.parse(await this.readText(join(directory, 'state.json'), MAX_ROW)); }
        catch (error) {
            if (code(error, 'ENOENT') || error instanceof SyntaxError) { return; }
            throw error;
        }
        if (raw && typeof raw === 'object' && 'sequence' in raw && typeof raw.sequence === 'number'
            && raw.sequence > (replay.last?.sequence ?? 0)) { throw failure('学习日志缺失，已保留原记录'); }
    }

    private async append(directory: string, event: TutorProgressEvent): Promise<void> {
        const line = `${JSON.stringify(event)}\n`;
        const length = Buffer.byteLength(line);
        if (length > MAX_ROW) { throw failure('学习记录条目过大'); }
        const handle = await this.openRegular(join(directory, 'events.jsonl'), constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY);
        try {
            if ((await handle.stat()).size + length > MAX_LOG) { throw failure('学习记录已达容量上限'); }
            await handle.writeFile(line, 'utf8');
            await handle.sync();
        } finally { await handle.close(); }
        await this.flushDirectory(directory);
        // A failed cache write does not undo the committed, fsynced journal.
        await this.checkpoint(directory, event).catch(() => undefined);
    }

    private async checkpoint(directory: string, event: TutorProgressEvent): Promise<void> {
        const temporary = join(directory, `.state-${randomUUID()}.tmp`);
        try {
            await this.writeNew(temporary, JSON.stringify({ ...this.snapshot(event), checksum: event.checksum }));
            await fs.rename(temporary, join(directory, 'state.json'));
            await this.flushDirectory(directory);
        } finally { await fs.unlink(temporary).catch(error => { if (!code(error, 'ENOENT')) { throw error; } }); }
    }

    private async preserveCourse(directory: string, course: TutorCourseV2): Promise<void> {
        const plans = join(directory, 'plans');
        await this.ensureDirectory(plans);
        const path = join(plans, `${course.contentHash}.json`);
        try {
            const existing = parseCourse(await this.readText(path, MAX_ROW));
            if (!existing.course || canonicalCourseContent(existing.course) !== canonicalCourseContent(course)
                || existing.course.contentHash !== course.contentHash) { throw failure('课程历史校验失败'); }
            return;
        } catch (error) { if (!code(error, 'ENOENT')) { throw error; } }
        const temporary = join(plans, `.course-${randomUUID()}.tmp`);
        try {
            await this.writeNew(temporary, JSON.stringify(course));
            await fs.link(temporary, path);
            await this.flushDirectory(plans);
            await this.flushDirectory(directory);
        } finally { await fs.unlink(temporary).catch(error => { if (!code(error, 'ENOENT')) { throw error; } }); }
    }

    private async access<T>(projectKey: string, work: (directory: string) => Promise<T>): Promise<T> {
        if (typeof projectKey !== 'string' || !HASH.test(projectKey)) { throw new CourseRepositoryError('outOfScope', '工程标识无效'); }
        try {
            await fs.mkdir(this.dataRoot, { recursive: true, mode: 0o700 });
            const root = await fs.realpath(this.dataRoot);
            const directory = join(root, projectKey);
            const previous = TutorProgressStore.queues.get(directory) ?? Promise.resolve();
            const next = previous.catch(() => undefined).then(async () => {
                await this.ensureDirectory(directory);
                await this.flushDirectory(root);
                await this.flushDirectory(dirname(root));
                const release = await TutorProgressStore.lock(directory);
                try { return await work(directory); } finally { await release(); }
            });
            TutorProgressStore.queues.set(directory, next);
            try { return await next; } finally { if (TutorProgressStore.queues.get(directory) === next) { TutorProgressStore.queues.delete(directory); } }
        } catch (error) {
            if (error instanceof CourseRepositoryError) { throw error; }
            throw failure('无法读取或保存学习记录');
        }
    }
    /**
     * Inter-process lock held for one read or write. The queue above already serializes this
     * process; the lock file stops a second Nodu backend from interleaving appends.
     */
    static async lock(directory: string, timeoutMs = 3000): Promise<() => Promise<void>> {
        const path = join(directory, '.write.lock');
        const owner = JSON.stringify({ pid: process.pid, at: Date.now(), id: randomUUID() });
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            try {
                const handle = await fs.open(path, 'wx', 0o600);
                try { await handle.writeFile(owner, 'utf8'); } finally { await handle.close(); }
                return async () => {
                    const current = await fs.readFile(path, 'utf8').catch(() => '');
                    if (current === owner) { await fs.unlink(path).catch(() => undefined); }
                };
            } catch (error) { if (!code(error, 'EEXIST')) { throw error; } }
            if (await TutorProgressStore.staleLock(path)) { await fs.unlink(path).catch(() => undefined); continue; }
            if (Date.now() > deadline) { throw new CourseRepositoryError('storageUnavailable', '学习记录正被另一个 Nodu 窗口写入，请稍后重试'); }
            await new Promise(resolve => setTimeout(resolve, 40));
        }
    }
    /** A lock whose process has exited, or that is far older than any write, is left over from a crash. */
    private static async staleLock(path: string): Promise<boolean> {
        let text: string;
        try { text = await fs.readFile(path, 'utf8'); } catch (error) { return code(error, 'ENOENT'); }
        let held: { pid?: unknown; at?: unknown };
        try { held = JSON.parse(text); } catch { held = {}; }
        const at = typeof held.at === 'number' ? held.at : 0;
        if (Date.now() - at > 60_000) { return true; }
        if (typeof held.pid !== 'number' || held.pid === process.pid) { return typeof held.pid !== 'number' && Date.now() - at > 5000; }
        try { process.kill(held.pid, 0); return false; } catch (error) { return code(error, 'ESRCH'); }
    }
    private async ensureDirectory(path: string): Promise<void> {
        await fs.mkdir(path, { mode: 0o700 }).catch(error => { if (!code(error, 'EEXIST')) { throw error; } });
        const stat = await fs.lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(path) !== path) { throw new CourseRepositoryError('outOfScope', '学习目录无效'); }
    }
    private async openRegular(path: string, flags: number): Promise<fs.FileHandle> {
        let before;
        try { before = await fs.lstat(path); } catch (error) { if (!code(error, 'ENOENT') || !(flags & constants.O_CREAT)) { throw error; } }
        if (before && (!before.isFile() || before.isSymbolicLink())) { throw new CourseRepositoryError('outOfScope', '学习文件无效'); }
        const handle = await fs.open(path, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
        const stat = await handle.stat();
        if (!stat.isFile() || before && (before.dev !== stat.dev || before.ino !== stat.ino)) { await handle.close(); throw new CourseRepositoryError('outOfScope', '学习文件无效'); }
        return handle;
    }
    private async readText(path: string, limit: number): Promise<string> {
        const handle = await this.openRegular(path, constants.O_RDONLY);
        try {
            const bytes = Buffer.alloc(limit + 1);
            let offset = 0;
            while (offset < bytes.length) {
                const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
                if (!bytesRead) { break; } offset += bytesRead;
            }
            if (offset > limit) { throw failure('学习文件过大'); }
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset));
        } finally { await handle.close(); }
    }
    private async writeNew(path: string, source: string): Promise<void> {
        const handle = await fs.open(path, 'wx', 0o600);
        try { await handle.writeFile(source, 'utf8'); await handle.sync(); } finally { await handle.close(); }
    }
    private async flushDirectory(path: string): Promise<void> {
        if (process.platform === 'win32') { return; }
        const handle = await fs.open(path, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
    }
}
