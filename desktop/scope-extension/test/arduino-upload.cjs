// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { readArduinoFlashPlan, executeArduinoUpload } = require('../lib/node/nodu-arduino-upload');

function image(chip) {
    const data = Buffer.alloc(48); data[0] = 0xe9; data[1] = 1; data[23] = 1;
    data.writeUInt16LE(chip === 'esp32c3' ? 5 : 9, 12); data.writeUInt32LE(4, 28);
    data.set([1, 2, 3, 4], 32); data[47] = 0xef ^ 1 ^ 2 ^ 3 ^ 4;
    return Buffer.concat([data, createHash('sha256').update(data).digest()]);
}
async function fixture(t) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-upload-unit-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'hello'), build = path.join(root, 'build with spaces');
    await fs.mkdir(source); await fs.mkdir(build);
    const project = { path: source, profile: 'nodu', fqbn: 'esp32:esp32:esp32c3', chip: 'esp32c3' };
    await fs.writeFile(path.join(build, 'build.options.json'), JSON.stringify({ fqbn: project.fqbn, sketchLocation: source }));
    await fs.writeFile(path.join(build, 'hello.ino.bin'), image('esp32c3'));
    await fs.writeFile(path.join(build, 'hello.ino.bootloader.bin'), image('esp32c3'));
    await fs.writeFile(path.join(build, 'flash_args'), '--flash-mode dio --flash-freq 80m --flash-size 4MB\n0x0 "hello.ino.bootloader.bin"\n0x10000 "hello.ino.bin"\n');
    const calls = [], stages = [];
    const options = { project, buildPath: build, cliPath: '/tools/arduino-cli', configPath: '/tools/config.yaml',
        target: { kind: 'emulator', port: 'socket://127.0.0.1:5555', esptoolPath: '/tools/esptool' },
        run: async (exe, args, cwd) => { calls.push({ exe, args, cwd }); return { code: 0, output: '' }; },
        onStage: value => stages.push(value) };
    return { root, source, build, project, options, calls, stages };
}

