// SPDX-License-Identifier: MIT
import { PortInfo } from './nodu-embedded-protocol';
/** Keep a user's choice through unplugging; only suggest an unambiguous USB device. */
export function preferredMonitorPort(current: string, ports: PortInfo[]): string {
    if (current) { return current; }
    const usb = ports.filter(port => port.vid !== undefined);
    return usb.length === 1 ? usb[0].path : '';
}
