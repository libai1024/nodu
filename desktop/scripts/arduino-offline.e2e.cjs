// SPDX-License-Identifier: MIT
'use strict';

// Opt-in cold-start acceptance. The worker and every compiler child run with
// macOS ARM64 network access denied, no developer CLI on PATH, and a brand-new home.
// No physical device, user Arduino installation, or warm cache is used.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createRequire } = require('node:module');
const { parseArgs, promisify } = require('node:util');
const { values } = parseArgs({ options: { worker: { type: 'boolean' }, root: { type: 'string' }, resources: { type: 'string' }, bundles: { type: 'string' } }, allowPositionals: false });
const extensionRequire = createRequire(path.resolve(__dirname, '../scope-extension/package.json'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const cleanPath = '/usr/bin:/bin:/usr/sbin:/sbin';
const execFileAsync = promisify(execFile);
const source = `#include <Arduino.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <ArduinoMqttClient.h>
#include <Adafruit_SSD1306.h>
#include <Adafruit_GFX.h>
#include <Adafruit_I2CDevice.h>
#include <Adafruit_NeoPixel.h>
#include <DHT.h>
#include <Adafruit_Sensor.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ESP32Servo.h>
// Compile fixture only: these pin numbers are not a board wiring recommendation.
WiFiClient transport;
MqttClient mqtt(transport);
Adafruit_SSD1306 oled(128, 64, &Wire, -1);
Adafruit_I2CDevice i2c(0x3c);
Adafruit_NeoPixel pixels(1, 4, NEO_GRB + NEO_KHZ800);
DHT dht(5, DHT22);
OneWire wire(6);
DallasTemperature temperatures(&wire);
Servo servo;
void setup() {
  Serial.begin(115200);
  JsonDocument json;
  deserializeJson(json, "{\\"ok\\":true}");
  serializeJson(json, Serial);
  mqtt.setId("nodu-offline-compile-check");
  oled.begin(SSD1306_SWITCHCAPVCC, 0x3c);
  oled.drawPixel(0, 0, SSD1306_WHITE);
  i2c.begin(); pixels.begin(); pixels.setPixelColor(0, 12, 0, 0); pixels.show();
  dht.begin(); Serial.println(dht.readTemperature());
  temperatures.begin(); temperatures.requestTemperatures();
  servo.attach(7); servo.write(90);
}
void loop() { delay(1000); }
`;

function deniedNetwork(host) {
    return new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port: 9 });
        socket.once('connect', () => { socket.destroy(); reject(new Error(`Network is not denied: ${host}`)); });
        socket.once('error', error => {
            if (['EPERM', 'EACCES'].includes(error.code)) { resolve({ host, port: 9, code: error.code }); }
            else { reject(new Error(`Expected policy denial for ${host}, got ${error.code}`)); }
        });
        socket.setTimeout(2000, () => { socket.destroy(); reject(new Error(`Network probe timed out: ${host}`)); });
    });
}

