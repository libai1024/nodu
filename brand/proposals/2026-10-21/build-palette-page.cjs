// Generates the colour preview page's data files from palette.cjs and geometry.cjs:
//   palette/tokens.css   CSS custom properties for every palette x theme
//   palette/tokens.js    the same data plus logo SVGs for palette.js
//   palette/tokens.json  exportable token set
//   palette/favicon.svg  app icon
// Then checks every text / UI pair against WCAG targets. Run: node brand/proposals/2026-10-21/build-palette-page.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const G = require('./geometry.cjs');
const P = require('./palette.cjs');

const OUT = path.join(__dirname, 'palette');
fs.mkdirSync(OUT, { recursive: true });

const THEMES = ['light', 'dark'];
const STATUS_KEYS = ['idle', 'ok', 'warn', 'error'];
// Opacity of status / busy tints over the surface they sit on.
const TINT = { dark: 0.14, light: 0.1 };

// ---------- token resolution ----------
function themeTokens(theme) {
    const n = P.neutrals[theme];
    const t = {
        canvas: n.canvas, editor: n.editor, panel: n.panel, surface: n.surface, raised: n.raised, hover: n.hover,
        border: n.border, 'border-strong': n.borderStrong, input: n.input,
        text: n.text, 'text-2': n.textSecondary, 'text-muted': n.textMuted, 'text-disabled': n.textDisabled, terminal: n.terminal
    };
    // Status: dot / icon / status-text colour plus a tint for banners and pills.
    const base = theme === 'dark' ? n.surface : n.editor;
    for (const s of P.status.filter(s => STATUS_KEYS.includes(s.key))) {
        t[s.key] = s[theme];
        t[`${s.key}-bg`] = P.mix(s[theme], base, TINT[theme]);
    }
    // Blink Yellow: brand-only tint for learning milestones.
    t['signal-bg'] = theme === 'dark' ? P.mix(P.core.gold.hex, n.surface, 0.14) : '#FFF1C7';
    for (const [k, v] of Object.entries(P.syntax[theme])) t[`syn-${k}`] = v;
    P.ansi[theme].forEach((v, i) => { t[`ansi-${i}`] = v; });
    return t;
}
function paletteTokens(id, theme) {
    const p = P.palettes[id], r = p[theme], n = P.neutrals[theme];
    const dark = theme === 'dark';
    return {
        primary: r.primary, 'on-primary': r.onPrimary, 'primary-hover': r.hover, 'primary-active': r.active,
        accent: r.accent, focus: r.accent, marker: r.marker, busy: r.busy,
        'busy-bg': P.mix(r.busy, dark ? n.surface : n.editor, TINT[theme]),
        selection: dark ? P.mix(r.marker, n.panel, 0.24) : r.selection,
        'editor-selection': P.mix(r.primary, n.editor, dark ? 0.32 : 0.18),
        soft: dark ? P.mix(r.primary, n.surface, 0.18) : r.soft
    };
}
const constants = {
    'brand-blue': P.core.blue.hex, signal: P.core.gold.hex, 'on-signal': P.core.ink.hex, ink: P.core.ink.hex, paper: P.core.paper.hex
};
const resolve = (id, theme) => ({ ...constants, ...themeTokens(theme), ...paletteTokens(id, theme) });

// ---------- contrast targets ----------
// [label, foreground token, background token, minimum]; 4.5 = AA text, 3 = UI components / large text.
function checks(t, theme) {
    const list = [
        ['正文 / 编辑区', 'text', 'editor', 4.5], ['正文 / 面板', 'text', 'panel', 4.5], ['正文 / 表面', 'text', 'surface', 4.5],
        ['次要文字 / 编辑区', 'text-2', 'editor', 4.5], ['弱化文字 / 编辑区', 'text-muted', 'editor', 4.5],
        ['弱化文字 / 面板', 'text-muted', 'panel', 4.5], ['弱化文字 / 表面', 'text-muted', 'surface', 4.5],
        ['强调文字与链接 / 编辑区', 'accent', 'editor', 4.5], ['强调文字与链接 / 面板', 'accent', 'panel', 4.5],
        ['强调文字与链接 / 表面', 'accent', 'surface', 4.5],
        ['主按钮文字 / 主按钮', 'on-primary', 'primary', 4.5], ['主按钮文字 / 悬停', 'on-primary', 'primary-hover', 4.5],
        ['主按钮文字 / 按下', 'on-primary', 'primary-active', 4.5],
        ['选中行文字 / 选中底', 'text', 'selection', 4.5], ['编辑区选区文字 / 选区', 'text', 'editor-selection', 4.5],
        ['里程碑文字 / 点亮黄底', 'text', 'signal-bg', 4.5],
        // Busy text uses the accent; the busy colour itself is reserved for dots, spinners and progress.
        ['进行中文字 / 进行中底', 'accent', 'busy-bg', 4.5],
        ...STATUS_KEYS.filter(k => k !== 'idle').map(k => [`${k} 状态文字 / ${k} 底`, k, `${k}-bg`, 4.5]),
        ['活动标记 / 编辑区', 'marker', 'editor', 3], ['活动标记 / 面板', 'marker', 'panel', 3],
        ['焦点环 / 编辑区', 'focus', 'editor', 3], ['焦点环 / 表面', 'focus', 'surface', 3],
        ['输入框边框 / 输入底', 'border-strong', 'input', 3], ['输入框边框 / 面板', 'border-strong', 'panel', 3],
        ['主按钮 / 编辑区', 'primary', 'editor', 3],
        ...['idle', 'busy', 'ok', 'warn', 'error'].map(k => [`${k} 状态点 / 表面`, k, 'surface', 3])
    ];
    for (const k of Object.keys(P.syntax[theme])) list.push([`语法 ${k} / 编辑区`, `syn-${k}`, 'editor', 4.5]);
    // ANSI 0 / 8 are background-ish greys and exempt; the rest are foreground text colours.
    for (let i = 1; i < 16; i++) if (i !== 8) list.push([`ANSI ${i} / 终端`, `ansi-${i}`, 'terminal', 4.5]);
    return list.map(([label, fg, bg, min]) => {
        const value = P.contrast(t[fg], t[bg]);
        return { label, fg, bg, min, value: Number(value.toFixed(2)), pass: value >= min };
    });
}

