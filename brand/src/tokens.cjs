// SPDX-License-Identifier: MIT
// Nodu · 见微 brand tokens, v2 (2026-10-21): direction 02「点亮」, primary palette 「电路板」.
// Single source of truth. brand/scripts/build.cjs derives brand/assets, brand/tokens.*, and
// desktop/scope-extension/src/browser/nodu-brand.ts from this file; desktop/scripts/check-brand.cjs
// fails when any of them drift. Change colours here, then run `node brand/scripts/build.cjs`.
'use strict';

// 2.1.0 (2026-10-22): the light theme moves from warm paper to clean white.
const version = '2.1.0';
const updated = '2026-10-22';

// ---------- core ----------
// Names describe the material they come from: a board, its silkscreen, a chip, a lit LED.
const core = {
    blue: { hex: '#2F5BFF', name: 'Nodu 蓝', en: 'Nodu Blue', role: '主要动作、焦点、选中、进度、活动标记' },
    yellow: { hex: '#FFC23D', name: '点亮黄', en: 'Blink Yellow', role: '标志灯罩与学习里程碑；只放在芯片墨上' },
    ink: { hex: '#14171C', name: '芯片墨', en: 'Chip Ink', role: '标志板体、深色工作台、浅底文字' },
    paper: { hex: '#FFFFFF', name: '丝印白', en: 'Silk White', role: '浅色工作台、文档与官网阅读面、深底文字' }
};

// ---------- ramps ----------
const blueRamp = [['50', '#EEF2FF'], ['100', '#DCE4FF'], ['200', '#BAC9FF'], ['300', '#8FA8FF'], ['400', '#5F82FF'],
    ['500', '#2F5BFF'], ['600', '#2449DB'], ['700', '#1C38AD'], ['800', '#172C82'], ['900', '#121F57']];
// 500 and darker drift into amber: print and illustration only, never UI state.
const yellowRamp = [['50', '#FFF9EB'], ['100', '#FFF1C7'], ['200', '#FFE494'], ['300', '#FFD566'], ['400', '#FFC23D'],
    ['500', '#F2A914'], ['600', '#C98A00'], ['700', '#9C6A00'], ['800', '#6E4B00'], ['900', '#4A3200']];

// ---------- primary roles per theme ----------
// primary: buttons and badges (white text on both themes); hover / active: button states;
// accent: links, focus rings, cursor, accent text; marker: active tab / view borders;
// busy: connecting and in-progress (dots, spinners, progress bars); selection: list selection (light).
const primary = {
    dark: { primary: '#2F5BFF', onPrimary: '#FFFFFF', hover: '#3F68FF', active: '#2449DB', accent: '#8FA8FF', accentHover: '#BAC9FF', marker: '#2F5BFF', busy: '#5F82FF' },
    light: { primary: '#2F5BFF', onPrimary: '#FFFFFF', hover: '#2449DB', active: '#1C38AD', accent: '#2449DB', accentHover: '#2F5BFF', marker: '#2F5BFF', busy: '#2449DB', selection: '#DCE4FF', soft: '#EEF2FF' }
};

// ---------- workbench neutrals ----------
// Dark: cool graphite on the blue hue. Light: clean white editor, inputs and overlays, with
// cool-grey chrome on Chip Ink's hue (about 218°), so the page reads white rather than paper.
const neutrals = {
    dark: {
        canvas: '#0F1115', editor: '#14171C', panel: '#181B21', surface: '#1D2027', raised: '#23272F', hover: '#2A2F38',
        border: '#343A45', borderStrong: '#646D7C', input: '#14171C',
        text: '#E7EAEF', textSecondary: '#B9C0CB', textMuted: '#949CAA', textDisabled: '#6E7684', terminal: '#181B21'
    },
    light: {
        canvas: '#E9ECF0', editor: '#FFFFFF', panel: '#F7F8FA', surface: '#F0F2F5', raised: '#E7EAEE', hover: '#EDEFF3',
        border: '#E0E3E8', borderStrong: '#868C97', input: '#FFFFFF',
        text: '#1D2129', textSecondary: '#3E434C', textMuted: '#5B616C', textDisabled: '#A3A7AE', terminal: '#FFFFFF'
    }
};

// ---------- status ----------
// Each colour says one thing. Connecting / busy uses the primary family, so amber only ever means risk.
const status = {
    idle: { name: '未连接', dark: '#7D8594', light: '#6C727D' },
    busy: { name: '连接中 / 进行中', dark: primary.dark.busy, light: primary.light.busy },
    ok: { name: '已连接 / 成功', dark: '#45C486', light: '#187244' },
    warn: { name: '风险 / 写入中勿断电', dark: '#F0A43A', light: '#8A5200' },
    error: { name: '错误 / 停止', dark: '#F2706A', light: '#B42F27' }
};
// Opacity of status tints over the surface they sit on (banners, pills).
const tint = { dark: 0.14, light: 0.1 };

