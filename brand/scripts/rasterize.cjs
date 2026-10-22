// SPDX-License-Identifier: MIT
// Raster exports for Nodu brand v2, using the repo's Electron (no sharp or other image dependency):
//   brand/assets/app-icon-{16..1024}.png, Nodu.ico          square tile (Windows, web)
//   brand/assets/Nodu.iconset/, Nodu.icns (macOS only)       Big Sur template (824 / 1024 body)
//   brand/assets/logo-on-light.png, logo-on-dark.png         1600 px transparent lockups
// 16-32 px always come from the heavier small-size masters. Run after build.cjs, from the repo root:
//   desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron brand/scripts/rasterize.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASSETS = path.resolve(__dirname, '..', 'assets');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-raster-'));
const SMALL = 32; // sizes up to and including this use the small master
const SQUARE = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO = [16, 24, 32, 48, 64, 128, 256];
const ICONSET = [16, 32, 128, 256, 512];

app.setPath('userData', path.join(TMP, 'user'));
app.on('window-all-closed', () => {});
setTimeout(() => { console.error('rasterize: timed out'); app.exit(3); }, 120000).unref();

let seq = 0;
async function page(html, width, height) {
    const file = path.join(TMP, `page-${++seq}.html`);
    fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:transparent;overflow:hidden}img{position:absolute;display:block}</style>${html}`);
    const win = new BrowserWindow({
        show: false, width, height, useContentSize: true, frame: false, transparent: true,
        backgroundColor: '#00000000', webPreferences: { offscreen: true, backgroundThrottling: false }
    });
    await win.loadFile(file);
    await win.webContents.executeJavaScript('Promise.all([...document.images].map(i => i.decode())).then(() => true)');
    await new Promise(resolve => setTimeout(resolve, 200));
    return win;
}
const uri = file => `data:image/svg+xml;base64,${fs.readFileSync(path.join(ASSETS, file)).toString('base64')}`;

// Lay every size of one source out side by side, capture once per size at true device pixels.
async function renderSizes(file, sizes, dsf) {
    let x = 0;
    const slots = sizes.map(size => { const css = size / dsf, slot = { size, css, x }; x += css + 4; return slot; });
    const height = Math.max(...slots.map(s => s.css));
    const win = await page(slots.map(s => `<img src="${uri(file)}" style="left:${s.x}px;top:0;width:${s.css}px;height:${s.css}px">`).join(''), x, height);
    const out = {};
    for (const s of slots) {
        const image = await win.webContents.capturePage({ x: s.x, y: 0, width: s.css, height: s.css });
        if (image.getSize().width !== s.size) throw new Error(`${file} @${s.size}: got ${image.getSize().width}px`);
        out[s.size] = image.toPNG();
    }
    win.destroy();
    return out;
}
async function renderWide(file, width, dsf) {
    const svg = fs.readFileSync(path.join(ASSETS, file), 'utf8');
    const [, , w, h] = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    const css = { w: width / dsf, h: Math.round((width * h) / w) / dsf };
    const win = await page(`<img src="${uri(file)}" style="left:0;top:0;width:${css.w}px;height:${css.h}px">`, css.w, css.h);
    const png = (await win.webContents.capturePage()).toPNG();
    win.destroy();
    return png;
}

// ICO with PNG-compressed entries (Windows Vista and later).
function writeIco(file, entries) {
    const head = Buffer.alloc(6 + 16 * entries.length);
    head.writeUInt16LE(1, 2);
    head.writeUInt16LE(entries.length, 4);
    let offset = head.length;
    entries.forEach(({ size, data }, i) => {
        const p = 6 + 16 * i;
        head[p] = head[p + 1] = size >= 256 ? 0 : size;
        head.writeUInt16LE(1, p + 4);
        head.writeUInt16LE(32, p + 6);
        head.writeUInt32LE(data.length, p + 8);
        head.writeUInt32LE(offset, p + 12);
        offset += data.length;
    });
    fs.writeFileSync(file, Buffer.concat([head, ...entries.map(e => e.data)]));
}

async function run() {
    if (app.dock) app.dock.hide();
    // Offscreen captures follow the display scale; measure it so every PNG has exact pixel dimensions.
    const probe = await page('', 10, 10);
    const dsf = (await probe.webContents.capturePage()).getSize().width / 10;
    probe.destroy();

    const small = await renderSizes('app-icon-small.svg', SQUARE.filter(s => s <= SMALL), dsf);
    const regular = await renderSizes('app-icon.svg', SQUARE.filter(s => s > SMALL), dsf);
    const square = { ...small, ...regular };
    for (const size of SQUARE) fs.writeFileSync(path.join(ASSETS, `app-icon-${size}.png`), square[size]);
    writeIco(path.join(ASSETS, 'Nodu.ico'), ICO.map(size => ({ size, data: square[size] })));

    const macSizes = [...new Set(ICONSET.flatMap(s => [s, s * 2]))].sort((a, b) => a - b);
    const mac = {
        ...await renderSizes('app-icon-macos-small.svg', macSizes.filter(s => s <= SMALL), dsf),
        ...await renderSizes('app-icon-macos.svg', macSizes.filter(s => s > SMALL), dsf)
    };
    const iconset = path.join(ASSETS, 'Nodu.iconset');
    fs.rmSync(iconset, { recursive: true, force: true });
    fs.mkdirSync(iconset);
    for (const s of ICONSET) {
        fs.writeFileSync(path.join(iconset, `icon_${s}x${s}.png`), mac[s]);
        fs.writeFileSync(path.join(iconset, `icon_${s}x${s}@2x.png`), mac[s * 2]);
    }
    if (process.platform === 'darwin') {
        execFileSync('/usr/bin/iconutil', ['-c', 'icns', '-o', path.join(ASSETS, 'Nodu.icns'), iconset]);
    } else {
        console.warn('rasterize: iconutil is macOS-only; Nodu.icns was not regenerated.');
    }

    fs.writeFileSync(path.join(ASSETS, 'logo-on-light.png'), await renderWide('logo-on-light.svg', 1600, dsf));
    fs.writeFileSync(path.join(ASSETS, 'logo-on-dark.png'), await renderWide('logo-on-dark.svg', 1600, dsf));
    // Hashes of the SVG sources these rasters came from; check-brand.cjs flags rasters older than their SVG.
    const sources = ['app-icon.svg', 'app-icon-small.svg', 'app-icon-macos.svg', 'app-icon-macos-small.svg', 'logo-on-light.svg', 'logo-on-dark.svg'];
    const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(ASSETS, file))).digest('hex');
    fs.writeFileSync(path.join(ASSETS, 'raster-sources.json'), `${JSON.stringify(Object.fromEntries(sources.map(s => [s, sha(s)])), null, 2)}\n`);
    console.log(`rasterize: ${SQUARE.length} PNG, Nodu.ico (${ICO.length} sizes), Nodu.iconset${process.platform === 'darwin' ? ' + Nodu.icns' : ''}, 2 lockups (scale ${dsf}).`);
}

app.whenReady().then(run).catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    app.quit();
});
