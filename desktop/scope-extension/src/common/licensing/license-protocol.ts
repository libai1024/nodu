// SPDX-License-Identifier: MIT
/**
 * Nodu 0.3 pure data contracts, NOT cryptography or an authorization service.
 * Every validate* function checks structure only. A well-shaped signature may be
 * completely false. Only the trusted Node/native host may supply verification,
 * device, time, network, dequeue and consumption facts; never accept them by RPC
 * from a renderer. The host must verify the EXACT immutable envelope it passes.
 *
 * Signature input for these version-1 envelopes is RFC 7515's signing input:
 * base64url(RFC8785(protectedHeader)) + '.' + base64url(RFC8785(claims)).
 * Use reviewed JCS/JWS implementations in the future adapter, not JSON.stringify
 * or a homemade signer. Server: EdDSA/Ed25519 only; device: ES256/P-256 only.
 * No verifier, key discovery, canonicalizer, hash, nonce store or signing API is
 * implemented here. kid must resolve ONLY against host-pinned server keys.
 *
 * Times are integer UTC epoch milliseconds, intervals are [notBefore, expiresAt).
 * Duration limits are REQUIRED host policy: 24h/6h/15m/60s in the design are
 * proposals, not approved defaults and not implicitly selected by this module.
 */

export type LicenseOfflinePolicy = 'lease_remainder' | 'online_required';
export type LicenseFeature = 'ai.custom_provider';
export type LicenseSignatureResult = 'verified' | 'invalid' | 'unverified';
export type LicenseClockState = 'trusted' | 'anomalous';
export type DeviceProofPurpose = 'activate' | 'activation-result' | 'renew' | 'status' | 'release' | 'transfer';
export type DevicePlatform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

export const LICENSE_CONTRACT_LIMITS = Object.freeze({ identifier: 128, url: 2048, nonce: 128, watermarks: 128 });
const PURPOSES: readonly DeviceProofPurpose[] = ['activate', 'activation-result', 'renew', 'status', 'release', 'transfer'];
const MAX_TIME = 8_640_000_000_000_000;

export interface DevicePublicKey {
    readonly kty: 'EC'; readonly crv: 'P-256'; readonly x: string; readonly y: string;
}
export interface DeviceSignals {
    readonly version: 1; readonly platform: DevicePlatform; readonly platformIdDigest: string;
}
export interface ActivationBusinessFields {
    readonly activationCodeDigest: string;
    readonly devicePublicKey: DevicePublicKey;
    readonly deviceSignals: DeviceSignals;
    readonly authorizationIntent: LicenseFeature;
}
/** Metadata only, NOT the activation RPC. Raw code and device session secrets are write-only elsewhere. */
export interface ActivationAttemptMetadata extends ActivationBusinessFields {
    readonly requestId: string; readonly challengeId: string; readonly nonce: string; readonly proof: string;
}
export interface ActivationBusinessDigestInput {
    readonly domain: 'nodu.activation.business.v1';
    readonly canonicalization: 'RFC8785'; readonly hashAlgorithm: 'SHA-256';
    readonly payload: ActivationBusinessFields;
}
export interface DeviceChallengeRequest {
    readonly requestId: string; readonly purpose: DeviceProofPurpose; readonly devicePublicKey: DevicePublicKey;
}
export interface DeviceChallenge {
    readonly challengeId: string; readonly nonce: string; readonly purpose: DeviceProofPurpose;
    readonly algorithm: 'ES256'; readonly issuedAt: number; readonly expiresAt: number;
}
/** bodyDigest covers the normalized complete attempt body EXCEPT proof itself, including nonce/challengeId. */
export interface DeviceProofClaims {
    readonly schemaVersion: 1; readonly purpose: DeviceProofPurpose; readonly method: 'POST' | 'GET';
    readonly url: string; readonly requestId: string; readonly challengeId: string; readonly nonce: string;
    readonly devicePublicKey: DevicePublicKey; readonly bodyDigest: string;
    readonly canonicalization: 'RFC8785'; readonly digestAlgorithm: 'SHA-256';
}
export interface DeviceProofEnvelope {
    readonly protectedHeader: { readonly alg: 'ES256'; readonly typ: 'nodu-device-proof+jws' };
    readonly claims: DeviceProofClaims; readonly signature: string;
}

