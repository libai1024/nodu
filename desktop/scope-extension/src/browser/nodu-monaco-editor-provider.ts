// SPDX-License-Identifier: MIT
import { injectable } from '@theia/core/shared/inversify';
import { MonacoEditorProvider } from '@theia/monaco/lib/browser/monaco-editor-provider';

/** Theia 1.76's schema still uses the option name preceding Monaco's rename. */
@injectable()
export class NoduMonacoEditorProvider extends MonacoEditorProvider {
    protected override toOptionName(preferenceName: string, prefixes: string[]): string {
        // Without this mapping Monaco ignores Theia's default false and enables
        // EditContext; Electron's native Cut menu then does nothing on Windows.
        return preferenceName === 'editor.experimentalEditContextEnabled'
            ? 'editContext' : super.toOptionName(preferenceName, prefixes);
    }
}
