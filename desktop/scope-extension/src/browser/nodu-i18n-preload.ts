// SPDX-License-Identifier: MIT
import { ContainerModule } from '@theia/core/shared/inversify';
import { injectable } from '@theia/core/shared/inversify';
import { TextReplacementContribution } from '@theia/core/lib/browser/preload/text-replacement-contribution';
import { NODU_ZH_CN } from '../common/nodu-zh-cn';

@injectable()
export class NoduZhCnTextReplacementContribution implements TextReplacementContribution {
    // Keys are the English default values passed to nls.localize / nls.localizeByDefault;
    // Localization.localize checks localization.replacements[defaultValue] first, so this
    // covers stock menus, dialogs and Monaco strings without needing a plugin language pack.
    getReplacement(locale: string): Record<string, string> {
        return locale === 'zh-cn' ? NODU_ZH_CN : {};
    }
}

export default new ContainerModule(bind => {
    bind(NoduZhCnTextReplacementContribution).toSelf().inSingletonScope();
    bind(TextReplacementContribution).toService(NoduZhCnTextReplacementContribution);
});
