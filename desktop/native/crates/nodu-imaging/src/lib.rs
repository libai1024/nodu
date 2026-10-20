// SPDX-License-Identifier: MIT
// Ported from openmv/qt-creator@af179e44:src/plugins/openmv/histogram/openmvpluginhistogram.cpp (MIT).
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/histogram/openmvpluginhistogram.cpp
// Copyright (C) 2016 OpenMV, LLC. See desktop/THIRD-PARTY-NOTICES.md.
//! Original IDE color quantization and histogram statistics on decoded RGBA.
//! JPEG pixels differ from the board's original sensor pixels. These results
//! match the pinned IDE algorithm, not a promise of sensor-value equality.

use serde::Serialize;

pub mod orb;

const LAB: &[u8; 196608] = include_bytes!("../data/lab_table.bin");
const YUV: &[u8; 196608] = include_bytes!("../data/yuv_table.bin");
const R5: &[u8; 256] = include_bytes!("../data/rb825_table.bin");
const G6: &[u8; 256] = include_bytes!("../data/g826_table.bin");
const R8: &[u8; 32] = include_bytes!("../data/rb528_table.bin");
const G8: &[u8; 64] = include_bytes!("../data/g628_table.bin");
const MAX_PIXELS: usize = 1_048_576;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Statistics {
    pub mean: i32,
    pub median: i32,
    pub mode: i32,
    pub stdev: i32,
    pub min: i32,
    pub max: i32,
    pub lq: i32,
    pub uq: i32,
}

#[derive(Debug, Serialize)]
pub struct Channel {
    pub name: &'static str,
    pub values: Vec<i32>,
    pub bins: Vec<u32>,
    pub statistics: Statistics,
}

#[derive(Debug, Serialize)]
pub struct Histogram {
    pub count: u32,
    pub channels: Vec<Channel>,
}

/// Byte-reversed RGB565 address, exactly as in the pinned desktop reference.
pub fn rgb565_index(r: u8, g: u8, b: u8) -> usize {
    let (r, g, b) = (
        usize::from(R5[r as usize]),
        usize::from(G6[g as usize]),
        usize::from(R5[b as usize]),
    );
    (r << 3) | (g >> 3) | ((g & 7) << 13) | (b << 8)
}

pub fn lab(r: u8, g: u8, b: u8) -> [i16; 3] {
    let i = rgb565_index(r, g, b) * 3;
    [
        i16::from(LAB[i] as i8),
        i16::from(LAB[i + 1] as i8),
        i16::from(LAB[i + 2] as i8),
    ]
}

pub fn yuv(r: u8, g: u8, b: u8) -> [i16; 3] {
    let i = rgb565_index(r, g, b) * 3;
    [
        i16::from(YUV[i] as i8) + 128,
        i16::from(YUV[i + 1] as i8),
        i16::from(YUV[i + 2] as i8),
    ]
}

fn raster(rgba: &[u8], width: u32, height: u32, roi: &[u32]) -> Result<[usize; 4], String> {
    let pixels = u64::from(width) * u64::from(height);
    if width == 0
        || height == 0
        || width > 2048
        || height > 2048
        || pixels > MAX_PIXELS as u64
        || pixels * 4 != rgba.len() as u64
    {
        return Err("Invalid RGBA dimensions (maximum 2048 per side / 1048576 pixels).".into());
    }
    let rect = match roi {
        [] => [0, 0, width, height],
        [x, y, w, h]
            if *w > 0
                && *h > 0
                && *x < width
                && *y < height
                && *w <= width - *x
                && *h <= height - *y =>
        {
            [*x, *y, *w, *h]
        }
        _ => return Err("ROI must be empty or [x, y, width, height] inside the raster.".into()),
    };
    Ok(rect.map(|v| v as usize))
}

