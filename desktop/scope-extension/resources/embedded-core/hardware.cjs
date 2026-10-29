// SPDX-License-Identifier: MIT
// Host-bound tools. Only the native desktop connection can approve a request.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
module.exports = function hardware(api) {
  const plans = new Map(), approvals = new Map(), grants = new Map();
  const id = () => crypto.randomUUID().replaceAll('-', '');
  const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
  const grantKey = (b, kind, target) => JSON.stringify([b.sessionId, b.projectId, b.path, kind, target]);
  const approve = (client, args) => {
    if (client.role !== 'desktop') fail('forbidden', '只有原生桌面可以批准硬件操作。');
    const request = approvals.get(args.id);
    if (!request || request.expires < Date.now()) fail('approvalExpired', '授权请求不存在或已过期。');
    const grant = { ...request, sessionScope: request.kind !== 'restore' && args.sessionScope === true, expires: Date.now() + 15 * 60 * 1000 };
    grants.set(grant.key, grant); approvals.delete(args.id); return { approved: true, sessionId: grant.binding.sessionId, expires: grant.expires };
  };
  function authorize(binding, kind, target, details) {
    const key = grantKey(binding, kind, target), existing = grants.get(key);
    if (existing && existing.expires > Date.now() && (existing.sessionScope || JSON.stringify(existing.details) === JSON.stringify(details))) { if (!existing.sessionScope) grants.delete(key); return null; }
    let request = [...approvals.values()].find(r => r.key === key && JSON.stringify(r.details) === JSON.stringify(details) && r.expires > Date.now());
    if (!request) { request = { id: id(), key, binding, kind, target, details, expires: Date.now() + 120000 }; approvals.set(request.id, request); }
    return { approvalRequired: true, requestId: request.id, projectId: binding.projectId, target, action: kind, details };
  }
  const peer = c => c.hardwarePeer ||= { ...c, role: 'authorizedAgent' };
  async function execute(c, args) {
    const b = args.binding, tool = args.tool, a = args.arguments || {};
    if (!b || typeof b.sessionId !== 'string' || typeof b.projectId !== 'string' || typeof b.path !== 'string') fail('scope', '缺少宿主工程身份。');
    b.path = fs.realpathSync(b.path);
    const project = JSON.parse(fs.readFileSync(path.join(b.path, 'studio.project.json')));
    if (project.projectId !== b.projectId) fail('scope', '活动工程身份已变化。');
    const p = peer(c);
    if (tool === 'studio_link') return api.handle(p, a.action === 'open' ? 'linkOpen' : 'linkResult', { path: b.path, target: a.target });
    if (tool === 'studio_firmware') return api.handle(p, 'buildResult', { path: b.path });
    if (tool === 'studio_board_inspect') {
      if (a.action === 'list') return { probes: await api.rpc('listProbes', {}), ports: await api.rpc('listPorts', {}) };
      if (!a.probe && !a.port) fail('targetRequired', '请明确选择目标下载设备。');
      return api.handle(p, 'inspectBoard', { probe: a.probe || '', method: a.method || 'stlink', port: a.port || '' });
    }
    if (tool === 'studio_board_prepare') {
      api.checkEditors(b.path);
      const built = await api.handle(p, 'buildResult', { path: b.path });
      if (!built.ok || built.stale) fail('staleBuild', '请先编译当前联动工程。');
      const identity = await api.handle(p, 'inspectBoard', { probe: a.probe || '', method: a.method || 'stlink', port: a.port || '' });
      if (identity.deviceId !== 0x410 || !/^[a-f0-9]{24}$/.test(identity.uid || '') || identity.readProtected !== false || identity.flashKiB < 64 || identity.flashKiB > 128) fail('wrongChip', '目标身份或读保护状态不符合要求。');
      const planId = id(), artifact = built.artifact;
      const plan = { planId, binding: b, uid: identity.uid, method: a.method || 'stlink', probe: a.probe || '', port: a.port || '', built, artifact, expires: Date.now() + 120000 };
      plans.set(planId, plan);
      return { planId, identity, bundleId: artifact.bundleSha256, elfSHA256: artifact.fileSha256['firmware.elf'], binarySHA256: artifact.fileSha256['firmware.bin'], bytes: artifact.binaryBytes, expires: plan.expires };
    }
    if (tool === 'studio_board_flash' || tool === 'studio_board_restore' || tool === 'studio_board_reset') {
      if (a.action === 'cancel') return api.handle(p, 'cancelOperation', { operationId: a.operationId });
      if (a.action === 'status') { const record = await api.handle(p, 'boardStatus', { operationId: a.operationId }); if (record.projectId !== b.projectId) fail('scope', '操作不属于当前工程。'); return record; }
      const plan = plans.get(a.planId);
      if (!plan || plan.expires < Date.now() || plan.binding.path !== b.path || plan.binding.sessionId !== b.sessionId || plan.binding.projectId !== b.projectId) fail('planExpired', '计划不存在、已过期或不属于本会话。');
      if (tool === 'studio_board_restore' && a.action === 'backups') return api.rpc('listBackups', { uid: plan.uid });
      if (plan.operationId) return api.handle(p, 'boardStatus', { operationId: plan.operationId });
      api.checkEditors(b.path);
      if (api.inputs(b.path).digest !== plan.built.inputDigest) fail('staleBuild', '源码已变化，请重新准备。');
      const kind = tool === 'studio_board_restore' ? 'restore' : tool === 'studio_board_reset' ? 'reset' : 'flash';
      const details = { planId: plan.planId, bundleId: plan.artifact.bundleSha256, backup: a.backup || null, bytes: plan.artifact.binaryBytes };
      const approval = authorize(b, kind, plan.uid, details); if (approval) return approval;
      const operationId = id();
      const native = { operationId, planId: plan.planId, uid: plan.uid, probe: plan.probe, port: plan.port, method: plan.method, projectId: b.projectId, projectPath: b.path, buildId: plan.built.buildId };
      let method = 'flashImage';
      if (kind === 'restore') {
        const backup = (await api.rpc('listBackups', { uid: plan.uid })).find(item => item.id === a.backup && item.uid === plan.uid);
        if (!backup) fail('badBackup', '只能恢复同一芯片的已登记备份。');
        native.sha256 = backup.sha256; native.backup = backup.id; method = 'restoreImage';
      } else if (kind === 'reset') method = 'resetBoard';
      else {
        const image = fs.readFileSync(path.join(plan.built.bundlePath, 'firmware.bin'));
        native.sha256 = plan.artifact.fileSha256['firmware.bin'];
        if (crypto.createHash('sha256').update(image).digest('hex') !== native.sha256) fail('badArtifact', '固件摘要不匹配。');
        native.data = image.toString('base64');
      }
      plan.operationId = operationId;
      void api.handle(p, method, native).catch(() => {});
      return { operationId, planId: plan.planId, state: 'running', instruction: 'Query status; never infer success from dispatch.' };
    }
    if (tool === 'studio_serial_connect') {
      if (a.action === 'status') return api.handle(p, 'monitorStatus', {});
      if (a.action === 'take_control') {
        if (!c.serialBinding || c.serialBinding.projectId !== b.projectId || c.serialBinding.path !== b.path) fail('scope', '请先订阅当前工程串口。');
        const approval = authorize(b, 'serialControl', c.serialBinding.sessionId, { sessionId: c.serialBinding.sessionId }); if (approval) return approval;
        return api.handle(p, 'takeMonitorControl', { confirm: true });
      }
      if (a.action === 'disconnect') return api.handle(p, 'closeMonitor', {});
      const approval = authorize(b, 'serial', a.port, { port: a.port, baud: a.baud || 115200 }); if (approval) return approval;
      if (!(await api.rpc('listPorts', {})).some(port => port.path === a.port)) fail('noPort', '请选择当前检测到的端口。');
      const result = await api.handle(p, 'openMonitor', { port: a.port, baud: a.baud || 115200 });
      c.serialBinding = { sessionId: result.sessionId, projectId: b.projectId, path: b.path }; return result;
    }
    if (tool.startsWith('studio_serial_')) {
      if (!c.serialBinding || c.serialBinding.sessionId !== a.sessionId || c.serialBinding.projectId !== b.projectId || c.serialBinding.path !== b.path) fail('serialScope', '串口会话不属于当前工程。');
      if (tool === 'studio_serial_read') return api.handle(p, 'readSerial', { sessionId: a.sessionId, offset: a.offset === undefined ? 0 : a.offset });
      if (tool === 'studio_serial_write') {
        const approval = authorize(b, 'serialWrite', a.sessionId, { data: a.data }); if (approval) return approval;
        return api.handle(p, 'writeMonitor', { data: a.data });
      }
      if (tool === 'studio_serial_expect') {
        const timeout = a.timeoutMs ?? 5000;
        if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000 || typeof a.text !== 'string' || !a.text.length || a.text.length > 4096) fail('badExpectation', '等待范围或匹配文本无效。');
        const deadline = Date.now() + timeout; let offset = a.offset, bytes = Buffer.alloc(0);
        if (!Number.isSafeInteger(offset) || offset < 0) fail('badCursor', '必须提供本次观察的起始游标。');
        while (Date.now() <= deadline) {
          let chunk; try { chunk = await api.handle(p, 'readSerial', { sessionId: a.sessionId, offset }); } catch { return { outcome: 'inconclusive', reason: 'session_changed', nextOffset: offset }; }
          if (chunk.gap || chunk.status.state !== 'open') return { outcome: 'inconclusive', reason: 'gap_or_disconnect', nextOffset: chunk.nextOffset };
          bytes = Buffer.concat([bytes, Buffer.from(chunk.data, 'base64')]); offset = chunk.nextOffset;
          if (bytes.length > 65536) return { outcome: 'inconclusive', reason: 'window_limit', nextOffset: offset };
          if (bytes.includes(Buffer.from(a.text, 'utf8'))) return { outcome: 'matched', acceptance: 'not-evaluated', firmwareProvenance: 'unproven', sessionId: a.sessionId, startOffset: a.offset, nextOffset: offset, data: bytes.toString('base64') };
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { outcome: 'timeout', sessionId: a.sessionId, startOffset: a.offset, nextOffset: offset };
      }
    }
    fail('unknownTool', '未注册的硬件工具。');
  }
  return { execute, approve, pending: () => [...approvals.values()].filter(r => r.expires > Date.now()).map(({ key, ...r }) => r) };
};
