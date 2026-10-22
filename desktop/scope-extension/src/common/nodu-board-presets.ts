// SPDX-License-Identifier: MIT
// Simple-mode board picker: one entry per physical K210 board, each fixing
// the camera profile and the original reset-sequence id (BOARD_MENU), so a
// beginner picks "the board on the desk" instead of three technical fields.
import type { SerialPortInfo } from './generated/SerialPortInfo';

export type BoardProfile = 'embedfire-cam-gc2145' | 'generic-k210';

export type BoardFamilyId = 'k210' | 'stm32' | 'esp32';

export interface BoardFamily {
    id: BoardFamilyId;
    label: string;
    /** One line under the name, e.g. the runtime the boards use. */
    detail: string;
    /** Families without a device backend on main are listed but cannot be picked. */
    available: boolean;
    /** Shown instead of the board count while unavailable. */
    status?: string;
}

/** First step of the simple-mode picker. Only K210 has a backend on main. */
export const BOARD_FAMILIES: readonly BoardFamily[] = [
    { id: 'k210', label: 'K210', detail: 'Kendryte K210 · MaixPy', available: true },
    // STM32 HAL build/flash/monitor is on spec/2026-10-20_validate-stm32-hal (docs/0.2.1, M0).
    { id: 'stm32', label: 'STM32', detail: 'STM32 · C 语言（HAL）', available: false, status: '开发中（0.2.1）' },
    // docs/0.2.1/PRD.md lists ESP32 as out of scope for 0.2.1.
    { id: 'esp32', label: 'ESP32', detail: 'Espressif ESP32', available: false, status: '规划中' },
];

export function familyById(id: string | undefined): BoardFamily | undefined {
    return BOARD_FAMILIES.find(family => family.id === id);
}

export interface BoardPreset {
    id: string;
    family: BoardFamilyId;
    label: string;
    profile: BoardProfile;
    /** Original MaixPy IDE board id 0–8 (connect reset sequence). */
    boardId: number;
}

/** 野火 first (the project's camera board), then the original 选择开发板 order. */
export const BOARD_PRESETS: readonly BoardPreset[] = [
    { id: 'embedfire-k210-cam', family: 'k210', label: '野火 K210 CAM', profile: 'embedfire-cam-gc2145', boardId: 2 },
    { id: 'maix-dock', family: 'k210', label: 'Sipeed Maix Dock', profile: 'generic-k210', boardId: 2 },
    { id: 'maix-bit-mic', family: 'k210', label: 'Sipeed Maix Bit（带麦克风）', profile: 'generic-k210', boardId: 6 },
    { id: 'maix-bit-old', family: 'k210', label: 'Sipeed Maix Bit（旧版）', profile: 'generic-k210', boardId: 1 },
    { id: 'maixduino', family: 'k210', label: 'Sipeed Maixduino', profile: 'generic-k210', boardId: 5 },
    { id: 'maix-go-new', family: 'k210', label: 'Sipeed Maix Go（新版 CMSIS-DAP）', profile: 'generic-k210', boardId: 3 },
    { id: 'maix-go-old', family: 'k210', label: 'Sipeed Maix Go（旧版 CMSIS-DAP）', profile: 'generic-k210', boardId: 4 },
    { id: 'm5stickv', family: 'k210', label: 'M5StickV', profile: 'generic-k210', boardId: 7 },
    { id: 't-watch', family: 'k210', label: 'T-Watch', profile: 'generic-k210', boardId: 8 },
    { id: 'kd233', family: 'k210', label: 'Kendryte KD233', profile: 'generic-k210', boardId: 0 },
];

export function presetsIn(family: BoardFamilyId): BoardPreset[] {
    return BOARD_PRESETS.filter(preset => preset.family === family);
}

export function presetById(id: string | undefined): BoardPreset | undefined {
    return BOARD_PRESETS.find(preset => preset.id === id);
}

export function presetFor(profile: string | undefined, boardId: number | undefined): BoardPreset | undefined {
    return BOARD_PRESETS.find(preset => preset.profile === profile && preset.boardId === boardId);
}

/**
 * Ports a board can be on: USB serial devices only (Bluetooth and debug
 * consoles have no VID), and on macOS only the `cu.*` node of each device —
 * the OS lists every USB serial twice, and `cu.*` is the one to open.
 */
export function boardPorts(ports: readonly SerialPortInfo[]): SerialPortInfo[] {
    const usb = ports.filter(port => port.vid !== undefined || port.path === 'mock');
    return usb.filter(port => !(port.path.startsWith('/dev/tty.')
        && usb.some(other => other.path === `/dev/cu.${port.path.slice('/dev/tty.'.length)}`)));
}

/** Last successful simple-mode connection, kept per user. */
export interface RememberedBoard {
    preset: string;
    port: string;
    serialNumber?: string;
}

/**
 * The port to use for a remembered board: same USB serial number first
 * (the path can change between plugs), then the same path, then the only
 * candidate. Undefined when the choice would be a guess.
 */
export function resolvePort(candidates: readonly SerialPortInfo[], remembered: RememberedBoard | undefined): SerialPortInfo | undefined {
    if (remembered?.serialNumber) {
        const bySerial = candidates.find(port => port.serialNumber === remembered.serialNumber);
        if (bySerial) { return bySerial; }
    }
    if (remembered) {
        const byPath = candidates.find(port => port.path === remembered.port);
        if (byPath) { return byPath; }
    }
    return candidates.length === 1 ? candidates[0] : undefined;
}

/** `/dev/cu.usbserial-3120` → `cu.usbserial-3120`; `COM5` stays. */
export function shortPortName(path: string): string {
    return path.split(/[\\/]/).pop() || path;
}
