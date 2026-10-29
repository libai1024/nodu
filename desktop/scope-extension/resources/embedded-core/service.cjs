// SPDX-License-Identifier: MIT
// A single local native coordinator shared by Nodu and DACIR.
const net = require('node:net');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { endpoint, home, PROTOCOL, coreDigest } = require('./client.cjs');
const config = JSON.parse(Buffer.from(process.argv[2], 'base64').toString());
const root = home(); fs.mkdirSync(root, { recursive: true, mode: 0o700 });
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const canonical = file => fs.realpathSync(file);
function fileHash(file) { const h = crypto.createHash('sha256'), fd = fs.openSync(file, 'r'), block = Buffer.alloc(1024 * 1024); try { let length; while ((length = fs.readSync(fd, block, 0, block.length, null))) h.update(block.subarray(0, length)); } finally { fs.closeSync(fd); } return h.digest('hex'); }
function treeHash(folder) { const h = crypto.createHash('sha256'); function walk(relative) { const file = path.join(folder, relative), stat = fs.lstatSync(file); if (stat.isSymbolicLink()) throw new Error('运行资源不能为符号链接。'); if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name)); else if (stat.isFile()) h.update(relative).update(fileHash(file)); } walk(''); return h.digest('hex'); }
const serviceIdentity = { core: coreDigest(__dirname), binary: fileHash(config.binary), resources: treeHash(config.resources), toolkit: fileHash(path.join(config.toolkit, 'toolkit.json')) };
let serialLogLimit = 64 * 1024 * 1024;
try { const value = JSON.parse(fs.readFileSync(path.join(root, 'settings.json'))).serialLogLimitBytes; if (Number.isSafeInteger(value) && value >= 1048576 && value <= 1073741824) serialLogLimit = value; } catch {}
let toolkitReady = false, nativeReady = false;
const checkedToolkit = new Map();
function sharedToolkit() {
  if (toolkitReady) {
    const manifest = read(path.join(config.toolkit, 'toolkit.json'));
    if (fileHash(path.join(config.toolkit, 'toolkit.json')) !== serviceIdentity.toolkit) throw new Error('工具包锁已改变，请重新连接匹配版本。');
    for (const item of manifest.files) { const file = path.join(config.toolkit, item.path), stat = fs.statSync(file), stamp = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`; if (checkedToolkit.get(item.path) !== stamp) { if (stat.size !== item.size || fileHash(file) !== item.sha256) throw new Error('共同工具包已被修改，操作停止。'); checkedToolkit.set(item.path, stamp); } }
    return;
  }
  const manifest = read(path.join(config.toolkit, 'toolkit.json')), digest = fileHash(path.join(config.toolkit, 'toolkit.json'));
  if (digest !== serviceIdentity.toolkit) throw new Error('工具包版本已变化。');
  const cache = path.join(root, 'toolkits', digest);
  if (!fs.existsSync(path.join(cache, 'toolkit.json'))) {
    const staging = cache + '.' + crypto.randomUUID() + '.tmp'; fs.mkdirSync(path.dirname(cache), { recursive: true });
    try { fs.cpSync(config.toolkit, staging, { recursive: true, dereference: true, mode: fs.constants.COPYFILE_FICLONE }); fs.renameSync(staging, cache); } catch (error) { fs.rmSync(staging, { recursive: true, force: true }); throw error; }
  }
  for (const item of manifest.files) { const file = path.join(cache, item.path); if (path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..') || !fs.existsSync(file) || fs.statSync(file).size !== item.size || fileHash(file) !== item.sha256) throw new Error('共同工具包校验失败；请修复资源后继续。'); }
  config.toolkit = cache; toolkitReady = true; sharedToolkit();
}
const failure = (code, message, detail) => Object.assign(new Error(message), { code, detail });
const atomic = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); const tmp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 }); fs.renameSync(tmp, file); };
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const clients = new Set(), jobs = new Map(), editors = new Map(), reservations = new Map();
const snapshotOrigins = new Map(), editReservations = new Map();
let child, sequence = 0, inflight = new Map(), monitor, activeDevices = 0;
const deviceOperations = new Map();
let monitorQueue = Promise.resolve(), buildQueue = Promise.resolve(), activeBuildOwner, activeDeviceOwner;
const buildRequests = new Map();
function publish(event, data, subset) { for (const c of subset || clients) if (!c.socket.destroyed) c.socket.write(JSON.stringify({ event, data }) + '\n'); }
function native() {
  sharedToolkit();
  if (!nativeReady) {
    const binary = path.join(root, 'binaries', serviceIdentity.binary, process.platform === 'win32' ? 'nodu-embedded.exe' : 'nodu-embedded');
    fs.mkdirSync(path.dirname(binary), { recursive: true });
    if (!fs.existsSync(binary)) fs.copyFileSync(config.binary, binary);
    if (fileHash(binary) !== serviceIdentity.binary) throw new Error('共同原生程序摘要不匹配。');
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    const resources = path.join(root, 'resources', serviceIdentity.resources);
    if (!fs.existsSync(resources)) fs.cpSync(config.resources, resources, { recursive: true });
    if (treeHash(resources) !== serviceIdentity.resources) throw new Error('共同资源摘要不匹配。');
    config.binary = binary; config.resources = resources; nativeReady = true;
  }
  if (child) return child;
  child = spawn(config.binary, ['--resources', config.resources, '--toolkit', config.toolkit, '--data-dir', path.join(root, 'native')], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, NODU_STM32_TOOLKIT: config.toolkit } });
  const spawned = child;
  child.stderr.resume();
  createInterface({ input: child.stdout }).on('line', line => {
    if (child !== spawned) return;
    let m; try { m = JSON.parse(line); } catch { return; }
    if (typeof m.id === 'number') { const p = inflight.get(m.id); if (!p) return; inflight.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(failure(m.code, m.error, m.detail)) : p.resolve(m.result); }
    else if (m.event?.startsWith('monitor.')) {
      if (!monitor) return;
      if (m.event === 'monitor.data' && typeof m.data?.data === 'string') receive(Buffer.from(m.data.data, 'base64'));
      if (m.event === 'monitor.state') {
        if (m.data.state === 'open' && ['disconnected', 'lent', 'suspended'].includes(monitor.state)) rotateSerial();
        monitor.state = m.data.state;
      }
      publish(m.event, { ...m.data, sessionId: monitor.id, owner: monitor.owner?.id, endOffset: monitor.end }, monitor.subscribers);
    } else if (m.event) {
      if (m.data?.path && snapshotOrigins.has(m.data.path)) m.data.path = snapshotOrigins.get(m.data.path);
      if (m.event.startsWith('build.')) {
        let request = m.data?.path ? buildRequests.get(m.data.path) : [...buildRequests.values()].find(record => record.nativeBuildId === m.data?.buildId);
        if (request && m.event === 'build.started') { request.nativeBuildId = m.data.buildId; request.logPath = path.join(root, 'build-logs', crypto.randomUUID() + '.log'); fs.mkdirSync(path.dirname(request.logPath), { recursive: true }); }
        if (request?.logPath && m.event === 'build.output' && typeof m.data?.line === 'string') fs.appendFileSync(request.logPath, m.data.line + '\n', { mode: 0o600 });
        publish(m.event, m.data, [...clients].filter(peer => request ? request.subscribers.has(peer.id) : peer.app === 'nodu'));
      } else publish(m.event, m.data);
    }
  });
  const lost = () => { if (child !== spawned) return; child = undefined; for (const p of inflight.values()) { clearTimeout(p.timer); p.reject(failure('outcomeUnknown', '原生服务退出；请查询操作记录，不能自动重试。')); } inflight.clear(); if (monitor) { monitor.state = 'disconnected'; monitor.indexDirty = true; publish('monitor.state', { state: 'disconnected', port: monitor.port, sessionId: monitor.id }, monitor.subscribers); } };
  child.stdin.on('error', lost); child.on('error', lost); child.on('exit', lost); return child;
}
function rpc(method, args = {}) {
  const p = native(), id = ++sequence;
  return new Promise((resolve, reject) => { const timer = setTimeout(() => { inflight.delete(id); reject(failure('outcomeUnknown', '原生操作等待超时。')); }, 900000); inflight.set(id, { resolve, reject, timer }); p.stdin.write(JSON.stringify({ id, method, args }) + '\n'); });
}
function rotateSerial() { flushSerialIndex(); monitor.id = crypto.randomUUID(); monitor.start = 0; monitor.end = 0; monitor.buffer = Buffer.alloc(0); monitor.logged = 0; monitor.logTruncated = false; monitor.log = path.join(root, 'serial', monitor.id + '.jsonl'); monitor.parts = []; monitor.lastLoggedRX = 0; monitor.indexDirty = true; }
function portKey(port) { let value = port; try { value = canonical(port); } catch {} return value.replace(/^\/dev\/tty\./, '/dev/cu.'); }
function receive(bytes) {
  if (!bytes.length) return;
  const offset = monitor.end; monitor.end += bytes.length;
  monitor.buffer = Buffer.concat([monitor.buffer, bytes]);
  if (monitor.buffer.length > 1048576) monitor.buffer = Buffer.from(monitor.buffer.subarray(-1048576));
  monitor.start = monitor.end - monitor.buffer.length;
  const entry = { direction: 'rx', offset, data: bytes.toString('base64'), at: Date.now() };
  logSerial(entry);
}
function flushSerialIndex() {
  if (!monitor?.indexDirty) return;
  atomic(path.join(root, 'serial', monitor.id + '.index.json'), { schema: 1, sessionId: monitor.id, port: monitor.port, baud: monitor.baud,
    endOffset: monitor.end, lastLoggedRXOffset: monitor.lastLoggedRX || 0, bytesLogged: monitor.logged, limitBytes: serialLogLimit,
    truncated: monitor.logTruncated, parts: monitor.parts || [], state: monitor.state });
  monitor.indexDirty = false;
}
function logSerial(entry) {
  const encoded = JSON.stringify(entry) + '\n', length = Buffer.byteLength(encoded);
  monitor.indexDirty = true;
  if (monitor.logged + length > serialLogLimit) { monitor.logTruncated = true; return; }
  try {
    monitor.parts ||= [];
    let part = monitor.parts.at(-1);
    if (!part || part.bytes + length > 1048576) { part = { file: `${monitor.id}-${String(monitor.parts.length).padStart(4, '0')}.jsonl`, bytes: 0 }; monitor.parts.push(part); }
    fs.appendFileSync(path.join(root, 'serial', part.file), encoded, { mode: 0o600 }); part.bytes += length; monitor.logged += length;
    if (entry.direction === 'rx') monitor.lastLoggedRX = entry.offset + Buffer.from(entry.data, 'base64').length;
  } catch { monitor.logTruncated = true; }
}
setInterval(() => { try { flushSerialIndex(); } catch { if (monitor) monitor.logTruncated = true; } }, 1000).unref();

function canonicalJSON(value) { if (Array.isArray(value)) return value.map(canonicalJSON); if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJSON(value[key])])); return value; }
function canonicalInput(name, data) {
  const value = ['nodu.json', 'studio.project.json'].includes(name) ? JSON.parse(data) : null;
  if (name === 'nodu.json') return Buffer.from(JSON.stringify(canonicalJSON(Object.fromEntries(['schema', 'kind', 'target', 'sdk', 'build'].filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]])))));
  if (name === 'studio.project.json') return Buffer.from(JSON.stringify(canonicalJSON({ mcu: value.mcu || value.target?.mcu || 'STM32F103C8T6', clockHz: value.clockHz || value.target?.clockHz || 72000000, build: { configHeader: value.build?.configHeader || 'include/config.h' } })));
  return data;
}
const sourceDirs = new Set(['src', 'include', 'drivers', 'nodu-support', 'cmake', 'Core', 'App', 'Board', 'Drivers', 'Startup', 'Linker']);
const sourceFiles = new Set(['CMakeLists.txt', 'CMakePresets.json', 'nodu.lock.json']);
function inputs(project) {
  const files = new Map(); let size = 0;
  const walk = (relative) => {
    const file = path.join(project, relative), st = fs.lstatSync(file);
    if (st.isSymbolicLink()) throw failure('inputSymlink', `构建输入不能为符号链接：${relative}`);
    if (st.isDirectory()) for (const name of fs.readdirSync(file).sort()) walk(path.join(relative, name));
    else if (st.isFile()) { size += st.size; if (size > 64 * 1024 * 1024 || files.size >= 10000) throw failure('inputLimit', '工程输入超过限制。'); files.set(relative.replaceAll('\\', '/'), fs.readFileSync(file)); }
  };
  for (const name of [...sourceDirs, ...sourceFiles]) if (fs.existsSync(path.join(project, name))) walk(name);
  const manifest = read(path.join(project, 'nodu.json'));
  const stable = { schema: manifest.schema, kind: manifest.kind, name: manifest.name, target: manifest.target, sdk: manifest.sdk, build: manifest.build };
  files.set('nodu.json', canonicalInput('nodu.json', JSON.stringify(stable)));
  const studio = read(path.join(project, 'studio.project.json'));
  const studioTarget = { mcu: studio.mcu || studio.target?.mcu, clockHz: studio.clockHz || studio.target?.clockHz };
  files.set('studio.project.json', canonicalInput('studio.project.json', JSON.stringify(studio)));
  if (studioTarget.mcu !== 'STM32F103C8T6' || studioTarget.clockHz !== 72000000) throw failure('unsupportedTarget', 'Studio 目标须为 STM32F103C8T6 / 72 MHz。');
  if (manifest.target?.mcu !== 'STM32F103C8Tx') throw failure('unsupportedTarget', '联动仅支持 STM32F103C8。');
  if (!['dacir-directory-v1', 'nodu-hal-f103-72mhz-v1'].includes(manifest.build?.adapter) || (manifest.build?.clockHz ?? 72000000) !== 72000000) throw failure('migrationRequired', '请先启用 STM32F103 / 72 MHz 联动配置。');
  const catalog = read(path.join(__dirname, 'profiles.json')), profiles = catalog.profiles;
  const hal72 = manifest.build?.adapter === 'nodu-hal-f103-72mhz-v1' && Object.entries(catalog.hal72).every(([name, expected]) => hash(files.get(name) || Buffer.alloc(0)) === expected) && /^cmake_minimum_required\(VERSION 3\.24\)\s+include\(cmake\/nodu-target\.cmake\)\s+project\([A-Za-z0-9_]+ LANGUAGES C ASM\)\s+include\(cmake\/nodu\.cmake\)$/.test((files.get('CMakeLists.txt') || Buffer.alloc(0)).toString().split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim());
  if (!hal72 && !profiles.some(profile => profile.cmakeSHA256 === hash(files.get('CMakeLists.txt') || Buffer.alloc(0)) && profile.toolchainSHA256 === hash(files.get('cmake/gcc-arm-none-eabi.cmake') || Buffer.alloc(0)))) throw failure('unsupportedRecipe', '构建配方不是已登记的联动配置；保留现有脚本，请显式迁移或审查配方。');
  const hashes = Object.fromEntries([...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([name, data]) => [name, hash(data)]));
  return { files, hashes, digest: hash(JSON.stringify(hashes)) };
}
function buildStale(project, result) {
  if (result.stale || inputs(project).digest !== result.inputDigest) return true;
  try { checkEditors(project); return false; } catch { return true; }
}
function checkEditors(project) {
  const matching = [...editors.values()].filter(e => e.path === project);
  if (!matching.length || matching.some(e => Date.now() - e.seen > 5000 || e.dirty.length)) throw failure('editorDirty', '请让两端工程编辑器保持打开并保存全部修改。', { editors: matching.map(e => ({ app: e.app, clientId: e.clientId, generation: e.generation, ageMs: Date.now() - e.seen, dirty: e.dirty, closed: !!e.closed })) });
}
async function waitForCleanEditors(project) {
  const deadline = Date.now() + 2000;
  for (;;) {
    try { checkEditors(project); return; } catch (error) {
      if (Date.now() >= deadline) throw error;
      // Save/build HTTP completion and native presence are separate channels.
      // Proceed only after every actual editor publishes a fresh clean state.
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
}
async function build(c, args) {
  const project = canonical(args.path);
  await waitForCleanEditors(project);
  const editorLease = editReservations.get(project);
  if (editorLease && editorLease.expiresAt > Date.now()) throw failure('editorBusy', '工程正在受保护的编辑事务中，请稍后编译。');
  if (args.studioInputs) {
    for (const [name, expected] of Object.entries(args.studioInputs)) {
      if (name.includes('..') || path.isAbsolute(name) || typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) throw failure('badInput', 'Studio 输入清单无效。');
      const file = path.join(project, name);
      if (fs.lstatSync(file).isSymbolicLink() || !canonical(file).startsWith(project + path.sep) || hash(canonicalInput(name, fs.readFileSync(file))) !== expected) throw failure('sourceChanged', 'Studio 快照与当前工程不一致。');
    }
  }
  const input = inputs(project), toolkitDigest = hash(fs.readFileSync(path.join(config.toolkit, 'toolkit.json')));
  const key = hash(project + input.digest + toolkitDigest);
  if (jobs.has(key)) { buildRequests.get(project)?.subscribers.add(c.id); return jobs.get(key); }
  if ([...reservations.keys()].some(p => p === project)) throw failure('buildBusy', '该工程正在准备另一构建。');
  const task = (async () => {
    reservations.set(project, crypto.randomUUID());
    const buildRequest = { owner: c.id, subscribers: new Set([c.id]), cancelled: false }; buildRequests.set(project, buildRequest);
    const currentFile = path.join(root, 'projects', hash(project) + '.json');
    if (fs.existsSync(currentFile)) { const previous = read(currentFile); if (previous.ok && previous.buildId) atomic(path.join(root, 'build-history', hash(project), previous.buildId + '.json'), previous); }
    atomic(currentFile, { ok: false, state: 'building', inputDigest: input.digest, projectPath: project });
    try {
      const status = await rpc('openProject', { path: project });
      if (!status.trusted) throw failure('untrusted', '请在 Nodu 中确认信任工程后编译。');
      const dir = path.join(root, 'workspaces', hash(project).slice(0, 24), toolkitDigest.slice(0, 16), serviceIdentity.core.slice(0, 16), 'project');
      fs.mkdirSync(dir, { recursive: true });
      const previous = fs.existsSync(path.join(dir, '.inputs.json')) ? read(path.join(dir, '.inputs.json')) : {};
      for (const name of Object.keys(previous)) if (!input.files.has(name)) fs.rmSync(path.join(dir, name), { force: true });
      for (const [name, data] of input.files) if (previous[name] !== input.hashes[name]) { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); }
      atomic(path.join(dir, '.inputs.json'), input.hashes);
      checkEditors(project);
      if (inputs(project).digest !== input.digest) throw failure('sourceChanged', '创建快照时工程发生变化。');
      snapshotOrigins.set(dir, project);
      await rpc('trustProject', { path: dir });
      const queued = buildQueue.then(async () => {
        if (buildRequest.cancelled) throw failure('cancelled', '构建已取消。');
        activeBuildOwner = c.id;
        try { return await rpc('build', { path: dir, clean: args.clean === true }); } finally { activeBuildOwner = undefined; }
      });
      buildQueue = queued.catch(() => {});
      const result = await queued;
      if (Array.isArray(result.diagnostics)) for (const d of result.diagnostics) { if (typeof d.absolute === 'string') d.absolute = d.absolute.replace(dir + path.sep, project + path.sep); }
      if (buildRequest.logPath && fs.existsSync(buildRequest.logPath)) { result.logPath = buildRequest.logPath; result.logSHA256 = fileHash(buildRequest.logPath); }
      result.inputDigest = input.digest; result.toolkitDigest = toolkitDigest; result.projectPath = project; result.snapshotPath = dir;
      result.stale = !!result.stale || inputs(project).digest !== input.digest;
      try { checkEditors(project); } catch { result.stale = true; }
      if (result.ok && result.artifact) {
        const bundle = result.artifact.bundleSha256;
        const origin = path.join(dir, '.nodu', 'artifacts', bundle), destination = path.join(root, 'artifacts', bundle);
        fs.mkdirSync(destination, { recursive: true });
        for (const name of ['firmware.elf', 'firmware.bin', 'firmware.hex', 'firmware.map']) { const data = fs.readFileSync(path.join(origin, name)); const out = path.join(destination, name); if (fs.existsSync(out) && hash(fs.readFileSync(out)) !== hash(data)) throw failure('artifactConflict', '已登记产物内容被修改。'); fs.writeFileSync(out, data); }
        if (!fs.existsSync(path.join(destination, 'artifact.json'))) atomic(path.join(destination, 'artifact.json'), result.artifact);
        atomic(path.join(root, 'build-manifests', hash(project), result.buildId + '.json'), result.artifact);
        result.bundlePath = destination;
        atomic(path.join(root, 'projects', hash(project) + '.json'), result);
      }
      if (!result.ok) atomic(currentFile, result);
      publish('link.build', result); return result;
    } catch (error) { atomic(currentFile, { ok: false, state: 'failed', projectPath: project, inputDigest: input.digest, error: error.message }); throw error;
    } finally { reservations.delete(project); jobs.delete(key); buildRequests.delete(project); }
  })(); jobs.set(key, task); return task;
}
async function handle(c, method, args) {
  if (method === 'hello') {
    if (args.protocol !== PROTOCOL || args.coreDigest !== serviceIdentity.core || fileHash(args.binary) !== serviceIdentity.binary || treeHash(args.resources) !== serviceIdentity.resources || fileHash(path.join(args.toolkit, 'toolkit.json')) !== serviceIdentity.toolkit) throw failure('versionMismatch', '联动组件或工具包版本不一致。');
    c.ready = true; c.role = args.role; c.app = args.app;
    if (c.role === 'desktop' && args.legacyData) require('./legacy.cjs')(args.legacyData, path.join(root, 'native'));
    if (c.role === 'desktop' && ['nodu', 'dacir'].includes(c.app) && typeof args.launcher === 'string' && path.isAbsolute(args.launcher) && fs.existsSync(args.launcher) && Array.isArray(args.launchArgs) && args.launchArgs.every(value => typeof value === 'string' && !value.includes('\0'))) atomic(path.join(root, 'launchers', c.app + '.json'), { executable: args.launcher, args: args.launchArgs });
    return { protocol: PROTOCOL, coreVersion: '1.0.0', capabilities: ['sharedBuild', 'sharedSerial', 'journal', 'leases'] };
  }
  if (!c.ready) throw failure('handshakeRequired', '请先连接共同服务。');
  if (c.role === 'agent' && method !== 'agentCall') throw failure('forbidden', 'Agent 仅可调用宿主硬件工具。');
  if (method === 'encodeText') { const bytes = require('./encoding.cjs').encode(args.text, args.encoding); if (bytes.length > 65536) throw failure('badRequest', '一次最多发送 64 KiB。'); return { data: bytes.toString('base64'), bytes: bytes.length }; }
  if (method === 'agentCall') return agentTools.execute(c, args);
  if (method === 'hardwareApprovals') { if (c.role !== 'desktop') throw failure('forbidden', '仅供桌面使用。'); return agentTools.pending(); }
  if (method === 'approveHardware') return agentTools.approve(c, args);
  if (method === 'linkInbox') {
    const folder = path.join(root, 'links'); if (!fs.existsSync(folder)) return [];
    return fs.readdirSync(folder).filter(n => n.endsWith('.json')).map(n => read(path.join(folder, n))).filter(r => r.target === c.app && r.state === 'pending' && r.expires > Date.now());
  }
  if (method === 'linkOpen') {
    const project = canonical(args.path), target = args.target;
    if (!['nodu', 'dacir'].includes(target) || !fs.existsSync(path.join(project, 'nodu.json')) || !fs.existsSync(path.join(project, 'studio.project.json'))) throw failure('badLink', '只能交接已登记的联动工程。');
    const id = hash(project + target), file = path.join(root, 'links', id + '.json');
    let record = fs.existsSync(file) ? read(file) : undefined;
    if (!record || record.state !== 'pending' || record.expires < Date.now()) { const peers = new Set([...clients].filter(peer => peer.app === target && peer.role === 'desktop').map(peer => peer.id));
    const matching = [...editors.values()].filter(editor => peers.has(editor.owner) && !editor.closed && Date.now() - editor.seen < 5000).sort((a, b) => Number(b.path === project) - Number(a.path === project) || b.seen - a.seen);
    record = { id, path: project, target, editorClientId: matching[0]?.clientId, state: 'pending', expires: Date.now() + 120000 }; atomic(file, record); }
    publish('link.open', record);
    const peerReady = () => [...clients].some(peer => peer.app === target && peer.role === 'desktop' && peer.ready && [...editors.values()].some(editor => editor.owner === peer.id && !editor.closed && Date.now() - editor.seen < 5000));
    {
      const launchPeer = async () => {
      let launcher; try { launcher = read(path.join(root, 'launchers', target + '.json')); } catch {}
      if (process.platform === 'darwin') {
        const selectedApp = (target === 'nodu' ? process.env.NODU_APP_PATH : process.env.DACIR_APP_PATH) || launcher?.executable || (target === 'nodu' ? 'Nodu' : 'DACIR');
        const app = selectedApp.match(/^(.*?\.app)(?:\/|$)/)?.[1] || selectedApp;
        const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE;
        await new Promise((resolve, reject) => { const launched = spawn('/usr/bin/open', ['-a', app, ...((launcher?.args || []).length ? ['--args', ...launcher.args] : [])], { stdio: 'ignore', env: environment }); launched.on('error', reject); launched.on('close', code => code === 0 ? resolve() : reject(failure('appUnavailable', '目标应用未安装或无法启动，请先打开对应桌面应用。'))); });
      } else {
        const executable = (target === 'nodu' ? process.env.NODU_APP_PATH : process.env.DACIR_APP_PATH) || launcher?.executable;
        if (!executable || !path.isAbsolute(executable) || !fs.existsSync(executable)) throw failure('appUnavailable', '目标应用尚未登记，请先打开一次对应桌面应用。');
        await new Promise((resolve, reject) => { const launched = spawn(executable, launcher?.args || [], { detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } }); launched.once('error', reject); launched.once('spawn', () => { launched.unref(); resolve(); }); });
      }
      };
      const deadline = Date.now() + 12000;
      let nextLaunch = 0, attempts = 0;
      while (true) {
        const latest = read(file);
        if (latest.state === 'opened') return latest;
        if (latest.state === 'rejected') throw failure('appUnavailable', '目标应用拒绝了工程交接，请查看对应应用的提示。');
        if (Date.now() >= deadline) {
          atomic(file, { ...latest, state: 'rejected', error: 'appNotReady' });
          throw failure('appUnavailable', '目标应用尚未就绪，交接未完成；请检查应用后重新打开。');
        }
        if (!peerReady() && Date.now() >= nextLaunch && attempts < 3) {
          const next = { ...latest }; delete next.editorClientId; atomic(file, next);
          try { await launchPeer(); } catch (error) { atomic(file, { ...latest, state: 'rejected', error: error.code || 'appUnavailable' }); throw error; }
          attempts++; nextLaunch = Date.now() + (attempts === 1 ? 3000 : 4000);
        }
        // Launch Services may still be retiring the old backend. A zero exit
        // code from `open` does not prove that the target editor is ready.
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    return record;
  }
  if (method === 'linkAcknowledge') {
    if (!/^[a-f0-9]{64}$/.test(args.id || '')) throw failure('badLink', '交接身份无效。'); const file = path.join(root, 'links', args.id + '.json'), record = read(file);
    if (record.target !== c.app) throw failure('badLink', '交接目标不匹配。'); record.state = args.accepted ? 'opened' : 'rejected'; atomic(file, record); return record;
  }
  if (method === 'linkResult') {
    const project = canonical(args.path); if (!args.result) { const file = path.join(root, 'results', hash(project) + '.json'); return fs.existsSync(file) ? read(file) : null; }
    const r = args.result; if (!['qemu', 'renode'].includes(r.engineId) || !/^[a-f0-9]{32}$/.test(r.runId || '') || !/^[a-f0-9]{64}$/.test(r.binarySHA256 || '')) throw failure('badResult', '仿真结果身份无效。');
    const record = { path: project, runId: r.runId, engineId: r.engineId, elfSHA256: r.binarySHA256, status: r.status, recordedAt: Date.now() }; atomic(path.join(root, 'results', hash(project) + '.json'), record); publish('link.result', record); return record;
  }
  if (method === 'reserveEditors') {
    const project = canonical(args.path), previous = editReservations.get(project);
    if (previous && previous.expiresAt > Date.now() && previous.id !== args.leaseId) throw failure('editorBusy', '另一会话正在保护工程编辑。');
    if (typeof args.leaseId !== 'string' || !Number.isSafeInteger(args.expiresAt) || args.expiresAt <= Date.now() || args.expiresAt > Date.now() + 10000) throw failure('badLease', '编辑租约无效。');
    editReservations.set(project, { id: args.leaseId, owner: c.id, expiresAt: args.expiresAt }); return { reserved: true };
  }
  if (method === 'releaseEditors') { const project = canonical(args.path), lease = editReservations.get(project); if (lease?.id === args.leaseId && lease.owner === c.id) { editReservations.delete(project); for (const [key, editor] of editors) if (editor.path === project && editor.closed && !editor.dirty.length) editors.delete(key); } return { released: true }; }
  if (method === 'editorProtection' || method === 'assertEditorLease') {
    const project = canonical(args.path), lease = editReservations.get(project), matching = [...editors.values()].filter(e => e.path === project);
    const ready = !!lease && lease.id === args.leaseId && lease.expiresAt > Date.now() && matching.length > 0 && matching.every(e => !e.dirty.length && e.ack === lease.id && Date.now() - e.seen < 5000);
    if (method === 'assertEditorLease' && !ready) throw failure('editorLeaseExpired', '共同编辑保护未确认或已失效。');
    return { ready, registered: matching.length, dirty: matching.some(e => e.dirty.length), unknown: matching.some(e => Date.now() - e.seen >= 5000), editors: matching.map(e => ({ app: e.app, clientId: e.clientId, ageMs: Date.now() - e.seen, dirty: e.dirty, closed: !!e.closed })) };
  }
  if (method === 'editorClose') {
    const project = canonical(args.path), key = project + '::' + (args.clientId || c.id), editor = editors.get(key);
    if (editor && editor.owner === c.id && editor.generation === args.generation) {
      editor.dirty = [...new Set([...editor.dirty, ...(Array.isArray(args.dirty) ? args.dirty : ['*'])])];
      const lease = editReservations.get(project);
      if (!editor.dirty.length && (!lease || lease.expiresAt <= Date.now())) editors.delete(key); else { editor.closed = true; if (editor.dirty.length) editor.seen = 0; }
    } return { closed: true };
  }
  if (method === 'editorPulse') { const p = canonical(args.path); if (!Array.isArray(args.dirty) || args.dirty.length > 4096) throw failure('badRequest', '草稿状态无效。'); const key = p + '::' + (args.clientId || c.id), previous = editors.get(key);
    if (previous && (args.generation || 0) < previous.generation) throw failure('staleEditor', '编辑器状态已过期。');
    const lease = editReservations.get(p), active = lease && lease.expiresAt > Date.now();
    editors.set(key, { path: p, app: c.app, dirty: args.dirty, clientId: args.clientId, generation: args.generation || 0, owner: c.id, seen: Date.now(), ack: active && args.ready === true && args.leaseId === lease.id && !args.dirty.length ? lease.id : undefined });
    return { reserved: reservations.has(p), requestedLeaseId: active ? lease.id : null, expiresAt: active ? lease.expiresAt : null }; }
  if (method === 'build' && fs.existsSync(path.join(args.path || '', 'studio.project.json'))) return build(c, args);
  if (method === 'linkedBuild') return build(c, args);
  if (method === 'cancel' && args.queue === 'build') {
    for (const request of buildRequests.values()) if (request.owner === c.id) request.cancelled = true;
    if (activeBuildOwner && activeBuildOwner !== c.id) throw failure('notOwner', '该编译由另一应用发起。');
    return activeBuildOwner === c.id ? rpc('cancel', args) : { cancelled: true };
  }
  if (method === 'cancel' && args.queue === 'device' && activeDeviceOwner && activeDeviceOwner !== c.id) throw failure('notOwner', '该设备操作由另一会话发起。');
  if (method === 'openProject' && fs.existsSync(path.join(args.path || '', 'studio.project.json'))) {
    const status = await rpc(method, args); status.currentBuild = null; status.buildStale = true;
    try { const last = read(path.join(root, 'projects', hash(canonical(args.path)) + '.json')); if (!last.ok) return status; snapshotOrigins.set(last.snapshotPath, canonical(args.path)); status.currentBuild = { bundle: last.artifact.bundleSha256, buildId: last.buildId }; status.buildStale = buildStale(canonical(args.path), last); } catch {}
    return status;
  }
  if (method === 'flash' && fs.existsSync(path.join(args.path || '', 'studio.project.json'))) {
    const project = canonical(args.path); checkEditors(project); const last = read(path.join(root, 'projects', hash(project) + '.json'));
    if (last.stale || inputs(project).digest !== last.inputDigest || args.bundle !== last.artifact.bundleSha256) throw failure('staleBuild', '源码或固件已变化，请重新编译。');
    snapshotOrigins.set(last.snapshotPath, project);
    args = { ...args, path: last.snapshotPath };
  }
  if (method === 'buildResult') { const project = canonical(args.path), result = read(path.join(root, 'projects', hash(project) + '.json')); result.stale = buildStale(project, result); return result; }
  if (method === 'resumeMonitor') {
    if (!monitor?.subscribers.has(c) || args.confirm !== true) throw failure('confirmationRequired', '恢复 BOOT 设置并复位后再继续。');
    const previous = monitor.id;
    await rpc('openMonitor', { port: monitor.port, baud: monitor.baud });
    if (monitor.id === previous) rotateSerial(); monitor.state = 'open';
    return serialStatus(c);
  }
  if (method === 'boardStatus') {
    if (!/^[a-f0-9]{32}$/.test(args.operationId || '')) throw failure('badRequest', '操作身份无效。');
    let record;
    try { record = read(path.join(root, 'native/stm32/dacir-bridge/operations', args.operationId, 'operation.json')); }
    catch { record = read(path.join(root, 'intents', args.operationId + '.json')); }
    if (['started', 'dispatching'].includes(record.state)) record.state = deviceOperations.has(args.operationId) ? 'running' : 'unknown'; return record;
  }
  if (method === 'cancelOperation') {
    if (deviceOperations.get(args.operationId) !== c.id) throw failure('notOwner', '只能停止本会话的操作。');
    return rpc('cancel', { queue: 'device' });
  }
  if (method === 'boardHistory') {
    const records = new Map();
    const intents = path.join(root, 'intents'), directory = path.join(root, 'native/stm32/dacir-bridge/operations');
    for (const [folder, nativeRecord] of [[intents, false], [directory, true]]) {
      if (!fs.existsSync(folder)) continue;
      for (const name of fs.readdirSync(folder)) {
        const id = nativeRecord ? name : name.replace(/\.json$/, '');
        if (!/^[a-f0-9]{32}$/.test(id)) continue;
        const file = nativeRecord ? path.join(folder, id, 'operation.json') : path.join(folder, name);
        try { const record = read(file); if (['started', 'dispatching'].includes(record.state)) record.state = deviceOperations.has(id) ? 'running' : 'unknown'; record.updatedAt = fs.statSync(file).mtimeMs; records.set(id, record); } catch {}
      }
    }
    return [...records.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }
  if (method === 'openMonitor') {
    if (typeof args.port !== 'string' || ![9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].includes(args.baud)) throw failure('badSerialConfig', '端口或波特率无效。');
    const port = portKey(args.port), baud = args.baud;
    if (!(await rpc('listPorts', {})).some(item => portKey(item.path) === port)) throw failure('noPort', '请选择当前检测到的串口。');
    args = { ...args, port };
    if (monitor && monitor.subscribers.size) { if (monitor.port !== port || monitor.baud !== baud) throw failure('portBusy', '共享串口已连接到另一端口或波特率。'); monitor.subscribers.add(c); return { ...serialStatus(c), shared: true }; }
    const id = crypto.randomUUID(); monitor = { id, port, baud, state: 'open', owner: c, subscribers: new Set([c]), buffer: Buffer.alloc(0), start: 0, end: 0, logged: 0, logTruncated: false, parts: [], lastLoggedRX: 0, indexDirty: true, log: path.join(root, 'serial', id + '.jsonl') }; fs.mkdirSync(path.dirname(monitor.log), { recursive: true });
    try { const result = await rpc('openMonitor', args); monitor.state = 'open'; return { ...result, ...serialStatus(c) }; } catch (error) { monitor.state = 'error'; throw error; }
  }
  if (method === 'monitorStatus') return serialStatus(c);
  if (method === 'takeMonitorControl') { if (!monitor?.subscribers.has(c)) throw failure('notSubscribed', '请先连接共享串口。'); if (monitor.owner && monitor.owner !== c && !args.confirm) throw failure('handoverRequired', '请明确确认接管串口发送。'); monitor.owner = c; publish('monitor.owner', { owner: c.id }, monitor.subscribers); return serialStatus(c); }
  if (method === 'readSerial') { if (!monitor?.subscribers.has(c) || args.sessionId !== monitor.id) throw failure('sessionChanged', '串口会话已变化。'); const offset = args.offset; if (!Number.isSafeInteger(offset) || offset < 0 || offset > monitor.end) throw failure('badCursor', '串口游标无效。'); const at = Math.max(offset, monitor.start), bytes = monitor.buffer.subarray(at - monitor.start, at - monitor.start + 65536); return { sessionId: monitor.id, data: bytes.toString('base64'), nextOffset: at + bytes.length, gap: offset < monitor.start, status: serialStatus(c) }; }
  if (method === 'writeMonitor') {
    if (typeof args.data !== 'string' || args.data.length > 90000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data) || Buffer.from(args.data, 'base64').length > 65536 || !Buffer.from(args.data, 'base64').length) throw failure('badRequest', '发送字节无效或超过 64 KiB。');
    if (monitor?.owner !== c) throw failure('readOnly', '当前应用仅监视串口，请先接管发送。'); const txId = crypto.randomUUID(), rxOffset = monitor.end;
    logSerial({ direction: 'tx-intent', txId, data: args.data, rxOffset, at: Date.now() });
    try { const result = await rpc(method, args); logSerial({ direction: 'tx-result', txId, sent: result.sent, at: Date.now() }); return { ...result, txId, sessionId: monitor.id, rxOffset }; }
    catch (error) { logSerial({ direction: 'tx-unknown', txId, at: Date.now() }); throw error; } }
  if (method === 'closeMonitor') { await detach(c); return { closed: true }; }
  if (c.role === 'agent') throw failure('approvalRequired', '硬件操作需要桌面授权。');
  if (['inspectBoard', 'flashImage', 'restoreImage', 'resetBoard', 'flash', 'restore', 'identify', 'reset'].includes(method)) {
    if (activeDeviceOwner && activeDeviceOwner !== c.id) throw failure('deviceBusy', '另一会话正在操作实体设备。');
    if (args.method === 'uart') {
      if (typeof args.port !== 'string' || !(await rpc('listPorts', {})).some(port => portKey(port.path) === portKey(args.port))) throw failure('noPort', '请选择当前检测到的 ISP 串口。');
      args = { ...args, port: portKey(args.port) };
    }
    if (args.projectPath && method !== 'inspectBoard') checkEditors(canonical(args.projectPath));
    let intent, intentFile;
    if (args.operationId) {
      if (!/^[a-f0-9]{32}$/.test(args.operationId)) throw failure('badRequest', '操作身份无效。');
      intentFile = path.join(root, 'intents', args.operationId + '.json');
      const signature = hash(JSON.stringify({ method, args }));
      if (fs.existsSync(intentFile)) { const previous = read(intentFile); if (previous.signature !== signature) throw failure('operationConflict', '操作身份已用于不同请求。'); return handle(c, 'boardStatus', { operationId: args.operationId }); }
      intent = { operationId: args.operationId, planId: args.planId, projectId: args.projectId, buildId: args.buildId, uid: args.uid, kind: method, state: 'dispatching', signature, createdAt: Date.now() };
      atomic(intentFile, intent);
      deviceOperations.set(args.operationId, c.id);
    }
    activeDevices++; activeDeviceOwner = c.id;
    try {
      if (args.method === 'uart' && monitor && monitor.port === portKey(args.port || '') && monitor.state !== 'suspended') {
        await rpc('closeMonitor', {}); monitor.state = 'suspended'; publish('monitor.state', { state: 'suspended', port: monitor.port, sessionId: monitor.id }, monitor.subscribers);
      }
      const result = await rpc(method, args);
      if (intent) atomic(intentFile, { ...intent, ...result });
      return result;
    } catch (error) { if (intent) atomic(intentFile, { ...intent, state: 'unknown', error: { message: error.message, code: error.code } }); throw error;
    } finally { activeDevices--; if (!activeDevices) activeDeviceOwner = undefined; if (args.operationId) deviceOperations.delete(args.operationId); }
  }
  return rpc(method, args);
}
function serialStatus(c) { return monitor && monitor.subscribers.has(c) ? { open: monitor.state === 'open', state: monitor.state, port: monitor.port, baud: monitor.baud, sessionId: monitor.id, startOffset: monitor.start, endOffset: monitor.end, canWrite: monitor.owner === c, logTruncated: monitor.logTruncated, logLimitBytes: serialLogLimit } : { open: false, state: 'closed', sessionId: null }; }
async function detach(c) { if (!monitor?.subscribers.has(c)) return; monitor.subscribers.delete(c); if (monitor.owner === c) monitor.owner = undefined; if (!monitor.subscribers.size) { await rpc('closeMonitor', {}); monitor.state = 'closed'; monitor.indexDirty = true; flushSerialIndex(); monitor = undefined; } }
function dispatch(c, method, args) {
  if (['openMonitor', 'closeMonitor', 'resumeMonitor', 'takeMonitorControl', 'writeMonitor'].includes(method)) {
    const job = monitorQueue.then(() => handle(c, method, args)); monitorQueue = job.catch(() => {}); return job;
  }
  return Promise.resolve().then(() => handle(c, method, args));
}
const agentTools = require('./hardware.cjs')({ rpc, handle, inputs, checkEditors });
const address = endpoint();
const startup = path.join(root, 'daemon-start');
try { fs.mkdirSync(startup, { mode: 0o700 }); } catch {
  try { const owner = read(path.join(startup, 'owner.json')); try { process.kill(owner.pid, 0); process.exit(); } catch (e) { if (e.code !== 'ESRCH') process.exit(); } fs.rmSync(startup, { recursive: true }); fs.mkdirSync(startup, { mode: 0o700 }); } catch { process.exit(); }
}
atomic(path.join(startup, 'owner.json'), { pid: process.pid });
const releaseStartup = () => { try { if (read(path.join(startup, 'owner.json')).pid === process.pid) fs.rmSync(startup, { recursive: true }); } catch {} };
process.on('exit', releaseStartup);
const server = net.createServer(socket => {
  const c = { id: crypto.randomUUID(), socket, ready: false }; clients.add(c); let buffer = '';
  socket.setEncoding('utf8'); socket.on('error', () => {});
  socket.on('data', data => { buffer += data; if (buffer.length > 4 * 1024 * 1024) return socket.destroy(); let end; while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); let m; try { m = JSON.parse(line); } catch { continue; } dispatch(c, m.method, m.args || {}).then(result => { if (!socket.destroyed) socket.write(JSON.stringify({ id: m.id, result }) + '\n'); }, error => { if (!socket.destroyed) socket.write(JSON.stringify({ id: m.id, error: error.message, code: error.code || 'internal', detail: error.detail }) + '\n'); }); } });
  socket.on('close', () => { clients.delete(c); for (const [key, editor] of editors) if (editor.owner === c.id) { if (editor.dirty.length) editor.seen = 0; else editors.delete(key); } void detach(c.hardwarePeer || c).catch(() => {}); });
});
server.on('error', error => { releaseStartup(); if (error.code !== 'EADDRINUSE') process.exitCode = 1; });
// Only remove a stale endpoint after a failed connection; never unlink a live service.
function listen() { server.listen(address, () => { releaseStartup(); if (process.platform !== 'win32') fs.chmodSync(address, 0o600); }); }
if (process.platform !== 'win32' && fs.existsSync(address)) { const probe = net.createConnection(address); probe.once('connect', () => { probe.destroy(); releaseStartup(); }); probe.once('error', error => { if (error.code === 'ECONNREFUSED') { try { fs.unlinkSync(address); } catch {} listen(); } }); } else listen();
setInterval(() => { if (!clients.size && !jobs.size && !activeDevices) { child?.stdin.end(); server.close(() => process.exit()); } }, 30000).unref();
