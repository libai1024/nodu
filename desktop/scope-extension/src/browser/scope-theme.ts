// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ColorRegistry } from '@theia/core/lib/browser/color-registry';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { MonacoThemeRegistry } from '@theia/monaco/lib/browser/textmate/monaco-theme-registry';

export const SCOPE_THEME_ID = 'scope-dark';

/** Theme colors use supported workbench IDs, so native Theia widgets retain their layout. */
const colors: Record<string, string> = {
    'foreground': '#E8ECE9',
    'descriptionForeground': '#A9B7B9',
    'disabledForeground': '#85969B',
    'focusBorder': '#8EACFF',
    'errorForeground': '#E99893',
    'textLink.foreground': '#8EACFF',
    'textLink.activeForeground': '#E8EEFF',
    'textBlockQuote.background': '#20272B',
    'textBlockQuote.border': '#344047',
    'textCodeBlock.background': '#20272B',
    'textPreformat.foreground': '#AAC78C',
    'textSeparator.foreground': '#344047',
    'icon.foreground': '#A9B7B9',
    'widget.shadow': '#00000040',
    'activityBar.background': '#181D20',
    'activityBar.foreground': '#E8ECE9',
    'activityBar.inactiveForeground': '#85969B',
    'activityBar.border': '#344047',
    'activityBar.activeBorder': '#4F7CFF',
    'activityBarBadge.background': '#4F7CFF',
    'activityBarBadge.foreground': '#101827',
    'sideBar.background': '#1C2226',
    'sideBar.foreground': '#C6D0CD',
    'sideBar.border': '#344047',
    'sideBarTitle.foreground': '#E8ECE9',
    'sideBarSectionHeader.background': '#20272B',
    'sideBarSectionHeader.foreground': '#C6D0CD',
    'sideBarSectionHeader.border': '#344047',
    'editor.background': '#181D20',
    'editor.foreground': '#E8ECE9',
    'editor.selectionBackground': '#4F7CFF40',
    'editor.inactiveSelectionBackground': '#2A383D',
    'editor.selectionHighlightBackground': '#4F7CFF26',
    'editor.lineHighlightBackground': '#20272B',
    'editor.lineHighlightBorder': '#20272B',
    'editorCursor.foreground': '#8EACFF',
    'editorLineNumber.foreground': '#75868B',
    'editorLineNumber.activeForeground': '#C6D0CD',
    'editorIndentGuide.background1': '#293338',
    'editorIndentGuide.activeBackground1': '#526461',
    'editorWhitespace.foreground': '#344047',
    'editorGutter.background': '#181D20',
    'editorBracketMatch.background': '#4F7CFF26',
    'editorBracketMatch.border': '#8EACFF',
    'editor.findMatchBackground': '#5A5735',
    'editor.findMatchHighlightBackground': '#5A573580',
    'editorGroup.border': '#344047',
    'editorGroupHeader.tabsBackground': '#1C2226',
    'editorGroupHeader.tabsBorder': '#344047',
    'editorWidget.background': '#20272B',
    'editorWidget.foreground': '#E8ECE9',
    'editorWidget.border': '#344047',
    'tab.activeBackground': '#181D20',
    'tab.activeForeground': '#E8ECE9',
    'tab.inactiveBackground': '#1C2226',
    'tab.inactiveForeground': '#A9B7B9',
    'tab.border': '#344047',
    'tab.activeBorderTop': '#4F7CFF',
    'tab.unfocusedActiveBorderTop': '#4F7CFF80',
    'tab.hoverBackground': '#293338',
    'panel.background': '#1C2226',
    'panel.border': '#344047',
    'panelTitle.activeForeground': '#E8ECE9',
    'panelTitle.activeBorder': '#4F7CFF',
    'panelTitle.inactiveForeground': '#A9B7B9',
    'panelSectionHeader.background': '#20272B',
    'titleBar.activeBackground': '#20272B',
    'titleBar.activeForeground': '#E8ECE9',
    'titleBar.inactiveBackground': '#1C2226',
    'titleBar.inactiveForeground': '#A9B7B9',
    'titleBar.border': '#344047',
    'menubar.selectionBackground': '#293338',
    'menubar.selectionForeground': '#E8ECE9',
    'menu.background': '#20272B',
    'menu.foreground': '#E8ECE9',
    'menu.border': '#344047',
    'menu.selectionBackground': '#2A383D',
    'menu.selectionForeground': '#E8ECE9',
    'menu.separatorBackground': '#344047',
    'statusBar.background': '#20272B',
    'statusBar.foreground': '#C6D0CD',
    'statusBar.border': '#344047',
    'statusBar.noFolderBackground': '#20272B',
    'statusBar.debuggingBackground': '#244BB040',
    'statusBarItem.hoverBackground': '#303C41',
    'statusBarItem.prominentBackground': '#4F7CFF26',
    'statusBarItem.remoteBackground': '#4F7CFF26',
    'statusBarItem.remoteForeground': '#8EACFF',
    'list.activeSelectionBackground': '#2A383D',
    'list.activeSelectionForeground': '#E8ECE9',
    'list.inactiveSelectionBackground': '#293338',
    'list.inactiveSelectionForeground': '#C6D0CD',
    'list.focusBackground': '#2A383D',
    'list.focusForeground': '#E8ECE9',
    'list.focusOutline': '#8EACFF',
    'list.hoverBackground': '#293338',
    'list.hoverForeground': '#E8ECE9',
    'list.highlightForeground': '#8EACFF',
    'list.dropBackground': '#4F7CFF26',
    'tree.indentGuidesStroke': '#344047',
    'input.background': '#181D20',
    'input.foreground': '#E8ECE9',
    'input.border': '#526068',
    'input.placeholderForeground': '#A9B7B9',
    'inputOption.activeBackground': '#4F7CFF26',
    'inputOption.activeBorder': '#8EACFF',
    'inputOption.activeForeground': '#E8ECE9',
    'dropdown.background': '#20272B',
    'dropdown.foreground': '#E8ECE9',
    'dropdown.border': '#526068',
    'button.background': '#4F7CFF',
    'button.foreground': '#101827',
    'button.hoverBackground': '#8EACFF',
    'button.secondaryBackground': '#293338',
    'button.secondaryForeground': '#E8ECE9',
    'button.secondaryHoverBackground': '#303C41',
    'badge.background': '#293338',
    'badge.foreground': '#E8ECE9',
    'progressBar.background': '#4F7CFF',
    'quickInput.background': '#20272B',
    'quickInput.foreground': '#E8ECE9',
    'quickInputTitle.background': '#293338',
    'notificationCenterHeader.background': '#293338',
    'notifications.background': '#20272B',
    'notifications.foreground': '#E8ECE9',
    'notifications.border': '#344047',
    'scrollbarSlider.background': '#A9B7B930',
    'scrollbarSlider.hoverBackground': '#A9B7B950',
    'scrollbarSlider.activeBackground': '#A9B7B970',
    'terminal.background': '#1C2226',
    'terminal.foreground': '#C6D0CD',
    'terminalCursor.foreground': '#8EACFF',
    'terminal.selectionBackground': '#4F7CFF40',
    'terminal.ansiGreen': '#AAC78C',
    'terminal.ansiBrightGreen': '#64C5AC',
    'terminal.ansiBlue': '#84B7DB',
    'terminal.ansiCyan': '#64C5AC',
    'terminal.ansiYellow': '#D4A47C',
    'terminal.ansiRed': '#E99893'
};

