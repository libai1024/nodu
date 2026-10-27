// SPDX-License-Identifier: MIT
const { test } = require('node:test');
const assert = require('node:assert/strict');
const p = require('../lib/common/licensing/license-protocol');

// All signatures/coordinates/digests are SHAPE fixtures, not real signatures or keys.
// No test pretends that validate* performs signature verification.
const DIGEST = 'A'.repeat(43);
const OTHER_DIGEST = 'B'.repeat(42) + 'A';
const SIGNATURE = 'A'.repeat(86);
const NONCE = 'n'.repeat(43);
const ISSUER = 'https://license.example.invalid';
const AUDIENCE = 'nodu.desktop';
const NOW = 1_800_000_000_000;
const KEY = { kty: 'EC', crv: 'P-256', x: DIGEST, y: OTHER_DIGEST };
const SIGNALS = { version: 1, platform: 'darwin-arm64', platformIdDigest: DIGEST };
const business = () => ({ activationCodeDigest: DIGEST, devicePublicKey: { ...KEY }, deviceSignals: { ...SIGNALS }, authorizationIntent: 'ai.custom_provider' });
const attempt = (patch = {}) => ({ ...business(), requestId: 'activate-1', challengeId: 'challenge-1', nonce: NONCE, proof: SIGNATURE, ...patch });
const scope = (kind = 'license', bindingId = 'binding-1', licenseId = 'license-1') => ({ kind, issuer: ISSUER, audience: AUDIENCE, licenseId,
    ...(kind === 'binding' ? { bindingId } : {}) });
const claims = (patch = {}) => ({ schemaVersion: 1, issuer: ISSUER, audience: AUDIENCE, licenseId: 'license-1', bindingId: 'binding-1',
    deviceKeyThumbprint: DIGEST, fingerprintVersion: 1, deviceSignalDigest: DIGEST, features: ['ai.custom_provider'],
    issuedAt: NOW - 1_000, notBefore: NOW - 1_000, expiresAt: NOW + 10_000,
    licenseRevision: 2, bindingRevision: 3, policyVersion: 1, offlinePolicy: 'lease_remainder', jti: 'lease-1', kid: 'server-1', ...patch });
const lease = (patch = {}) => ({ protectedHeader: { alg: 'EdDSA', typ: 'nodu-license-lease+jws', kid: 'server-1' }, claims: claims(patch), signature: SIGNATURE });
const watermark = (kind = 'license', version = kind === 'license' ? 2 : 3, extra = {}) => ({ scope: scope(kind), highestRevision: version,
    highestDeniedRevision: null, highestRecoveredRevision: null, ...extra });
const state = (patch = {}) => ({ accessRevision: 7, watermarks: [watermark(), watermark('binding')], ...patch });
const stateEnvelope = (status, version, domain = scope(), patch = {}) => ({
    protectedHeader: { alg: 'EdDSA', typ: 'nodu-license-state+jws', kid: 'server-1' },
    claims: { schemaVersion: 1, requestId: 'state-request-1', jti: 'state-1', issuedAt: NOW - 100, expiresAt: NOW + 1_000,
        scope: domain, [domain.kind === 'license' ? 'licenseRevision' : 'bindingRevision']: version, status,
        ...(status === 'denied' ? { reason: 'revoked' } : status === 'restored' ? { restoresRevision: version - 1 } : {}), ...patch },
    signature: SIGNATURE,
});
const stateContext = (patch = {}) => ({ signature: 'verified', clock: 'trusted', now: NOW, issuer: ISSUER, audience: AUDIENCE,
    expectedRequestId: 'state-request-1', ...patch });
const useContext = (patch = {}) => ({ signature: 'verified', clock: 'trusted', now: NOW, issuer: ISSUER, audience: AUDIENCE,
    deviceKeyThumbprint: DIGEST, fingerprintVersion: 1, deviceSignalDigest: DIGEST,
    maxLeaseDurationMs: 20_000, maxOnlineCheckAgeMs: 1_000, cloudOutcome: 'network-unreachable',
    requestId: 'model-1', dispatchId: 'dispatch-1', dequeuedAt: NOW - 500, accessRevision: 7, onlineCheck: null, ...patch });
