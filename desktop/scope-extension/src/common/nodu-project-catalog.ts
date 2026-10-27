// SPDX-License-Identifier: MIT
/** Project targets are silicon models, independent of board wiring. */
export type ProjectFamily = 'k210' | 'stm32f103' | 'stm32f407' | 'esp32';
export type EspProjectFramework = 'arduino' | 'esp-idf';
export const ESP_PROJECT_FRAMEWORKS: readonly { id: EspProjectFramework; name: string }[] = [
    { id: 'arduino', name: 'Arduino' }, { id: 'esp-idf', name: 'ESP-IDF' },
];
// Fixed release baseline; installed projects keep the version in their sketch profile.
export const ESP32_ARDUINO_CORE_VERSION = '3.3.12';
export const ESP32_ARDUINO_INDEX_URL = 'https://espressif.github.io/arduino-esp32/package_esp32_index.json';
export interface ProjectChip { id: string; name: string; family: ProjectFamily; pack?: string }
export const PROJECT_FAMILIES: { id: ProjectFamily; name: string }[] = [
    { id: 'k210', name: 'K210' }, { id: 'stm32f103', name: 'STM32F103' },
    { id: 'stm32f407', name: 'STM32F407' }, { id: 'esp32', name: 'ESP32' },
];
export const PROJECT_CHIPS: ProjectChip[] = [
    { id: 'k210', name: 'K210', family: 'k210' },
    { id: 'STM32F103C8Tx', name: 'STM32F103C8T6', family: 'stm32f103', pack: 'chip-f103c8@1' },
    { id: 'STM32F407ZGTx', name: 'STM32F407ZGT6', family: 'stm32f407', pack: 'chip-f407zg@1' },
    ...['ESP32', 'ESP32-S2', 'ESP32-S3', 'ESP32-C2', 'ESP32-C3', 'ESP32-C6', 'ESP32-H2', 'ESP32-P4']
        .map(name => ({ id: name.toLowerCase().replace('-', ''), name, family: 'esp32' as const })),
];
export const DAXIN_TEMPLATES = [
    { id: 'dacir-temperature-humidity', source: 'temperature-humidity', name: '搭芯温湿度 OLED' },
    { id: 'dacir-warehouse', source: 'warehouse', name: '搭芯仓库温湿度监测' },
    { id: 'dacir-esp8266', source: 'esp8266', name: '搭芯 ESP8266 联网' },
] as const;
export function projectTemplates(family: ProjectFamily, chipId?: string, framework: EspProjectFramework = 'arduino'): { id: string; name: string }[] {
    return [
        { id: 'empty', name: '默认项目' },
        { id: 'hello', name: family === 'esp32' && framework === 'arduino' ? '串口示例' : 'Hello World' },
        ...(family === 'stm32f103' && (!chipId || chipId === 'STM32F103C8Tx') ? DAXIN_TEMPLATES : []),
    ];
}
export const PROJECT_NAME_RULE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
export function validProjectName(name: string): boolean {
    return PROJECT_NAME_RULE.test(name) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}
