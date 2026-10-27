// SPDX-License-Identifier: MIT
export type AiRoute = 'official' | 'custom';
export type AiIntent = 'chat' | 'line-review' | 'step-review' | 'goal' | 'provider-test' | 'model-discovery';
export type AiFeature = 'ai.chat' | 'ai.teach' | 'ai.review' | 'ai.provider-test' | 'ai.model-discovery';
export type AccessBlockReason = 'login-required' | 'account-disabled' | 'quota-exhausted'
    | 'license-required' | 'license-expired' | 'license-revoked' | 'device-mismatch'
    | 'cloud-check-required' | 'provider-unconfigured' | 'protocol-unsupported';

export const AI_FEATURE_BY_INTENT: Readonly<Record<AiIntent, AiFeature>> = Object.freeze({
    chat: 'ai.chat', 'line-review': 'ai.review', 'step-review': 'ai.review', goal: 'ai.teach',
    'provider-test': 'ai.provider-test', 'model-discovery': 'ai.model-discovery',
});
const REASONS: readonly AccessBlockReason[] = ['login-required', 'account-disabled', 'quota-exhausted',
    'license-required', 'license-expired', 'license-revoked', 'device-mismatch', 'cloud-check-required',
    'provider-unconfigured', 'protocol-unsupported'];

export type AccessDecision = {
    revision: number; route: AiRoute; feature: AiFeature; profileId: string;
} & ({ allowed: true; validUntil: number } | { allowed: false; reason: AccessBlockReason });

export interface ExecutionSnapshot {
    requestId: string;
    connectionId: string;
    workspaceHandle: string;
    intent: AiIntent;
    route: AiRoute;
    profileId: string;
    configRevision: number;
    selectionRevision: number;
    accessRevision: number;
    teachingEpoch: number;
}
export interface DispatchState {
    connectionId: string;
    workspaceHandle: string;
    route: AiRoute;
    profileId: string;
    configRevision: number;
    selectionRevision: number;
    accessRevision: number;
    teachingEpoch: number;
}
/** Supplied by the trusted host after its cloud response, never accepted from renderer RPC. */
export interface OnlineRequestCheck {
    requestId: string;
    profileId: string;
    configRevision: number;
    accessRevision: number;
    checkedAt: number;
    validUntil: number;
}
export type DispatchDecision = { allowed: true } | {
    allowed: false;
    reason: AccessBlockReason | 'stale-context' | 'cancelled' | 'invalid-context';
};

function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) { throw new Error('Invalid AI contract'); }
    const obj = value as Record<string, unknown>;
    if (Object.keys(obj).some(key => !fields.includes(key))) { throw new Error('Unknown AI contract field'); }
    return obj;
}
function id(value: unknown): string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/.test(value)) { throw new Error('Invalid AI identifier'); }
    return value;
}
function revision(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) { throw new Error('Invalid AI revision'); }
    return value as number;
}
function route(value: unknown): AiRoute {
    if (value !== 'official' && value !== 'custom') { throw new Error('Invalid AI route'); }
    return value;
}
export function validateAccessDecision(raw: unknown): AccessDecision {
    const value = record(raw, ['revision', 'route', 'feature', 'profileId', 'allowed', 'validUntil', 'reason']);
    if (!Object.values(AI_FEATURE_BY_INTENT).includes(value.feature as AiFeature)) { throw new Error('Invalid AI feature'); }
    const base = { revision: revision(value.revision), route: route(value.route), feature: value.feature as AiFeature, profileId: id(value.profileId) };
    if (value.allowed === true && value.reason === undefined) {
        const validUntil = revision(value.validUntil);
        return { ...base, allowed: true, validUntil };
    }
    if (value.allowed === false && value.validUntil === undefined && REASONS.includes(value.reason as AccessBlockReason)) {
        return { ...base, allowed: false, reason: value.reason as AccessBlockReason };
    }
    throw new Error('Invalid AI access decision');
}
const SNAPSHOT_FIELDS = ['requestId', 'connectionId', 'workspaceHandle', 'intent', 'route', 'profileId',
    'configRevision', 'selectionRevision', 'accessRevision', 'teachingEpoch'] as const;
export function validateExecutionSnapshot(raw: unknown): Readonly<ExecutionSnapshot> {
    const value = record(raw, SNAPSHOT_FIELDS);
    if (typeof value.intent !== 'string' || !Object.hasOwn(AI_FEATURE_BY_INTENT, value.intent)) { throw new Error('Invalid AI intent'); }
    return Object.freeze({ requestId: id(value.requestId), connectionId: id(value.connectionId), workspaceHandle: id(value.workspaceHandle),
        intent: value.intent as AiIntent, route: route(value.route), profileId: id(value.profileId), configRevision: revision(value.configRevision),
        selectionRevision: revision(value.selectionRevision), accessRevision: revision(value.accessRevision), teachingEpoch: revision(value.teachingEpoch) });
}

/** Call after dequeue and again after awaited authorization, immediately before sending. */
export function evaluateDispatch(snapshot: ExecutionSnapshot, current: DispatchState, decision: AccessDecision,
    options: { now: number; dequeuedAt: number; cancelled: boolean; onlineRequired: boolean; onlineCheck?: OnlineRequestCheck }): DispatchDecision {
    try {
        validateExecutionSnapshot(snapshot);
        validateExecutionSnapshot({ ...current, requestId: snapshot.requestId, intent: snapshot.intent });
        validateAccessDecision(decision);
        revision(options.now); revision(options.dequeuedAt);
        if (options.dequeuedAt > options.now || typeof options.cancelled !== 'boolean' || typeof options.onlineRequired !== 'boolean') {
            return { allowed: false, reason: 'invalid-context' };
        }
    } catch { return { allowed: false, reason: 'invalid-context' }; }
    if (options.cancelled) { return { allowed: false, reason: 'cancelled' }; }
    const keys: readonly (keyof DispatchState)[] = ['connectionId', 'workspaceHandle', 'route', 'profileId',
        'configRevision', 'selectionRevision', 'accessRevision', 'teachingEpoch'];
    if (keys.some(key => snapshot[key] !== current[key]) || decision.revision !== current.accessRevision
        || decision.route !== current.route || decision.profileId !== current.profileId || decision.feature !== AI_FEATURE_BY_INTENT[snapshot.intent]) {
        return { allowed: false, reason: 'stale-context' };
    }
    if (!decision.allowed) { return { allowed: false, reason: decision.reason }; }
    if (decision.validUntil <= options.now) { return { allowed: false, reason: 'cloud-check-required' }; }
    if (options.onlineRequired) {
        const check = options.onlineCheck;
        if (!check || !Number.isSafeInteger(check.checkedAt) || !Number.isSafeInteger(check.validUntil)
            || check.checkedAt < options.dequeuedAt || check.checkedAt > options.now || check.validUntil <= options.now
            || check.requestId !== snapshot.requestId || check.profileId !== current.profileId
            || check.configRevision !== current.configRevision || check.accessRevision !== current.accessRevision) {
            return { allowed: false, reason: 'cloud-check-required' };
        }
    }
    return { allowed: true };
}

export type InvalidationScope = { kind: 'connection'; connectionId: string }
    | { kind: 'profile'; profileId: string } | { kind: 'route'; route: AiRoute };
export function isSnapshotAffected(snapshot: ExecutionSnapshot, scope: InvalidationScope): boolean {
    switch (scope.kind) {
        case 'connection': return snapshot.connectionId === scope.connectionId;
        case 'profile': return snapshot.profileId === scope.profileId;
        case 'route': return snapshot.route === scope.route;
        default: return true;
    }
}