fn stats(bins: &[u32], values: &[i32]) -> Statistics {
    let mut out = Statistics {
        mean: 0,
        median: 0,
        mode: 0,
        stdev: 0,
        min: 0,
        max: 0,
        lq: 0,
        uq: 0,
    };
    let count: u64 = bins.iter().map(|v| u64::from(*v)).sum();
    if count == 0 {
        return out;
    }
    let mut weighted = 0i64;
    let mut peak = 0u32;
    let mut first = true;
    for (&n, &v) in bins.iter().zip(values) {
        weighted += i64::from(n) * i64::from(v);
        if n > peak {
            peak = n;
            out.mode = v;
        }
        if n > 0 {
            if first {
                out.min = v;
                first = false;
            }
            out.max = v;
        }
    }
    // C++ round is halfway away from zero. StDev uses the rounded mean.
    out.mean = (weighted as f64 / count as f64).round() as i32;
    let ranks = [(count + 3) / 4, (count + 1) / 2, (count * 3 + 3) / 4];
    let mut quantiles = [0; 3];
    let mut cumulative = 0u64;
    let mut variance = 0u64;
    for (&n, &v) in bins.iter().zip(values) {
        let next = cumulative + u64::from(n);
        for (rank, target) in ranks.iter().zip(quantiles.iter_mut()) {
            if cumulative < *rank && *rank <= next {
                *target = v;
            }
        }
        let delta = i64::from(v - out.mean);
        variance += u64::from(n) * (delta * delta) as u64;
        cumulative = next;
    }
    [out.lq, out.median, out.uq] = quantiles;
    out.stdev = (variance as f64 / count as f64).sqrt().round() as i32;
    out
}

/// Space: 0 RGB (32/64/32 bins), 1 gray, 2 LAB, 3 YUV.
#[allow(clippy::many_single_char_names)] // x/y/w/h/r/g/b are pixel coordinates
pub fn histogram(
    rgba: &[u8],
    width: u32,
    height: u32,
    roi: &[u32],
    space: u8,
) -> Result<Histogram, String> {
    let [x, y, w, h] = raster(rgba, width, height, roi)?;
    let definitions: Vec<(&str, Vec<i32>)> = match space {
        0 => vec![
            ("R", R8.iter().map(|v| i32::from(*v)).collect()),
            ("G", G8.iter().map(|v| i32::from(*v)).collect()),
            ("B", R8.iter().map(|v| i32::from(*v)).collect()),
        ],
        1 => vec![("Y", (0..256).collect())],
        2 => vec![
            ("L", (0..101).collect()),
            ("A", (-128..128).collect()),
            ("B", (-128..128).collect()),
        ],
        3 => vec![
            ("Y", (0..256).collect()),
            ("U", (-128..128).collect()),
            ("V", (-128..128).collect()),
        ],
        _ => return Err("Unknown color space.".into()),
    };
    let mut channels: Vec<Channel> = definitions
        .into_iter()
        .map(|(name, values)| {
            let bins = vec![0; values.len()];
            Channel {
                name,
                statistics: stats(&bins, &values),
                bins,
                values,
            }
        })
        .collect();
    for yy in y..y + h {
        for xx in x..x + w {
            let p = (yy * width as usize + xx) * 4;
            let (r, g, b) = (rgba[p], rgba[p + 1], rgba[p + 2]);
            let bins = match space {
                0 => [
                    usize::from(R5[r as usize]),
                    usize::from(G6[g as usize]),
                    usize::from(R5[b as usize]),
                ],
                2 => {
                    let c = lab(r, g, b);
                    [c[0] as usize, (c[1] + 128) as usize, (c[2] + 128) as usize]
                }
                _ => {
                    let c = yuv(r, g, b);
                    [c[0] as usize, (c[1] + 128) as usize, (c[2] + 128) as usize]
                }
            };
            for (channel, bin) in channels.iter_mut().zip(bins) {
                channel.bins[bin] += 1;
            }
        }
    }
    for c in &mut channels {
        c.statistics = stats(&c.bins, &c.values);
    }
    Ok(Histogram {
        count: (w * h) as u32,
        channels,
    })
}

