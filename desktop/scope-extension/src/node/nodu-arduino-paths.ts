// SPDX-License-Identifier: MIT
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

export function arduinoResources(): string {
    const candidates = [process.env.NODU_ARDUINO_RESOURCES, join(__dirname, '../../resources/arduino'),
        join(__dirname, '../../../scope-extension/resources/arduino'), join(__dirname, '../../scope-extension/resources/arduino'),
        join(dirname(createRequire(__filename).resolve('@scope/studio-extension/package.json')), 'resources/arduino')];
    const result = candidates.find(path => path && existsSync(join(path, 'libraries/manifest.json')));
    if (!result) { throw new Error('Arduino 内置资源缺失，请修复 Nodu 安装。'); }
    return result;
}
