// SPDX-License-Identifier: MIT
// Opt-in hardware-free integration test. All Flash writes target fresh temporary files.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { executeArduinoUpload, readArduinoFlashPlan } = require('../scope-extension/lib/node/nodu-arduino-upload');
const home = process.env.NODU_ARDUINO_E2E_HOME || '/tmp/nodu-arduino-e2e-20261026';
const toolHome = path.join(os.homedir(), '.local/share/bysj-common-app');
const emulator = process.env.NODU_ESP_EMU || path.join(toolHome, 'esp-emulator-0.46.0/esp-emu-0.46.0-aarch64-apple-darwin/esp-emu');
const esptool = process.env.NODU_ESPTOOL || path.join(toolHome, 'arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let root, commandId = 0;
const report = { cases: [], commands: [], hardware_accessed: false }, running = new Set();
function killProcess(child, signal = 'SIGKILL') {
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* Already exited. */ } }
    child.kill(signal);
}

async function freePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function run(exe, args, cwd = root, options = {}) {
    const id = ++commandId, record = { id, exe, args, cwd };
    report.commands.push(record); const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(exe, args, { cwd, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); running.add(child);
        let output = '', timedOut = false;
        const timer = setTimeout(() => { timedOut = true; killProcess(child); }, options.timeout || 45000);
        for (const stream of [child.stdout, child.stderr]) {
            stream.on('data', data => { output += data.toString(); if (options.onOutput) { options.onOutput(output, child); } });
        }
        child.once('error', error => { clearTimeout(timer); running.delete(child); reject(error); });
        child.once('close', async (code, signal) => {
            clearTimeout(timer); running.delete(child);
            Object.assign(record, { code: code ?? -1, signal, elapsed_ms: Date.now() - started, timed_out: timedOut });
            await fs.writeFile(path.join(root, `command-${id}.log`), output);
            resolve({ code: code ?? -1, output, timedOut });
        });
    });
}
async function startEmulator(chip, name) {
    const flash = path.join(root, `${name}.flash.bin`), port = await freePort();
    await fs.writeFile(flash, Buffer.alloc(4 * 1024 * 1024, 0xff));
    const args = ['--chip', chip, '--firmware', flash, '--save-state', '--strap-mode', '0x02',
        '--uart-tcp', `127.0.0.1:${port}`, '--net', 'user,restrict=yes', '--timeout', '240s', '--log-color', 'never'];
    const child = spawn(emulator, args, { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); running.add(child);
    let output = '', done = false;
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', data => { output += data.toString(); }); }
    const ended = new Promise(resolve => child.once('close', (code, signal) => { done = true; running.delete(child); resolve({ code, signal }); }));
    child.on('error', error => { output += error.message; });
    for (let i = 0; i < 60; i++) {
        if (done) { throw new Error(`emulator exited during startup: ${output}`); }
        const open = await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false));
        });
        if (open) { break; } await delay(50);
        if (i === 59) { throw new Error('emulator listener did not start'); }
    }
    let stopped = false;
    return { chip, port, flash, async stop() {
        if (!stopped) {
            stopped = true; if (!done) { killProcess(child, 'SIGINT'); }
            const kill = setTimeout(() => { if (!done) { killProcess(child); } }, 4000);
            const result = await ended; clearTimeout(kill);
            await fs.writeFile(path.join(root, `${name}.emulator.log`), output);
            report.commands.push({ exe: emulator, args, result });
            assert.notEqual(result.signal, 'SIGKILL', 'emulator did not shut down gracefully');
        }
    } };
}
function options(chip, port, overrides = {}) {
    return { project: { path: path.join(home, `nodu_${chip}_hello`), profile: 'nodu', fqbn: `esp32:esp32:${chip}`, chip },
        buildPath: path.join(home, `build-${chip}`), configPath: path.join(home, 'config.yaml'), cliPath: '/opt/homebrew/bin/arduino-cli',
        target: { kind: 'emulator', port: `socket://127.0.0.1:${port}`, esptoolPath: esptool }, run, ...overrides };
}
async function passingUpload(chip) {
    const state = await startEmulator(chip, chip), config = options(chip, state.port), plan = await readArduinoFlashPlan(config.buildPath, config.project);
    try {
        for (let pass = 1; pass <= 2; pass++) {
            const stages = [], result = await executeArduinoUpload({ ...config, onStage: value => stages.push(value) });
            report.cases.push({ name: `${chip}-upload-${pass}`, result, stages });
            assert.equal(result.ok, true, JSON.stringify(result));
        }
        const readback = path.join(root, `${chip}.readback.bin`);
        // One independent full readback, using the official esptool stub for fast transfer.
        const read = await run(esptool, ['--chip', chip, '--port', config.target.port, '--before', 'no-reset', '--after', 'no-reset',
            '--connect-attempts', '2', 'read-flash', '--no-progress', '0', String(plan.flashSize), readback]);
        assert.equal(read.code, 0, read.output.slice(-2500));
        const data = await fs.readFile(readback);
        for (const segment of plan.segments) { assert.deepEqual(data.subarray(segment.address, segment.address + segment.size), await fs.readFile(segment.path)); }
        report.cases.push({ name: `${chip}-readback`, ok: true, bytes: data.length, sha256: sha(data) });
    } finally { await state.stop(); }
    const saved = await fs.readFile(state.flash), readback = await fs.readFile(path.join(root, `${chip}.readback.bin`));
    assert.deepEqual(saved, readback, 'saved Flash differs from independently read Flash');
    const boot = await run(emulator, ['--chip', chip, '--firmware', state.flash, '--net', 'user,restrict=yes', '--timeout', '10s',
        '--exit-on', 'Hello, ESP32!', '--log-color', 'never']);
    assert.equal(boot.code, 0); assert.ok(boot.output.includes('Hello, ESP32!'), boot.output);
    assert.equal(sha(await fs.readFile(state.flash)), sha(saved));
    report.cases.push({ name: `${chip}-saved-flash-boot`, ok: true, sha256: sha(saved), hello: true });
}
async function failureCases() {
    const state = await startEmulator('esp32s3', 'wrong-chip');
    try {
        const result = await executeArduinoUpload(options('esp32c3', state.port));
        assert.equal(result.ok, false); assert.equal(result.stage, 'upload');
        report.cases.push({ name: 'actual-wrong-chip', result });
    } finally { await state.stop(); }
    assert.ok((await fs.readFile(state.flash)).every(byte => byte === 0xff), 'wrong-chip test modified Flash');
    const missing = await executeArduinoUpload(options('esp32c3', await freePort()));
    assert.equal(missing.ok, false); assert.equal(missing.stage, 'upload'); report.cases.push({ name: 'absent-endpoint', result: missing });
    const corruptBuild = path.join(root, 'corrupt-build'); await fs.mkdir(corruptBuild);
    const source = options('esp32c3', 1), plan = await readArduinoFlashPlan(source.buildPath, source.project);
    for (const name of ['flash_args', 'build.options.json', ...plan.segments.map(segment => path.basename(segment.path))]) {
        await fs.copyFile(path.join(source.buildPath, name), path.join(corruptBuild, name));
    }
    const image = path.join(corruptBuild, 'nodu_esp32c3_hello.ino.bin'), bytes = await fs.readFile(image); bytes[48] ^= 1; await fs.writeFile(image, bytes);
    let calls = 0;
    const corrupt = await executeArduinoUpload({ ...source, buildPath: corruptBuild, run: async () => { calls++; throw new Error('corrupt image reached uploader'); } });
    assert.equal(corrupt.ok, false); assert.equal(corrupt.stage, 'validate'); assert.equal(calls, 0);
    report.cases.push({ name: 'corrupt-image-no-process', result: corrupt, calls });
    const cancellable = await startEmulator('esp32c3', 'cancelled'); let cancelled = false;
    try {
        const stages = [], result = await executeArduinoUpload(options('esp32c3', cancellable.port, {
            isCancelled: () => cancelled, onStage: value => stages.push(value),
            run: (exe, args, cwd) => run(exe, args, cwd, { onOutput(output, child) {
                if (!cancelled && /Writing at|Writing\s+\d|Writing.*bytes/.test(output)) { cancelled = true; killProcess(child); }
            } })
        }));
        assert.equal(cancelled, true, 'actual write cancellation trigger was not observed');
        assert.equal(result.cancelled, true); assert.equal(result.ok, false); assert.ok(!stages.includes('complete'));
        report.cases.push({ name: 'cancel-during-write', result, stages });
    } finally { await cancellable.stop(); }
}
(async () => {
    root = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'nodu-arduino-upload-20261027-')); report.directory = root;
    console.log(`Evidence: ${root}`);
    if (process.env.NODU_ESP_UPLOAD_CASES !== 'failures') {
        if (process.env.NODU_ESP_UPLOAD_CASES !== 's3-and-failures') { await passingUpload('esp32c3'); console.log('C3 write/readback/save/boot + repeat passed'); }
        await passingUpload('esp32s3'); console.log('S3 write/readback/save/boot + repeat passed');
    }
    await failureCases(); console.log('Wrong chip / absent endpoint / corrupt image / cancellation passed');
    report.ok = true;
})().catch(error => { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; })
    .finally(async () => { for (const child of running) { killProcess(child); } if (root) { await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n'); } });
