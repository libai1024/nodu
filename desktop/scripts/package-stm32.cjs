// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function validateToolkit(root) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'toolkit.json'), 'utf8'));
    if (manifest.profile !== 'release') throw new Error('STM32 发布需要 profile=release 的工具包；不能分发 Xcode/Homebrew 开发工具包。');
    if (!Array.isArray(manifest.files) || !manifest.files.length) throw new Error('STM32 工具包没有文件清单');
    for (const file of manifest.files) {
        if (!file.path || path.isAbsolute(file.path) || file.path.split(/[\\/]/).some(p => p === '..' || p === '')) throw new Error('STM32 清单路径无效');
        const target = path.resolve(root, file.path);
        const real = fs.realpathSync(target);
        if (!real.startsWith(fs.realpathSync(root) + path.sep)) throw new Error(`STM32 文件越界：${file.path}`);
        if (!fs.statSync(target).isFile() || fs.statSync(target).size !== file.size || hash(target) !== file.sha256) throw new Error(`STM32 工具包文件损坏：${file.path}`);
    }
    if (!manifest.files.some(f => f.path.startsWith('licenses/'))) throw new Error('STM32 工具包缺少许可文件');
    // Release producers must provide actual source archives alongside the package.
    if (!Array.isArray(manifest.sourceArchives) || !manifest.sourceArchives.length) throw new Error('STM32 工具包缺少对应源码归档记录');
    for (const source of manifest.sourceArchives) {
        if (!manifest.files.some(f => f.path === source.path && f.sha256 === source.sha256)) throw new Error('STM32 源码归档不在校验清单内');
    }
    return manifest;
}
function toolkitSource(desktop, platform, arch) {
    const base = process.env.NODU_STM32_RELEASE_TOOLKITS;
    return base ? path.join(base, `${platform}-${arch}`) : path.join(desktop, 'scope-extension/resources/toolkits/stm32', platform === 'win32' ? `win32-${arch}` : platform);
}
function copyToolkit(source, resources, platform, arch) {
    validateToolkit(source);
    const dest = path.join(resources, 'toolkits/stm32', platform === 'win32' ? `win32-${arch}` : platform);
    fs.cpSync(source, dest, { recursive: true, dereference: true });
    return dest;
}
// codesign and lipo change Mach-O bytes. Regenerate the manifest AFTER them,
// before signing the containing .app, or first-run integrity checks always fail.
function refreshManifests(appPath) {
    const visit = dir => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.name === 'toolkit.json' && dir.includes(`${path.sep}toolkits${path.sep}stm32${path.sep}`)) {
                const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
                for (const record of manifest.files) { const full = path.join(dir, record.path); record.size = fs.statSync(full).size; record.sha256 = hash(full); }
                manifest.totalBytes = manifest.files.reduce((total, record) => total + record.size, 0);
                fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n');
            }
        }
    };
    visit(appPath);
}
function prepareUniversal(armApp, x64App) {
    const relative = 'Contents/Resources/app/node_modules/@scope/studio-extension/resources/toolkits/stm32/darwin/toolkit.json';
    const armFile = path.join(armApp, relative), x64File = path.join(x64App, relative);
    const arm = JSON.parse(fs.readFileSync(armFile)), x64 = JSON.parse(fs.readFileSync(x64File));
    if (arm.id !== x64.id || arm.version !== x64.version || JSON.stringify(arm.files.map(f => f.path).sort()) !== JSON.stringify(x64.files.map(f => f.path).sort())) {
        throw new Error('universal STM32 工具包版本或文件列表不一致');
    }
    // Only normalize the derived manifest; ordinary files still must match.
    // Refresh sizes/hashes after lipo and individual binary signing.
    arm.hostArch = 'universal';
    const data = JSON.stringify(arm, null, 2) + '\n';
    fs.writeFileSync(armFile, data); fs.writeFileSync(x64File, data);
}
module.exports = { validateToolkit, toolkitSource, copyToolkit, refreshManifests, prepareUniversal };
