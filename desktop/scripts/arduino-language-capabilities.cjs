// SPDX-License-Identifier: MIT
// ALS 0.7.7 forwards initialization capabilities to clangd but does not proxy every server request.
// Claim only request paths the intermediary implements; modern client defaults otherwise make ALS panic.
exports.restrictArduinoCapabilities = capabilities => {
    const disableDynamic = value => {
        if (!value || typeof value !== 'object') return;
        if ('dynamicRegistration' in value) value.dynamicRegistration = false;
        for (const child of Object.values(value)) disableDynamic(child);
    };
    disableDynamic(capabilities);
    const workspace = capabilities.workspace ??= {};
    workspace.applyEdit = false;
    workspace.configuration = false;
    workspace.workspaceFolders = false;
    for (const feature of ['semanticTokens', 'codeLens', 'inlayHint', 'inlineValue', 'diagnostics']) {
        workspace[feature] = { refreshSupport: false };
    }
    if (capabilities.window?.showDocument) capabilities.window.showDocument.support = false;
    // ALS does not advertise these document methods; retain its supported completion/hover/rename/diagnostics.
    for (const feature of ['semanticTokens', 'inlayHint', 'inlineValue', 'diagnostic']) {
        if (capabilities.textDocument) delete capabilities.textDocument[feature];
    }
    return capabilities;
};
// The release also advertises three clangd handlers that its IDE-facing server still implements as panic.
exports.restrictArduinoServerCapabilities = capabilities => {
    for (const name of ['workspaceSymbolProvider', 'executeCommandProvider', 'documentOnTypeFormattingProvider']) delete capabilities[name];
};