const onlineCheck = (patch = {}) => ({ requestId: 'model-1', dispatchId: 'dispatch-1', leaseJti: 'lease-1',
    licenseId: 'license-1', bindingId: 'binding-1', licenseRevision: 2, bindingRevision: 3, accessRevision: 7,
    startedAt: NOW - 400, checkedAt: NOW - 100, expiresAt: NOW + 500, signature: 'verified', consumed: false, ...patch });
const use = (l = lease(), s = state(), h = useContext()) => p.evaluateLicenseUse(l, s, h);
function deny(result, reason) { assert.deepEqual(result, { allowed: false, reason }); }
function applied(s, e, h = stateContext()) {
    const r = p.applyLicenseState(s, e, h);
    assert.equal(r.accepted, true, r.reason);
    return r.state;
}

// Strict, bounded wire contracts and secret-free projections.
test('lease requires every fixed field and rejects extras, invalid enums, limits and dates', () => {
    assert.deepEqual(p.validateLeaseClaims(claims()), claims());
    for (const key of Object.keys(claims())) {
        const missing = claims(); delete missing[key];
        assert.throws(() => p.validateLeaseClaims(missing), /Invalid license contract/, key);
    }
    const invalid = [
        { schemaVersion: 2 }, { licenseId: '' }, { bindingId: 'b'.repeat(129) }, { issuer: 'http://license.example.invalid' },
        { issuer: `${ISSUER}/` }, { audience: 'wrong audience' }, { licenseRevision: -1 }, { bindingRevision: 1.5 },
        { policyVersion: Number.MAX_SAFE_INTEGER + 1 }, { issuedAt: NaN }, { expiresAt: Infinity }, { expiresAt: NOW - 1_000 },
        { notBefore: NOW - 1_001 }, { notBefore: NOW + 10_000 }, { deviceKeyThumbprint: DIGEST + '=' },
        { deviceSignalDigest: 'B'.repeat(43) }, { fingerprintVersion: 2 }, { offlinePolicy: 'always-allow' },
        { features: [] }, { features: ['ai.chat'] }, { features: ['ai.custom_provider', 'ai.custom_provider'] },
        { features: ['ai.custom_provider', 'ai.unknown'] }, { secret: 'synthetic-secret' }, { accessRevision: 7 },
        { license_revision: 2 }, { devicePrivateKey: 'synthetic-private-key' },
    ];
    for (const patch of invalid) { assert.throws(() => p.validateLeaseClaims(claims(patch)), /Invalid license contract/); }
});

test('plain own enumerable fields only; validation errors never echo input secrets', () => {
    const raw = claims();
    Object.defineProperty(raw, 'secret', { value: 'synthetic-hidden-secret', enumerable: false });
    assert.throws(() => p.validateLeaseClaims(raw), { message: 'Invalid license contract' });
    const symbol = claims(); symbol[Symbol('secret')] = 'synthetic-secret';
    assert.throws(() => p.validateLeaseClaims(symbol));
    const accessor = claims();
    Object.defineProperty(accessor, 'issuer', { enumerable: true, get() { assert.fail('getter must not execute'); } });
    assert.throws(() => p.validateLeaseClaims(accessor), { message: 'Invalid license contract' });
    assert.throws(() => p.validateLeaseClaims(Object.assign(Object.create({ token: 'synthetic-secret' }), claims())));
    const featureGetter = ['ai.custom_provider'];
    Object.defineProperty(featureGetter, '0', { enumerable: true, get() { assert.fail('array getter must not execute'); } });
    assert.throws(() => p.validateLeaseClaims(claims({ features: featureGetter })), { message: 'Invalid license contract' });
    assert.throws(() => p.validateLicenseTrustState(state({ watermarks: new Array(2) })));
    assert.throws(() => p.validateLeaseClaims({ ...claims(), 'synthetic-secret-field-name': 'synthetic-secret' }), error => {
        assert.equal(error.message, 'Invalid license contract'); return true;
    });
});

