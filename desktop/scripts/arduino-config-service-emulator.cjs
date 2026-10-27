// SPDX-License-Identifier: MIT
// Opt-in integration: actual service configure/compile/upload, official CLI/esptool and ESP-EMU.
// Only fresh temporary Flash files and loopback sockets are used. Never opens hardware ports.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const assert = require('node:assert/strict');
const extensionRequire = createRequire(path.resolve(__dirname, '../scope-extension/package.json'));
extensionRequire('reflect-metadata');
const { NoduArduinoServer } = require('../scope-extension/lib/node/nodu-arduino-server');
const { createSourceProject, parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
const { readArduinoFlashPlan } = require('../scope-extension/lib/node/nodu-arduino-upload');
const seed = process.env.NODU_ARDUINO_E2E_HOME || '/tmp/nodu-arduino-e2e-20261026';
const shared = path.join(os.homedir(), '.local/share/bysj-common-app');
const emulator = process.env.NODU_ESP_EMU || path.join(shared, 'esp-emulator-0.46.0/esp-emu-0.46.0-aarch64-apple-darwin/esp-emu');
const esptool = process.env.NODU_ESPTOOL || path.join(shared, 'arduino/data/packages/esp32/tools/esptool_py/5.3.1/esptool');
const cli = process.env.NODU_ARDUINO_CLI || '/opt/homebrew/bin/arduino-cli';
const sha = data => createHash('sha256').update(data).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const children = new Set(), report = { hardware_accessed: false, started: new Date().toISOString(), commands: [], cases: [] };
let root, evidence, service, serial = 0;

function kill(child, signal = 'SIGKILL') {
    if (process.platform !== 'win32' && child.pid) { try { process.kill(-child.pid, signal); return; } catch { /* already exited */ } }
    child.kill(signal);
}
async function run(executable, args, options = {}) {
    const record = { executable, args }, name = `${++serial}-${path.basename(executable)}`; report.commands.push(record);
    const started = Date.now();
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
        let output = '';
        for (const stream of [child.stdout, child.stderr]) { stream.on('data', bytes => { output += bytes; }); }
        const timeout = setTimeout(() => { record.timed_out = true; kill(child); }, options.timeout || 60_000);
        child.once('error', error => { clearTimeout(timeout); children.delete(child); reject(error); });
        child.once('close', async (code, signal) => {
            clearTimeout(timeout); children.delete(child); Object.assign(record, { code, signal, elapsed_ms: Date.now() - started, log: `${name}.log` });
            await fs.writeFile(path.join(evidence, record.log), output); resolve({ code, output });
        });
    });
}
async function availablePort() {
    const socket = net.createServer();
    await new Promise((resolve, reject) => { socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve); });
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port;
}
async function startEmulator(chip, bytes) {
    const port = await availablePort(), flash = path.join(evidence, `${chip}.flash.bin`);
    await fs.writeFile(flash, Buffer.alloc(bytes, 0xff));
    const args = ['--chip', chip, '--firmware', flash, '--save-state', '--strap-mode', '0x02', '--uart-tcp', `127.0.0.1:${port}`,
        '--net', 'user,restrict=yes', '--timeout', '240s', '--log-color', 'never'];
    const child = spawn(emulator, args, { cwd: root, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }); children.add(child);
    let output = '', exited = false;
    for (const stream of [child.stdout, child.stderr]) { stream.on('data', bytes => { output += bytes; }); }
    const ended = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => { exited = true; children.delete(child); resolve({ code, signal }); });
    });
    for (let attempt = 0; attempt < 60; attempt++) {
        assert.equal(exited, false, output);
        const open = await new Promise(resolve => {
            const socket = net.connect(port, '127.0.0.1');
            socket.once('connect', () => { socket.destroy(); resolve(true); }); socket.once('error', () => resolve(false));
        });
        if (open) { break; } assert.notEqual(attempt, 59, 'ESP-EMU listener did not start'); await pause(50);
    }
    return { flash, port: `socket://127.0.0.1:${port}`, async stop() {
        if (!exited) { kill(child, 'SIGINT'); }
        const timeout = setTimeout(() => { if (!exited) { kill(child); } }, 5000);
        const result = await ended; clearTimeout(timeout);
        await fs.writeFile(path.join(evidence, `${chip}.rom.log`), output);
        report.commands.push({ executable: emulator, args, ...result, log: `${chip}.rom.log` });
        assert.notEqual(result.signal, 'SIGKILL', 'ESP-EMU could not persist Flash');
    } };
}
class SimulatorService extends NoduArduinoServer {
    directory() { return path.join(root, 'home'); }
    binary() { return cli; }
    uploadTarget(request) { return { kind: 'emulator', port: request.port, esptoolPath: esptool }; }
    async run(...parameters) {
        const [, request, args, cwd, config, , , executable = this.binary(), raw = false] = parameters;
        const record = { executable, args: raw ? args : ['--config-file', config, ...args], cwd, operation: request.operationId,
            log: `${++serial}-service-${path.basename(executable)}.log` }; report.commands.push(record);
        const started = Date.now();
        try {
            const result = await super.run(...parameters);
            Object.assign(record, { code: result.code, elapsed_ms: Date.now() - started });
            await fs.writeFile(path.join(evidence, record.log), result.output); return result;
        } catch (error) { record.error = error.message; throw error; }
    }
}
async function checkChip(chip) {
    const item = { chip, options: chip === 'esp32c3' ? { FlashFreq: '40', DebugLevel: 'warn' }
        : { CPUFreq: '160', FlashMode: 'dio', DebugLevel: 'warn' } }; report.cases.push(item);
    const project = path.join(root, `configured_${chip}`);
    if (!await fs.stat(project).catch(() => undefined)) {
        await createSourceProject(parseProjectRequest({ parent: root, name: path.basename(project), chip, framework: 'arduino', template: 'hello' }));
    }
    const menu = await service.boardOptions(project);
    for (const [id, value] of Object.entries(item.options)) {
        assert.ok(menu.some(option => option.id === id && option.values.some(choice => choice.value === value)), `${chip} lacks ${id}=${value}`);
    }
    const configured = await service.configure({ path: project, options: item.options });
    item.project = configured; await fs.copyFile(path.join(project, 'sketch.yaml'), path.join(evidence, `${chip}.sketch.yaml`));
    console.log(`${chip}: compiling configured Arduino profile`);
    const buildStart = Date.now(); item.compile = await service.compile({ path: project, operationId: `${chip}-compile` }); item.compile_ms = Date.now() - buildStart;
    assert.equal(item.compile.ok, true, JSON.stringify(item.compile)); assert.ok(item.compile.buildToken);
    const optionsFile = path.join(item.compile.buildPath, 'build.options.json');
    const built = JSON.parse(await fs.readFile(optionsFile, 'utf8'));
    item.profile_fqbn = configured.fqbn; item.build_fqbn = built.fqbn; item.order_changed = configured.fqbn !== built.fqbn;
    await fs.copyFile(optionsFile, path.join(evidence, `${chip}.build.options.json`));
    console.log(`${chip}: CLI reordered FQBN = ${item.order_changed}`);
    const plan = await readArduinoFlashPlan(item.compile.buildPath, configured);
    item.flash_plan = { options: plan.flashOptions, size: plan.flashSize, segments: plan.segments };
    const state = await startEmulator(chip, plan.flashSize);
    try {
        console.log(`${chip}: service uploading and verifying through ROM protocol`);
        item.upload = await service.upload({ path: project, operationId: `${chip}-upload`, buildToken: item.compile.buildToken, port: state.port });
        assert.equal(item.upload.ok, true, JSON.stringify(item.upload));
    } finally { await state.stop(); }
    const flash = await fs.readFile(state.flash);
    for (const segment of plan.segments) { assert.deepEqual(flash.subarray(segment.address, segment.address + segment.size), await fs.readFile(segment.path)); }
    item.flash_sha256 = sha(flash); item.flash_bytes = flash.length;
    console.log(`${chip}: booting the Flash saved after upload`);
    const boot = await run(emulator, ['--chip', chip, '--firmware', state.flash, '--net', 'user,restrict=yes', '--timeout', '10s', '--exit-on', 'Hello, ESP32!', '--log-color', 'never']);
    assert.equal(boot.code, 0, boot.output); assert.ok(boot.output.includes('Hello, ESP32!'), boot.output);
    item.hello = true; item.ok = true;
}
(async () => {
    root = process.env.NODU_CONFIG_E2E_DIR || await fs.mkdtemp('/tmp/nodu-arduino-config-service-20261027-');
    root = await fs.realpath(root); evidence = await fs.mkdtemp(path.join(root, 'run-')); Object.assign(report, { directory: root, evidence });
    console.log(`Evidence: ${evidence}`);
    const home = path.join(root, 'home'); await fs.mkdir(home, { recursive: true });
    for (const name of ['data', 'downloads', 'user']) {
        const destination = path.join(home, name);
        if (await fs.stat(destination).catch(() => undefined)) { continue; }
        assert.equal(process.platform, 'darwin', 'Supply a prepared NODU_CONFIG_E2E_DIR/home cache on non-APFS hosts');
        const cloned = await run('/bin/cp', ['-cR', path.join(seed, name), destination], { timeout: 180_000 });
        assert.equal(cloned.code, 0, cloned.output);
    }
    service = new SimulatorService(); const logs = [];
    service.addClient({ onArduinoOutput(event) { logs.push(event); } });
    for (const chip of ['esp32c3', 'esp32s3']) {
        try { await checkChip(chip); } catch (error) { Object.assign(report.cases.at(-1), { ok: false, error: error.stack }); console.error(`${chip}: ${error.message}`); }
        await fs.writeFile(path.join(evidence, 'service-output.json'), JSON.stringify(logs, null, 2) + '\n');
        await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    }
    report.ok = report.cases.length === 2 && report.cases.every(item => item.ok); if (!report.ok) { process.exitCode = 1; }
})().catch(error => { report.ok = false; report.error = error.stack; console.error(error); process.exitCode = 1; })
    .finally(async () => {
        service?.onStop(); for (const child of children) { kill(child); }
        report.finished = new Date().toISOString();
        if (evidence) { await fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
    });
