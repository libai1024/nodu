// SPDX-License-Identifier: MIT
// Ported from openmv/qt-creator@af179e44:src/plugins/openmv/tools/keypointseditor.cpp (MIT).
// Source: openmv/qt-creator af179e44cddf396a5ab618792d71e9de5cc67032 src/plugins/openmv/tools/keypointseditor.{cpp,h}
// Copyright (C) 2016 OpenMV, LLC. See desktop/THIRD-PARTY-NOTICES.md.
//! OpenMV IDE `.orb` keypoint container: little-endian u32 type, u32 count,
//! then `count` 42-byte records of five u16 (x, y, score, octave, angle) and a
//! 32-byte descriptor. The original normalized flag is runtime state and is
//! not serialized. Unknown `kind` values and descriptors are preserved; merge
//! requires equal kinds. Unlike the original, truncation/trailing bytes are
//! rejected rather than partially accepted.

const LIMIT: usize = 2 * 1024 * 1024;
const RECORD: usize = 42;
const DESCRIPTOR: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Keypoint {
    pub x: u16,
    pub y: u16,
    pub score: u16,
    pub octave: u16,
    pub angle: u16,
    pub descriptor: [u8; DESCRIPTOR],
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Orb {
    pub kind: u32,
    pub points: Vec<Keypoint>,
}

pub fn decode(data: &[u8]) -> Result<Orb, String> {
    if data.len() < 8 || data.len() > LIMIT {
        return Err(format!("orb size {} outside 8..={LIMIT}", data.len()));
    }
    let kind = u32::from_le_bytes([data[0], data[1], data[2], data[3]]);
    let count = u32::from_le_bytes([data[4], data[5], data[6], data[7]]) as usize;
    let expected = 8usize
        .checked_add(count.checked_mul(RECORD).ok_or("orb count overflows")?)
        .ok_or("orb size overflows")?;
    if data.len() != expected {
        return Err(format!(
            "orb declares {count} points ({expected} bytes) but has {}",
            data.len()
        ));
    }
    let mut points = Vec::with_capacity(count);
    for record in data[8..].as_chunks::<RECORD>().0 {
        let field = |i: usize| u16::from_le_bytes([record[i * 2], record[i * 2 + 1]]);
        let mut descriptor = [0u8; DESCRIPTOR];
        descriptor.copy_from_slice(&record[10..RECORD]);
        points.push(Keypoint {
            x: field(0),
            y: field(1),
            score: field(2),
            octave: field(3),
            angle: field(4),
            descriptor,
        });
    }
    Ok(Orb { kind, points })
}

pub fn encode(orb: &Orb) -> Result<Vec<u8>, String> {
    let count = u32::try_from(orb.points.len()).map_err(|_| "too many points")?;
    let size = 8usize
        .checked_add(
            orb.points
                .len()
                .checked_mul(RECORD)
                .ok_or("orb size overflows")?,
        )
        .ok_or("orb size overflows")?;
    if size > LIMIT {
        return Err(format!("orb output {size} exceeds {LIMIT}"));
    }
    let mut out = Vec::with_capacity(size);
    out.extend_from_slice(&orb.kind.to_le_bytes());
    out.extend_from_slice(&count.to_le_bytes());
    for point in &orb.points {
        out.extend_from_slice(&point.x.to_le_bytes());
        out.extend_from_slice(&point.y.to_le_bytes());
        out.extend_from_slice(&point.score.to_le_bytes());
        out.extend_from_slice(&point.octave.to_le_bytes());
        out.extend_from_slice(&point.angle.to_le_bytes());
        out.extend_from_slice(&point.descriptor);
    }
    Ok(out)
}

/// `keep` must be strictly increasing in-bounds indices into the decoded
/// points; `merge` may be empty or another `.orb` file with the same kind.
pub fn edit(data: &[u8], keep: &[u32], merge: &[u8]) -> Result<Vec<u8>, String> {
    let mut orb = decode(data)?;
    if keep.len() > orb.points.len() {
        return Err(format!(
            "keep has {} indices for {} points",
            keep.len(),
            orb.points.len()
        ));
    }
    let kept = {
        let mut previous: Option<u32> = None;
        let mut kept = Vec::with_capacity(keep.len());
        for &index in keep {
            if previous.is_some_and(|p| index <= p) {
                return Err("keep indices must be strictly increasing".into());
            }
            let point = orb
                .points
                .get(index as usize)
                .ok_or_else(|| format!("keep index {index} out of bounds"))?;
            kept.push(point.clone());
            previous = Some(index);
        }
        kept
    };
    orb.points = kept;
    if !merge.is_empty() {
        let other = decode(merge)?;
        if other.kind != orb.kind {
            return Err(format!("orb kind mismatch: {} vs {}", orb.kind, other.kind));
        }
        orb.points.extend(other.points);
    }
    encode(&orb)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> Vec<u8> {
        let mut data = Vec::new();
        data.extend_from_slice(&7u32.to_le_bytes());
        data.extend_from_slice(&2u32.to_le_bytes());
        data.extend_from_slice(&10u16.to_le_bytes());
        data.extend_from_slice(&20u16.to_le_bytes());
        data.extend_from_slice(&30u16.to_le_bytes());
        data.extend_from_slice(&1u16.to_le_bytes());
        data.extend_from_slice(&90u16.to_le_bytes());
        data.extend_from_slice(&(0u8..32).collect::<Vec<u8>>());
        data.extend_from_slice(&100u16.to_le_bytes());
        data.extend_from_slice(&120u16.to_le_bytes());
        data.extend_from_slice(&40u16.to_le_bytes());
        data.extend_from_slice(&2u16.to_le_bytes());
        data.extend_from_slice(&180u16.to_le_bytes());
        data.extend_from_slice(&[255u8; 32]);
        data
    }

    #[test]
    fn fixture_decodes_and_encodes_byte_identical() {
        let data = fixture();
        let orb = decode(&data).unwrap();
        assert_eq!(orb.kind, 7);
        assert_eq!(orb.points.len(), 2);
        assert_eq!(
            (
                orb.points[0].x,
                orb.points[0].y,
                orb.points[0].score,
                orb.points[0].octave,
                orb.points[0].angle
            ),
            (10, 20, 30, 1, 90)
        );
        assert_eq!(
            orb.points[0].descriptor,
            (0u8..32).collect::<Vec<u8>>().as_slice()
        );
        assert_eq!(orb.points[1].descriptor, [255u8; 32]);
        assert_eq!(encode(&orb).unwrap(), data);
    }

    #[test]
    fn edit_keep_subset_preserves_records() {
        let data = fixture();
        let out = edit(&data, &[1], &[]).unwrap();
        let orb = decode(&out).unwrap();
        assert_eq!(orb.points.len(), 1);
        assert_eq!(orb.points[0].x, 100);
        assert_eq!(orb.points[0].descriptor, [255u8; 32]);
        let all = edit(&data, &[0, 1], &[]).unwrap();
        assert_eq!(all, data);
    }

    #[test]
    fn merge_requires_matching_kind_and_appends() {
        let data = fixture();
        let merged = edit(&data, &[0, 1], &data).unwrap();
        assert_eq!(decode(&merged).unwrap().points.len(), 4);
        let mut other = fixture();
        other[0] = 8; // different kind
        assert!(edit(&data, &[0, 1], &other).is_err());
        assert!(edit(&data, &[0, 1], &[1, 2, 3]).is_err()); // undecodable merge
    }

    #[test]
    fn empty_keep_removes_every_point() {
        let data = fixture();
        let out = edit(&data, &[], &[]).unwrap();
        assert_eq!(out.len(), 8);
        let orb = decode(&out).unwrap();
        assert_eq!((orb.kind, orb.points.len()), (7, 0));
        // Empty keep followed by merge replaces the whole point list.
        let replaced = edit(&data, &[], &data).unwrap();
        assert_eq!(replaced, data);
    }

    #[test]
    fn malformed_inputs_are_rejected() {
        let data = fixture();
        for cut in 0..data.len() {
            assert!(decode(&data[..cut]).is_err(), "truncated at {cut}");
        }
        let mut extra = data.clone();
        extra.push(0);
        assert!(decode(&extra).is_err());
        let mut huge = Vec::new();
        huge.extend_from_slice(&7u32.to_le_bytes());
        huge.extend_from_slice(&u32::MAX.to_le_bytes());
        assert!(decode(&huge).is_err());
        assert!(edit(&data, &[1, 1], &[]).is_err());
        assert!(edit(&data, &[1, 0], &[]).is_err());
        assert!(edit(&data, &[2], &[]).is_err());
        assert!(edit(&data, &[u32::MAX], &[]).is_err());
    }
}
