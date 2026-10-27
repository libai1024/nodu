// SPDX-License-Identifier: MIT
import { Diagnostic } from './nodu-embedded-protocol';
import { ArduinoLibraryQuery, ArduinoLibraryList, ArduinoLibraryChange, ArduinoLibraryChangeResult } from './nodu-arduino-libraries-protocol';

export const NODU_ARDUINO_PATH = '/services/nodu-arduino';
export const ARDUINO_COMMANDS = { build: 'nodu.arduino.build', upload: 'nodu.arduino.upload', prepare: 'nodu.arduino.prepare', stop: 'nodu.arduino.stop', libraries: 'nodu.arduino.libraries' };
export interface ArduinoMonitorConfig { baud: number; encoding: 'utf-8' | 'gbk'; port?: string }
export interface ArduinoProjectInfo {
    path: string; profile: string; fqbn: string; boardName: string; chip: string; coreVersion: string;
    monitor: ArduinoMonitorConfig; port?: string; ready: boolean;
}
export interface ArduinoBoard { fqbn: string; name: string; chip: string }
export interface ArduinoBoardOption { id: string; label: string; value: string; values: { value: string; label: string }[] }
export interface ArduinoConfigureRequest { path: string; fqbn?: string; options?: Record<string, string>; monitor?: Partial<ArduinoMonitorConfig>; port?: string }
export interface ArduinoPort { path: string; label?: string; serialNumber?: string; vid?: number; pid?: number }
export interface ArduinoBuildRequest { path: string; operationId: string }
export interface ArduinoBuildResult {
    ok: boolean; cancelled?: boolean; stale?: boolean; diagnostics: Diagnostic[];
    buildPath?: string; buildToken?: string; error?: string;
}
export interface ArduinoUploadRequest extends ArduinoBuildRequest { port: string; buildToken: string }
export interface ArduinoUploadResult { ok: boolean; cancelled?: boolean; stale?: boolean; error?: string; monitorRestored?: boolean }
export type ArduinoPhase = 'preparing' | 'compiling' | 'uploading' | 'verifying' | 'restoring';
export interface ArduinoEvent { operationId: string; path: string; line: string; phase?: ArduinoPhase }
export interface ArduinoClient { onArduinoOutput(event: ArduinoEvent): void }
export interface NoduArduinoService {
    inspect(path: string): Promise<ArduinoProjectInfo>;
    boards(path: string): Promise<ArduinoBoard[]>;
    boardOptions(path: string, fqbn?: string): Promise<ArduinoBoardOption[]>;
    configure(request: ArduinoConfigureRequest): Promise<ArduinoProjectInfo>;
    ports(): Promise<ArduinoPort[]>;
    prepare(request: ArduinoBuildRequest): Promise<ArduinoBuildResult>;
    compile(request: ArduinoBuildRequest): Promise<ArduinoBuildResult>;
    upload(request: ArduinoUploadRequest): Promise<ArduinoUploadResult>;
    listLibraries(request: ArduinoLibraryQuery): Promise<ArduinoLibraryList>;
    changeLibrary(request: ArduinoLibraryChange): Promise<ArduinoLibraryChangeResult>;
    cancel(operationId: string): Promise<void>;
}
