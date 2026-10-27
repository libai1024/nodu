// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gzipSync } = require('node:zlib');
const { arduinoArchiveFile } = require('../lib/node/nodu-arduino-toolchain');
function tar(entries) {
    const chunks = [];
    for (const [name, text, type = 48] of entries) {
        const bytes = Buffer.from(text), header = Buffer.alloc(512); header.write(name); header.write(bytes.length.toString(8).padStart(11, '0'), 124); header[156] = type;
        chunks.push(header, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
    }
    chunks.push(Buffer.alloc(1024)); return gzipSync(Buffer.concat(chunks));
}
test('installer extracts only the named regular executable, never archive paths or symlinks', () => {
    const archive = tar([['../../arduino-cli', 'evil'], ['arduino-cli', 'symlink', 50], ['arduino-cli', 'valid'], ['LICENSE.txt', 'license']]);
    assert.equal(arduinoArchiveFile(archive, false, 'arduino-cli').toString(), 'valid');
    assert.equal(arduinoArchiveFile(archive, false, 'LICENSE.txt').toString(), 'license');
    assert.throws(() => arduinoArchiveFile(tar([['../../arduino-cli', 'evil']]), false, 'arduino-cli'), /缺少/);
});
test('installer rejects broken gzip/zip archives and truncated tar data', () => {
    assert.throws(() => arduinoArchiveFile(Buffer.from('broken'), false, 'arduino-cli'));
    assert.throws(() => arduinoArchiveFile(Buffer.from('broken'), true, 'arduino-cli'), /目录无效/);
    const header = Buffer.alloc(512); header.write('arduino-cli'); header.write('00000004000', 124); header[156] = 48;
    assert.throws(() => arduinoArchiveFile(gzipSync(header), false, 'arduino-cli'), /不完整/);
});
