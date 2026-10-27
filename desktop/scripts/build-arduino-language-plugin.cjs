// SPDX-License-Identifier: MIT
// The runtime contains only the bundled language client and the lifecycle adapter; no npm at runtime.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
async function main() {
    const dependencyRoot = path.join(root, '.tools/arduino-language-plugin/node_modules');
    const client = path.join(dependencyRoot, 'vscode-languageclient/package.json');
    if (!fs.existsSync(client) || JSON.parse(fs.readFileSync(client, 'utf8')).version !== '9.0.1') {
        const staging = path.dirname(dependencyRoot); fs.mkdirSync(staging, { recursive: true });
        for (const file of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(__dirname, 'arduino-language-plugin', file), path.join(staging, file));
        const npmCli = [process.env.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
            path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].find(file => file && fs.existsSync(file));
        if (!npmCli) throw new Error('Run this build through npm run build:plugins with the Node 24 toolchain.');
        execFileSync(process.execPath, [npmCli, 'ci', '--prefix', staging, '--ignore-scripts', '--no-audit', '--no-fund'], { stdio: 'inherit' });
    }
    const dest = path.join(root, 'plugins/nodu-arduino-language'); fs.mkdirSync(dest, { recursive: true });
    await require('esbuild').build({ entryPoints: [path.join(__dirname, 'arduino-language-adapter.cjs')], bundle: true,
        outfile: path.join(dest, 'extension.cjs'), platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'],
        nodePaths: [dependencyRoot], legalComments: 'external', minify: false });
    const manifest = { name: 'nodu-arduino-language', displayName: 'Nodu Arduino', publisher: 'nodu', version: '0.1.0',
        license: 'MIT', engines: { vscode: '^1.75.0' }, main: './extension.cjs', activationEvents: ['onCommand:nodu.arduino.language.start'],
        contributes: { languages: [{ id: 'cpp', aliases: ['C++', 'Cpp', 'cpp'], extensions: ['.ino', '.pde'], configuration: './grammar/language-configuration.json' }],
            grammars: [{ language: 'cpp', scopeName: 'source.cpp.embedded.macro', path: './grammar/syntaxes/cpp.embedded.macro.tmLanguage.json' },
                { language: 'cpp', scopeName: 'source.cpp', path: './grammar/syntaxes/cpp.tmLanguage.json' }],
            commands: [{ command: 'nodu.arduino.language.start', title: 'Nodu internal Arduino language lifecycle' }],
            menus: { commandPalette: [{ command: 'nodu.arduino.language.start', when: 'false' }] } } };
    fs.writeFileSync(path.join(dest, 'package.json'), JSON.stringify(manifest, null, 2)+'\n');
    const grammar = path.join(__dirname, 'arduino-language-plugin/grammar');
    const grammarManifest = JSON.parse(fs.readFileSync(path.join(grammar, 'manifest.json'), 'utf8'));
    for (const item of grammarManifest.files) {
        if (crypto.createHash('sha256').update(fs.readFileSync(path.join(grammar, item.file))).digest('hex') !== item.sha256) throw new Error(`Grammar checksum mismatch: ${item.file}`);
    }
    fs.cpSync(grammar, path.join(dest, 'grammar'), { recursive: true });
    const licenses = path.join(dest, 'licenses'); fs.mkdirSync(licenses, { recursive: true });
    const packages = ['vscode-languageclient','vscode-languageserver-protocol','vscode-languageserver-types','vscode-jsonrpc','semver','minimatch','brace-expansion','balanced-match'];
    const provenance = [];
    for (const name of packages) {
        const dir = path.join(dependencyRoot, name); if (!fs.existsSync(dir)) continue;
        const info = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
        const license = fs.readdirSync(dir).find(file => /^(license|copying)/i.test(file));
        if (!license) throw new Error(`Missing license: ${name}`);
        fs.copyFileSync(path.join(dir, license), path.join(licenses, name+'.txt'));
        provenance.push({ name, version: info.version, license: info.license });
    }
    const bytes = fs.readFileSync(path.join(dest, 'extension.cjs'));
    fs.writeFileSync(path.join(dest, 'NODU-PROVENANCE.json'), JSON.stringify({ schema:1, source:'desktop/scripts/arduino-language-adapter.cjs', dependencies:provenance,
        sha256:crypto.createHash('sha256').update(bytes).digest('hex') },null,2)+'\n');
    console.log(`Built Arduino language plugin (${bytes.length} bytes)`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