@injectable()
export class ScopeThemeContribution implements FrontendApplicationContribution {
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(MonacoThemeRegistry) protected readonly editorThemes!: MonacoThemeRegistry;

    initialize(): void {
        this.editorThemes.register({
            name: '见微 Nodu · 石墨',
            colors,
            tokenColors: [
                { scope: ['comment', 'comment.line', 'comment.block'], settings: { foreground: '#85969B' } },
                { scope: ['keyword', 'storage', 'storage.type'], settings: { foreground: '#84B7DB' } },
                { scope: ['string', 'string.quoted'], settings: { foreground: '#AAC78C' } },
                { scope: ['constant.numeric', 'constant.language'], settings: { foreground: '#D4A47C' } },
                { scope: ['entity.name.function', 'support.function'], settings: { foreground: '#99DBC9' } },
                { scope: ['entity.name.type', 'support.type'], settings: { foreground: '#84B7DB' } },
                { scope: ['variable', 'variable.parameter'], settings: { foreground: '#E8ECE9' } }
            ]
        }, undefined, SCOPE_THEME_ID, 'vs-dark');
        this.themes.register({
            id: SCOPE_THEME_ID,
            type: 'dark',
            label: '见微 Nodu · 石墨',
            description: 'Nodu 的石墨工作台与品牌蓝主题。',
            editorTheme: SCOPE_THEME_ID
        });
    }
}

/** Custom panel tokens fall back coherently when users choose another Theia theme. */
@injectable()
export class ScopeColorContribution implements ColorContribution {
    registerColors(registry: ColorRegistry): void {
        registry.register(
            {
                id: 'scope.accent',
                description: 'Nodu 工作台的强调色。',
                defaults: { dark: '#8EACFF', light: '#244BB0', hcDark: '#8EACFF', hcLight: '#244BB0' }
            },
            {
                id: 'scope.accentBackground',
                description: 'Nodu 状态与选中项的背景。',
                defaults: { dark: '#4F7CFF26', light: '#E8EEFF', hcDark: '#244BB0', hcLight: '#E8EEFF' }
            },
            {
                id: 'scope.mutedForeground',
                description: 'Nodu 面板的次要文字。',
                defaults: { dark: '#A9B7B9', light: '#50645C', hcDark: '#FFFFFF', hcLight: '#242424' }
            },
            {
                id: 'scope.canvasBackground',
                description: 'Nodu 合成帧的画布背景。',
                defaults: { dark: '#111719', light: '#E3E9E1', hcDark: '#000000', hcLight: '#FFFFFF' }
            }
        );
    }
}
