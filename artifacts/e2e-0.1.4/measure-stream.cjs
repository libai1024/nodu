// Lead-authored diagnostic capture; records observations, never injects device state.
const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('/Users/wangwei/Model/k210-studio/desktop/node_modules/puppeteer-core');
const helpers = require('/tmp/s5-lib.cjs');
const root = __dirname;
const label = process.argv[2];
const recordOnly = process.argv[3] === 'record-only';
const comparison = process.argv[3] === 'comparison';
if (!/^[a-z0-9-]+$/.test(label || '')) throw Error('Provide a unique capture label');
const output = `${root}/${label}.json`;
if (fs.existsSync(output)) throw Error(`Refusing to overwrite ${output}`);
const sourcePath = comparison
    ? `${root}/../delivery-0.1.4/original-proof.py` : `${root}/comparison-camera.py`;
const source = fs.readFileSync(sourcePath, 'utf8');
const binary = '/Users/wangwei/Model/k210-studio/desktop/scope-extension/resources/bin/darwin-arm64/nodu-device';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const result = {
    label, mode: comparison ? 'same-source-comparison' : recordOnly ? 'record-only' : 'three-stop-cycles-and-record',
    sourcePath,
    started: new Date().toISOString(),
    sourceSha256: crypto.createHash('sha256').update(source).digest('hex'),
    binarySha256: crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex'),
    cycles: []
};
let browser, page;

async function snapshot() {
    return page.evaluate(() => ({
        phase: window.__t.state.phase,
        running: window.__t.state.running,
        busy: window.__t.busy || window.__t.boardInspecting,
        protocol: window.__t.state.protocol,
        preview: window.__t.state.preview,
        frame: window.__t.frame ? {
            sequence: window.__t.frame.sequence, time: window.__t.frame.time,
            width: window.__t.frame.width, height: window.__t.frame.height,
        } : null,
        error: window.__t.error, recording: window.__t.state.recording,
    }));
}

async function until(description, predicate, ms = 30000) {
    const started = Date.now();
    while (Date.now() - started < ms) {
        const state = await snapshot();
        if (predicate(state)) return state;
        if (state.phase === 'error') throw Error(`${description}: ${JSON.stringify(state)}`);
        await sleep(100);
    }
    throw Error(`Timed out: ${description}`);
}

async function beginLogCapture() {
    await page.evaluate(() => {
        window.__leadDispose?.dispose();
        window.__leadLogs = [];
        window.__leadDispose = window.__t.onDidLog(log => {
            window.__leadLogs.push({ ...log, receivedAt: Date.now() });
        });
    });
}

async function getLogs() {
    return page.evaluate(() => window.__leadLogs.slice());
}

async function startCamera() {
    const before = await snapshot();
    const began = Date.now();
    const enabled = await page.$eval('.scope-toolbar-run', el => !el.disabled);
    if (!enabled) throw Error('Run button is disabled');
    await page.click('.scope-toolbar-run');
    await until('fresh streaming frames', state =>
        state.running && state.frame && state.frame.time >= began &&
        state.frame.sequence !== before.frame?.sequence);
    return { began, before };
}

