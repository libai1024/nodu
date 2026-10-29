// SPDX-License-Identifier: MIT
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('./client.cjs');
async function main() {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { config } = require('./runtime-config.cjs');
  const client = new Client(config(request.app || 'dacir', request.role || 'desktop'));
  if (request.method === 'linkedBuild') process.once('SIGTERM', () => { void client.request('cancel', { queue: 'build' }, 5000).finally(() => { client.close(); process.exit(143); }); });
  process.stdout.on('error', () => { client.close(); process.exitCode = 1; });
  client.on('event', (event, data) => process.stderr.write(JSON.stringify({ event, data }) + '\n'));
  try { const result = await client.request(request.method, request.args); process.stdout.write(JSON.stringify({ ok: true, result })); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message, code: e.code, detail: e.detail })); process.exitCode = 1; }
  finally { client.close(); }
}
main().catch(e => { process.stderr.write(e.message); process.exitCode = 1; });
