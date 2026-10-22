// Nodu redesign proposal (2026-10-21): every colour token, plus WCAG 2.x contrast helpers.
// Single source of truth for boards/ and palette/ (the preview page). Values are hand-tuned; the page
// build re-checks every text pair against its target and reports failures.
'use strict';

// ---------- core brand ----------
// Names describe the material they come from: a board, its silkscreen, a chip, a lit LED.
const core = {
    blue: { hex: '#2F5BFF', name: 'Nodu 蓝', en: 'Nodu Blue', role: '主要动作、焦点、选中、进度、活动标记' },
    gold: { hex: '#FFC23D', name: '点亮黄', en: 'Blink Yellow', role: '标志灯罩、首次点亮等品牌时刻；只放在芯片墨上' },
    ink: { hex: '#14171C', name: '芯片墨', en: 'Chip Ink', role: '标志板体、深色工作台、浅底文字' },
    paper: { hex: '#F6F5F0', name: '丝印白', en: 'Silk White', role: '浅色工作台、文档与官网阅读面、深底文字' }
};

// ---------- primary families ----------
// Each family: a 50-900 ramp plus per-theme roles. `current` reproduces the shipped 0.1.4 roles
// (dark button with ink text, light button on the deep blue) on the new neutrals, for comparison only.
const palettes = {
    board: {
        name: '电路板', tag: '推荐', summary: '更深更饱和的 Nodu 蓝，白字按钮两套主题通用。',
        ramp: [['50', '#EEF2FF'], ['100', '#DCE4FF'], ['200', '#BAC9FF'], ['300', '#8FA8FF'], ['400', '#5F82FF'],
            ['500', '#2F5BFF'], ['600', '#2449DB'], ['700', '#1C38AD'], ['800', '#172C82'], ['900', '#121F57']],
        dark: { primary: '#2F5BFF', onPrimary: '#FFFFFF', hover: '#3F68FF', active: '#2449DB', accent: '#8FA8FF', marker: '#2F5BFF', busy: '#5F82FF' },
        light: { primary: '#2F5BFF', onPrimary: '#FFFFFF', hover: '#2449DB', active: '#1C38AD', accent: '#2449DB', marker: '#2F5BFF', busy: '#2449DB', selection: '#DCE4FF', soft: '#EEF2FF' }
    },
    indigo: {
        name: '靛蓝', tag: '备选', summary: '偏紫的靛蓝，辨识度更高；深底标记需要换用 400。',
        ramp: [['50', '#EEEEFE'], ['100', '#DFDEFD'], ['200', '#C3C0FB'], ['300', '#A9A4FF'], ['400', '#7D75F2'],
            ['500', '#5046E5'], ['600', '#4239CF'], ['700', '#3B32B5'], ['800', '#2D2789'], ['900', '#1E1A5C']],
        // 500 on ink is only 2.9:1, so the dark-theme button steps up to a lighter indigo.
        dark: { primary: '#5D54EC', onPrimary: '#FFFFFF', hover: '#6860EF', active: '#5046E5', accent: '#A9A4FF', marker: '#7D75F2', busy: '#7D75F2' },
        light: { primary: '#5046E5', onPrimary: '#FFFFFF', hover: '#4239CF', active: '#3B32B5', accent: '#4239CF', marker: '#5046E5', busy: '#4239CF', selection: '#DFDEFD', soft: '#EEEEFE' }
    },
    current: {
        name: '现行蓝', tag: '对照', summary: '0.1.4 已发布的主色角色，只替换主色、沿用新中性色，用来对比。',
        ramp: [['50', '#F1F5FF'], ['100', '#E8EEFF'], ['200', '#C9D7FF'], ['300', '#8EACFF'], ['400', '#6F94FF'],
            ['500', '#4F7CFF'], ['600', '#3A64E0'], ['700', '#244BB0'], ['800', '#1C3A87'], ['900', '#142A5E']],
        dark: { primary: '#4F7CFF', onPrimary: '#101827', hover: '#8EACFF', active: '#3A64E0', accent: '#8EACFF', marker: '#4F7CFF', busy: '#6F94FF' },
        light: { primary: '#244BB0', onPrimary: '#FFFFFF', hover: '#4F7CFF', active: '#1C3A87', accent: '#244BB0', marker: '#244BB0', busy: '#244BB0', selection: '#C9D5F2', soft: '#E8EEFF' }
    }
};

// ---------- signal: Blink Yellow ----------
// 500 and darker drift into amber; they are for print / illustration, never for UI state.
const signalRamp = [['50', '#FFF9EB'], ['100', '#FFF1C7'], ['200', '#FFE494'], ['300', '#FFD566'], ['400', '#FFC23D'],
    ['500', '#F2A914'], ['600', '#C98A00'], ['700', '#9C6A00'], ['800', '#6E4B00'], ['900', '#4A3200']];

