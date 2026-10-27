// SPDX-License-Identifier: MIT
require('reflect-metadata');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createSourceProject, parseProjectRequest } = require('../lib/node/nodu-project-generator');
const { readArduinoProject, arduinoInputDigest, arduinoDiagnostics } = require('../lib/node/nodu-arduino-project');
const { NoduArduinoServer, arduinoConnection } = require('../lib/node/nodu-arduino-server');

async function fixture(t, source = '') {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodu-arduino-test-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const project = await createSourceProject(parseProjectRequest({ parent: dir, name: 'hello-c3', chip: 'esp32c3', template: 'hello' }));
    if (source) { await fs.appendFile(path.join(project.path, 'hello-c3.ino'), source); }
    const executable = path.join(dir, 'fake-cli');
    await fs.writeFile(executable, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
fs.appendFileSync(path.join(path.dirname(args[1]), 'calls.jsonl'), JSON.stringify({ args, config, environment: Object.keys(process.env).filter(k=>k.startsWith('ARDUINO_')) })+'\\n');
if (args.includes('version')) { console.log(JSON.stringify({ VersionString:'1.5.1' })); process.exit(0); }
const root = args.at(-1), file = path.join(root, path.basename(root)+'.ino'), source = fs.readFileSync(file, 'utf8');
if (source.includes('MUTATE')) { fs.appendFileSync(file, '//changed'); }
if (source.includes('INIT_BROKEN')) { console.error('Error initializing instance: Library fixture not found'); process.exit(0); }
if (source.includes('BROKEN')) { console.error(file+':4:7: error: invalid statement'); process.exit(1); }
const build = args[args.indexOf('--build-path')+1]; fs.mkdirSync(build,{recursive:true}); fs.writeFileSync(path.join(build,'fake.ino.bin'),'fixture');
if (args.includes('--only-compilation-database') && !source.includes('MISSING_DATABASE')) { fs.writeFileSync(path.join(build,'compile_commands.json'),JSON.stringify([{file,command:'fixture'}])); }
console.log('Compiling sketch');
if (source.includes('SLOW')) { setTimeout(()=>console.log('compiled'), 60000); } else { console.log('compiled'); }
`, { mode: 0o755 });
    class Server extends NoduArduinoServer { directory() { return path.join(dir, 'isolated'); } binary() { return executable; } }
    const server = new Server(); t.after(() => server.onStop());
    return { dir, root: project.path, server, request: { path: project.path, operationId: 'build-1' } };
}
function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function bootstrapFixture(t, source = '') {
    const f = await fixture(t, source), previous = process.env.NODU_ARDUINO_OFFLINE_BUNDLES;
    const bundles = path.join(f.dir, 'offline'); await fs.mkdir(bundles); await fs.writeFile(path.join(bundles, 'required.json'), '{}');
    process.env.NODU_ARDUINO_OFFLINE_BUNDLES = bundles;
    t.after(() => { if (previous === undefined) { delete process.env.NODU_ARDUINO_OFFLINE_BUNDLES; } else { process.env.NODU_ARDUINO_OFFLINE_BUNDLES = previous; } });
    // Lifecycle fixtures use the real operation/child management, without installing vendor tools.
    f.server.checkCli = async () => {};
    return f;
}

test('generated Arduino projects resolve the pinned profile; IDF and ambiguous profiles are rejected', async t => {
    const f = await fixture(t), config = await readArduinoProject(f.root);
    assert.equal(config.profile, 'nodu'); assert.equal(config.fqbn, 'esp32:esp32:esp32c3');
    const idf = await createSourceProject(parseProjectRequest({ parent: f.dir, name: 'idf', chip: 'esp32s3', template: 'hello', framework: 'esp-idf' }));
    await assert.rejects(readArduinoProject(idf.path), /不是 ESP32 Arduino/);
    await fs.appendFile(path.join(f.root, 'sketch.yaml'), '\ndefault_profile: another\n');
    await assert.rejects(readArduinoProject(f.root), /格式错误/);
});
test('compile uses profile and isolated config, never a shell or the user Arduino environment', async t => {
    const f = await fixture(t), events = []; f.server.addClient({ onArduinoOutput: e => events.push(e) });
    const result = await f.server.compile(f.request);
    assert.equal(result.ok, true); assert.equal(result.stale, false);
    const calls = (await fs.readFile(path.join(f.dir, 'isolated/calls.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.equal(calls.length, 2); const compile = calls[1];
    assert.deepEqual(compile.args.slice(2, 5), ['compile', '--profile', 'nodu']);
    assert.equal(compile.args.at(-1), f.root); assert.equal(compile.config.directories.data, path.join(await fs.realpath(f.dir), 'isolated/data'));
    assert.deepEqual(compile.environment, []); assert.ok(result.buildPath.startsWith(path.join(await fs.realpath(f.dir), 'isolated/builds')));
    assert.ok(events.some(e => e.line === 'Compiling sketch' && e.operationId === f.request.operationId));
});
test('failed compilation returns original sketch positions for the Problems panel', async t => {
    const f = await fixture(t, '\n// BROKEN\n'); const result = await f.server.compile(f.request);
    assert.equal(result.ok, false); assert.equal(result.buildPath, undefined);
    assert.equal(result.diagnostics.length, 1); assert.equal(result.diagnostics[0].absolute, path.join(f.root, 'hello-c3.ino'));
    assert.equal(result.diagnostics[0].line, 4); assert.equal(result.diagnostics[0].column, 7);
});
test('prepare requires a fresh compilation database and cannot reuse a prior successful result', async t => {
    const f = await fixture(t);
    assert.equal((await f.server.prepare({ ...f.request, operationId: 'prepare-ok' })).ok, true);
    await fs.appendFile(path.join(f.root, 'hello-c3.ino'), '\n// MISSING_DATABASE\n');
    const missing = await f.server.prepare({ ...f.request, operationId: 'prepare-missing' });
    assert.equal(missing.ok, false); assert.ok(missing.error);
});
test('a zero-exit CLI initialization error fails prepare and compile without issuing a build token', async t => {
    const f = await fixture(t, '\n// INIT_BROKEN\n');
    const prepared = await f.server.prepare({ ...f.request, operationId: 'prepare-init-error' });
    assert.equal(prepared.ok, false); assert.ok(prepared.error);
    const compiled = await f.server.compile(f.request);
    assert.equal(compiled.ok, false); assert.ok(compiled.error); assert.equal(compiled.buildToken, undefined);
});
test('a successful process cannot validate a build after input changes', async t => {
    const f = await fixture(t, '\n// MUTATE\n'); const result = await f.server.compile(f.request);
    assert.equal(result.ok, false); assert.equal(result.stale, true);
});
test('one operation owns the compiler; unrelated cancellation cannot kill it', async t => {
    const f = await fixture(t, '\n// SLOW\n');
    let started; const ready = new Promise(resolve => { started = resolve; });
    f.server.addClient({ onArduinoOutput: e => { if (e.line === 'Compiling sketch') { started(); } } });
    const pending = f.server.compile(f.request); await ready;
    assert.equal((await f.server.compile({ ...f.request, operationId: 'build-2' })).ok, false);
    await f.server.cancel('not-this-operation');
    await f.server.cancel(f.request.operationId);
    assert.equal((await pending).cancelled, true);
    await fs.writeFile(path.join(f.root, 'hello-c3.ino'), 'void setup() {}\nvoid loop() {}\n');
    assert.equal((await f.server.compile({ ...f.request, operationId: 'build-3' })).ok, true);
});
test('input digests include dependencies and profile but ignore generated output', async t => {
    const f = await fixture(t), before = await arduinoInputDigest(f.root);
    await fs.mkdir(path.join(f.root, 'build')); await fs.writeFile(path.join(f.root, 'build/test.bin'), 'output');
    assert.equal(await arduinoInputDigest(f.root), before);
    await fs.appendFile(path.join(f.root, 'sketch.yaml'), '# change\n'); assert.notEqual(await arduinoInputDigest(f.root), before);
    await fs.symlink(path.join(f.root, 'sketch.yaml'), path.join(f.root, 'external.h'));
    await assert.rejects(arduinoInputDigest(f.root), /符号链接/);
});
test('diagnostics handle Windows drive paths, ANSI and duplicate messages', () => {
    const line = '\u001b[31mC:\\demo\\hello.ino:12:3: warning: unused variable\u001b[0m';
    const items = arduinoDiagnostics(line+'\n'+line, '/root');
    assert.equal(items.length, 1); assert.equal(items[0].line, 12); assert.equal(items[0].severity, 'warning');
});
test('custom platform indexes cannot replace the official ESP32 compiler recipe', async t => {
    const f = await fixture(t), file = path.join(f.root, 'sketch.yaml');
    await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('https://espressif.github.io/arduino-esp32/package_esp32_index.json', 'https://untrusted.invalid/index.json'));
    assert.equal((await f.server.compile(f.request)).ok, false);
    await assert.rejects(fs.access(path.join(f.dir, 'isolated/calls.jsonl')));
});
test('disconnect cancels owned work; stale or foreign request IDs do not cancel a new build', async t => {
    const f = await fixture(t, '\n// SLOW\n');
    let started; const ready = new Promise(resolve => { started = resolve; });
    const connection = arduinoConnection(f.server, { onArduinoOutput: e => {
        assert.equal(e.operationId, 'build-1'); if (e.line === 'Compiling sketch') { started(); }
    } });
    const other = arduinoConnection(f.server, { onArduinoOutput() { assert.fail('output crossed connection boundary'); } });
    const pending = connection.service.compile(f.request); await ready;
    await other.service.cancel('build-1'); await connection.service.cancel('previous-request');
    assert.ok(f.server.active); assert.equal(f.server.active.cancelled, false);
    connection.dispose(); assert.equal((await pending).cancelled, true);
    await assert.rejects(connection.service.compile(f.request), /连接已关闭/);
    other.dispose();
});
test('disconnect terminates the owned first-open initialization child and permits a fresh retry', async t => {
    const f = await bootstrapFixture(t), started = gate(), originalRun = f.server.run.bind(f.server);
    await fs.writeFile(path.join(f.dir, 'fake-cli'), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
    f.server.run = (...args) => { const pending = originalRun(...args); started.resolve(); return pending; };
    const connection = arduinoConnection(f.server, { onArduinoOutput() {} });
    const pending = connection.service.inspect(f.root).then(value => ({ value }), error => ({ error }));
    await started.promise;
    const pid = f.server.active.child.pid; assert.ok(pid); connection.dispose();
    assert.match((await pending).error.message, /停止|abort/i);
    assert.equal(f.server.active, undefined); assert.equal(f.server.baseEnvironment, undefined);
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    await assert.rejects(connection.service.inspect(f.root), /连接已关闭/);
    f.server.run = async (_operation, _request, args) => {
        const build = args[args.indexOf('--build-path') + 1]; await fs.mkdir(build, { recursive: true });
        await fs.writeFile(path.join(build, 'compile_commands.json'), '[{"file":"fixture.cpp"}]'); return { code: 0, output: '' };
    };
    const retry = arduinoConnection(f.server, { onArduinoOutput() {} });
    assert.equal((await retry.service.inspect(f.root)).chip, 'esp32c3'); retry.dispose();
});
test('an inspect disconnected while queued behind a compile cannot start initialization later', async t => {
    const f = await bootstrapFixture(t, '\n// SLOW\n'), compiling = gate(), queued = gate();
    const originalRun = f.server.run.bind(f.server), initialize = f.server.initializeBundledEnvironment.bind(f.server); let bootstrapRuns = 0;
    f.server.run = (...args) => {
        if (args[2].includes('--only-compilation-database')) { bootstrapRuns++; }
        const pending = originalRun(...args); compiling.resolve(); return pending;
    };
    const build = f.server.compile(f.request); await compiling.promise;
    f.server.initializeBundledEnvironment = (...args) => { const pending = initialize(...args); queued.resolve(); return pending; };
    const connection = arduinoConnection(f.server, { onArduinoOutput() {} });
    const inspect = connection.service.inspect(f.root).then(value => ({ value }), error => ({ error }));
    await queued.promise; connection.dispose();
    assert.equal(f.server.active.id, f.request.operationId); assert.equal(f.server.active.cancelled, false);
    await f.server.cancel(f.request.operationId); assert.equal((await build).cancelled, true);
    assert.match((await inspect).error.message, /abort/i);
    assert.equal(bootstrapRuns, 0); assert.equal(f.server.active, undefined); assert.equal(f.server.baseEnvironment, undefined);
});
test('disconnecting a shared initialization waiter does not cancel the owning connection', async t => {
    const f = await bootstrapFixture(t), started = gate(), finish = gate(), waiting = gate(); let runs = 0;
    t.after(() => finish.resolve());
    f.server.run = async (_operation, _request, args) => {
        runs++; started.resolve(); await finish.promise;
        const build = args[args.indexOf('--build-path') + 1]; await fs.mkdir(build, { recursive: true });
        await fs.writeFile(path.join(build, 'compile_commands.json'), '[{"file":"fixture.cpp"}]'); return { code: 0, output: '' };
    };
    const owner = arduinoConnection(f.server, { onArduinoOutput() {} }), waiter = arduinoConnection(f.server, { onArduinoOutput() {} });
    const ownerInspect = owner.service.inspect(f.root); await started.promise;
    const initialize = f.server.initializeBundledEnvironment.bind(f.server);
    f.server.initializeBundledEnvironment = (...args) => { const pending = initialize(...args); waiting.resolve(); return pending; };
    const waiterInspect = waiter.service.inspect(f.root).then(value => ({ value }), error => ({ error }));
    await waiting.promise; waiter.dispose(); assert.equal(f.server.active.cancelled, false);
    finish.resolve(); assert.equal((await ownerInspect).chip, 'esp32c3');
    assert.match((await waiterInspect).error.message, /abort/i); assert.equal(runs, 1); owner.dispose();
});
test('board options come from the pinned core and serial settings do not change build inputs', async t => {
    const f = await fixture(t), before = await arduinoInputDigest(f.root);
    const info = await f.server.inspect(f.root);
    assert.equal(info.chip, 'esp32c3'); assert.equal(info.monitor.baud, 115200);
    const boards = await f.server.boards(f.root); assert.ok(boards.length > 0); assert.ok(boards.every(b => b.chip === 'esp32c3'));
    const options = await f.server.boardOptions(f.root); assert.ok(options.some(o => o.id === 'CDCOnBoot'));
    await assert.rejects(f.server.configure({ path: f.root, fqbn: 'esp32:esp32:esp32s3' }), /芯片不匹配/);
    await f.server.configure({ path: f.root, port: '/dev/cu.upload', monitor: { port: '/dev/cu.monitor', baud: 9600, encoding: 'gbk' } });
    const changed = await f.server.configure({ path: f.root, port: '/dev/cu.upload-2' });
    assert.equal(changed.port, '/dev/cu.upload-2'); assert.equal(changed.monitor.port, '/dev/cu.monitor');
    assert.equal(changed.monitor.baud, 9600); assert.equal(changed.monitor.encoding, 'gbk');
    assert.equal(await arduinoInputDigest(f.root), before);
    await f.server.configure({ path: f.root, options: { CDCOnBoot: 'cdc' } });
    assert.notEqual(await arduinoInputDigest(f.root), before);
    await assert.rejects(f.server.configure({ path: f.root, options: { CDCOnBoot: 'wrong' } }), /无效的开发板参数/);
});
test('upload refuses stale source or modified artifacts before borrowing any serial port', async t => {
    const f = await fixture(t); let leases = 0;
    f.server.embedded = { acquireArduinoPort: async () => { leases++; throw new Error('must not borrow'); } };
    const first = await f.server.compile(f.request); assert.ok(first.buildToken);
    await fs.appendFile(path.join(f.root, 'hello-c3.ino'), '\n// edited');
    const stale = await f.server.upload({ ...f.request, operationId: 'upload-1', port: '/dev/cu.test', buildToken: first.buildToken });
    assert.equal(stale.ok, false); assert.match(stale.error, /重新编译/); assert.equal(leases, 0);
    const second = await f.server.compile({ ...f.request, operationId: 'build-2' }); assert.ok(second.buildToken);
    await fs.appendFile(path.join(second.buildPath, 'fake.ino.bin'), 'tampered');
    const changed = await f.server.upload({ ...f.request, operationId: 'upload-2', port: '/dev/cu.test', buildToken: second.buildToken });
    assert.equal(changed.ok, false); assert.match(changed.error, /重新编译/); assert.equal(leases, 0);
});
