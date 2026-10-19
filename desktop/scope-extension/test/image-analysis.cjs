// SPDX-License-Identifier: MIT
// Offline color/geometry tests. No device, UI, or user source files are touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    analysisSize, buildLabRaster, clampRect, DEFAULT_LAB_THRESHOLD, histogram,
    MAX_ANALYSIS_PIXELS, rectFromPoints, rgbToLab, scaleRect, thresholdMask,
    thresholdTuple, updateThreshold
} = require('../lib/browser/nodu-image-analysis');
const { copyImageParameters } = require('../lib/browser/nodu-image-clipboard');

const near = (actual, expected, tolerance = .08) => expected.forEach((value, index) => assert.ok(Math.abs(actual[index] - value) < tolerance, `${actual} differs from ${expected}`));
const rgba = (...pixels) => new Uint8ClampedArray(pixels.flatMap(pixel => [...pixel, 255]));

test('sRGB D65 reference colors use explicit PC CIELAB, including endpoints', () => {
    near(rgbToLab(0, 0, 0), [0, 0, 0]);
    near(rgbToLab(255, 255, 255), [100, 0, 0]);
    near(rgbToLab(255, 0, 0), [53.23, 80.11, 67.22]);
    near(rgbToLab(0, 255, 0), [87.74, -86.18, 83.18]);
    near(rgbToLab(0, 0, 255), [32.30, 79.20, -107.86]);
});

test('ROI drag includes endpoints, handles reverse drag, and clamps out-of-image pointers', () => {
    assert.deepEqual(rectFromPoints({ x: 3, y: 2 }, { x: 1, y: 0 }, 4, 3), { x: 1, y: 0, width: 3, height: 3 });
    assert.deepEqual(rectFromPoints({ x: 2.9, y: 1.2 }, { x: 2.9, y: 1.2 }, 4, 3), { x: 2, y: 1, width: 1, height: 1 });
    assert.deepEqual(rectFromPoints({ x: -50, y: -1 }, { x: 500, y: 100 }, 4, 3), { x: 0, y: 0, width: 4, height: 3 });
    assert.deepEqual(clampRect({ x: 3, y: 2, width: 100, height: 0 }, 4, 3), { x: 3, y: 2, width: 1, height: 1 });
    assert.deepEqual(clampRect(undefined, 4, 3), { x: 0, y: 0, width: 4, height: 3 });
});

test('analysis raster preserves small frames, bounds large frames and maps ROI coverage', () => {
    assert.deepEqual(analysisSize(320, 240), { width: 320, height: 240 });
    const size = analysisSize(1024, 1024);
    assert.deepEqual(size, { width: 512, height: 512 });
    assert.ok(size.width * size.height <= MAX_ANALYSIS_PIXELS);
    assert.deepEqual(scaleRect({ x: 3, y: 3, width: 4, height: 4 }, 8, 8, 4, 4), { x: 1, y: 1, width: 3, height: 3 });
    for (const dimensions of [[0, 1], [2049, 1], [1024, 1025], [Infinity, 1], [2.5, 1]]) { assert.throws(() => analysisSize(...dimensions)); }
});

test('histograms count each ROI pixel once and gray uses declared Rec.709 luma', () => {
    const pixels = rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]);
    const full = histogram(pixels, 2, 2);
    assert.equal(full.count, 4);
    assert.equal(full.red[255], 2); assert.equal(full.red[0], 2);
    assert.equal(full.gray[54], 1); assert.equal(full.gray[182], 1); assert.equal(full.gray[18], 1); assert.equal(full.gray[255], 1);
    const selected = histogram(pixels, 2, 2, { x: 1, y: 0, width: 1, height: 2 });
    assert.equal(selected.count, 2); assert.equal(selected.green[255], 2); assert.equal(selected.blue[0], 1);
    assert.equal(selected.red.reduce((a, b) => a + b, 0), selected.count);
    assert.throws(() => histogram(pixels, 3, 2));
});

test('LAB mask uses inclusive bounds, keeps non-ROI pixels black, and counts correctly', async () => {
    const pixels = rgba([255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]);
    const lab = await buildLabRaster(pixels, 2, 2, () => true, async () => {});
    assert.ok(lab);
    const all = thresholdMask(lab, 2, 2, DEFAULT_LAB_THRESHOLD);
    assert.equal(all.matched, 4); assert.equal(all.total, 4); assert.ok(all.rgba.every(value => value === 255));
    const green = thresholdMask(lab, 2, 2, [70, 100, -128, -30, 0, 127]);
    assert.equal(green.matched, 1); assert.deepEqual([...green.rgba.slice(4, 8)], [255, 255, 255, 255]);
    const selected = thresholdMask(lab, 2, 2, DEFAULT_LAB_THRESHOLD, { x: 1, y: 0, width: 1, height: 1 });
    assert.equal(selected.total, 1); assert.equal(selected.matched, 1); assert.deepEqual([...selected.rgba.slice(0, 4)], [0, 0, 0, 255]);
    assert.equal(thresholdMask(new Float32Array([50, -10, 20]), 1, 1, [50, 50, -10, -10, 20, 20]).matched, 1);
    assert.throws(() => thresholdMask(new Float32Array(2), 1, 1, DEFAULT_LAB_THRESHOLD));
});

test('threshold edits remain paired, integer, bounded, and tuple is valid Python syntax', () => {
    assert.deepEqual(updateThreshold([20, 40, -20, 20, -30, 30], 0, 60.2), [60, 60, -20, 20, -30, 30]);
    assert.deepEqual(updateThreshold([20, 40, -20, 20, -30, 30], 3, -200), [20, 40, -128, -128, -30, 30]);
    assert.equal(thresholdTuple(DEFAULT_LAB_THRESHOLD), '(0, 100, -128, 127, -128, 127)');
    assert.throws(() => updateThreshold(DEFAULT_LAB_THRESHOLD, 6, 1));
});

test('chunked LAB conversion can cancel stale frames before publishing results', async () => {
    let current = true, yielded = 0;
    const result = await buildLabRaster(new Uint8ClampedArray(128 * 128 * 4), 128, 128, () => current, async () => { yielded++; current = false; });
    assert.equal(result, undefined); assert.equal(yielded, 1);
    assert.equal(await buildLabRaster(rgba([1, 2, 3]), 1, 1, () => false, async () => {}), undefined);
});

test('clipboard success requires a write acknowledgement; silent permission denial is reported', async () => {
    let listener, disposed = 0;
    const clipboard = { onDidWriteText: callback => { listener = callback; return { dispose: () => { disposed++; } }; }, writeText: async text => listener(text) };
    await copyImageParameters(clipboard, '(0, 100, -128, 127, -128, 127)');
    assert.equal(disposed, 1);
    clipboard.writeText = async () => {};
    await assert.rejects(copyImageParameters(clipboard, 'test'), /未确认写入/);
    assert.equal(disposed, 2);
    clipboard.writeText = async () => { throw new Error('denied'); };
    await assert.rejects(copyImageParameters(clipboard, 'test'), /denied/);
    assert.equal(disposed, 3);
});
