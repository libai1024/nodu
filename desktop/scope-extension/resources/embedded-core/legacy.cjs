// SPDX-License-Identifier: MIT
// Copy verified legacy records; never modify or restore the source store.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
module.exports = function migrate(source, target) {
  if (typeof source !== 'string' || !path.isAbsolute(source) || !fs.existsSync(source)) return;
  const original = path.join(source, 'stm32/backups'), destination = path.join(target, 'stm32/backups');
  if (fs.existsSync(original) && !fs.lstatSync(original).isSymbolicLink()) for (const chip of fs.readdirSync(original)) {
    if (!/^[a-f0-9]{3}-[a-f0-9]{24}$/.test(chip)) continue;
    const folder = path.join(original, chip); if (!fs.lstatSync(folder).isDirectory() || fs.lstatSync(folder).isSymbolicLink()) continue;
    for (const stamp of fs.readdirSync(folder)) {
      if (!/^\d{8}-\d{6}$/.test(stamp)) continue;
      const slot = path.join(folder, stamp), out = path.join(destination, chip, stamp);
      if (fs.existsSync(out) || fs.lstatSync(slot).isSymbolicLink()) continue;
      try {
        const image = path.join(slot, 'flash.bin'), meta = path.join(slot, 'backup.json');
        if (fs.lstatSync(image).isSymbolicLink() || fs.lstatSync(meta).isSymbolicLink() || fs.statSync(image).size > 2 * 1024 * 1024) continue;
        const record = JSON.parse(fs.readFileSync(meta)), bytes = fs.readFileSync(image);
        if (record.uid !== chip.slice(4) || record.bytes !== bytes.length || record.flashKiB * 1024 !== bytes.length || record.sha256 !== sha(bytes)) continue;
        const staging = out + '.tmp-' + crypto.randomUUID(); fs.mkdirSync(staging, { recursive: true, mode: 0o700 }); fs.copyFileSync(image, path.join(staging, 'flash.bin')); fs.copyFileSync(meta, path.join(staging, 'backup.json')); fs.renameSync(staging, out);
      } catch { /* Invalid records remain in the original store for explicit review. */ }
    }
  }
  try {
    const before = JSON.parse(fs.readFileSync(path.join(source, 'stm32/trusted-projects.json'))), file = path.join(target, 'stm32/trusted-projects.json');
    const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { schema: 1, projects: [] };
    const projects = new Set(current.projects);
    for (const project of before.projects || []) if (typeof project === 'string' && path.isAbsolute(project) && fs.existsSync(path.join(project, 'nodu.json'))) projects.add(fs.realpathSync(project));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ schema: 1, projects: [...projects] }), { mode: 0o600 }); fs.renameSync(tmp, file);
  } catch { /* Absence never grants trust. */ }
};
