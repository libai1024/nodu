// SPDX-License-Identifier: MIT
// Wire types are generated from desktop/native/crates/nodu-protocol (ts-rs).
// The service surface stays hand-written.
export const NoduDeviceService = Symbol('NoduDeviceService');
export const NODU_DEVICE_PATH = '/services/nodu-device';
export type { BoardInspection } from './nodu-board-info';
import type { BoardInspection } from './nodu-board-info';
export type {
    ConnectArgs, DeviceBackup, DeviceCapabilities, DeviceFileData, DeviceFrame, DeviceLog,
    DevicePhase, DeviceState, FirmwarePlan, FirmwareResult, LogStream, ProgressInfo,
    RecordingStatus, RemoteFile, RequestId, SerialPortInfo
} from './generated';
import type {
    ConnectArgs, DeviceBackup, DeviceFileData, DeviceFrame, DeviceLog, DeviceState,
    FirmwarePlan, FirmwareResult, RecordingStatus, RemoteFile, SerialPortInfo
} from './generated';
export type ConnectOptions = Omit<ConnectArgs, 'protocol'> & {
    boardProfile: 'embedfire-cam-gc2145' | 'generic-k210';
    protocol?: 'ide' | 'raw';
    boardId?: number;
};
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
    /** Read-only inspection of the board-side config declaration. */
    inspectBoard(): Promise<BoardInspection>;
    writeFile(path: string, data: string, overwrite: boolean, confirmedStartup?: boolean): Promise<void>;
    setPreview(enabled: boolean): Promise<void>;
    startCamera(): Promise<void>;
    saveFile(name: string, data: string, confirmedStartup?: boolean): Promise<void>;
    /** Local script formatting (comment strip / indent conversion); no device needed. */
    formatScript(code: string, stripComments: boolean, spacesToTabs: boolean): Promise<string>;
    resetDevice(): Promise<void>;
    /** Begin a `.bin` framebuffer recording at a file:// URI target. */
    startRecording(fileUri: string): Promise<RecordingStatus>;
    stopRecording(): Promise<RecordingStatus>;
    /** Bundled-ffmpeg transcode; only while disconnected, output must not exist. */
    convertVideo(inputUri: string, outputUri: string): Promise<void>;
    /** Bundled-ffplay playback; .bin streams are converted to a temp MP4 first. */
    playVideo(inputUri: string): Promise<void>;
    /** Path of the bundled `nodu-terminal` binary (Node-side only lookup). */
    getTerminalExecutable(): Promise<string>;
    /** `NODU_STARTUP_TERMINALS` argument arrays, consumed once per backend. */
    takeStartupTerminals(): Promise<string[][]>;
    prepareFirmware(): Promise<FirmwarePlan>;
    backupDevice(): Promise<DeviceBackup>;
    flashFirmware(confirmedBackupDirectory: string): Promise<FirmwareResult>;
}