pub fn lab_raster(rgba: &[u8], width: u32, height: u32) -> Result<Vec<i16>, String> {
    raster(rgba, width, height, &[])?;
    Ok(rgba
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| lab(p[0], p[1], p[2]))
        .collect())
}

/// Threshold mode: 0 LAB (six bounds), 1 grayscale (two bounds).
#[allow(clippy::many_single_char_names)] // x/y/w/h/r/g/b are pixel coordinates
pub fn threshold(
    rgba: &[u8],
    width: u32,
    height: u32,
    roi: &[u32],
    bounds: &[i16],
    mode: u8,
    invert: bool,
) -> Result<Vec<u8>, String> {
    let [x, y, w, h] = raster(rgba, width, height, roi)?;
    let domains: &[(i16, i16)] = match mode {
        0 => &[(0, 100), (-128, 127), (-128, 127)],
        1 => &[(0, 255)],
        _ => return Err("Unknown threshold mode.".into()),
    };
    if bounds.len() != domains.len() * 2
        || bounds
            .as_chunks::<2>()
            .0
            .iter()
            .zip(domains)
            .any(|(b, (lo, hi))| b.iter().any(|v| v < lo || v > hi))
    {
        return Err("Invalid threshold bounds.".into());
    }
    let mut output = vec![0; rgba.len()];
    for p in output.as_chunks_mut::<4>().0.iter_mut() {
        p[3] = 255;
    }
    for yy in y..y + h {
        for xx in x..x + w {
            let p = (yy * width as usize + xx) * 4;
            let color = if mode == 0 {
                lab(rgba[p], rgba[p + 1], rgba[p + 2])
            } else {
                yuv(rgba[p], rgba[p + 1], rgba[p + 2])
            };
            let matched = bounds
                .as_chunks::<2>()
                .0
                .iter()
                .zip(color)
                .all(|(b, v)| v >= b[0].min(b[1]) && v <= b[0].max(b[1]));
            if matched ^ invert {
                output[p..p + 3].fill(255);
            }
        }
    }
    Ok(output)
}

/// Return a tiny grayscale AprilTag with white outside and black inside border.
/// Code tables are BSD-2-Clause, Regents of the University of Michigan 2013-2016.
pub fn apriltag(family: &str, id: u32) -> Result<(u32, Vec<u8>), String> {
    let (dimension, codes): (u32, &[u8]) = match family {
        "tag16h5" => (4, include_bytes!("../data/tag16h5.bin")),
        "tag25h7" => (5, include_bytes!("../data/tag25h7.bin")),
        "tag25h9" => (5, include_bytes!("../data/tag25h9.bin")),
        "tag36h10" => (6, include_bytes!("../data/tag36h10.bin")),
        "tag36h11" => (6, include_bytes!("../data/tag36h11.bin")),
        "tag36artoolkit" => (6, include_bytes!("../data/tag36artoolkit.bin")),
        _ => return Err("Unknown AprilTag family.".into()),
    };
    let entry = codes
        .as_chunks::<8>()
        .0
        .get(id as usize)
        .ok_or("AprilTag ID is outside the family.")?;
    let code = u64::from_le_bytes(*entry);
    let side = dimension + 4;
    let mut pixels = vec![0; (side * side) as usize];
    for y in 0..side {
        for x in 0..side {
            let white = x == 0
                || y == 0
                || x == side - 1
                || y == side - 1
                || (x >= 2
                    && y >= 2
                    && x < dimension + 2
                    && y < dimension + 2
                    && (code >> ((dimension + 1 - y) * dimension + dimension + 1 - x)) & 1 != 0);
            pixels[(y * side + x) as usize] = if white { 255 } else { 0 };
        }
    }
    Ok((side, pixels))
}

