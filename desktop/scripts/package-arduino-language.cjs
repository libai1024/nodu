// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
// Signing changes Mach-O bytes. Preserve the source-build identity, then update
// installed-byte hashes before the containing application is sealed.
function refreshManifests(appPath) {
    let count = 0;
    const visit = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.isFile() && entry.name === 'ARDUINO-LANGUAGE-TOOLS.json'
                && /[/\\]resources[/\\]bin[/\\]darwin-(arm64|x64)$/.test(directory)) {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                const resources = path.resolve(directory, '../..');
                const catalog = JSON.parse(fs.readFileSync(path.join(resources, 'arduino/language/tools.json'), 'utf8'));
                if (manifest.host !== path.basename(directory) || manifest.alsVersion !== catalog.alsVersion
                    || manifest.als.sha256 !== catalog.alsSource.sha256 || manifest.als.patchSha256 !== catalog.alsSource.patchSha256) {
                    throw new Error('Arduino language source identity changed during packaging');
                }
                for (const [record, binary] of [[manifest.als, path.join(directory, 'arduino-language-server')],
                    [manifest.clangd, path.join(directory, 'arduino-clangd/bin/clangd')]]) {
                    record.buildBinarySha256 ??= record.binarySha256;
                    record.binarySha256 = hash(binary);
                }
                manifest.packageSigning = 'macOS codesign; installed-byte hashes refreshed before application signing';
                fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
                count++;
            }
        }
    };
    visit(appPath);
    return count;
}
module.exports = { refreshManifests };
