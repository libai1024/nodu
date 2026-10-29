import type { ArduinoPort } from './nodu-arduino-protocol';

/** A unique USB/UART bridge is a default candidate; native USB and ambiguous lists stay manual. */
export function preferredArduinoUartPort(ports: readonly ArduinoPort[]): ArduinoPort | undefined {
    const bridgeVendors = new Set([0x1a86, 0x10c4, 0x0403, 0x067b]);
    const candidates = ports.filter(port => port.vid !== undefined && bridgeVendors.has(port.vid)
        && /^(?:COM[1-9]\d*|\/dev\/[^\0\r\n]+)$/i.test(port.path));
    return candidates.length === 1 ? candidates[0] : undefined;
}
