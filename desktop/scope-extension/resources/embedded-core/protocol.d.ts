// SPDX-License-Identifier: MIT
/** The paired native apps consume this single versioned wire contract. */
export interface BoardRequest { projectPath: string; projectId: string; buildId: string; probe: string; method?: 'stlink' | 'uart'; port?: string }
export interface PreparedImage { projectId: string; buildId: string; sourceSHA256: string; elfSHA256: string; binarySHA256: string; bytes: number; loadAddress: number; dataBase64: string }
export interface BoardOperation { operationId: string; planId: string; projectId: string; buildId: string; state: 'running' | 'completed' | 'failed' | 'unknown'; stage: string; result?: unknown; error?: string }
export interface SerialStatus { sessionId: string | null; connectionId: string | null; state: 'closed' | 'opening' | 'open' | 'disconnected' | 'error'; port: string; baud: number; startOffset: number; endOffset: number; error?: string | undefined; canWrite?: boolean | undefined; logTruncated?: boolean | undefined }
export interface SerialRead { sessionId: string; data: string; nextOffset: number; gap: boolean; status: SerialStatus }
export interface CoreInfo { protocol: 2; coreVersion: string; capabilities: string[] }