test('lease/state envelopes only admit the fixed server algorithm/type/kid; structure is NOT verification', () => {
    const shaped = p.validateSignedLeaseEnvelope(lease());
    assert.ok(Object.isFrozen(shaped) && Object.isFrozen(shaped.claims) && Object.isFrozen(shaped.claims.features));
    // Nonsense signature accepted as shape, then host unverified/invalid verdict blocks use.
    deny(use(shaped, state(), useContext({ signature: 'unverified' })), 'invalid-signature');
    deny(use(shaped, state(), useContext({ signature: 'invalid' })), 'invalid-signature');
    for (const patch of [{ alg: 'none' }, { alg: 'HS256' }, { alg: 'ES256' }, { typ: 'nodu-device-proof+jws' },
        { kid: 'server-other' }, { jku: 'https://untrusted.invalid/key' }, { jwk: KEY }, { crit: ['b64'] }]) {
        assert.throws(() => p.validateSignedLeaseEnvelope({ ...lease(), protectedHeader: { ...lease().protectedHeader, ...patch } }));
    }
    assert.throws(() => p.validateSignedLeaseEnvelope({ ...lease(), signature: 'bad' }));
    assert.throws(() => p.validateSignedLeaseEnvelope({ ...lease(), secret: 'synthetic-secret' }));
    const e = stateEnvelope('denied', 4);
    assert.deepEqual(p.validateSignedLicenseStateEnvelope(e), e);
    assert.throws(() => p.validateSignedLicenseStateEnvelope({ ...e, protectedHeader: lease().protectedHeader }));
    assert.throws(() => p.validateSignedLicenseStateEnvelope({ ...e, claims: { ...e.claims, bindingRevision: 9 } }));
});

test('denial/recovery states have exact scope-specific revision and reason shapes', () => {
    for (const kind of ['license', 'binding']) {
        for (const status of ['active', 'denied', 'restored']) {
            const e = stateEnvelope(status, 4, scope(kind));
            assert.deepEqual(p.validateLicenseStateClaims(e.claims), e.claims);
            const field = kind === 'license' ? 'licenseRevision' : 'bindingRevision';
            const missing = { ...e.claims }; delete missing[field];
            assert.throws(() => p.validateLicenseStateClaims(missing));
        }
    }
    for (const patch of [{ reason: 'something' }, { restoresRevision: 0 }, { status: 'revoked' }, { secret: 'synthetic-secret' }]) {
        assert.throws(() => p.validateLicenseStateClaims(stateEnvelope('denied', 4, scope(), patch).claims));
    }
    assert.throws(() => p.validateLicenseStateClaims(stateEnvelope('active', 4, scope(), { reason: 'revoked' }).claims));
    assert.throws(() => p.validateLicenseStateClaims(stateEnvelope('restored', 4, scope(), { restoresRevision: 4 }).claims));
    assert.throws(() => p.validateLicenseStateScope({ ...scope(), bindingId: 'binding-1' }));
    assert.throws(() => p.validateLicenseStateScope({ ...scope('binding'), bindingId: undefined }));
});

test('idempotency digest input excludes request/challenge/nonce/proof; business changes cannot disappear', () => {
    const original = p.activationBusinessDigestInput(attempt());
    assert.deepEqual(original.payload, business());
    assert.equal(original.domain, 'nodu.activation.business.v1');
    assert.equal(original.hashAlgorithm, 'SHA-256');
    assert.equal(original.canonicalization, 'RFC8785');
    assert.deepEqual(p.activationBusinessDigestInput(attempt({ challengeId: 'challenge-2', nonce: 'z'.repeat(43), proof: 'B'.repeat(85) + 'A' })), original);
    assert.deepEqual(p.activationBusinessDigestInput(attempt({ requestId: 'different-lookup-key' })), original);
    for (const patch of [{ activationCodeDigest: OTHER_DIGEST }, { devicePublicKey: { ...KEY, x: OTHER_DIGEST } },
        { deviceSignals: { ...SIGNALS, platformIdDigest: OTHER_DIGEST } }, { deviceSignals: { ...SIGNALS, platform: 'win32-x64' } }]) {
        assert.notDeepEqual(p.activationBusinessDigestInput(attempt(patch)), original);
    }
    assert.equal(Object.hasOwn(original.payload, 'nonce'), false);
    for (const patch of [{ activationCode: 'synthetic-activation-code' }, { secret: 'synthetic-secret' },
        { devicePublicKey: { ...KEY, d: 'synthetic-private-key' } }, { deviceSignals: { ...SIGNALS, serialNumber: 'synthetic-serial' } },
        { deviceSignals: { ...SIGNALS, version: 2 } }, { authorizationIntent: 'ai.official' }]) {
        assert.throws(() => p.activationBusinessDigestInput(attempt(patch)));
    }
    assert.ok(Object.isFrozen(original.payload.devicePublicKey) && Object.isFrozen(original.payload.deviceSignals));
});

