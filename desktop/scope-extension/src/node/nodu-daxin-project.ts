// SPDX-License-Identifier: MIT
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { dirname, join } from 'path';
import { DAXIN_TEMPLATES } from '../common/nodu-project-catalog';
import { parseProjectRequest, ProjectRequest } from './nodu-project-generator';

interface Pack { schema: number; provider: string; version: string; contentSha256: string; templates: string[];
    upstream: { commit: string; libraryCommit: string; directoryBuilderSha256: string }; files: Record<string, string> }
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const json = (value: unknown): Buffer => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function safeRelative(name: string): void {
    if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) {
        throw new Error('搭芯模板包含无效路径。');
    }
}
async function readRegular(root: string, relative: string): Promise<Buffer> {
    safeRelative(relative);
    let path = root;
    for (const part of relative.split('/')) {
        path = join(path, part);
        if ((await fs.lstat(path)).isSymbolicLink()) { throw new Error('搭芯模板不能包含符号链接。'); }
    }
    const stat = await fs.stat(path);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) { throw new Error('搭芯模板文件无效或过大。'); }
    return fs.readFile(path);
}

/** Creation uses a verified, bundled snapshot, never a live DACIR checkout. */
export async function createDaxinProject(input: ProjectRequest, packRoot = join(__dirname, '../../resources/daxin')): Promise<{ path: string }> {
    const request = parseProjectRequest({ parent: input.parent, name: input.name, chip: input.chip.id, template: input.template });
    const template = DAXIN_TEMPLATES.find(t => t.id === request.template);
    if (!template || request.chip.id !== 'STM32F103C8Tx') { throw new Error('搭芯模板仅适用于 STM32F103C8T6。'); }
    const pack: Pack = JSON.parse((await readRegular(packRoot, 'manifest.json')).toString('utf8'));
    if (pack.schema !== 1 || pack.provider !== 'dacir' || !pack.templates.includes(template.source)
        || !pack.files || Object.keys(pack.files).length > 4096 || sha(json(pack.files)) !== pack.contentSha256
        || pack.version !== `snapshot-${pack.contentSha256.slice(0, 16)}`) { throw new Error('搭芯模板包版本或摘要无效。'); }
    const entries = new Map<string, Buffer>();
    let total = 0;
    for (const [name, expected] of Object.entries(pack.files)) {
        const data = await readRegular(packRoot, name);
        if (sha(data) !== expected) { throw new Error(`搭芯模板校验失败：${name}`); }
        total += data.length;
        if (total > 32 * 1024 * 1024) { throw new Error('搭芯模板包过大。'); }
        entries.set(name, data);
    }
    const files = new Map<string, Buffer>();
    const prefix = `templates/${template.source}/`;
    for (const [name, data] of entries) {
        if (name.startsWith(prefix)) { files.set(name.slice(prefix.length), data); }
        else if (name.startsWith('support/')) { files.set(name.replace('support/', 'nodu-support/'), data); }
        else if (name.startsWith('licenses/')) { files.set(name, data); }
    }
    const required = (name: string): Buffer => {
        const bytes = entries.get(name);
        if (!bytes) { throw new Error(`搭芯模板缺少 ${name}。`); }
        return bytes;
    };
    const studio = JSON.parse(required(prefix + 'studio.project.json').toString('utf8'));
    if (studio.target?.mcu !== 'STM32F103C8T6' || studio.target?.clockHz !== 72000000 || studio.build?.configHeader !== 'include/config.h') {
        throw new Error('搭芯模板的芯片或时钟配置不受支持。');
    }
    studio.name = request.name; studio.projectId = randomUUID();
    files.set('studio.project.json', json(studio));
    files.set('CMakeLists.txt', required('adapter/CMakeLists.txt'));
    files.set('cmake/gcc-arm-none-eabi.cmake', required('adapter/gcc-arm-none-eabi.cmake'));
    files.set('nodu.json', json({ schema: 1, kind: 'stm32-hal', name: request.name,
        target: { mcu: request.chip.id, board: request.chip.pack }, sdk: 'stm32cube-f1@1.8.7',
        build: { preset: 'debug', external: true, adapter: 'dacir-directory-v1', clockHz: 72000000, printfFloat: false },
        flash: { method: 'stlink' }, monitor: { baud: 115200, encoding: 'utf-8', lineEnding: 'lf' } }));
    // GCC diagnostic presentation flags do not belong to clangd's parser.
    files.set('.clangd', Buffer.from('CompileFlags:\n  Remove: [-fdiagnostics-plain-output, -fdiagnostics-column-unit=*]\n'));
    files.set('.gitignore', Buffer.from('build/\nruns/\n.nodu/\n.studio/\ncompile_commands.json\n'));
    const baseline = Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)).map(([name, bytes]) => [name, sha(bytes)]));
    const origin = { schema: 1, provider: 'dacir', templateId: template.source, packVersion: pack.version,
        packSha256: pack.contentSha256, upstream: pack.upstream, createdAt: new Date().toISOString(), files: baseline };
    files.set('template-origin.json', json(origin));
    files.set('nodu.lock.json', json({ schema: 1, template: { id: request.template, version: pack.version, files: baseline },
        dacir: { packSha256: pack.contentSha256, libraryCommit: pack.upstream.libraryCommit } }));
    const parent = await fs.realpath(request.parent);
    const root = join(parent, request.name);
    try { await fs.mkdir(root); } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') { throw new Error('该位置已有同名项目。'); }
        throw e;
    }
    try {
        for (const [name, data] of files) {
            safeRelative(name);
            const target = join(root, name);
            await fs.mkdir(dirname(target), { recursive: true });
            await fs.writeFile(target, data, { flag: 'wx' });
        }
        return { path: root };
    } catch (e) { await fs.rm(root, { recursive: true, force: true }); throw e; }
}