export interface LicenseLeaseClaims {
    readonly schemaVersion: 1;
    readonly issuer: string; readonly audience: string;
    readonly licenseId: string; readonly bindingId: string;
    readonly deviceKeyThumbprint: string; readonly fingerprintVersion: 1; readonly deviceSignalDigest: string;
    readonly features: readonly LicenseFeature[];
    readonly issuedAt: number; readonly notBefore: number; readonly expiresAt: number;
    /** Server license revision, scoped to issuer + audience + licenseId, shared across bindings. */
    readonly licenseRevision: number;
    /** Server binding revision, scoped to issuer + audience + licenseId + bindingId. */
    readonly bindingRevision: number;
    readonly policyVersion: number; readonly offlinePolicy: LicenseOfflinePolicy;
    readonly jti: string; readonly kid: string;
}
export type LicenseEnvelopeType = 'nodu-license-lease+jws' | 'nodu-license-state+jws';
export interface ServerSignatureHeader<T extends LicenseEnvelopeType = LicenseEnvelopeType> {
    readonly alg: 'EdDSA'; readonly kid: string; readonly typ: T;
}
export interface SignedLeaseEnvelope {
    readonly protectedHeader: ServerSignatureHeader<'nodu-license-lease+jws'>; readonly claims: LicenseLeaseClaims; readonly signature: string;
}
export interface LicenseRevisionScope {
    readonly kind: 'license'; readonly issuer: string; readonly audience: string; readonly licenseId: string;
}
export interface BindingRevisionScope {
    readonly kind: 'binding'; readonly issuer: string; readonly audience: string;
    readonly licenseId: string; readonly bindingId: string;
}
export type LicenseStateScope = LicenseRevisionScope | BindingRevisionScope;
export type LicenseDenialReason = 'revoked' | 'suspended' | 'expired' | 'device-mismatch' | 'invalid';
export type LicenseStateClaims = {
    readonly schemaVersion: 1; readonly requestId: string; readonly jti: string;
    readonly issuedAt: number; readonly expiresAt: number;
} & ({ readonly scope: LicenseRevisionScope; readonly licenseRevision: number }
    | { readonly scope: BindingRevisionScope; readonly bindingRevision: number })
    & ({ readonly status: 'active' }
        | { readonly status: 'denied'; readonly reason: LicenseDenialReason }
        | { readonly status: 'restored'; readonly restoresRevision: number });
export interface SignedLicenseStateEnvelope {
    readonly protectedHeader: ServerSignatureHeader<'nodu-license-state+jws'>; readonly claims: LicenseStateClaims; readonly signature: string;
}
/**
 * Persist through renew, restart, cache replacement and binding changes. A
 * denial includes revocation; keep its highest revision even after recovery.
 * Never compare numbers from different scopes, or either to accessRevision.
 */
export interface RevocationWatermark {
    readonly scope: LicenseStateScope;
    readonly highestRevision: number;
    readonly highestDeniedRevision: number | null;
    readonly highestRecoveredRevision: number | null;
}
export interface LicenseTrustState {
    /** Host-local invalidation epoch, not a cloud revision; invalidates all affected AI snapshots. */
    readonly accessRevision: number;
    readonly watermarks: readonly RevocationWatermark[];
}
export interface TrustedLicenseStateContext {
    readonly signature: LicenseSignatureResult; readonly clock: LicenseClockState;
    readonly now: number; readonly issuer: string; readonly audience: string; readonly expectedRequestId: string;
}
export type LicenseStateTransition = {
    /** The observation was applied, NOT permission to use AI; evaluateLicenseUse remains required. */
    readonly accepted: boolean;
    readonly reason: 'applied' | 'invalid-structure' | 'invalid-signature' | 'clock-anomaly' | 'wrong-context'
        | 'stale-response' | 'invalid-recovery' | 'capacity-exceeded';
    readonly state: LicenseTrustState;
};

