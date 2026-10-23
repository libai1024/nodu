// SPDX-License-Identifier: MIT
import type { TutorStorageService } from './tutor-storage-protocol';
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
export interface TutorProviderState { provider: 'glm-coding'; model: string; configured: boolean; storage: 'keychain' | 'session'; }
export interface TutorAIClient {
    onDidChange(event: { sessionId: string; sequence: number }): void;
    onChatDelta(event: { id: string; epoch: number; text: string }): void;
}
export type TutorAIResult = { ok: true; answer: TutorAnswer } | { ok: false; error: string; cancelled?: boolean };
export interface TutorService extends TutorStorageService {
    workspaces(): Promise<{ id: string; uri: string }[]>;
    providerState(): Promise<TutorProviderState>;
    configureProvider(key: string, model: string): Promise<TutorProviderState>;
    forgetCredential(): Promise<void>;
    setPresentation(workspaceId: string, epoch: number, mode: TutorMode, paused: boolean): Promise<void>;
    chat(request: TutorChatRequest): Promise<TutorAIResult>;
    cancelChat(id: string): Promise<void>;
    clearChat(workspaceId: string, mode: TutorMode): Promise<void>;
}
