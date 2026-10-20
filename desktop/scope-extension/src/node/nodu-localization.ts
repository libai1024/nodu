// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { LocalizationContribution, LocalizationRegistry } from '@theia/core/lib/node/i18n/localization-contribution';
import { nls } from '@theia/core/lib/common/nls';
import { NODU_ZH_CN } from '../common/nodu-zh-cn';

@injectable()
export class NoduZhCnLocalizationContribution implements LocalizationContribution {
    async registerLocalizations(registry: LocalizationRegistry): Promise<void> {
        // Derive vscode/* nls keys from each English default via Theia's own metadata
        // (nls.getDefaultKey). Strings that only exist as theia-namespaced keys resolve
        // to nothing here and are covered by the frontend text replacements instead.
        const translations: Record<string, string> = {};
        for (const [defaultValue, localized] of Object.entries(NODU_ZH_CN)) {
            const key = nls.getDefaultKey(defaultValue);
            if (key) {
                translations[key] = localized;
            }
        }
        registry.registerLocalization({
            languageId: 'zh-cn',
            languageName: 'Chinese (Simplified)',
            localizedLanguageName: '中文(简体)',
            languagePack: true,
            translations
        });
    }
}
