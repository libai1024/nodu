// SPDX-License-Identifier: MIT
// Isolated M0 contract probe; no provider credentials or network requests.
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const host = createRequire(path.join(root, 'desktop/package.json'));
host('reflect-metadata');
const { Container } = host('@theia/core/shared/inversify');
const core = host('@theia/core/lib/common');
const lm = host('@theia/ai-core/lib/common/language-model');
const { LanguageModelFrontendDelegateImpl } = host('@theia/ai-core/lib/node/language-model-frontend-delegate');
const { ContributionFilterRegistryImpl } = host('@theia/core/lib/common/contribution-filter/contribution-filter-registry');
const results = [];
const passed = name => { results.push(name); process.stdout.write(`PASS ${name}\n`); };
(async () => {
    let providerCalls = 0, clientToolCalls = 0, epoch = 1;
    const grants = new Map();
    const raw = {
        id: 'raw-private', status: { status: 'ready' },
        async request(request, token) {
            providerCalls++;
            if (request.messages[0].text === 'wait') {
                return new Promise((resolve, reject) => token.onCancellationRequested(() => reject(new Error('cancelled'))));
            }
            return { text: request.messages[0].text };
        }
    };
    const guarded = {
        id: 'nodu-tutor-probe', status: { status: 'ready' },
        async request(request, token) {
            const grant = grants.get(request.requestId);
            grants.delete(request.requestId);
            assert.ok(grant && grant.epoch === epoch, 'missing or stale backend grant');
            assert.deepEqual(request.messages, grant.messages, 'context mismatch');
            assert.ok(!request.tools?.length && !request.serverTools?.length && !request.deferredToolIds?.length, 'unapproved tool');
            assert.ok(!request.settings || !Object.keys(request.settings).length, 'unapproved settings');
            assert.ok(!token?.isCancellationRequested, 'cancelled before request');
            return raw.request({ ...request, tools: [], serverTools: [], deferredToolIds: [], settings: {} }, token);
        }
    };
    const c = new Container();
    core.bindContributionProvider(c.bind.bind(c), lm.LanguageModelProvider);
    c.bind(lm.LanguageModelProvider).toConstantValue(async () => [guarded]);
    c.bind(core.ILogger).toConstantValue({ error() {}, warn() {}, info() {}, debug() {}, log() {} });
    c.bind(lm.LanguageModelRegistry).to(lm.DefaultLanguageModelRegistryImpl).inSingletonScope();
    c.bind(LanguageModelFrontendDelegateImpl).toSelf();
    const registry = c.get(lm.LanguageModelRegistry);
    assert.deepEqual((await registry.getLanguageModels()).map(m => m.id), ['nodu-tutor-probe']);
    assert.equal(await registry.getLanguageModel('raw-private'), undefined);
    passed('real Theia DI registry exposes only guarded provider');
    const delegate = c.get(LanguageModelFrontendDelegateImpl);
    delegate.setClient({ toolCall() { clientToolCalls++; throw new Error('unexpected frontend tool'); } });
    let seq = 0;
    const request = text => {
        const req = { sessionId: 'm0', requestId: `probe-${++seq}`, messages: [{ actor: 'user', type: 'text', text }] };
        grants.set(req.requestId, { epoch, messages: structuredClone(req.messages) });
        return req;
    };
    const good = request('allowed slice');
    assert.equal((await delegate.request(guarded.id, good, good.requestId)).text, 'allowed slice');
    assert.equal(providerCalls, 1);
    passed('real frontend delegate reaches controlled provider with approved context');
    await assert.rejects(delegate.request(guarded.id, good, good.requestId), /missing or stale/);
    passed('replayed backend grant rejected before provider');
    const changed = request('selected snippet'); changed.messages[0].text = 'other file';
    await assert.rejects(delegate.request(guarded.id, changed, changed.requestId), /context mismatch/);
    passed('changed source context rejected');
    const tools = request('selected snippet'); tools.tools = [{ id: 'shell', name: 'shell', parameters: { properties: {} }, handler: async () => 'unsafe' }];
    await assert.rejects(delegate.request(guarded.id, tools, tools.requestId), /unapproved tool/);
    assert.equal(clientToolCalls, 0);
    passed('frontend-supplied tool cannot acquire execution rights');
    const server = request('selected snippet'); server.serverTools = ['web_search'];
    await assert.rejects(delegate.request(guarded.id, server, server.requestId), /unapproved tool/);
    passed('provider server tools denied');
    const settings = request('selected snippet'); settings.settings = { baseURL: 'https://unapproved.example' };
    await assert.rejects(delegate.request(guarded.id, settings, settings.requestId), /unapproved settings/);
    passed('request settings cannot override endpoint policy');
    const stale = request('selected snippet'); epoch++;
    await assert.rejects(delegate.request(guarded.id, stale, stale.requestId), /missing or stale/);
    assert.equal(providerCalls, 1);
    passed('mode epoch invalidates old request');
    const waiting = request('wait');
    const cancellation = new core.CancellationTokenSource();
    const pending = delegate.request(guarded.id, waiting, waiting.requestId, cancellation.token);
    await new Promise(resolve => setImmediate(resolve));
    delegate.cancel(waiting.requestId);
    await assert.rejects(pending, /cancelled/);
    passed('delegate cancellation reaches provider token');
    const commandType = Symbol('command-contribution');
    const viewType = Symbol('view-contribution');
    const unwanted = { id: 'upstream-default' };
    const nodu = { id: 'nodu' };
    const filters = new ContributionFilterRegistryImpl([{
        registerContributionFilters(registry) {
            registry.addFilters([commandType, viewType], [contribution => contribution !== unwanted]);
        }
    }]);
    assert.deepEqual(filters.applyFilters([unwanted, nodu], commandType), [nodu]);
    assert.deepEqual(filters.applyFilters([unwanted, nodu], viewType), [nodu]);
    passed('actual contribution registry can exclude selected contribution identities');
    assert.throws(() => filters.addFilters([commandType], [() => false]), /initialization/);
    passed('contribution filters must be registered during container initialization');
    process.stdout.write(JSON.stringify({ tests: results.length, node: process.version, aiCore: host('@theia/ai-core/package.json').version, callsToFakeProvider: providerCalls, networkRequests: 0, hardwareOperations: 0 })+'\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
