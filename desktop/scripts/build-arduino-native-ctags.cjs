// SPDX-License-Identifier: MIT
// Rebuild the unchanged Arduino ctags source for Apple Silicon; never replace an upstream archive.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const desktop = path.resolve(__dirname, '..');
const version = '5.8-arduino11';
const sourceName = `ctags-${version}.tar.gz`;
const sourceSha256 = '86ca843c62aecb9bc531a73d9b6cef33179bd885b1bf8df9e0c7e9761aa9794d';
const sourceUrl = `https://codeload.github.com/arduino/ctags/tar.gz/refs/tags/${version}`;
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

function build(options = {}) {
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Native ctags build currently supports a macOS arm64 build host only.');
    const sources = path.resolve(options.sources || path.join(desktop, '.tools/arduino-release-sources'));
    const source = path.join(sources, 'sources', sourceName);
    if (digest(source) !== sourceSha256) throw Error('Pinned Arduino ctags source checksum mismatch.');
    const out = path.resolve(options.out || path.join(desktop, '.tools/arduino-release-native/darwin-arm64'));
    const buildBase = path.join(sources, 'build'); fs.mkdirSync(buildBase, { recursive: true });
    const staging = fs.mkdtempSync(path.join(buildBase, 'native-ctags-'));
    const run = (command, args, cwd = staging, env = process.env) => {
        const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
        if (result.status !== 0) throw Error(`${path.basename(command)} failed: ${(result.stderr || result.stdout || String(result.error)).slice(-5000)}`);
        return result.stdout;
    };
    run('/usr/bin/tar', ['-xzf', source, '-C', staging]);
    const tree = path.join(staging, `ctags-${version}`);
    // Pre-include SDK declarations before the old __unused__ macro and configure's exit() probe.
    // This avoids changing upstream sources or forcing configure results.
    const cflags = '-O2 -arch arm64 -mmacosx-version-min=11.0 -std=gnu89 -include dirent.h -include stdlib.h';
    const ldflags = '-arch arm64 -mmacosx-version-min=11.0';
    const configure = ['--disable-external-sort', '--disable-etags', '--enable-tmpdir=/tmp'];
    const env = { ...process.env, CC: '/usr/bin/clang', CFLAGS: cflags, LDFLAGS: ldflags, SOURCE_DATE_EPOCH: '0', LC_ALL: 'C', TMPDIR: '/tmp' };
    delete env.CPPFLAGS; delete env.CPP; delete env.CXXFLAGS; delete env.LIBS;
    fs.writeFileSync(path.join(staging, 'configure.log'), run('./configure', configure, tree, env));
    fs.writeFileSync(path.join(staging, 'make.log'), run('/usr/bin/make', ['-j4'], tree, env));
    const executable = path.join(tree, 'ctags');
    const architecture = run('/usr/bin/file', ['-b', executable]).trim();
    if (!architecture.includes('arm64')) throw Error('ctags build did not produce an arm64 binary.');
    const linkage = run('/usr/bin/otool', ['-L', executable]);
    if (!linkage.split('\n').slice(1).filter(line => line.trim()).every(line => line.trim().startsWith('/usr/lib/libSystem.B.dylib '))) throw Error('ctags has a non-system runtime dependency.');
    const banner = run(executable, ['--version']).trim();
    if (!banner.includes('+regex') || !banner.includes('+internal-sort')) throw Error('ctags build is missing its required parser features.');
    fs.mkdirSync(out, { recursive: true });
    const dest = path.join(out, 'ctags');
    const temporary = path.join(out, `ctags.${process.pid}.tmp`);
    fs.copyFileSync(executable, temporary); fs.chmodSync(temporary, 0o755); fs.renameSync(temporary, dest);
    const record = { path: 'ctags', sha256: digest(dest), size: fs.statSync(dest).size, version, sourceSha256, sourceUrl, buildBinarySha256: digest(dest) };
    const recipe = { schemaVersion: 1, host: 'darwin-arm64', upstreamSourceUnchanged: true, version,
        source: { path: `sources/${sourceName}`, url: sourceUrl, sha256: sourceSha256 },
        compiler: run('/usr/bin/clang', ['--version']).trim(), sdkVersion: run('/usr/bin/xcrun', ['--show-sdk-version']).trim(),
        environment: { CC: '/usr/bin/clang', CFLAGS: cflags, LDFLAGS: ldflags, SOURCE_DATE_EPOCH: '0', LC_ALL: 'C', TMPDIR: '/tmp' },
        configure, make: ['-j4'], architecture, dynamicLibraries: ['/usr/lib/libSystem.B.dylib'], banner, binary: record };
    fs.writeFileSync(path.join(out, 'CTAGS-BUILD.json'), JSON.stringify(recipe, null, 2) + '\n');
    fs.copyFileSync(path.join(tree, 'COPYING'), path.join(out, 'CTAGS-COPYING'));
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ schemaVersion: 1, host: 'darwin-arm64', files: [record] }, null, 2) + '\n');
    return { out, ...record };
}
if (require.main === module) {
    try { console.log(JSON.stringify(build(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { build, sourceSha256, sourceUrl };