// ---------- code ----------
// Syntax keeps its own meaning (the Semantic Color Rule): it never follows the brand colours.
const syntax = {
    dark: { comment: '#8A93A2', keyword: '#84B7DB', string: '#AAC78C', number: '#D4A47C', function: '#99DBC9', type: '#84B7DB', variable: '#E7EAEF', punctuation: '#B9C0CB' },
    light: { comment: '#656C78', keyword: '#244BB0', string: '#3D7A44', number: '#946419', function: '#1F7A63', type: '#244BB0', variable: '#1D2129', punctuation: '#3E434C' }
};
const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ansi = {
    dark: ['#23272F', '#F2706A', '#A8CE8A', '#E6C07B', '#7EA6F2', '#C79BF2', '#6CCFC0', '#C9CED6',
        '#646D7C', '#FF8F88', '#BFE3A2', '#FFD37A', '#9DBBFF', '#DDB7FF', '#8EE3D6', '#F2F4F7'],
    light: ['#1D2129', '#B42F27', '#187244', '#8A5200', '#2449DB', '#8A3FB0', '#17717A', '#5B616C',
        '#4A505B', '#C9372E', '#1E7A4A', '#7A4A00', '#2F5BFF', '#9D4FC4', '#146A72', '#6A707B']
};
// Editor find-match highlights stay olive / sand, independent of the brand.
const findMatch = { dark: { match: '#5A5735', highlight: '#5A573580' }, light: { match: '#F0C365', highlight: '#E9D8A6' } };

// ---------- logo colours ----------
// The dome is always Blink Yellow on Chip Ink; the rim keeps the ink tile visible on dark docks.
const logo = { tile: core.ink.hex, dome: core.yellow.hex, legs: '#FFFFFF', rim: '#2A2F38', rimSmall: '#3A404B' };

// Superseded colours. check-brand.cjs rejects them in app code: v1 (2026-10-19 blue / SCOPE mint),
// then the v2.0 warm-paper light theme (2026-10-21), replaced by clean white in v2.1.
const legacy = ['#4F7CFF', '#8EACFF', '#244BB0', '#E8EEFF', '#64C5AC', '#181D20', '#101827', '#101729', '#1C2226',
    '#20272B', '#293338', '#303C41', '#344047', '#526068', '#E8ECE9', '#A9B7B9', '#85969B', '#C6D0CD', '#263C30', '#EDF8EF',
    '#F6F5F0', '#E3E0D6', '#EFEDE6', '#E7E4DB', '#DDD9CE', '#E4E1D7', '#D8D4C8', '#8A867A', '#FAF9F5'];

