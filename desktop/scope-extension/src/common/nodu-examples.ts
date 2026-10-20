// SPDX-License-Identifier: MIT
// Pure menu-tree builder for the 示例 submenu: ordering, depth and entry
// limits live here so the file walk stays a thin async shell and the logic
// is unit-testable without Theia.

export const MAX_EXAMPLE_DEPTH = 5;
export const MAX_EXAMPLE_FILES = 1000;

export interface ExampleSubmenu {
    /** Segments from the examples root ('Nodu', 'application/gpio', ...). */
    segments: string[];
    /** Zero-padded sort key within the parent menu. */
    order: string;
}

export interface ExampleFileItem {
    /** Directory segments below the examples root. */
    dir: string[];
    /** File name including the .py suffix. */
    name: string;
    /** Zero-padded sort key within the parent menu. */
    order: string;
}

export interface ExampleMenuTree {
    /** Every directory level, parents before children. */
    submenus: ExampleSubmenu[];
    /** Files in depth-first menu order; index = command registration order. */
    files: ExampleFileItem[];
}

/** Locale-insensitive and numeric-aware, so `demo_2` sorts before `demo_10`. */
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

interface DirNode {
    dirs: Map<string, DirNode>;
    files: string[];
}

const newNode = (): DirNode => ({ dirs: new Map(), files: [] });

function orderKey(index: number): string {
    return index.toString().padStart(4, '0');
}

function skippedName(name: string): boolean {
    return name.startsWith('.') || name === '__pycache__' || name === '.' || name === '..';
}

/**
 * Build the examples menu model from `.py` paths relative to the examples
 * root (POSIX separators). The `Nodu` category pins first; every other level
 * sorts directories before files with numeric-aware, case-insensitive
 * ordering. Entries deeper than {@link MAX_EXAMPLE_DEPTH} segments and files
 * past {@link MAX_EXAMPLE_FILES} are dropped.
 */
export function buildExampleTree(relativePaths: readonly string[], maxFiles = MAX_EXAMPLE_FILES): ExampleMenuTree {
    const root = newNode();
    const accepted: string[] = [];
    for (const rel of relativePaths) {
        if (accepted.length >= maxFiles) { break; }
        const segments = rel.split('/').filter(segment => segment.length > 0);
        if (segments.length === 0 || segments.length > MAX_EXAMPLE_DEPTH) { continue; }
        if (segments.some(skippedName)) { continue; }
        let node = root;
        for (const segment of segments.slice(0, -1)) {
            let next = node.dirs.get(segment);
            if (!next) { node.dirs.set(segment, next = newNode()); }
            node = next;
        }
        node.files.push(segments[segments.length - 1]);
        accepted.push(rel);
    }

    const submenus: ExampleSubmenu[] = [];
    const files: ExampleFileItem[] = [];

    const emit = (node: DirNode, segments: string[]): void => {
        const dirs = [...node.dirs.keys()].sort(collator.compare);
        // 'Nodu' pins first at the top level (bundled Nodu examples).
        const ordered = segments.length === 0 && node.dirs.has('Nodu')
            ? ['Nodu', ...dirs.filter(name => name !== 'Nodu')]
            : dirs;
        const fileNames = node.files.slice().sort(collator.compare);
        let index = 0;
        for (const name of ordered) {
            const child = node.dirs.get(name)!;
            const childSegments = [...segments, name];
            submenus.push({ segments: childSegments, order: orderKey(index++) });
            emit(child, childSegments);
        }
        for (const name of fileNames) {
            files.push({ dir: segments, name, order: orderKey(index++) });
        }
    };
    emit(root, []);
    return { submenus, files };
}
