// SPDX-License-Identifier: MIT
// Numerical core: desktop/native/crates/nodu-imaging (Rust, MIT; its own
// header carries the OpenMV/MaixPy provenance lines), compiled to WASM by
// scripts/build-imaging.cjs. This module only marshals data across
// the boundary; it reimplements no color math and has no JS fallback —
// a missing or broken WASM build fails loudly at initializeImaging().
import { analyze_rgba, initSync, lab_rgba, orb_edit, orb_info, tag_pixels, threshold_rgba } from '../../resources/imaging/nodu_imaging';
import { wasmBase64 } from '../../resources/imaging/wasm-bytes';
import { ImageRect } from './nodu-image-analysis';

/** Shared image-source bound: files above this are rejected before decode. */
export const MAX_IMAGE_FILE_BYTES = 8 * 1024 * 1024;

/** Encoded `DeviceFrame.data` (base64) gate matching `MAX_IMAGE_FILE_BYTES`. */
export function frameDataWithinLimit(base64Length: number): boolean {
    return base64Length <= Math.ceil(MAX_IMAGE_FILE_BYTES / 3) * 4;
}

export type ColorSpace = 'rgb' | 'gray' | 'lab' | 'yuv';
export interface ChannelStatistics { mean: number; median: number; mode: number; stdev: number; min: number; max: number; lq: number; uq: number; }
export interface NativeChannel { name: string; values: number[]; bins: number[]; statistics: ChannelStatistics; }
export interface NativeHistogram { count: number; channels: NativeChannel[]; }
export type ThresholdMode = 'lab' | 'gray';

const SPACES: Record<ColorSpace, number> = { rgb: 0, gray: 1, lab: 2, yuv: 3 };
const THRESHOLD_MODES: Record<ThresholdMode, number> = { lab: 0, gray: 1 };

let ready = false;
export function initializeImaging(): void {
    if (!ready) {
        // Embedded bytes keep the app offline and avoid fetch/URL/CSP variance.
        initSync({ module: Uint8Array.from(atob(wasmBase64), c => c.charCodeAt(0)) });
        ready = true;
    }
}

function bytes(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
    return new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
}

function roiOf(roi: ImageRect | undefined): Uint32Array {
    return roi ? Uint32Array.of(roi.x, roi.y, roi.width, roi.height) : new Uint32Array(0);
}

export function analyze(rgba: Uint8ClampedArray, width: number, height: number, roi: ImageRect | undefined, space: ColorSpace): NativeHistogram {
    initializeImaging();
    return JSON.parse(analyze_rgba(bytes(rgba), width, height, roiOf(roi), SPACES[space])) as NativeHistogram;
}

/** Full-resolution LAB raster via the pinned lookup table (3 values per pixel). */
export function labRaster(rgba: Uint8ClampedArray, width: number, height: number): Int16Array {
    initializeImaging();
    return lab_rgba(bytes(rgba), width, height);
}

/** Black/white RGBA mask; pixels outside `roi` stay black. */
export function binary(rgba: Uint8ClampedArray, width: number, height: number, roi: ImageRect | undefined, bounds: readonly number[], mode: ThresholdMode, invert = false): Uint8ClampedArray {
    initializeImaging();
    return new Uint8ClampedArray(threshold_rgba(bytes(rgba), width, height, roiOf(roi), Int16Array.from(bounds), THRESHOLD_MODES[mode], invert));
}

/** Grayscale AprilTag pixels; the caller scales/edges the tiny raster. */
export function tagPixels(family: string, id: number): Uint8Array {
    initializeImaging();
    return tag_pixels(family, id);
}

export interface OrbInfo {
    kind: number;
    /** Each entry is [x, y, score, octave, angle]. */
    points: [number, number, number, number, number][];
}

/** `.orb` container metadata; invalid files throw the decoder's message. */
export function orbInfo(data: Uint8Array): OrbInfo {
    initializeImaging();
    return JSON.parse(orb_info(data)) as OrbInfo;
}

/** Edit an `.orb` file: strictly increasing kept indices, optional same-kind merge. */
export function editOrb(data: Uint8Array, keep: readonly number[], merge: Uint8Array = new Uint8Array(0)): Uint8Array {
    initializeImaging();
    return orb_edit(data, Uint32Array.from(keep), merge);
}
