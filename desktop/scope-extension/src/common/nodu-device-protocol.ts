// SPDX-License-Identifier: MIT
export const NoduDeviceService = Symbol('NoduDeviceService');
export const NODU_DEVICE_PATH = '/services/nodu-device';
export interface SerialPortInfo { path: string; description: string; vid?: number; pid?: number; serialNumber?: string; }
export interface DeviceState {
    phase: 'disconnected' | 'connecting' | 'connected' | 'running' | 'error';
    port?: string;
    boardProfile?: string;
    firmware?: string;
    architecture?: string;
    busy: boolean;
    operation?: string;
    running: boolean;
    preview: boolean;
    capabilities: { repl: boolean; files: boolean; framebuffer: boolean; script: boolean };
    lastError?: string;
    progress?: { stage: string; completed: number; total: number; percent: number };
}
export interface DeviceLog { text: string; stream: 'stdout' | 'stderr' | 'system'; time: number; }
export interface DeviceFrame { mime: 'image/jpeg'; data: string; width: number; height: number; sequence: number; time: number; }
export interface RemoteFile { name: string; path: string; size: number; directory: boolean; }
export interface DeviceClient { onState(state: DeviceState): void; onLog(log: DeviceLog): void; onFrame(frame: DeviceFrame): void; }
export interface ConnectOptions { port: string; boardProfile: 'embedfire-cam-gc2145' | 'generic-k210'; baud?: number; }
export interface DeviceFileData { data: string; size: number; }
export interface FirmwarePlan {
    version: string; url: string; sha256: string; address: number; size: number;
    writeBytes: number; sectorEnd: number; ready: boolean;
}
export interface DeviceBackup {
    directory: string; flashSha256: string; flashBytes: number; verified: boolean;
    createdAt: number; files: number;
    flashCapacityVerified: boolean; flashJedecId?: string; physicalBoardEvidence?: string;
}
export interface FirmwareResult { verified: boolean; firmware: string; backupDirectory: string; sha256: string; }
export interface NoduDeviceService {
    getState(): Promise<DeviceState>;
    listPorts(): Promise<SerialPortInfo[]>;
    connect(options: ConnectOptions): Promise<DeviceState>;
    disconnect(): Promise<void>;
    execute(code: string): Promise<string>;
    runScript(code: string): Promise<void>;
    stop(): Promise<void>;
    listFiles(path: string): Promise<RemoteFile[]>;
    readFile(path: string): Promise<DeviceFileData>;
    writeFile(path: string, data: string, overwrite: boolean): Promise<void>;
    setPreview(enabled: boolean): Promise<void>;
    startCamera(): Promise<void>;
    prepareFirmware(): Promise<FirmwarePlan>;
    backupDevice(): Promise<DeviceBackup>;
    flashFirmware(confirmedBackupDirectory: string): Promise<FirmwareResult>;
}
