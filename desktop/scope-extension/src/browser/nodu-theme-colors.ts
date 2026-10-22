// SPDX-License-Identifier: MIT
// Theia / Monaco colour maps for the two Nodu themes, built only from brand tokens (nodu-brand.ts).
// Kept free of Theia imports so test/brand-theme.cjs can check every value in plain Node.
import { NODU_ANSI, NODU_COLORS, NODU_FIND_MATCH, NODU_NEUTRALS, NODU_SYNTAX, NoduThemeType } from './nodu-brand';

/** '#RRGGBB' plus an opacity (0-1) as '#RRGGBBAA'. */
export function alpha(hex: string, opacity: number): string {
    return `${hex.slice(0, 7)}${Math.round(opacity * 255).toString(16).padStart(2, '0').toUpperCase()}`;
}

/** Opaque sRGB mix of `fg` over `bg`, as a browser composites `fg` at `amount` opacity. */
export function mix(fg: string, bg: string, amount: number): string {
    const parse = (hex: string) => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
    const a = parse(fg), b = parse(bg);
    return `#${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount)).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const ANSI_KEYS = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'];

/** Workbench colours by VS Code / Theia colour ID. Both themes define exactly the same keys. */
export function workbenchColors(type: NoduThemeType): Record<string, string> {
    const c = NODU_COLORS[type], n = NODU_NEUTRALS[type], syn = NODU_SYNTAX[type], find = NODU_FIND_MATCH[type];
    const dark = type === 'dark';
    // Neutral steps that differ by theme: dark rows lift towards light, light rows sink towards ink.
    const rowHover = dark ? c.raised : c.hover;
    const rowInactive = dark ? c.hover : c.raised;
    const chrome = dark ? c.editor : c.surface;
    const secondaryHover = mix(c.text, c.raised, 0.08);
    const ansi: Record<string, string> = {};
    NODU_ANSI[type].forEach((hex, i) => { ansi[`terminal.ansi${i >= 8 ? 'Bright' : ''}${ANSI_KEYS[i % 8]}`] = hex; });
    return {
        'foreground': c.text,
        'descriptionForeground': c['text-muted'],
        'disabledForeground': c['text-disabled'],
        'focusBorder': c.focus,
        'errorForeground': c.error,
        'textLink.foreground': c.accent,
        'textLink.activeForeground': c['accent-hover'],
        'textBlockQuote.background': c.surface,
        'textBlockQuote.border': c.border,
        'textCodeBlock.background': c.surface,
        'textPreformat.foreground': syn.string,
        'textSeparator.foreground': c.border,
        'icon.foreground': c['text-muted'],
        'widget.shadow': dark ? '#0000004D' : alpha(c.ink, 0.15),
        'activityBar.background': chrome,
        'activityBar.foreground': c.text,
        'activityBar.inactiveForeground': c['text-disabled'],
        'activityBar.border': c.border,
        'activityBar.activeBorder': c.marker,
        'activityBarBadge.background': c.primary,
        'activityBarBadge.foreground': c['on-primary'],
        'sideBar.background': c.panel,
        'sideBar.foreground': c['text-2'],
        'sideBar.border': c.border,
        'sideBarTitle.foreground': c.text,
        'sideBarSectionHeader.background': c.surface,
        'sideBarSectionHeader.foreground': c['text-2'],
        'sideBarSectionHeader.border': c.border,
        'editor.background': c.editor,
        'editor.foreground': c.text,
        'editor.selectionBackground': alpha(c.primary, dark ? 0.32 : 0.18),
        'editor.inactiveSelectionBackground': rowInactive,
        'editor.selectionHighlightBackground': alpha(c.primary, dark ? 0.16 : 0.12),
        'editor.lineHighlightBackground': c.panel,
        'editor.lineHighlightBorder': c.panel,
        'editorCursor.foreground': c.accent,
        'editorLineNumber.foreground': c['text-disabled'],
        'editorLineNumber.activeForeground': c['text-2'],
        'editorIndentGuide.background1': dark ? c.raised : c.border,
        'editorIndentGuide.activeBackground1': mix(n.borderStrong, c.editor, 0.6),
        'editorWhitespace.foreground': c.border,
        'editorGutter.background': c.editor,
        'editorBracketMatch.background': alpha(c.primary, dark ? 0.16 : 0.12),
        'editorBracketMatch.border': c.accent,
        'editor.findMatchBackground': find.match,
        'editor.findMatchHighlightBackground': find.highlight,
        'editorError.foreground': c.error,
        'editorWarning.foreground': c.warn,
        'editorInfo.foreground': c.accent,
        'editorGroup.border': c.border,
        'editorGroupHeader.tabsBackground': c.panel,
        'editorGroupHeader.tabsBorder': c.border,
        'editorWidget.background': c.surface,
        'editorWidget.foreground': c.text,
        'editorWidget.border': c.border,
        'tab.activeBackground': c.editor,
        'tab.activeForeground': c.text,
        'tab.inactiveBackground': c.panel,
        'tab.inactiveForeground': c['text-muted'],
        'tab.border': c.border,
        'tab.activeBorderTop': c.marker,
        'tab.unfocusedActiveBorderTop': alpha(c.marker, 0.5),
        'tab.hoverBackground': rowHover,
        'panel.background': c.panel,
        'panel.border': c.border,
        'panelTitle.activeForeground': c.text,
        'panelTitle.activeBorder': c.marker,
        'panelTitle.inactiveForeground': c['text-muted'],
        'panelSectionHeader.background': c.surface,
        'titleBar.activeBackground': c.surface,
        'titleBar.activeForeground': c.text,
        'titleBar.inactiveBackground': c.panel,
        'titleBar.inactiveForeground': c['text-muted'],
        'titleBar.border': c.border,
        'menubar.selectionBackground': rowInactive,
        'menubar.selectionForeground': c.text,
        'menu.background': c.surface,
        'menu.foreground': c.text,
        'menu.border': c.border,
        'menu.selectionBackground': rowInactive,
        'menu.selectionForeground': c.text,
        'menu.separatorBackground': c.border,
        'statusBar.background': c.surface,
        'statusBar.foreground': c['text-2'],
        'statusBar.border': c.border,
        'statusBar.noFolderBackground': c.surface,
        'statusBar.debuggingBackground': c.soft,
        'statusBarItem.hoverBackground': rowInactive,
        'statusBarItem.prominentBackground': c.soft,
        'statusBarItem.remoteBackground': c.soft,
        'statusBarItem.remoteForeground': c.accent,
        'list.activeSelectionBackground': c.selection,
        'list.activeSelectionForeground': c.text,
        'list.inactiveSelectionBackground': rowInactive,
        'list.inactiveSelectionForeground': c['text-2'],
        'list.focusBackground': c.selection,
        'list.focusForeground': c.text,
        'list.focusOutline': c.focus,
        'list.hoverBackground': rowHover,
        'list.hoverForeground': c.text,
        'list.highlightForeground': c.accent,
        'list.dropBackground': c.soft,
        'tree.indentGuidesStroke': c.border,
        'input.background': c.input,
        'input.foreground': c.text,
        'input.border': c['border-strong'],
        'input.placeholderForeground': c['text-muted'],
        'inputOption.activeBackground': c.soft,
        'inputOption.activeBorder': c.focus,
        'inputOption.activeForeground': c.text,
        'inputValidation.errorBorder': c.error,
        'inputValidation.errorBackground': c['error-bg'],
        'inputValidation.warningBorder': c.warn,
        'inputValidation.warningBackground': c['warn-bg'],
        'inputValidation.infoBorder': c.busy,
        'inputValidation.infoBackground': c['busy-bg'],
        'dropdown.background': dark ? c.surface : c.input,
        'dropdown.foreground': c.text,
        'dropdown.border': c['border-strong'],
        'button.background': c.primary,
        'button.foreground': c['on-primary'],
        'button.hoverBackground': c['primary-hover'],
        'button.secondaryBackground': c.raised,
        'button.secondaryForeground': c.text,
        'button.secondaryHoverBackground': secondaryHover,
        'badge.background': c.raised,
        'badge.foreground': c.text,
        'progressBar.background': c.busy,
        'quickInput.background': c.surface,
        'quickInput.foreground': c.text,
        'quickInputTitle.background': c.raised,
        'notificationCenterHeader.background': c.raised,
        'notifications.background': c.surface,
        'notifications.foreground': c.text,
        'notifications.border': c.border,
        'notificationsErrorIcon.foreground': c.error,
        'notificationsWarningIcon.foreground': c.warn,
        'notificationsInfoIcon.foreground': c.accent,
        'scrollbarSlider.background': alpha(c['text-muted'], 0.19),
        'scrollbarSlider.hoverBackground': alpha(c['text-muted'], 0.31),
        'scrollbarSlider.activeBackground': alpha(c['text-muted'], 0.44),
        'terminal.background': c.terminal,
        'terminal.foreground': c['text-2'],
        'terminalCursor.foreground': c.accent,
        'terminal.selectionBackground': alpha(c.primary, dark ? 0.32 : 0.18),
        ...ansi
    };
}

/** Monaco token colours. Syntax keeps its own meaning and never follows the brand colours. */
export function editorTokenRules(type: NoduThemeType): { scope: string[]; settings: { foreground: string } }[] {
    const syn = NODU_SYNTAX[type];
    return [
        { scope: ['comment', 'comment.line', 'comment.block'], settings: { foreground: syn.comment } },
        { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: syn.keyword } },
        { scope: ['string', 'string.quoted'], settings: { foreground: syn.string } },
        { scope: ['constant.numeric', 'constant.language'], settings: { foreground: syn.number } },
        { scope: ['entity.name.function', 'support.function'], settings: { foreground: syn.function } },
        { scope: ['entity.name.type', 'support.type'], settings: { foreground: syn.type } },
        { scope: ['variable', 'variable.parameter'], settings: { foreground: syn.variable } },
        { scope: ['punctuation', 'meta.brace'], settings: { foreground: syn.punctuation } }
    ];
}

export interface NoduColorDefault {
    id: string;
    description: string;
    defaults: { dark: string; light: string; hcDark: string; hcLight: string };
}

/**
 * Colours registered under `scope.*` (CSS: --theia-scope-*). Custom panels use these instead of
 * borrowing unrelated IDs such as terminal green, so they follow the brand under any theme.
 */
export function scopeColorDefaults(): NoduColorDefault[] {
    const d = NODU_COLORS.dark, l = NODU_COLORS.light;
    const both = (key: keyof typeof d, hcDark: string = d[key], hcLight: string = l[key]) => ({ dark: d[key], light: l[key], hcDark, hcLight });
    return [
        { id: 'scope.accent', description: 'Nodu 强调色：链接、焦点与选中标记。', defaults: both('accent') },
        { id: 'scope.accentBackground', description: 'Nodu 柔和强调底：状态与选中项。', defaults: both('soft', d.selection, l.soft) },
        { id: 'scope.mutedForeground', description: 'Nodu 面板的次要文字。', defaults: both('text-muted', '#FFFFFF', l.text) },
        { id: 'scope.canvasBackground', description: 'Nodu 画面与合成帧的画布背景。', defaults: both('canvas', '#000000', '#FFFFFF') },
        { id: 'scope.idle', description: 'Nodu 状态：未连接。', defaults: both('idle') },
        { id: 'scope.busy', description: 'Nodu 状态：连接中 / 进行中（主色族）。', defaults: both('busy') },
        { id: 'scope.ok', description: 'Nodu 状态：已连接 / 成功。', defaults: both('ok') },
        { id: 'scope.warn', description: 'Nodu 状态：风险，例如写入中勿断电。', defaults: both('warn') },
        { id: 'scope.signal', description: 'Nodu 点亮黄：只用于标志与学习里程碑，放在芯片墨上。', defaults: both('signal') }
    ];
}
