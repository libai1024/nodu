// SPDX-License-Identifier: MIT
/** Explicit opt-in presets; never applied by opening or compiling an existing project. */
export const ARDUINO_SIMULATION_PROFILES = {
    esp32c3: { name: 'ESP32-C3 · 4 MB / 160 MHz', detail: 'UART0 · USB CDC 关闭', fqbn: 'esp32:esp32:esp32c3', options: {
        CPUFreq: '160', FlashSize: '4M', FlashMode: 'qio', FlashFreq: '80', CDCOnBoot: 'default', PartitionScheme: 'default',
    } },
    esp32s3: { name: 'ESP32-S3 · 8 MB / 240 MHz', detail: 'UART0 · USB CDC / PSRAM 关闭 · 主循环与事件 Core 1', fqbn: 'esp32:esp32:esp32s3', options: {
        CPUFreq: '240', FlashSize: '8M', FlashMode: 'qio', CDCOnBoot: 'default', PartitionScheme: 'default_8MB',
        PSRAM: 'disabled', LoopCore: '1', EventsCore: '1', USBMode: 'hwcdc', MSCOnBoot: 'default', DFUOnBoot: 'default', UploadMode: 'default',
    } },
} as const;
export function arduinoSimulationConfigurationError(project: { chip: string; fqbn: string; coreVersion: string }): string | undefined {
    const preset = ARDUINO_SIMULATION_PROFILES[project.chip as keyof typeof ARDUINO_SIMULATION_PROFILES];
    if (!preset || project.coreVersion !== '3.3.12') { return '仿真导出仅支持 Arduino-ESP32 3.3.12 的 ESP32-C3 / ESP32-S3。'; }
    const parts = project.fqbn.split(':'), options = Object.fromEntries((parts[3] || '').split(',').filter(Boolean).map(p => p.split('=')));
    if (parts.length !== 4 || parts.slice(0, 3).join(':') !== preset.fqbn) { return `请在开发板设置中选择“仿真配置：${preset.name}”，然后重新编译。`; }
    const mismatches = Object.entries(preset.options).filter(([key, value]) => options[key] !== value).map(([key, value]) => `${key}=${value}`);
    return mismatches.length ? `当前开发板参数与仿真配置不符（${mismatches.join('、')}）。请在开发板设置中明确选择“${preset.name}”，然后重新编译。` : undefined;
}
