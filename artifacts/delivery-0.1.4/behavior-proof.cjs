// Lead-authored acceptance capture. No injected logs, frames or device states.
const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('/Users/wangwei/Model/k210-studio/desktop/node_modules/puppeteer-core');
const ui = require('/tmp/s5-lib.cjs');
const token = crypto.randomBytes(8).toString('hex');
const root = __dirname;
const mode = process.argv[2];
if (!['boot', 'editor', 'format'].includes(mode)) throw Error('Choose boot, editor or format');
const record = { mode, token, started: new Date().toISOString(), checks: [] };
const output = `${root}/${mode}-${token}.json`;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let browser, page, bootPath, bootSource, bootExpected;
const marker = `/flash/nodu-boot-proof-${token}.txt`;
const markerText = `NODU_BOOT_AUTORUN:${token}\n`;
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function state() {
    return page.evaluate(() => ({
        ...window.__t.state, busy: window.__t.busy || window.__t.boardInspecting,
        error: window.__t.error,
    }));
}
async function wait(description, test, limit = 45000) {
    const start = Date.now();
    while (Date.now() - start < limit) {
        const value = await test();
        if (value) return value;
        await pause(100);
    }
    throw Error(`Timeout: ${description}; ${JSON.stringify(await state())}`);
}
async function idle() {
    return wait('connected and idle', async () => {
        const s = await state();
        if (s.phase === 'error') throw Error(s.error || s.lastError);
        return s.phase === 'connected' && !s.busy && !s.running;
    });
}
async function visibleButton(text, selector = 'body') {
    return page.$eval(selector, (root, text) => {
        const b = [...root.querySelectorAll('button')].find(b =>
            b.textContent.trim() === text && b.getBoundingClientRect().width > 0 && !b.disabled);
        if (!b) throw Error(`Visible enabled button missing: ${text}`);
        b.click();
        return b.textContent;
    }, text);
}
async function connect() {
    if ((await state()).phase !== 'disconnected') {
        await page.evaluate(() => window.__t.disconnect());
    }
    if (await page.$eval('#scope-device-popover', e => e.hidden)) await page.click('.scope-device-chip');
    await visibleButton('扫描', '#scope-device-popover');
    await wait('serial scan', () => page.evaluate(() =>
        !window.__t.busy && window.__t.ports.some(p => p.path === '/dev/cu.usbserial-3110')));
    await page.select('#nodu-serial-port', '/dev/cu.usbserial-3110');
    await visibleButton('连接', '#scope-device-popover');
    await idle();
    if (!await page.$eval('#scope-device-popover', e => e.hidden)) await page.click('.scope-device-chip');
    // These checks do not need camera streaming; avoid the separately tracked P1.
    await page.evaluate(() => window.__t.setPreview(false));
    await idle();
}
async function readOptional(path) {
    const value = await page.evaluate(path => window.__t.service.readFile(path)
        .then(data => ({ data })).catch(error => ({ error: String(error.message || error) })), path);
    if (value.error) {
        if (value.error.includes('Device file does not exist:')) return null;
        throw Error(value.error);
    }
    return value.data;
}
async function newEditor(source) {
    const old = await ui.editorUri(page);
    const opened = await ui.newScript(page);
    if (!opened.ok || opened.uri === old) throw Error('New editor not created');
    await ui.setModelText(page, source);
    if (await ui.getModelText(page) !== source) throw Error('Editor source differs');
    return opened.uri;
}
async function editorFacts() {
    return page.evaluate(() => {
        const c = window.theia.container;
        const key = [...c._bindingDictionary._map.keys()].find(k =>
            typeof k === 'function' && k.prototype && Object.getOwnPropertyDescriptor(k.prototype, 'currentEditor'));
        const editor = c.get(key).currentEditor;
        const control = editor.editor.getControl(), model = control.getModel();
        return {
            uri: String(editor.editor.uri), source: model.getValue(), position: control.getPosition(),
            decorations: model.getAllDecorations().filter(d =>
                (d.options.className || '').includes('nodu-traceback-line')).map(d => ({
                range: d.range, className: d.options.className,
            })),
        };
    });
}
async function resetLogs() {
    await page.evaluate(() => { window.__behaviorLogs.length = 0; });
}
async function logs() {
    return page.evaluate(() => window.__behaviorLogs.slice());
}
async function runError(source, kind) {
    await newEditor(source);
    await resetLogs();
    await page.click('.scope-toolbar-run');
    await wait(kind, async () => (await logs()).some(l => l.stream === 'stderr' && l.text.includes(kind)));
    await idle();
    const observed = await logs();
    const frames = [...observed.map(l => l.text).join('').matchAll(/File "<stdin>", line (\d+)/g)];
    if (!frames.length) throw Error('Missing traceback line');
    const line = Number(frames.at(-1)[1]);
    const facts = await editorFacts();
    if (!facts.decorations.some(d => d.range.startLineNumber === line) || facts.position.lineNumber !== line) {
        throw Error(`Traceback not reflected in editor: ${JSON.stringify({ line, facts })}`);
    }
    record.checks.push({ name: kind, line, facts, logs: observed });
    await page.screenshot({ path: `${root}/${kind}-${token}.png` });
}

