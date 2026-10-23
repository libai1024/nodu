// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { emptyGoal, TutorGoalState, validateGoalState } from '../../common/tutor/tutor-goal';

/** Shared by connections; model calls happen outside this short compare-and-swap transaction. */
export class TutorGoalStore {
    private readonly queues = new Map<string, Promise<unknown>>();
    constructor(private readonly directory: string) { }
    private file(key: string): string {
        if (!/^[a-f\d]{64}$/.test(key)) { throw new Error('教学工程无效'); }
        return join(this.directory, `${key}.json`);
    }
    async read(key: string): Promise<TutorGoalState> {
        const file = this.file(key);
        let handle;
        try {
            if ((await fs.lstat(this.directory)).isSymbolicLink()) { throw new Error('教学存储目录不能是符号链接'); }
            handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
            if ((await handle.stat()).size > 256000) { throw new Error('教学记录过大'); }
            return validateGoalState(JSON.parse(await handle.readFile('utf8')));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return emptyGoal(); }
            throw error;
        } finally { await handle?.close(); }
    }
    async write(key: string, expected: number, next: TutorGoalState, authorize: () => Promise<void>): Promise<TutorGoalState> {
        next = validateGoalState(JSON.parse(JSON.stringify(next)));
        const before = this.queues.get(key) ?? Promise.resolve();
        const run = before.catch(() => undefined).then(async () => {
            const current = await this.read(key);
            if (expected !== current.revision) { throw new Error('教学进度已在其他窗口更新，请重试'); }
            const state = validateGoalState({ ...next, revision: expected + 1 });
            const body = JSON.stringify(state);
            if (body.length > 256000) { throw new Error('教学记录过大'); }
            await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
            if ((await fs.lstat(this.directory)).isSymbolicLink()) { throw new Error('教学存储目录不能是符号链接'); }
            const file = this.file(key), temporary = `${file}.${randomUUID()}.tmp`;
            try {
                const handle = await fs.open(temporary, 'wx', 0o600);
                try { await handle.writeFile(body + '\n'); await handle.sync(); } finally { await handle.close(); }
                await authorize();
                await fs.rename(temporary, file);
                return state;
            } finally { await fs.rm(temporary, { force: true }); }
        });
        this.queues.set(key, run);
        try { return await run; } finally { if (this.queues.get(key) === run) { this.queues.delete(key); } }
    }
}
