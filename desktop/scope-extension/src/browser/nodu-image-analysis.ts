// SPDX-License-Identifier: MIT
// Color math is provided by color-convert 2.0.1 (MIT), not copied from OpenMV.
const convert = require('color-convert') as { rgb: { lab: { raw(value: readonly number[]): number[] } } };

export interface ImageRect { x: number; y: number; width: number; height: number; }
export interface ImagePoint { x: number; y: number; }
export type LabThreshold = [number, number, number, number, number, number];
export const DEFAULT_LAB_THRESHOLD: LabThreshold = [0, 100, -128, 127, -128, 127];
export const MAX_DECODED_PIXELS = 1_048_576;
export const MAX_ANALYSIS_PIXELS = 262_144;
export interface ImageHistogram { red: Uint32Array; green: Uint32Array; blue: Uint32Array; gray: Uint32Array; count: number; }

export function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }

/** Coordinates are inclusive pixel indices; even a click selects exactly one pixel. */
export function rectFromPoints(first: ImagePoint, last: ImagePoint, width: number, height: number): ImageRect {
    const x1 = clamp(Math.floor(first.x), 0, width - 1), y1 = clamp(Math.floor(first.y), 0, height - 1);
    const x2 = clamp(Math.floor(last.x), 0, width - 1), y2 = clamp(Math.floor(last.y), 0, height - 1);
    return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1) + 1, height: Math.abs(y2 - y1) + 1 };
}

export function clampRect(rect: ImageRect | undefined, width: number, height: number): ImageRect {
    if (!rect) { return { x: 0, y: 0, width, height }; }
    const x = Math.floor(clamp(rect.x, 0, width - 1)), y = Math.floor(clamp(rect.y, 0, height - 1));
    return { x, y, width: Math.floor(clamp(rect.width, 1, width - x)), height: Math.floor(clamp(rect.height, 1, height - y)) };
}

/** Cover the same region when an analysis raster is smaller than the source. */
export function scaleRect(rect: ImageRect | undefined, sourceWidth: number, sourceHeight: number, width: number, height: number): ImageRect {
    const source = clampRect(rect, sourceWidth, sourceHeight);
    const x = Math.floor(source.x * width / sourceWidth), y = Math.floor(source.y * height / sourceHeight);
    return clampRect({ x, y, width: Math.ceil((source.x + source.width) * width / sourceWidth) - x, height: Math.ceil((source.y + source.height) * height / sourceHeight) - y }, width, height);
}

export function analysisSize(width: number, height: number): { width: number; height: number } {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width > 2048 || height > 2048 || width * height > MAX_DECODED_PIXELS) {
        throw new Error('图像尺寸超过工具上限（最多 1,048,576 像素，单边最多 2048）。');
    }
    const factor = Math.min(1, Math.sqrt(MAX_ANALYSIS_PIXELS / (width * height)));
    return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) };
}

/** PC sRGB/D65 CIELAB. JPEG and floating point differ from the board's RGB565/LAB LUT. */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
    const lab = convert.rgb.lab.raw([r, g, b]);
    return [clamp(lab[0], 0, 100), clamp(lab[1], -128, 127), clamp(lab[2], -128, 127)];
}

function assertRaster(rgba: Uint8ClampedArray, width: number, height: number): void {
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 || width * height > MAX_ANALYSIS_PIXELS || rgba.length !== width * height * 4) {
        throw new Error('分析图像的尺寸或像素数据无效。');
    }
}

/** Chunked conversion yields to the UI and lets the caller cancel stale decodes. */
export async function buildLabRaster(rgba: Uint8ClampedArray, width: number, height: number, current: () => boolean, yieldTask: () => Promise<void>): Promise<Float32Array | undefined> {
    assertRaster(rgba, width, height);
    const lab = new Float32Array(width * height * 3);
    for (let start = 0; start < width * height; start += 8192) {
        if (!current()) { return undefined; }
        const end = Math.min(start + 8192, width * height);
        for (let index = start; index < end; index++) {
            const offset = index * 4;
            const sample = rgbToLab(rgba[offset], rgba[offset + 1], rgba[offset + 2]);
            lab.set(sample, index * 3);
        }
        if (end < width * height) { await yieldTask(); }
    }
    return current() ? lab : undefined;
}

export function histogram(rgba: Uint8ClampedArray, width: number, height: number, selection?: ImageRect): ImageHistogram {
    assertRaster(rgba, width, height);
    const rect = clampRect(selection, width, height);
    const result: ImageHistogram = { red: new Uint32Array(256), green: new Uint32Array(256), blue: new Uint32Array(256), gray: new Uint32Array(256), count: rect.width * rect.height };
    for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
            const index = (y * width + x) * 4;
            const r = rgba[index], g = rgba[index + 1], b = rgba[index + 2];
            result.red[r]++; result.green[g]++; result.blue[b]++;
            result.gray[Math.round(.2126 * r + .7152 * g + .0722 * b)]++;
        }
    }
    return result;
}

export function updateThreshold(threshold: LabThreshold, index: number, value: number): LabThreshold {
    const next = [...threshold] as LabThreshold;
    if (!Number.isInteger(index) || index < 0 || index > 5) { throw new Error('阈值通道无效。'); }
    next[index] = Math.round(clamp(value, index < 2 ? 0 : -128, index < 2 ? 100 : 127));
    const paired = index % 2 === 0 ? index + 1 : index - 1;
    next[paired] = index % 2 === 0 ? Math.max(next[paired], next[index]) : Math.min(next[paired], next[index]);
    return next;
}

export function thresholdMask(lab: Float32Array, width: number, height: number, threshold: LabThreshold, selection?: ImageRect): { rgba: Uint8ClampedArray; matched: number; total: number } {
    if (width * height > MAX_ANALYSIS_PIXELS || width < 1 || height < 1 || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || lab.length !== width * height * 3) { throw new Error('LAB 像素数据无效。'); }
    const rect = clampRect(selection, width, height);
    const rgba = new Uint8ClampedArray(width * height * 4);
    let matched = 0;
    for (let index = 0; index < width * height; index++) { rgba[index * 4 + 3] = 255; }
    for (let y = rect.y; y < rect.y + rect.height; y++) {
        for (let x = rect.x; x < rect.x + rect.width; x++) {
            const index = y * width + x, l = index * 3;
            if (lab[l] >= threshold[0] && lab[l] <= threshold[1] && lab[l + 1] >= threshold[2] && lab[l + 1] <= threshold[3] && lab[l + 2] >= threshold[4] && lab[l + 2] <= threshold[5]) {
                const p = index * 4;
                rgba[p] = rgba[p + 1] = rgba[p + 2] = 255;
                matched++;
            }
        }
    }
    return { rgba, matched, total: rect.width * rect.height };
}

export function thresholdTuple(threshold: LabThreshold): string { return `(${threshold.join(', ')})`; }