(async () => {
    try {
        browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:4187' });
        page = (await browser.pages()).find(p => p.url().includes('127.0.0.1:4188'));
        if (!page) throw Error('Nodu page missing');
        await page.evaluate(() => {
            const c = window.theia.container;
            const key = [...c._bindingDictionary._map.keys()].find(k =>
                typeof k === 'function' && typeof k.prototype?.readBoardInspection === 'function');
            window.__t = c.get(key);
            window.__behaviorSub?.dispose();
            window.__behaviorLogs = [];
            window.__behaviorSub = window.__t.onDidLog(log =>
                window.__behaviorLogs.push({ ...log, observedAt: Date.now() }));
        });
        await connect();
        record.connected = await state();
        if (mode === 'boot' || mode === 'format') {
            const before = {};
            for (const path of ['/flash/boot.py', '/sd/boot.py', marker]) before[path] = await readOptional(path);
            record.before = before;
            if (Object.values(before).some(value => value !== null)) {
                throw Error('Existing startup/proof file; refusing to overwrite');
            }
            bootSource = `# Nodu automatic-boot proof ${token}\n` +
                `with open(${JSON.stringify(marker)}, "w") as proof:\n` +
                `    proof.write(${JSON.stringify(markerText)})\n` +
                `print(${JSON.stringify(markerText.trim())})\n`;
            if (mode === 'format') bootSource = fs.readFileSync(`${root}/original-boot-proof.py`, 'utf8');
            bootExpected = mode === 'format'
                ? JSON.parse(fs.readFileSync(`${root}/original-boot-formatted-readback.json`, 'utf8')).text : bootSource;
            record.source = bootSource;
            record.sourceSha256 = sha(bootSource);
            record.editor = await newEditor(bootSource);
            // Deliberately NEVER run the boot source manually.
            if (!await ui.clickMenuItem(page, ['工具', '将打开的脚本保存到开发板的 boot.py'])) throw Error('Boot menu missing');
            await page.waitForSelector('.quick-input-widget', { visible: true, timeout: 10000 });
            await page.evaluate(label => {
                const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')]
                    .find(e => e.textContent.includes(label));
                if (!row) throw Error('Keep-original choice missing');
                row.click();
            }, mode === 'format' ? '去除注释并转换缩进' : '保留原样');
            await pause(200);
            if (await page.$eval('.quick-input-widget', e => e.getBoundingClientRect().width > 0)) {
                await page.keyboard.press('Enter');
            }
            await wait('boot confirmation', () => page.evaluate(() =>
                [...document.querySelectorAll('button')].some(b =>
                    b.textContent.trim() === '写入 boot.py' && b.getBoundingClientRect().width > 0)));
            record.confirmation = await page.evaluate(() =>
                [...document.querySelectorAll('.dialogBlock')].map(e => e.textContent));
            await visibleButton('写入 boot.py');
            await wait('boot save completed', async () => (await logs()).some(l =>
                l.text.includes('已写入板端 boot.py')));
            await idle();
            for (const path of ['/flash/boot.py', '/sd/boot.py']) {
                const bytes = await readOptional(path);
                if (bytes) {
                    if (Buffer.from(bytes.data, 'base64').toString('utf8') !== bootExpected) throw Error('Unexpected boot bytes');
                    if (bootPath) throw Error('Both startup locations changed unexpectedly');
                    bootPath = path;
                }
            }
            if (!bootPath) throw Error('Boot file not found after UI save');
            record.bootPath = bootPath;
            record.writtenSha256 = sha(bootExpected);
            record.writtenBytes = Buffer.byteLength(bootExpected);
            if (mode === 'format') {
                record.checks.push({ name: 'formatted boot.py equals original', passed: true,
                    bytes: record.writtenBytes, sha256: record.writtenSha256 });
                return;
            }
            if (await readOptional(marker) !== null) throw Error('Proof exists before reset');
            record.markerAbsentBeforeReset = true;
            record.resetRequestedAt = new Date().toISOString();
            if (!await ui.clickMenuItem(page, ['工具', '复位设备'])) throw Error('Reset menu missing');
            await wait('reset disconnect', async () => (await state()).phase === 'disconnected');
            await pause(6000);
            await connect();
            const proof = await readOptional(marker);
            record.proof = proof;
            if (!proof || Buffer.from(proof.data, 'base64').toString('utf8') !== markerText) throw Error('Autorun marker absent or incorrect');
            record.checks.push({ name: 'boot autorun after reset', passed: true, token, marker });
        } else {
            await runError('print("NODU_RUNTIME_CHECK")\nprint(1 / 0)\n', 'ZeroDivisionError');
            await runError('print("NODU_SYNTAX_CHECK")\nfor i in range(3)\n    print(i)\n', 'SyntaxError');
            await ui.setModelText(page, 'print("NODU_CLEAR_CHECK")\n');
            await resetLogs();
            await page.click('.scope-toolbar-run');
            await wait('clear run output', async () => (await logs()).some(l => l.stream === 'stdout' && l.text.includes('NODU_CLEAR_CHECK')));
            await idle();
            const facts = await editorFacts();
            if (facts.decorations.length) throw Error('Old traceback decoration survived next run');
            record.checks.push({ name: 'clear old error on rerun', passed: true, facts });
        }
    } catch (error) {
        record.failure = String(error);
        process.exitCode = 1;
    } finally {
        if (page) {
            if (bootPath) {
                try {
                    if ((await state()).phase !== 'connected') await connect();
                    const source = `import uos\n` +
                        `assert open(${JSON.stringify(bootPath)}).read() == ${JSON.stringify(bootExpected)}\n` +
                        `uos.remove(${JSON.stringify(bootPath)})\n` +
                        `try:\n    proof = open(${JSON.stringify(marker)}).read()\nexcept OSError:\n    proof = None\n` +
                        `if proof is not None:\n    assert proof == ${JSON.stringify(markerText)}\n    uos.remove(${JSON.stringify(marker)})\n` +
                        `print("NODU_BOOT_CLEANED")\n`;
                    record.cleanupOutput = await page.evaluate(code => window.__t.service.execute(code), source);
                    record.cleaned = await readOptional(bootPath) === null && await readOptional(marker) === null;
                } catch (error) { record.cleanupFailure = String(error); process.exitCode = 2; }
            }
            record.finalLogs = await logs().catch(() => []);
            await page.evaluate(() => window.__behaviorSub?.dispose()).catch(() => {});
            await page.evaluate(() => window.__t.disconnect()).catch(error => { record.disconnectFailure = String(error); });
            record.finalState = await state().catch(() => null);
        }
        record.finished = new Date().toISOString();
        fs.writeFileSync(output, JSON.stringify(record, null, 2));
        await browser?.disconnect();
        console.log(JSON.stringify({ output, checks: record.checks, failure: record.failure, cleaned: record.cleaned, cleanupFailure: record.cleanupFailure }, null, 2));
    }
})();
