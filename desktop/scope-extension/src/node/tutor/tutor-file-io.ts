// SPDX-License-Identifier: MIT
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';

/** Read a regular file without following the final link or blocking on a replaced FIFO.
 * The fixed buffer also bounds files that grow after stat; callers recheck their grant. */
export async function readRegularFile(location: string, limit: number): Promise<string> {
    const before = await fs.lstat(location);
    if (!before.isFile() || before.isSymbolicLink() || before.size > limit) { throw new Error('教学文件无效或超过大小限制'); }
    const file = await fs.open(location, constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0));
    try {
        const opened = await file.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > limit) { throw new Error('教学文件已改变，请重试'); }
        const bytes = Buffer.alloc(limit + 1); let length = 0;
        while (length < bytes.length) {
            const part = await file.read(bytes, length, bytes.length - length, length);
            if (!part.bytesRead) { break; } length += part.bytesRead;
        }
        const after = await file.stat(), current = await fs.lstat(location);
        if (length > limit || !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino
            || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || current.size !== after.size || current.mtimeMs !== after.mtimeMs || length !== after.size) { throw new Error('教学文件已改变或超过大小限制'); }
        try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
        catch { throw new Error('教学文件编码无效'); }
    } finally { await file.close(); }
}
