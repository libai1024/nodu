// Nodu redesign proposal (2026-10-21). Writes master SVGs and four review boards next to this file.
// Run: node brand/proposals/2026-10-21/build.cjs   (no dependencies)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const G = require('./geometry.cjs');
const P = require('./palette.cjs');

const ROOT = __dirname;
const MASTERS = path.join(ROOT, 'masters');
const BOARDS = path.join(ROOT, 'boards');
fs.mkdirSync(MASTERS, { recursive: true });
fs.mkdirSync(BOARDS, { recursive: true });

const C = {
    blue: P.core.blue.hex, gold: P.core.gold.hex, ink: P.core.ink.hex, paper: P.core.paper.hex, white: '#FFFFFF',
    onDark: '#8FA8FF', deep: '#2449DB', soft: '#EEF2FF',
    surface: '#1D2027', raised: '#23272F', border: '#343A45', muted: '#949CAA', text: '#E7EAEF',
    lmuted: '#5B616C', ltext: '#1D2129', lline: '#D8D4C8', lpanel: '#EFEDE6', lsurface: '#E7E4DB', card: '#FFFFFF'
};
const STATUS = Object.fromEntries(P.status.map(s => [s.key, s]));
const FONT = "-apple-system,'PingFang SC','Source Han Sans SC','Noto Sans SC','Microsoft YaHei',sans-serif";
const MONO = "'SF Mono','JetBrains Mono',Menlo,Consolas,monospace";

// ---------- tiny SVG helpers ----------
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function text(x, y, str, o = {}) {
    const { size = 16, weight = 400, color = C.ink, family = FONT, anchor = 'start', opacity, spacing } = o;
    return `<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${color}"` +
        `${anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}${opacity ? ` opacity="${opacity}"` : ''}` +
        `${spacing ? ` letter-spacing="${spacing}"` : ''}>${esc(str)}</text>`;
}
const lines = (x, y, arr, o = {}) => arr.map((s, i) => text(x, y + i * (o.lh || 26), s, o)).join('');
function rect(x, y, w, h, { fill = 'none', rx = 0, stroke, sw = 1, dash, opacity } = {}) {
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" fill="${fill}"` +
        `${stroke ? ` stroke="${stroke}" stroke-width="${sw}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}` +
        `${opacity ? ` opacity="${opacity}"` : ''}/>`;
}
const place = (body, x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})">${body}</g>`;
const card = (x, y, w, h, fill = C.card) => rect(x, y, w, h, { fill, rx: 18, stroke: fill === C.card ? '#E4E1D8' : undefined });
function header(overline, title, subtitle) {
    return text(64, 78, overline, { size: 15, weight: 600, color: C.blue, spacing: 0.5 }) +
        text(64, 126, title, { size: 34, weight: 600 }) +
        text(64, 164, subtitle, { size: 18, color: C.lmuted });
}
const footer = (y, str) => text(64, y, str, { size: 13, color: C.lmuted });
function board(w, h, body, title) {
    return G.svg(`${rect(0, 0, w, h, { fill: C.paper })}${body}`, { box: `0 0 ${w} ${h}`, title, w, h });
}
function pill(x, y, label, { fill = C.blue, color = C.white, size = 13, pad = 10 } = {}) {
    const w = pillWidth(label, size, pad);
    return rect(x, y, w, size + 12, { fill, rx: (size + 12) / 2 }) + text(x + w / 2, y + size + 3, label, { size, weight: 600, color, anchor: 'middle' });
}
function pillWidth(label, size = 13, pad = 10) { return Math.round(textWidth(label, size) + pad * 2); }

// ---------- brand pieces ----------
// Selected 2026-10-21: direction 02 「点亮」. Direction 01 stays on the boards as the archived alternative.
const mark = (o = {}) => G.blinkMark(o);
const markSmall = () => G.blinkMark({ size: 'small' });
const mono = (color, size) => G.blinkMono(color, size);
const pin1 = (o = {}) => G.pin1Mark({ tile: C.blue, glyph: C.white, dot: C.gold, ...o });
const pin1Small = () => pin1({ size: 'small' });
const blink = () => G.blinkMark({ tile: C.ink, dome: C.gold, legs: C.white });
const pulse = () => G.pulseMark({ tile: C.blue, line: C.white, dot: C.gold });
// Width estimate for pills: CJK glyphs take a full em, Latin and digits about 0.6 em.
const textWidth = (s, size) => [...s].reduce((w, ch) => w + (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : size * 0.6), 0);

