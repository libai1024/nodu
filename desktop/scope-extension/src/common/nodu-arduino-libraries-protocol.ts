// SPDX-License-Identifier: MIT
export type ArduinoLibraryFilter = 'all' | 'installed' | 'updates' | 'bundled';
export interface ArduinoLibraryDependency { name: string; version: string; direct: boolean }
export interface ArduinoLibraryItem {
    name: string; author: string; summary: string; website?: string;
    versions: string[]; latestVersion: string; installedVersion?: string;
    bundledVersion?: string; bundled: boolean; core: boolean; compatible: boolean;
    architectures: string[]; dependencies: ArduinoLibraryDependency[]; updateAvailable: boolean;
}
export interface ArduinoLibraryQuery { path: string; query?: string; filter?: ArduinoLibraryFilter; offset?: number; limit?: number; refresh?: boolean; operationId?: string }
export interface ArduinoLibraryList { items: ArduinoLibraryItem[]; total: number; offline?: boolean; error?: string }
export interface ArduinoLibraryChange { path: string; name: string; version?: string; action: 'add' | 'remove' | 'update'; operationId: string }
export interface ArduinoLibraryChangeResult { ok: boolean; changed?: boolean; cancelled?: boolean; dependencies?: ArduinoLibraryDependency[]; error?: string }
