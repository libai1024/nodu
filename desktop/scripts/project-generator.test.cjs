// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSourceProject, parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
const { PROJECT_CHIPS } = require('../scope-extension/lib/common/nodu-project-catalog');
test('chip projects create portable K210 and every ESP32 target without a board', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-projects-'));
    try {
        for (const chip of PROJECT_CHIPS.filter(c => !c.pack)) {
            for (const template of ['empty', 'hello']) {
                const request = parseProjectRequest({ parent, name: `test-${chip.id}-${template}`, chip: chip.id, template });
                const { path: root } = await createSourceProject(request);
                const metadata = JSON.parse(await fs.readFile(path.join(root, 'nodu.json'), 'utf8'));
                assert.deepEqual(metadata.target, { mcu: chip.id });
                if (chip.family === 'esp32') {
                    const cmake = await fs.readFile(path.join(root, 'CMakeLists.txt'), 'utf8');
                    assert(cmake.includes(`set(IDF_TARGET "${chip.id}")`));
                    assert(cmake.includes('$ENV{IDF_PATH}/tools/cmake/project.cmake'));
                    assert(!cmake.includes(parent));
                    const tasks = JSON.parse(await fs.readFile(path.join(root, '.theia/tasks.json'), 'utf8')).tasks;
                    assert.deepEqual(tasks.map(t => t.args), [['build'], ['flash'], ['monitor'], ['menuconfig']]);
                    assert(tasks.every(t => t.type === 'process'));
                    assert((await fs.readFile(path.join(root, 'main/main.c'), 'utf8')).includes('app_main'));
                } else {
                    assert((await fs.readFile(path.join(root, 'main.py'), 'utf8')).includes(template === 'hello' ? 'print(' : '# MaixPy'));
                }
                await assert.rejects(createSourceProject(request), /同名项目/);
                assert.equal(JSON.parse(await fs.readFile(path.join(root, 'nodu.json'), 'utf8')).name, request.name);
            }
        }
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
test('reject traversal, reserved names, unknown chips and templates before writing', () => {
    const args = { parent: os.tmpdir(), name: 'hello', chip: 'k210', template: 'empty' };
    for (const patch of [{ name: '../escape' }, { name: 'CON' }, { name: 'x'.repeat(41) }, { chip: 'board-unknown' }, { template: 'blink' }, { parent: './relative' }, { parent: '/bad\0name' }]) {
        assert.throws(() => parseProjectRequest({ ...args, ...patch }));
    }
    for (const chip of PROJECT_CHIPS.filter(c => c.pack)) {
        assert.match(parseProjectRequest({ ...args, chip: chip.id }).chip.pack, /^chip-/);
    }
});
test('same-name concurrent creates have one winner', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-projects-race-'));
    try {
        const args = parseProjectRequest({ parent, name: 'hello', chip: 'k210', template: 'hello' });
        const result = await Promise.allSettled([createSourceProject(args), createSourceProject(args)]);
        assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
        assert((await fs.readFile(path.join(parent, 'hello/main.py'), 'utf8')).includes('print('));
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