// ---------- masters ----------
function writeMasters() {
    const out = (name, body, box, title) => fs.writeFileSync(path.join(MASTERS, name), G.svg(body, { box, title }));
    const L = `0 0 ${G.LOCKUP_W} 100`, B = `0 0 ${G.BILINGUAL_W} 100`;
    out('mark.svg', mark(), undefined, 'Nodu 标志');
    out('mark-small.svg', markSmall(), undefined, 'Nodu 标志（16–32 px 母版）');
    out('mark-mono.svg', mono('currentColor'), undefined, 'Nodu 单色标志');
    out('mark-toolbar.svg', G.blinkTight().body, G.blinkTight().box, 'Nodu 工具栏标志（深色主题）');
    out('wordmark.svg', G.wordmark('currentColor'), `0 0 ${G.WORD.width} 100`, 'nodu 字标');
    out('logo-on-light.svg', G.lockup(mark(), C.ink), L, 'Nodu 横向组合（浅底）');
    out('logo-on-dark.svg', G.lockup(mark(), C.white), L, 'Nodu 横向组合（深底）');
    out('logo-bilingual-on-light.svg', G.bilingual(mark(), C.ink, C.ink), B, 'Nodu · 见微（浅底）');
    out('logo-bilingual-on-dark.svg', G.bilingual(mark(), C.white, C.white), B, 'Nodu · 见微（深底）');
    out('app-icon-1024.svg', G.blinkAppIcon(), '0 0 1024 1024', 'Nodu 应用图标');
    out('direction-1-pin1.svg', pin1(), undefined, 'Nodu 方向 1 · 一号引脚（未选）');
    out('direction-3-pulse.svg', pulse(), undefined, 'Nodu 方向 3 · 脉冲（未选）');
    for (const stale of ['direction-2-blink.svg']) fs.rmSync(path.join(MASTERS, stale), { force: true });
}

// ---------- board 1: three directions ----------
function directionsBoard() {
    const cols = [
        {
            no: '01', name: '一号引脚', en: 'Pin 1', mark: pin1(), small: pin1Small(),
            story: ['芯片用一个小圆点标出 1 号引脚，读懂一颗', '芯片从这里开始。蓝色板体、白色丝印 n，', '金色圆点同时是第一盏被点亮的灯。'],
            notes: ['✓ 16 px 仍清楚，图标形态完整', '✓ 延续现有“n + 圆点”的记忆', '✓ 圆点可延展为“从这里开始”的引导符号', '△ 字母方块较常见，靠圆点建立区分']
        },
        {
            no: '02', name: '点亮', en: 'Blink', mark: blink(), small: markSmall(), pick: true,
            story: ['Blink 是嵌入式的 Hello World。n 的拱形', '是被点亮的 LED 灯罩，两条腿是长短不同', '的引脚：长脚为正。'],
            notes: ['✓ 情绪最强，直接对应第一次成功', '✓ 长短引脚是初学者会学到的真实细节', '△ 分段的 n 在 16 px 偏碎', '△ 墨色板体在深色背景上需要描边']
        },
        {
            no: '03', name: '脉冲', en: 'Pulse', mark: pulse(), small: pulse(),
            story: ['一次高电平脉冲画出 n：代码变成电信号，', '信号点亮输出，强调“运行”这个动作。'],
            notes: ['✓ 线条最简洁，技术感强', '✓ 与运行、下载动作关联直接', '△ 方波常见于仪器品牌，辨识度最低', '△ 偏工程感，对新手的亲和力较弱']
        }
    ];
    let body = header('品牌提案 · 2026-10-21 · 已选方向 02', '三个方向，对应初学者的三个“第一次”',
        '认出一颗芯片 · 点亮一盏灯 · 发出一个信号。三个方向都不绑定任何芯片厂商，K210、STM32、ESP32 放在开发板选择里。');
    cols.forEach((c, i) => {
        const x = 64 + i * 504, y = 206;
        body += card(x, y, 464, 790);
        body += text(x + 32, y + 52, `${c.no}  ${c.name}`, { size: 26, weight: 600 });
        body += text(x + 32, y + 80, c.en, { size: 15, color: C.lmuted, family: MONO });
        if (c.pick) body += pill(x + 372, y + 30, '已选');
        body += place(c.mark, x + 32, y + 104, 1.76);
        body += place(c.small, x + 248, y + 216, 0.64) + place(c.small, x + 328, y + 248, 0.32) + place(c.small, x + 376, y + 264, 0.16);
        body += text(x + 248, y + 300, '64 · 32 · 16（矢量缩放）', { size: 12, color: C.lmuted });
        body += rect(x + 32, y + 316, 400, 84, { fill: C.paper, rx: 10 }) + place(G.lockup(c.mark, C.ink), x + 56, y + 330, 0.56);
        body += rect(x + 32, y + 412, 400, 84, { fill: C.ink, rx: 10 }) + place(G.lockup(c.onDark || c.mark, C.white), x + 56, y + 426, 0.56);
        body += lines(x + 32, y + 548, c.story, { size: 17, lh: 28 });
        body += lines(x + 32, y + 650, c.notes, { size: 15, lh: 27, color: C.lmuted });
    });
    body += footer(1036, '全部为原创矢量几何，标志与字标不依赖字体；“见微”中文组合用开源字体（思源黑体 / Noto Sans SC）设置，定稿前转曲。小尺寸实测见 previews/small-sizes.png。');
    return board(1600, 1060, body, 'Nodu 标志方向');
}