const challenge = (patch = {}) => ({ challengeId: 'challenge-1', nonce: NONCE, purpose: 'activate', algorithm: 'ES256',
    issuedAt: NOW - 1_000, expiresAt: NOW + 1_000, ...patch });
const proofClaims = (patch = {}) => ({ schemaVersion: 1, purpose: 'activate', method: 'POST', url: `${ISSUER}/nodu/v1/license/activate`,
    requestId: 'activate-1', challengeId: 'challenge-1', nonce: NONCE, devicePublicKey: { ...KEY }, bodyDigest: DIGEST,
    canonicalization: 'RFC8785', digestAlgorithm: 'SHA-256', ...patch });
const proofContext = (patch = {}) => ({ officialOrigin: ISSUER, purpose: 'activate', requestId: 'activate-1', devicePublicKey: { ...KEY },
    bodyDigest: DIGEST, now: NOW, maxChallengeLifetimeMs: 2_000, challengeConsumed: false, ...patch });

test('device challenge/proof has bounded public fields and fixed purpose, method, canonicalization and algorithms', () => {
    const request = { requestId: 'activate-1', purpose: 'activate', devicePublicKey: KEY };
    assert.deepEqual(p.validateDeviceChallengeRequest(request), request);
    assert.deepEqual(p.validateDeviceChallenge(challenge()), challenge());
    assert.throws(() => p.validateDeviceChallengeRequest({ ...request, token: 'synthetic-secret' }));
    assert.throws(() => p.validateDeviceChallengeRequest({ ...request, purpose: 'sign-anything' }));
    for (const patch of [{ nonce: 'x'.repeat(129) }, { nonce: 'x' }, { algorithm: 'EdDSA' }, { expiresAt: NOW - 2_000 }, { privateKey: 'synthetic-secret' }]) {
        assert.throws(() => p.validateDeviceChallenge(challenge(patch)));
    }
    const envelope = { protectedHeader: { alg: 'ES256', typ: 'nodu-device-proof+jws' }, claims: proofClaims(), signature: SIGNATURE };
    assert.deepEqual(p.validateDeviceProofEnvelope(envelope), envelope);
    assert.throws(() => p.validateDeviceProofEnvelope({ ...envelope, protectedHeader: { ...envelope.protectedHeader, alg: 'none' } }));
    for (const patch of [{ method: 'GET' }, { purpose: 'renew' }, { url: `${ISSUER}/nodu/v1/license/release` },
        { url: `${ISSUER}/nodu/v1/license/activate?secret=synthetic-secret` }, { url: `${ISSUER}/nodu/v1/license/activate#f` },
        { url: 'https://user:pass@license.example.invalid/nodu/v1/license/activate' }, { canonicalization: 'JSON.stringify' },
        { digestAlgorithm: 'SHA-1' }, { bodyDigest: 'bad' }, { secret: 'synthetic-secret' }]) {
        assert.throws(() => p.validateDeviceProofClaims(proofClaims(patch)));
    }
    assert.equal(p.validateDeviceProofClaims(proofClaims({ purpose: 'status', method: 'GET', url: `${ISSUER}/nodu/v1/license/status` })).purpose, 'status');
});

test('proof binding is separate from signature verification and stable business digest', () => {
    assert.equal(p.matchesDeviceProofContext(proofClaims(), challenge(), proofContext()), true);
    for (const patch of [{ challengeId: 'challenge-2' }, { nonce: 'z'.repeat(43) }, { requestId: 'activate-2' }, { bodyDigest: OTHER_DIGEST },
        { devicePublicKey: { ...KEY, x: OTHER_DIGEST } }, { url: 'https://evil.invalid/nodu/v1/license/activate' }]) {
        assert.equal(p.matchesDeviceProofContext(proofClaims(patch), challenge(), proofContext()), false);
    }
    for (const patch of [{ purpose: 'renew' }, { now: NOW + 1_000 }, { now: NOW - 1_001 }, { challengeConsumed: true },
        { maxChallengeLifetimeMs: 1_999 }, { bodyDigest: OTHER_DIGEST }, { officialOrigin: 'https://other.invalid' }]) {
        assert.equal(p.matchesDeviceProofContext(proofClaims(), challenge(), proofContext(patch)), false);
    }
    assert.equal(p.matchesDeviceProofContext(proofClaims(), challenge({ purpose: 'renew' }), proofContext()), false);
    // A new challenge changes signed proof/body binding, but not the business digest above.
    const retry = proofClaims({ challengeId: 'challenge-2', nonce: 'z'.repeat(43), bodyDigest: OTHER_DIGEST });
    assert.equal(p.matchesDeviceProofContext(retry, challenge({ challengeId: 'challenge-2', nonce: 'z'.repeat(43) }), proofContext({ bodyDigest: OTHER_DIGEST })), true);
});

