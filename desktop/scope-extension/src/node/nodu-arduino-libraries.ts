// SPDX-License-Identifier: MIT
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import { ARDUINO_BUNDLED_LIBRARIES, ARDUINO_CORE_LIBRARIES } from '../common/nodu-arduino-library-catalog';
import { ArduinoLibraryChange, ArduinoLibraryChangeResult, ArduinoLibraryDependency, ArduinoLibraryItem, ArduinoLibraryList, ArduinoLibraryQuery } from '../common/nodu-arduino-libraries-protocol';
import { readArduinoProject } from './nodu-arduino-project';

export interface ArduinoLibraryContext {
    home: string;
    /** Absolute directory containing manifest.json and the bundled archives. */
    resources?: string;
    run(args: string[], quiet?: boolean): Promise<{ code: number; output: string }>;
    cancelled?(): boolean;
}
export interface ArduinoIndexLibrary {
    name: string; version: string; author?: string; sentence?: string; website?: string; architectures?: string[];
    dependencies?: { name: string; version?: string }[];
    url?: string; archiveFileName?: string; checksum?: string; size?: number;
}
interface LibraryProfile {
    path: string; file: string; source: string; profile: string; coreVersion: string; chip: string;
    libraries: ArduinoLibraryDependency[]; local: { dir: string }[];
}
interface Bundle { libraries: ArduinoIndexLibrary[] }
const cancelled = (context: ArduinoLibraryContext): void => { if (context.cancelled?.()) { throw new Error('已停止'); } };
const clean = (text: string | undefined): string => (text ?? '').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 600);
const validName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 _.+-]{0,119}$/.test(name) && /[A-Za-z]/.test(name);
const validVersion = (version: string): boolean => /^\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version);

export function compareArduinoVersions(a: string, b: string): number {
    const split = (v: string): [number[], string | undefined] => { const value = v.split('+')[0], hyphen = value.indexOf('-'); return [(hyphen < 0 ? value : value.slice(0, hyphen)).split('.').map(Number), hyphen < 0 ? undefined : value.slice(hyphen + 1)]; };
    const [av, ap] = split(a), [bv, bp] = split(b);
    for (let i = 0; i < 3; i++) { if ((av[i] ?? 0) !== (bv[i] ?? 0)) { return (av[i] ?? 0) - (bv[i] ?? 0); } }
    if (ap === bp) { return 0; } if (!ap) { return 1; } if (!bp) { return -1; }
    const aa = ap.split('.'), bb = bp.split('.');
    for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
        if (aa[i] === bb[i]) { continue; } if (aa[i] === undefined) { return -1; } if (bb[i] === undefined) { return 1; }
        const an = /^\d+$/.test(aa[i]), bn = /^\d+$/.test(bb[i]);
        return an && bn ? Number(aa[i]) - Number(bb[i]) : an ? -1 : bn ? 1 : aa[i].localeCompare(bb[i]);
    }
    return 0;
}

/** Arduino's documented comparison/boolean grammar; unsupported constraints fail closed. */
export function arduinoVersionSatisfies(version: string, constraint = ''): boolean {
    if (!constraint.trim()) { return true; }
    if (constraint.length > 512) { throw new Error('库版本约束过长。'); }
    const tokens = constraint.match(/\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?(?:\+[\w.-]+)?|>=|<=|!=|==|&&|\|\||[=><!()]/g) ?? [];
    if (tokens.join('') !== constraint.replace(/\s/g, '')) { throw new Error(`不支持的库版本约束：${constraint}`); }
    let at = 0;
    const term = (): boolean => {
        if (tokens[at] === '!') { at++; return !term(); }
        if (tokens[at] === '(') { at++; const v = or(); if (tokens[at++] !== ')') { throw new Error('库版本约束括号不匹配。'); } return v; }
        let op = '='; if (/^(?:>=|<=|!=|==|=|>|<)$/.test(tokens[at] ?? '')) { op = tokens[at++]; }
        const required = tokens[at++]; if (!required || !validVersion(required)) { throw new Error('库版本约束无效。'); }
        const c = compareArduinoVersions(version, required);
        return op === '>' ? c > 0 : op === '>=' ? c >= 0 : op === '<' ? c < 0 : op === '<=' ? c <= 0 : op === '!=' ? c !== 0 : c === 0;
    };
    const and = (): boolean => { let v = term(); while (tokens[at] === '&&') { at++; const next = term(); v = v && next; } return v; };
    const or = (): boolean => { let v = and(); while (tokens[at] === '||') { at++; const next = and(); v = v || next; } return v; };
    const result = or(); if (at !== tokens.length) { throw new Error('库版本约束无效。'); } return result;
}

