// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('reflect-metadata');
const { NoduDeviceServer } = require('../lib/node/nodu-device-server');

test('device filesystem rejects traversal and protects board startup files before opening serial', () => {
    const server = new NoduDeviceServer();
    for (const path of ['/etc/passwd', '/flash/../boot.py', '/flash/a\0b', '/sd/../flash/main.py']) {
        assert.throws(() => server.readFile(path), /路径/);
    }
    for (const path of ['/flash/boot.py', '/flash/main.py', '/sd/main.py']) {
        assert.throws(() => server.writeFile(path, 'eA==', true), /保护/);
    }
    server.onStop();
});

test('formatScript and startup confirmation validate before the worker', () => {
    const server = new NoduDeviceServer();
    assert.throws(() => server.formatScript('   ', true, false), /非空/);
    assert.throws(() => server.formatScript('x'.repeat(256 * 1024 + 1), false, false), /256 KiB/);
    // Non-boolean confirmedStartup is treated as unconfirmed, never as truthy.
    assert.throws(() => server.writeFile('/flash/boot.py', 'eA==', true, 'yes'), /保护/);
    assert.throws(() => server.writeFile('/flash/main.py', 'eA==', true, 1), /保护/);
    server.onStop();
});

test('media methods validate file:// URIs before the worker', () => {
    const server = new NoduDeviceServer();
    for (const bad of [`file:///${'a'.repeat(5000)}`, 'file:///a\0b.bin',
        '/tmp/plain-path.bin', 'https://example.com/x.bin',
        'file://server/share/x.bin', 'file://192.168.0.10/tmp/x.bin',
        'file:///tmp/x.bin?y=1', 'file:///tmp/x.bin#frag']) {
        assert.throws(() => server.startRecording(bad), /路径|file|\.bin/, bad);
        assert.throws(() => server.playVideo(bad), /路径|file/, bad);
    }
    // Encoded space/# round-trip and a localhost authority are valid locals.
    const mediaPath = server.mediaPath.bind(server);
    assert.equal(mediaPath('file:///tmp/a%20b.bin', 'x'), '/tmp/a b.bin');
    assert.equal(mediaPath('file:///tmp/a%23b.bin', 'x'), '/tmp/a#b.bin');
    assert.equal(mediaPath('file://localhost/tmp/x.bin', 'x'), '/tmp/x.bin');
    assert.throws(() => server.startRecording('file:///tmp/rec.mp4'), /\.bin/);
    assert.throws(() => server.convertVideo('file:///tmp/a.bin', 'file:///tmp/out.gif'), /mp4|avi|mjpeg/);
    server.onStop();
});

// The model fetcher must abort mid-stream at its bound, not after allocating
// the full body, and must refuse to follow redirects off HTTPS.
test('fetch-models bounded reader enforces the 2 MiB streaming bound', async () => {
    const http = require('node:http');
    const { fetchBounded, MAX_BYTES } = require('../../scripts/fetch-models.cjs');
    const srv = http.createServer((req, res) => {
        if (req.url === '/big') {
            res.writeHead(200, { 'content-type': 'application/octet-stream' });
            const chunk = Buffer.alloc(1024 * 1024, 1);
            let sent = 0;
            const timer = setInterval(() => {
                res.write(chunk);
                sent += chunk.length;
                if (sent > 8 * 1024 * 1024) { clearInterval(timer); res.end(); }
            }, 5);
            req.on('close', () => clearInterval(timer));
        } else if (req.url === '/redir') {
            res.writeHead(302, { location: `http://127.0.0.1:${srv.address().port}/small` });
            res.end();
        } else {
            res.writeHead(200); res.end('ok-body');
        }
    });
    await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
    try {
        const base = `http://127.0.0.1:${srv.address().port}`;
        const small = await fetchBounded(`${base}/small`, 'small');
        assert.equal(small.toString(), 'ok-body');
        assert.equal(MAX_BYTES, 2 * 1024 * 1024);
        await assert.rejects(fetchBounded(`${base}/big`, 'big'), /2 MiB/);
        await assert.rejects(fetchBounded(`${base}/redir`, 'redir'), /HTTPS/);
    } finally {
        srv.close();
    }
});

