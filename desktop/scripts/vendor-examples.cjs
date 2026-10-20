#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// Vendor the MaixPy-v1_scripts Python examples into the bundled resources
// tree. The source checkout is pinned to a single commit; every run removes
// the previously vendored categories (from the recorded manifest), copies
// all *.py files <= 256 KiB plus the root LICENSE/README.md, and writes a
// deterministic manifest.json with per-file sizes and sha256.
// Usage: node scripts/vendor-examples.cjs [--source DIR] [--dest DIR]
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PINNED_COMMIT = '8d7c5f98ba654d226f433d31718d852674cab08d';
const SOURCE_REPO = 'sipeed/MaixPy-v1_scripts';
const MAX_FILE_BYTES = 256 * 1024;
const PROTECTED_TOP_LEVEL = new Set(['Nodu']); // hand-maintained category, never vendored

function parseArgs(argv) {
    const options = {
        source: path.resolve(__dirname, '..', '..', '..', 'nodu-refs', 'MaixPy-v1_scripts'),
        dest: path.resolve(__dirname, '..', 'scope-extension', 'resources', 'nodu-resources', 'examples'),
    };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === '--source' && argv[i + 1]) {
            options.source = path.resolve(argv[++i]);
        } else if (argv[i] === '--dest' && argv[i + 1]) {
            options.dest = path.resolve(argv[++i]);
        } else {
            console.error(`vendor-examples: unknown or incomplete argument ${argv[i]}`);
            console.error('usage: node scripts/vendor-examples.cjs [--source DIR] [--dest DIR]');
            process.exit(2);
        }
    }
    return options;
}

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Collect .py files under dir into [{rel, abs, bytes}], sorted; oversized go to skipped. */
function collectPython(dir, prefix, files, skipped) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === '__pycache__') { continue; }
        const abs = path.join(dir, entry.name);
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            collectPython(abs, rel, files, skipped);
        } else if (entry.isFile() && /\.py$/i.test(entry.name)) {
            const bytes = fs.statSync(abs).size;
            if (bytes > MAX_FILE_BYTES) {
                skipped.push({ path: rel, bytes });
            } else {
                files.push({ path: rel, abs, bytes });
            }
        }
        // non-.py assets (kmodel/wav/mp4/zip/pdf/png, symlinks, ...) are not vendored
    }
}

/** Top-level categories the previous run vendored, read from its manifest
 * (empty when there is none — nothing is removed in that case). */
function vendoredTopLevels(dest) {
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(dest, 'manifest.json'), 'utf8'));
        if (!manifest || !Array.isArray(manifest.files)) { return []; }
        return [...new Set(manifest.files.map(f => String(f.path).split('/')[0]))];
    } catch {
        return [];
    }
}

function main() {
    const { source, dest } = parseArgs(process.argv);
    if (!fs.existsSync(path.join(source, '.git'))) {
        console.error(`vendor-examples: ${source} is not a git checkout of ${SOURCE_REPO}`);
        process.exit(1);
    }
    const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    if (commit !== PINNED_COMMIT) {
        console.error(`vendor-examples: ${source} is at ${commit}, expected ${PINNED_COMMIT}`);
        process.exit(1);
    }

    const files = [];
    const skipped = [];
    collectPython(source, '', files, skipped);
    for (const name of ['LICENSE', 'README.md']) {
        const abs = path.join(source, name);
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            files.push({ path: name, abs, bytes: fs.statSync(abs).size });
        }
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    fs.mkdirSync(dest, { recursive: true });
    for (const top of vendoredTopLevels(dest)) {
        if (PROTECTED_TOP_LEVEL.has(top)) { continue; }
        fs.rmSync(path.join(dest, top), { recursive: true, force: true });
    }
    for (const name of ['LICENSE', 'README.md', 'manifest.json']) {
        fs.rmSync(path.join(dest, name), { force: true });
    }

    let total = 0;
    for (const file of files) {
        const target = path.join(dest, file.path);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file.abs, target);
        total += file.bytes;
    }
    const manifest = {
        source: SOURCE_REPO,
        commit,
        files: files.map(file => ({ path: file.path, bytes: file.bytes, sha256: sha256(file.abs) })),
    };
    const manifestPath = path.join(dest, 'manifest.json');
    fs.writeFileSync(`${manifestPath}.tmp`, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.renameSync(`${manifestPath}.tmp`, manifestPath);

    const pyCount = files.filter(f => f.path.endsWith('.py')).length;
    console.log(`vendor-examples: ${pyCount} .py + ${files.length - pyCount} manifest files (${total} bytes)`);
    for (const item of skipped) {
        console.log(`vendor-examples: skipped ${item.path} (${item.bytes} bytes > ${MAX_FILE_BYTES})`);
    }
}

if (require.main === module) { main(); }
module.exports = { PINNED_COMMIT, MAX_FILE_BYTES, collectPython, vendoredTopLevels };
