// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

interface InputStamp { path: string; size: number; mtimeMs: number; ctimeMs: number; directory: boolean }
const receiptName = '.environment-ready.json';
const local = (name: string): boolean => !!name && !isAbsolute(name) && !name.split(/[\\/]/).includes('..');

/** An installed-environment hint, invalidated by app inputs, moves or missing tools. */
export async function arduinoEnvironmentIdentity(home: string, inputs: string[]): Promise<string | undefined> {
    try {
        const hash = createHash('sha256').update(`nodu-environment-1\0${process.platform}-${process.arch}\0${home}\0`);
        for (const input of inputs) { hash.update(await fs.readFile(input)).update('\0'); }
        return hash.digest('hex');
    } catch { return undefined; }
}

export async function hasArduinoEnvironmentReceipt(home: string, identity: string): Promise<boolean> {
    try {
        const file = join(home, receiptName), stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) { return false; }
        const value = JSON.parse(await fs.readFile(file, 'utf8')) as { schema: number; identity: string; inputs: InputStamp[] };
        if (value.schema !== 1 || value.identity !== identity || !Array.isArray(value.inputs) || !value.inputs.length || value.inputs.length > 10000) { return false; }
        const results = await Promise.all(value.inputs.map(async input => {
            if (!input || typeof input.path !== 'string' || !local(input.path)) { return false; }
            const current = await fs.lstat(join(home, input.path));
            return !current.isSymbolicLink() && current.isDirectory() === input.directory && (current.isDirectory() || current.isFile())
                && current.size === input.size && current.mtimeMs === input.mtimeMs && current.ctimeMs === input.ctimeMs;
        }));
        return results.every(Boolean);
    } catch { return false; }
}

/** Keep metadata for the installed closure and executables, not a boolean 'ready'. */
export async function rememberArduinoEnvironment(home: string, identity: string, database: unknown): Promise<void> {
    if (!Array.isArray(database) || !database.length) { return; }
    const inputs = new Map<string, InputStamp>();
    const add = async (file: string): Promise<void> => {
        const name = relative(home, file);
        if (!local(name)) { throw new Error('Arduino environment input is outside its home'); }
        const stat = await fs.lstat(file);
        if (stat.isSymbolicLink() || !stat.isFile() && !stat.isDirectory()) { throw new Error('Unsupported Arduino environment input'); }
        inputs.set(name, { path: name, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, directory: stat.isDirectory() });
    };
    const scanTools = async (directory: string, allFiles = false): Promise<void> => {
        await add(directory);
        for (const item of await fs.readdir(directory, { withFileTypes: true })) {
            const file = join(directory, item.name);
            if (item.isDirectory()) { await scanTools(file, allFiles); }
            else if (allFiles || /\.(exe|dll|so|dylib)$/.test(item.name) || (await fs.lstat(file)).mode & 0o111) { await add(file); }
        }
    };
    try {
        let compilers = 0, core = false;
        for (const command of database) {
            const executable = command?.arguments?.[0];
            if (typeof executable !== 'string' || !isAbsolute(executable) || !local(relative(home, executable))) { continue; }
            const file = process.platform === 'win32' && !/\.exe$/i.test(executable) ? `${executable}.exe` : executable;
            await add(file); ++compilers;
        }
        if (!compilers) { return; }
        const internal = join(home, 'data/internal');
        for (const item of await fs.readdir(internal, { withFileTypes: true })) {
            if (!item.isDirectory()) { continue; }
            const directory = join(internal, item.name); await add(directory);
            for (const child of await fs.readdir(directory, { withFileTypes: true })) {
                const file = join(directory, child.name);
                if (child.isFile() && /^(?:package\.json|installed\.json|library\.properties|boards\.txt|platform(?:\.local)?\.txt)$/.test(child.name)) {
                    await add(file); if (child.name === 'boards.txt') { core = true; }
                } else if (child.isDirectory() && ['bin', 'libexec', 'flags'].includes(child.name)) { await scanTools(file, child.name === 'flags'); }
                else if (child.isDirectory()) {
                    // Profile libraries have one archive-root directory below the install directory.
                    const properties = join(file, 'library.properties');
                    if (await fs.lstat(properties).then(s => s.isFile()).catch(() => false)) { await add(file); await add(properties); }
                }
            }
        }
        if (!core) { return; }
        const file = join(home, receiptName), temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify({ schema: 1, identity, inputs: [...inputs.values()] }), { flag: 'wx' });
            await fs.rename(temporary, file);
        } finally { await fs.rm(temporary, { force: true }); }
    } catch { /* An unusual/moving installation uses the normal bootstrap next time. */ }
}
