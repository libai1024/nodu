// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { validateToolkit, refreshManifests } = require('./package-stm32.cjs');
test('release rejects development kits, altered content and missing sources; signing refreshes digests', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nodu-package-'));
    try {
        const root = path.join(tmp, 'toolkits/stm32/darwin'); fs.mkdirSync(root, { recursive: true });
        const manifest = { profile: 'dev', files: [] };
        const save = () => fs.writeFileSync(path.join(root, 'toolkit.json'), JSON.stringify(manifest));
        save(); assert.throws(() => validateToolkit(root), /release/);
        manifest.profile = 'release';
        for (const rel of ['licenses/LICENSE', 'sources/tool.tar.gz', 'clangd/bin/clangd']) {
            const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
            manifest.files.push({ path: rel, size: 7, sha256: crypto.createHash('sha256').update('fixture').digest('hex') });
        }
        save(); assert.throws(() => validateToolkit(root), /源码/);
        manifest.sourceArchives = [{ path: manifest.files[1].path, sha256: manifest.files[1].sha256 }]; save(); validateToolkit(root);
        fs.writeFileSync(path.join(root, 'clangd/bin/clangd'), 'signed fixture');
        assert.throws(() => validateToolkit(root), /损坏/);
        refreshManifests(tmp); validateToolkit(root);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