(async () => {
    try {
        browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:4187' });
        page = (await browser.pages()).find(p => p.url().includes('127.0.0.1:4188'));
        if (!page) throw Error('No existing Nodu page');
        await page.evaluate(() => {
            const c = window.theia.container;
            const keys = [...c._bindingDictionary._map.keys()];
            window.__t = c.get(keys.find(k => typeof k === 'function' &&
                typeof k.prototype?.readBoardInspection === 'function'));
        });
        await beginLogCapture();
        await page.evaluate(() => window.__t.disconnect());
        if (await page.$eval('#scope-device-popover', el => el.hidden)) {
            await page.click('.scope-device-chip');
        }
        await page.$eval('#scope-device-popover', el => {
            const button = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === '扫描');
            if (!button || button.disabled) throw Error('Scan button unavailable');
            button.click();
        });
        await page.waitForFunction(() => !window.__t.busy &&
            window.__t.ports.some(p => p.path === '/dev/cu.usbserial-3110'), { timeout: 15000 });
        await page.select('#nodu-serial-port', '/dev/cu.usbserial-3110');
        await page.$eval('#scope-device-popover', el => {
            const button = [...el.querySelectorAll('button')].find(b => b.textContent.trim() === '连接');
            if (!button || button.disabled) throw Error('Connect button unavailable');
            button.click();
        });
        result.connected = await until('idle IDE connection',
            s => s.phase === 'connected' && !s.busy && s.protocol === 'ide');
        result.connectLogs = await getLogs();
        if (!await page.$eval('#scope-device-popover', el => el.hidden)) {
            await page.click('.scope-device-chip');
        }
        const beforeUri = await helpers.editorUri(page);
        const opened = await helpers.newScript(page);
        if (!opened.ok || opened.uri === beforeUri) throw Error('New editor did not open');
        result.editor = await helpers.setModelText(page, source);
        if (await helpers.getModelText(page) !== source) throw Error('Editor source mismatch');

        await page.evaluate(() => document.querySelector('[aria-label="专业模式"]')?.click());
        for (let cycle = 0; cycle < (recordOnly ? 0 : comparison ? 1 : 3); cycle++) {
            const entry = { cycle, samples: [] };
            result.cycles.push(entry);
            await beginLogCapture();
            try {
                entry.start = await startCamera();
                const started = Date.now();
                while (Date.now() - started < 10000) {
                    const state = await snapshot();
                    entry.samples.push({ elapsedMs: Date.now() - started, ...state });
                    if (state.phase === 'error') throw Error('Stream entered error phase');
                    await sleep(500);
                }
                if (comparison) {
                    await page.screenshot({ path: `${root}/${label}-running.png` });
                    const clickText = text => page.evaluate(text => {
                        const b = [...document.querySelectorAll('button')].find(b =>
                            b.textContent.trim() === text && b.getBoundingClientRect().width > 0 && !b.disabled);
                        if (!b) throw Error(`Visible button missing: ${text}`);
                        b.click();
                    }, text);
                    await clickText('禁用');
                    await page.waitForFunction(() => !window.__t.busy && window.__t.state.preview === false);
                    await sleep(500);
                    entry.freezeBefore = await snapshot();
                    await sleep(3500);
                    entry.freezeAfter = await snapshot();
                    if (entry.freezeBefore.frame?.sequence !== entry.freezeAfter.frame?.sequence) throw Error('Frame changed after preview disabled');
                    await page.screenshot({ path: `${root}/${label}-disabled.png` });
                    await clickText('启用');
                    await until('framebuffer resume', s => s.frame && s.frame.sequence !== entry.freezeAfter.frame?.sequence);
                    entry.resumed = await snapshot();
                    entry.histograms = {};
                    for (const space of ['rgb', 'gray', 'lab', 'yuv']) {
                        await page.select('[aria-label="直方图色彩空间"]', space);
                        await sleep(250);
                        entry.histograms[space] = await page.$eval('[aria-label="直方图"]', e => e.innerText);
                        await page.screenshot({ path: `${root}/${label}-hist-${space}.png` });
                    }
                }
                const stopAt = Date.now();
                await page.click('.nodu-toolbar-stop');
                entry.stopped = await until('camera stop',
                    s => !s.running && !s.busy && s.phase === 'connected');
                entry.stopMs = Date.now() - stopAt;
                entry.repl = await page.evaluate(() => window.__t.service.execute('print(1 + 1)'));
                if (entry.repl.trim() !== '2') throw Error('Unexpected REPL result');
                if (comparison) await page.screenshot({ path: `${root}/${label}-stopped.png` });
            } catch (error) {
                entry.failure = String(error);
                throw error;
            } finally {
                entry.logs = await getLogs();
                fs.writeFileSync(output, JSON.stringify(result, null, 2));
            }
        }

        if (comparison) return;
        // Diagnostic API call uses the same model/backend; separate from save-dialog UX.
        const recordPath = `${root}/${label}.bin`;
        if (fs.existsSync(recordPath)) throw Error('Recording already exists');
        await beginLogCapture();
        const recording = result.recording = { path: recordPath, trigger: 'NoduDeviceModel API' };
        recording.start = await startCamera();
        recording.startResult = await page.evaluate(path =>
            window.__t.startRecording(`file://${path}`), recordPath);
        if (recording.startResult !== true) throw Error('Recording did not start');
        await sleep(5200);
        recording.stateBeforeStop = await snapshot();
        recording.final = await page.evaluate(() => window.__t.stopRecording());
        if (!recording.final || recording.final.frames <= 1) throw Error('No complete multi-frame recording');
        recording.fileBytes = fs.statSync(recordPath).size;
        recording.header = fs.readFileSync(recordPath).subarray(0, 16).toString('ascii');
        await page.click('.nodu-toolbar-stop');
        recording.stopped = await until('stop after recording',
            s => !s.running && !s.busy && s.phase === 'connected');
        recording.repl = await page.evaluate(() => window.__t.service.execute('print(1 + 1)'));
        recording.logs = await getLogs();
    } catch (error) {
        result.failure = String(error);
        process.exitCode = 1;
    } finally {
        if (page) {
            result.finalObservation = await snapshot().catch(error => ({ error: String(error) }));
            result.lastLogs = await getLogs().catch(() => []);
            await page.evaluate(() => window.__leadDispose?.dispose()).catch(() => {});
            await page.evaluate(() => window.__t.disconnect()).catch(error => {
                result.disconnectError = String(error);
            });
            result.disconnected = await snapshot().catch(error => ({ error: String(error) }));
        }
        result.finished = new Date().toISOString();
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        await browser?.disconnect();
        console.log(JSON.stringify({
            output, failure: result.failure, cycles: result.cycles.map(c => ({
                cycle: c.cycle, stopMs: c.stopMs, repl: c.repl,
                frameSamples: c.samples.filter(s => s.frame).length, failure: c.failure,
            })), recording: result.recording?.final,
            disconnected: result.disconnected,
        }, null, 2));
    }
})();