// ---------- workbench neutrals ----------
// Dark: cool graphite on the blue hue (the SCOPE-era teal tint removed). Light: warm paper.
const neutrals = {
    dark: {
        canvas: '#0F1115', editor: '#14171C', panel: '#181B21', surface: '#1D2027', raised: '#23272F', hover: '#2A2F38',
        border: '#343A45', borderStrong: '#646D7C', input: '#14171C',
        text: '#E7EAEF', textSecondary: '#B9C0CB', textMuted: '#949CAA', textDisabled: '#6E7684', terminal: '#181B21'
    },
    light: {
        canvas: '#E3E0D6', editor: '#F6F5F0', panel: '#EFEDE6', surface: '#E7E4DB', raised: '#DDD9CE', hover: '#E4E1D7',
        border: '#D8D4C8', borderStrong: '#8A867A', input: '#FFFFFF',
        text: '#1D2129', textSecondary: '#3E434C', textMuted: '#5B616C', textDisabled: '#A3A7AE', terminal: '#FAF9F5'
    }
};
// Legacy arrays used by the review boards.
const dark = [['canvas', '#0F1115'], ['editor', '#14171C'], ['panel', '#181B21'], ['surface', '#1D2027'], ['raised', '#23272F'],
    ['hover', '#2A2F38'], ['border', '#343A45'], ['input', '#646D7C'], ['muted', '#949CAA'], ['text', '#E7EAEF']];
const light = [['editor', '#F6F5F0'], ['panel', '#EFEDE6'], ['surface', '#E7E4DB'], ['border', '#D8D4C8'],
    ['input', '#FFFFFF'], ['muted', '#5B616C'], ['text', '#1D2129']];

// ---------- status ----------
// "Connecting / busy" follows the palette's `busy` role (primary family), so amber only ever means risk.
const status = [
    { key: 'idle', name: '未连接', dark: '#7D8594', light: '#6C727D', note: '灰点 + 虚线边框' },
    { key: 'busy', name: '连接中 / 进行中', dark: '#5F82FF', light: '#2449DB', note: '主色，脉冲动画（新）' },
    { key: 'ok', name: '已连接 / 运行中', dark: '#45C486', light: '#187244', note: '绿色' },
    { key: 'warn', name: '警告 / 写入中勿断电', dark: '#F0A43A', light: '#8A5200', note: '琥珀，只表示风险' },
    { key: 'error', name: '错误 / 停止', dark: '#F2706A', light: '#B42F27', note: '红色' }
];

// ---------- code ----------
// Syntax keeps its own meaning (the Semantic Color Rule): only comments and plain text move to the new neutrals.
const syntax = {
    dark: {
        comment: '#8A93A2', keyword: '#84B7DB', string: '#AAC78C', number: '#D4A47C',
        function: '#99DBC9', type: '#84B7DB', variable: '#E7EAEF', punctuation: '#B9C0CB'
    },
    light: {
        comment: '#656C78', keyword: '#244BB0', string: '#3D7A44', number: '#946419',
        function: '#1F7A63', type: '#244BB0', variable: '#1D2129', punctuation: '#3E434C'
    }
};
const ansiNames = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
const ansi = {
    dark: ['#23272F', '#F2706A', '#A8CE8A', '#E6C07B', '#7EA6F2', '#C79BF2', '#6CCFC0', '#C9CED6',
        '#646D7C', '#FF8F88', '#BFE3A2', '#FFD37A', '#9DBBFF', '#DDB7FF', '#8EE3D6', '#F2F4F7'],
    light: ['#1D2129', '#B42F27', '#187244', '#8A5200', '#2449DB', '#8A3FB0', '#17717A', '#5B616C',
        '#4A505B', '#C9372E', '#1E7A4A', '#7A4A00', '#2F5BFF', '#9D4FC4', '#146A72', '#6A707B']
};

// Comparison palettes shown on the review boards.
const alternatives = [
    { id: 'board', name: '电路板（推荐）', brand: '#2F5BFF', onDark: '#8FA8FF', deep: '#2449DB', signal: '#FFC23D' },
    { id: 'indigo', name: '靛蓝（备选）', brand: '#5046E5', onDark: '#A9A4FF', deep: '#3B32B5', signal: '#FFC23D' },
    // Current shipped palette: no signal colour; the dark-theme primary button uses #101827 text.
    { id: 'current', name: '现行蓝（对照）', brand: '#4F7CFF', onDark: '#8EACFF', deep: '#244BB0', soft: '#E8EEFF', buttonText: '#101827' }
];
const blueRamp = palettes.board.ramp;

// ---------- colour maths ----------
function rgb(hex) {
    const n = parseInt(hex.slice(1, 7), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toHex = c => `#${c.map(v => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
// Alpha-composite `fg` at `alpha` over an opaque `bg` (sRGB, as browsers do).
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
const ratio = (a, b) => `${contrast(a, b).toFixed(1)}:1`;

module.exports = {
    core, palettes, signalRamp, neutrals, status, syntax, ansi, ansiNames,
    blueRamp, dark, light, alternatives, rgb, toHex, mix, luminance, contrast, ratio
};
