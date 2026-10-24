// SPDX-License-Identifier: MIT
/** Project identity comes from its manifest tag, never a guess based on its folder name. */
export interface ProjectIconIdentity {
    vendor: 'kendryte' | 'stmicroelectronics' | 'espressif' | 'unknown';
    manufacturer: string;
    model?: string;
}

export function projectIconIdentity(tag?: string): ProjectIconIdentity {
    const value = (tag ?? '').trim().toUpperCase().replace(/[\s_-]/g, '');
    if (/^K210$/.test(value)) { return { vendor: 'kendryte', manufacturer: '嘉楠 · Kendryte', model: 'K210' }; }
    const stm32 = /^STM32([A-Z]\d{3})[A-Z0-9]*$/.exec(value);
    if (stm32 || value === 'STM32') {
        return { vendor: 'stmicroelectronics', manufacturer: '意法半导体 · ST', model: stm32?.[1] ?? 'STM32' };
    }
    const esp32 = /^ESP32([SCHP]\d+)?$/.exec(value);
    if (esp32 || value === 'ESP8266') {
        return { vendor: 'espressif', manufacturer: '乐鑫 · Espressif', model: value === 'ESP8266' ? '8266' : esp32?.[1] ?? 'ESP32' };
    }
    return { vendor: 'unknown', manufacturer: tag?.trim() || '普通项目' };
}
