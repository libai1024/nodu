// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const { generateKeil, commandTokens, keilStatus } = require('../lib/node/nodu-keil-project');
const { affectsKeil, supportsKeil } = require('../lib/common/nodu-keil');
const resources = path.resolve(__dirname, '../resources/stm32');

async function fixture(t) {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-keil-'));
    t.after(() => fs.rm(temp, { recursive: true, force: true }));
    const root = path.join(temp, '中文 project'), toolkit = path.join(temp, 'toolkit');
    const sdk = path.join(toolkit, 'sdk/cube-f1');
    const write = async (file, text = '') => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
    await write(path.join(root, 'Core/Src/main.c'), 'int main(void) { return 0; }');
    await write(path.join(root, 'Core/Inc/main.h'));
    await write(path.join(root, 'Core/Src/syscalls.c'));
    await write(path.join(root, 'Startup/startup_stm32f103xb.s'));
    await write(path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c'));
    await write(path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Inc/stm32f1xx_hal.h'));
    const project = { path: root, chip: { id: 'STM32F103C8Tx', sdk: { dir: 'cube-f1' } }, manifest: {}, trusted: true, preset: 'debug', toolkit: { root: toolkit } };
    const args = ['arm-none-eabi-gcc', '-DSTM32F103xB', '-DUSE_HAL_DRIVER', '-I', path.join(root, 'Core/Inc'), '-I' + path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Inc')];
    const entries = ['Core/Src/main.c', 'Core/Src/syscalls.c', 'Startup/startup_stm32f103xb.s', path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c')]
        .map(file => ({ file, directory: root, arguments: args }));
    const db = path.join(root, 'build/debug/compile_commands.json');
    const saveDb = () => write(db, JSON.stringify(entries)); await saveDb();
    const generate = () => generateKeil(project, db, resources);
    return { root, project, entries, args, write, saveDb, generate, file: path.join(root, 'MDK-ARM/Nodu.uvprojx') };
}

test('CMake command tokenization retains Windows paths and quoted values without a shell', () => {
    assert.deepEqual(commandTokens('"D:\\Arm tools\\gcc.exe" -I"D:\\我的工程\\Core\\Inc" -DSTM32F103xB'), ['D:\\Arm tools\\gcc.exe', '-ID:\\我的工程\\Core\\Inc', '-DSTM32F103xB']);
    assert.throws(() => commandTokens('gcc -I"broken'), { code: 'keilConfiguration' });
});

test('only supported native projects and relevant changes participate in maintenance', () => {
    const p = { chip: { id: 'STM32F103C8Tx' }, manifest: {} };
    assert(supportsKeil(p)); assert(!supportsKeil({ ...p, manifest: { build: { external: true } } }));
    assert(!supportsKeil({ ...p, chip: { id: 'STM32F407ZGTx' } }));
    for (const name of ['nodu.json', 'cmake/nodu.cmake', 'Core/Inc/stm32f1xx_hal_conf.h']) assert(affectsKeil(name, false));
    assert(affectsKeil('App/sensor.c', true)); assert(!affectsKeil('App/sensor.c', false));
    for (const name of ['MDK-ARM/Drivers/test.c', 'build/debug/output.c', '.nodu/keil-update.lock']) assert(!affectsKeil(name, true));
});

test('portable two-target project uses shared sources; repeat generation is a no-op', async t => {
    const f = await fixture(t), first = await f.generate();
    assert(first.created && first.changed);
    const xml = await fs.readFile(f.file, 'utf8');
    assert(xml.includes('Nodu AC6') && xml.includes('Nodu AC5'));
    assert(xml.includes('..\\Core\\Src\\main.c'));
    assert(!xml.includes(f.root) && !xml.includes('syscalls.c'));
    assert(xml.includes('<Undefine></Undefine><IncludePath>'));
    const before = (await fs.stat(f.file)).mtimeMs;
    assert.equal((await f.generate()).changed, false);
    assert.equal((await fs.stat(f.file)).mtimeMs, before);
    await fs.unlink(path.join(f.root, 'MDK-ARM/retarget_arm.c'));
    assert.equal((await f.generate()).changed, true);
    assert.equal((await keilStatus(f.project)).autoSync, false);
});

test('adding a module and changing preset preserves user groups, file options and debug settings', async t => {
    const f = await fixture(t); await f.generate();
    const d = new DOMParser().parseFromString(await fs.readFile(f.file, 'utf8'), 'text/xml');
    d.getElementsByTagName('RunToMain')[0].textContent = '0';
    const group = d.createElement('Group'), name = d.createElement('GroupName'); name.textContent = 'User Drivers'; group.appendChild(name);
    d.getElementsByTagName('Groups')[0].appendChild(group);
    const option = d.createElement('FileOption'); option.appendChild(d.createElement('UserTest'));
    d.getElementsByTagName('File')[0].appendChild(option);
    await fs.writeFile(f.file, new XMLSerializer().serializeToString(d));
    const opts = path.join(f.root, 'MDK-ARM/Nodu.uvoptx'); await fs.writeFile(opts, 'user debug options');
    await f.write(path.join(f.root, 'App/sensor.c'), 'int sensor(void) { return 1; }');
    f.entries.push({ file: 'App/sensor.c', directory: f.root, arguments: f.args }); await f.saveDb();
    f.project.preset = 'release'; await f.generate();
    const after = await fs.readFile(f.file, 'utf8');
    for (const text of ['<RunToMain>0</RunToMain>', 'User Drivers', '<UserTest/>', '..\\App\\sensor.c', '<Optim>4</Optim>']) assert(after.includes(text), text);
    assert.equal(await fs.readFile(opts, 'utf8'), 'user debug options');
    const snapshot = after.replace('STM32F103xB,USE_HAL_DRIVER', 'STM32F103xB,USER_OVERRIDE');
    await fs.writeFile(f.file, snapshot);
    await assert.rejects(f.generate(), { code: 'keilConflict' });
    assert.equal(await fs.readFile(f.file, 'utf8'), snapshot);
});

test('changed support files and unknown MDK folders are never overwritten', async t => {
    const f = await fixture(t); await f.generate();
    const runtime = path.join(f.root, 'MDK-ARM/retarget_arm.c');
    await fs.writeFile(runtime, 'custom runtime');
    await assert.rejects(f.generate(), { code: 'keilConflict' });
    assert.equal(await fs.readFile(runtime, 'utf8'), 'custom runtime');
    const other = await fixture(t);
    await other.write(path.join(other.root, 'MDK-ARM/existing.uvprojx'), 'keep');
    await assert.rejects(other.generate(), { code: 'keilConflict' });
});

test('untrusted, external, escaping and per-file macro configurations fail before output', async t => {
    const f = await fixture(t);
    f.project.trusted = false; await assert.rejects(f.generate(), { code: 'untrusted' });
    f.project.trusted = true; f.project.manifest.build = { external: true };
    await assert.rejects(f.generate(), { code: 'keilUnsupported' }); delete f.project.manifest.build;
    f.entries[0].arguments = [...f.args, '-DONLY_THIS_FILE']; await f.saveDb();
    await assert.rejects(f.generate(), { code: 'keilUnsupported' });
    f.entries[0].arguments = f.args; f.entries[0].file = path.join(__dirname, 'keil-project.cjs'); await f.saveDb();
    await assert.rejects(f.generate(), { code: 'keilUnsupported' });
    f.entries[0].file = path.resolve(f.root, '../outside.c'); await fs.writeFile(f.entries[0].file, ''); await f.saveDb();
    await assert.rejects(f.generate(), { code: 'keilPath' });
    await assert.rejects(fs.access(path.join(f.root, 'MDK-ARM')));
});
