// SPDX-License-Identifier: MIT

export interface LauncherSearchItem {
    name: string;
    path: string;
    tag?: string;
    summary?: string;
}

export function launcherSearchMatch(item: LauncherSearchItem, query: string): boolean {
    const needle = query.trim().toLowerCase();
    if (!needle) { return true; }
    return `${item.name}\n${item.path}\n${item.tag ?? ''}\n${item.summary ?? ''}`.toLowerCase().includes(needle);
}

export function launcherProjectMonogram(tag: string | undefined, name: string): string {
    const value = tag?.trim().toUpperCase() ?? '';
    const stm32 = /^STM32(F\d)/.exec(value);
    if (stm32) { return stm32[1]; }
    if (value.startsWith('K210')) { return 'K2'; }
    if (value.startsWith('ESP32')) { return 'E'; }
    return Array.from(name.trim())[0]?.toUpperCase() ?? '';
}

export function nextLauncherIndex(current: number, key: string, count: number): number {
    if (count <= 0) { return -1; }
    if (key === 'Home') { return 0; }
    if (key === 'End') { return count - 1; }
    if (key === 'ArrowDown') { return Math.min(count - 1, current + 1); }
    if (key === 'ArrowUp') { return current < 0 ? count - 1 : Math.max(0, current - 1); }
    return -1;
}
