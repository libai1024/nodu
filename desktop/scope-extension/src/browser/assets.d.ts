// SPDX-License-Identifier: MIT
// esbuild emits .png imports as data URLs (see gen-esbuild.browser.mjs loaders).
declare module '*.png' {
    const url: string;
    export default url;
}
