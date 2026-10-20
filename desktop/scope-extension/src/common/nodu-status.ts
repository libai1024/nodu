// SPDX-License-Identifier: MIT
// Original-IDE status strings for the 0.1.4 layout parity pass:
// the histogram "Res - ..." line and the bottom status bar items
// 固件版本 / 串行端口 / FPS. Labels match MaixPy IDE 0.2.5 verbatim.
// Ported from openmv-qt-creator openmvplugin.cpp (MIT)
//
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/openmvplugin.cpp

export interface ResRoi { x: number; y: number; width: number; height: number }

/** resLabel text: "Res - 没有图像" with no frame; ROI >1px2 reports pixel count,
 * a degenerate ROI is the click point variant, an empty ROI is invalid in Qt
 * and falls back to the plain resolution. */
export function histogramResolutionText(
    width: number | undefined, height: number | undefined, roi?: ResRoi,
): string {
    if (width === undefined || height === undefined || width <= 0 || height <= 0) {
        return 'Res - 没有图像';
    }
    if (roi && roi.width > 0 && roi.height > 0) {
        if (roi.width > 1 || roi.height > 1) {
            return `Res (w:${width}, h:${height}) - ROI (x:${roi.x}, y:${roi.y}, w:${roi.width}, h:${roi.height}) - Pixels (${roi.width * roi.height})`;
        }
        return `Res (w:${width}, h:${height}) - Point (x:${roi.x}, y:${roi.y})`;
    }
    return `Res (w:${width}, h:${height})`;
}

/** Status bar items keep the label with an empty value when disconnected. */
export function firmwareStatusText(firmware: string | undefined): string {
    return `固件版本：${firmware ?? ''}`;
}

export function serialPortStatusText(port: string | undefined): string {
    return `串行端口：${port ?? ''}`;
}

export function fpsStatusText(fps: number | undefined): string {
    return `FPS：${typeof fps === 'number' ? fps.toFixed(1) : ''}`;
}
