// SPDX-License-Identifier: MIT
// Pure parser for the board-side /flash/config.json declaration. The file is a
// user-provided configuration statement, never a measured hardware identity:
// drivers still apply FPIOA mapping later and the cached runtime copy can lag
// the file until reboot. See docs/0.1.3/evidence/board-source-audit.md.
import { BOARD_DEFINITIONS, BoardDefinition } from './nodu-board-data';

export interface BoardInspection {
    status: 'declared' | 'unknown' | 'missing' | 'invalid' | 'conflict' | 'unavailable';
    source: '/flash/config.json';
    /** Catalog id only when the declaration matches one frozen definition. */
    boardId?: string;
    declaredType?: string;
    configName?: string;
    pins: Record<string, number>;
    peripherals: Record<string, Record<string, number>>;
    issues: string[];
}

export const BOARD_CONFIG_MAX_BYTES = 16 * 1024;
const IDENTIFIER_MAX_LENGTH = 80;
const PIN_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const FORBIDDEN_PINS = new Set(['__proto__', 'constructor', 'prototype']);
const D_ARRAY_MAX_LENGTH = 48;
// Generic placeholders do not assert a board model.
const GENERIC_IDENTIFIERS = new Set(['config', 'config.json', 'template', 'default']);
const PERIPHERAL_IO: Record<string, readonly string[]> = {
    sensor: ['cmos_pclk', 'cmos_xclk', 'cmos_href', 'cmos_pwdn', 'cmos_vsync', 'cmos_rst', 'pin_clk', 'pin_sda'],
    lcd: ['rst', 'dcx', 'ss', 'clk'],
    sdcard: ['sclk', 'mosi', 'miso', 'cs'],
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const isIo = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 47;

export function inspectBoardConfig(text: string): BoardInspection {
    const inspection: BoardInspection = {
        status: 'invalid', source: '/flash/config.json', pins: {}, peripherals: {}, issues: []
    };
    if (typeof text !== 'string' || !text.trim()) {
        inspection.issues.push('板端配置文件为空。');
        return inspection;
    }
    if (new TextEncoder().encode(text).length > BOARD_CONFIG_MAX_BYTES) {
        inspection.issues.push(`板端配置超过 ${BOARD_CONFIG_MAX_BYTES} 字节上限。`);
        return inspection;
    }
    let config: unknown;
    try {
        config = JSON.parse(text);
    } catch {
        inspection.issues.push('板端配置不是有效的 JSON。');
        return inspection;
    }
    if (!isPlainObject(config)) {
        inspection.issues.push('板端配置的顶层必须是 JSON 对象。');
        return inspection;
    }

    let identifiersValid = true;
    const identifier = (key: 'type' | 'config_name'): string | undefined => {
        const value = config[key];
        if (value === undefined || value === null) { return undefined; }
        if (typeof value !== 'string') {
            inspection.issues.push(`板端配置的 ${key} 必须是字符串。`);
            identifiersValid = false;
            return undefined;
        }
        if (value.length > IDENTIFIER_MAX_LENGTH) {
            inspection.issues.push(`板端配置的 ${key} 过长，未采用。`);
            identifiersValid = false;
            return undefined;
        }
        return value;
    };
    const declaredType = identifier('type');
    const configName = identifier('config_name');
    // A malformed identifier must never combine with a valid sibling into a
    // confident match: the whole document is rejected instead.
    if (!identifiersValid) { return inspection; }
    if (declaredType !== undefined) { inspection.declaredType = declaredType; }
    if (configName !== undefined) { inspection.configName = configName; }
    const typeAsserted = !!declaredType && !GENERIC_IDENTIFIERS.has(declaredType.toLowerCase());
    const nameAsserted = !!configName && !GENERIC_IDENTIFIERS.has(configName.toLowerCase());

    // board_info is a dictionary of logical aliases to SoC IO numbers. Metadata
    // slots (pin_num count, pin_name list, D array) are shape-checked but never
    // reported as pins; any malformed entry fails the whole inspection so a bad
    // file cannot silently drop values.
    const pins: Record<string, number> = {};
    const setPin = (name: string, io: number): boolean => {
        if (name in pins && pins[name] !== io) {
            inspection.issues.push(`board_info 别名 ${name} 被声明为不同的芯片 IO。`);
            return false;
        }
        pins[name] = io;
        return true;
    };
    if (config.board_info !== undefined) {
        if (!isPlainObject(config.board_info)) {
            inspection.issues.push('board_info 必须是对象。');
            return inspection;
        }
        let pinsValid = true;
        for (const [name, value] of Object.entries(config.board_info)) {
            if (name === 'pin_num') {
                if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > D_ARRAY_MAX_LENGTH) {
                    inspection.issues.push('board_info.pin_num 必须是 0–48 的整数。');
                    pinsValid = false;
                }
                continue;
            }
            if (name === 'pin_name') {
                if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
                    inspection.issues.push('board_info.pin_name 必须是字符串数组。');
                    pinsValid = false;
                }
                continue;
            }
            if (name === 'D') {
                if (!Array.isArray(value) || value.length > D_ARRAY_MAX_LENGTH) {
                    inspection.issues.push(`board_info.D 必须是不超过 ${D_ARRAY_MAX_LENGTH} 项的 IO 数组。`);
                    pinsValid = false;
                    break;
                }
                for (let index = 0; index < value.length; index++) {
                    const io = value[index];
                    if (!isIo(io)) {
                        inspection.issues.push(`board_info.D[${index}] 不是 0–47 的芯片 IO。`);
                        pinsValid = false;
                        break;
                    }
                    if (!setPin(`D${index}`, io)) { pinsValid = false; break; }
                }
                if (!pinsValid) { break; }
                continue;
            }
            if (!PIN_NAME.test(name) || FORBIDDEN_PINS.has(name)) {
                inspection.issues.push(`board_info 别名 ${JSON.stringify(name.slice(0, 64))} 无效。`);
                pinsValid = false;
                break;
            }
            if (!isIo(value)) {
                inspection.issues.push(`board_info.${name} 不是 0–47 的芯片 IO。`);
                pinsValid = false;
                break;
            }
            if (!setPin(name, value)) { pinsValid = false; break; }
        }
        if (!pinsValid) { return inspection; }
    }

    // Only documented physical IO keys are extracted; register widths, GPIO
    // indexes and other firmware parameters stay out of the pin tables. A
    // present-but-malformed section invalidates the whole declaration rather
    // than being silently omitted. Pins and peripherals stay local until every
    // section validated, so an early invalid result is always empty.
    const peripherals: Record<string, Record<string, number>> = {};
    for (const [peripheral, keys] of Object.entries(PERIPHERAL_IO)) {
        const section = config[peripheral];
        if (section === undefined || section === null) { continue; }
        if (!isPlainObject(section)) {
            inspection.issues.push(`${peripheral} 必须是对象。`);
            return inspection;
        }
        const pinsOf: Record<string, number> = {};
        for (const key of keys) {
            const value = section[key];
            if (value === undefined) { continue; }
            if (!isIo(value)) {
                inspection.issues.push(`${peripheral}.${key} 不是 0–47 的芯片 IO。`);
                return inspection;
            }
            pinsOf[key] = value;
        }
        if (Object.keys(pinsOf).length) { peripherals[peripheral] = pinsOf; }
    }
    inspection.pins = pins;
    inspection.peripherals = peripherals;

    const byType = typeAsserted ? BOARD_DEFINITIONS.filter(board => board.declaredTypes.includes(declaredType!)) : [];
    const byName = nameAsserted ? BOARD_DEFINITIONS.filter(board => board.configNames.includes(configName!)) : [];
    let candidate: BoardDefinition | undefined;
    if (byType.length && byName.length) {
        if (byType[0].id !== byName[0].id) {
            inspection.status = 'conflict';
            inspection.issues.push(`板端 type 声明为 ${declaredType}，config_name 声明为 ${configName}，指向不同开发板。`);
        } else {
            candidate = byType[0];
        }
    } else if (byType.length) {
        if (nameAsserted) {
            inspection.status = 'conflict';
            inspection.issues.push(`板端 type 声明为 ${declaredType}，但 config_name ${configName} 不在资料库中。`);
        } else { candidate = byType[0]; }
    } else if (byName.length) {
        if (typeAsserted) {
            inspection.status = 'conflict';
            inspection.issues.push(`板端 config_name 声明为 ${configName}，但 type ${declaredType} 不在资料库中。`);
        } else { candidate = byName[0]; }
    } else if (typeAsserted || nameAsserted) {
        inspection.status = 'unknown';
        inspection.issues.push('板端声明了资料库未收录的板型标识。');
    } else {
        inspection.status = 'unknown';
        inspection.issues.push('板端配置未声明板型标识。');
    }

    // A matched declaration still has to agree with the aliases it carries:
    // same-name pins wired to different IO mean the file was customised and the
    // catalog entry must not be presented as the detected model.
    if (candidate) {
        const differences = Object.keys(candidate.pins)
            .filter(name => name in pins && pins[name] !== candidate!.pins[name]);
        if (differences.length) {
            inspection.status = 'conflict';
            for (const name of differences) {
                inspection.issues.push(`别名 ${name}：板端为 IO${pins[name]}，${candidate.label} 资料为 IO${candidate.pins[name]}。`);
            }
        } else {
            inspection.status = 'declared';
            inspection.boardId = candidate.id;
        }
    }
    return inspection;
}

/** Read-only lookup sample for the optional board-side helper module. */
export function boardPinSample(name: string): string {
    return `import nodu_board\nprint(nodu_board.pin(${JSON.stringify(name)}))`;
}
