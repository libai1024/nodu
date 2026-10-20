// SPDX-License-Identifier: MIT
// Shared bounded binary file loading for the machine-vision dialogs: native
// picker, declared-size preflight, then actual-length check after read.
import URI from '@theia/core/lib/common/uri';
import { FileService } from '@theia/filesystem/lib/browser/file-service';
import { FileDialogService } from '@theia/filesystem/lib/browser/file-dialog';

export interface PickedFile {
    uri: URI;
    bytes: Uint8Array;
}

export async function pickBinaryFile(deps: { files: FileService; dialogs: FileDialogService }, options: {
    title: string;
    openLabel: string;
    filters: Record<string, string[]>;
    maxBytes: number;
    tooLarge: string;
}): Promise<PickedFile | undefined> {
    const uri = await deps.dialogs.showOpenDialog({
        title: options.title,
        openLabel: options.openLabel,
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: options.filters,
    });
    const picked = Array.isArray(uri) ? uri[0] : uri;
    if (!picked) { return undefined; }
    const stat = await deps.files.resolve(picked);
    if (stat.size !== undefined && stat.size > options.maxBytes) {
        throw new Error(options.tooLarge);
    }
    const content = await deps.files.readFile(picked, { limits: { size: options.maxBytes } });
    const bytes = content.value.buffer;
    if (bytes.length > options.maxBytes) {
        throw new Error(options.tooLarge);
    }
    return { uri: picked, bytes };
}
