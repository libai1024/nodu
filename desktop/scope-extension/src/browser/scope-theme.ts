// SPDX-License-Identifier: MIT
import { inject, injectable } from '@theia/core/shared/inversify';
import { ColorContribution } from '@theia/core/lib/browser/color-application-contribution';
import { ColorRegistry } from '@theia/core/lib/browser/color-registry';
import { FrontendApplicationContribution } from '@theia/core/lib/browser/frontend-application-contribution';
import { ThemeService } from '@theia/core/lib/browser/theming';
import { MonacoThemeRegistry } from '@theia/monaco/lib/browser/textmate/monaco-theme-registry';
import { editorTokenRules, scopeColorDefaults, workbenchColors } from './nodu-theme-colors';

// Theme IDs stay unchanged for existing user settings; the visible names follow brand v2.
export const SCOPE_THEME_ID = 'scope-dark';
export const SCOPE_LIGHT_THEME_ID = 'scope-light';

const THEMES = [
    {
        id: SCOPE_THEME_ID, type: 'dark' as const, base: 'vs-dark' as const,
        label: '见微 Nodu 芯片墨', description: 'Nodu 的芯片墨工作台与 Nodu 蓝主题。'
    },
    {
        id: SCOPE_LIGHT_THEME_ID, type: 'light' as const, base: 'vs' as const,
        label: '见微 Nodu 丝印白', description: 'Nodu 的丝印白阅读面与 Nodu 蓝主题。'
    }
];

/** Every colour comes from brand tokens (nodu-brand.ts, generated from brand/src/tokens.cjs). */
@injectable()
export class ScopeThemeContribution implements FrontendApplicationContribution {
    @inject(ThemeService) protected readonly themes!: ThemeService;
    @inject(MonacoThemeRegistry) protected readonly editorThemes!: MonacoThemeRegistry;

    initialize(): void {
        for (const theme of THEMES) {
            this.editorThemes.register({
                name: theme.label,
                colors: workbenchColors(theme.type),
                tokenColors: editorTokenRules(theme.type)
            }, undefined, theme.id, theme.base);
            this.themes.register({
                id: theme.id,
                type: theme.type,
                label: theme.label,
                description: theme.description,
                editorTheme: theme.id
            });
        }
    }
}

/** Custom panel tokens fall back coherently when users choose another Theia theme. */
@injectable()
export class ScopeColorContribution implements ColorContribution {
    registerColors(registry: ColorRegistry): void {
        registry.register(...scopeColorDefaults());
    }
}
