// SPDX-License-Identifier: MIT
const { app, BrowserWindow, Menu } = require('electron');
const path = require('node:path');
const dir = process.argv[2];
if (!dir) throw Error('Pass the fixture output directory');
app.setPath('userData', path.join(dir, 'native-profile'));
app.whenReady().then(() => {
    const win = new BrowserWindow({ width: 1120, height: 900, title: 'Nodu 会话界面验收', webPreferences: { contextIsolation: true, nodeIntegration: false } });
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: '验收', submenu: [{ role: 'reload' }, { role: 'quit' }] }, { role: 'editMenu' }]));
    win.loadFile(path.join(dir, 'index.html'), { query: { theme: process.argv[3] === 'dark' ? 'dark' : 'light', width: process.argv[4] === '460' ? '460' : '620' } });
});
app.on('window-all-closed', () => app.quit());