export async function readArduinoLibraryProfile(path: string): Promise<LibraryProfile> {
    const project = await readArduinoProject(path), file = join(project.path, 'sketch.yaml');
    const source = await fs.readFile(file, 'utf8'), doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length) { throw new Error('sketch.yaml 格式错误。'); }
    const selected = doc.toJS({ maxAliasCount: 20 }).profiles[project.profile];
    const libraries: ArduinoLibraryDependency[] = [], local: { dir: string }[] = [];
    if (selected.libraries !== undefined && !Array.isArray(selected.libraries)) { throw new Error('项目库配置无效。'); }
    for (const entry of selected.libraries ?? []) {
        if (typeof entry === 'object' && entry && typeof entry.dir === 'string') { local.push({ dir: entry.dir }); continue; }
        const raw = typeof entry === 'string' ? entry : entry?.dependency;
        const match = typeof raw === 'string' ? /^(.+) \(([^()]+)\)$/.exec(raw) : null;
        if (!match || !validName(match[1]) || !validVersion(match[2])) { throw new Error('项目库必须固定完整版本。'); }
        if (libraries.some(library => library.name === match[1])) { throw new Error(`项目中重复配置库：${match[1]}`); }
        libraries.push({ name: match[1], version: match[2], direct: typeof entry === 'string' });
    }
    return { path: project.path, file, source, profile: project.profile, coreVersion: /\(([^)]+)\)/.exec(selected.platforms[0].platform)![1], chip: project.chip, libraries, local };
}

async function bundle(context: ArduinoLibraryContext): Promise<Bundle> {
    const root = context.resources ?? join(__dirname, '../../resources/arduino/libraries');
    const parsed = JSON.parse(await fs.readFile(join(root, 'manifest.json'), 'utf8')) as Bundle;
    if (!Array.isArray(parsed.libraries)) { throw new Error('内置库清单损坏。'); }
    return parsed;
}
export async function prepareBundledArduinoLibraries(context: ArduinoLibraryContext): Promise<void> {
    const root = context.resources ?? join(__dirname, '../../resources/arduino/libraries');
    const target = join(context.home, 'downloads', 'libraries'); await fs.mkdir(target, { recursive: true });
    const bundled = await bundle(context);
    for (const library of bundled.libraries) {
        cancelled(context);
        const name = library.archiveFileName;
        if (!name || basename(name) !== name || !/^SHA-256:[a-f0-9]{64}$/i.test(library.checksum ?? '')) { throw new Error('内置库清单无效。'); }
        const data = await fs.readFile(join(root, name));
        if (library.size !== data.length || `SHA-256:${createHash('sha256').update(data).digest('hex')}` !== library.checksum) { throw new Error(`内置库校验失败：${library.name}`); }
        const destination = join(target, name);
        try { const cached = await fs.readFile(destination); if (createHash('sha256').update(cached).digest('hex') === library.checksum.slice(8)) { continue; } } catch { /* Missing/damaged cache is replaced from verified bundle. */ }
        const temporary = join(target, `.${name}.${randomUUID()}.tmp`);
        try { await fs.writeFile(temporary, data, { flag: 'wx' }); cancelled(context); await fs.rename(temporary, destination); }
        finally { await fs.rm(temporary, { force: true }); }
    }
    // A shipped index may predate one of the pinned library releases. Preserve other entries while
    // inserting the verified bundle records, so the CLI can actually resolve all shipped archives offline.
    const data = join(context.home, 'data'); await fs.mkdir(data, { recursive: true }); cancelled(context);
    const file = join(data, 'library_index.json');
    const before = await fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') { return undefined; } throw error; });
    const document = before === undefined ? { libraries: [] as ArduinoIndexLibrary[], noduBundledOnly: true } : JSON.parse(before);
    if (!document || !Array.isArray(document.libraries)) { throw new Error('本地 Arduino 库索引无效。'); }
    let changed = before === undefined;
    for (const library of bundled.libraries) {
        const at = document.libraries.findIndex((entry: ArduinoIndexLibrary) => entry.name === library.name && entry.version === library.version);
        if (at < 0) { document.libraries.push(library); changed = true; }
        else if (JSON.stringify(document.libraries[at]) !== JSON.stringify(library)) { document.libraries[at] = library; changed = true; }
    }
    if (changed) {
        const temporary = `${file}.${randomUUID()}.tmp`;
        try {
            await fs.writeFile(temporary, JSON.stringify(document), { flag: 'wx' }); cancelled(context);
            if (await fs.readFile(file, 'utf8').catch(() => undefined) !== before) { throw new Error('库索引已更新，请重试。'); }
            await fs.rename(temporary, file);
            // The merged local index is authenticated by the packaged library hashes, not the old snapshot signature.
            await fs.rm(`${file}.sig`, { force: true });
        } finally { await fs.rm(temporary, { force: true }); }
    }
}

