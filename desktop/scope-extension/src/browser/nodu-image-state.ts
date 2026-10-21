// SPDX-License-Identifier: MIT
import { DEFAULT_LAB_THRESHOLD, ImagePoint, ImageRect, LabThreshold } from './nodu-image-analysis';
import { ColorSpace, ThresholdMode } from './nodu-imaging';

/** Owned by the widget, so switching layouts or demo/source never resets tools. */
export class NoduImageToolState {
    roi: ImageRect | undefined;
    samplePoint: ImagePoint | undefined;
    threshold: LabThreshold = [...DEFAULT_LAB_THRESHOLD];
    thresholdMode: ThresholdMode = 'lab';
    grayThreshold: [number, number] = [0, 255];
    invert = false;
    mask = false;
    /** Original 缩放 (缩放到合适大小): scale the frame to the free space; off shows native pixels. */
    fit = true;
    histogram: ColorSpace = 'rgb';
}
