// SPDX-License-Identifier: MIT
// macOS may retain a code-signature cache entry when esbuild truncates an
// existing native binary. Replace bundled copies atomically before launch.
const fs = require('node:fs');
const path = require('node:path');
function refreshNativeArtifacts(appDirectory) {
    if (process.platform !== 'darwin') return;
    const dir = path.join(appDirectory, 'lib/backend/native');
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
        const file = path.join(dir, name);
        if (!fs.statSync(file).isFile()) continue;
        const temporary = file + `.nodu-${process.pid}`;
        fs.copyFileSync(file, temporary);
        fs.chmodSync(temporary, fs.statSync(file).mode);
        fs.renameSync(temporary, file);
    }
}
module.exports = { refreshNativeArtifacts };
if (require.main === module) refreshNativeArtifacts(path.resolve(__dirname, '..', `${process.argv[2]}-app`));
