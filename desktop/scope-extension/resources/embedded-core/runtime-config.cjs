// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
function config(app = 'dacir', role = 'desktop') {
  const adjacent = path.dirname(__dirname);
  const development = path.resolve(__dirname, '../../apps/studio-integration/.runtime/embedded-core');
  const root = process.env.STUDIO_EMBEDDED_PACKAGE || (fs.existsSync(path.join(adjacent, 'toolkit/toolkit.json')) ? adjacent : development);
  return { binary: process.env.STUDIO_NODU_EMBEDDED_BINARY || path.join(root, process.platform === 'win32' ? 'nodu-embedded.exe' : 'nodu-embedded'), resources: process.env.STUDIO_NODU_RESOURCES || path.join(root, 'resources'), toolkit: process.env.STUDIO_NODU_TOOLKIT || path.join(root, 'toolkit'), app, role };
}
module.exports = { config };
