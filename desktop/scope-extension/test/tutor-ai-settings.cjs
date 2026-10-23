// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const cfg = require('../lib/common/tutor/tutor-ai-config');
const { TutorAISettingsStore } = require('../lib/node/tutor/tutor-ai-settings-store');
const { TutorProgressStore } = require('../lib/node/tutor/tutor-progress-store');

async function dir(t) {
    const base = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'nodu-ai-settings-')));
    t.after(() => fs.rm(base, { recursive: true, force: true }));
    return base;
}
/** In-memory stand-in for Theia's KeyStoreService. */
function keystore(initial = {}) {
    const map = new Map(Object.entries(initial));
    return { map,
        getPassword: async (s, a) => map.get(`${s}/${a}`),
        setPassword: async (s, a, p) => { map.set(`${s}/${a}`, p); },
        deletePassword: async (s, a) => map.delete(`${s}/${a}`) };
}
const custom = (patch = {}) => ({ id: 'relay', name: 'tvt-gpt', kind: 'custom', enabled: true, baseUrl: 'https://ai.tvt.wiki', apiFormat: 'responses',
    models: [{ id: 'gpt-5.6-sol', contextWindow: 272000, inputs: ['text', 'image'] }], ...patch });

test('base URLs need https except on this machine, and never carry credentials', () => {
    assert.equal(cfg.normalizeBaseUrl('https://ai.tvt.wiki/'), 'https://ai.tvt.wiki');
    assert.equal(cfg.normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
    assert.throws(() => cfg.normalizeBaseUrl('http://example.com'), /https/);
    assert.throws(() => cfg.normalizeBaseUrl('https://u:p@example.com'), /账号/);
    assert.throws(() => cfg.normalizeBaseUrl('ftp://example.com'), /https/);
    assert.equal(cfg.resolveEndpoint('https://ai.tvt.wiki', 'responses'), 'https://ai.tvt.wiki/v1/responses');
    assert.equal(cfg.resolveEndpoint('https://open.bigmodel.cn/api/coding/paas/v4', 'chat-completions'), 'https://open.bigmodel.cn/api/coding/paas/v4/chat/completions');
    assert.equal(cfg.resolveEndpoint('https://api.anthropic.com/v1', 'anthropic-messages'), 'https://api.anthropic.com/v1/messages');
});

test('model config validation keeps text input and rejects bad ids, limits and levels', () => {
    const m = cfg.validateModel({ id: 'gpt-x', inputs: ['image'], reasoningLevels: ['low', 'high'], contextWindow: 128000 });
    assert.deepEqual(m.inputs, ['text', 'image']);
    assert.deepEqual(m.reasoningLevels, ['low', 'high']);
    assert.throws(() => cfg.validateModel({ id: 'bad id' }), /模型 ID/);
    assert.throws(() => cfg.validateModel({ id: 'm', contextWindow: -1 }), /上下文窗口/);
    assert.throws(() => cfg.validateModel({ id: 'm', reasoningLevels: ['a', 'a'] }), /推理等级/);
    assert.throws(() => cfg.validateProvider(custom({ models: [{ id: 'm' }, { id: 'm' }] })), /重复/);
});

test('built-in endpoints cannot be redirected and account providers are not user-editable', () => {
    const builtin = cfg.builtinProviders()[0];
    const edited = cfg.validateProvider({ ...builtin, baseUrl: 'https://evil.example.com', apiFormat: 'responses' }, builtin);
    assert.equal(edited.baseUrl, builtin.baseUrl); assert.equal(edited.apiFormat, 'chat-completions');
    assert.throws(() => cfg.validateProvider({ ...custom(), kind: 'account' }, { ...custom(), kind: 'account' }), /账号/);
    const file = cfg.validateSettingsFile({ schema: 1, providers: [{ ...custom(), kind: 'account' }] });
    assert.ok(!file.providers.some(p => p.kind === 'account'), 'account entries never load from disk');
    assert.ok(file.providers.some(p => p.id === cfg.GLM_CODING_PROVIDER), 'the built-in provider is always present');
});

test('selection falls back to the first enabled model', () => {
    const providers = [{ ...custom(), enabled: false }, cfg.builtinProviders()[0]];
    assert.deepEqual(cfg.effectiveSelection(providers, { providerId: 'relay', modelId: 'gpt-5.6-sol' }), { providerId: 'glm-coding', modelId: 'glm-5.3' });
    assert.equal(cfg.formatTokens(272000), '272K');
});

test('settings persist, keys live in the keystore and never in the file', async t => {
    const base = await dir(t);
    const keys = keystore();
    const path = join(base, 'ai-settings.json');
    const store = new TutorAISettingsStore(path, keys);
    await store.saveProvider(custom());
    await store.setKey('relay', 'sk-relay-0123456789');
    await store.setDefault({ providerId: 'relay', modelId: 'gpt-5.6-sol' });
    const text = await fs.readFile(path, 'utf8');
    assert.ok(!text.includes('sk-relay'), 'the key is not written to the settings file');
    assert.equal(keys.map.get('cn.nodu.tutor.ai/relay'), 'sk-relay-0123456789');
    const reopened = new TutorAISettingsStore(path, keys);
    const view = await reopened.view();
    assert.deepEqual(view.selection, { providerId: 'relay', modelId: 'gpt-5.6-sol' });
    const relay = view.providers.find(p => p.id === 'relay');
    assert.equal(relay.hasKey, true); assert.equal(relay.endpoint, 'https://ai.tvt.wiki/v1/responses');
    assert.ok(!JSON.stringify(view).includes('sk-relay'), 'the view sent to the UI has no key');
    const target = await reopened.target();
    assert.equal(target.key, 'sk-relay-0123456789'); assert.equal(target.model.id, 'gpt-5.6-sol');
    await reopened.removeProvider('relay');
    assert.equal(keys.map.has('cn.nodu.tutor.ai/relay'), false);
    await assert.rejects(reopened.removeProvider('glm-coding'), /内置/);
});

test('the first GLM-only key is migrated once from its old keychain entry', async t => {
    const keys = keystore({ 'cn.nodu.tutor.glm-coding/default': 'legacy-key-0123456789' });
    const store = new TutorAISettingsStore(join(await dir(t), 'ai.json'), keys);
    assert.equal(await store.getKey('glm-coding'), 'legacy-key-0123456789');
    assert.equal(keys.map.get('cn.nodu.tutor.ai/glm-coding'), 'legacy-key-0123456789');
    assert.equal(keys.map.has('cn.nodu.tutor.glm-coding/default'), false);
});

test('an unavailable keychain keeps keys in memory only; a damaged file is set aside', async t => {
    const base = await dir(t);
    const broken = { getPassword: async () => { throw new Error('no keychain'); }, setPassword: async () => { throw new Error('no keychain'); }, deletePassword: async () => true };
    const path = join(base, 'ai.json');
    await fs.writeFile(path, '{ not json');
    const store = new TutorAISettingsStore(path, broken);
    await store.setKey('glm-coding', 'session-key-0123456789');
    assert.equal(store.storage, 'session');
    assert.equal(await store.getKey('glm-coding'), 'session-key-0123456789');
    const names = await fs.readdir(base);
    assert.ok(names.some(n => n.startsWith('ai.json.invalid-')), 'the damaged file is kept for inspection');
});

test('the learning write lock blocks a second process and recovers from a dead owner', async t => {
    const base = await dir(t);
    const release = await TutorProgressStore.lock(base, 200);
    await assert.rejects(TutorProgressStore.lock(base, 150), /另一个 Nodu 窗口/);
    await release();
    const again = await TutorProgressStore.lock(base, 200);
    await again();
    // A lock left behind by a process that has exited is taken over.
    const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
    await new Promise(resolve => child.on('exit', resolve));
    await fs.writeFile(join(base, '.write.lock'), JSON.stringify({ pid: child.pid, at: Date.now() }));
    const recovered = await TutorProgressStore.lock(base, 500);
    await recovered();
    await assert.rejects(fs.stat(join(base, '.write.lock')), /ENOENT/);
});
