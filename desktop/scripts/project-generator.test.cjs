// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSourceProject, parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
const { PROJECT_CHIPS, ESP32_ARDUINO_CORE_VERSION, ESP32_ARDUINO_INDEX_URL } = require('../scope-extension/lib/common/nodu-project-catalog');
test('chip projects preserve portable K210 and explicit ESP-IDF targets without a board', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-projects-'));
    try {
        for (const chip of PROJECT_CHIPS.filter(c => !c.pack)) {
            for (const template of ['empty', 'hello']) {
                const request = parseProjectRequest({ parent, name: `test-${chip.id}-${template}`, chip: chip.id, template, ...(chip.family === 'esp32' ? { framework: 'esp-idf' } : {}) });
                const { path: root } = await createSourceProject(request);
                const metadata = JSON.parse(await fs.readFile(path.join(root, 'nodu.json'), 'utf8'));
                assert.deepEqual(metadata.target, { mcu: chip.id });
                if (chip.family === 'esp32') {
                    assert.equal(metadata.kind, 'esp-idf');
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
test('ESP32 defaults to Arduino with a standard primary sketch and pinned portable profile', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-arduino-projects-'));
    try {
        for (const chip of PROJECT_CHIPS.filter(c => c.family === 'esp32')) {
            for (const template of ['empty', 'hello']) {
                const name = `test-${chip.id}-${template}`;
                const request = parseProjectRequest({ parent, name, chip: chip.id, template });
                assert.equal(request.framework, 'arduino');
                const { path: root } = await createSourceProject(request);
                const metadata = JSON.parse(await fs.readFile(path.join(root, 'nodu.json'), 'utf8'));
                assert.equal(metadata.kind, 'esp32-arduino');
                assert.deepEqual(metadata.target, { mcu: chip.id });
                const sketch = await fs.readFile(path.join(root, `${name}.ino`), 'utf8');
                assert.match(sketch, /void setup\(\)/);
                assert.match(sketch, /void loop\(\)/);
                assert.equal(sketch.includes('Serial.begin(115200)'), template === 'hello');
                const profile = await fs.readFile(path.join(root, 'sketch.yaml'), 'utf8');
                assert(profile.includes(`fqbn: esp32:esp32:${chip.id}`));
                if (chip.id === 'esp32s3') {
                    assert(profile.includes('USBMode=hwcdc,CDCOnBoot=default,UploadMode=default'));
                }
                assert(profile.includes(`platform: esp32:esp32 (${ESP32_ARDUINO_CORE_VERSION})`));
                assert(profile.includes(`platform_index_url: ${ESP32_ARDUINO_INDEX_URL}`));
                const bundle = require('../scope-extension/lib/common/nodu-arduino-library-catalog').ARDUINO_BUNDLED_LIBRARIES;
                for (const library of bundle) {
                    assert.equal(profile.includes(`${library.name} (${library.version})`), ['esp32s3', 'esp32c3'].includes(chip.id));
                }
                assert(profile.startsWith('default_profile: nodu\nprofiles:\n  nodu:\n'));
                assert(!profile.includes(parent));
                await assert.rejects(fs.access(path.join(root, 'CMakeLists.txt')));
                await assert.rejects(fs.access(path.join(root, '.theia/tasks.json')));
                await assert.rejects(createSourceProject(request), /同名项目/);
            }
        }
    } finally { await fs.rm(parent, { recursive: true, force: true }); }
});
test('framework validation precedes writes and does not leak into non-ESP32 projects', () => {
    const args = { parent: os.tmpdir(), name: 'hello', chip: 'esp32s3', template: 'empty' };
    for (const framework of ['unknown', '', null, true]) {
        assert.throws(() => parseProjectRequest({ ...args, framework }), /框架/);
    }
    assert.equal(parseProjectRequest({ ...args, framework: 'esp-idf' }).framework, 'esp-idf');
    assert.equal(parseProjectRequest({ ...args, framework: 'arduino' }).framework, 'arduino');
    assert.throws(() => parseProjectRequest({ ...args, chip: 'k210', framework: 'arduino' }), /框架/);
    assert.equal(parseProjectRequest({ ...args, chip: 'k210' }).framework, undefined);
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
