// SPDX-License-Identifier: MIT
// Build the Rust device sidecar for the host and stage it into
// scope-extension/resources/bin/<platform>-<arch>/nodu-device[.exe].
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const native = path.join(desktop, 'native');

const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'x64' ? 'x64' : process.arch;
const exe = platform === 'win32' ? 'nodu-device.exe' : 'nodu-device';

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
console.log('build-native: cargo build --release --locked -p nodu-device --features mock');
execSync('cargo build --release --locked -p nodu-device --features mock', {
    cwd: native,
    stdio: 'inherit',
    env,
});

const built = path.join(native, 'target', 'release', exe);
if (!fs.existsSync(built)) {
    console.error(`build-native: expected ${built} after cargo build`);
    process.exit(1);
}
const destDir = path.join(
    desktop, 'scope-extension', 'resources', 'bin', `${platform}-${arch}`);
fs.mkdirSync(destDir, { recursive: true });
fs.copyFileSync(built, path.join(destDir, exe));
fs.chmodSync(path.join(destDir, exe), 0o755);
console.log(`build-native: staged ${path.relative(desktop, path.join(destDir, exe))}`);
