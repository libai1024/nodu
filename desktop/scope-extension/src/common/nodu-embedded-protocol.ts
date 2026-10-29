// SPDX-License-Identifier: MIT
// STM32 HAL service (docs/0.2.1/FUNCTIONAL-DESIGN.md §10). The Node backend
// relays whitelisted requests to the `nodu-embedded` sidecar and fans its
// events out to every connected frontend.
export const NODU_EMBEDDED_PATH = '/services/nodu-embedded';
export const NoduEmbeddedService = Symbol('NoduEmbeddedService');

/** Sidecar methods the frontend may call; anything else is refused in Node. */
export const EMBEDDED_METHODS = [
    'keilStatus', 'generateKeil', 'openKeil',
    'openBuildLocation', 'createWorkspace', 'createModule', 'readToolkitLicense', 'setProjectOptions',
    'exportProject', 'detectExternal', 'importExternal', 'acceptToolkit', 'clangd',
    'editorPulse', 'editorClose', 'takeMonitorControl', 'linkOpen', 'linkInbox', 'linkAcknowledge', 'linkResult', 'ping', 'catalog', 'checkToolkit', 'createProject', 'openProject', 'trustProject', 'setProjectOption',
    'configure', 'build', 'cancel', 'listProbes', 'listPorts', 'identify', 'flash', 'reset',
    'listBackups', 'restore', 'openMonitor', 'closeMonitor', 'writeMonitor', 'monitorStatus',
] as const;
export type EmbeddedMethod = typeof EMBEDDED_METHODS[number];

export interface EmbeddedClient {
    /** Sidecar events (`build.progress`, `flash.step`, `monitor.data`, …) and `service.state`. */
    onEvent(event: string, data: unknown): void;
}

/** A sidecar failure: Chinese `message`, stable `code`, optional tool output in `detail`. */
export interface EmbeddedFailure { message: string; code: string; detail?: unknown }

/** Explicit envelope: RPC errors would lose `code` and `detail` on the way to the browser. */
export type CallOutcome = { ok: true; result: unknown } | { ok: false; error: EmbeddedFailure };

export interface NoduEmbeddedService {
    call(method: EmbeddedMethod, args: Record<string, unknown>): Promise<CallOutcome>;
    /** Home directory, used as the default location for new projects. */
    homeDirectory(): Promise<string>;

}

export interface Diagnostic {
    source: 'compiler' | 'linker' | 'cmake';
    severity: 'error' | 'warning';
    file?: string | null;
    absolute?: string;
    line?: number;
    column?: number;
    message: string;
    flag?: string | null;
    inSdk?: boolean;
    notes?: { file: string; line: number; column: number; message: string }[];
    explanation?: { rule: string; title: string; explain: string; fix: string };
}

export interface Capacity { [region: string]: { used: number; size: number; percent: number } }

export interface BuildResult {
    ok: boolean;
    buildId: string;
    stale?: boolean;
    phase?: string;
    diagnostics: Diagnostic[];
    errors: number;
    warnings: number;
    capacity?: Capacity;
    artifact?: { bundleSha256: string; binaryBytes: number; erase: { label: string } };
    ms: number;
    output?: string;
}

export interface ChipIdentity {
    method: 'stlink' | 'uart';
    deviceId: number;
    deviceIdHex: string;
    flashKiB: number | null;
    uid: string | null;
    readProtected: boolean | null;
    voltage?: number | null;
    probe?: string | null;
    /** Mismatch explanation, or null when the chip matches the project. */
    matches?: string | null;
    deviceName?: string;
    hasBackup?: boolean;
}

export interface FlashResult {
    autoBoot?: boolean;
    ok: true;
    runId: string;
    method: 'stlink' | 'uart';
    identity: ChipIdentity;
    backup: BackupRecord | null;
    erase: { label: string };
    bytes: number;
    readbackSha256: string;
    running: boolean | null;
    needsBootRestore: boolean;
    ms: number;
}

export interface BackupRecord {
    id: string;
    createdAt: string;
    deviceId: number;
    deviceName: string;
    uid: string;
    flashKiB: number;
    bytes: number;
    sha256: string;
    method: string;
    firstBackup?: boolean;
    factory: boolean; // Legacy storage flag; UI calls this a first backup, never factory firmware.
}

export interface ProbeInfo { id?: string; location?: string; vid: number; pid: number; model: string; serial: string; product: string; driver: 'ok' | 'missing' }
export interface PortInfo { path: string; description: string; vid?: number; pid?: number; serial_number?: string; stlinkVcp?: boolean }

export interface ProjectStatus {
    path: string;
    name: string;
    manifest: { keil?: { autoSync?: boolean }; target: { mcu: string; board: string; vendor?: 'st' | 'compatible' }; flash?: { autoBoot?: { enabled: boolean; confirmed: boolean; boot0HighDtr: boolean; resetActiveRts: boolean }; method?: string; port?: string | null }; monitor?: { baud?: number; encoding?: string }; build?: { preset?: string; printfFloat?: boolean; external?: boolean; adapter?: string } };
    chip: { id: string; name: string; core: string; family: string; series: string; flash: { size: number; eraseUnit: string }; ram: { size: number }; sdk: { dir: string; version: string } };
    board: { id: string; name: string; boot?: { note?: string; boot0?: string }; debugUart?: { instance: string; tx: string; rx: string; via: string; note?: string } };
    preset: string;
    flashMethod: 'stlink' | 'uart';
    trusted: boolean;
    lockedToolkitVersion?: string | null;
    currentBuild: { bundle: string; binaryBytes: number; capacity?: Capacity } | null;
    buildStale: boolean;
    toolkit: { ok: boolean; version?: string; root?: string; code?: string; message?: string };
}

export interface CatalogTemplate { id: string; name: string; description: string; available: boolean; needsInput: string[]; reason: string | null }
export interface CatalogBoard {
    id: string; version: number; reference: string; name: string; description: string;
    mcu: string; chipName: string; core: string; flashKiB: number; ramKiB: number; gpioPorts: string;
    debugUart: { instance: string; tx: string; rx: string; via: string; note?: string } | null;
    led: { pin: string } | null;
    templates: CatalogTemplate[];
}

/** Manual connection state. A disconnected session never reopens itself. */
export interface MonitorSnapshot {
    open: boolean;
    state: 'closed' | 'connecting' | 'open' | 'disconnected' | 'lent';
    port: string;
    baud: number;
    session?: string;
    owner?: string;
    message?: string;
}
export interface MonitorData { port: string; session: string; data: string }
/** New backends include the exact encoded wire bytes for TX display. */
export interface MonitorWriteResult { sent: number; data?: string }

export type { BoardOperation, PreparedImage, CoreInfo } from '../../resources/embedded-core/protocol.js';
