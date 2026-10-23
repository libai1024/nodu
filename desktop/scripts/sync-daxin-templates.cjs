// SPDX-License-Identifier: MIT
// Release-time snapshot sync only. Never writes to an existing user project or DACIR.
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const desktop = path.resolve(__dirname, '..');
const DEFAULT_OUTPUT = path.join(desktop, 'scope-extension/resources/daxin');
const TEMPLATES = ['temperature-humidity', 'warehouse', 'esp8266'];
const hash = data => createHash('sha256').update(data).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
function safeRelative(name) {
    if (typeof name !== 'string' || !name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').some(p => !p || p === '.' || p === '..')) throw new Error(`Unsafe template path: ${name}`);
    return name;
}
async function tree(root, prefix = '') {
    const files = {};
    for (const item of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = safeRelative(prefix + item.name);
        if (item.isSymbolicLink()) throw new Error(`Symlink not allowed: ${relative}`);
        if (item.isDirectory()) Object.assign(files, await tree(path.join(root, item.name), relative + '/'));
        else if (item.isFile()) files[relative] = await fs.readFile(path.join(root, item.name));
        else throw new Error(`Non-file template entry: ${relative}`);
    }
    return files;
}
async function regular(root, relative) {
    safeRelative(relative);
    let current = root;
    for (const part of relative.split('/')) {
        current = path.join(current, part);
        if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink not allowed: ${relative}`);
    }
    if (!(await fs.stat(current)).isFile()) throw new Error(`Not a file: ${relative}`);
    return fs.readFile(current);
}
async function snapshot(source) {
    source = await fs.realpath(source);
    const recipe = JSON.parse(await fs.readFile(path.join(__dirname, 'daxin/recipe-lock.json'), 'utf8'));
    const builderHash = hash(await regular(source, 'firmware/directory_build.py'));
    if (builderHash !== recipe.directoryBuilderSha256) throw new Error('DACIR build recipe changed. Review the CMake adapter and update recipe-lock.json after build verification.');
    const files = {};
    const library = JSON.parse(await regular(source, 'firmware/library/studio.lock.json'));
    for (const id of TEMPLATES) {
        const entries = await tree(path.join(source, 'templates/studio', id));
        const declared = JSON.parse(entries['template-sources.json']);
        if (declared.libraryCommit !== library.commit) throw new Error(`${id}: driver lock mismatch`);
        const expected = Object.keys(declared.files).sort();
        const actual = Object.keys(entries).filter(n => n !== 'template-sources.json').sort();
        if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${id}: source file list differs from template-sources.json`);
        for (const [name, digest] of Object.entries(declared.files)) {
            safeRelative(name);
            if (!entries[name] || hash(entries[name]) !== digest) throw new Error(`${id}: source hash mismatch: ${name}`);
        }
        const manifest = JSON.parse(entries['studio.project.json']);
        if (manifest.target?.mcu !== 'STM32F103C8T6' || manifest.target?.clockHz !== 72000000 || manifest.build?.configHeader !== 'include/config.h') throw new Error(`${id}: unsupported template profile`);
        for (const [name, data] of Object.entries(entries)) files[`templates/${id}/${name}`] = data;
    }
    const support = {
        'runtime.c': 'firmware/src/runtime.c', 'hal_timebase.c': 'firmware/src/hal_timebase.c',
        'stm32f103c8.ld': 'firmware/stm32f103c8.ld', 'stm32f1xx_hal_conf.h': 'firmware/library/include/stm32f1xx_hal_conf.h',
        'timebase_accumulator.h': 'firmware/library/include/timebase_accumulator.h',
    };
    for (const [name, input] of Object.entries(support)) files[`support/${name}`] = await regular(source, input);
    files['licenses/DACIR-MIT.txt'] = await regular(source, 'LICENSE');
    files['licenses/NUN-DX-AGPL.txt'] = await regular(source, 'templates/studio/temperature-humidity/drivers/nun-dx/LICENSE');
    files['licenses/NOTICE.md'] = Buffer.from(`# DACIR template snapshot\n\nTemplate sources and driver notices are retained verbatim. Teaching templates, HAL timebase and NUN_DX use AGPL-3.0-only. Support headers copied from firmware/library retain that directory's AGPL-3.0-only license; runtime.c and the linker script retain the DACIR repository MIT license; glyph licenses remain under drivers/nun-dx/licenses. The Nodu CMake adapter is MIT. ST HAL/CMSIS is supplied by the separately licensed Nodu toolkit. This snapshot does not bundle the DACIR simulator or desktop shell.\n`);
    files['adapter/CMakeLists.txt'] = await fs.readFile(path.join(__dirname, 'daxin/CMakeLists.txt'));
    files['adapter/gcc-arm-none-eabi.cmake'] = await fs.readFile(path.join(desktop, 'scope-extension/resources/stm32/templates/common/cmake/arm-gcc.cmake'));
    const fileHashes = Object.fromEntries(Object.keys(files).sort().map(n => [n, hash(files[n])]));
    const contentSha256 = hash(json(fileHashes));
    const manifest = { schema: 1, provider: 'dacir', version: `snapshot-${contentSha256.slice(0, 16)}`, contentSha256,
        upstream: { commit: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), directoryBuilderSha256: builderHash, libraryCommit: library.commit },
        templates: TEMPLATES, files: fileHashes };
    files['manifest.json'] = json(manifest);
    return { files, manifest };
}
async function sync(source, output = DEFAULT_OUTPUT, check = true) {
    const { files, manifest } = await snapshot(source);
    let current = {};
    try { current = await tree(output); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const changes = [...new Set([...Object.keys(files), ...Object.keys(current)])].filter(n => !current[n] || !files[n] || !current[n].equals(files[n]));
    if (check || changes.length === 0) return { version: manifest.version, changes, updated: false };
    await fs.mkdir(path.dirname(output), { recursive: true });
    const stage = output + '.stage-' + randomUUID(); const backup = output + '.previous-' + randomUUID();
    await fs.mkdir(stage);
    let moved = false;
    try {
        for (const [name, bytes] of Object.entries(files)) { const dest = path.join(stage, name); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, bytes, { flag: 'wx' }); }
        try { await fs.rename(output, backup); moved = true; } catch (e) { if (e.code !== 'ENOENT') throw e; }
        try { await fs.rename(stage, output); } catch (e) { if (moved) { await fs.rename(backup, output); moved = false; } throw e; }
        if (moved) await fs.rm(backup, { recursive: true });
        return { version: manifest.version, changes, updated: true };
    } finally { await fs.rm(stage, { recursive: true, force: true }); }
}
module.exports = { sync, snapshot, safeRelative };
if (require.main === module) {
    const args = process.argv.slice(2); const index = args.indexOf('--source');
    const source = index >= 0 ? args[index + 1] : process.env.DAXIN_SOURCE;
    if (!source || (args.includes('--write') && args.includes('--check'))) { console.error('Usage: node scripts/sync-daxin-templates.cjs --source /path/to/DACIR [--check | --write]'); process.exitCode = 2; }
    else sync(source, DEFAULT_OUTPUT, !args.includes('--write')).then(result => {
        console.log(JSON.stringify(result, null, 2));
        if (!args.includes('--write') && result.changes.length) process.exitCode = 1;
    }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
