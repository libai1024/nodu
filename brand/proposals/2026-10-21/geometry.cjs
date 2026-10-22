// Nodu redesign proposal (2026-10-21): original vector geometry, no fonts required for the marks.
// Marks use a 100 x 100 grid. The monoline wordmark uses baseline 90, x-height 35, stroke 13.
'use strict';

const f = v => Number(v.toFixed(2));
const SW = 13;
const H = SW / 2;

// ---------- monoline wordmark ----------
// n: stem with a short spur above the shoulder; u is the same drawing turned 180 degrees.
function nLine() {
    const a = H, b = 54 - H, r = (b - a) / 2, cy = 35 + H + r;
    return `M${f(a)} ${90 - H}V${f(37.5 + H)}M${f(a)} ${f(cy)}A${f(r)} ${f(r)} 0 0 1 ${f(b)} ${f(cy)}V${90 - H}`;
}
const BOWL_R = 28.5 - H;
const WORD = { n: 0, o: 62, d: 126, u: 194, width: 248 };

function stroke(color, width = SW, cap = 'round') {
    return `fill="none" stroke="${color}" stroke-width="${width}" stroke-linecap="${cap}" stroke-linejoin="round"`;
}
function wordmark(color = 'currentColor') {
    const o = WORD.o + 28.5, d = WORD.d + 28.5;
    return `<g ${stroke(color)}>` +
        `<path d="${nLine()}"/>` +
        `<circle cx="${o}" cy="62.5" r="${BOWL_R}"/>` +
        `<circle cx="${d}" cy="62.5" r="${BOWL_R}"/><path d="M${d + BOWL_R} ${8 + H}V${90 - H}"/>` +
        `<path transform="translate(${WORD.u} 0) rotate(180 27 62.5)" d="${nLine()}"/>` +
        `</g>`;
}

// ---------- tile ----------
function squircle(x = 0, y = 0, size = 100, exponent = 5, steps = 240) {
    const r = size / 2, cx = x + r, cy = y + r, e = 2 / exponent, pts = [];
    for (let i = 0; i < steps; i++) {
        const t = (i / steps) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
        pts.push(`${f(cx + r * Math.sign(c) * Math.abs(c) ** e)} ${f(cy + r * Math.sign(s) * Math.abs(s) ** e)}`);
    }
    return `M${pts.join('L')}Z`;
}
const TILE = squircle();

// ---------- direction 1 (recommended): Pin 1 ----------
// Tile = chip / board body, white n = silkscreen marking, gold dot = pin-1 marker and the first lit LED.
// `small` is the optical master for 16-32 px exports: heavier n, larger dot.
const PIN1 = {
    regular: { scale: 0.82, x: 29, y: 36, width: SW, dot: { cx: 22, cy: 22, r: 5.8 } },
    small: { scale: 0.8, x: 29.5, y: 37, width: 16, dot: { cx: 23, cy: 23, r: 7.6 } }
};
function pin1Glyph(color, size = 'regular') {
    const { scale, x, y, width } = PIN1[size];
    return `<g transform="translate(${x} ${f(y - 35 * scale)}) scale(${scale})"><path ${stroke(color, width)} d="${nLine()}"/></g>`;
}
function pin1Mark({ tile, glyph, dot, size = 'regular' }) {
    const { cx, cy, r } = PIN1[size].dot;
    return `<path fill="${tile}" d="${TILE}"/>${pin1Glyph(glyph, size)}<circle cx="${cx}" cy="${cy}" r="${r}" fill="${dot}"/>`;
}
// One-colour stencil: the tile takes the given colour (default currentColor); the n and the dot are cut out.
function pin1Stencil(id, color = 'currentColor', size = 'regular') {
    const { cx, cy, r } = PIN1[size].dot;
    return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100">` +
        `<rect width="100" height="100" fill="#fff"/>${pin1Glyph('#000', size)}<circle cx="${cx}" cy="${cy}" r="${r}" fill="#000"/></mask></defs>` +
        `<path mask="url(#${id})" fill="${color}" d="${TILE}"/>`;
}
// macOS Big Sur+ template: 1024 canvas, 824 body. The same artwork serves the Windows ICO.
function appIcon(colors) {
    return `<g transform="translate(100 100) scale(8.24)">${pin1Mark(colors)}</g>`;
}

// ---------- direction 2 (selected 2026-10-21): Blink (LED n) ----------
// Gold dome = the lit LED lens; legs = its leads, the anode (left) longer than the cathode.
// `regular` serves 48 px and up; `small` is the optical master for 16-32 px (heavier strokes, tighter gap).
// The rim keeps the ink tile visible on dark docks and taskbars.
const BLINK = {
    regular: { sw: 14, gap: 6, r: 19.5, long: 83, short: 74, scale: 0.84, rim: { width: 2, color: '#2A2F38' } },
    small: { sw: 17.5, gap: 4.5, r: 18.5, long: 81, short: 72, scale: 0.9, rim: { width: 3, color: '#3A404B' } }
};
const BLINK_COLORS = { tile: '#14171C', dome: '#FFC23D', legs: '#FFFFFF' };

