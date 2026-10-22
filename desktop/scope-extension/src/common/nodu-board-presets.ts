// SPDX-License-Identifier: MIT
// Simple-mode board picker: one entry per physical K210 board, each fixing
// the camera profile and the original reset-sequence id (BOARD_MENU), so a
// beginner picks "the board on the desk" instead of three technical fields.
import type { SerialPortInfo } from './generated/SerialPortInfo';

export type BoardProfile = 'embedfire-cam-gc2145' | 'generic-k210';

export interface BoardPreset {
    id: string;
    label: string;
    profile: BoardProfile;
    /** Original MaixPy IDE board id 0–8 (connect reset sequence). */
    boardId: number;
}

/** 野火 first (the project's camera board), then the original 选择开发板 order. */
export const BOARD_PRESETS: readonly BoardPreset[] = [
    { id: 'embedfire-k210-cam', label: '野火 K210 CAM', profile: 'embedfire-cam-gc2145', boardId: 2 },
    { id: 'maix-dock', label: 'Sipeed Maix Dock', profile: 'generic-k210', boardId: 2 },
    { id: 'maix-bit-mic', label: 'Sipeed Maix Bit（带麦克风）', profile: 'generic-k210', boardId: 6 },
    { id: 'maix-bit-old', label: 'Sipeed Maix Bit（旧版）', profile: 'generic-k210', boardId: 1 },
    { id: 'maixduino', label: 'Sipeed Maixduino', profile: 'generic-k210', boardId: 5 },
    { id: 'maix-go-new', label: 'Sipeed Maix Go（新版 CMSIS-DAP）', profile: 'generic-k210', boardId: 3 },
    { id: 'maix-go-old', label: 'Sipeed Maix Go（旧版 CMSIS-DAP）', profile: 'generic-k210', boardId: 4 },
    { id: 'm5stickv', label: 'M5StickV', profile: 'generic-k210', boardId: 7 },
    { id: 't-watch', label: 'T-Watch', profile: 'generic-k210', boardId: 8 },
    { id: 'kd233', label: 'Kendryte KD233', profile: 'generic-k210', boardId: 0 },
];

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