// ---------- colour maths (WCAG 2.x) ----------
function rgb(hex) {
    const n = parseInt(hex.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = c => `#${c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
// Alpha-composite `fg` at `alpha` over an opaque `bg`, as browsers do in sRGB.
function mix(fg, bg, alpha) {
    const a = rgb(fg), b = rgb(bg);
    return toHex(a.map((v, i) => v * alpha + b[i] * (1 - alpha)));
}
function channel(v) {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
function luminance(hex) {
    const [r, g, b] = rgb(hex);
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
function contrast(a, b) {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

// ---------- resolved semantic tokens per theme (CSS: --nd-<key>) ----------
function resolve(theme) {
    const n = neutrals[theme], p = primary[theme], dark = theme === 'dark';
    const base = dark ? n.surface : n.editor;
    const t = {
        'brand-blue': core.blue.hex, signal: core.yellow.hex, 'on-signal': core.ink.hex, ink: core.ink.hex, paper: core.paper.hex,
        canvas: n.canvas, editor: n.editor, panel: n.panel, surface: n.surface, raised: n.raised, hover: n.hover,
        // chrome: toolbar, status bar and section headers. overlay: menus, editor widgets, quick input, notifications.
        // Dark keeps both on surface; light keeps chrome on the panel grey and floats overlays in white.
        chrome: dark ? n.surface : n.panel, overlay: dark ? n.surface : n.editor,
        border: n.border, 'border-strong': n.borderStrong, input: n.input,
        text: n.text, 'text-2': n.textSecondary, 'text-muted': n.textMuted, 'text-disabled': n.textDisabled, terminal: n.terminal,
        primary: p.primary, 'on-primary': p.onPrimary, 'primary-hover': p.hover, 'primary-active': p.active,
        accent: p.accent, 'accent-hover': p.accentHover, focus: p.accent, marker: p.marker, busy: p.busy,
        'busy-bg': mix(p.busy, base, tint[theme]),
        selection: dark ? mix(p.marker, n.panel, 0.24) : p.selection,
        'editor-selection': mix(p.primary, n.editor, dark ? 0.32 : 0.18),
        soft: dark ? mix(p.primary, n.surface, 0.18) : p.soft,
        'signal-bg': dark ? mix(core.yellow.hex, n.surface, 0.14) : yellowRamp[1][1]
    };
    for (const key of ['idle', 'ok', 'warn', 'error']) {
        t[key] = status[key][theme];
        t[`${key}-bg`] = mix(status[key][theme], base, tint[theme]);
    }
    for (const [k, v] of Object.entries(syntax[theme])) t[`syn-${k}`] = v;
    ansi[theme].forEach((v, i) => { t[`ansi-${i}`] = v; });
    return t;
}

// ---------- contrast targets ----------
// [label, fg, bg, min]: 4.5 = WCAG AA text, 3 = UI components and large text.
function checks(theme) {
    const t = resolve(theme);
    const list = [
        ['正文 / 编辑区', 'text', 'editor', 4.5], ['正文 / 面板', 'text', 'panel', 4.5], ['正文 / 表面', 'text', 'surface', 4.5],
        ['次要文字 / 编辑区', 'text-2', 'editor', 4.5], ['弱化文字 / 编辑区', 'text-muted', 'editor', 4.5],
        ['弱化文字 / 面板', 'text-muted', 'panel', 4.5], ['弱化文字 / 表面', 'text-muted', 'surface', 4.5],
        ['正文 / 界面框架', 'text', 'chrome', 4.5], ['弱化文字 / 界面框架', 'text-muted', 'chrome', 4.5],
        ['正文 / 浮层', 'text', 'overlay', 4.5], ['弱化文字 / 浮层', 'text-muted', 'overlay', 4.5],
        ['强调文字与链接 / 编辑区', 'accent', 'editor', 4.5], ['强调文字与链接 / 面板', 'accent', 'panel', 4.5],
        ['强调文字与链接 / 表面', 'accent', 'surface', 4.5],
        ['主按钮文字 / 主按钮', 'on-primary', 'primary', 4.5], ['主按钮文字 / 悬停', 'on-primary', 'primary-hover', 4.5],
        ['主按钮文字 / 按下', 'on-primary', 'primary-active', 4.5],
        ['选中行文字 / 选中底', 'text', 'selection', 4.5], ['编辑区选区文字 / 选区', 'text', 'editor-selection', 4.5],
        ['里程碑文字 / 点亮黄底', 'text', 'signal-bg', 4.5],
        ['进行中文字 / 进行中底', 'accent', 'busy-bg', 4.5],
        ['ok 状态文字 / ok 底', 'ok', 'ok-bg', 4.5], ['warn 状态文字 / warn 底', 'warn', 'warn-bg', 4.5],
        ['error 状态文字 / error 底', 'error', 'error-bg', 4.5],
        ['活动标记 / 编辑区', 'marker', 'editor', 3], ['活动标记 / 面板', 'marker', 'panel', 3],
        ['焦点环 / 编辑区', 'focus', 'editor', 3], ['焦点环 / 表面', 'focus', 'surface', 3],
        ['输入框边框 / 输入底', 'border-strong', 'input', 3], ['输入框边框 / 面板', 'border-strong', 'panel', 3],
        ['主按钮 / 编辑区', 'primary', 'editor', 3], ['主按钮 / 界面框架', 'primary', 'chrome', 3],
        ['焦点环 / 界面框架', 'focus', 'chrome', 3],
        ...['idle', 'busy', 'ok', 'warn', 'error'].map(k => [`${k} 状态点 / 表面`, k, 'surface', 3])
    ];
    for (const k of Object.keys(syntax[theme])) list.push([`语法 ${k} / 编辑区`, `syn-${k}`, 'editor', 4.5]);
    // ANSI 0 / 8 are background greys and exempt; the rest are foreground text colours.
    for (let i = 1; i < 16; i++) if (i !== 8) list.push([`ANSI ${i} / 终端`, `ansi-${i}`, 'terminal', 4.5]);
    // The logo dome is a graphic on the ink tile: 3:1.
    list.push(['标志灯罩 / 板体', 'signal', 'ink', 3]);
    return list.map(([label, fg, bg, min]) => {
        const value = contrast(t[fg], t[bg]);
        return { label, fg, bg, min, value: Number(value.toFixed(2)), pass: value >= min };
    });
}

module.exports = {
    version, updated, core, blueRamp, yellowRamp, primary, neutrals, status, tint, syntax, ansi, ansiNames, findMatch, logo, legacy,
    rgb, toHex, mix, luminance, contrast, resolve, checks
};