// ---------- board 2: identity system ----------
function identityBoard() {
    let body = header('已选方向 · 02 点亮', '标志系统',
        'n 的拱形是被点亮的 LED 灯罩，两条腿是引脚，左边的长脚为正极。灯罩只用点亮黄，始终放在芯片墨上。');
    // Row A: primary lockups
    body += card(64, 200, 940, 320) + place(G.lockup(mark(), C.ink), G.f(534 - G.LOCKUP_W * 0.75), 285, 1.5) + text(96, 492, '横向组合 · 浅底', { size: 14, color: C.lmuted });
    body += card(1028, 200, 508, 320, C.ink) + place(G.lockup(mark(), C.white), 1095, 322, 1.0) + text(1060, 492, '横向组合 · 深底', { size: 14, color: C.muted });
    // Row B: bilingual + one-colour stencils
    body += card(64, 544, 696, 216) + place(G.bilingual(mark(), C.ink, C.ink), 100, 600, 0.86) + text(96, 736, '中英组合 · Nodu · 见微', { size: 14, color: C.lmuted });
    body += card(784, 544, 752, 216);
    body += rect(816, 576, 140, 140, { fill: C.paper, rx: 12 }) + place(mono(C.ink), 846, 606, 0.8);
    body += rect(972, 576, 140, 140, { fill: C.blue, rx: 12 }) + place(mono(C.white), 1002, 606, 0.8);
    body += rect(1128, 576, 140, 140, { fill: C.ink, rx: 12 }) + place(mono(C.paper), 1158, 606, 0.8);
    body += lines(1292, 608, ['单色标志', '单色印刷、压印、', '开发板丝印。', '灯罩与引脚同色。'], { size: 15, lh: 26, color: C.lmuted });
    body += text(816, 742, '浅底墨色 · 蓝底白色 · 深底丝印白', { size: 13, color: C.lmuted });
    // Row C: construction
    body += card(64, 784, 696, 340);
    const cx = 96, cy = 812, s = 2.8;
    body += place(mark(), cx, cy, s);
    let grid = '';
    for (let k = 0; k <= 10; k++) {
        grid += `<path d="M${cx + k * 28} ${cy}V${cy + 280}M${cx} ${cy + k * 28}H${cx + 280}" stroke="#FFFFFF" stroke-opacity=".14" stroke-width="1"/>`;
    }
    body += grid;
    const v = G.BLINK.regular;
    body += lines(404, 840, ['灯罩 · 点亮黄 #FFC23D', `拱形线宽 ${v.sw}，半径 ${v.r}，底边平切`], { size: 15, lh: 24 });
    body += lines(404, 912, ['引脚 · 长脚为正', `左 ${v.long} / 右 ${v.short}，与灯罩间隔 ${v.gap}`], { size: 15, lh: 24 });
    body += lines(404, 984, ['板体 · 芯片墨，超椭圆（n = 5）', `深色背景上加 ${v.rim.width} px 描边 ${v.rim.color}`], { size: 15, lh: 24 });
    body += lines(404, 1056, ['安全留白 ≥ 灯罩线宽 × 2', '单独标志最小 16 px'], { size: 15, lh: 24 });
    // Row C right: app icon + small master
    body += card(784, 784, 752, 340);
    body += rect(816, 816, 220, 220, { fill: C.lsurface, rx: 14 }) + place(G.blinkAppIcon(), 816, 816, 220 / 1024);
    body += text(816, 1064, '应用图标 · 1024 画布，824 板体', { size: 13, color: C.lmuted });
    body += text(1068, 836, '小尺寸母版（16–32 px）', { size: 16, weight: 600 });
    const sm = G.BLINK.small;
    body += lines(1068, 864, [`线宽加粗到 ${sm.sw}，间隔收紧到 ${sm.gap}，`, `描边加到 ${sm.rim.width} px，任务栏里也能认出灯罩。`], { size: 14, lh: 22, color: C.lmuted });
    [[64, 1068], [32, 1160], [24, 1220], [16, 1272]].forEach(([px, x]) => {
        body += place(markSmall(), x, 1004 - px, px / 100) + text(x, 1028, `${px}`, { size: 12, color: C.lmuted, family: MONO });
    });
    body += rect(1068, 1044, 436, 52, { fill: C.ink, rx: 10 });
    [[32, 1086], [24, 1140], [16, 1186]].forEach(([px, x]) => { body += place(markSmall(), x, 1070 - px / 2, px / 100); });
    body += text(1224, 1076, '深色任务栏', { size: 13, color: C.muted });
    body += footer(1150, '组合标志最小 96 px 宽；深色工具栏用不带板体的灯形（22 px），浅色工具栏用小板体；应用图标、官网与文档使用彩色标志。');
    return board(1600, 1172, body, 'Nodu 标志系统');
}