test('emulator writes official generated addresses and verifies every segment with array arguments', async t => {
    const f = await fixture(t), result = await executeArduinoUpload(f.options);
    assert.equal(result.ok, true); assert.deepEqual(f.stages, ['validate', 'upload', 'verify', 'complete']);
    assert.equal(f.calls.length, 2); assert.equal(f.calls[0].exe, '/tools/esptool');
    assert.ok(f.calls[0].args.includes('write-flash')); assert.ok(f.calls[1].args.includes('verify-flash'));
    assert.deepEqual(f.calls[0].args.slice(-4), ['0x0', path.join(f.build, 'hello.ino.bootloader.bin'), '0x10000', path.join(f.build, 'hello.ino.bin')]);
    assert.equal(f.calls[0].cwd, f.build); assert.ok(f.calls[0].args.includes('--no-stub'));
});
test('serial upload delegates the profile, port and build directory to the official CLI recipe', async t => {
    const f = await fixture(t);
    for (const transport of ['uart', 'hardware-cdc']) {
        f.calls.length = 0;
        const result = await executeArduinoUpload({ ...f.options, target: { kind: 'serial', port: '/dev/cu.usbmodem123', transport } });
        assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
        assert.deepEqual(f.calls[0], { exe: '/tools/arduino-cli', cwd: f.source, args: ['--config-file', '/tools/config.yaml', 'upload', '--profile', 'nodu', '--input-dir', f.build, '--port', '/dev/cu.usbmodem123', '--protocol', 'serial', '--discovery-timeout', '10s', '--verify', f.source] });
    }
});
test('remote endpoints, injection ports and unsupported TinyUSB fail before any process', async t => {
    const f = await fixture(t);
    for (const target of [
        { ...f.options.target, port: 'socket://192.168.1.4:5555' }, { ...f.options.target, port: 'socket://127.0.0.1:65536' },
        { kind: 'serial', port: '/dev/cu.modem;touch /tmp/oops', transport: 'uart' },
        { kind: 'serial', port: '/dev/cu.usbmodem1', transport: 'tinyusb' }
    ]) { assert.equal((await executeArduinoUpload({ ...f.options, target })).ok, false); }
    assert.match((await executeArduinoUpload({ ...f.options, project: { ...f.project, fqbn: 'esp32:esp32:esp32s3:UploadMode=cdc' },
        target: { kind: 'serial', port: '/dev/cu.usbmodem1', transport: 'hardware-cdc' } })).error, /TinyUSB/);
    assert.equal(f.calls.length, 0);
});
test('wrong chip and corrupted image are rejected before an upload can erase flash', async t => {
    const f = await fixture(t);
    assert.equal((await executeArduinoUpload({ ...f.options, project: { ...f.project, chip: 'esp32s3' } })).ok, false);
    const file = path.join(f.build, 'hello.ino.bin'), data = await fs.readFile(file); data[32] ^= 1; await fs.writeFile(file, data);
    assert.match((await executeArduinoUpload(f.options)).error, /校验/); assert.equal(f.calls.length, 0);
});
test('image hash corruption cannot pass even when the XOR checksum is intact', async t => {
    const f = await fixture(t), file = path.join(f.build, 'hello.ino.bin'), data = await fs.readFile(file);
    data[60] ^= 1; await fs.writeFile(file, data);
    assert.match((await executeArduinoUpload(f.options)).error, /摘要校验/); assert.equal(f.calls.length, 0);
});
test('mismatched build ownership fails before execution', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.build, 'build.options.json'), JSON.stringify({ fqbn: 'esp32:esp32:esp32s3', sketchLocation: f.source }));
    assert.match((await executeArduinoUpload(f.options)).error, /不属于/); assert.equal(f.calls.length, 0);
});
test('a configured board option set passes ownership validation and reaches the uploader', async t => {
    const f = await fixture(t);
    f.project.fqbn += ':FlashFreq=40,DebugLevel=warn,CDCOnBoot=default';
    await fs.writeFile(path.join(f.build, 'build.options.json'), JSON.stringify({
        fqbn: f.project.fqbn, sketchLocation: f.source
    }));
    assert.equal((await executeArduinoUpload(f.options)).ok, true);
    assert.equal(f.calls.length, 2);
});
test('configured build ownership rejects changed, missing, duplicate or malformed options', async t => {
    const f = await fixture(t);
    f.project.fqbn += ':FlashFreq=40,DebugLevel=warn';
    for (const fqbn of [
        'esp32:esp32:esp32c3:DebugLevel=warn,FlashFreq=80',
        'esp32:esp32:esp32c3:FlashFreq=40',
        'esp32:esp32:esp32c3:DebugLevel=warn,FlashFreq=40,FlashFreq=40',
        'esp32:esp32:esp32c3:DebugLevel=warn,FlashFreq=40,Other=default',
        'esp32:esp32:esp32s3:DebugLevel=warn,FlashFreq=40',
        'esp32:esp32:esp32c3:DebugLevel=warn,FlashFreq=40,',
        'esp32:esp32:esp32c3:DebugLevel=warn,FlashFreq=40=40',
        null
    ]) {
        await fs.writeFile(path.join(f.build, 'build.options.json'), JSON.stringify({ fqbn, sketchLocation: f.source }));
        assert.equal((await executeArduinoUpload(f.options)).ok, false, String(fqbn));
    }
    assert.equal(f.calls.length, 0);
});
test('out of range, overlapping, escaping and response-file layouts are rejected', async t => {
    const f = await fixture(t), file = path.join(f.build, 'flash_args');
    for (const content of [
        '--flash-size 1MB\n0x0 hello.ino.bootloader.bin\n0x100000 hello.ino.bin',
        '--flash-size 4MB\n0x0 hello.ino.bootloader.bin\n0x20 hello.ino.bin',
        '--flash-size 4MB\n0x0 ../outside.bin\n0x10000 hello.ino.bin',
        '--flash-size 4MB\n@other_args',
        '--erase-all --flash-size 4MB\n0x0 hello.ino.bootloader.bin\n0x10000 hello.ino.bin'
    ]) { await fs.writeFile(file, content); assert.equal((await executeArduinoUpload(f.options)).ok, false); }
    assert.equal(f.calls.length, 0);
});
test('symlink images cannot redirect an upload out of the build directory', async t => {
    const f = await fixture(t), file = path.join(f.build, 'hello.ino.bin');
    await fs.rename(file, path.join(f.root, 'outside.bin')); await fs.symlink(path.join(f.root, 'outside.bin'), file);
    assert.equal((await executeArduinoUpload(f.options)).ok, false); assert.equal(f.calls.length, 0);
});
test('cancellation before upload has no side effects; cancellation after write skips verification', async t => {
    const f = await fixture(t);
    assert.equal((await executeArduinoUpload({ ...f.options, isCancelled: () => true })).cancelled, true);
    assert.equal(f.calls.length, 0);
    let cancelled = false;
    const result = await executeArduinoUpload({ ...f.options, isCancelled: () => cancelled, run: async (...args) => {
        await f.options.run(...args); cancelled = true; return { code: 0, output: '' };
    } });
    assert.equal(result.cancelled, true); assert.equal(result.ok, false); assert.equal(f.calls.length, 1);
});
test('missing endpoint and failed readback remain failures and never emit complete', async t => {
    const f = await fixture(t);
    let result = await executeArduinoUpload({ ...f.options, run: async () => ({ code: 2, output: 'connection refused' }) });
    assert.equal(result.ok, false); assert.equal(result.stage, 'upload');
    let count = 0; result = await executeArduinoUpload({ ...f.options, run: async () => ({ code: ++count === 1 ? 0 : 2, output: 'digest mismatch' }) });
    assert.equal(result.ok, false); assert.equal(result.stage, 'verify'); assert.ok(!f.stages.includes('complete'));
});
test('missing bootloader cannot be silently replaced with a guessed flash offset', async t => {
    const f = await fixture(t);
    await fs.writeFile(path.join(f.build, 'flash_args'), '--flash-size 4MB\n0x8000 hello.ino.bin\n0x10000 hello.ino.bin');
    await assert.rejects(readArduinoFlashPlan(f.build, f.project), /缺少/);
});