test('malformed and oversized payloads never reach the worker', () => {
    const server = new NoduDeviceServer();
    assert.throws(() => server.writeFile('/flash/nodu-test.txt', '%%%not-base64', false), /有效数据/);
    assert.throws(() => server.writeFile('/flash/nodu-test.txt', Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64'), false), /2 MiB/);
    assert.throws(() => server.runScript('  '), /非空/);
    assert.throws(() => server.execute('x'.repeat(256 * 1024 + 1)), /256 KiB/);
    server.onStop();
});

test('invalid connections fail before port probing', async () => {
    const server = new NoduDeviceServer();
    await assert.rejects(server.connect({ port: '', boardProfile: 'generic-k210' }), /串口/);
    await assert.rejects(server.connect({ port: '/dev/fake', boardProfile: 'not-a-board' }), /板型/);
    await assert.rejects(server.connect({ port: '/dev/fake', boardProfile: 'generic-k210', baud: 1 }), /115200/);
    assert.equal((await server.getState()).phase, 'disconnected');
    server.onStop();
});

test('disconnect cancels a connection still waiting on port discovery', async () => {
    const server = new NoduDeviceServer();
    let finishProbe;
    server.listPorts = () => new Promise(resolve => { finishProbe = resolve; });
    let actualConnects = 0;
    server.request = async method => { if (method === 'connect') actualConnects++; };
    const attempt = server.connect({ port: '/dev/fake', boardProfile: 'generic-k210' });
    await server.disconnect();
    finishProbe([{ path: '/dev/fake', description: 'test' }]);
    await assert.rejects(attempt, /取消/);
    assert.equal(actualConnects, 0);
    await server.onStop();
});

test('another client cannot queue a short-timeout request behind an active firmware write', async () => {
    const server = new NoduDeviceServer();
    server.flashTask = new Promise(() => {});
    await assert.rejects(server.listPorts(), /固件/);
    await assert.rejects(server.stop(), /固件/);
    await assert.rejects(server.disconnect(), /固件/);
    assert.equal((await server.getState()).phase, 'disconnected');
    server.flashTask = undefined;
    await server.onStop();
});

test('firmware write never kills the sidecar at the Node request deadline', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = new NoduDeviceServer();
    let killed = 0;
    const worker = { stdin: { write() {}, end() {} }, kill() { killed++; } };
    server.worker = worker;
    server.ensureWorker = () => worker;
    server.backupDirectory = '/backups/verified';
    const task = server.flashFirmware('/backups/verified');
    const settled = task.catch(() => undefined);
    try {
        t.mock.timers.tick(900001);
        assert.equal(killed, 0, 'Node must not terminate a writer during flash');
        assert.equal(server.pending.size, 1, 'the worker owns the deadline and recovery');
    } finally {
        const pending = server.pending.get(1);
        if (pending) { server.pending.delete(1); pending.resolve({ verified: true }); }
        await settled;
        server.flashTask = undefined;
        server.shutdown();
    }
});

test('losing the last UI client defers cleanup until the firmware critical section ends', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const server = new NoduDeviceServer();
    let disconnected = 0;
    server.disconnect = async () => { disconnected++; };
    const remove = server.addClient({ onState() {}, onLog() {}, onFrame() {} });
    server.flashTask = new Promise(() => {});
    remove();
    t.mock.timers.tick(5000);
    assert.equal(disconnected, 0);
    server.flashTask = undefined;
    t.mock.timers.tick(5000);
    await Promise.resolve();
    assert.equal(disconnected, 1);
    await server.onStop();
});

