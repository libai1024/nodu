// SPDX-License-Identifier: MIT
// Nodu · 见微 brand geometry, v2 (2026-10-21): the lit-LED mark「点亮」and the monoline nodu wordmark.
// Original vector artwork; no fonts are needed for the mark or the wordmark.
// Marks use a 100 x 100 grid. The wordmark uses baseline 90, x-height 35, stroke 13.
'use strict';

const { logo } = require('./tokens.cjs');

const f = v => Number(v.toFixed(2));

// ---------- wordmark ----------
const SW = 13;
const H = SW / 2;
// n: stem with a short spur above the shoulder; u is the same drawing turned 180 degrees.
function nLine() {
    const a = H, b = 54 - H, r = (b - a) / 2, cy = 35 + H + r;
    return `M${f(a)} ${90 - H}V${f(37.5 + H)}M${f(a)} ${f(cy)}A${f(r)} ${f(r)} 0 0 1 ${f(b)} ${f(cy)}V${90 - H}`;
}
const BOWL_R = 28.5 - H;
const WORD = { n: 0, o: 62, d: 126, u: 194, width: 248 };
// Structured elements, so React and SVG writers share one drawing.
function wordmarkElements() {
    const o = WORD.o + 28.5, d = WORD.d + 28.5;
    return [
        { type: 'path', d: nLine() },
        { type: 'circle', cx: o, cy: 62.5, r: BOWL_R },
        { type: 'circle', cx: d, cy: 62.5, r: BOWL_R },
        { type: 'path', d: `M${d + BOWL_R} ${8 + H}V${90 - H}` },
        { type: 'path', d: nLine(), transform: `translate(${WORD.u} 0) rotate(180 27 62.5)` }
    ];
}
function stroke(color, width = SW, cap = 'round') {
    return `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="round"`;
}
function wordmark(color = 'currentColor') {
    const body = wordmarkElements().map(e => e.type === 'circle'
        ? `<circle cx="${e.cx}" cy="${e.cy}" r="${e.r}"/>`
        : `<path${e.transform ? ` transform="${e.transform}"` : ''} d="${e.d}"/>`).join('');
    return `<g ${stroke(color)}>${body}</g>`;
}

// ---------- tile ----------
// Superellipse (n = 5), close to the macOS icon outline.
function squircle(x = 0, y = 0, size = 100, exponent = 5, steps = 240) {
    const r = size / 2, cx = x + r, cy = y + r, e = 2 / exponent, pts = [];
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
        pts.push(`${f(cx + r * Math.sign(c) * Math.abs(c) ** e)} ${f(cy + r * Math.sign(s) * Math.abs(s) ** e)}`);
    }
    return `M${pts.join('L')}Z`;
}
const TILE = squircle();

// ---------- the lit-LED mark ----------
// Gold dome = the lit LED lens, cut flat at its base; legs = its leads, the anode (left) longer.
// `regular` serves 48 px and up; `small` is the optical master for 16-32 px (heavier, tighter gap).
const MASTERS = {
    regular: { sw: 14, gap: 6, r: 19.5, long: 83, short: 74, scale: 0.84, rim: { width: 2, color: logo.rim } },
    small: { sw: 17.5, gap: 4.5, r: 18.5, long: 81, short: 72, scale: 0.9, rim: { width: 3, color: logo.rimSmall } }
};

