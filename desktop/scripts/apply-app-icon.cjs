#!/usr/bin/env node
// SPDX-License-Identifier: MIT
'use strict';

// Replaces the bundled Electron.app icon and display name with the Nodu
// brand assets so the development app shows correctly in Launchpad/Dock.
// node_modules is not tracked, so this runs on every electron launch; the
// patch is idempotent and re-applies after any Electron upgrade.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DISPLAY_NAME = '见微 Nodu';

function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readPlistKey(plist, key) {
    try {
        return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], {
            encoding: 'utf8',
        }).trim();
    } catch {
        return undefined;
    }
}

function writePlistKey(plist, key, value) {
    if (readPlistKey(plist, key) === value) {
        return false;
    }
    try {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], {
            stdio: 'pipe',
        });
    } catch {
        execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist]);
    }
    return true;
}

function applyAppIcon(root) {
    if (process.platform !== 'darwin') {
        return false;
    }
    const source = path.resolve(root, '..', 'brand', 'assets', 'Nodu.icns');
    const electronApp = path.join(
        root,
        'node_modules',
        'electron',
        'dist',
        'Electron.app'
    );
    const target = path.join(electronApp, 'Contents', 'Resources', 'electron.icns');
    const plist = path.join(electronApp, 'Contents', 'Info.plist');
    if (!fs.existsSync(source) || !fs.existsSync(electronApp)) {
        return false;
    }
    let changed = false;
    if (!fs.existsSync(target) || sha256(source) !== sha256(target)) {
        fs.copyFileSync(source, target);
        changed = true;
    }
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
        if (writePlistKey(plist, key, DISPLAY_NAME)) {
            changed = true;
        }
    }
    if (changed) {
        // Bumping the .app mtime makes Finder/Launchpad drop the cached icon.
        const now = new Date();
        fs.utimesSync(electronApp, now, now);
        try {
            execFileSync('/usr/bin/touch', ['-c', electronApp]);
        } catch {
            // utimesSync already ran; ignore touch failures.
        }
    }
    return changed;
}

if (require.main === module) {
    const root = path.resolve(__dirname, '..');
    console.log(applyAppIcon(root) ? 'Nodu: application icon applied' : 'Nodu: application icon already current');
}

module.exports = { applyAppIcon };