// ---------- board 3: colour ----------
function colorBoard() {
    let body = header('推荐配色 · 电路板', '色彩：蓝色写代码，黄色是被点亮的那一刻',
        '取自一块真实的开发板：蓝色板体、白色丝印、金色焊盘与指示灯、黑色芯片。');
    const swatches = [
        { c: P.core.blue, sample: C.white, notes: [`白字 ${P.ratio(C.white, C.blue)}`, `深底图形 ${P.ratio(C.blue, C.ink)}`] },
        { c: P.core.gold, sample: C.ink, notes: [`墨底 ${P.ratio(C.gold, C.ink)} · 蓝底 ${P.ratio(C.gold, C.blue)}`, `浅底仅 ${P.ratio(C.gold, C.paper)}，禁止使用`] },
        { c: P.core.ink, sample: C.paper, notes: [`丝印白文字 ${P.ratio(C.paper, C.ink)}`, '深色工作台基准'] },
        { c: P.core.paper, sample: C.ink, notes: [`芯片墨文字 ${P.ratio(C.ink, C.paper)}`, `Nodu 蓝文字 ${P.ratio(C.blue, C.paper)}`] }
    ];
    swatches.forEach((s, i) => {
        const x = 64 + i * 376, y = 200;
        body += card(x, y, 344, 336);
        body += `<path d="M${x} ${y + 18}a18 18 0 0 1 18 -18h308a18 18 0 0 1 18 18v172h-344z" fill="${s.c.hex}"${s.c.hex === C.paper ? ' stroke="#E4E1D8"' : ''}/>`;
        body += text(x + 24, y + 64, 'Aa 运行', { size: 30, weight: 600, color: s.sample });
        if (s.c.hex === C.gold) body += place(mark({ tile: C.ink }), x + 252, y + 98, 0.68);
        if (s.c.hex === C.blue) body += place(mark(), x + 252, y + 98, 0.68);
        body += text(x + 24, y + 228, s.c.name, { size: 22, weight: 600 }) + text(x + 320, y + 228, s.c.hex, { size: 16, family: MONO, anchor: 'end', color: C.lmuted });
        body += text(x + 24, y + 256, s.c.role.length > 21 ? s.c.role.slice(0, s.c.role.indexOf('；') > 0 ? s.c.role.indexOf('；') : 21) : s.c.role, { size: 14, color: C.lmuted });
        body += lines(x + 24, y + 290, s.notes, { size: 13, lh: 22, color: C.ltext });
    });
    // blue ramp
    body += text(64, 584, 'Nodu 蓝色阶', { size: 18, weight: 600 }) + text(200, 584, '500 主色 · 300 深底文字与焦点 · 600 浅底文字与按下 · 50 浅色选中', { size: 14, color: C.lmuted });
    P.blueRamp.forEach(([step, hex], i) => {
        const x = 64 + i * 148, y = 604, dark = P.luminance(hex) < 0.3;
        body += rect(x, y, 140, 64, { fill: hex, rx: 8 }) + text(x + 12, y + 26, step, { size: 15, weight: 600, color: dark ? C.white : C.ink });
        body += text(x + 12, y + 50, hex, { size: 12, family: MONO, color: dark ? C.white : C.ink, opacity: 0.85 });
    });
    // neutrals
    body += text(64, 722, '深色工作台 · 冷石墨', { size: 18, weight: 600 }) + text(240, 722, '去掉 SCOPE 时期的青绿色偏，与蓝色同一色相', { size: 14, color: C.lmuted });
    P.dark.forEach(([name, hex], i) => {
        const x = 64 + i * 148, y = 740, dark = P.luminance(hex) < 0.3;
        body += rect(x, y, 140, 56, { fill: hex, rx: 8, stroke: '#00000014' }) + text(x + 12, y + 24, name, { size: 13, weight: 600, color: dark ? C.text : C.ink });
        body += text(x + 12, y + 44, hex, { size: 12, family: MONO, color: dark ? C.muted : C.lmuted });
    });
    body += text(64, 840, '浅色工作台 · 暖纸', { size: 18, weight: 600 }) + text(222, 840, '保留阅读感，暖色与点亮黄同调', { size: 14, color: C.lmuted });
    P.light.forEach(([name, hex], i) => {
        const x = 64 + i * 148, y = 858, dark = P.luminance(hex) < 0.3;
        body += rect(x, y, 140, 56, { fill: hex, rx: 8, stroke: '#00000018' }) + text(x + 12, y + 24, name, { size: 13, weight: 600, color: dark ? C.white : C.ink });
        body += text(x + 12, y + 44, hex, { size: 12, family: MONO, color: dark ? '#C7CCD4' : C.lmuted });
    });
    body += lines(1112, 876, ['主按钮两套主题共用 #2F5BFF + 白字；', '浅色主题悬停 / 按下用 600。'], { size: 14, lh: 22, color: C.lmuted });
    // status
    body += text(64, 962, '状态色', { size: 18, weight: 600 }) + text(140, 962, '连接中改用主色脉冲；琥珀只表示风险，不与点亮黄并排出现。', { size: 14, color: C.lmuted });
    P.status.forEach((s, i) => {
        const x = 64 + i * 296, y = 980;
        body += rect(x, y, 280, 150, { fill: C.card, rx: 12, stroke: '#E4E1D8' });
        body += rect(x + 16, y + 16, 248, 40, { fill: C.surface, rx: 8 }) + `<circle cx="${x + 38}" cy="${y + 36}" r="5" fill="${s.dark}"/>` +
            text(x + 52, y + 41, s.name, { size: 13, color: C.text }) + text(x + 252, y + 41, s.dark, { size: 11, family: MONO, color: C.muted, anchor: 'end' });
        body += rect(x + 16, y + 64, 248, 40, { fill: C.lsurface, rx: 8 }) + `<circle cx="${x + 38}" cy="${y + 84}" r="5" fill="${s.light}"/>` +
            text(x + 52, y + 89, s.name, { size: 13, color: C.ltext }) + text(x + 252, y + 89, s.light, { size: 11, family: MONO, color: C.lmuted, anchor: 'end' });
        body += text(x + 16, y + 132, s.note, { size: 13, color: C.lmuted });
    });
    body += footer(1168, '对比度按 WCAG 2.x 计算。代码语法、终端 ANSI、直方图通道色保持独立，不随品牌色替换。');
    return board(1600, 1190, body, 'Nodu 色彩');
}