// Same-domain monotonic state; cloud versions and host access epochs are not interchangeable.
test('revision comparison never compares distinct licenses, bindings, revision domains or issuers', () => {
    const a = { scope: scope(), revision: 2 };
    assert.equal(p.compareScopedRevisions(a, { ...a, revision: 3 }), 'older');
    assert.equal(p.compareScopedRevisions(a, a), 'same');
    assert.equal(p.compareScopedRevisions({ ...a, revision: 3 }, a), 'newer');
    for (const other of [scope('binding'), scope('license', '', 'license-2'), { ...scope(), issuer: 'https://other.invalid' }, { ...scope(), audience: 'nodu.other' }]) {
        assert.equal(p.compareScopedRevisions(a, { scope: other, revision: 999 }), 'incomparable');
    }
    assert.equal(p.compareScopedRevisions({ scope: scope('binding'), revision: 99 }, { scope: scope('binding', 'binding-2'), revision: 1 }), 'incomparable');
});

test('trust state rejects duplicate domains, impossible revision facts, extras and excessive cardinality', () => {
    assert.deepEqual(p.validateLicenseTrustState(state()), state());
    assert.throws(() => p.validateLicenseTrustState(state({ watermarks: [watermark(), watermark()] })));
    assert.throws(() => p.validateLicenseTrustState(state({ accessRevision: -1 })));
    assert.throws(() => p.validateLicenseTrustState(state({ secret: 'synthetic-secret' })));
    for (const extra of [{ highestDeniedRevision: 10 }, { highestRecoveredRevision: 10 },
        { highestDeniedRevision: null, highestRecoveredRevision: 1 }]) {
        assert.throws(() => p.validateLicenseTrustState(state({ watermarks: [watermark('license', 2, extra)] })));
    }
    const tooMany = Array.from({ length: p.LICENSE_CONTRACT_LIMITS.watermarks + 1 }, (_, n) => watermark('license', 2, { scope: scope('license', '', `license-${n}`) }));
    assert.throws(() => p.validateLicenseTrustState(state({ watermarks: tooMany })));
});

test('known revocation blocks offline, old cache, ordinary and late renew, and low/same revision recovery', () => {
    const initial = state();
    const denied = applied(initial, stateEnvelope('denied', 4));
    assert.equal(initial.watermarks[0].highestDeniedRevision, null, 'pure transition must not mutate prior state');
    assert.equal(denied.accessRevision, 8);
    assert.equal(denied.watermarks[0].highestDeniedRevision, 4);
    deny(use(lease(), denied, useContext({ accessRevision: 8 })), 'license-revoked');
    deny(use(lease({ licenseRevision: 4 }), denied, useContext({ accessRevision: 8, cloudOutcome: 'validated' })), 'license-revoked');
    assert.equal(p.applyLicenseState(denied, stateEnvelope('active', 2), stateContext()).reason, 'stale-response');
    const ordinaryNewer = applied(denied, stateEnvelope('active', 5));
    deny(use(lease({ licenseRevision: 5 }), ordinaryNewer, useContext({ accessRevision: 9, cloudOutcome: 'validated' })), 'license-revoked');
    for (const version of [3, 4]) {
        const r = p.applyLicenseState(denied, stateEnvelope('restored', version, scope(), { restoresRevision: 4 }), stateContext());
        assert.equal(r.accepted, false);
        assert.deepEqual(r.state, denied);
    }
    assert.equal(p.applyLicenseState(ordinaryNewer, stateEnvelope('restored', 5, scope(), { restoresRevision: 4 }), stateContext()).reason, 'stale-response');
    assert.equal(p.applyLicenseState(ordinaryNewer, stateEnvelope('restored', 6, scope(), { restoresRevision: 3 }), stateContext()).reason, 'invalid-recovery');
    const recovered = applied(ordinaryNewer, stateEnvelope('restored', 6, scope(), { restoresRevision: 4 }));
    assert.equal(recovered.watermarks[0].highestDeniedRevision, 4, 'successful recovery must not erase historical denial floor');
    assert.equal(recovered.watermarks[0].highestRecoveredRevision, 6);
    deny(use(lease({ licenseRevision: 5 }), recovered, useContext({ accessRevision: 10 })), 'stale-revision');
    assert.equal(use(lease({ licenseRevision: 6 }), recovered, useContext({ accessRevision: 10 })).allowed, true);
    const replay = p.applyLicenseState(recovered, stateEnvelope('denied', 4), stateContext());
    assert.equal(replay.accepted, false); assert.deepEqual(replay.state, recovered);
});

