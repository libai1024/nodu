// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createDaxinProject } = require('../scope-extension/lib/node/nodu-daxin-project');
const { parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
const { DAXIN_TEMPLATES, projectTemplates } = require('../scope-extension/lib/common/nodu-project-catalog');
const { sync, safeRelative } = require('./sync-daxin-templates.cjs');
const packRoot = path.resolve(__dirname, '../scope-extension/resources/daxin');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const request = (parent, id = DAXIN_TEMPLATES[0].id, name = 'project') => parseProjectRequest({ parent, chip: 'STM32F103C8Tx', template: id, name });

test('templates are F103C8-only; existing default stays first', () => {
    assert.equal(projectTemplates('stm32f103')[0].name, '默认项目');
    assert.equal(projectTemplates('stm32f103', 'STM32F103C8Tx').length, 5);
    for (const chip of ['k210', 'STM32F407ZGTx', 'esp32', 'esp32s3']) {
        assert.throws(() => parseProjectRequest({ parent: os.tmpdir(), chip, template: 'dacir-esp8266', name: 'hello' }));
    }
    assert.equal(projectTemplates('stm32f103', 'STM32F103RBTx').length, 2);
    for (const name of ['../x', '/tmp/x', 'a\\b', 'a//b', 'C:foo']) assert.throws(() => safeRelative(name));
});
test('all templates preserve upstream source/circuit bytes and lock independent copies', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-daxin-'));
    try {
        for (const t of DAXIN_TEMPLATES) {
            const result = await createDaxinProject(request(root, t.id, t.source));
            for (const file of ['src/main.c', 'include/config.h', 'circuit.json', 'layout.json', 'environment.json']) {
                assert.deepEqual(await fs.readFile(path.join(result.path, file)), await fs.readFile(path.join(packRoot, 'templates', t.source, file)));
            }
            assert.match(await fs.readFile(path.join(result.path, '.clangd'), 'utf8'), /Remove: \[.*-fdiagnostics-plain-output.*-fdiagnostics-column-unit=\*/);
            const metadata = JSON.parse(await fs.readFile(path.join(result.path, 'nodu.json')));
            assert.equal(metadata.target.mcu, 'STM32F103C8Tx');
            assert.equal(metadata.build.external, true);
            const origin = JSON.parse(await fs.readFile(path.join(result.path, 'template-origin.json')));
            for (const [name, digest] of Object.entries(origin.files)) assert.equal(hash(await fs.readFile(path.join(result.path, name))), digest);
            await fs.appendFile(path.join(result.path, 'src/main.c'), '\n/* user edit */\n');
            await assert.rejects(createDaxinProject(request(root, t.id, t.source)), /同名项目/);
            assert.match(await fs.readFile(path.join(result.path, 'src/main.c'), 'utf8'), /user edit/);
            const second = await createDaxinProject(request(root, t.id, t.source + '-second'));
            assert.doesNotMatch(await fs.readFile(path.join(second.path, 'src/main.c'), 'utf8'), /user edit/);
            const a = JSON.parse(await fs.readFile(path.join(result.path, 'studio.project.json')));
            const b = JSON.parse(await fs.readFile(path.join(second.path, 'studio.project.json')));
            assert.notEqual(a.projectId, b.projectId);
        }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('corrupt or symlinked template pack fails before creating a project', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-daxin-invalid-'));
    try {
        const pack = path.join(root, 'pack'); await fs.cp(packRoot, pack, { recursive: true });
        const file = path.join(pack, 'templates/temperature-humidity/src/main.c');
        await fs.appendFile(file, 'tampered');
        await assert.rejects(createDaxinProject(request(root), pack), /校验失败/);
        await assert.rejects(fs.stat(path.join(root, 'project')), { code: 'ENOENT' });
        await fs.rm(file); await fs.symlink(path.join(packRoot, 'templates/temperature-humidity/src/main.c'), file);
        await assert.rejects(createDaxinProject(request(root), pack), /符号链接/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('concurrent creation has one winner without deleting its files', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-daxin-race-'));
    try {
        const results = await Promise.allSettled([createDaxinProject(request(root)), createDaxinProject(request(root))]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert((await fs.readFile(path.join(root, 'project/src/main.c'))).length);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test('release sync detects changes and never alters existing projects', { skip: !process.env.DAXIN_SOURCE }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-daxin-sync-'));
    try {
        const output = path.join(root, 'pack');
        const first = await sync(process.env.DAXIN_SOURCE, output, false);
        assert(first.updated);
        assert.equal((await sync(process.env.DAXIN_SOURCE, output, true)).changes.length, 0);
        const created = await createDaxinProject(request(root), output);
        const main = path.join(created.path, 'src/main.c');
        await fs.appendFile(main, '\n/* retained user change */\n');
        const before = await fs.readFile(main);
        await fs.appendFile(path.join(output, 'templates/temperature-humidity/src/main.c'), 'corrupt');
        assert((await sync(process.env.DAXIN_SOURCE, output, true)).changes.includes('templates/temperature-humidity/src/main.c'));
        assert((await sync(process.env.DAXIN_SOURCE, output, false)).updated);
        assert.deepEqual(await fs.readFile(main), before);
        assert.equal((await sync(process.env.DAXIN_SOURCE, output, true)).changes.length, 0);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('upstream version upgrade changes new projects only; invalid upstream leaves the pack intact', { skip: !process.env.DAXIN_SOURCE }, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-daxin-upgrade-'));
    try {
        const source = path.join(root, 'upstream'); await fs.mkdir(source);
        for (const relative of ['templates/studio', 'firmware/directory_build.py', 'firmware/src/runtime.c', 'firmware/src/hal_timebase.c', 'firmware/stm32f103c8.ld', 'firmware/library/include', 'firmware/library/studio.lock.json', 'LICENSE']) {
            await fs.mkdir(path.dirname(path.join(source, relative)), { recursive: true });
            await fs.cp(path.join(process.env.DAXIN_SOURCE, relative), path.join(source, relative), { recursive: true });
        }
        execFileSync('git', ['init', '--quiet', source]);
        execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--allow-empty', '-m', 'fixture']);
        const output = path.join(root, 'pack');
        const first = await sync(source, output, false);
        const old = await createDaxinProject(request(root, undefined, 'old-project'), output);
        const oldOrigin = await fs.readFile(path.join(old.path, 'template-origin.json'));
        const main = path.join(old.path, 'src/main.c'); await fs.appendFile(main, '\n/* local customization */\n');
        const oldMain = await fs.readFile(main);
        const upstreamMain = path.join(source, 'templates/studio/temperature-humidity/src/main.c');
        await fs.appendFile(upstreamMain, '\n/* upstream revision 2 */\n');
        const currentPack = await fs.readFile(path.join(output, 'manifest.json'));
        await assert.rejects(sync(source, output, false), /source hash mismatch/);
        assert.deepEqual(await fs.readFile(path.join(output, 'manifest.json')), currentPack);
        const sourcesFile = path.join(source, 'templates/studio/temperature-humidity/template-sources.json');
        const sources = JSON.parse(await fs.readFile(sourcesFile)); sources.files['src/main.c'] = hash(await fs.readFile(upstreamMain));
        await fs.writeFile(sourcesFile, JSON.stringify(sources, null, 2) + '\n');
        const second = await sync(source, output, false);
        assert.notEqual(second.version, first.version);
        const next = await createDaxinProject(request(root, undefined, 'new-project'), output);
        assert.match(await fs.readFile(path.join(next.path, 'src/main.c'), 'utf8'), /upstream revision 2/);
        assert.deepEqual(await fs.readFile(main), oldMain);
        assert.deepEqual(await fs.readFile(path.join(old.path, 'template-origin.json')), oldOrigin);
        await fs.appendFile(path.join(source, 'firmware/directory_build.py'), '\n# changed recipe\n');
        await assert.rejects(sync(source, output, false), /build recipe changed/);
        assert.equal(JSON.parse(await fs.readFile(path.join(output, 'manifest.json'))).version, second.version);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
