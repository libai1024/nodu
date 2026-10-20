// SPDX-License-Identifier: MIT
// Build the Rust device sidecar + standalone terminal for the host and stage
// them into scope-extension/resources/bin/<platform>-<arch>/.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const native = path.join(desktop, 'native');

const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'x64' ? 'x64' : process.arch;
const names = ['nodu-device', 'nodu-terminal'];
const exe = name => (platform === 'win32' ? `${name}.exe` : name);

// Host-platform only: universal macOS binaries and Windows builds are not
// verified yet. `mock` feature stays in the shipped binary: it is inert
// unless --mock is passed (dev/tests only, via NODU_DEVICE_MOCK=1).
const os = require('node:os');
const pathKey =
    Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
const env = {
    ...process.env,
    [pathKey]: [path.join(os.homedir(), '.cargo', 'bin'), process.env[pathKey] || '']
        .join(path.delimiter),
};
console.log('build-native: cargo build --release --locked -p nodu-device --features mock --bins');
execSync('cargo build --release --locked -p nodu-device --features mock --bins', {
    cwd: native,
    stdio: 'inherit',
    env,
});

const destDir = path.join(
    desktop, 'scope-extension', 'resources', 'bin', `${platform}-${arch}`);
fs.mkdirSync(destDir, { recursive: true });
for (const name of names) {
    const built = path.join(native, 'target', 'release', exe(name));
    if (!fs.existsSync(built)) {
        console.error(`build-native: expected ${built} after cargo build`);
        process.exit(1);
    }
    // macOS keeps a provenance record per inode: overwriting a signed binary in
    // place makes the kernel kill the next exec/mmap of it. Stage via rename so
    // the destination is always a fresh inode.
    const dest = path.join(destDir, exe(name));
    const tmp = path.join(destDir, `.${exe(name)}.tmp-${process.pid}`);
    fs.copyFileSync(built, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
    console.log(`build-native: staged ${path.relative(desktop, path.join(destDir, exe(name)))}`);
}

// ts-rs exports write line-trailing whitespace that fails git diff --check.
// Normalize only that (generated files keep all other bytes), never source.
const generatedDir = path.join(desktop, 'scope-extension', 'src', 'common', 'generated');
if (fs.existsSync(generatedDir)) {
    for (const name of fs.readdirSync(generatedDir)) {
        if (!name.endsWith('.ts')) { continue; }
        const file = path.join(generatedDir, name);
        const text = fs.readFileSync(file, 'utf8');
        const fixed = text.replace(/[\t ]+$/gm, '');
        if (fixed !== text) {
            fs.writeFileSync(file, fixed);
            console.log(`build-native: normalized generated ${name}`);
        }
    }
}