test('higher or delayed denial preserves highest observed success and demands a strictly newer recovery', () => {
    const newer = applied(state(), stateEnvelope('active', 8));
    const lateDenial = applied(newer, stateEnvelope('denied', 5));
    assert.equal(lateDenial.watermarks[0].highestRevision, 8);
    assert.equal(lateDenial.watermarks[0].highestDeniedRevision, 5);
    assert.equal(p.applyLicenseState(lateDenial, stateEnvelope('restored', 7, scope(), { restoresRevision: 5 }), stateContext()).reason, 'stale-response');
    const recovered = applied(lateDenial, stateEnvelope('restored', 9, scope(), { restoresRevision: 5 }));
    const deniedAgain = applied(recovered, stateEnvelope('denied', 10));
    assert.equal(deniedAgain.watermarks[0].highestRecoveredRevision, 9);
    deny(use(lease({ licenseRevision: 10 }), deniedAgain, useContext({ accessRevision: deniedAgain.accessRevision })), 'license-revoked');
});

test('a contradictory denial at the recovery revision fails closed until strictly newer recovery', () => {
    const denied = applied(state(), stateEnvelope('denied', 4));
    const recovered = applied(denied, stateEnvelope('restored', 5));
    const conflict = applied(recovered, stateEnvelope('denied', 5));
    assert.equal(conflict.watermarks[0].highestDeniedRevision, 5);
    assert.equal(conflict.watermarks[0].highestRecoveredRevision, 5);
    deny(use(lease({ licenseRevision: 5 }), conflict, useContext({ accessRevision: conflict.accessRevision })), 'license-revoked');
    const restored = applied(conflict, stateEnvelope('restored', 6));
    assert.equal(use(lease({ licenseRevision: 6 }), restored, useContext({ accessRevision: restored.accessRevision })).allowed, true);
});

test('binding denial/recovery is isolated; license-wide denial applies to all bindings', () => {
    const s = state({ watermarks: [watermark(), watermark('binding'), watermark('binding', 1, { scope: scope('binding', 'binding-2') })] });
    const firstDenied = applied(s, stateEnvelope('denied', 100, scope('binding')));
    deny(use(lease(), firstDenied, useContext({ accessRevision: 8 })), 'license-revoked');
    assert.equal(use(lease({ bindingId: 'binding-2', bindingRevision: 1 }), firstDenied, useContext({ accessRevision: 8 })).allowed, true);
    const secondUpdated = applied(firstDenied, stateEnvelope('active', 2, scope('binding', 'binding-2')));
    assert.equal(secondUpdated.watermarks.find(w => w.scope.bindingId === 'binding-1').highestDeniedRevision, 100);
    const otherRecovery = p.applyLicenseState(secondUpdated, stateEnvelope('restored', 101, scope('binding', 'binding-2'), { restoresRevision: 100 }), stateContext());
    assert.equal(otherRecovery.accepted, false);
    const allDenied = applied(secondUpdated, stateEnvelope('denied', 3));
    deny(use(lease({ licenseRevision: 3, bindingId: 'binding-2', bindingRevision: 2 }), allDenied, useContext({ accessRevision: 10 })), 'license-revoked');
    const otherLicense = applied(allDenied, stateEnvelope('active', 1, scope('license', '', 'license-2')));
    assert.equal(otherLicense.watermarks.find(w => w.scope.kind === 'license' && w.scope.licenseId === 'license-1').highestDeniedRevision, 3);
});