#[cfg(feature = "wasm")]
mod wasm {
    use wasm_bindgen::prelude::*;
    fn js(error: String) -> JsValue {
        JsValue::from_str(&error)
    }
    #[wasm_bindgen]
    pub fn analyze_rgba(
        rgba: &[u8],
        width: u32,
        height: u32,
        roi: &[u32],
        space: u8,
    ) -> Result<String, JsValue> {
        serde_json::to_string(&super::histogram(rgba, width, height, roi, space).map_err(js)?)
            .map_err(|e| js(e.to_string()))
    }
    #[wasm_bindgen]
    pub fn lab_rgba(rgba: &[u8], width: u32, height: u32) -> Result<Vec<i16>, JsValue> {
        super::lab_raster(rgba, width, height).map_err(js)
    }
    #[wasm_bindgen]
    pub fn threshold_rgba(
        rgba: &[u8],
        width: u32,
        height: u32,
        roi: &[u32],
        bounds: &[i16],
        mode: u8,
        invert: bool,
    ) -> Result<Vec<u8>, JsValue> {
        super::threshold(rgba, width, height, roi, bounds, mode, invert).map_err(js)
    }
    #[wasm_bindgen]
    pub fn tag_pixels(family: &str, id: u32) -> Result<Vec<u8>, JsValue> {
        super::apriltag(family, id).map(|(_, p)| p).map_err(js)
    }
    #[wasm_bindgen]
    pub fn orb_info(data: &[u8]) -> Result<String, JsValue> {
        let doc = super::orb::decode(data).map_err(js)?;
        serde_json::to_string(&serde_json::json!({
            "kind": doc.kind,
            "points": doc.points.iter().map(|p| [p.x, p.y, p.score, p.octave, p.angle]).collect::<Vec<_>>()
        }))
        .map_err(|e| js(e.to_string()))
    }
    #[wasm_bindgen]
    pub fn orb_edit(data: &[u8], keep: &[u32], merge: &[u8]) -> Result<Vec<u8>, JsValue> {
        super::orb::edit(data, keep, merge).map_err(js)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reference_statistics_round_mean_before_deviation() {
        let s = stats(&[1, 1, 1, 1], &[-2, -1, 0, 1]);
        assert_eq!(
            (s.mean, s.median, s.mode, s.stdev, s.min, s.max, s.lq, s.uq),
            (-1, -1, -2, 1, -2, 1, -2, 0)
        );
    }
    #[test]
    fn roi_and_rgb_bins() {
        let image = [0, 0, 0, 255, 255, 255, 255, 255];
        let h = histogram(&image, 2, 1, &[1, 0, 1, 1], 0).unwrap();
        assert_eq!(h.count, 1);
        assert_eq!(
            h.channels.iter().map(|c| c.bins.len()).collect::<Vec<_>>(),
            [32, 64, 32]
        );
        assert!(h.channels.iter().all(|c| c.statistics.mean == 255));
        assert!(histogram(&image, 2, 1, &[1, 0, 2, 1], 0).is_err());
    }
    #[test]
    fn threshold_inclusive_reversed_and_invert() {
        let image = [0, 0, 0, 255, 255, 255, 255, 255];
        assert_eq!(
            threshold(&image, 2, 1, &[], &[100, 0, 127, -128, 127, -128], 0, false).unwrap(),
            vec![255; 8]
        );
        assert_eq!(
            threshold(&image, 2, 1, &[], &[0, 0], 1, false).unwrap(),
            [255, 255, 255, 255, 0, 0, 0, 255]
        );
        assert_eq!(
            threshold(&image, 2, 1, &[], &[0, 0], 1, true).unwrap(),
            [0, 0, 0, 255, 255, 255, 255, 255]
        );
    }
    #[test]
    fn tag16h5_first_code_orientation() {
        let (side, p) = apriltag("tag16h5", 0).unwrap();
        assert_eq!(side, 8);
        // Code 0x231b, top-left to bottom-right, most-significant bit first.
        let bits: Vec<u8> = (2..6)
            .flat_map(|y| (2..6).map(move |x| y * 8 + x))
            .map(|i| u8::from(p[i] == 255))
            .collect();
        assert_eq!(bits, [0, 0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 1, 1]);
        assert!(apriltag("tag16h5", 30).is_err());
    }
}
