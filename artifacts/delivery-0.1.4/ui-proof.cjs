// UI acceptance using real menu actions and clipboard reads; no board session.
const fs = require('node:fs');
const crypto = require('node:crypto');
const puppeteer = require('/Users/wangwei/Model/k210-studio/desktop/node_modules/puppeteer-core');
const ui = require('/tmp/s5-lib.cjs');
const pause = ms => new Promise(r => setTimeout(r, ms));
const token = crypto.randomBytes(6).toString('hex');
const root = __dirname, output = `${root}/ui-${token}.json`;
const imageName = `nodu-threshold-${token}.jpg`;
const imagePath = `/private/tmp/nodu-menu-check-ws/${imageName}`;
const imageSource = '/Users/wangwei/Model/k210-studio/artifacts/e2e-0.1.4/s5/frame-capture.jpg';
const result = { token, started: new Date().toISOString(), checks: [] };
let browser, page, oldClipboard, fontSnapshot, imageCopied = false;

async function menu(parts) {
    // Escape collapses Monaco's selection; a real menu click must preserve it.
    const bar = await page.evaluate(label => {
        const e = [...document.querySelectorAll('.p-MenuBar-item,.lm-MenuBar-item')]
            .find(e => e.textContent.trim() === label);
        if (!e) return null;
        const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, parts[0]);
    if (!bar) throw Error(`Menu missing: ${parts[0]}`);
    await page.mouse.click(bar.x, bar.y);
    for (let index = 1; index < parts.length; index++) {
        await pause(350);
        const position = await page.evaluate(label => {
            const menus = [...document.querySelectorAll('.p-Menu,.lm-Menu')].filter(e => e.getBoundingClientRect().width > 0);
            for (const m of menus.reverse()) for (const li of m.querySelectorAll('li')) {
                const text = li.querySelector('.p-Menu-itemLabel,.lm-Menu-itemLabel');
                if (text?.textContent.trim() === label) {
                    const r = li.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                }
            }
            return null;
        }, parts[index]);
        if (!position) throw Error(`Menu missing: ${parts.join(' > ')}`);
        if (index === parts.length - 1) await page.mouse.click(position.x, position.y);
        else await page.mouse.move(position.x, position.y);
    }
    await pause(250);
}
async function pick(label) {
    await page.waitForSelector('.quick-input-widget', { visible: true, timeout: 10000 });
    await page.evaluate(label => {
        const row = [...document.querySelectorAll('.quick-input-widget .monaco-list-row')]
            .find(e => e.textContent.includes(label));
        if (!row) throw Error(`Quick pick missing: ${label}`);
        row.click();
    }, label);
    await pause(200);
    if (await page.$eval('.quick-input-widget', e => e.getBoundingClientRect().width > 0)) await page.keyboard.press('Enter');
}
async function button(text) {
    await page.evaluate(text => {
        const b = [...document.querySelectorAll('button')].find(b =>
            b.textContent.trim() === text && b.getBoundingClientRect().width > 0 && !b.disabled);
        if (!b) throw Error(`Button missing: ${text}`);
        b.click();
    }, text);
}
async function folding() {
    return page.evaluate(async () => {
        const model = await window.__uiEditor().getContribution('editor.contrib.folding').getFoldingModel();
        return Array.from({ length: model.regions.length }, (_, i) => ({
            start: model.regions.getStartLineNumber(i), end: model.regions.getEndLineNumber(i),
            collapsed: model.regions.isCollapsed(i),
        }));
    });
}
async function capture(name) {
    await page.screenshot({ path: `${root}/${name}-${token}.png` });
}

(async () => {
    try {
        browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:4187' });
        page = (await browser.pages()).find(p => p.url().includes('127.0.0.1:4188'));
        if (!page) throw Error('Nodu page missing');
        await browser.defaultBrowserContext().overridePermissions('http://127.0.0.1:4188',
            ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
        await page.bringToFront();
        // Close only a leftover test threshold dialog, without touching a document.
        if (await page.$('.nodu-image-tools-threshold')) await button('完成');
        oldClipboard = await page.evaluate(() => navigator.clipboard.readText());
        await page.evaluate(() => {
            const c = window.theia.container, keys = [...c._bindingDictionary._map.keys()];
            const editorKey = keys.find(k => typeof k === 'function' && k.prototype &&
                Object.getOwnPropertyDescriptor(k.prototype, 'currentEditor'));
            const prefsKey = keys.find(k => typeof k === 'symbol' && k.description === 'PreferenceService');
            window.__uiEditor = () => c.get(editorKey).currentEditor.editor.getControl();
            if (prefsKey) window.__uiPrefs = c.get(prefsKey);
        });

        const tuple = '(20, 80, -70, -10, -10, 40)';
        const doc = await ui.newScript(page);
        if (!doc.ok) throw Error('New script menu failed');
        await ui.setModelText(page, `threshold = ${tuple}\n`);
        await page.evaluate(() => {
            const e = window.__uiEditor(), m = e.getModel();
            e.setSelection({ startLineNumber: 1, startColumn: 13, endLineNumber: 1, endColumn: m.getLineMaxColumn(1) });
            e.focus();
        });
        fs.copyFileSync(imageSource, imagePath, fs.constants.COPYFILE_EXCL);
        imageCopied = true;
        result.imageSha256 = crypto.createHash('sha256').update(fs.readFileSync(imageSource)).digest('hex');
        await menu(['工具', '机器视觉', '阈值编辑器']);
        await pick('图片文件');
        await page.waitForFunction(() => [...document.querySelectorAll('.dialogBlock')]
            .some(d => d.textContent.includes('选择图像文件')), { timeout: 10000 });
        // FileService-backed tree: select the actual staged JPEG, not a mocked dialog result.
        await page.waitForFunction(name => [...document.querySelectorAll('.dialogBlock *')]
            .some(e => e.textContent.trim() === name), { timeout: 10000 }, imageName);
        await page.evaluate(name => {
            const labels = [...document.querySelectorAll('.dialogBlock *')]
                .filter(e => e.textContent.trim() === name && e.children.length === 0);
            const label = labels.find(e => e.getBoundingClientRect().width > 0);
            if (!label) throw Error('Image tree label not visible');
            label.click();
        }, imageName);
        await button('选择图像');
        await page.waitForSelector('.nodu-image-tools-threshold canvas', { visible: true, timeout: 15000 });
        const displayed = await page.$eval('.nodu-image-tools-threshold [aria-label="可复制的阈值 Python 元组"]', e => e.textContent);
        if (displayed !== tuple) throw Error(`Selected tuple not loaded: ${displayed}`);
        await page.evaluate(() => navigator.clipboard.writeText('NODU_BEFORE_COPY'));
        await page.$eval('.nodu-image-tools-threshold', el => {
            const b = [...el.querySelectorAll('button')].find(b => b.textContent.includes('复制参数'));
            if (!b) throw Error('Copy button missing');
            b.click();
        });
        await page.waitForFunction(expected => navigator.clipboard.readText().then(text => text === expected),
            { timeout: 10000 }, tuple);
        const copied = await page.evaluate(() => navigator.clipboard.readText());
        result.checks.push({ name: 'threshold clipboard', displayed, copied, passed: copied === tuple });
        await capture('threshold-clipboard');
        await button('完成');

        const clipSource = 'NODU_CLIP_ALPHA\nNODU_CLIP_BETA\n';
        await ui.setModelText(page, clipSource);
        for (const line of [1, 2]) {
            await page.evaluate(line => { const e = window.__uiEditor(); e.setPosition({ lineNumber: line, column: 1 }); e.focus(); }, line);
            await menu(['编辑', '高级', '复制行']);
        }
        await page.evaluate(() => { const e = window.__uiEditor(); e.setPosition({ lineNumber: 3, column: 1 }); e.focus(); });
        await menu(['编辑', '从剪贴板历史记录粘贴']);
        await pick('NODU_CLIP_ALPHA');
        const pasted = await ui.getModelText(page);
        if (pasted !== clipSource + 'NODU_CLIP_ALPHA\n') throw Error(`History paste mismatch: ${pasted}`);
        result.checks.push({ name: 'clipboard history paste', source: pasted, passed: true });
        await capture('clipboard-history');

        await ui.setModelText(page, 'def alpha():\n    print("alpha")\n\ndef beta():\n    print("beta")\n');
        await page.evaluate(() => window.__uiEditor().focus());
        await pause(700);
        const foldBefore = await folding();
        if (foldBefore.length < 2) throw Error('Folding regions not populated');
        await menu(['编辑', '高级', '切换折叠全部']); await pause(300);
        const collapsed = await folding();
        await menu(['编辑', '高级', '切换折叠全部']); await pause(300);
        const expanded = await folding();
        if (!collapsed.every(r => r.collapsed) || !expanded.every(r => !r.collapsed)) throw Error('Fold toggle failed');
        result.checks.push({ name: 'fold all toggle', foldBefore, collapsed, expanded, passed: true });

        fontSnapshot = await page.evaluate(() => {
            if (!window.__uiPrefs) throw Error('PreferenceService unavailable');
            return {
                effective: window.__uiPrefs.get('editor.fontSize'),
                user: window.__uiPrefs.inspectInScope('editor.fontSize', 1),
            };
        });
        await menu(['编辑', '高级', '增加字体大小']);
        await page.waitForFunction(before => window.__uiPrefs.get('editor.fontSize') === before + 1, {}, fontSnapshot.effective);
        const increased = await page.evaluate(() => window.__uiPrefs.get('editor.fontSize'));
        await menu(['编辑', '高级', '减小字体大小']);
        await page.waitForFunction(before => window.__uiPrefs.get('editor.fontSize') === before, {}, fontSnapshot.effective);
        result.checks.push({ name: 'font size menus', before: fontSnapshot.effective, increased, restoredEffective: fontSnapshot.effective, passed: true });
    } catch (error) {
        result.failure = String(error);
        process.exitCode = 1;
        if (page) {
            result.dialogTextAtFailure = await page.evaluate(() =>
                [...document.querySelectorAll('.dialogBlock,.quick-input-widget')]
                    .filter(e => e.getBoundingClientRect().width > 0).map(e => e.innerText)).catch(() => []);
            await capture('ui-failure').catch(() => {});
        }
    } finally {
        if (page) {
            if (fontSnapshot) await page.evaluate(value => window.__uiPrefs.set('editor.fontSize', value, 1), fontSnapshot.user)
                .catch(error => { result.preferenceRestoreFailure = String(error); });
            if (oldClipboard !== undefined) await page.evaluate(value => navigator.clipboard.writeText(value), oldClipboard)
                .catch(error => { result.clipboardRestoreFailure = String(error); });
        }
        if (imageCopied) fs.unlinkSync(imagePath);
        result.finished = new Date().toISOString();
        fs.writeFileSync(output, JSON.stringify(result, null, 2));
        await browser?.disconnect();
        console.log(JSON.stringify({ output, ...result }, null, 2));
    }
})();
