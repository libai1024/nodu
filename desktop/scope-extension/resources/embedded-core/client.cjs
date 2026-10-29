// SPDX-License-Identifier: MIT
// Native Node clients only. No browser or HTTP transport.
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const PROTOCOL = require('./protocol.json').protocolVersion;
function coreDigest(root) { const digest = crypto.createHash('sha256'); for (const name of ['client.cjs', 'service.cjs', 'hardware.cjs', 'legacy.cjs', 'encoding.cjs', 'transport.cjs', 'command.cjs', 'python-transport.cjs', 'runtime-config.cjs', 'profiles.json', 'protocol.json', 'protocol.d.ts']) digest.update(name).update(fs.readFileSync(path.join(root, name))); return digest.digest('hex'); }
function home() { return process.env.NODU_DACIR_HOME || path.join(os.homedir(), '.nodu-dacir'); }
function endpoint() { const hash = crypto.createHash('sha256').update(home()).digest('hex').slice(0, 20); return process.platform === 'win32' ? `\\\\.\\pipe\\nodu-dacir-${hash}` : path.join(os.tmpdir(), `nodu-dacir-${process.getuid()}-${hash}.sock`); }
class Client extends EventEmitter {
  constructor(config) { super(); this.config = config; this.pending = new Map(); this.sequence = 0; this.socket = undefined; this.connecting = undefined; }
  async connect() {
    if (this.socket && !this.socket.destroyed) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.connectOnce().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }
  async connectOnce() {
    const address = endpoint();
    let socket;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { socket = await new Promise((resolve, reject) => { const s = net.createConnection(address); s.once('error', reject); s.once('connect', () => { s.removeListener('error', reject); resolve(s); }); }); break; }
      catch (error) {
        if (!['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error.code)) throw error;
        if (attempt % 10 === 0 && this.config.autostart !== false) {
          const child = spawn(process.execPath, [path.join(__dirname, 'service.cjs'), Buffer.from(JSON.stringify(this.config)).toString('base64')], { detached: true, stdio: 'ignore', windowsHide: true, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
          child.on('error', () => {}); child.unref();
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!socket) throw Object.assign(new Error('共同嵌入式服务无法启动。'), { code: 'serviceUnavailable' });
    this.socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', data => {
      buffer += data;
      if (buffer.length > 8 * 1024 * 1024) return socket.destroy(new Error('响应超过大小限制。'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (typeof m.event === 'string') this.emit('event', m.event, m.data);
        else { const p = this.pending.get(m.id); if (!p) continue; clearTimeout(p.timer); this.pending.delete(m.id); m.error ? p.reject(Object.assign(new Error(m.error), { code: m.code, detail: m.detail })) : p.resolve(m.result); }
      }
    });
    const lost = error => { if (this.socket !== socket) return; this.socket = undefined; for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Object.assign(new Error(error?.message || '共同服务连接已断开，操作结果需查询。'), { code: 'outcomeUnknown' })); } this.pending.clear(); this.emit('event', 'service.state', { running: false }); };
    socket.on('error', lost); socket.on('close', () => lost());
    const info = await this.send('hello', { protocol: PROTOCOL, coreDigest: coreDigest(__dirname), binary: this.config.binary, toolkit: this.config.toolkit, resources: this.config.resources, role: this.config.role || 'desktop', app: this.config.app || 'dacir', legacyData: this.config.legacyData, launcher: this.config.launcher, launchArgs: this.config.launchArgs }, 120000);
    if (info.protocol !== PROTOCOL) { socket.destroy(); throw new Error('联动组件版本不一致。'); }
  }
  send(method, args, timeout) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error('操作等待超时；不会自动重试。'), { code: 'outcomeUnknown' })); }, timeout); this.pending.set(id, { resolve, reject, timer }); this.socket.write(JSON.stringify({ id, method, args }) + '\n'); });
  }
  async request(method, args = {}, timeout = 900000) { await this.connect(); return this.send(method, args, timeout); }
  close() { this.socket?.end(); }
}
module.exports = { Client, home, endpoint, PROTOCOL, coreDigest };
