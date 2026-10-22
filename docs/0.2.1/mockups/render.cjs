// Renders mockups/*.html to PNG at 1440 × 900 with the repo's Electron (offscreen).
// From the repo root:
//   desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron docs/0.2.1/mockups/render.cjs [name ...]
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = __dirname;
const WIDTH = 1440;
const HEIGHT = 900;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-mockups-'));
app.setPath('userData', path.join(TMP, 'user'));
app.on('window-all-closed', () => {});

async function render(name) {
    const win = new BrowserWindow({
        show: false, width: WIDTH, height: HEIGHT, useContentSize: true, frame: false,
        webPreferences: { offscreen: true, backgroundThrottling: false }
    });
    try {
        await win.loadFile(path.join(ROOT, `${name}.html`));
        await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        await new Promise(resolve => setTimeout(resolve, 300));
        const image = await win.webContents.capturePage({ x: 0, y: 0, width: WIDTH, height: HEIGHT });
        fs.writeFileSync(path.join(ROOT, `${name}.png`), image.toPNG());
        console.log(`rendered ${name}.png`);
    } finally {
        win.destroy();
    }
}

app.whenReady().then(async () => {
    const wanted = process.argv.slice(2).filter(arg => /^\d\d-[a-z-]+$/.test(arg));
    const names = wanted.length ? wanted
        : fs.readdirSync(ROOT).filter(file => /^\d\d-.*\.html$/.test(file)).map(file => file.slice(0, -5)).sort();
    try {
        for (const name of names) { await render(name); }
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        fs.rmSync(TMP, { recursive: true, force: true });
        app.quit();
    }
});
