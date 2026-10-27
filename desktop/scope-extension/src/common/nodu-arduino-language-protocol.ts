// SPDX-License-Identifier: MIT
export const NODU_ARDUINO_LANGUAGE_PATH = '/services/nodu-arduino-language';
export const NoduArduinoLanguageService = Symbol('NoduArduinoLanguageService');
export const ARDUINO_LANGUAGE_COMMANDS = { start: 'nodu.arduino.language.start', stop: 'nodu.arduino.language.stop', restart: 'nodu.arduino.language.restart' };
export interface ArduinoLanguageSpec {
    ok: boolean; error?: string; command?: string; args?: string[]; project?: string;
    incrementalSync?: boolean; fingerprint?: string; environment?: Record<string, string>;
}
export interface NoduArduinoLanguageService { spec(request: { path: string }): Promise<ArduinoLanguageSpec> }
