// SPDX-License-Identifier: MIT
/** Versions are immutable; existing projects keep their own profile. */
export const ARDUINO_LIBRARY_BUNDLE = 'esp32-common-20261026';
export const ARDUINO_BUNDLED_LIBRARIES = [
    { name: 'ArduinoJson', version: '7.4.3', direct: true },
    { name: 'ArduinoMqttClient', version: '0.1.8', direct: true },
    { name: 'Adafruit SSD1306', version: '2.5.17', direct: true },
    { name: 'Adafruit GFX Library', version: '1.13.0', direct: true },
    { name: 'Adafruit BusIO', version: '1.17.4', direct: false },
    { name: 'Adafruit NeoPixel', version: '1.15.5', direct: true },
    { name: 'DHT sensor library', version: '1.4.7', direct: true },
    { name: 'Adafruit Unified Sensor', version: '1.1.15', direct: false },
    { name: 'OneWire', version: '2.3.8', direct: false },
    { name: 'DallasTemperature', version: '4.0.6', direct: true },
    { name: 'ESP32Servo', version: '3.2.1', direct: true },
] as const;
/** These APIs are part of the ESP32 Core, never independent Library Manager packages. */
export const ARDUINO_CORE_LIBRARIES = [
    ['WiFi', 'Wi-Fi 网络'], ['HTTPClient', 'HTTP 客户端'], ['WebServer', 'HTTP 服务'],
    ['Network', '网络连接'], ['NetworkClientSecure', 'TLS 网络连接'], ['Wire', 'I²C 总线'],
    ['SPI', 'SPI 总线'], ['Preferences', '持久化键值存储'], ['EEPROM', 'EEPROM 兼容存储'],
    ['FS', '文件系统接口'], ['LittleFS', 'Flash 文件系统'], ['SD', 'SPI SD 卡'],
    ['SD_MMC', 'SDMMC 存储'], ['ArduinoOTA', '网络固件更新'], ['Update', '固件更新'],
    ['AsyncUDP', 'UDP 通信'], ['DNSServer', 'DNS 服务'], ['ESPmDNS', '本地网络发现'],
    ['Ticker', '定时回调'], ['BLE', '低功耗蓝牙'],
] as const;
