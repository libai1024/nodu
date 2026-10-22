// SPDX-License-Identifier: MIT
// Drive the nodu-embedded sidecar from a terminal (development and hardware
// evidence). Each argument is one request: `method` or `method:{json args}`;
// requests run in order and `path` defaults to --project.
//
//   node scripts/stm32-cli.cjs --project /tmp/blink catalog \
//     'createProject:{"parent":"/tmp","name":"blink","board":"generic-f103c8","template":"uart-hello"}' \
//     build identify flash
const { spawn } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { parseArgs } = require('node:util');

const desktop = path.resolve(__dirname, '..');
const platformDir = process.platform === 'win32' ? 'win32-x64' : process.platform;
const { values: opts, positionals } = parseArgs({
    options: {
        project: { type: 'string' },
        bin: { type: 'string', default: path.join(desktop, 'native/target/release', process.platform === 'win32' ? 'nodu-embedded.exe' : 'nodu-embedded') },
        toolkit: { type: 'string', default: path.join(desktop, '.tools/stm32', platformDir) },
        'data-dir': { type: 'string', default: path.join(os.homedir(), '.nodu') },
        verbose: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
    },
    allowPositionals: true,
});
const requests = positionals.map(arg => {
    const split = arg.indexOf(':');
    const method = split < 0 ? arg : arg.slice(0, split);
    const args = split < 0 ? {} : JSON.parse(arg.slice(split + 1));
    if (opts.project && args.path === undefined) { args.path = opts.project; }
    return { method, args };
});
const child = spawn(opts.bin, ['--resources', path.join(desktop, 'scope-extension/resources/stm32'),
    '--toolkit', opts.toolkit, '--data-dir', opts['data-dir']], { stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map();
let failed = false;
readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.event) {
        const { event, data } = message;
        if (event === 'build.output' || event === 'flash.output') { if (opts.verbose) { console.log(`  │ ${data.line}`); } return; }
        if (event === 'build.progress') { if (data.total) { process.stdout.write(`  [${data.done}/${data.total}] ${data.file}\n`); } return; }
        console.log(`  · ${event} ${JSON.stringify(data).slice(0, 400)}`);
        return;
    }
    const done = pending.get(message.id);
    pending.delete(message.id);
    done?.(message);
});
let id = 0;
function send(method, args) {
    return new Promise(resolve => {
        pending.set(++id, resolve);
        child.stdin.write(JSON.stringify({ id, method, args }) + '\n');
    });
}
(async () => {
    for (const { method, args } of requests) {
        console.log(`→ ${method} ${JSON.stringify(args)}`);
        const reply = await send(method, args);
        if (reply.error) {
            failed = true;
            console.log(`✕ ${method}: [${reply.code}] ${reply.error}`);
            if (reply.detail?.output) { console.log(reply.detail.output.split('\n').slice(-25).map(l => `  │ ${l}`).join('\n')); }
            break;
        }
        const result = reply.result;
        if (opts.json) { console.log(JSON.stringify(result, null, 2)); }
        else if (method === 'build') {
            const flash = result.capacity?.FLASH; const ram = result.capacity?.RAM;
            console.log(`✓ build ok=${result.ok} errors=${result.errors} warnings=${result.warnings} ${result.ms} ms`
                + (flash ? ` FLASH ${flash.used}/${flash.size} RAM ${ram?.used}/${ram?.size}` : '')
                + (result.artifact ? ` bundle ${result.artifact.bundleSha256.slice(0, 12)} bin ${result.artifact.binaryBytes} B` : ''));
            for (const d of result.diagnostics || []) {
                console.log(`  ${d.severity} ${d.file || ''}:${d.line || ''}:${d.column || ''} ${d.message}`);
                if (d.explanation) { console.log(`    → ${d.explanation.title}｜${d.explanation.fix}`); }
            }
            if (!result.ok) { failed = true; }
        } else {
            console.log(`✓ ${method} ${JSON.stringify(result).slice(0, 1200)}`);
        }
    }
    child.stdin.end();
})();
child.on('exit', () => process.exit(failed ? 1 : 0));