// ---------- board 4: application mock ----------
const icon = {
    file: c => `<path d="M8 4h6l4 4v10.5A1.5 1.5 0 0 1 16.5 20h-9A1.5 1.5 0 0 1 6 18.5v-13A1.5 1.5 0 0 1 7.5 4zM14 4v4h4" ${G.stroke(c, 1.6)}/>`,
    play: c => `<path d="M8.5 6.5 17.5 12l-9 5.5z" fill="${c}" stroke="${c}" stroke-width="1.4" stroke-linejoin="round"/>`,
    stop: c => `<rect x="7" y="7" width="10" height="10" rx="1.5" ${G.stroke(c, 1.6)}/>`,
    term: c => `<rect x="4" y="5" width="16" height="14" rx="2" ${G.stroke(c, 1.6)}/><path d="M8 10l2.5 2L8 14M12.5 15H16" ${G.stroke(c, 1.6)}/>`,
    cam: c => `<path d="M4.5 8.5h3l1.8-2.5h5.4l1.8 2.5h3v10h-15z" ${G.stroke(c, 1.6)}/><circle cx="12" cy="13.2" r="3.2" ${G.stroke(c, 1.6)}/>`,
    theme: c => `<circle cx="12" cy="12" r="7" ${G.stroke(c, 1.6)}/><path d="M12 5a7 7 0 0 1 0 14z" fill="${c}"/>`
};
const ico = (fn, c, x, y, s = 1) => place(fn(c), x, y, s);
function toolbar(x, y, w, theme) {
    const dark = theme === 'dark';
    const bg = dark ? C.surface : C.lsurface, line = dark ? C.border : C.lline, fg = dark ? C.text : C.ltext, mut = dark ? C.muted : C.lmuted;
    const raised = dark ? C.raised : '#DCD8CD';
    let b = rect(x, y, w, 56, { fill: bg, rx: 12, stroke: line });
    // Dark theme: the bare lamp (legs follow the text colour); light theme: the small ink tile.
    b += dark ? place(G.blinkGlyph({ size: 'small', legs: fg, cx: 12, cy: 12, scale: 0.26 }), x + 18, y + 16)
        : place(markSmall(), x + 18, y + 16, 0.24);
    b += rect(x + 56, y + 12, 76, 32, { fill: raised, rx: 6 }) + ico(icon.file, fg, x + 62, y + 16, 1) + text(x + 92, y + 33, '文件', { size: 14, color: fg });
    b += rect(x + 142, y + 12, 84, 32, { fill: C.blue, rx: 6 }) + ico(icon.play, C.white, x + 150, y + 16, 1) + text(x + 180, y + 33, '运行', { size: 14, weight: 600, color: C.white });
    b += ico(icon.stop, mut, x + 238, y + 16, 1);
    b += rect(x + 278, y + 12, 236, 32, { fill: 'none', rx: 6, stroke: line }) + `<circle cx="${x + 294}" cy="${y + 28}" r="3.5" fill="${dark ? STATUS.ok.dark : STATUS.ok.light}"/>` +
        text(x + 306, y + 33, '野火 K210 CAM', { size: 14, weight: 600, color: fg }) + text(x + 414, y + 33, 'usbserial-3110', { size: 11, color: mut, family: MONO });
    const r = x + w;
    b += ico(icon.term, mut, r - 214, y + 16) + ico(icon.cam, mut, r - 178, y + 16);
    b += `<path d="M${r - 140} ${y + 16}V${y + 40}" stroke="${line}"/>` + ico(icon.theme, mut, r - 130, y + 16);
    b += rect(r - 96, y + 12, 80, 32, { fill: raised, rx: 16 }) + rect(r - 54, y + 15, 36, 26, { fill: dark ? C.ink : C.white, rx: 13 }) +
        text(r - 74, y + 33, '简', { size: 13, color: mut, anchor: 'middle' }) + text(r - 36, y + 33, '专', { size: 13, weight: 600, color: fg, anchor: 'middle' });
    return b;
}
function chip(x, y, label, color, dashed, theme = 'dark') {
    const dark = theme === 'dark';
    return rect(x, y, 168, 32, { fill: dark ? C.surface : C.lsurface, rx: 6, stroke: dark ? C.border : C.lline, dash: dashed ? '4 3' : undefined }) +
        `<circle cx="${x + 16}" cy="${y + 16}" r="3.5" fill="${color}"/>` + text(x + 28, y + 21, label, { size: 13, color: dark ? C.text : C.ltext });
}
function applicationBoard() {
    let body = header('落位示意 · 非运行截图', '在产品里的样子',
        '工具栏左侧是一盏小灯：深色主题不带板体，浅色主题用小板体。设备状态仍由 chip 上的状态点表达。');
    body += toolbar(64, 196, 1472, 'dark') + toolbar(64, 268, 1472, 'light');
    body += text(64, 362, '设备状态', { size: 14, weight: 600 });
    [['未连接 · 选择开发板', STATUS.idle.dark, true], ['连接中…', STATUS.busy.dark], ['已连接 · 运行中', STATUS.ok.dark], ['写入中 · 勿断电', STATUS.warn.dark], ['连接出错', STATUS.error.dark]]
        .forEach(([label, color, dashed], i) => { body += chip(140 + i * 184, 340, label, color, dashed); });
    // about dialog
    body += rect(64, 412, 488, 360, { fill: C.surface, rx: 14, stroke: C.border });
    body += text(96, 448, '关于 Nodu', { size: 13, color: C.muted });
    body += place(G.bilingual(mark(), C.white, C.white), 96, 472, 0.62);
    body += text(96, 580, '嵌入式入门学习 IDE', { size: 17, color: C.text });
    body += text(96, 606, '版本 0.1.4（开发版）', { size: 14, color: C.muted });
    body += lines(96, 648, ['已验证：K210（野火 CAM · GC2145）', '规划中：STM32、ESP32'], { size: 14, lh: 24, color: C.muted });
    body += rect(424, 716, 96, 32, { fill: C.raised, rx: 6 }) + text(472, 737, '关闭', { size: 14, color: C.text, anchor: 'middle' });
    // website hero
    body += rect(576, 412, 960, 360, { fill: C.card, rx: 14, stroke: '#E4E1D8' });
    body += place(G.lockup(mark(), C.ink), 608, 436, 0.3);
    body += text(1356, 456, '下载', { size: 13, color: C.ltext }) + text(1404, 456, '示例', { size: 13, color: C.ltext }) + text(1452, 456, '文档', { size: 13, color: C.ltext });
    body += text(608, 540, '从第一行代码，', { size: 40, weight: 600 }) + text(608, 592, '到第一次点亮。', { size: 40, weight: 600 });
    body += lines(608, 634, ['面向初学者的嵌入式学习 IDE：写代码、选开发板、', '运行到板上，看到结果。'], { size: 16, lh: 25, color: C.lmuted });
    let px = 608;
    for (const [label, fill, color] of [['K210 已验证', C.soft, C.deep], ['STM32 规划中', C.lpanel, C.lmuted], ['ESP32 规划中', C.lpanel, C.lmuted]]) {
        body += pill(px, 676, label, { fill, color, size: 12 });
        px += pillWidth(label, 12) + 8;
    }
    body += rect(608, 716, 128, 40, { fill: C.blue, rx: 8 }) + text(672, 742, '下载 Nodu', { size: 15, weight: 600, color: C.white, anchor: 'middle' });
    body += rect(748, 716, 112, 40, { fill: 'none', rx: 8, stroke: C.lline }) + text(804, 742, '看看示例', { size: 15, color: C.ltext, anchor: 'middle' });
    body += rect(1236, 476, 268, 268, { fill: C.ink, rx: 12 }) + place(mark(), 1306, 546, 1.28);
    // brand moment toast
    body += rect(64, 796, 488, 132, { fill: C.surface, rx: 14, stroke: C.border });
    body += `<circle cx="104" cy="844" r="12" fill="${C.gold}"/>`;
    body += text(132, 838, '第一次点亮', { size: 17, weight: 600, color: C.text }) + text(132, 864, 'LED 亮了，你的程序正在板上运行。', { size: 14, color: C.muted });
    body += text(132, 904, '下一步：把闪烁间隔改成 200 ms →', { size: 14, color: C.onDark });
    body += text(64, 952, '学习里程碑使用点亮黄；运行状态本身仍由绿色状态点表达。', { size: 13, color: C.lmuted });
    // dock
    body += rect(576, 796, 464, 132, { fill: C.lsurface, rx: 14 });
    const dockIcon = (x, fill) => place(`<path fill="${fill}" d="${G.TILE}"/>`, x, 826, 0.72);
    body += dockIcon(604, '#C9C5BA') + dockIcon(688, '#B9B5AA') + place(G.blinkAppIcon(), 762, 814, 96 / 1024) + dockIcon(860, '#C9C5BA') + dockIcon(944, '#B9B5AA');
    body += text(576, 952, '程序坞 / 任务栏：墨色板体加描边，在浅、深背景都能被认出。', { size: 13, color: C.lmuted });
    // silkscreen on a teaching board
    body += rect(1064, 796, 472, 132, { fill: '#1F3FB8', rx: 14 });
    for (let k = 0; k < 14; k++) body += `<circle cx="${1092 + k * 30}" cy="816" r="5" fill="${C.gold}"/><circle cx="${1092 + k * 30}" cy="816" r="2" fill="#1F3FB8"/>`;
    body += place(mono('#F4F3EE'), 1096, 844, 0.5) + place(G.wordmark('#F4F3EE'), 1158, 849, 0.42);
    body += text(1270, 882, 'LEARN · BLINK · BUILD', { size: 12, family: MONO, color: '#F4F3EE', opacity: 0.8 });
    body += `<circle cx="1490" cy="872" r="9" fill="${C.gold}"/>` + text(1478, 906, 'L1', { size: 11, family: MONO, color: '#F4F3EE' });
    body += text(1064, 952, '开发板 / 教学套件丝印（设想）：单色标志直接作为丝印。', { size: 13, color: C.lmuted });
    body += footer(998, '界面元素均为示意，不代表已实现的设备能力：当前仅 K210（野火 CAM / GC2145）完成真板验证，STM32 与 ESP32 为规划范围。');
    return board(1600, 1020, body, 'Nodu 落位示意');
}