// End-to-end against the Rust sidecar's --mock transport (no hardware).
// Requires `npm run build:native` to have produced the dev release binary.
test('rust sidecar mock board: connect, REPL execute, file round-trip, disconnect', async t => {
    const { existsSync } = require('node:fs');
    const { join } = require('node:path');
    const binary = join(__dirname, '..', '..', 'native', 'target', 'release',
        process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
    if (!existsSync(binary)) { t.skip('nodu-device release binary missing; run npm run build:native'); return; }
    const savedBin = process.env.NODU_DEVICE_BIN;
    const savedMock = process.env.NODU_DEVICE_MOCK;
    const savedMediaDir = process.env.NODU_MEDIA_DIR;
    const savedVideo = process.env.SDL_VIDEODRIVER;
    const savedAudio = process.env.SDL_AUDIODRIVER;
    process.env.NODU_DEVICE_BIN = binary;
    process.env.NODU_DEVICE_MOCK = '1';
    // The worker spawns with this environment; its media ops resolve the
    // bundled ffmpeg/ffplay via the dev-only override, and ffplay runs
    // headless under SDL dummy drivers.
    const mediaDir = join(__dirname, '..', 'resources', 'bin', `${process.platform}-${process.arch}`);
    const hasMedia = existsSync(join(mediaDir, 'ffmpeg')) && existsSync(join(mediaDir, 'ffplay'));
    if (hasMedia) {
        process.env.NODU_MEDIA_DIR = mediaDir;
        process.env.SDL_VIDEODRIVER = 'dummy';
        process.env.SDL_AUDIODRIVER = 'dummy';
    }
    const server = new NoduDeviceServer();
    try {
        const ports = await server.listPorts();
        assert.ok(ports.some(port => port.path === 'mock'), 'mock port listed');
        const state = await server.connect({ port: 'mock', boardProfile: 'generic-k210' });
        assert.equal(state.phase, 'connected');
        assert.equal(state.capabilities.repl, true);
        assert.equal(state.capabilities.firmware, true);
        assert.equal(await server.execute('print(42)'), '42\n');
        const payload = Buffer.alloc(4096, 0x5a);
        await server.writeFile('/flash/nodu_e2e.bin', payload.toString('base64'), false);
        const back = await server.readFile('/flash/nodu_e2e.bin');
        assert.equal(Buffer.from(back.data, 'base64').equals(payload), true);
        const files = await server.listFiles('/flash');
        assert.ok(files.some(file => file.name === 'nodu_e2e.bin'));
        // Startup file: guarded without confirmation, allowed when explicit.
        assert.throws(() => server.writeFile('/flash/boot.py', 'cHJpbnQoMSk=', true), /保护/);
        await server.writeFile('/flash/boot.py', 'cHJpbnQoMSk=', true, true);
        const boot = await server.readFile('/flash/boot.py');
        assert.equal(Buffer.from(boot.data, 'base64').toString(), 'print(1)');
        // formatScript needs no device connection but rides the same sidecar.
        assert.equal(await server.formatScript('x=1 # c\n    y=2', true, true), 'x=1 \n\ty=2');
        assert.equal(await server.formatScript('x=1', false, false), 'x=1');
        // Mock framebuffer recording: start camera so frames flow, record a
        // few frames into a .bin, then stop and verify the stream magic.
        const { mkdtempSync, readFileSync, existsSync: exists, rmSync } = require('node:fs');
        const { tmpdir } = require('node:os');
        const dir = mkdtempSync(join(tmpdir(), 'nodu-rec-'));
        const recPath = join(dir, 'clip.bin');
        await server.startCamera();
        const status = await server.startRecording(`file://${recPath}`);
        assert.equal(status.active, true);
        await new Promise(resolve => setTimeout(resolve, 400));
        const done = await server.stopRecording();
        assert.equal(done.active, false);
        assert.ok(done.frames > 0, JSON.stringify(done));
        assert.ok(exists(recPath), 'recording file written');
        assert.equal(readFileSync(recPath).subarray(0, 16).toString(), 'OMV IMG STR V1.0');
        await server.disconnect();
        assert.equal((await server.getState()).phase, 'disconnected');
        // Media conversion is host-side and only valid while disconnected;
        // the worker found the bundled tools via NODU_MEDIA_DIR at spawn.
        if (hasMedia) {
            const out = join(dir, 'clip.mp4');
            await server.convertVideo(`file://${recPath}`, `file://${out}`);
            assert.ok(exists(out), 'converted mp4 written');
            // Refuses to overwrite; .bin playback transcodes to a temp
            // MP4 and exits cleanly under SDL dummy drivers.
            await assert.rejects(server.convertVideo(`file://${recPath}`, `file://${out}`), /exist|覆盖/);
            await server.playVideo(`file://${recPath}`);
        }
        rmSync(dir, { recursive: true, force: true });
    } finally {
        await server.onStop();
        if (savedBin === undefined) { delete process.env.NODU_DEVICE_BIN; } else { process.env.NODU_DEVICE_BIN = savedBin; }
        if (savedMock === undefined) { delete process.env.NODU_DEVICE_MOCK; } else { process.env.NODU_DEVICE_MOCK = savedMock; }
        if (savedMediaDir === undefined) { delete process.env.NODU_MEDIA_DIR; } else { process.env.NODU_MEDIA_DIR = savedMediaDir; }
        if (savedVideo === undefined) { delete process.env.SDL_VIDEODRIVER; } else { process.env.SDL_VIDEODRIVER = savedVideo; }
        if (savedAudio === undefined) { delete process.env.SDL_AUDIODRIVER; } else { process.env.SDL_AUDIODRIVER = savedAudio; }
    }
});

// Board inspection: read-only config declaration path. `request` is stubbed so
// no worker or serial port is involved; every test asserts what was asked of it.
const connectedState = () => ({ phase: 'connected', port: '/dev/mock', busy: false, running: false,
    preview: false, capabilities: { repl: true, files: true, framebuffer: false, script: true, firmware: false } });

test('board inspection is unavailable when disconnected, running or busy', async () => {
    const server = new NoduDeviceServer();
    let calls = 0;
    server.request = async () => { calls++; return []; };
    for (const state of [
        { phase: 'disconnected' }, { phase: 'connecting' }, { phase: 'error' },
        { ...connectedState(), running: true }, { ...connectedState(), busy: true },
        { ...connectedState(), capabilities: { ...connectedState().capabilities, files: false } },
    ]) {
        server.state = state;
        const result = await server.inspectBoard();
        assert.equal(result.status, 'unavailable');
    }
    assert.equal(calls, 0, 'inspection must not touch the worker without a healthy connection');
    await server.onStop();
});

test('board inspection reports missing config.json without reading it', async () => {
    const server = new NoduDeviceServer();
    server.state = connectedState();
    const methods = [];
    server.request = async method => { methods.push(method); return []; };
    const result = await server.inspectBoard();
    assert.equal(result.status, 'missing');
    assert.deepEqual(methods, ['listFiles']);
    await server.onStop();
});

test('board inspection rejects oversized or directory config before reading', async () => {
    const server = new NoduDeviceServer();
    server.state = connectedState();
    for (const entry of [
        { name: 'config.json', path: '/flash/config.json', size: 16385, directory: false },
        { name: 'config.json', path: '/flash/config.json', size: 10, directory: true },
    ]) {
        const methods = [];
        server.request = async method => { methods.push(method); return [entry]; };
        const result = await server.inspectBoard();
        assert.equal(result.status, 'invalid', JSON.stringify(entry));
        assert.deepEqual(methods, ['listFiles'], 'no readFile for a config that cannot be trusted');
    }
    await server.onStop();
});

test('board inspection returns declared result from a real config payload', async () => {
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const server = new NoduDeviceServer();
    server.state = connectedState();
    const text = readFileSync(join(__dirname, 'fixtures', 'board-config-embedfire.json'), 'utf-8');
    const data = Buffer.from(text, 'utf-8');
    server.request = async (method, args) => {
        if (method === 'listFiles') { return [{ name: 'config.json', path: '/flash/config.json', size: data.length, directory: false }]; }
        if (method === 'readFile') { assert.equal(args.path, '/flash/config.json'); return { data: data.toString('base64'), size: data.length }; }
        throw new Error(`unexpected request ${method}`);
    };
    const result = await server.inspectBoard();
    assert.equal(result.status, 'declared');
    assert.equal(result.boardId, 'embedfire-cam-gc2145');
    await server.onStop();
});

test('board inspection abandons stale results when the connection changes between awaits', async () => {
    const server = new NoduDeviceServer();
    server.state = connectedState();
    server.request = async method => {
        if (method === 'listFiles') { return [{ name: 'config.json', path: '/flash/config.json', size: 4, directory: false }]; }
        // Simulate disconnect/reconnect while the read is in flight.
        server.connectionEpoch++;
        return { data: 'e30=', size: 2 };
    };
    const result = await server.inspectBoard();
    assert.equal(result.status, 'unavailable');
    await server.onStop();
});

test('board inspection rejects malformed readFile payloads', async () => {
    const server = new NoduDeviceServer();
    server.state = connectedState();
    const entry = { name: 'config.json', path: '/flash/config.json', size: 4, directory: false };
    // Junk characters/padding that Buffer.from would silently skip, a
    // non-integer size field, and an over-cap encoded length are all invalid.
    for (const payload of [
        { data: 'e30=###junk', size: 4 },
        { data: 'e30', size: 4 },            // bad padding: 3 chars without '='
        { data: 'e30=', size: 4.5 },
        { data: 'e30=', size: -1 },
        { data: 'AAAA'.repeat(6000), size: 4 },
        { size: 4 },                          // missing data entirely
    ]) {
        server.request = async method => method === 'listFiles' ? [entry] : payload;
        const result = await server.inspectBoard();
        assert.equal(result.status, 'invalid', JSON.stringify(payload).slice(0, 60));
    }
    // Listing size vs read size disagreement means the file changed mid-read.
    server.request = async method => method === 'listFiles' ? [entry]
        : { data: 'e30=', size: 2 };
    const changed = await server.inspectBoard();
    assert.equal(changed.status, 'unavailable');
    assert.ok(changed.issues[0].includes('变化'));
    await server.onStop();
});

test('board inspection stays aborted when the connection drops after the read resolves', async () => {
    const server = new NoduDeviceServer();
    server.state = connectedState();
    server.request = async method => {
        if (method === 'listFiles') { return [{ name: 'config.json', path: '/flash/config.json', size: 2, directory: false }]; }
        // Read resolves, then the worker reports the connection gone before the
        // inspection result is handed back.
        server.connectionEpoch++;
        server.state = { ...connectedState(), phase: 'error', port: undefined };
        return { data: 'e30=', size: 2 };
    };
    const result = await server.inspectBoard();
    assert.equal(result.status, 'unavailable');
    await server.onStop();
});

// deviceBinary() resolution: dev fallback when the packaged sidecar is absent.
// Renames the staged binary inside try/finally; no port or spawn involved.
test('deviceBinary falls back to the dev release build', async t => {
    const { existsSync, renameSync } = require('node:fs');
    const { join } = require('node:path');
    const server = new NoduDeviceServer();
    const savedBin = process.env.NODU_DEVICE_BIN;
    delete process.env.NODU_DEVICE_BIN;
    try {
        const staged = join(__dirname, '..', 'resources', 'bin',
            `${process.platform}-${process.arch}`,
            process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
        const dev = join(__dirname, '..', '..', 'native', 'target', 'release',
            process.platform === 'win32' ? 'nodu-device.exe' : 'nodu-device');
        if (!existsSync(dev)) { t.skip('dev release binary missing; run npm run build:native'); return; }
        const aside = `${staged}.aside`;
        const hadStaged = existsSync(staged);
        try {
            if (hadStaged) { renameSync(staged, aside); }
            assert.equal(server.deviceBinary(), dev, 'must fall back to desktop/native dev build');
        } finally {
            if (hadStaged && existsSync(aside)) { renameSync(aside, staged); }
        }
        if (hadStaged) { assert.equal(server.deviceBinary(), staged); }
    } finally {
        if (savedBin === undefined) { delete process.env.NODU_DEVICE_BIN; } else { process.env.NODU_DEVICE_BIN = savedBin; }
    }
});

test('terminal executable and startup terminals are Node-local, consumed once', async () => {
    const server = new NoduDeviceServer();
    const savedBin = process.env.NODU_TERMINAL_BIN;
    const savedTerminals = process.env.NODU_STARTUP_TERMINALS;
    try {
        process.env.NODU_TERMINAL_BIN = '/tmp/nodu-terminal-test';
        assert.equal(await server.getTerminalExecutable(), '/tmp/nodu-terminal-test');
        delete process.env.NODU_TERMINAL_BIN;
        const resolved = await server.getTerminalExecutable();
        assert.match(resolved, /nodu-terminal(\.exe)?$/, 'packaged or dev binary path');
        process.env.NODU_STARTUP_TERMINALS = JSON.stringify([['-open_udp_server_terminal', '9000'], ['-open_serial_terminal', '/dev/cu.x:115200']]);
        assert.deepEqual(await server.takeStartupTerminals(), [['-open_udp_server_terminal', '9000'], ['-open_serial_terminal', '/dev/cu.x:115200']]);
        assert.deepEqual(await server.takeStartupTerminals(), [], 'consumed exactly once');
        const server2 = new NoduDeviceServer();
        process.env.NODU_STARTUP_TERMINALS = 'not json';
        assert.deepEqual(await server2.takeStartupTerminals(), []);
        const server3 = new NoduDeviceServer();
        process.env.NODU_STARTUP_TERMINALS = JSON.stringify(Array.from({ length: 17 }, () => ['-open_udp_server_terminal', '1']));
        assert.deepEqual(await server3.takeStartupTerminals(), [], 'over 16 entries rejected');
        const server4 = new NoduDeviceServer();
        process.env.NODU_STARTUP_TERMINALS = JSON.stringify([['-open_udp_server_terminal', 'x'.repeat(513)]]);
        assert.deepEqual(await server4.takeStartupTerminals(), [], 'oversized arg rejected');
        const server5 = new NoduDeviceServer();
        process.env.NODU_STARTUP_TERMINALS = JSON.stringify([[]]);
        assert.deepEqual(await server5.takeStartupTerminals(), [], 'empty arg array rejected');
        const server6 = new NoduDeviceServer();
        process.env.NODU_STARTUP_TERMINALS = `[["-open_udp_server_terminal","${'9'.repeat(200_000)}"]]`;
        assert.deepEqual(await server6.takeStartupTerminals(), [], 'oversized raw JSON rejected before parse');
        server2.onStop(); server3.onStop(); server4.onStop(); server5.onStop(); server6.onStop();
    } finally {
        if (savedBin === undefined) { delete process.env.NODU_TERMINAL_BIN; } else { process.env.NODU_TERMINAL_BIN = savedBin; }
        if (savedTerminals === undefined) { delete process.env.NODU_STARTUP_TERMINALS; } else { process.env.NODU_STARTUP_TERMINALS = savedTerminals; }
    }
});

test('read-timeout env flags reach the worker argv only when valid', () => {
    const arg = NoduDeviceServer.timeoutArg.bind(NoduDeviceServer);
    const saved = [process.env.NODU_READ_TIMEOUT_MS, process.env.NODU_READ_STALL_TIMEOUT_MS];
    try {
        process.env.NODU_READ_TIMEOUT_MS = '5000';
        process.env.NODU_READ_STALL_TIMEOUT_MS = '1000';
        assert.deepEqual(arg('NODU_READ_TIMEOUT_MS', '-override_read_timeout'), ['-override_read_timeout', '5000']);
        assert.deepEqual(arg('NODU_READ_STALL_TIMEOUT_MS', '-override_read_stall_timeout'), ['-override_read_stall_timeout', '1000']);
        for (const bad of ['0', '60001', 'abc', '1.5']) {
            process.env.NODU_READ_TIMEOUT_MS = bad;
            assert.deepEqual(arg('NODU_READ_TIMEOUT_MS', '-override_read_timeout'), [], bad);
        }
        delete process.env.NODU_READ_TIMEOUT_MS;
        assert.deepEqual(arg('NODU_READ_TIMEOUT_MS', '-override_read_timeout'), []);
    } finally {
        if (saved[0] === undefined) { delete process.env.NODU_READ_TIMEOUT_MS; } else { process.env.NODU_READ_TIMEOUT_MS = saved[0]; }
        if (saved[1] === undefined) { delete process.env.NODU_READ_STALL_TIMEOUT_MS; } else { process.env.NODU_READ_STALL_TIMEOUT_MS = saved[1]; }
    }
});

test('launcher extracts original -open_*/-override_* flags without touching Theia args', () => {
    const { extractLauncherFlags } = require('../../scripts/launch.cjs');
    const out = extractLauncherFlags(['-open_udp_server_terminal', '9000', '--plugins', 'x',
        '-open_serial_terminal', '/dev/cu.x:115200', '-override_read_timeout', '8000',
        '-override_read_stall_timeout', '2000']);
    assert.deepEqual(out.args, ['--plugins', 'x']);
    assert.deepEqual(out.terminals, [['-open_udp_server_terminal', '9000'], ['-open_serial_terminal', '/dev/cu.x:115200']]);
    assert.deepEqual(out.timeouts, { NODU_READ_TIMEOUT_MS: '8000', NODU_READ_STALL_TIMEOUT_MS: '2000' });
    assert.throws(() => extractLauncherFlags(['-open_tcp_client_terminal']), /parameter/);
    assert.throws(() => extractLauncherFlags(['-open_tcp_client_terminal', '-override_read_timeout']), /parameter/);
    assert.throws(() => extractLauncherFlags(['-override_read_timeout', 'abc']), /1-60000/);
    assert.throws(() => extractLauncherFlags(
        Array.from({ length: 17 }, () => ['-open_udp_server_terminal', '9']).flat()), /16/);
    assert.throws(() => extractLauncherFlags(
        ['-open_udp_server_terminal', 'x'.repeat(513)]), /512/);
    assert.throws(() => extractLauncherFlags(
        ['-open_udp_server_terminal', '9000\0']), /NUL/);
    // Unknown flags stay untouched for Theia to handle or reject.
    assert.deepEqual(extractLauncherFlags(['--unknown-option', 'v']).args, ['--unknown-option', 'v']);
});

// ---------- nodu-resources sidecar wiring (0.1.4 Phase 1) ----------

const { existsSync, readFileSync } = require('node:fs');

const resourcesFixture = () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require('node:fs');
    const { tmpdir } = require('node:os');
    const { join } = require('node:path');
    const { NoduResourcesServer } = require('../lib/node/nodu-resources-server');
    const home = mkdtempSync(join(tmpdir(), 'nodu-res-home-'));
    const candidates = [
        join(__dirname, '..', '..', 'native', 'target', 'debug', 'nodu-resources'),
        join(__dirname, '..', 'resources', 'bin', `${process.platform}-${process.arch}`, 'nodu-resources'),
        join(__dirname, '..', '..', 'native', 'target', 'release', 'nodu-resources'),
    ];
    const bin = candidates.find(p => existsSync(p));
    const saved = {
        NODU_RESOURCES_HOME: process.env.NODU_RESOURCES_HOME,
        NODU_RESOURCES_BIN: process.env.NODU_RESOURCES_BIN,
        NODU_UPDATE_RESOURCES: process.env.NODU_UPDATE_RESOURCES,
    };
    const resources = join(home, 'resources');
    const versionFile = join(home, 'resources-version.json');
    process.env.NODU_RESOURCES_HOME = home;
    if (bin) { process.env.NODU_RESOURCES_BIN = bin; }
    delete process.env.NODU_UPDATE_RESOURCES;
    const restore = () => {
        for (const [key, value] of Object.entries(saved)) {
            if (value === undefined) { delete process.env[key]; } else { process.env[key] = value; }
        }
    };
    return { NoduResourcesServer, home, resources, versionFile, bin, restore, mkdirSync, writeFileSync, join };
};

test('resources server resets when the version file is missing', async t => {
    const fx = resourcesFixture();
    if (!fx.bin) { t.skip('nodu-resources binary not built'); fx.restore(); return; }
    try {
        const server = new fx.NoduResourcesServer();
        const { examplesDir } = await server.ready();
        assert.ok(existsSync(fx.join(fx.resources, 'examples', 'Nodu')), 'bundled examples copied into the user dir');
        const recorded = JSON.parse(readFileSync(fx.versionFile, 'utf8'));
        assert.deepEqual([recorded.major, recorded.minor, recorded.patch], [0, 1, 4]);
        assert.equal(examplesDir, fx.join(fx.resources, 'examples'));
        server.onStop();
    } finally { fx.restore(); }
});

test('resources server resets when the recorded version is older', async t => {
    const fx = resourcesFixture();
    if (!fx.bin) { t.skip('nodu-resources binary not built'); fx.restore(); return; }
    try {
        fx.mkdirSync(fx.resources, { recursive: true });
        fx.writeFileSync(fx.join(fx.resources, 'stale-marker.txt'), 'old');
        fx.writeFileSync(fx.versionFile, '{"major":0,"minor":0,"patch":1}');
        const server = new fx.NoduResourcesServer();
        await server.ready();
        assert.ok(!existsSync(fx.join(fx.resources, 'stale-marker.txt')), 'stale tree replaced');
        assert.ok(existsSync(fx.join(fx.resources, 'examples', 'Nodu')));
        server.onStop();
    } finally { fx.restore(); }
});

test('NODU_UPDATE_RESOURCES=1 forces the reset even at equal version', async t => {
    const fx = resourcesFixture();
    if (!fx.bin) { t.skip('nodu-resources binary not built'); fx.restore(); return; }
    try {
        fx.mkdirSync(fx.resources, { recursive: true });
        fx.writeFileSync(fx.join(fx.resources, 'marker.txt'), 'keep?');
        fx.writeFileSync(fx.versionFile, '{"major":0,"minor":1,"patch":4}');
        process.env.NODU_UPDATE_RESOURCES = '1';
        const server = new fx.NoduResourcesServer();
        await server.ready();
        assert.ok(!existsSync(fx.join(fx.resources, 'marker.txt')), 'forced reset replaced the tree');
        assert.ok(existsSync(fx.join(fx.resources, 'examples', 'Nodu')));
        server.onStop();
    } finally { fx.restore(); }
});

test('resources server skips the reset when the recorded version matches', async t => {
    const fx = resourcesFixture();
    if (!fx.bin) { t.skip('nodu-resources binary not built'); fx.restore(); return; }
    try {
        fx.mkdirSync(fx.join(fx.resources, 'examples'), { recursive: true });
        fx.writeFileSync(fx.join(fx.resources, 'examples', 'marker.txt'), 'user content');
        fx.writeFileSync(fx.versionFile, '{"major":0,"minor":1,"patch":4}');
        const server = new fx.NoduResourcesServer();
        const { examplesDir } = await server.ready();
        assert.equal(readFileSync(fx.join(fx.resources, 'examples', 'marker.txt'), 'utf8'), 'user content', 'equal version keeps user resources');
        assert.equal(examplesDir, fx.join(fx.resources, 'examples'));
        server.onStop();
    } finally { fx.restore(); }
});

test('launcher strips -update_resources into NODU_UPDATE_RESOURCES without forwarding it', () => {
    const { extractLauncherFlags } = require('../../scripts/launch.cjs');
    const out = extractLauncherFlags(['-update_resources', '--plugins', 'x']);
    assert.deepEqual(out.args, ['--plugins', 'x']);
    assert.deepEqual(out.timeouts, { NODU_UPDATE_RESOURCES: '1' });
    assert.deepEqual(out.terminals, []);
});
