// SPDX-License-Identifier: MIT
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Keep a marked Windows portable distribution's own writable data beside it. */
function configurePortableProfile({ app, executable = process.execPath, platform = process.platform, env = process.env }) {
    if (platform !== 'win32' || !app.isPackaged || env.NODU_PROFILE_DIR) { return undefined; }
    const marker = path.join(path.dirname(executable), 'NoduPortable.json');
    if (!fs.existsSync(marker)) { return undefined; }
    const settings = JSON.parse(fs.readFileSync(marker, 'utf8'));
    if (settings.schema !== 1 || settings.dataDirectory !== 'Data') { throw new Error('Invalid Nodu portable configuration'); }
    const root = path.join(path.dirname(executable), 'Data');
    const folders = { NODU_PROFILE_DIR: 'profile', NODU_EMBEDDED_HOME: 'embedded', NODU_RESOURCES_HOME: 'resources',
        NODU_ARDUINO_HOME: 'arduino', NODU_PROJECTS_DIR: 'Projects', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', TEMP: 'temp', TMP: 'temp' };
    for (const [key, directory] of Object.entries(folders)) {
        const value = path.join(root, directory);
        fs.mkdirSync(value, { recursive: true });
        env[key] = value;
    }
    app.setPath('appData', env.APPDATA);
    app.setPath('temp', env.TEMP);
    return root;
}

module.exports = { configurePortableProfile };
