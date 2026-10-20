// SPDX-License-Identifier: MIT
// Build the Rust device sidecar + standalone terminal and stage them into
// scope-extension/resources/bin/<platform>-<arch>/. On macOS both
// architectures are built and lipo'd into a universal binary, staged under
// darwin-arm64 and darwin-x64 so the existing lookup keeps working.
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktop = path.resolve(__dirname, '..');
const native = path.join(desktop, 'native');

const platform = process.platform === 'win32' ? 'win32' : process.platform;
const arch = process.arch === 'x64' ? 'x64' : process.arch;
const names = ['nodu-device', 'nodu-terminal'];
const exe = name => (platform === 'win32' ? `${name}.exe` : name);
// Rust target triples per staging dir; non-macOS hosts stay single-arch.
const MACOS_TARGETS = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
};
const MACOS_DEPLOYMENT = '15.0';
const buildDirs =
    platform === 'darwin' ? Object.keys(MACOS_TARGETS) : [`${platform}-${arch}`];

// `mock` feature stays in the shipped binary: it is inert unless --mock is
// passed (dev/tests only, via NODU_DEVICE_MOCK=1).
const os = require('node:os');
const pathKey =
    Object.keys(process.env).find(key => key.toLowerCase() === 'path') || 'PATH';
const env = {
    ...process.env,
    // The media bundle's gate is minos <= 15.0; keep the sidecars inside it.
    MACOSX_DEPLOYMENT_TARGET: platform === 'darwin' ? MACOS_DEPLOYMENT : undefined,
    [pathKey]: [path.join(os.homedir(), '.cargo', 'bin'), process.env[pathKey] || '']
        .join(path.delimiter),
};
const cargoArgs = '--release --locked -p nodu-device --features mock --bins';
for (const dir of buildDirs) {
    const target = MACOS_TARGETS[dir];
    const targetArg = target ? ` --target ${target}` : '';
    console.log(`build-native: cargo build ${cargoArgs}${targetArg}`);
    execSync(`cargo build ${cargoArgs}${targetArg}`, {
        cwd: native,
        stdio: 'inherit',
        env,
    });
}

function builtPath(dir, name) {
    const target = MACOS_TARGETS[dir];
    return path.join(
        native, 'target', target || '', 'release', exe(name));
}

function stage(dir, source, name) {
    const destDir = path.join(
        desktop, 'scope-extension', 'resources', 'bin', dir);
    fs.mkdirSync(destDir, { recursive: true });
    // macOS keeps a provenance record per inode: overwriting a signed binary in
    // place makes the kernel kill the next exec/mmap of it. Stage via rename so
    // the destination is always a fresh inode.
    const dest = path.join(destDir, exe(name));
    const tmp = path.join(destDir, `.${exe(name)}.tmp-${process.pid}`);
    fs.copyFileSync(source, tmp);
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
    console.log(`build-native: staged ${path.relative(desktop, dest)}`);
}

for (const name of names) {
    if (platform === 'darwin') {
        // lipo the two arch slices into one universal binary, then stage it
        // under both arch dirs — packaged apps resolve by process arch.
        const universal = path.join(native, 'target', 'universal', exe(name));
        fs.mkdirSync(path.dirname(universal), { recursive: true });
        execSync(
            `lipo -create ${buildDirs
                .map(dir => JSON.stringify(builtPath(dir, name)))
                .join(' ')} -output ${JSON.stringify(universal)}`,
            { stdio: 'inherit' });
        const info = execSync(`lipo -info ${JSON.stringify(universal)}`)
            .toString();
        for (const dir of buildDirs) {
            const target = MACOS_TARGETS[dir];
            const slice = target.endsWith('darwin')
                ? ({ 'aarch64-apple-darwin': 'arm64',
                     'x86_64-apple-darwin': 'x86_64' })[target]
                : target;
            if (!info.includes(slice)) {
                console.error(
                    `build-native: universal ${name} missing ${slice}: ${info}`);
                process.exit(1);
            }
            stage(dir, universal, name);
        }
    } else {
        const built = builtPath(buildDirs[0], name);
        if (!fs.existsSync(built)) {
            console.error(`build-native: expected ${built} after cargo build`);
            process.exit(1);
        }
        stage(buildDirs[0], built, name);
    }
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
