// SPDX-License-Identifier: MIT
// License guard for the 0.1.3 rewrite:
// 1. Fail if any non-ignored file under desktop/ — tracked or new, excluding
//    node_modules, target, lib, src-gen — contains the non-commercial-clause
//    fingerprints "personal benefit" / "monetary gain" (newer OpenMV Qt
//    branches). This script itself is exempt from check 1 because it must
//    contain the detection signatures; it is still listed in the scan set.
// 2. Fail if a .rs/.ts file carries a "Ported from" header without a
//    "Source: <repo> <commit|version> <path>" line (local project files may
//    name k210-studio with a commit sha).
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repo = path.resolve(__dirname, '..', '..');
const desktop = path.join(repo, 'desktop');
const selfRel = 'desktop/scripts/check-licenses.cjs';

const files = [...new Set(
    execFileSync(
        'git',
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        { cwd: repo, encoding: 'utf8' }
    )
        .split('\0')
        .filter(Boolean)
        .filter(f => f.startsWith('desktop/'))
        .filter(f => !/(^|\/)(node_modules|target|lib|src-gen)(\/|$)/.test(f))
)];

const failures = [];
for (const rel of files) {
    const file = path.join(repo, rel);
    let text;
    try {
        text = fs.readFileSync(file, 'utf8');
    } catch {
        continue; // binary/unreadable file
    }
    if (rel !== selfRel && /personal benefit|monetary gain/i.test(text)) {
        failures.push(`${rel}: contains a non-commercial-clause fingerprint`);
    }
    if (/\.(rs|ts)$/.test(rel) && /Ported from/i.test(text)) {
        const source = text
            .split('\n')
            .map(l => l.trim())
            .find(l => /^\/\/\s*Source:/i.test(l) || /^Source:/i.test(l));
        const ok = source &&
            /\S+\s+(?:[0-9a-f]{7,40}|v?\d+\.\d+(?:\.\d+)*)\s+\S+/i.test(source.replace(/^\/\/\s*Source:/i, ''));
        if (!ok) {
            failures.push(`${rel}: "Ported from" header lacks a "Source: <repo> <commit> <path>" line`);
        }
    }
}

if (failures.length) {
    console.error('check-licenses failed:');
    for (const f of failures) console.error('  ' + f);
    process.exit(1);
}
console.log(`check-licenses: scanned ${files.length} files under desktop/ — clean.`);
