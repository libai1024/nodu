// SPDX-License-Identifier: MIT
// Opt-in integration. Calls the REAL Nodu service/compiler, never fake CLI or hardware ports.
// Writes only a fresh evidence root; existing extension lib output remains untouched.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRequire, Module } = require('node:module');
const extension = path.resolve(__dirname, '..'), req = createRequire(path.join(extension, 'package.json'));
req('reflect-metadata');
const ts = req('typescript');
const { NoduArduinoServer } = req('./lib/node/nodu-arduino-server');
const { createSourceProject, parseProjectRequest } = req('./lib/node/nodu-project-generator');
const { readArduinoProject, arduinoInputDigest } = req('./lib/node/nodu-arduino-project');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cli = process.env.NODU_ARDUINO_CLI || '/opt/homebrew/bin/arduino-cli';
const root = path.resolve(process.env.NODU_SIM_EVIDENCE_DIR || path.join(extension, '../../artifacts/esp-sim-export-' + Date.now()));
const studio = process.env.NODU_SIM_STUDIO_ROOT || '/Users/wangwei/Project/FC/STM32_Study_Studio';
let service, producer; const report = { started: new Date().toISOString(), directory: root, hardwareAccessed: false, cases: [], builds: [] }, operations = [];
async function command(executable, args, cwd = root) {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] }); let output = '';
        for (const stream of [child.stdout, child.stderr]) { stream.on('data', b => { output += b; }); }
        child.on('error', reject); child.on('close', code => resolve({ code, output }));
    });
}
async function evidence() { await fs.writeFile(path.join(root, 'result.json'), JSON.stringify(report, null, 2) + '\n'); }
async function check(name, run) {
    try { await run(); report.cases.push({ name, status: 'PASS' }); console.log('PASS ' + name); }
    catch (error) { report.cases.push({ name, status: 'FAIL', error: error.stack }); console.error('FAIL ' + name + ': ' + error.message); }
    await evidence();
}
async function loadProducer() {
    const file = path.join(extension, 'src/node/nodu-arduino-simulation-package.ts'), source = await fs.readFile(file, 'utf8');
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const module = new Module(file); module.filename = file; module.paths = req.resolve.paths('typescript');
    module.require = id => id.startsWith('./nodu-') ? req('./lib/node/' + id.slice(2)) : req(id);
    module._compile(javascript, file);
    report.producerSource = { path: file, sha256: sha(source) };
    await fs.writeFile(path.join(root, 'producer-used.ts'), source, { flag: 'wx' });
    report.testSource = { path: __filename, sha256: sha(await fs.readFile(__filename)) };
    report.serviceSources = [];
    for (const name of ['nodu-arduino-server', 'nodu-arduino-project', 'nodu-arduino-upload', 'nodu-arduino-libraries', 'nodu-arduino-boards', 'nodu-project-generator']) {
        for (const kind of ['src', 'lib']) {
            const source = path.join(extension, kind, 'node', name + (kind === 'src' ? '.ts' : '.js'));
            report.serviceSources.push({ path: source, sha256: sha(await fs.readFile(source)) });
        }
    }
    return module.exports;
}
class RealService extends NoduArduinoServer {
    directory() { return path.join(root, 'home'); }
    binary() { return cli; }
    async run(...parameters) {
        const [, request, args, cwd, config, , , executable = this.binary(), raw = false] = parameters;
        const record = { executable, args: raw ? args : ['--config-file', config, ...args], cwd, operation: request.operationId };
        operations.push(record); const started = Date.now();
        const result = await super.run(...parameters); record.code = result.code; record.elapsedMs = Date.now() - started;
        record.log = `operation-${operations.length}.log`; await fs.writeFile(path.join(root, record.log), result.output); return result;
    }
}
async function main() {
    await fs.mkdir(root, { recursive: true });
    // Caller may clone a cache into this fresh home. Never reuse mutable user-service directories.
    const home = path.join(root, 'home'); await fs.mkdir(home, { recursive: true });
    const seed = process.env.NODU_SIM_SEED_HOME;
    if (seed) {
        for (const name of ['data', 'downloads', 'user']) {
            const destination = path.join(home, name);
            assert.equal(await fs.stat(destination).catch(() => undefined), undefined, 'Seed destination already exists');
            const cloned = await command('/bin/cp', ['-cR', path.join(seed, name), destination]); assert.equal(cloned.code, 0, cloned.output);
        }
    }
    assert.ok((await fs.stat(path.join(home, 'data', 'internal'))).isDirectory(), 'Supply a prepared private home or NODU_SIM_SEED_HOME');
    const version = await command(cli, ['version', '--format', 'json']); assert.equal(version.code, 0, version.output);
    assert.equal(JSON.parse(version.output).VersionString, '1.5.1'); report.cli = { path: cli, sha256: sha(await fs.readFile(cli)), version: JSON.parse(version.output) };
    producer = await loadProducer(); service = new RealService();
    const events = []; service.addClient({ onArduinoOutput: event => { events.push(event); } });
    for (const chip of ['esp32c3', 'esp32s3']) {
        const name = 'nodu_sim_' + chip, projectPath = path.join(root, name);
        await createSourceProject(parseProjectRequest({ parent: root, name, chip, framework: 'arduino', template: 'hello' }));
        const configured = await service.configure({ path: projectPath, options: chip === 'esp32c3'
            ? { CPUFreq: '160', FlashFreq: '80', FlashSize: '4M', FlashMode: 'qio', CDCOnBoot: 'default', PartitionScheme: 'default' }
            : { CPUFreq: '240', FlashSize: '8M', FlashMode: 'qio', CDCOnBoot: 'default', PartitionScheme: 'default_8MB', PSRAM: 'disabled', LoopCore: '1', EventsCore: '1', USBMode: 'hwcdc' } });
        assert.equal(configured.error, undefined, JSON.stringify(configured));
        console.log(chip + ': capturing actual installed dependency content before compile');
        const dependencies = await producer.discoverArduinoSimulationDependencies(home, projectPath, cli);
        await fs.writeFile(path.join(root, chip + '-dependency-inputs.json'), JSON.stringify(dependencies, null, 2) + '\n');
        const snapshot = await producer.captureArduinoSimulationInputs({ projectPath, dependencies, producerVersion: req('./package.json').version, cliVersion: '1.5.1', coreVersion: '3.3.12', idfVersion: '5.5.5' });
        console.log(chip + ': real NoduArduinoServer.compile');
        const operationId = 'sim-export-' + chip, result = await service.compile({ path: projectPath, operationId });
        const buildLog = Buffer.from(events.filter(event => event.operationId === operationId).map(e => e.line).join('\n') + '\n');
        await fs.writeFile(path.join(root, chip + '-build.log'), buildLog);
        const item = { chip, projectPath, compile: result, snapshot, profile: await readArduinoProject(projectPath) }; report.builds.push(item); await evidence();
        assert.equal(result.ok, true, JSON.stringify(result)); assert.ok(result.buildToken);
        const built = service.builds.get(result.buildToken); assert.ok(built);
        const build = { token: result.buildToken, ...built };
        const verifyCurrent = async () => {
            const current = service.builds.get(result.buildToken); assert.equal(current, built, 'successful token no longer current');
            assert.equal(current.path, projectPath); assert.equal(current.fqbn, (await readArduinoProject(projectPath)).fqbn);
            assert.equal(current.digest, await arduinoInputDigest(projectPath), 'source changed');
            assert.equal(current.artifacts, await service.artifactDigest(current.directory), 'artifacts changed');
        };
        const request = { snapshot, build, buildLog, verifyCurrent };
        let exported;
        await check(chip + ': real Nodu successful token produces package', async () => {
            exported = await producer.createArduinoSimulationPackage(request);
            item.export = { bytes: exported.bytes.length, packageSha256: exported.packageSha256, contentDigest: exported.contentDigest,
                elfSha256: exported.elfSha256, fullflashSha256: exported.fullflashSha256 };
            await fs.writeFile(path.join(root, chip + '-manifest.json'), JSON.stringify(exported.manifest, null, 2) + '\n');
        });
        if (!exported) { continue; }
        const destination = path.join(root, chip + '.esp-sim.zip');
        await check(chip + ': publish new immutable package', () => producer.publishArduinoSimulationPackage(exported, destination, verifyCurrent));
        await check(chip + ': independent Studio strict consumer accepts real package', async () => {
            const validation = await command('python3', ['-c', 'import hashlib,json,sys;from pathlib import Path;from studio.esp_firmware import validate_package;p=Path(sys.argv[1]);v=validate_package(p.read_bytes(),sys.argv[2]);print(json.dumps({"packageSHA256":v["packageSHA256"],"validation":v["validation"]}))', destination, chip], studio);
            await fs.writeFile(path.join(root, chip + '-studio-validation.log'), validation.output); assert.equal(validation.code, 0, validation.output);
            item.consumer = JSON.parse(validation.output);
        });
        await check(chip + ': existing export cannot be replaced', async () => {
            await assert.rejects(producer.publishArduinoSimulationPackage(exported, destination, verifyCurrent), /EEXIST/);
            assert.equal(sha(await fs.readFile(destination)), exported.packageSha256);
        });
        await check(chip + ': cancellation produces no new file', async () => {
            const controller = new AbortController(); controller.abort(); const cancelled = path.join(root, chip + '-cancelled.esp-sim.zip');
            await assert.rejects(producer.createArduinoSimulationPackage({ ...request, signal: controller.signal }), /停止/);
            await assert.rejects(producer.publishArduinoSimulationPackage(exported, cancelled, verifyCurrent, controller.signal), /停止/);
            assert.equal(await fs.stat(cancelled).catch(() => undefined), undefined);
        });
        await check(chip + ': successful token cannot use fabricated/post-build snapshot', async () => {
            await assert.rejects(producer.createArduinoSimulationPackage({ ...request, snapshot: { ...snapshot } }), /编译前/);
        });
        await check(chip + ': source change rejects and preserves prior package', async () => {
            const file = path.join(projectPath, name + '.ino'), before = await fs.readFile(file);
            try { await fs.appendFile(file, '\n// changed after success\n'); await assert.rejects(producer.createArduinoSimulationPackage(request), /source changed|源码/); }
            finally { await fs.writeFile(file, before); }
            assert.equal(sha(await fs.readFile(destination)), exported.packageSha256);
        });
        await check(chip + ': incomplete artifacts reject', async () => {
            const file = path.join(build.directory, name + '.ino.partitions.bin'), before = await fs.readFile(file);
            try { await fs.unlink(file); await assert.rejects(producer.createArduinoSimulationPackage(request), /artifacts changed|ENOENT|产物/); }
            finally { await fs.writeFile(file, before); }
        });
        await check(chip + ': tampered artifacts reject', async () => {
            const file = path.join(build.directory, name + '.ino.bin'), before = await fs.readFile(file), altered = Buffer.from(before); altered[100] ^= 1;
            try { await fs.writeFile(file, altered); await assert.rejects(producer.createArduinoSimulationPackage(request), /artifacts changed|产物/); }
            finally { await fs.writeFile(file, before); }
        });
        await check(chip + ': changed dependency content rejects export and publication', async () => {
            const dependency = dependencies.find(d => d.provider === 'library'), file = path.join(dependency.path, 'library.properties'), before = await fs.readFile(file);
            const destination = path.join(root, chip + '-changed-dependency.esp-sim.zip');
            try {
                await fs.appendFile(file, '\n# changed after successful compilation\n');
                await assert.rejects(producer.createArduinoSimulationPackage(request), /依赖内容已修改/);
                await assert.rejects(producer.publishArduinoSimulationPackage(exported, destination, verifyCurrent), /依赖内容已修改/);
            } finally { await fs.writeFile(file, before); }
            assert.equal(await fs.stat(destination).catch(() => undefined), undefined);
        });
        if (chip === 'esp32s3') {
            await check('mixed C3 ELF in S3 build rejects', async () => {
                const c3 = report.builds[0], file = path.join(build.directory, name + '.ino.elf'), before = await fs.readFile(file);
                try { await fs.copyFile(path.join(c3.compile.buildPath, 'nodu_sim_esp32c3.ino.elf'), file); await assert.rejects(producer.createArduinoSimulationPackage(request), /artifacts changed|产物/); }
                finally { await fs.writeFile(file, before); }
            });
        }
        await check(chip + ': revoked/failed build cannot export', async () => {
            service.builds.delete(build.token);
            await assert.rejects(producer.createArduinoSimulationPackage(request), /token no longer current/);
            const destination = path.join(root, chip + '-revoked.esp-sim.zip');
            await assert.rejects(producer.publishArduinoSimulationPackage(exported, destination, verifyCurrent), /token no longer current/);
            assert.equal(await fs.stat(destination).catch(() => undefined), undefined);
            service.builds.set(build.token, built);
        });
    }
    report.operations = operations; report.status = report.cases.every(c => c.status === 'PASS') && report.builds.length === 2 ? 'PASS' : 'FAIL';
    if (report.status !== 'PASS') { process.exitCode = 1; }
}
if (!process.env.NODU_SIM_EVIDENCE_DIR) { require('node:test').test('real Nodu simulation-package integration', { skip: 'Set NODU_SIM_EVIDENCE_DIR and a private seed home' }, () => {}); }
else main().catch(error => { report.status = 'FAIL'; report.error = error.stack; console.error(error); process.exitCode = 1; })
    .finally(async () => { service?.onStop(); report.operations = operations; report.finished = new Date().toISOString(); await evidence(); });