const indexCache = new Map<string, { stamp: string; records: ArduinoIndexLibrary[]; offline: boolean }>();
const groupCache = new WeakMap<ArduinoIndexLibrary[], Map<string, ArduinoIndexLibrary[]>>();
async function index(context: ArduinoLibraryContext): Promise<{ records: ArduinoIndexLibrary[]; offline: boolean }> {
    const bundled = (await bundle(context)).libraries;
    let records: ArduinoIndexLibrary[] = [], offline = false;
    const file = join(context.home, 'data', 'library_index.json'), key = `${file}|${context.resources ?? ''}`;
    const stat = await fs.stat(file).catch(() => undefined), stamp = `${stat?.mtimeMs}:${stat?.size}`;
    const cached = indexCache.get(key); if (cached?.stamp === stamp) { return cached; }
    try {
        if (!stat || stat.size > 160 * 1024 * 1024) { throw new Error('库索引不可用。'); }
        const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as { libraries: ArduinoIndexLibrary[]; noduBundledOnly?: boolean };
        records = parsed.libraries; offline = parsed.noduBundledOnly === true;
        if (!Array.isArray(records)) { throw new Error('库索引格式错误。'); }
    } catch { offline = true; }
    const mapped = new Map<string, ArduinoIndexLibrary>();
    for (const record of [...records, ...bundled]) {
        if (typeof record.name !== 'string' || !validName(record.name) || typeof record.version !== 'string' || !validVersion(record.version)) { continue; }
        if (record.architectures !== undefined && (!Array.isArray(record.architectures) || !record.architectures.every(a => typeof a === 'string'))) { continue; }
        if (record.dependencies !== undefined && (!Array.isArray(record.dependencies) || !record.dependencies.every(d => d && typeof d.name === 'string' && (d.version === undefined || typeof d.version === 'string')))) { continue; }
        mapped.set(`${record.name}@${record.version}`, record);
    }
    const result = { stamp, records: [...mapped.values()], offline }; indexCache.set(key, result);
    if (indexCache.size > 4) { indexCache.delete(indexCache.keys().next().value!); }
    return result;
}
function compatible(record: ArduinoIndexLibrary): boolean { return !record.architectures?.length || record.architectures.some(a => a === '*' || a === 'esp32'); }
function group(records: ArduinoIndexLibrary[]): Map<string, ArduinoIndexLibrary[]> {
    const cached = groupCache.get(records); if (cached) { return cached; }
    const groups = new Map<string, ArduinoIndexLibrary[]>();
    for (const record of records) { const versions = groups.get(record.name) ?? []; versions.push(record); groups.set(record.name, versions); }
    for (const versions of groups.values()) { versions.sort((a, b) => compareArduinoVersions(b.version, a.version)); }
    groupCache.set(records, groups); return groups;
}

