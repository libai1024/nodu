// SPDX-License-Identifier: MIT
// Pin facts transcribed from the sources below. IO numbers are SoC IO indices,
// never connector contact numbers or GPIO/GPIOHS channel numbers.
// Sipeed tables: MIT, Copyright (c) 2019 sipeed (see THIRD-PARTY-NOTICES.md).
export interface BoardDefinition {
    id: string;
    label: string;
    declaredTypes: readonly string[];
    configNames: readonly string[];
    pins: Readonly<Record<string, number>>;
    source: string;
    description: string;
}

const scripts = 'https://github.com/sipeed/MaixPy-v1_scripts/blob/8d7c5f98ba654d226f433d31718d852674cab08d/board/';
export const BOARD_DEFINITIONS: readonly BoardDefinition[] = [
    {
        id: 'embedfire-cam-gc2145', label: '野火 K210 CAM',
        declaredTypes: ['embedfire'], configNames: ['embedfire-k210'],
        pins: { USER_LED: 17, BOOT_KEY: 16 },
        source: 'artifacts/ide-diag/config.json',
        description: '当前项目所用相机板。板端配置包含 GC2145 相机适配所需的引脚；相机型号仍需对照实物。',
    },
    {
        id: 'maix-bit', label: 'Sipeed Maix Bit',
        declaredTypes: ['bit'], configNames: [],
        pins: { BOOT_KEY: 16, LED_R: 13, LED_G: 12, LED_B: 14, MIC0_WS: 19, MIC0_DATA: 20, MIC0_BCK: 18 },
        source: scripts + 'config_maix_bit.py',
        description: '官方 bit 配置的引脚别名。旧版和带麦克风版本的连接复位方式需单独选择。',
    },
    {
        id: 'maix-dock', label: 'Sipeed Maix Dock',
        declaredTypes: ['dock'], configNames: [],
        pins: { BOOT_KEY: 16, LED_R: 14, LED_G: 13, LED_B: 12, WIFI_TX: 6, WIFI_RX: 7, WIFI_EN: 8,
            MIC0_WS: 30, MIC0_DATA: 20, MIC0_BCK: 32, I2S_WS: 33, I2S_DA: 34, I2S_BCK: 35 },
        source: scripts + 'config_maix_dock.py',
        description: '官方 dock 配置。LED 与麦克风的引脚映射不同于 Bit，示例应使用逻辑别名。',
    },
    {
        id: 'maix-go', label: 'Sipeed Maix Go',
        declaredTypes: ['Go'], configNames: [],
        pins: { BOOT_KEY: 16, LED_R: 14, LED_G: 12, LED_B: 13, WIFI_TX: 6, WIFI_RX: 7, WIFI_EN: 8,
            MIC0_WS: 19, MIC0_DATA: 20, MIC0_BCK: 18, I2S_WS: 33, I2S_DA: 34, I2S_BCK: 35 },
        source: scripts + 'config_maix_go.py',
        description: '官方 Go 配置。该声明无法区分新旧 CMSIS-DAP 版本，复位方式保持独立设置。',
    },
    {
        id: 'maixduino', label: 'Sipeed Maixduino',
        declaredTypes: ['duino'], configNames: [],
        pins: { BOOT_KEY: 16, LED_R: 13, LED_G: 12, LED_B: 14, WIFI_TX: 6, WIFI_RX: 7, WIFI_EN: 8,
            MIC0_WS: 19, MIC0_DATA: 20, MIC0_BCK: 18, I2S_WS: 33, I2S_DA: 34, I2S_BCK: 35,
            ESP32_CS: 25, ESP32_RST: 8, ESP32_RDY: 9, ESP32_MOSI: 28, ESP32_MISO: 26, ESP32_SCLK: 27,
            PIN0: 4, PIN1: 5, PIN2: 21, PIN3: 22, PIN4: 23, PIN5: 24, PIN6: 32,
            PIN7: 15, PIN8: 14, PIN9: 13, PIN10: 12, PIN11: 11, PIN12: 10, PIN13: 3 },
        source: scripts + 'config_maix_duino.py',
        description: '官方 duino 配置。PIN0 等接口别名与芯片 IO 号不同，例如 PIN0 对应 IO4。',
    },
];

export interface ConnectorDefinition {
    id: string;
    label: string;
    ioVoltage: string;
    contacts: readonly (number | 'GND' | '3.3V' | '5V' | '1.8V')[];
    source: string;
}

// Contact arrays are in numerical order, starting at contact 1. The vendor
// tables do not establish pin-1 orientation in the photograph; the 3D model
// must not label individual holes as numbered wiring positions.
export const EMBEDFIRE_CONNECTORS: readonly ConnectorDefinition[] = [
    {
        id: 'header-1', label: '引脚组 1', ioVoltage: '3.3V',
        contacts: ['3.3V', '5V', 36, '5V', 37, 'GND', 38, 0, 'GND', 1, 39, 2, 40, 'GND',
            41, 3, '3.3V', 10, 42, 'GND', 43, 11, 44, 46, 45, 47, 'GND', 'GND'],
        source: 'https://doc.embedfire.com/k210/quick_start/zh/latest/_images/pin1.png',
    },
    {
        id: 'header-2', label: '引脚组 2', ioVoltage: '1.8V',
        contacts: ['1.8V', 34, 32, 35, 33, 'GND'],
        source: 'https://doc.embedfire.com/k210/quick_start/zh/latest/_images/pin2.png',
    },
];
