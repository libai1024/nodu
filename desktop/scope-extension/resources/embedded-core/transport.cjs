// SPDX-License-Identifier: MIT
const { Client } = require('./client.cjs');
const { createInterface } = require('node:readline');
const options = {};
for (let i = 2; i < process.argv.length; i += 2) options[process.argv[i].slice(2)] = process.argv[i + 1];
const client = new Client({ binary: options.binary, resources: options.resources, toolkit: options.toolkit, app: options.app || 'dacir', role: 'desktop', legacyData: options['data-dir'], launcher: options.app === 'nodu' ? process.env.NODU_APP_EXECUTABLE : process.env.STUDIO_APP_EXECUTABLE, launchArgs: options.app === 'nodu' ? [] : JSON.parse(process.env.STUDIO_APP_ARGUMENTS || '[]') });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
client.on('event', (event, data) => send({ event, data }));
const reader = createInterface({ input: process.stdin });
reader.on('line', line => {
  if (line.length > 4 * 1024 * 1024) return;
  let m; try { m = JSON.parse(line); } catch { return; }
  client.request(m.method, m.args || {}).then(result => send({ id: m.id, result }), e => send({ id: m.id, error: e.message, code: e.code, detail: e.detail }));
});
reader.on('close', () => client.close());