export async function listArduinoLibraries(context: ArduinoLibraryContext, query: ArduinoLibraryQuery): Promise<ArduinoLibraryList> {
    try {
        const profile = await readArduinoLibraryProfile(query.path); let refreshError: string | undefined;
        if (query.refresh) {
            try { const result = await context.run(['lib', 'update-index']); if (result.code) { refreshError = '库索引更新失败，正在显示本地记录。'; } }
            catch { refreshError = '库索引更新失败，正在显示本地记录。'; }
            cancelled(context);
        }
        const { records, offline } = await index(context), grouped = group(records), items: ArduinoLibraryItem[] = [];
        const installed = new Map(profile.libraries.map(entry => [entry.name, entry]));
        for (const [name, versions] of grouped) {
            const release = versions.find(compatible) ?? versions[0], used = installed.get(name);
            const bundled = ARDUINO_BUNDLED_LIBRARIES.find(entry => entry.name === name);
            const latestVersion = release.version;
            items.push({ name, author: clean(release.author), summary: clean(release.sentence), website: /^https?:\/\//.test(release.website ?? '') ? release.website : undefined,
                versions: versions.filter(compatible).map(v => v.version), latestVersion, installedVersion: used?.version,
                bundledVersion: bundled?.version, bundled: !!bundled, core: false, compatible: compatible(release), architectures: release.architectures ?? ['*'],
                dependencies: (versions.find(v => v.version === used?.version)?.dependencies ?? release.dependencies ?? []).map(dep => ({ name: dep.name, version: installed.get(dep.name)?.version ?? dep.version ?? '', direct: false })),
                updateAvailable: !!used && compareArduinoVersions(latestVersion, used.version) > 0 });
        }
        for (const [name, summary] of ARDUINO_CORE_LIBRARIES) {
            // A third-party same-name library must not impersonate a Core API.
            const duplicate = items.findIndex(item => item.name === name); if (duplicate >= 0) { items.splice(duplicate, 1); }
            // Core 3.3.12 gates SD_MMC on SOC_SDMMC_HOST_SUPPORTED; C3 uses the separate SPI SD API.
            if (name === 'SD_MMC' && !['esp32', 'esp32s3', 'esp32p4'].includes(profile.chip)) { continue; }
            items.push({ name, author: 'Espressif', summary, versions: [profile.coreVersion], latestVersion: profile.coreVersion, installedVersion: profile.coreVersion,
                bundledVersion: profile.coreVersion, bundled: true, core: true, compatible: true, architectures: ['esp32'], dependencies: [], updateAvailable: false });
        }
        for (const used of profile.libraries) {
            if (!items.some(item => item.name === used.name)) { items.push({ name: used.name, author: '', summary: '', versions: [used.version], latestVersion: used.version,
                installedVersion: used.version, bundled: false, core: false, compatible: true, architectures: [], dependencies: [], updateAvailable: false }); }
        }
        const terms = clean(query.query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
        const filtered = items.filter(item => terms.every(term => `${item.name} ${item.author} ${item.summary}`.toLocaleLowerCase().includes(term))
            && (query.filter === 'installed' ? !!item.installedVersion : query.filter === 'updates' ? item.updateAvailable : query.filter === 'bundled' ? item.bundled : true));
        filtered.sort((a, b) => Number(b.bundled) - Number(a.bundled) || a.name.localeCompare(b.name));
        const offset = Math.max(0, Math.floor(Number(query.offset) || 0)), limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 40)));
        return { items: filtered.slice(offset, offset + limit), total: filtered.length, ...(offline || refreshError ? { offline: true } : {}), ...(refreshError ? { error: refreshError } : {}) };
    } catch (error) { return { items: [], total: 0, error: error instanceof Error ? error.message : String(error) }; }
}

