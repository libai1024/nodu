// SPDX-License-Identifier: MIT
import type { TutorStorageService } from './tutor-storage-protocol';
import type { TutorAISettingsView, TutorModelSelection, TutorProviderConfig } from './tutor-ai-config';
import type { TutorGoalRequest, TutorGoalResult, TutorGoalState } from './tutor-goal';
import type { TutorLocalCheck, TutorLocalRule } from './tutor-local-check';
export const TUTOR_SERVICE_PATH = '/services/nodu-tutor';
export type TutorMode = 'teach' | 'ask';
export interface TutorBuffer {
    path: string; text: string; version: number; line: number;
}
export interface TutorAnnotation { startLine: number; endLine: number; note: string; }
export interface TutorGuidance { anchorLine: number; lines: string[]; }
export interface TutorAnswer {
    text: string; annotations: TutorAnnotation[]; guidance?: TutorGuidance;
    review?: { verdict: 'ok' | 'needs-work' | 'context'; note: string };
}
export interface TutorChatRequest {
    id: string; workspaceId: string; epoch: number; mode: TutorMode;
    kind: 'chat' | 'line' | 'step'; prompt: string; buffer?: TutorBuffer;
}
export interface TutorModelTest { ok: boolean; message: string; ms?: number }
export interface TutorRemoteModel { id: string; contextWindow?: number }
export interface TutorAIClient {
    onDidChange(event: { sessionId: string; sequence: number }): void;
    onChatDelta(event: { id: string; epoch: number; text: string }): void;
    /** The host granted or revoked workspaces for this window. */
    onWorkspacesChanged(): void;
    /** Another window changed providers, keys or the default model. */
    onAISettingsChanged(): void;
    onGoalsChanged(): void;
}
export type TutorAIResult = { ok: true; answer: TutorAnswer } | { ok: false; error: string; cancelled?: boolean };
export interface TutorService extends TutorStorageService {
    workspaces(): Promise<{ id: string; uri: string }[]>;
    aiSettings(): Promise<TutorAISettingsView>;
    saveProvider(provider: TutorProviderConfig): Promise<TutorAISettingsView>;
    removeProvider(providerId: string): Promise<TutorAISettingsView>;
    setProviderKey(providerId: string, key: string): Promise<TutorAISettingsView>;
    deleteProviderKey(providerId: string): Promise<TutorAISettingsView>;
    /** Selects the model for this window and remembers it as the default for new windows. */
    selectModel(selection: TutorModelSelection): Promise<TutorAISettingsView>;
    testModel(providerId: string, modelId: string): Promise<TutorModelTest>;
    listRemoteModels(providerId: string): Promise<TutorRemoteModel[]>;
    setPresentation(workspaceId: string, epoch: number, mode: TutorMode, paused: boolean): Promise<void>;
    chat(request: TutorChatRequest): Promise<TutorAIResult>;
    cancelChat(id: string): Promise<void>;
    clearChat(workspaceId: string, mode: TutorMode): Promise<void>;
    goalSnapshot(workspaceId: string): Promise<TutorGoalState>;
    goal(request: TutorGoalRequest): Promise<TutorGoalResult>;
    inspectBuffer(workspaceId: string, buffer: TutorBuffer, rules?: TutorLocalRule[], requestId?: string): Promise<TutorLocalCheck>;
    resolveReference(workspaceId: string, path: string, line: number): Promise<{ path: string; line: number }>;
}

/** Exhaustive RPC surface: a new service method must explicitly reach the desktop transport. */
export const TUTOR_SERVICE_METHODS: Record<keyof TutorService, true> = {
    openSession: true, getSnapshot: true, closeSession: true, previewMigration: true, acceptMigration: true,
    recordAction: true, importLegacyProgress: true, workspaces: true, aiSettings: true, saveProvider: true,
    removeProvider: true, setProviderKey: true, deleteProviderKey: true, selectModel: true, testModel: true,
    listRemoteModels: true, setPresentation: true, chat: true, cancelChat: true, clearChat: true,
    goalSnapshot: true, goal: true, inspectBuffer: true, resolveReference: true
};
export function tutorServiceFacade(ready: Promise<{ service: TutorService }>): TutorService {
    const facade = Object.create(null);
    for (const name of Object.keys(TUTOR_SERVICE_METHODS) as (keyof TutorService)[]) {
        facade[name] = async (...args: unknown[]) => {
            const { service } = await ready;
            return (service[name] as (...args: unknown[]) => unknown)(...args);
        };
    }
    return Object.freeze(facade);
}