// Local drawing: dome centred on (50, 50), cut flat at y = 50; legs start one gap lower.
// Classes let a page restyle the parts (e.g. an unlit dome) without touching geometry.
function blinkLocal(v, dome, legs) {
    const a = 50 - v.r, b = 50 + v.r, h = v.sw / 2;
    return `<path class="nd-dome" ${stroke(dome, v.sw, 'butt')} d="M${f(a)} 50A${f(v.r)} ${f(v.r)} 0 0 1 ${f(b)} 50"/>` +
        `<g class="nd-legs"><path ${stroke(legs, v.sw, 'butt')} d="M${f(a)} ${f(50 + v.gap)}V${f(v.long)}M${f(b)} ${f(50 + v.gap)}V${f(v.short)}"/>` +
        `<circle cx="${f(a)}" cy="${f(v.long)}" r="${f(h)}" fill="${legs}"/><circle cx="${f(b)}" cy="${f(v.short)}" r="${f(h)}" fill="${legs}"/></g>`;
}
function blinkBox(v) {
    return { x0: 50 - v.r - v.sw / 2, x1: 50 + v.r + v.sw / 2, y0: 50 - v.r - v.sw / 2, y1: v.long + v.sw / 2 };
}
// Glyph centred on (cx, cy) at the master's own scale (or an explicit one).
function blinkGlyph({ dome = BLINK_COLORS.dome, legs = BLINK_COLORS.legs, size = 'regular', cx = 50, cy = 51, scale } = {}) {
    const v = BLINK[size], s = scale || v.scale, box = blinkBox(v);
    const tx = cx - ((box.x0 + box.x1) / 2) * s, ty = cy - ((box.y0 + box.y1) / 2) * s;
    return `<g transform="translate(${f(tx)} ${f(ty)}) scale(${s})">${blinkLocal(v, dome, legs)}</g>`;
}
function blinkMark({ tile = BLINK_COLORS.tile, dome = BLINK_COLORS.dome, legs = BLINK_COLORS.legs, size = 'regular', rim = true } = {}) {
    const v = BLINK[size], w = v.rim.width;
    const edge = rim ? `<path fill="none" stroke="${v.rim.color}" stroke-width="${w}" d="${squircle(w / 2, w / 2, 100 - w)}"/>` : '';
    return `<path fill="${tile}" d="${TILE}"/>${edge}${blinkGlyph({ dome, legs, size })}`;
}
// One colour, no tile: for single-colour print, embossing and the light toolbar fallback.
function blinkMono(color = 'currentColor', size = 'regular') {
    return blinkGlyph({ dome: color, legs: color, size });
}
function blinkAppIcon(colors = {}) {
    return `<g transform="translate(100 100) scale(8.24)">${blinkMark(colors)}</g>`;
}
// Bare glyph cropped to its own bounds, for the dark IDE toolbar (no tile, legs follow the text colour).
function blinkTight({ dome = BLINK_COLORS.dome, legs = 'currentColor', size = 'small' } = {}) {
    const v = BLINK[size], b = blinkBox(v), pad = 1;
    return { body: blinkLocal(v, dome, legs), box: `${f(b.x0 - pad)} ${f(b.y0 - pad)} ${f(b.x1 - b.x0 + 2 * pad)} ${f(b.y1 - b.y0 + 2 * pad)}` };
}
// Lockups always carry the tile: a bare glyph beside the wordmark reads as an extra letter n.
function blinkLockup(wordColor = '#14171C') {
    return lockup(blinkMark(), wordColor);
}


// ---------- direction 3: Pulse ----------
// One digital high pulse draws the n; the dot is the output it switches on.
function pulseGlyph({ line, dot }) {
    return `<path ${stroke(line)} d="M13 70H27V33H63V70H72"/><circle cx="85" cy="70" r="7.5" fill="${dot}"/>`;
}
function pulseMark({ tile, line, dot }) {
    return `<path fill="${tile}" d="${TILE}"/><g transform="translate(9 9) scale(.82)">${pulseGlyph({ line, dot })}</g>`;
}

// ---------- lockups ----------
const GAP = 26;
const LOCKUP_W = 100 + GAP + WORD.width;
function lockup(mark, wordColor) {
    return `${mark}<g transform="translate(${100 + GAP} 0)">${wordmark(wordColor)}</g>`;
}
// Chinese name: set in an open-licensed sans (Source Han Sans SC / Noto Sans SC); outline before production use.
const CJK = "'Source Han Sans SC','Noto Sans SC','PingFang SC','Microsoft YaHei',sans-serif";
const BILINGUAL_W = LOCKUP_W + 36 + 118;
function bilingual(mark, wordColor, cjkColor) {
    const x = LOCKUP_W + 36;
    return `${lockup(mark, wordColor)}<rect x="${x - 18}" y="40" width="2.5" height="46" rx="1.25" fill="${cjkColor}" opacity=".32"/>` +
        `<text x="${x}" y="86" font-family="${CJK}" font-weight="600" font-size="58" fill="${cjkColor}">见微</text>`;
}

function svg(body, { box = '0 0 100 100', title = 'Nodu', w, h } = {}) {
    const size = w ? ` width="${w}" height="${h || w}"` : '';
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${box}"${size} role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;
}

module.exports = {
    f, SW, nLine, WORD, wordmark, squircle, TILE, PIN1, pin1Glyph, pin1Mark, pin1Stencil, appIcon,
    BLINK, BLINK_COLORS, blinkGlyph, blinkMark, blinkMono, blinkAppIcon, blinkTight, blinkLockup,
    pulseMark, GAP, LOCKUP_W, lockup, CJK, BILINGUAL_W, bilingual, svg, stroke
};
