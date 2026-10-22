// Full-page screenshot of palette/index.html (1 CSS px = 1 image px, 1440 px wide).
// From the repo root:
//   desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron \
//     brand/proposals/2026-10-21/shoot-palette-page.cjs "palette=board&theme=light" brand/proposals/2026-10-21/previews/palette-light.png
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PAGE = path.join(__dirname, 'palette', 'index.html');
const scriptIndex = process.argv.findIndex(a => path.basename(a) === 'shoot-palette-page.cjs');
const [query, output] = process.argv.slice(scriptIndex + 1);
const WIDTH = 1440;
if (scriptIndex < 0 || !query || !output) {
    console.error('usage: Electron shoot-palette-page.cjs <query> <output.png>');
    process.exit(2);
}
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-shoot-'));
app.setPath('userData', TMP);
app.on('window-all-closed', () => {});
setTimeout(() => { console.error('timeout'); app.exit(3); }, 90000).unref();

app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    try {
        // Offscreen output follows the display scale (2x on Retina); zoom 0.5 in a half-size window gives 1:1.
        const probe = new BrowserWindow({ show: false, width: 10, height: 10, webPreferences: { offscreen: true } });
        await probe.loadURL('data:text/html,<body style="margin:0">');
        const dsf = (await probe.webContents.capturePage()).getSize().width / 10;
        probe.destroy();
        const win = new BrowserWindow({
            show: false, width: WIDTH / dsf, height: 600, useContentSize: true, frame: false,
            webPreferences: { offscreen: true, zoomFactor: 1 / dsf, backgroundThrottling: false }
        });
        await win.loadFile(PAGE, { search: query });
        win.webContents.setZoomFactor(1 / dsf);
        await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
        const height = await win.webContents.executeJavaScript('document.documentElement.scrollHeight');
        win.setContentSize(WIDTH / dsf, Math.ceil(height / dsf));
        await new Promise(resolve => setTimeout(resolve, 900));
        const image = await win.webContents.capturePage();
        fs.writeFileSync(output, image.toPNG());
        const summary = await win.webContents.executeJavaScript("document.getElementById('check-summary').textContent");
        console.log('saved', output, image.getSize(), summary);
        win.destroy();
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        fs.rmSync(TMP, { recursive: true, force: true });
        app.quit();
    }
});
