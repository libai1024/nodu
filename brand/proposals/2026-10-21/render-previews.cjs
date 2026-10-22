// Renders boards/*.svg and a small-size pixel test to previews/*.png with the repo's Electron.
// From the repo root, after `node brand/proposals/2026-10-21/build.cjs`:
//   desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron brand/proposals/2026-10-21/render-previews.cjs
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const G = require('./geometry.cjs');

const ROOT = __dirname;
const REPO = path.resolve(ROOT, '../../..');
const BOARDS = path.join(ROOT, 'boards');
const PREVIEWS = path.join(ROOT, 'previews');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-previews-'));
fs.mkdirSync(PREVIEWS, { recursive: true });

app.setPath('userData', path.join(TMP, 'user'));
// Keep the app alive between captures; destroying the last window would otherwise quit it.
app.on('window-all-closed', () => {});

let seq = 0;
async function capture(html, width, height) {
    const file = path.join(TMP, `page-${++seq}.html`);
    fs.writeFileSync(file, html);
    const win = new BrowserWindow({
        show: false, width, height, useContentSize: true, frame: false,
        webPreferences: { offscreen: true, backgroundThrottling: false }
    });
    try {
        await win.loadFile(file);
        await new Promise(resolve => setTimeout(resolve, 400));
        return await win.webContents.capturePage({ x: 0, y: 0, width, height });
    } finally {
        win.destroy();
    }
}

async function renderBoards() {
    for (const name of fs.readdirSync(BOARDS).filter(n => n.endsWith('.svg')).sort()) {
        const svg = fs.readFileSync(path.join(BOARDS, name), 'utf8');
        const width = Number(svg.match(/width="(\d+)"/)[1]);
        const height = Number(svg.match(/height="(\d+)"/)[1]);
        const image = await capture(`<!doctype html><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style>${svg}`, width, height);
        fs.writeFileSync(path.join(PREVIEWS, name.replace('.svg', '.png')), image.toPNG());
        console.log('board', name, image.getSize());
    }
}

// Each row is rasterised at true device pixels (16 / 24 / 32 / 48 px), then shown magnified with hard pixels.
async function renderSmallSizes(dsf) {
    const C = { blue: '#2F5BFF', gold: '#FFC23D', ink: '#14171C', paper: '#F6F5F0', white: '#FFFFFF', onDark: '#8FA8FF', toolbar: '#1D2027' };
    const current = name => fs.readFileSync(path.join(REPO, 'brand/assets', name), 'utf8');
    const currentMark = color => current('mark.svg').replace('fill="currentColor"', `fill="${color}"`);
    const blinkSmall = G.svg(G.blinkMark({ size: 'small' }));
    const tight = G.blinkTight({ legs: '#E7EAEF' });
    const rows = [
        ['已选 · 应用图标（小尺寸母版）', blinkSmall, blinkSmall, C.ink],
        ['已选 · 工具栏（深：灯形 / 浅：小板体）', G.svg(tight.body, { box: tight.box }), blinkSmall, C.toolbar],
        ['方向 1 · 一号引脚', ...Array(2).fill(G.svg(G.pin1Mark({ tile: C.blue, glyph: C.white, dot: C.gold, size: 'small' }))), C.ink],
        ['方向 3 · 脉冲', ...Array(2).fill(G.svg(G.pulseMark({ tile: C.blue, line: C.white, dot: C.gold }))), C.ink],
        ['现行 · 应用图标', current('app-icon.svg'), current('app-icon.svg'), C.ink],
        ['现行 · 工具栏标志', currentMark('#8EACFF'), currentMark('#244BB0'), C.toolbar]
    ];
    const SIZES = [16, 24, 32, 48], W = 320, H = 64, px = v => `${v / dsf}px`;
    const uri = svg => `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
    const half = (svg, bg) => `<div style="background:${bg};display:flex;align-items:center;gap:${px(10)};padding:0 ${px(10)};height:${px(H)};width:${px(W / 2 - 20)}">` +
        SIZES.map(s => `<img src="${uri(svg)}" style="display:block;width:${px(s)};height:${px(s)}">`).join('') + '</div>';
    const rasters = [];
    for (const [, darkSvg, lightSvg, darkBg] of rows) {
        const image = await capture(`<!doctype html><meta charset="utf-8"><style>body{margin:0;display:flex}</style>${half(darkSvg, darkBg)}${half(lightSvg, C.paper)}`, W / dsf, H / dsf);
        rasters.push(image.toPNG().toString('base64'));
    }
    const Z = 3;
    const list = rows.map(([label], i) => `<div class="row"><div class="label">${label}</div><img src="data:image/png;base64,${rasters[i]}" width="${W * Z}" height="${H * Z}"></div>`).join('');
    const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;padding:28px 32px;background:#F6F5F0;font:15px -apple-system,'PingFang SC',sans-serif;color:#14171C}
h1{font-size:22px;margin:0 0 6px}p{margin:0 0 18px;color:#5B616C}
.row{display:flex;align-items:center;gap:20px;margin-bottom:10px}.label{width:200px;flex:none}
img{display:block;image-rendering:pixelated;border-radius:6px}
.ticks{display:flex;width:${W * Z}px;margin-left:220px;margin-bottom:8px;color:#5B616C;font-size:13px}.ticks span{flex:1}
</style><h1>小尺寸实测</h1><p>按真实像素栅格化后放大 ${Z} 倍。每行左半为深色背景，右半为浅色背景，依次 ${SIZES.join(' / ')} px。</p>
<div class="ticks"><span>深色背景</span><span>浅色背景</span></div>${list}`;
    const width = 32 * 2 + 220 + W * Z, height = 130 + rows.length * (H * Z + 10);
    const image = await capture(html, width, height);
    fs.writeFileSync(path.join(PREVIEWS, 'small-sizes.png'), image.toPNG());
    console.log('small-sizes', image.getSize());
}

app.whenReady().then(async () => {
    if (app.dock) app.dock.hide();
    try {
        // Offscreen output follows the display scale; measure it so the pixel test uses true device pixels.
        const probe = await capture('<!doctype html><body style="margin:0">', 10, 10);
        const dsf = probe.getSize().width / 10;
        await renderBoards();
        await renderSmallSizes(dsf);
        console.log('device scale factor', dsf);
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    } finally {
        fs.rmSync(TMP, { recursive: true, force: true });
        app.quit();
    }
});