/** Backtracking across constraints keeps existing pins unless an explicitly requested change requires a dependency change. */
export function resolveArduinoLibraries(records: ArduinoIndexLibrary[], direct: ArduinoLibraryDependency[], existing: ArduinoLibraryDependency[] = []): ArduinoLibraryDependency[] {
    const grouped = group(records), preferred = new Map(existing.map(entry => [entry.name, entry.version]));
    const initial = new Map<string, string[]>(); for (const entry of direct) { initial.set(entry.name, [`=${entry.version}`]); }
    let attempts = 0;
    const solve = (selected: Map<string, ArduinoIndexLibrary>, constraints: Map<string, string[]>): Map<string, ArduinoIndexLibrary> | undefined => {
        if (++attempts > 10_000 || constraints.size > 100) { throw new Error('库依赖过于复杂，请减少依赖或固定兼容版本。'); }
        for (const [name, value] of selected) { if (!(constraints.get(name) ?? []).every(c => arduinoVersionSatisfies(value.version, c))) { return undefined; } }
        const pending = [...constraints.keys()].find(name => !selected.has(name)); if (!pending) { return selected; }
        const candidates = (grouped.get(pending) ?? []).filter(record => compatible(record) && constraints.get(pending)!.every(c => arduinoVersionSatisfies(record.version, c)));
        const prior = preferred.get(pending) ?? ARDUINO_BUNDLED_LIBRARIES.find(entry => entry.name === pending)?.version;
        candidates.sort((a, b) => Number(b.version === prior) - Number(a.version === prior) || compareArduinoVersions(b.version, a.version));
        for (const candidate of candidates) {
            const next = new Map(selected); next.set(pending, candidate);
            const requested = new Map([...constraints].map(([name, values]) => [name, [...values]]));
            for (const dependency of candidate.dependencies ?? []) {
                if (!validName(dependency.name)) { throw new Error('库依赖名称无效。'); }
                requested.set(dependency.name, [...requested.get(dependency.name) ?? [], dependency.version ?? '']);
            }
            const found = solve(next, requested); if (found) { return found; }
        }
        return undefined;
    };
    const result = solve(new Map(), initial);
    if (!result) { throw new Error('库版本或依赖不兼容，请选择其他版本；项目依赖保持原状。'); }
    return [...result].map(([name, record]) => ({ name, version: record.version, direct: direct.some(entry => entry.name === name) }))
        .sort((a, b) => Number(b.direct) - Number(a.direct) || a.name.localeCompare(b.name));
}