// ---------- board 5: palette options ----------
function optionsBoard() {
    let body = header('配色对照', '为什么继续用蓝色，但换一种蓝',
        'IDE 里绿色表示已连接、琥珀表示风险、红色表示错误，主色放在蓝紫区间最稳妥。三种候选放在同一个按钮和标记上比较。');
    P.alternatives.forEach((a, i) => {
        const x = 64 + i * 504, y = 200;
        body += card(x, y, 464, 420);
        body += text(x + 32, y + 50, a.name, { size: 22, weight: 600 });
        if (i === 0) body += pill(x + 372, y + 30, '推荐');
        const tileMark = a.id === 'current'
            ? `<path fill="${C.ink}" d="${G.TILE}"/><g transform="translate(8 8) scale(.84)" fill="${a.onDark}"><path d="M18 80V22H35V30C40 24 48 20 58 20C75 20 84 31 84 49V57H66V49C66 40 62 36 54 36C43 36 36 44 36 55V80Z"/><circle cx="75" cy="75" r="9"/></g>`
            : mark();
        body += place(tileMark, x + 32, y + 78, 1.2);
        body += rect(x + 184, y + 82, 248, 112, { fill: C.ink, rx: 10 });
        body += rect(x + 204, y + 100, 92, 32, { fill: a.brand, rx: 6 }) + text(x + 250, y + 121, '运行', { size: 14, weight: 600, color: a.buttonText || C.white, anchor: 'middle' });
        body += text(x + 312, y + 121, '链接文字', { size: 14, color: a.onDark });
        body += rect(x + 204, y + 148, 208, 3, { fill: a.brand, rx: 1.5 });
        body += text(x + 204, y + 176, '活动标记', { size: 12, color: C.muted });
        const notes = {
            board: [`白字 ${P.ratio(C.white, a.brand)}（AA），两套主题共用一个按钮`, `深底活动标记 ${P.ratio(a.brand, C.ink)}（≥ 3:1）`, '与绿 / 琥珀 / 红状态色区分清楚', '点亮黄与蓝互补，标志在小尺寸更醒目'],
            indigo: [`白字 ${P.ratio(C.white, a.brand)}，辨识度更高`, `深底活动标记仅 ${P.ratio(a.brand, C.ink)}，需要另配浅色`, '近年常被用作 AI 产品色，', '容易让人误会产品定位'],
            current: [`白字仅 ${P.ratio(C.white, a.brand)}，深色主题按钮改用深色文字`, '浅色主题需另配 #244BB0 按钮', '与常见 IDE 蓝接近，品牌区分度低', '现行标志在 24 px 下容易读成 “r.”']
        }[a.id];
        body += lines(x + 32, y + 250, notes, { size: 15, lh: 28, color: i === 0 ? C.ltext : C.lmuted });
        const chips = [a.brand, a.onDark, a.deep, a.signal || a.soft];
        body += chips.map((hex, k) => rect(x + 32 + k * 52, y + 366, 44, 28, { fill: hex, rx: 6, stroke: '#00000012' })).join('');
        body += text(x + 248, y + 386, a.signal ? `${a.brand} · ${a.signal}` : `${a.brand} · 无信号色`, { size: 12, family: MONO, color: C.lmuted });
    });
    body += footer(664, '不选橙、绿、红作为主色：它们会和“写入风险 / 已连接 / 错误”撞色；Arduino 的青色与乐鑫的红色也已有强烈联想。');
    return board(1600, 690, body, 'Nodu 配色对照');
}

