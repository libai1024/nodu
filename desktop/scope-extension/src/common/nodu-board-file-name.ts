// SPDX-License-Identifier: MIT
// Name rules for 保存到开发板: a bare file name in the board's default storage.
// The sidecar itself accepts up to 512 bytes; the stricter limit here keeps
// beginners away from paths and from characters a FAT volume rejects.

export const BOARD_FILE_NAME_MAX_BYTES = 64;

/** A message for an unusable name, or undefined when the name is acceptable. */
export function boardFileNameProblem(input: string): string | undefined {
    const name = input.trim();
    if (!name) { return '请输入文件名。'; }
    if (/[\\/:*?"<>|\x00-\x1f]/.test(name) || name === '.' || name === '..') { return '文件名不能包含路径或特殊字符。'; }
    // FAT-style filesystems ignore a trailing dot, so "boot.py." could land as boot.py and skip the
    // startup-file confirmation (the check is an exact-name match). Not verified on the board; rejecting is harmless.
    if (name.endsWith('.')) { return '文件名不能以点结尾。'; }
    if (new TextEncoder().encode(name).length > BOARD_FILE_NAME_MAX_BYTES) { return '文件名过长。'; }
    return undefined;
}
