// SPDX-License-Identifier: MIT
import type { TutorStorageService } from './tutor-storage-protocol';
import type { TutorAISettingsView, TutorModelSelection, TutorProviderConfig } from './tutor-ai-config';
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
}