async function atomicProfile(context: ArduinoLibraryContext, profile: LibraryProfile, libraries: ArduinoLibraryDependency[]): Promise<void> {
    const doc = parseDocument(profile.source, { uniqueKeys: true });
    const originalData = doc.toJS({ maxAliasCount: 20 });
    const path = ['profiles', profile.profile, 'libraries'], sequence = doc.getIn(path, true);
    const value = (entry: ArduinoLibraryDependency): string | { dependency: string } => entry.direct
        ? `${entry.name} (${entry.version})` : { dependency: `${entry.name} (${entry.version})` };
    if (isSeq(sequence)) {
        // Keep existing nodes in place: rebuilding the list loses comments, local-path
        // attributes and scalar styles even for libraries the user did not change.
        const rawEntries = originalData.profiles[profile.profile].libraries;
        const remaining = new Map(libraries.map(entry => [entry.name, entry]));
        sequence.items = sequence.items.flatMap((node, index) => {
            const raw = rawEntries[index];
            if (raw && typeof raw === 'object' && typeof raw.dir === 'string') { return [node]; }
            const oldValue = typeof raw === 'string' ? raw : raw?.dependency;
            const name = /^(.+) \(([^()]+)\)$/.exec(oldValue)?.[1], entry = name && remaining.get(name);
            if (!entry) { return []; }
            remaining.delete(entry.name);
            const updated = `${entry.name} (${entry.version})`;
            if (entry.direct && isScalar(node)) { node.value = updated; return [node]; }
            if (!entry.direct && isMap(node)) { node.set('dependency', updated); return [node]; }
            if (oldValue === updated && entry.direct === (typeof raw === 'string')) { return [node]; }
            const replacement = doc.createNode(value(entry));
            if (isNode(node)) {
                replacement.commentBefore = node.commentBefore;
                replacement.comment = node.comment;
                replacement.spaceBefore = node.spaceBefore;
                // Promoting a transitive dependency also retains its version comment.
                const dependency = isMap(node) ? node.get('dependency', true) : undefined;
                if (isScalar(dependency) && dependency.comment) {
                    replacement.comment = [replacement.comment, dependency.comment].filter(Boolean).join('\n');
                }
            }
            return [replacement];
        });
        for (const entry of remaining.values()) { sequence.add(doc.createNode(value(entry))); }
    } else {
        doc.setIn(path, libraries.map(value));
    }
    let serialized: string;
    try {
        serialized = doc.toString();
        const after = parseDocument(serialized, { uniqueKeys: true }).toJS({ maxAliasCount: 20 });
        // YAML anchors may share a library node with another profile. Reject edits
        // that would silently change that profile or leave a dangling alias.
        const expected = JSON.parse(JSON.stringify(originalData));
        expected.profiles[profile.profile].libraries = after.profiles[profile.profile].libraries;
        if (JSON.stringify(after) !== JSON.stringify(expected)) { throw new Error('shared YAML anchor'); }
    } catch {
        throw new Error('库配置与其他配置共享 YAML 引用，请先将引用展开后重试。');
    }
    const temporary = join(dirname(profile.file), `.sketch-${randomUUID()}.tmp`);
    try {
        await fs.writeFile(temporary, serialized, { flag: 'wx', mode: (await fs.stat(profile.file)).mode });
        cancelled(context);
        if (await fs.readFile(profile.file, 'utf8') !== profile.source) { throw new Error('sketch.yaml 已被修改，请刷新后重试。'); }
        await fs.rename(temporary, profile.file);
    } finally { await fs.rm(temporary, { force: true }); }
}

export async function changeArduinoLibrary(context: ArduinoLibraryContext, request: ArduinoLibraryChange): Promise<ArduinoLibraryChangeResult> {
    try {
        cancelled(context);
        if (!validName(request.name) || !['add', 'remove', 'update'].includes(request.action)) { throw new Error('无效的库操作。'); }
        if (ARDUINO_CORE_LIBRARIES.some(([name]) => name === request.name)) { throw new Error('此库随 ESP32 Core 提供。'); }
        const profile = await readArduinoLibraryProfile(request.path), { records } = await index(context);
        let direct = profile.libraries.filter(entry => entry.direct && entry.name !== request.name);
        if (request.action !== 'remove') {
            if (!request.version || !validVersion(request.version)) { throw new Error('请选择准确的库版本。'); }
            direct = [...direct, { name: request.name, version: request.version, direct: true }];
        }
        const resolved = resolveArduinoLibraries(records, direct, profile.libraries);
        if (request.action === 'remove' && resolved.some(entry => entry.name === request.name)) { throw new Error('其他项目库仍依赖此库，无法移除。'); }
        const normalized = (values: ArduinoLibraryDependency[]): string => JSON.stringify([...values].sort((a, b) => a.name.localeCompare(b.name)));
        if (normalized(resolved) === normalized(profile.libraries)) { return { ok: true, changed: false, dependencies: resolved }; }
        await prepareBundledArduinoLibraries(context);
        for (const dependency of resolved) {
            cancelled(context);
            const result = await context.run(['lib', 'download', `${dependency.name}@${dependency.version}`]);
            if (result.code) { throw new Error(`无法准备 ${dependency.name} ${dependency.version}，项目依赖保持原状。`); }
        }
        cancelled(context); await atomicProfile(context, profile, resolved);
        return { ok: true, changed: true, dependencies: resolved };
    } catch (error) { return { ok: false, ...(context.cancelled?.() ? { cancelled: true } : {}), error: error instanceof Error ? error.message : String(error) }; }
}
