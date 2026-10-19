// SPDX-License-Identifier: MIT
import { DEFAULT_LAB_THRESHOLD, ImagePoint, ImageRect, LabThreshold } from './nodu-image-analysis';

/** Owned by the widget, so switching layouts or demo/source never resets tools. */
export class NoduImageToolState {
    roi: ImageRect | undefined;
    samplePoint: ImagePoint | undefined;
    threshold: LabThreshold = [...DEFAULT_LAB_THRESHOLD];
    mask = false;
    zoom: 'fit' | '100' | '200' = 'fit';
    histogram: 'rgb' | 'gray' = 'rgb';
    exportFormat: 'png' | 'jpeg' = 'png';
}