// Local drawing: dome centred on (50, 50); legs start one gap lower.
function parts(size = 'regular') {
    const v = MASTERS[size], a = 50 - v.r, b = 50 + v.r, h = v.sw / 2;
    return {
        sw: v.sw,
        dome: `M${f(a)} 50A${f(v.r)} ${f(v.r)} 0 0 1 ${f(b)} 50`,
        legs: `M${f(a)} ${f(50 + v.gap)}V${f(v.long)}M${f(b)} ${f(50 + v.gap)}V${f(v.short)}`,
        caps: [[f(a), f(v.long), f(h)], [f(b), f(v.short), f(h)]],
        box: { x0: f(50 - v.r - h), y0: f(50 - v.r - h), x1: f(50 + v.r + h), y1: f(v.long + h) }
    };
}
// Transform that centres a master's glyph on (cx, cy) inside the 100 grid.
function placement(size = 'regular', cx = 50, cy = 51) {
    const v = MASTERS[size], p = parts(size), s = v.scale;
    const tx = cx - ((p.box.x0 + p.box.x1) / 2) * s, ty = cy - ((p.box.y0 + p.box.y1) / 2) * s;
    return `translate(${f(tx)} ${f(ty)}) scale(${s})`;
}
function glyphLocal(size, dome, legs) {
    const p = parts(size);
    return `<path class="nd-dome" ${stroke(dome, p.sw, 'butt')} d="${p.dome}"/>` +
        `<g class="nd-legs"><path ${stroke(legs, p.sw, 'butt')} d="${p.legs}"/>` +
        p.caps.map(([cx, cy, r]) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${legs}"/>`).join('') + '</g>';
}
function rimPath(size) {
    const w = MASTERS[size].rim.width;
    return squircle(w / 2, w / 2, 100 - w);
}
function mark({ size = 'regular', tile = logo.tile, dome = logo.dome, legs = logo.legs, rim = true } = {}) {
    const v = MASTERS[size];
    const edge = rim ? `<path fill="none" stroke="${v.rim.color}" stroke-width="${v.rim.width}" d="${rimPath(size)}"/>` : '';
    return `<path fill="${tile}" d="${TILE}"/>${edge}<g transform="${placement(size)}">${glyphLocal(size, dome, legs)}</g>`;
}
// One colour, no tile: single-colour print, embossing, silkscreen.
function mono(color = 'currentColor', size = 'regular') {
    return `<g transform="${placement(size)}">${glyphLocal(size, color, color)}</g>`;
}
// Two-tone lamp without its tile, placed on the 100 grid (only correct on Chip Ink backgrounds).
function bare({ size = 'regular', dome = logo.dome, legs = logo.legs } = {}) {
    return `<g transform="${placement(size)}">${glyphLocal(size, dome, legs)}</g>`;
}
// Bare lamp cropped to its own bounds: the dark IDE toolbar (legs follow the text colour).
function toolbarGlyph(size = 'small') {
    const p = parts(size), pad = 1;
    const box = `${f(p.box.x0 - pad)} ${f(p.box.y0 - pad)} ${f(p.box.x1 - p.box.x0 + 2 * pad)} ${f(p.box.y1 - p.box.y0 + 2 * pad)}`;
    return { box, body: glyphLocal(size, logo.dome, 'currentColor') };
}

// ---------- app icons ----------
// macOS (Big Sur and later) template: 1024 canvas, 824 body. Windows / web: tile at 92 % of the canvas.
function appIconMac(size = 'regular') {
    return `<g transform="translate(100 100) scale(8.24)">${mark({ size })}</g>`;
}
function appIconSquare(size = 'regular') {
    return `<g transform="translate(4 4) scale(.92)">${mark({ size })}</g>`;
}

// ---------- lockups ----------
// Lockups always carry the tile: a bare lamp beside the wordmark reads as an extra letter n.
const GAP = 26;
const LOCKUP_W = 100 + GAP + WORD.width;
function lockup(wordColor = 'currentColor') {
    return `${mark()}<g transform="translate(${100 + GAP} 0)">${wordmark(wordColor)}</g>`;
}
// The Chinese name is typeset; outline it with an open-licensed face (Source Han Sans SC) before print use.
const CJK = "'Source Han Sans SC','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";
const BILINGUAL_W = LOCKUP_W + 36 + 118;
function bilingual(wordColor = 'currentColor', cjkColor = wordColor) {
    const x = LOCKUP_W + 36;
    return `${lockup(wordColor)}<rect x="${x - 18}" y="40" width="2.5" height="46" rx="1.25" fill="${cjkColor}" opacity=".32"/>` +
        `<text x="${x}" y="86" font-family="${CJK}" font-weight="600" font-size="58" fill="${cjkColor}">见微</text>`;
}

function svg(body, { box = '0 0 100 100', title = 'Nodu' } = {}) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
}

module.exports = {
    f, SW, WORD, wordmarkElements, wordmark, squircle, TILE, MASTERS, parts, placement, rimPath,
    mark, mono, bare, toolbarGlyph, appIconMac, appIconSquare, GAP, LOCKUP_W, lockup, CJK, BILINGUAL_W, bilingual, svg, stroke
};
