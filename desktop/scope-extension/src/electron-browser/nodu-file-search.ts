// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { QuickFileOpenService } from '@theia/file-search/lib/browser/quick-file-open';

@injectable()
export class NoduFileSearch extends QuickFileOpenService {
    override registerQuickAccessProvider(): void {
        this.quickAccessRegistry.registerQuickAccessProvider({
            getInstance: () => this,
            prefix: QuickFileOpenService.PREFIX,
            placeholder: '搜索文件…',
            helpEntries: [{ description: '搜索文件', needsEditor: false }],
        });
    }
}
