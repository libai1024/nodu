// SPDX-License-Identifier: MIT
// Wire types are generated from desktop/native/crates/nodu-protocol (ts-rs).
// The service surface stays hand-written.
export const NoduDeviceService = Symbol('NoduDeviceService');
export const NODU_DEVICE_PATH = '/services/nodu-device';
export type {
    ConnectArgs, DeviceBackup, DeviceCapabilities, DeviceFileData, DeviceFrame, DeviceLog,
    DevicePhase, DeviceState, FirmwarePlan, FirmwareResult, LogStream, ProgressInfo,
    RemoteFile, RequestId, SerialPortInfo
} from './generated';
import type {
    ConnectArgs, DeviceBackup, DeviceFileData, DeviceFrame, DeviceLog, DeviceState,
    FirmwarePlan, FirmwareResult, RemoteFile, SerialPortInfo
} from './generated';
export type ConnectOptions = ConnectArgs & { boardProfile: 'embedfire-cam-gc2145' | 'generic-k210' };
export interface DeviceClient { onState(state: DeviceState): void; onLog(log: DeviceLog): void; onFrame(frame: DeviceFrame): void; }
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
