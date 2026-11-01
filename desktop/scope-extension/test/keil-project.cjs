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
    await write(path.join(root, 'Core/Src/syscalls.c'), await fs.readFile(path.join(resources, 'templates/common/Core/Src/syscalls.c'), 'utf8'));
    const gccStartup = await fs.readFile(path.resolve(__dirname, '../../examples/stm32f103-uart-tutor/Startup/startup_stm32f103xb.s'), 'utf8');
    await write(path.join(root, 'Startup/startup_stm32f103xb.s'), gccStartup);
    await write(path.join(sdk, 'Drivers/CMSIS/Device/ST/STM32F1xx/Source/Templates/gcc/startup_stm32f103xb.s'), gccStartup);
    await write(path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c'));
    await write(path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Inc/stm32f1xx_hal.h'));
    for (const name of ['cmsis_compiler.h','cmsis_armcc.h','cmsis_armclang.h','core_cm3.h']) await write(path.join(sdk, 'Drivers/CMSIS/Include', name), '/* fixture */');
    const project = { path: root, chip: { id: 'STM32F103C8Tx', flash: { size: 65536 }, ram: { size: 20480 }, sdk: { dir: 'cube-f1' } }, manifest: {}, trusted: true, preset: 'debug', toolkit: { root: toolkit } };
    const args = ['arm-none-eabi-gcc', '-DSTM32F103xB', '-DUSE_HAL_DRIVER', '-I', path.join(root, 'Core/Inc'), '-I' + path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Inc')];
    const entries = ['Core/Src/main.c', 'Core/Src/syscalls.c', 'Startup/startup_stm32f103xb.s', path.join(sdk, 'Drivers/STM32F1xx_HAL_Driver/Src/stm32f1xx_hal.c')]
        .map(file => ({ file, directory: root, arguments: args }));
    await write(path.join(root, 'Linker/FLASH.ld'), 'ENTRY(Reset_Handler)\n_estack = ORIGIN(RAM) + LENGTH(RAM);\n_Min_Heap_Size = 0x200;\n_Min_Stack_Size = 0x800;\nMEMORY {\nFLASH (rx): ORIGIN = 0x08000000, LENGTH = 64K\nRAM (xrw): ORIGIN = 0x20000000, LENGTH = 20K\n}\nSECTIONS { .text : { *(.text*) } > FLASH }');
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
    assert(supportsKeil({ ...p, chip: { id: 'STM32F407ZGTx' } }));
    for (const name of ['nodu.json', 'cmake/nodu.cmake', 'Core/Inc/stm32f1xx_hal_conf.h']) assert(affectsKeil(name, false));
    assert(affectsKeil('App/sensor.c', true)); assert(affectsKeil('App/sensor.c', false));
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
    assert(xml.includes('<Driver>STLink\\ST-LINKIII-KEIL_SWO.dll</Driver>'));
    assert(xml.includes('<Flash2>STLink\\ST-LINKIII-KEIL_SWO.dll</Flash2>'));
    assert((await fs.readFile(path.join(f.root, 'MDK-ARM/Nodu.uvoptx'), 'utf8')).includes('<pMon>STLink\\ST-LINKIII-KEIL_SWO.dll</pMon>'));
    const before = (await fs.stat(f.file)).mtimeMs;
    assert.equal((await f.generate()).changed, false);
    assert.equal((await fs.stat(f.file)).mtimeMs, before);
    await fs.unlink(path.join(f.root, 'MDK-ARM/retarget_arm.c'));
    assert.equal((await f.generate()).changed, true);
    assert.equal((await keilStatus(f.project)).autoSync, false);
});

test('legacy ST-LINK paths are repaired without overwriting custom drivers or debug settings', async t => {
    const f = await fixture(t); await f.generate();
    const options = path.join(f.root, 'MDK-ARM/Nodu.uvoptx');
    const driver = 'STLink\\ST-LINKIII-KEIL_SWO.dll', legacy = 'BIN\\' + driver;
    const project = (await fs.readFile(f.file, 'utf8')).replaceAll(driver, legacy).replace('<RunToMain>1</RunToMain>', '<RunToMain>0</RunToMain>');
    // Keep a deliberately selected different driver on AC5.
    const custom = project.replace(/<Flash2>[^<]+<\/Flash2>(?![\s\S]*<Flash2>)/, '<Flash2>MyProbe\\Driver.dll</Flash2>');
    await fs.writeFile(f.file, custom);
    // µVision also writes tDll when it saves the generated options file.
    await fs.writeFile(options, (await fs.readFile(options, 'utf8')).replaceAll(driver, legacy).replace('<pMon>', `<tDll>${legacy}</tDll><pMon>`).replace('<tGomain>1</tGomain>', '<tGomain>0</tGomain>'));
    assert.equal((await f.generate()).changed, true);
    const after = await fs.readFile(f.file, 'utf8'), afterOptions = await fs.readFile(options, 'utf8');
    assert(!after.includes(legacy)); assert(!afterOptions.includes(legacy));
    assert(after.includes('<Flash2>MyProbe\\Driver.dll</Flash2>'));
    assert(afterOptions.includes(`<tDll>${driver}</tDll>`));
    assert(after.includes('<RunToMain>0</RunToMain>')); assert(afterOptions.includes('<tGomain>0</tGomain>'));
    assert.equal((await f.generate()).changed, false);
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
    const updated = new DOMParser().parseFromString(after, 'text/xml');
    for (const node of Array.from(updated.getElementsByTagName('VariousControls'))) {
        assert.deepEqual(Array.from(node.childNodes).filter(n => n.nodeType === 1).map(n => n.nodeName), ['MiscControls', 'Define', 'Undefine', 'IncludePath']);
    }
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
    await f.generate();
    assert((await fs.readFile(f.file, 'utf8')).includes('ONLY_THIS_FILE'));
    f.entries[0].arguments = f.args; f.entries[0].file = path.join(__dirname, 'keil-project.cjs'); await f.saveDb();
    await assert.rejects(f.generate(), { code: 'keilUnsupported' });
    f.entries[0].file = path.resolve(f.root, '../outside.c'); await fs.writeFile(f.entries[0].file, ''); await f.saveDb();
    await assert.rejects(f.generate(), { code: 'keilPath' });
    assert((await fs.readFile(f.file, 'utf8')).includes('ONLY_THIS_FILE'));
});


test('missing Arm CMSIS headers are caught before output instead of copying GNU headers', async t => {
    const f = await fixture(t);
    await fs.unlink(path.join(f.project.toolkit.root, 'sdk/cube-f1/Drivers/CMSIS/Include/cmsis_armcc.h'));
    await assert.rejects(f.generate(), error => error.code === 'keilSdkMissing' && error.message.includes('cmsis_armcc.h'));
    await assert.rejects(fs.access(path.join(f.root, 'MDK-ARM')));
});

test('nonportable headers and C11 assertions are reported with a fix without rewriting business sources', async t => {
    const f = await fixture(t), source = '#include <memory.h>\n_Static_assert(sizeof(int)==4, "ABI");\n';
    const file = path.join(f.root, 'Core/Src/main.c'); await fs.writeFile(file, source);
    await assert.rejects(f.generate(), error => error.code === 'keilSource' && error.detail.diagnostics.length === 2 && error.detail.diagnostics[0].line === 1);
    assert.equal(await fs.readFile(file, 'utf8'), source);
    await assert.rejects(fs.access(path.join(f.root, 'MDK-ARM')));
});


test('custom Keil scatter cannot silently diverge from the GNU Flash reservation', async t => {
    const f = await fixture(t); await f.generate();
    const custom = path.join(f.root, 'MDK-ARM/custom.sct');
    await fs.writeFile(custom, 'LR_IROM1 0x08000000 0x00010000 { ER_IROM1 0x08000000 0x00010000 { .ANY (+RO) } }');
    const original = (await fs.readFile(f.file, 'utf8')).replaceAll('.\\STM32F103C8.sct', '.\\custom.sct'); await fs.writeFile(f.file, original);
    await f.generate();
    const linker = path.join(f.root, 'Linker/FLASH.ld'); await fs.writeFile(linker, (await fs.readFile(linker, 'utf8')).replace('64K','62K'));
    await assert.rejects(f.generate(), error => error.code === 'keilConflict' && error.message.includes('Flash'));
    assert((await fs.readFile(f.file, 'utf8')).includes('custom.sct'));
});
