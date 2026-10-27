// SPDX-License-Identifier: MIT
// Run from the repository root, passing an isolated evidence root as the first argument.
const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict');
const { createRequire } = require('node:module'), { createHash } = require('node:crypto');
const extension = path.resolve('desktop/scope-extension'), load = createRequire(path.join(extension, 'package.json'));
load('reflect-metadata');
const { parseDocument } = load('yaml');
const { NoduArduinoServer } = load('./lib/node/nodu-arduino-server');
const { parseProjectRequest, createSourceProject } = load('./lib/node/nodu-project-generator');
const root = path.resolve(process.argv[2]), label = process.argv[3] || '', evidence = path.join(root, label ? `run-${label}` : 'run');
const report = { started: new Date().toISOString(), hardware_accessed: false, root, checks: {}, commands: [], sourceHashes: {} };
let service, commandLogs = '', outputs = [];
const sha = data => createHash('sha256').update(data).digest('hex');
const save = () => fs.writeFile(path.join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
class LibraryService extends NoduArduinoServer {
    directory() { return path.join(root, 'home'); }
    binary() { return '/opt/homebrew/bin/arduino-cli'; }
    async run(...parameters) {
        const [, request, args, cwd, config, , , executable = this.binary(), raw = false] = parameters;
        const record = { executable, args: raw ? args : ['--config-file', config, ...args], cwd, operation: request.operationId };
        report.commands.push(record); const start = Date.now();
        const result = await super.run(...parameters); Object.assign(record, { code: result.code, elapsed_ms: Date.now() - start });
        commandLogs += JSON.stringify(record) + '\n' + result.output + '\n';
        await fs.writeFile(path.join(evidence, 'commands.log'), commandLogs); return result;
    }
}
(async () => {
    await fs.mkdir(evidence, { recursive: true });
    for (const name of ['nodu-arduino-server', 'nodu-arduino-libraries', 'nodu-project-generator']) {
        report.sourceHashes[name] = sha(await fs.readFile(path.join(extension, `lib/node/${name}.js`)));
    }
    const projectName = label ? `library_service_c3_${label}` : 'library_service_c3';
    const created = await createSourceProject(parseProjectRequest({ parent: root, name: projectName, chip: 'esp32c3', framework: 'arduino', template: 'hello' }));
    const project = created.path, profileFile = path.join(project, 'sketch.yaml'); report.project = project;
    const source = '#include <Arduino.h>\n#include <ArduinoJson.h>\n\nvoid setup() {\n  Serial.begin(115200);\n  JsonDocument doc;\n  doc["answer"] = 42;\n  serializeJson(doc, Serial);\n  Serial.println();\n}\n\nvoid loop() { delay(1000); }\n';
    await fs.writeFile(path.join(project, `${projectName}.ino`), source);
    let profile = '# Preserve the project note.\n' + await fs.readFile(profileFile, 'utf8');
    profile = profile.replace('fqbn: esp32:esp32:esp32c3', 'fqbn: esp32:esp32:esp32c3 # Preserve the board note.')
        .replace('- ArduinoMqttClient (0.1.8)', '- ArduinoMqttClient (0.1.8) # Preserve the unchanged MQTT pin note.');
    profile += '  # Preserve the other profile note.\n  backup:\n    fqbn: esp32:esp32:esp32c3\n    platforms:\n      - platform: esp32:esp32 (3.3.12)\n        platform_index_url: https://espressif.github.io/arduino-esp32/package_esp32_index.json\n    libraries:\n      - ArduinoJson (7.4.3)\n';
    await fs.writeFile(profileFile, profile); await fs.writeFile(path.join(evidence, 'before.sketch.yaml'), profile);
    const before = parseDocument(profile).toJS();
    const immutable = value => { const selected = { ...value.profiles.nodu }; delete selected.libraries; return { default_profile: value.default_profile, selected, backup: value.profiles.backup }; };
    const checkProfile = async label => {
        const current = await fs.readFile(profileFile, 'utf8'), document = parseDocument(current);
        assert.equal(document.errors.length, 0); assert.deepEqual(immutable(document.toJS()), immutable(before));
        const markers = ['Preserve the project note.', 'Preserve the board note.', 'Preserve the other profile note.', 'Preserve the unchanged MQTT pin note.'];
        const comments = Object.fromEntries(markers.map(marker => [marker, current.includes(marker)]));
        report.checks[label] = { standard_profile_preserved: true, comments, all_comments_preserved: Object.values(comments).every(Boolean) };
        await fs.writeFile(path.join(evidence, `${label}.sketch.yaml`), current);
        if (!report.checks[label].all_comments_preserved) { console.log(`COMMENT LOSS ${label}: ${JSON.stringify(comments)}`); }
        return document.toJS();
    };
    service = new LibraryService(); service.addClient({ onArduinoOutput(event) { outputs.push(event); } });
    const list = async filter => service.listLibraries({ path: project, query: 'ArduinoJson', filter, limit: 100 });
    const beforeList = await list('installed'); report.before = beforeList.items.find(item => item.name === 'ArduinoJson'); assert.equal(report.before.installedVersion, '7.4.3');
    console.log('Removing ArduinoJson through the actual service');
    report.remove = await service.changeLibrary({ path: project, name: 'ArduinoJson', action: 'remove', operationId: 'library-remove-json' });
    assert.equal(report.remove.ok, true, JSON.stringify(report.remove)); assert.equal(report.remove.changed, true);
    report.afterRemoveInstalled = await list('installed'); assert.ok(!report.afterRemoveInstalled.items.some(item => item.name === 'ArduinoJson'));
    report.afterRemoveAll = (await list('all')).items.find(item => item.name === 'ArduinoJson'); assert.equal(report.afterRemoveAll.installedVersion, undefined);
    const removed = await checkProfile('after-remove'); assert.ok(!removed.profiles.nodu.libraries.some(entry => typeof entry === 'string' && entry.startsWith('ArduinoJson ')));
    await save();
    console.log('Restoring ArduinoJson 7.4.3 through the actual service');
    report.add = await service.changeLibrary({ path: project, name: 'ArduinoJson', version: '7.4.3', action: 'add', operationId: 'library-add-json' });
    assert.equal(report.add.ok, true, JSON.stringify(report.add)); assert.equal(report.add.changed, true);
    report.afterAdd = (await list('installed')).items.find(item => item.name === 'ArduinoJson'); assert.equal(report.afterAdd.installedVersion, '7.4.3');
    const added = await checkProfile('after-add'); assert.ok(added.profiles.nodu.libraries.includes('ArduinoJson (7.4.3)'));
    const normalize = values => values.map(entry => JSON.stringify(entry)).sort(); assert.deepEqual(normalize(added.profiles.nodu.libraries), normalize(before.profiles.nodu.libraries));
    report.checks.dependency_versions_restored = true;
    console.log('Compiling the JsonDocument serial example');
    report.compile = await service.compile({ path: project, operationId: 'library-json-compile' }); assert.equal(report.compile.ok, true, JSON.stringify(report.compile));
    report.checks.ino_sha256 = sha(await fs.readFile(path.join(project, `${projectName}.ino`)));
    report.checks.source_unchanged = report.checks.ino_sha256 === sha(Buffer.from(source)); assert.equal(report.checks.source_unchanged, true);
    report.ok = report.checks['after-remove'].all_comments_preserved && report.checks['after-add'].all_comments_preserved;
    if (!report.ok) { report.error = 'An unchanged library entry comment was removed while changing ArduinoJson.'; process.exitCode = 1; }
})().catch(error => { report.ok = false; report.error = error.stack; process.exitCode = 1; console.error(error); })
    .finally(async () => { service?.onStop(); report.finished = new Date().toISOString(); await fs.writeFile(path.join(evidence, 'service-output.json'), JSON.stringify(outputs, null, 2) + '\n'); await save(); console.log(JSON.stringify({ ok: report.ok, evidence, error: report.error })); });
