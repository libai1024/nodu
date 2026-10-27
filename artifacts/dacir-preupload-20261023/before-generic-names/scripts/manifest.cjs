// SPDX-License-Identifier: MIT
// No dependencies, compiler invocation or network access.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const write = process.argv.includes('--write');
function walk(dir, prefix = '') {
    const result = {};
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = prefix + entry.name;
        if (entry.isSymbolicLink() || /[\\\x00-\x1f:]/.test(name)) throw new Error('Unsupported path: ' + name);
        if (entry.isDirectory()) Object.assign(result, walk(path.join(dir, entry.name), name + '/'));
        else if (entry.isFile()) result[name] = sha(fs.readFileSync(path.join(dir, entry.name)));
        else throw new Error('Unsupported entry: ' + name);
    }
    return result;
}
function equal(a, b) { return JSON.stringify(Object.fromEntries(Object.entries(a).sort())) === JSON.stringify(Object.fromEntries(Object.entries(b).sort())); }
try {
    const manifestFile = path.join(root, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestFile));
    if (manifest.schema !== 1 || manifest.provider !== 'dacir') throw new Error('Unsupported manifest');
    for (const id of manifest.templates) {
        if (!/^[a-z0-9-]+$/.test(id)) throw new Error('Invalid template ID');
        const dir = path.join(root, 'templates', id);
        const sourceFile = path.join(dir, 'template-sources.json');
        const sources = JSON.parse(fs.readFileSync(sourceFile));
        const files = walk(dir); delete files['template-sources.json'];
        if (sources.libraryCommit !== manifest.upstream.libraryCommit) throw new Error('Driver commit mismatch: ' + id);
        const project = JSON.parse(fs.readFileSync(path.join(dir, 'studio.project.json')));
        if (project.target?.mcu !== 'STM32F103C8T6' || project.target?.clockHz !== 72000000) throw new Error('Unsupported chip/clock: ' + id);
        if (write) { sources.files = Object.fromEntries(Object.entries(files).sort()); fs.writeFileSync(sourceFile, json(sources)); }
        else if (!equal(sources.files, files)) throw new Error('Template content changed: ' + id + '; review changes then run npm run reindex');
    }
    const collected = {};
    for (const dir of ['adapter', 'licenses', 'support', 'templates']) Object.assign(collected, walk(path.join(root, dir), dir + '/'));
    const files = Object.fromEntries(Object.entries(collected).sort());
    const digest = sha(json(files));
    if (write) {
        manifest.files = files; manifest.contentSha256 = digest; manifest.version = 'snapshot-' + digest.slice(0, 16);
        fs.writeFileSync(manifestFile, json(manifest));
    } else if (!equal(manifest.files, files) || manifest.contentSha256 !== digest || manifest.version !== 'snapshot-' + digest.slice(0, 16)) throw new Error('Pack manifest mismatch');
    console.log(`${write ? 'Indexed' : 'Verified'} ${manifest.version}: ${manifest.templates.length} templates, ${Object.keys(files).length} files`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
