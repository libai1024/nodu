// SPDX-License-Identifier: MIT
// Fetch the pinned OpenMV CMSIS-NN .network files listed in
// tools/refs/network-models.json (frozen manifest — bytes were
// byte-compared against the installed MaixPy IDE 0.2.5 upstream). Only the
// exact pinned raw.githubusercontent.com URLs are fetched, bounded to
// 2 MiB each, then verified against the manifest's size and SHA-256 before
// staging under scope-extension/resources/models/<id>/. Each distinct
// repository's root LICENSE at the same pinned revision is staged under
// resources/licenses/network-models/. Run manually; builds never fetch.
'use strict';
const { createHash } = require('crypto');
const { mkdirSync, writeFileSync, copyFileSync } = require('fs');
const { basename, join, dirname } = require('path');

const MAX_BYTES = 2 * 1024 * 1024;
const ROOT = join(__dirname, '..');
const MANIFEST = join(ROOT, '..', 'tools', 'refs', 'network-models.json');
const MODELS_DIR = join(ROOT, 'scope-extension', 'resources', 'models');
const LICENSE_DIR = join(ROOT, 'scope-extension', 'resources', 'licenses', 'network-models');

const MAX_REDIRECTS = 5;

// Manual redirect following keeps every hop HTTPS-pinned; the body is read
// as chunks so the 2 MiB bound aborts mid-stream instead of after a full
// allocation.
async function fetchBounded(url, what, redirects = 0) {
    const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
    });
    if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (response.body) { await response.body.cancel().catch(() => {}); }
        if (!location) { throw new Error(`${what}: redirect without Location for ${url}`); }
        if (redirects >= MAX_REDIRECTS) { throw new Error(`${what}: too many redirects for ${url}`); }
        const next = new URL(location, url);
        if (next.protocol !== 'https:') { throw new Error(`${what}: redirect left HTTPS for ${url}`); }
        return fetchBounded(next.toString(), what, redirects + 1);
    }
    if (!response.ok) { throw new Error(`${what}: HTTP ${response.status} for ${url}`); }
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) { throw new Error(`${what}: declared size ${length} exceeds 2 MiB`); }
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of response.body) {
            total += chunk.byteLength;
            if (total > MAX_BYTES) {
                throw new Error(`${what}: body exceeds 2 MiB mid-stream`);
            }
            chunks.push(Buffer.from(chunk));
        }
    } catch (error) {
        if (response.body) { await response.body.cancel().catch(() => {}); }
        throw error;
    }
    return Buffer.concat(chunks);
}

async function main() {
    const manifest = JSON.parse(require('fs').readFileSync(MANIFEST, 'utf-8'));
    mkdirSync(MODELS_DIR, { recursive: true });
    mkdirSync(LICENSE_DIR, { recursive: true });
    const licenses = new Map();
    for (const model of manifest.models) {
        const url = `https://raw.githubusercontent.com/${model.repository}/${model.revision}/${model.path}`;
        const data = await fetchBounded(url, `model ${model.id}`);
        if (data.length !== model.bytes) {
            throw new Error(`model ${model.id}: expected ${model.bytes} bytes, got ${data.length}`);
        }
        const sha = createHash('sha256').update(data).digest('hex');
        if (sha !== model.sha256) {
            throw new Error(`model ${model.id}: sha256 mismatch (${sha})`);
        }
        const dir = join(MODELS_DIR, model.id);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, basename(model.path)), data);
        console.log(`fetch-models: staged ${model.id}/${basename(model.path)} (${data.length} bytes, sha256 verified)`);
        if (!licenses.has(model.repository)) {
            const licenseUrl = `https://raw.githubusercontent.com/${model.repository}/${model.revision}/${model.licensePath}`;
            const text = await fetchBounded(licenseUrl, `license ${model.repository}`);
            const owner = model.repository.split('/')[0];
            licenses.set(model.repository, join(LICENSE_DIR, `${owner}-LICENSE.txt`));
            writeFileSync(licenses.get(model.repository), text);
            console.log(`fetch-models: staged license for ${model.repository}@${model.revision.slice(0, 8)}`);
        }
    }
    copyFileSync(MANIFEST, join(MODELS_DIR, 'manifest.json'));
    console.log('fetch-models: copied manifest.json (frozen pin data)');
}

if (require.main === module) {
    main().catch(error => { console.error(`fetch-models: ${error.message}`); process.exit(1); });
}

module.exports = { fetchBounded, MAX_BYTES, MAX_REDIRECTS };