test('unsigned/tampered/context-mismatched/time-invalid state cannot advance or recover watermarks', () => {
    const s = applied(state(), stateEnvelope('denied', 4));
    const e = stateEnvelope('restored', 5);
    for (const patch of [{ signature: 'unverified' }, { signature: 'invalid' }, { clock: 'anomalous' }, { issuer: 'https://other.invalid' },
        { audience: 'nodu.other' }, { expectedRequestId: 'different-request' }, { now: NOW - 101 }, { now: NOW + 1_000 }]) {
        const r = p.applyLicenseState(s, e, stateContext(patch));
        assert.equal(r.accepted, false); assert.deepEqual(r.state, s);
    }
    const tampered = { ...e, signature: 'bad' };
    assert.equal(p.applyLicenseState(s, tampered, stateContext()).accepted, false);
    assert.equal(p.applyLicenseState(state(), stateEnvelope('restored', 5), stateContext()).reason, 'invalid-recovery');
    const hugeAccess = state({ accessRevision: Number.MAX_SAFE_INTEGER });
    assert.equal(p.applyLicenseState(hugeAccess, stateEnvelope('denied', 4), stateContext()).reason, 'capacity-exceeded');
});

test('new lease revisions must first be observed; stale success/cache and local access snapshots never authorize', () => {
    deny(use(lease({ licenseRevision: 3 })), 'online-check-required');
    const observed = applied(state(), stateEnvelope('active', 3));
    deny(use(lease(), observed, useContext({ accessRevision: 8 })), 'stale-revision');
    deny(use(lease({ licenseRevision: 3 }), observed, useContext()), 'stale-access');
    assert.equal(use(lease({ licenseRevision: 3 }), observed, useContext({ accessRevision: 8 })).allowed, true);
    const hugeAccess = state({ accessRevision: 999_999 });
    assert.equal(use(lease(), hugeAccess, useContext({ accessRevision: 999_999 })).allowed, true, 'accessRevision is not comparable to license/binding revisions');
    deny(use(lease(), state({ watermarks: [] })), 'online-check-required');
    deny(use(null), 'license-required');
});

// No rolling grace, no fallback for negative/invalid security evidence.
test('only recoverable network failure permits unchanged remaining lease, with no extension or default lifetime', () => {
    for (const cloudOutcome of ['network-unreachable', 'network-timeout']) {
        const r = use(lease(), state(), useContext({ cloudOutcome }));
        assert.equal(r.allowed, true); assert.equal(r.mode, 'lease-remainder'); assert.equal(r.validUntil, NOW + 10_000);
        const later = use(lease(), state(), useContext({ cloudOutcome, now: NOW + 9_999 }));
        assert.equal(later.validUntil, r.validUntil);
        deny(use(lease(), state(), useContext({ cloudOutcome, now: NOW + 10_000 })), 'license-expired');
    }
    assert.equal(use(lease(), state(), useContext({ cloudOutcome: 'validated' })).mode, 'online');
    for (const cloudOutcome of ['not-checked', 'tls-error', 'rate-limited', 'server-error']) {
        deny(use(lease(), state(), useContext({ cloudOutcome })), 'online-check-required');
    }
    deny(use(lease(), state(), useContext({ cloudOutcome: 'denied' })), 'cloud-denied');
    deny(use(lease(), state(), useContext({ cloudOutcome: 'invalid-response' })), 'invalid-signature');
    deny(use(lease(), state(), useContext({ maxLeaseDurationMs: 10_000 })), 'license-expired');
    const noPolicy = useContext(); delete noPolicy.maxLeaseDurationMs;
    deny(use(lease(), state(), noPolicy), 'invalid-structure');
    // A caller-approved 25-hour policy is not silently replaced with the design's proposed 24 hours.
    assert.equal(use(lease({ issuedAt: NOW, notBefore: NOW, expiresAt: NOW + 90_000_000 }), state(), useContext({ maxLeaseDurationMs: 90_000_000 })).allowed, true);
});