async function worker() {
    const root = await fs.realpath(values.root), evidence = path.join(root, 'evidence'), home = path.join(root, 'home');
    const report = { schema: 1, started: new Date().toISOString(), root, home, hardwareAccessed: false,
        networkPolicy: 'macOS sandbox-exec deny network* (inherited by all subprocesses)', commands: [], cases: [], events: [] };
    let service;
    await fs.mkdir(evidence);
    const saveReport = () => fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    try {
        report.networkProbes = await Promise.all(['127.0.0.1', '1.1.1.1'].map(deniedNetwork));
        assert.equal(process.env.PATH, cleanPath);
        assert.equal(process.env.NODU_ARDUINO_HOME, home);
        assert.equal(process.env.NODU_ARDUINO_CLI, undefined);
        assert.equal(await fs.stat(home).catch(() => undefined), undefined, 'The cold home must not exist before the service runs');
        report.cleanPath = process.env.PATH;
        const resources = await fs.realpath(values.resources), bundles = await fs.realpath(values.bundles || path.join(resources, 'offline'));
        const bundlePath = path.join(bundles, `${process.platform}-${process.arch}`, 'manifest.json');
        const manifestBytes = await fs.readFile(bundlePath), manifest = JSON.parse(manifestBytes);
        report.bundle = { path: bundlePath, id: manifest.id, host: manifest.host, sha256: sha(manifestBytes), files: manifest.files.length,
            cliVersion: manifest.cliVersion, coreVersion: manifest.coreVersion, releaseReady: manifest.releaseReady,
            runtimeManifestSha256: sha(Buffer.from(JSON.stringify(manifest.files.filter(file => file.target).sort((a, b) => a.target.localeCompare(b.target))))),
            runtimeFiles: manifest.files.filter(file => file.target).length, runtimeBytes: manifest.files.filter(file => file.target).reduce((sum, file) => sum + file.size, 0) };
        assert.equal(manifest.host, `${process.platform}-${process.arch}`);
        const libraries = JSON.parse(await fs.readFile(path.join(resources, 'libraries/manifest.json'))).libraries;
        assert.equal(libraries.length, 11);
        extensionRequire('reflect-metadata');
        const { NoduArduinoServer } = require('../scope-extension/lib/node/nodu-arduino-server');
        const { NoduArduinoLanguageServer } = require('../scope-extension/lib/node/nodu-arduino-language');
        const { createSourceProject, parseProjectRequest } = require('../scope-extension/lib/node/nodu-project-generator');
        const yaml = extensionRequire('yaml');
        class RecordedService extends NoduArduinoServer {
            resolvedCli() { return super.binary(); }
            async run(...parameters) {
                const [, request, args, cwd, config, , , executable = this.binary(), raw = false] = parameters;
                assert.ok(executable.startsWith(home + path.sep), `Compiler launcher escaped the clean home: ${executable}`);
                const record = { executable, args: raw ? args : ['--config-file', config, ...args], cwd, operation: request.operationId,
                    log: `${String(report.commands.length + 1).padStart(2, '0')}-${request.operationId}.log` };
                report.commands.push(record);
                const started = Date.now();
                try {
                    const result = await super.run(...parameters);
                    Object.assign(record, { code: result.code, elapsedMs: Date.now() - started });
                    await fs.writeFile(path.join(evidence, record.log), result.output);
                    return result;
                } catch (error) { record.error = error.stack; throw error; }
            }
        }
        const makeService = () => {
            const server = new RecordedService();
            server.addClient({ onArduinoOutput(event) { report.events.push(event); } });
            return server;
        };
        const parent = path.join(root, 'projects with spaces'); await fs.mkdir(parent);
        service = makeService();
        for (const chip of ['esp32c3', 'esp32s3']) {
            const item = { chip, name: `offline_${chip}` }; report.cases.push(item);
            const generated = await createSourceProject(parseProjectRequest({ parent, name: item.name, chip, framework: 'arduino', template: 'hello' }));
            const sketch = path.join(generated.path, `${item.name}.ino`);
            item.project = generated.path;
            const profileText = await fs.readFile(path.join(generated.path, 'sketch.yaml'), 'utf8');
            const profile = yaml.parse(profileText).profiles.nodu;
            assert.equal(profile.libraries.length, 11);
            item.profile = profile;
            // Opening an unfinished sketch must initialize the environment
            // without compiling, saving, or otherwise changing the user's file.
            const draft = source + '\nvoid unfinished(\n';
            await fs.writeFile(sketch, draft);
            item.draftSha256 = sha(Buffer.from(draft));
            await fs.copyFile(path.join(generated.path, 'sketch.yaml'), path.join(evidence, `${chip}.sketch.yaml`));
            console.log(`${chip}: opening an unfinished sketch initializes bundled tools`);
            const openStarted = Date.now();
            item.openInspect = await service.inspect(generated.path);
            item.openElapsedMs = Date.now() - openStarted;
            assert.equal(item.openInspect.ready, true, JSON.stringify(item.openInspect));
            assert.equal(sha(await fs.readFile(sketch)), item.draftSha256, 'Opening must preserve the unfinished source');
            assert.equal(await fs.readFile(path.join(generated.path, 'sketch.yaml'), 'utf8'), profileText, 'Opening must preserve the profile');
            item.openLanguage = await new NoduArduinoLanguageServer().spec({ path: generated.path });
            assert.equal(item.openLanguage.ok, true, JSON.stringify(item.openLanguage));
            assert.ok(item.openLanguage.command.startsWith(path.resolve(resources, '../bin') + path.sep), 'Opening must use the bundled language server');
            assert.ok(item.openLanguage.args[item.openLanguage.args.indexOf('-cli') + 1].startsWith(path.join(home, 'bin') + path.sep), 'Opening must use the managed CLI');
            if (!report.nativeCtags) {
                const tool = manifest.files.find(file => file.target?.startsWith('tools/ctags/') && file.target.endsWith('/ctags'));
                assert.ok(tool, 'Apple Silicon bundle must include native ctags');
                const executable = path.join(home, tool.target), bytes = await fs.readFile(executable);
                assert.equal(bytes.readUInt32LE(0), 0xfeedfacf, 'ctags must be a native Mach-O 64-bit executable');
                assert.equal(bytes.readUInt32LE(4), 0x0100000c, 'ctags must use the ARM64 CPU type');
                const file = await execFileAsync('/usr/bin/file', [executable]);
                const version = await execFileAsync(executable, ['--version']);
                const platform = manifest.files.find(file => file.target?.endsWith('/platform.local.txt'));
                assert.ok(platform, 'Core must select bundled native ctags');
                const override = await fs.readFile(path.join(home, platform.target), 'utf8');
                assert.match(override, /tools\/ctags\/darwin-arm64/);
                report.nativeCtags = { executable, sha256: sha(bytes), cpuType: 'ARM64 (0x0100000c)', file: file.stdout.trim(),
                    version: version.stdout.trim(), platformLocal: override, officialX64Execution: 'denied by sandbox policy' };
                await fs.writeFile(path.join(evidence, 'platform.local.txt'), override);
            }
            await fs.writeFile(sketch, source);
            await fs.copyFile(sketch, path.join(evidence, `${chip}.ino`));
            console.log(`${chip}: cold home compile with bundled tools and all 11 libraries`);
            const started = Date.now();
            item.compile = await service.compile({ path: generated.path, operationId: `offline-${chip}` });
            item.elapsedMs = Date.now() - started;
            assert.equal(item.compile.ok, true, JSON.stringify(item.compile));
            assert.ok(item.compile.buildToken);
            item.cli = service.resolvedCli();
            assert.ok(item.cli.startsWith(path.join(home, 'bin') + path.sep));
            item.inspect = await service.inspect(generated.path); assert.equal(item.inspect.ready, true);
            item.language = await new NoduArduinoLanguageServer().spec({ path: generated.path });
            assert.equal(item.language.ok, true, JSON.stringify(item.language));
            assert.ok(item.language.command.startsWith(path.resolve(resources, '../bin') + path.sep), 'Language server must be bundled');
            assert.ok(item.language.args[item.language.args.indexOf('-cli') + 1].startsWith(path.join(home, 'bin') + path.sep), 'Language service must reuse the managed CLI');
            const buildOptions = JSON.parse(await fs.readFile(path.join(item.compile.buildPath, 'build.options.json'), 'utf8'));
            await fs.writeFile(path.join(evidence, `${chip}.build.options.json`), JSON.stringify(buildOptions, null, 2) + '\n');
            item.buildFqbn = buildOptions.fqbn;
            assert.ok(buildOptions.fqbn.startsWith(`esp32:esp32:${chip}`));
            item.artifacts = [];
            for (const name of (await fs.readdir(item.compile.buildPath)).filter(name => /\.(bin|elf)$/.test(name))) {
                const bytes = await fs.readFile(path.join(item.compile.buildPath, name));
                item.artifacts.push({ name, size: bytes.length, sha256: sha(bytes) });
            }
            item.ok = true; await saveReport();
            // A fresh service instance must use Nodu's managed CLI without PATH or Homebrew.
            service.onStop(); service = makeService();
        }
        const reopened = report.cases[0];
        console.log('esp32c3: reopened service reuses the bundled environment');
        const repeat = await service.compile({ path: reopened.project, operationId: 'offline-reopen-c3' });
        report.reopen = { ok: repeat.ok, cli: service.resolvedCli(), result: repeat };
        assert.equal(repeat.ok, true, JSON.stringify(repeat));
        assert.ok(report.reopen.cli.startsWith(path.join(home, 'bin') + path.sep));
        assert.ok(report.commands.every(command => command.executable.startsWith(path.join(home, 'bin') + path.sep)));
        report.ok = true;
    } catch (error) { report.ok = false; report.error = error.stack; process.exitCode = 1; console.error(error.stack); }
    finally {
        service?.onStop(); report.finished = new Date().toISOString(); await saveReport();
        console.log(JSON.stringify({ ok: report.ok, evidence, cases: report.cases.map(item => ({ chip: item.chip, ok: item.ok, elapsedMs: item.elapsedMs })) }));
    }
}