function fail(): never { throw new Error('Invalid license contract'); }
/** Reject accessors, inherited/hidden/unknown fields and symbols without echoing their names or values. */
function record(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) { return fail(); }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (Reflect.ownKeys(raw).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key)
        || !Object.hasOwn(descriptors[key], 'value') || !descriptors[key].enumerable)
        || required.some(key => !Object.hasOwn(descriptors, key))) { return fail(); }
    return raw as Record<string, unknown>;
}
function list(raw: unknown, max: number): readonly unknown[] {
    if (!Array.isArray(raw) || Object.getPrototypeOf(raw) !== Array.prototype || raw.length > max
        || Reflect.ownKeys(raw).length !== raw.length + 1) { return fail(); }
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    for (let i = 0; i < raw.length; i++) {
        const d = descriptors[String(i)];
        if (!d || !Object.hasOwn(d, 'value') || !d.enumerable) { return fail(); }
    }
    return raw;
}
function id(raw: unknown): string {
    if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(raw)) { return fail(); }
    return raw;
}
function integer(raw: unknown, max = Number.MAX_SAFE_INTEGER): number {
    if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) { return fail(); }
    return raw as number;
}
function positive(raw: unknown): number { const n = integer(raw, MAX_TIME); return n > 0 ? n : fail(); }
function time(raw: unknown): number { return integer(raw, MAX_TIME); }
function oneOf<T extends string>(raw: unknown, choices: readonly T[]): T {
    if (typeof raw !== 'string' || !choices.includes(raw as T)) { return fail(); }
    return raw as T;
}
function literal<T extends string | number>(raw: unknown, expected: T): T { return raw === expected ? expected : fail(); }
function boolean(raw: unknown): boolean { return typeof raw === 'boolean' ? raw : fail(); }
/** Canonical unpadded base64url of 32 bytes (SHA-256/thumbprint/P-256 coordinate). */
function digest(raw: unknown): string {
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(raw) ? raw : fail();
}
/** Canonical unpadded base64url of a 64-byte Ed25519 or JOSE ES256 signature. Shape only! */
function signature(raw: unknown): string {
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{85}[AQgw]$/.test(raw) ? raw : fail();
}
function nonce(raw: unknown): string {
    return typeof raw === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(raw) ? raw : fail();
}
function httpsUrl(raw: unknown): string {
    if (typeof raw !== 'string' || raw.length > LICENSE_CONTRACT_LIMITS.url) { return fail(); }
    let url: URL;
    try { url = new URL(raw); } catch { return fail(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== raw) { return fail(); }
    return raw;
}
function origin(raw: unknown): string {
    if (typeof raw !== 'string') { return fail(); }
    const url = new URL(httpsUrl(`${raw}/`));
    return url.origin === raw ? raw : fail();
}
function windowTimes(issuedAt: unknown, expiresAt: unknown): { issuedAt: number; expiresAt: number } {
    const times = { issuedAt: time(issuedAt), expiresAt: time(expiresAt) };
    return times.issuedAt < times.expiresAt ? times : fail();
}
export function validateDevicePublicKey(raw: unknown): DevicePublicKey {
    const v = record(raw, ['kty', 'crv', 'x', 'y']);
    return Object.freeze({ kty: literal(v.kty, 'EC'), crv: literal(v.crv, 'P-256'), x: digest(v.x), y: digest(v.y) });
}
export function validateDeviceSignals(raw: unknown): DeviceSignals {
    const v = record(raw, ['version', 'platform', 'platformIdDigest']);
    return Object.freeze({ version: literal(v.version, 1), platform: oneOf(v.platform, ['darwin-arm64', 'darwin-x64', 'win32-x64']),
        platformIdDigest: digest(v.platformIdDigest) });
}
const BUSINESS_FIELDS = ['activationCodeDigest', 'devicePublicKey', 'deviceSignals', 'authorizationIntent'] as const;
export function validateActivationBusinessFields(raw: unknown): ActivationBusinessFields {
    const v = record(raw, BUSINESS_FIELDS);
    return Object.freeze({ activationCodeDigest: digest(v.activationCodeDigest), devicePublicKey: validateDevicePublicKey(v.devicePublicKey),
        deviceSignals: validateDeviceSignals(v.deviceSignals), authorizationIntent: literal(v.authorizationIntent, 'ai.custom_provider') });
}
export function validateActivationAttemptMetadata(raw: unknown): ActivationAttemptMetadata {
    const v = record(raw, [...BUSINESS_FIELDS, 'requestId', 'challengeId', 'nonce', 'proof']);
    const business = validateActivationBusinessFields({ activationCodeDigest: v.activationCodeDigest, devicePublicKey: v.devicePublicKey,
        deviceSignals: v.deviceSignals, authorizationIntent: v.authorizationIntent });
    return Object.freeze({ ...business, requestId: id(v.requestId), challengeId: id(v.challengeId), nonce: nonce(v.nonce), proof: signature(v.proof) });
}
/**
 * This is INPUT to a future reviewed digest implementation, NOT a digest.
 * requestId is the idempotency lookup key, not part of its value. challengeId,
 * nonce and proof MUST change on retry without changing the business digest.
 * activationCodeDigest comes from the trusted code normalizer, never a raw code.
 */
export function activationBusinessDigestInput(raw: unknown): ActivationBusinessDigestInput {
    const v = validateActivationAttemptMetadata(raw);
    return Object.freeze({ domain: 'nodu.activation.business.v1', canonicalization: 'RFC8785', hashAlgorithm: 'SHA-256',
        payload: validateActivationBusinessFields({ activationCodeDigest: v.activationCodeDigest, devicePublicKey: v.devicePublicKey,
            deviceSignals: v.deviceSignals, authorizationIntent: v.authorizationIntent }) });
}
export function validateDeviceChallengeRequest(raw: unknown): DeviceChallengeRequest {
    const v = record(raw, ['requestId', 'purpose', 'devicePublicKey']);
    return Object.freeze({ requestId: id(v.requestId), purpose: oneOf(v.purpose, PURPOSES), devicePublicKey: validateDevicePublicKey(v.devicePublicKey) });
}
export function validateDeviceChallenge(raw: unknown): DeviceChallenge {
    const v = record(raw, ['challengeId', 'nonce', 'purpose', 'algorithm', 'issuedAt', 'expiresAt']);
    return Object.freeze({ challengeId: id(v.challengeId), nonce: nonce(v.nonce), purpose: oneOf(v.purpose, PURPOSES),
        algorithm: literal(v.algorithm, 'ES256'), ...windowTimes(v.issuedAt, v.expiresAt) });
}
export function validateDeviceProofClaims(raw: unknown): DeviceProofClaims {
    const v = record(raw, ['schemaVersion', 'purpose', 'method', 'url', 'requestId', 'challengeId', 'nonce',
        'devicePublicKey', 'bodyDigest', 'canonicalization', 'digestAlgorithm']);
    const purpose = oneOf(v.purpose, PURPOSES);
    const url = httpsUrl(v.url);
    if (new URL(url).pathname !== `/nodu/v1/license/${purpose}`) { return fail(); }
    return Object.freeze({ schemaVersion: literal(v.schemaVersion, 1), purpose, method: literal(v.method, purpose === 'status' ? 'GET' : 'POST'),
        url, requestId: id(v.requestId), challengeId: id(v.challengeId), nonce: nonce(v.nonce), devicePublicKey: validateDevicePublicKey(v.devicePublicKey),
        bodyDigest: digest(v.bodyDigest), canonicalization: literal(v.canonicalization, 'RFC8785'), digestAlgorithm: literal(v.digestAlgorithm, 'SHA-256') });
}
export function validateDeviceProofEnvelope(raw: unknown): DeviceProofEnvelope {
    const v = record(raw, ['protectedHeader', 'claims', 'signature']);
    const h = record(v.protectedHeader, ['alg', 'typ']);
    return Object.freeze({ protectedHeader: Object.freeze({ alg: literal(h.alg, 'ES256'), typ: literal(h.typ, 'nodu-device-proof+jws') }),
        claims: validateDeviceProofClaims(v.claims), signature: signature(v.signature) });
}
export interface TrustedDeviceProofContext {
    readonly officialOrigin: string; readonly purpose: DeviceProofPurpose; readonly requestId: string;
    readonly devicePublicKey: DevicePublicKey; readonly bodyDigest: string;
    readonly now: number; readonly maxChallengeLifetimeMs: number; readonly challengeConsumed: boolean;
}
/** Binding checks ONLY. Does not verify proof, hash the body, consume a nonce or establish device possession. */
export function matchesDeviceProofContext(raw: unknown, rawChallenge: unknown, context: TrustedDeviceProofContext): boolean {
    try {
        const p = validateDeviceProofClaims(raw), c = validateDeviceChallenge(rawChallenge);
        const h = record(context, ['officialOrigin', 'purpose', 'requestId', 'devicePublicKey', 'bodyDigest', 'now', 'maxChallengeLifetimeMs', 'challengeConsumed']);
        const key = validateDevicePublicKey(h.devicePublicKey);
        const now = time(h.now);
        return !boolean(h.challengeConsumed) && c.issuedAt <= now && now < c.expiresAt
            && c.expiresAt - c.issuedAt <= positive(h.maxChallengeLifetimeMs)
            && p.url === `${origin(h.officialOrigin)}/nodu/v1/license/${oneOf(h.purpose, PURPOSES)}`
            && p.purpose === c.purpose && p.purpose === h.purpose && p.requestId === id(h.requestId)
            && p.challengeId === c.challengeId && p.nonce === c.nonce && p.bodyDigest === digest(h.bodyDigest)
            && p.devicePublicKey.x === key.x && p.devicePublicKey.y === key.y;
    } catch { return false; }
}

const LEASE_FIELDS = ['schemaVersion', 'issuer', 'audience', 'licenseId', 'bindingId', 'deviceKeyThumbprint', 'fingerprintVersion',
    'deviceSignalDigest', 'features', 'issuedAt', 'notBefore', 'expiresAt', 'licenseRevision', 'bindingRevision', 'policyVersion', 'offlinePolicy', 'jti', 'kid'] as const;
export function validateLeaseClaims(raw: unknown): LicenseLeaseClaims {
    const v = record(raw, LEASE_FIELDS);
    const times = windowTimes(v.issuedAt, v.expiresAt), notBefore = time(v.notBefore);
    const features = list(v.features, 1);
    if (notBefore < times.issuedAt || notBefore >= times.expiresAt || features.length !== 1 || features[0] !== 'ai.custom_provider') { return fail(); }
    return Object.freeze({ schemaVersion: literal(v.schemaVersion, 1), issuer: origin(v.issuer), audience: id(v.audience),
        licenseId: id(v.licenseId), bindingId: id(v.bindingId), deviceKeyThumbprint: digest(v.deviceKeyThumbprint),
        fingerprintVersion: literal(v.fingerprintVersion, 1), deviceSignalDigest: digest(v.deviceSignalDigest),
        features: Object.freeze(['ai.custom_provider'] as LicenseFeature[]), ...times, notBefore,
        licenseRevision: integer(v.licenseRevision), bindingRevision: integer(v.bindingRevision), policyVersion: integer(v.policyVersion),
        offlinePolicy: oneOf(v.offlinePolicy, ['lease_remainder', 'online_required']), jti: id(v.jti), kid: id(v.kid) });
}
function serverHeader<T extends LicenseEnvelopeType>(raw: unknown, typ: T): ServerSignatureHeader<T> {
    const v = record(raw, ['alg', 'kid', 'typ']);
    return Object.freeze({ alg: literal(v.alg, 'EdDSA'), kid: id(v.kid), typ: literal(v.typ, typ) });
}
export function validateSignedLeaseEnvelope(raw: unknown): SignedLeaseEnvelope {
    const v = record(raw, ['protectedHeader', 'claims', 'signature']);
    const protectedHeader = serverHeader(v.protectedHeader, 'nodu-license-lease+jws'), claims = validateLeaseClaims(v.claims);
    if (protectedHeader.kid !== claims.kid) { return fail(); }
    return Object.freeze({ protectedHeader, claims, signature: signature(v.signature) });
}
export function validateLicenseStateScope(raw: unknown): LicenseStateScope {
    const v = record(raw, ['kind', 'issuer', 'audience', 'licenseId'], ['bindingId']);
    const kind = oneOf(v.kind, ['license', 'binding']);
    const base = { issuer: origin(v.issuer), audience: id(v.audience), licenseId: id(v.licenseId) };
    if (kind === 'license') {
        if (Object.hasOwn(v, 'bindingId')) { return fail(); }
        return Object.freeze({ kind, ...base });
    }
    return Object.freeze({ kind, ...base, bindingId: id(v.bindingId) });
}
function sameScope(a: LicenseStateScope, b: LicenseStateScope): boolean {
    return a.kind === b.kind && a.issuer === b.issuer && a.audience === b.audience && a.licenseId === b.licenseId
        && (a.kind === 'license' || (b.kind === 'binding' && a.bindingId === b.bindingId));
}
export function compareScopedRevisions(a: { scope: LicenseStateScope; revision: number }, b: { scope: LicenseStateScope; revision: number }):
    'older' | 'same' | 'newer' | 'incomparable' {
    const va = record(a, ['scope', 'revision']), vb = record(b, ['scope', 'revision']);
    const sa = validateLicenseStateScope(va.scope), sb = validateLicenseStateScope(vb.scope);
    const ar = integer(va.revision), br = integer(vb.revision);
    return !sameScope(sa, sb) ? 'incomparable' : ar < br ? 'older' : ar > br ? 'newer' : 'same';
}
export function validateLicenseStateClaims(raw: unknown): LicenseStateClaims {
    const v = record(raw, ['schemaVersion', 'requestId', 'jti', 'issuedAt', 'expiresAt', 'scope', 'status'],
        ['licenseRevision', 'bindingRevision', 'reason', 'restoresRevision']);
    const scope = validateLicenseStateScope(v.scope);
    const revisionKey = scope.kind === 'license' ? 'licenseRevision' : 'bindingRevision';
    if (Object.hasOwn(v, scope.kind === 'license' ? 'bindingRevision' : 'licenseRevision')) { return fail(); }
    const version = integer(v[revisionKey]);
    const domain = scope.kind === 'license' ? { scope, licenseRevision: version } : { scope, bindingRevision: version };
    const base = { schemaVersion: literal(v.schemaVersion, 1), requestId: id(v.requestId), jti: id(v.jti),
        ...windowTimes(v.issuedAt, v.expiresAt), ...domain };
    const status = oneOf(v.status, ['active', 'denied', 'restored']);
    if (status === 'denied') {
        if (Object.hasOwn(v, 'restoresRevision')) { return fail(); }
        return Object.freeze({ ...base, status, reason: oneOf(v.reason, ['revoked', 'suspended', 'expired', 'device-mismatch', 'invalid']) });
    }
    if (Object.hasOwn(v, 'reason')) { return fail(); }
    if (status === 'restored') {
        const restoresRevision = integer(v.restoresRevision);
        if (version <= restoresRevision) { return fail(); }
        return Object.freeze({ ...base, status, restoresRevision });
    }
    if (Object.hasOwn(v, 'restoresRevision')) { return fail(); }
    return Object.freeze({ ...base, status });
}
export function validateSignedLicenseStateEnvelope(raw: unknown): SignedLicenseStateEnvelope {
    const v = record(raw, ['protectedHeader', 'claims', 'signature']);
    return Object.freeze({ protectedHeader: serverHeader(v.protectedHeader, 'nodu-license-state+jws'),
        claims: validateLicenseStateClaims(v.claims), signature: signature(v.signature) });
}
export function validateLicenseTrustState(raw: unknown): LicenseTrustState {
    const v = record(raw, ['accessRevision', 'watermarks']);
    const items = list(v.watermarks, LICENSE_CONTRACT_LIMITS.watermarks);
    const watermarks: RevocationWatermark[] = [];
    for (const item of items) {
        const w = record(item, ['scope', 'highestRevision', 'highestDeniedRevision', 'highestRecoveredRevision']);
        const scope = validateLicenseStateScope(w.scope), highestRevision = integer(w.highestRevision);
        const highestDeniedRevision = w.highestDeniedRevision === null ? null : integer(w.highestDeniedRevision);
        const highestRecoveredRevision = w.highestRecoveredRevision === null ? null : integer(w.highestRecoveredRevision);
        if (watermarks.some(old => sameScope(old.scope, scope))
            || (highestDeniedRevision !== null && highestDeniedRevision > highestRevision)
            || (highestRecoveredRevision !== null && (highestDeniedRevision === null || highestRecoveredRevision > highestRevision))) { return fail(); }
        watermarks.push(Object.freeze({ scope, highestRevision, highestDeniedRevision, highestRecoveredRevision }));
    }
    return Object.freeze({ accessRevision: integer(v.accessRevision), watermarks: Object.freeze(watermarks) });
}
function stateRevision(c: LicenseStateClaims): number { return 'licenseRevision' in c ? c.licenseRevision : c.bindingRevision; }
/**
 * Applies ONLY a host-authenticated live response. An ordinary active/renew
 * response cannot clear a denial, even at a higher revision. Recovery must name
 * the exact highest denial and advance beyond EVERY observed version in that
 * scope. Late denials are retained conservatively unless a newer explicit
 * recovery already supersedes them. Other bindings/licenses are never compared.
 *
 * Host must atomically persist returned state and invalidate affected AI work
 * before dispatch. Losing/rolling back this state is NOT repaired by this helper.
 */
export function applyLicenseState(rawState: LicenseTrustState, rawEnvelope: unknown, context: TrustedLicenseStateContext): LicenseStateTransition {
    const state = validateLicenseTrustState(rawState);
    const result = (reason: LicenseStateTransition['reason'], next = state): LicenseStateTransition => Object.freeze({ accepted: reason === 'applied', reason, state: next });
    let envelope: SignedLicenseStateEnvelope;
    try { envelope = validateSignedLicenseStateEnvelope(rawEnvelope); } catch { return result('invalid-structure'); }
    const c = envelope.claims;
    try {
        const h = record(context, ['signature', 'clock', 'now', 'issuer', 'audience', 'expectedRequestId']);
        if (oneOf(h.signature, ['verified', 'invalid', 'unverified']) !== 'verified') { return result('invalid-signature'); }
        if (oneOf(h.clock, ['trusted', 'anomalous']) !== 'trusted') { return result('clock-anomaly'); }
        if (origin(h.issuer) !== c.scope.issuer || id(h.audience) !== c.scope.audience || id(h.expectedRequestId) !== c.requestId
            || time(h.now) < c.issuedAt || time(h.now) >= c.expiresAt) { return result('wrong-context'); }
    } catch { return result('invalid-structure'); }
    const old = state.watermarks.find(w => sameScope(w.scope, c.scope));
    const version = stateRevision(c);
    const previous = old ?? { scope: c.scope, highestRevision: 0, highestDeniedRevision: null, highestRecoveredRevision: null };
    let next: RevocationWatermark;
    if (c.status === 'denied') {
        // At an equal contradictory version, denial wins; only STRICTLY newer
        // recovery can override it. This also fails closed on server split-brain.
        if ((previous.highestRecoveredRevision !== null && version < previous.highestRecoveredRevision)
            || (previous.highestDeniedRevision !== null && version <= previous.highestDeniedRevision)) { return result('stale-response'); }
        next = { ...previous, highestRevision: Math.max(previous.highestRevision, version), highestDeniedRevision: version };
    } else if (c.status === 'restored') {
        if (previous.highestDeniedRevision === null || c.restoresRevision !== previous.highestDeniedRevision) { return result('invalid-recovery'); }
        if (version <= previous.highestRevision) { return result('stale-response'); }
        next = { ...previous, highestRevision: version, highestRecoveredRevision: version };
    } else {
        if (old && version <= previous.highestRevision) { return result('stale-response'); }
        // Track newer successes without lifting any revocation floor.
        next = { ...previous, highestRevision: version };
    }
    if ((!old && state.watermarks.length === LICENSE_CONTRACT_LIMITS.watermarks) || state.accessRevision === Number.MAX_SAFE_INTEGER) {
        return result('capacity-exceeded');
    }
    const watermarks = old ? state.watermarks.map(w => sameScope(w.scope, c.scope) ? next : w) : [...state.watermarks, next];
    return result('applied', validateLicenseTrustState({ accessRevision: state.accessRevision + 1, watermarks }));
}

export type LicenseCloudOutcome = 'validated' | 'network-unreachable' | 'network-timeout' | 'not-checked'
    | 'denied' | 'invalid-response' | 'tls-error' | 'rate-limited' | 'server-error';
/** Host-created receipt after verifying the cloud's request-bound response; never a renderer/bearer ticket. */
export interface TrustedOnlineLicenseCheck {
    readonly requestId: string; readonly dispatchId: string; readonly leaseJti: string;
    readonly licenseId: string; readonly bindingId: string;
    readonly licenseRevision: number; readonly bindingRevision: number; readonly accessRevision: number;
    readonly startedAt: number; readonly checkedAt: number; readonly expiresAt: number;
    readonly signature: LicenseSignatureResult; readonly consumed: boolean;
}
export interface TrustedLicenseUseContext {
    readonly signature: LicenseSignatureResult; readonly clock: LicenseClockState;
    readonly now: number; readonly issuer: string; readonly audience: string;
    readonly deviceKeyThumbprint: string; readonly fingerprintVersion: 1; readonly deviceSignalDigest: string;
    readonly maxLeaseDurationMs: number; readonly maxOnlineCheckAgeMs: number;
    readonly cloudOutcome: LicenseCloudOutcome;
    readonly requestId: string; readonly dispatchId: string; readonly dequeuedAt: number; readonly accessRevision: number;
    readonly onlineCheck: TrustedOnlineLicenseCheck | null;
}
export type LicenseUseBlockReason = 'invalid-structure' | 'license-required' | 'invalid-signature' | 'clock-anomaly' | 'wrong-context'
    | 'device-mismatch' | 'license-expired' | 'license-revoked' | 'stale-revision' | 'stale-access' | 'cloud-denied' | 'online-check-required';
export type LicenseUseDecision = { readonly allowed: false; readonly reason: LicenseUseBlockReason }
    | { readonly allowed: true; readonly mode: 'online' | 'lease-remainder'; readonly validUntil: number;
        /** Host MUST CAS-consume this receipt before sending; pure evaluation alone never spends it. */
        readonly consume: { readonly requestId: string; readonly dispatchId: string; readonly leaseJti: string; readonly accessRevision: number } | null };
function validateUseContext(raw: unknown): TrustedLicenseUseContext {
    const v = record(raw, ['signature', 'clock', 'now', 'issuer', 'audience', 'deviceKeyThumbprint', 'fingerprintVersion', 'deviceSignalDigest',
        'maxLeaseDurationMs', 'maxOnlineCheckAgeMs', 'cloudOutcome', 'requestId', 'dispatchId', 'dequeuedAt', 'accessRevision', 'onlineCheck']);
    let onlineCheck: TrustedOnlineLicenseCheck | null = null;
    if (v.onlineCheck !== null) {
        const c = record(v.onlineCheck, ['requestId', 'dispatchId', 'leaseJti', 'licenseId', 'bindingId', 'licenseRevision', 'bindingRevision', 'accessRevision',
            'startedAt', 'checkedAt', 'expiresAt', 'signature', 'consumed']);
        onlineCheck = Object.freeze({ requestId: id(c.requestId), dispatchId: id(c.dispatchId), leaseJti: id(c.leaseJti),
            licenseId: id(c.licenseId), bindingId: id(c.bindingId), licenseRevision: integer(c.licenseRevision), bindingRevision: integer(c.bindingRevision),
            accessRevision: integer(c.accessRevision), startedAt: time(c.startedAt), checkedAt: time(c.checkedAt), expiresAt: time(c.expiresAt),
            signature: oneOf(c.signature, ['verified', 'invalid', 'unverified']), consumed: boolean(c.consumed) });
    }
    return Object.freeze({ signature: oneOf(v.signature, ['verified', 'invalid', 'unverified']), clock: oneOf(v.clock, ['trusted', 'anomalous']),
        now: time(v.now), issuer: origin(v.issuer), audience: id(v.audience), deviceKeyThumbprint: digest(v.deviceKeyThumbprint),
        fingerprintVersion: literal(v.fingerprintVersion, 1), deviceSignalDigest: digest(v.deviceSignalDigest), maxLeaseDurationMs: positive(v.maxLeaseDurationMs),
        maxOnlineCheckAgeMs: positive(v.maxOnlineCheckAgeMs), cloudOutcome: oneOf(v.cloudOutcome, ['validated', 'network-unreachable', 'network-timeout',
            'not-checked', 'denied', 'invalid-response', 'tls-error', 'rate-limited', 'server-error']), requestId: id(v.requestId), dispatchId: id(v.dispatchId),
        dequeuedAt: time(v.dequeuedAt), accessRevision: integer(v.accessRevision), onlineCheck });
}
/**
 * Call after dequeue and after every awaited check, immediately before send.
 * Host must serialize watermark/access updates and receipt consumption with
 * dispatch; repeated calls with a stale consumed=false input cannot be secured
 * by a pure function. dispatchId is a host-only unique dequeue attempt ID.
 * Never classify TLS/signature/auth/HTTP errors as network-unreachable.
 */
export function evaluateLicenseUse(rawLease: unknown, rawState: LicenseTrustState, rawContext: TrustedLicenseUseContext): LicenseUseDecision {
    const deny = (reason: LicenseUseBlockReason): LicenseUseDecision => Object.freeze({ allowed: false, reason });
    let lease: LicenseLeaseClaims, state: LicenseTrustState, h: TrustedLicenseUseContext;
    try {
        state = validateLicenseTrustState(rawState); h = validateUseContext(rawContext);
        if (rawLease === null) { return deny('license-required'); }
        lease = validateSignedLeaseEnvelope(rawLease).claims;
    } catch { return deny('invalid-structure'); }
    if (h.signature !== 'verified') { return deny('invalid-signature'); }
    if (h.clock !== 'trusted' || h.dequeuedAt > h.now) { return deny('clock-anomaly'); }
    if (lease.issuer !== h.issuer || lease.audience !== h.audience) { return deny('wrong-context'); }
    if (lease.deviceKeyThumbprint !== h.deviceKeyThumbprint || lease.fingerprintVersion !== h.fingerprintVersion
        || lease.deviceSignalDigest !== h.deviceSignalDigest) { return deny('device-mismatch'); }
    if (h.accessRevision !== state.accessRevision) { return deny('stale-access'); }
    if (h.now < lease.notBefore || h.now < lease.issuedAt) { return deny('clock-anomaly'); }
    if (h.now >= lease.expiresAt || lease.expiresAt - lease.issuedAt > h.maxLeaseDurationMs) { return deny('license-expired'); }
    const licenseScope: LicenseRevisionScope = { kind: 'license', issuer: lease.issuer, audience: lease.audience, licenseId: lease.licenseId };
    const bindingScope: BindingRevisionScope = { ...licenseScope, kind: 'binding', bindingId: lease.bindingId };
    for (const scope of [licenseScope, bindingScope]) {
        const w = state.watermarks.find(item => sameScope(item.scope, scope));
        if (!w) { return deny('online-check-required'); }
        if (w.highestDeniedRevision !== null && (w.highestRecoveredRevision === null || w.highestRecoveredRevision <= w.highestDeniedRevision)) {
            return deny('license-revoked');
        }
        const revision = scope.kind === 'license' ? lease.licenseRevision : lease.bindingRevision;
        if (revision < w.highestRevision || (w.highestDeniedRevision !== null && revision <= w.highestDeniedRevision)) { return deny('stale-revision'); }
        // An unseen higher lease is not a state transition. Persist the signed
        // active/restored state in EACH domain first; otherwise a subsequent
        // older cache could roll back a newer successful renew unnoticed.
        if (revision > w.highestRevision) { return deny('online-check-required'); }
    }
    if (h.cloudOutcome === 'denied') { return deny('cloud-denied'); }
    if (h.cloudOutcome === 'invalid-response') { return deny('invalid-signature'); }
    const online = h.cloudOutcome === 'validated';
    if (lease.offlinePolicy === 'online_required') {
        const c = h.onlineCheck;
        if (!online || !c || c.signature !== 'verified' || c.consumed || c.requestId !== h.requestId || c.dispatchId !== h.dispatchId
            || c.leaseJti !== lease.jti || c.licenseId !== lease.licenseId || c.bindingId !== lease.bindingId
            || c.licenseRevision !== lease.licenseRevision || c.bindingRevision !== lease.bindingRevision || c.accessRevision !== state.accessRevision
            || c.startedAt < h.dequeuedAt || c.startedAt > c.checkedAt || c.checkedAt > h.now || h.now >= c.expiresAt
            || h.now - c.checkedAt > h.maxOnlineCheckAgeMs || c.expiresAt - c.checkedAt > h.maxOnlineCheckAgeMs) {
            return deny('online-check-required');
        }
        return Object.freeze({ allowed: true, mode: 'online', validUntil: Math.min(lease.expiresAt, c.expiresAt),
            consume: Object.freeze({ requestId: c.requestId, dispatchId: c.dispatchId, leaseJti: c.leaseJti, accessRevision: c.accessRevision }) });
    }
    if (!online && h.cloudOutcome !== 'network-unreachable' && h.cloudOutcome !== 'network-timeout') { return deny('online-check-required'); }
    return Object.freeze({ allowed: true, mode: online ? 'online' : 'lease-remainder', validUntil: lease.expiresAt, consume: null });
}