test('signature failure, hardware mismatch, untrusted clock and wrong audience cannot fall back offline', () => {
    for (const signature of ['invalid', 'unverified']) { deny(use(lease(), state(), useContext({ signature })), 'invalid-signature'); }
    deny(use(lease(), state(), useContext({ clock: 'anomalous' })), 'clock-anomaly');
    deny(use(lease(), state(), useContext({ dequeuedAt: NOW + 1 })), 'clock-anomaly');
    deny(use(lease({ issuedAt: NOW + 1, notBefore: NOW + 1 })), 'clock-anomaly');
    deny(use(lease(), state(), useContext({ deviceKeyThumbprint: OTHER_DIGEST })), 'device-mismatch');
    deny(use(lease(), state(), useContext({ deviceSignalDigest: OTHER_DIGEST })), 'device-mismatch');
    deny(use(lease(), state(), useContext({ audience: 'nodu.other' })), 'wrong-context');
    deny(use(lease(), state(), useContext({ signature: undefined })), 'invalid-structure');
});

test('online_required requires a fresh request/dispatch-bound receipt begun after dequeue', () => {
    const l = lease({ offlinePolicy: 'online_required' });
    const ctx = useContext({ cloudOutcome: 'validated', onlineCheck: onlineCheck() });
    const allowed = use(l, state(), ctx);
    assert.deepEqual(allowed, { allowed: true, mode: 'online', validUntil: NOW + 500,
        consume: { requestId: 'model-1', dispatchId: 'dispatch-1', leaseJti: 'lease-1', accessRevision: 7 } });
    for (const patch of [{ requestId: 'model-2' }, { dispatchId: 'dispatch-2' }, { leaseJti: 'lease-2' }, { licenseId: 'license-2' },
        { bindingId: 'binding-2' }, { licenseRevision: 1 }, { bindingRevision: 1 }, { accessRevision: 6 }, { consumed: true },
        { signature: 'unverified' }, { signature: 'invalid' }, { startedAt: NOW - 501 }, { startedAt: NOW },
        { checkedAt: NOW + 1 }, { expiresAt: NOW }, { expiresAt: NOW + 1_000 }]) {
        deny(use(l, state(), { ...ctx, onlineCheck: onlineCheck(patch) }), 'online-check-required');
    }
    deny(use(l, state(), { ...ctx, onlineCheck: null }), 'online-check-required');
    for (const cloudOutcome of ['network-unreachable', 'network-timeout', 'not-checked']) {
        deny(use(l, state(), { ...ctx, cloudOutcome }), 'online-check-required');
    }
    // A 15-minute cached receipt or prefetch that starts before dequeue is not fresh.
    deny(use(l, state(), { ...ctx, onlineCheck: onlineCheck({ startedAt: NOW - 900_001, checkedAt: NOW - 900_000 }) }), 'online-check-required');
    // Different request AND retry of the same request with a new dequeue attempt both need a new check.
    deny(use(l, state(), { ...ctx, requestId: 'model-2' }), 'online-check-required');
    deny(use(l, state(), { ...ctx, dispatchId: 'dispatch-2' }), 'online-check-required');
    // Host applies the returned consume instruction atomically; this pure helper does not mutate inputs.
    assert.equal(ctx.onlineCheck.consumed, false);
    deny(use(l, state(), { ...ctx, onlineCheck: { ...ctx.onlineCheck, consumed: true } }), 'online-check-required');
});

test('revocation/access changes while online check is awaited invalidate its late response', () => {
    const l = lease({ offlinePolicy: 'online_required' });
    const ctx = useContext({ cloudOutcome: 'validated', onlineCheck: onlineCheck() });
    const revoked = applied(state(), stateEnvelope('denied', 4));
    deny(use(l, revoked, ctx), 'stale-access');
    deny(use(l, revoked, { ...ctx, accessRevision: revoked.accessRevision }), 'license-revoked');
    assert.equal(p.applyLicenseState(revoked, stateEnvelope('active', 2), stateContext()).accepted, false);
});

test('decision/state projections contain no raw code, device sessions, proof or keys', () => {
    const result = use();
    assert.deepEqual(Object.keys(result).sort(), ['allowed', 'consume', 'mode', 'validUntil']);
    const transition = p.applyLicenseState(state(), stateEnvelope('denied', 4), stateContext());
    assert.deepEqual(Object.keys(transition).sort(), ['accepted', 'reason', 'state']);
    for (const forbidden of ['activationCode', 'secret', 'proof', 'signature', 'devicePublicKey', 'refreshToken', 'privateKey']) {
        assert.equal(JSON.stringify(result).includes(`"${forbidden}"`), false);
        assert.equal(JSON.stringify(transition).includes(`"${forbidden}"`), false);
    }
});
