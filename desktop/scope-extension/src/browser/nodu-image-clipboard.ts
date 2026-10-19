// SPDX-License-Identifier: MIT
interface ClipboardWriter {
    writeText(value: string): void | PromiseLike<void>;
    onDidWriteText?: (listener: (value: string) => void) => { dispose(): void };
}

/** Theia browser writeText can return normally when permission is denied. */
export async function copyImageParameters(clipboard: ClipboardWriter, text: string): Promise<void> {
    let acknowledged = false;
    const subscription = clipboard.onDidWriteText?.(value => { if (value === text) { acknowledged = true; } });
    try {
        await clipboard.writeText(text);
        if (!acknowledged) { throw new Error('剪贴板未确认写入，请检查权限或手动复制参数。'); }
    } finally { subscription?.dispose(); }
}