// ---------- board 0: one-glance overview ----------
function overviewBoard() {
    let body = header('品牌提案 · 2026-10-21 · 已选方向 02「点亮」', 'Nodu 新形象一览',
        '一颗被点亮的 LED：金色灯罩、长短不同的引脚、芯片墨板体。面向 STM32、K210、ESP32 等主流 MCU 的嵌入式入门学习 IDE。');
    body += card(64, 200, 940, 300);
    body += place(G.lockup(mark(), C.ink), G.f(534 - G.LOCKUP_W * 0.65), 285, 1.3);
    body += text(96, 476, '横向组合', { size: 14, color: C.lmuted });
    body += card(1028, 200, 508, 300, C.ink);
    body += place(G.blinkAppIcon(), 1152, 214, 260 / 1024);
    body += text(1060, 476, '应用图标', { size: 14, color: C.muted });
    const roles = { blue: '主要动作 · 焦点 · 选中 · 进度', gold: '标志灯罩 · 首次点亮', ink: '标志板体 · 深色工作台', paper: '浅色阅读面 · 深底文字' };
    Object.entries(roles).forEach(([key, role], i) => {
        const c = P.core[key], w = 356, x = 64 + i * (w + 16), y = 524;
        body += card(x, y, w, 184);
        body += `<path d="M${x} ${y + 18}a18 18 0 0 1 18 -18h${w - 36}a18 18 0 0 1 18 18v86h-${w}z" fill="${c.hex}"${key === 'paper' ? ' stroke="#E4E1D8"' : ''}/>`;
        body += text(x + 24, y + 140, c.name, { size: 20, weight: 600 }) + text(x + w - 24, y + 140, c.hex, { size: 15, family: MONO, anchor: 'end', color: C.lmuted });
        body += text(x + 24, y + 166, role, { size: 13, color: C.lmuted });
    });
    body += toolbar(64, 732, 1472, 'dark') + toolbar(64, 800, 1472, 'light');
    body += footer(892, '详见：01 方向对比 · 02 标志系统 · 03 色彩 · 04 落位示意 · 05 配色对照。工具栏为示意，不是运行截图。');
    return board(1600, 916, body, 'Nodu 新形象一览');
}

writeMasters();
const boards = {
    '00-overview.svg': overviewBoard(),
    '01-directions.svg': directionsBoard(),
    '02-identity.svg': identityBoard(),
    '03-color.svg': colorBoard(),
    '04-application.svg': applicationBoard(),
    '05-palette-options.svg': optionsBoard()
};
for (const [name, content] of Object.entries(boards)) fs.writeFileSync(path.join(BOARDS, name), content);
console.log(`Wrote ${fs.readdirSync(MASTERS).length} masters and ${Object.keys(boards).length} boards.`);
