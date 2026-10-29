// SPDX-License-Identifier: MIT
const { Client } = require('./client.cjs');
const { config } = require('./runtime-config.cjs');
const { createInterface } = require('node:readline');
const client = new Client(config());
const reader = createInterface({ input: process.stdin });
reader.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } client.request(m.method, m.args, m.timeout || 2500).then(result => process.stdout.write(JSON.stringify({ id: m.id, result }) + '\n'), error => process.stdout.write(JSON.stringify({ id: m.id, error: error.message, code: error.code }) + '\n')); });
reader.on('close', () => client.close());