async function launch() {
    assert.equal(process.platform, 'darwin', 'This acceptance runner requires macOS sandbox-exec; it does not claim offline isolation on other hosts.');
    assert.equal(process.arch, 'arm64', 'This acceptance runner checks Apple Silicon without Rosetta; other host variants need their own execution policy.');
    assert.equal(values.root, undefined, 'The launcher always creates a new empty root; --root is reserved for its worker.');
    const resources = await fs.realpath(values.resources || path.resolve(__dirname, '../scope-extension/resources/arduino'));
    const bundles = await fs.realpath(values.bundles || path.join(resources, 'offline'));
    await fs.access(path.join(bundles, `${process.platform}-${process.arch}`, 'manifest.json'));
    const root = await fs.realpath(await fs.mkdtemp('/private/tmp/nodu-arduino-offline-'));
    await fs.copyFile(__filename, path.join(root, 'runner.cjs'));
    const deniedPaths = [path.join(os.homedir(), 'Library/Arduino15'), path.join(os.homedir(), '.arduino15'),
        path.join(os.homedir(), '.local/share/bysj-common-app/arduino'), path.join(os.homedir(), '.nodu/arduino'),
        '/Applications/Arduino IDE.app', '/private/tmp/nodu-arduino-e2e-20261026',
        '/opt/homebrew/bin/arduino-cli', '/usr/local/bin/arduino-cli'];
    const allDenied = [...new Set(deniedPaths.flatMap(item => {
        try { return [item, fsSync.realpathSync(item)]; } catch { return [item]; }
    }))];
    const policy = '(version 1)\n(allow default)\n(deny network*)\n'
        + allDenied.map(item => `(deny file-read* (subpath ${JSON.stringify(item)}))`).join('\n') + '\n'
        + `(deny process-exec (literal ${JSON.stringify(path.join(root, 'home/data/packages/builtin/tools/ctags/5.8-arduino11/ctags'))}))\n`;
    const policyFile = path.join(root, 'sandbox.sb'); await fs.writeFile(policyFile, policy);
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('ARDUINO_') && !key.startsWith('NODU_ARDUINO_') && !['NODE_PATH', 'NODE_OPTIONS'].includes(key)));
    env.PATH = cleanPath; env.NODU_ARDUINO_HOME = path.join(root, 'home'); env.NODU_ARDUINO_RESOURCES = resources; env.NODU_ARDUINO_OFFLINE_BUNDLES = bundles;
    console.log(`Evidence root: ${root}`);
    const args = ['-f', policyFile, process.execPath, __filename, '--worker', '--root', root, '--resources', resources, '--bundles', bundles];
    await fs.writeFile(path.join(root, 'launch.json'), JSON.stringify({ executable: '/usr/bin/sandbox-exec', args, path: cleanPath, deniedPaths: allDenied,
        runnerSha256: sha(await fs.readFile(__filename)) }, null, 2) + '\n');
    const code = await new Promise((resolve, reject) => {
        const child = spawn('/usr/bin/sandbox-exec', args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        const log = fsSync.createWriteStream(path.join(root, 'worker.log'));
        child.stdout.on('data', bytes => { log.write(bytes); process.stdout.write(bytes); });
        child.stderr.on('data', bytes => { log.write(bytes); process.stderr.write(bytes); });
        child.once('error', reject); child.once('close', (code, signal) => { log.end(); resolve(signal ? 1 : code); });
    });
    process.exitCode = code;
}

(values.worker ? worker() : launch()).catch(error => { console.error(error.stack); process.exitCode = 1; });
