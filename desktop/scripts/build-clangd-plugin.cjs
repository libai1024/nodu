// SPDX-License-Identifier: MIT
// Fetch only at build time. The app loads this pinned, bundled plugin offline.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const url = 'https://open-vsx.org/api/llvm-vs-code-extensions/vscode-clangd/0.6.0/file/llvm-vs-code-extensions.vscode-clangd-0.6.0.vsix';
const sha256 = '32030694fa6c0ef438f4e4219f84677cd32f603c7faa4c71a283efc1f5b51751';
async function main() {
    const archive = path.join(root, '.tools/plugins/clangd.vsix');
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    if (!fs.existsSync(archive)) {
        const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!response.ok) throw new Error(`clangd download: ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (crypto.createHash('sha256').update(data).digest('hex') !== sha256) throw new Error('clangd VSIX checksum mismatch');
        fs.writeFileSync(archive, data);
    }
    if (crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== sha256) throw new Error('Cached clangd VSIX checksum mismatch');
    const unpack = path.join(root, '.tools/plugins/unpack');
    fs.rmSync(unpack, { recursive: true, force: true });
    // Theia ships a cross-platform ZIP library, so Windows needs no unzip executable.
    const yauzl = require('yauzl');
    await new Promise((resolve, reject) => yauzl.open(archive, { lazyEntries: true }, (error, zip) => {
        if (error) return reject(error);
        zip.on('error', reject); zip.on('end', resolve);
        zip.on('entry', entry => {
            if (entry.fileName.split('/').includes('..') || path.isAbsolute(entry.fileName)) return reject(new Error('Unsafe VSIX entry'));
            const file = path.join(unpack, entry.fileName);
            if (entry.fileName.endsWith('/')) { fs.mkdirSync(file, { recursive: true }); zip.readEntry(); return; }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            zip.openReadStream(entry, (error, input) => {
                if (error) return reject(error);
                const out = fs.createWriteStream(file);
                input.on('error', reject); out.on('error', reject); out.on('finish', () => zip.readEntry()); input.pipe(out);
            });
        });
        zip.readEntry();
    }));
    const source = path.join(unpack, 'extension');
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
    manifest.main = './nodu-adapter.cjs';
    manifest.activationEvents = ['onCommand:nodu.clangd.start'];
    // Keep language-client features, remove upstream palettes, menus and shortcuts.
    manifest.contributes = { configuration: manifest.contributes.configuration,
        commands: [{ command: 'nodu.clangd.start', title: 'Nodu internal clangd lifecycle' }],
        menus: { commandPalette: [{ command: 'nodu.clangd.start', when: 'false' }] } };
    const properties = manifest.contributes.configuration.properties;
    const defaults = { 'clangd.path': '${env:NODU_CLANGD_PATH}',
        'clangd.arguments': Array.from({ length: 8 }, (_, i) => '${env:NODU_CLANGD_ARG_' + i + '}'),
        'clangd.checkUpdates': false, 'clangd.detectExtensionConflicts': false, 'clangd.onConfigChanged': 'ignore' };
    for (const [key, value] of Object.entries(defaults)) if (properties[key]) properties[key].default = value;
    fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
    fs.copyFileSync(path.join(__dirname, 'clangd-adapter.cjs'), path.join(source, 'nodu-adapter.cjs'));
    fs.writeFileSync(path.join(source, 'NODU-PATCHES.md'), `Upstream: ${url}\nSHA-256: ${sha256}\nNodu changes: explicit lifecycle adapter, offline tool defaults, hidden contributed menus/commands. Upstream out/bundle.js is unchanged.\n`);
    const dest = path.join(root, 'plugins/vscode-clangd');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(source, dest, { recursive: true });
    console.log(`Bundled clangd 0.6.0 (${sha256})`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