// ---------- outputs ----------
const combos = [];
for (const id of Object.keys(P.palettes)) for (const theme of THEMES) combos.push({ id, theme, tokens: resolve(id, theme) });

const vars = obj => Object.entries(obj).map(([k, v]) => `  --nd-${k}: ${v};`).join('\n');
let css = `/* Generated by build-palette-page.cjs from palette.cjs. Do not edit by hand. */\n:root {\n${vars(constants)}\n}\n`;
for (const theme of THEMES) css += `:root[data-theme="${theme}"] {\n  color-scheme: ${theme};\n${vars(themeTokens(theme))}\n}\n`;
for (const { id, theme } of combos) css += `:root[data-palette="${id}"][data-theme="${theme}"] {\n${vars(paletteTokens(id, theme))}\n}\n`;
fs.writeFileSync(path.join(OUT, 'tokens.css'), css);

const L = `0 0 ${G.LOCKUP_W} 100`, B = `0 0 ${G.BILINGUAL_W} 100`;
const tight = G.blinkTight({ legs: 'currentColor' });
const logos = {
    mark: G.svg(G.blinkMark(), { title: 'Nodu 标志' }),
    markSmall: G.svg(G.blinkMark({ size: 'small' }), { title: 'Nodu 标志（小尺寸母版）' }),
    appIcon: G.svg(G.blinkAppIcon(), { box: '0 0 1024 1024', title: 'Nodu 应用图标' }),
    toolbar: G.svg(tight.body, { box: tight.box, title: 'Nodu' }),
    mono: G.svg(G.blinkMono('currentColor'), { title: 'Nodu 单色标志' }),
    unlit: G.svg(G.blinkGlyph({ dome: 'currentColor', legs: 'currentColor' }), { title: 'Nodu 单色标志' }),
    wordmark: G.svg(G.wordmark('currentColor'), { box: `0 0 ${G.WORD.width} 100`, title: 'nodu 字标' }),
    lockup: G.svg(G.lockup(G.blinkMark(), 'currentColor'), { box: L, title: 'Nodu' }),
    lockupLight: G.svg(G.blinkLockup('#14171C'), { box: L, title: 'Nodu 横向组合（浅底）' }),
    lockupDark: G.svg(G.blinkLockup('#FFFFFF'), { box: L, title: 'Nodu 横向组合（深底）' }),
    bilingual: G.svg(G.bilingual(G.blinkMark(), 'currentColor', 'currentColor'), { box: B, title: 'Nodu · 见微' }),
    misuseOnPaper: G.svg(G.blinkGlyph(), { title: '错误示例：点亮黄直接放在浅底上' }),
    misuseGreen: G.svg(G.blinkMark({ dome: '#45C486' }), { title: '错误示例：灯罩改成绿色' }),
    misuseGlow: G.svg(`<defs><filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs><g filter="url(#glow)">${G.blinkMark()}</g>`, { title: '错误示例：给标志加发光' })
};
const data = {
    generated: '2026-10-21',
    direction: { id: '02', name: '点亮', en: 'Blink' },
    core: P.core,
    palettes: Object.fromEntries(Object.entries(P.palettes).map(([id, p]) => [id, { name: p.name, tag: p.tag, summary: p.summary, ramp: p.ramp }])),
    signalRamp: P.signalRamp,
    neutrals: P.neutrals,
    status: P.status,
    syntax: P.syntax,
    ansi: P.ansi,
    ansiNames: P.ansiNames,
    tokens: Object.fromEntries(Object.keys(P.palettes).map(id => [id, Object.fromEntries(THEMES.map(th => [th, resolve(id, th)]))])),
    checks: Object.fromEntries(Object.keys(P.palettes).map(id => [id, Object.fromEntries(THEMES.map(th => [th, checks(resolve(id, th), th)]))])),
    logos
};
fs.writeFileSync(path.join(OUT, 'tokens.js'), `// Generated by build-palette-page.cjs. Do not edit by hand.\nwindow.NODU = ${JSON.stringify(data)};\n`);
const exportable = { name: 'Nodu · 见微', version: 'proposal-2026-10-21', direction: data.direction, tokens: data.tokens, signalRamp: P.signalRamp };
fs.writeFileSync(path.join(OUT, 'tokens.json'), `${JSON.stringify(exportable, null, 2)}\n`);
fs.writeFileSync(path.join(OUT, 'favicon.svg'), logos.appIcon);

// ---------- report ----------
let failures = 0;
for (const { id, theme } of combos) {
    const bad = data.checks[id][theme].filter(c => !c.pass);
    const expected = id === 'current';
    if (!expected) failures += bad.length;
    console.log(`${id.padEnd(8)} ${theme.padEnd(5)} ${bad.length ? `${bad.length} below target${expected ? ' (reference palette, expected)' : ''}` : 'all pass'}`);
    for (const c of bad) console.log(`    ${c.label}: ${c.value}:1 < ${c.min}`);
}
if (failures) {
    console.error(`${failures} contrast failures in proposed palettes.`);
    process.exitCode = 1;
}
